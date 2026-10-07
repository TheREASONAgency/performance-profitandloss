/**
 * Account Status tab — pure functions only (no network, no env, no clock).
 * Everything here takes its rules from lib/status-config.js, so it is easy to
 * audit and unit-test: see tests/status-logic.test.js.
 */

const ORDER = { off_track: 0, on_track: 1, paused: 2, unknown: 3 };

/** "$1,234.50" -> 1234.5 ; "$-", "N/A", "", null -> null ; zero -> null. */
function parseMoney(text) {
  if (text === null || text === undefined) return null;
  const m = String(text).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** First "$number" in an account name: "GAL (<$400)" -> 400. */
function parseTargetFromName(name) {
  const m = String(name || "").replace(/,/g, "").match(/\$\s*(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/** Map an On Target CPA label to a status key via config. */
function classifyCpaLabel(label, statusMap) {
  const key = String(label || "").trim().toLowerCase();
  return statusMap[key] || "unknown";
}

function sortRows(rows) {
  return rows.sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name)
  );
}

function countByStatus(rows) {
  const counts = { on_track: 0, off_track: 0, paused: 0, unknown: 0 };
  rows.forEach((r) => { counts[r.status] += 1; });
  return counts;
}

/**
 * PV + Managed rows from raw Monday items.
 * item = { id, name, group: {id,title}, column_values: [{id, text}] }
 * Returns { pv: [...], managed: [...] }.
 */
function buildMondayRows(items, cfg) {
  const m = cfg.monday;
  const col = m.columns;
  const out = { pv: [], managed: [] };

  items.forEach((item) => {
    const v = {};
    (item.column_values || []).forEach((c) => { v[c.id] = c.text; });

    const clientType = (v[col.clientType] || "").trim();
    let kind = null;
    if (m.clientTypes.pv.includes(clientType)) kind = "pv";
    else if (m.clientTypes.managed.includes(clientType)) kind = "managed";
    if (!kind) return;

    if (item.group && m.excludeGroupIds.includes(item.group.id)) return;

    const label = (v[col.onTargetCpa] || "").trim();
    if (m.excludeOnTargetLabels.some((x) => x.toLowerCase() === label.toLowerCase())) return;

    const l7d = parseMoney(v[col.cpaL7d]);
    const cpaTarget = m.parseTargetFromName ? parseTargetFromName(item.name) : null;
    const adSpend = col.adSpend ? parseMoney(v[col.adSpend]) : null;
    const row = {
      id: item.id,
      name: item.name,
      url: `https://${m.accountSlug}.monday.com/boards/${m.boardId}/pulses/${item.id}`,
      platform: (col.platform && v[col.platform]) || m.defaultPlatform,
      group: item.group ? item.group.title : null,
      status: classifyCpaLabel(label, m.cpaStatusMap),
      rawLabel: label || null,
      cpaTarget,
      cpaToday: parseMoney(v[col.cpaToday]),
      cpaL7d: l7d,
      cpaGap: l7d != null && cpaTarget != null ? l7d - cpaTarget : null, // + = over target
      adSpend,
    };
    if (kind === "managed") row.bonus = evaluateBonus(row, cfg.managed && cfg.managed.bonus);
    out[kind].push(row);
  });

  sortRows(out.pv);
  sortRows(out.managed);
  return out;
}

/**
 * Profit pacing for one account. Isolated so the rule is auditable:
 *   dailyTarget   = monthlyTarget / daysBasis
 *   expectedToDate = dailyTarget * daysElapsed   (daysElapsed capped at basis)
 *   On Track  if profit >= expectedToDate, else Off Track
 */
function computeCpaPacing({ monthlyTarget, profit, daysElapsed, daysBasis, capDaysAtBasis }) {
  const days = capDaysAtBasis ? Math.min(daysElapsed, daysBasis) : daysElapsed;
  const dailyTarget = monthlyTarget / daysBasis;
  const expectedToDate = dailyTarget * days;
  return {
    daysElapsed: days,
    dailyTarget,
    expectedToDate,
    delta: profit - expectedToDate,
    pacingPct: expectedToDate > 0 ? (profit / expectedToDate) * 100 : null,
    status: profit >= expectedToDate ? "on_track" : "off_track",
  };
}

/** CPA-account rows from the parsed data.json payload. */
function buildCpaRows(data, cfg) {
  const c = cfg.cpa;
  const daysElapsed = Number(data[c.daysElapsedField]);
  const rows = [];

  (data.buyers || []).forEach((buyer) => {
    (buyer.accounts || []).forEach((a) => {
      if (a.type === "cpa") return; // purchases-vs-CPA offers have no profit target

      const hasTarget = Number(a.monthlyTarget) > 0;
      const live = Boolean(a.liveThisMonth);
      const base = {
        id: `${buyer.id}:${a.name}`,
        name: a.name,
        buyer: buyer.name,
        platform: c.defaultPlatform,
        monthlyTarget: hasTarget ? a.monthlyTarget : null,
        profit: Number(a.pl) || 0,
        live,
        lastEntry: a.lastEntry || null,
      };

      if (!hasTarget) {
        if (c.showNoTarget) rows.push({ ...base, status: "unknown", note: "No monthly target set" });
        return;
      }
      if (!live) {
        if (c.showNotLive) rows.push({ ...base, status: "paused", note: "No entries this month" });
        return;
      }
      if (!Number.isFinite(daysElapsed) || daysElapsed < 1) {
        rows.push({ ...base, status: "unknown", note: "Days elapsed unavailable" });
        return;
      }

      rows.push({
        ...base,
        ...computeCpaPacing({
          monthlyTarget: a.monthlyTarget,
          profit: base.profit,
          daysElapsed,
          daysBasis: c.daysBasis,
          capDaysAtBasis: c.capDaysAtBasis,
        }),
      });
    });
  });

  return sortRows(rows);
}

/**
 * Managed-account bonus/commission pacing. PLACEHOLDER: the real rule is not
 * finalized, so it is driven entirely by cfg.managed.bonus and off by default.
 * Returns { label, tone } where tone is good | bad | muted (badge colors).
 */
function evaluateBonus(row, rule) {
  if (!rule || !rule.enabled) return { label: (rule && rule.tbdLabel) || "Rule TBD", tone: "muted" };
  const value = row[rule.metric];
  const threshold = rule.thresholdField ? row[rule.thresholdField] : rule.threshold;
  if (value == null || threshold == null) return { label: "No data", tone: "muted" };
  if (rule.minAdSpend != null && (row.adSpend || 0) < rule.minAdSpend) {
    return { label: "Below min spend", tone: "muted" };
  }
  const ok = rule.comparator === "gte" ? value >= threshold : value <= threshold;
  return ok ? { label: "On pace", tone: "good" } : { label: "Off pace", tone: "bad" };
}

/** {y, m, d} (1-based month) for a Date in the given IANA timezone. */
function todayParts(now, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/**
 * The date the P&L data represents (data.json's current month + dayOfMonth),
 * not the wall clock, so a lagging data refresh isn't scored against today.
 * Same convention the Overview tab uses. Falls back to the given date.
 */
function dataAsOf(data, fallback) {
  const m = /^(\d{4})-(\d{2})$/.exec(data.currentMonth || "");
  const d = Number(data.dayOfMonth);
  return m && d >= 1 ? { y: Number(m[1]), m: Number(m[2]), d } : fallback;
}

/** Quarter target: explicit config value if set, else sum of monthly targets x months. */
function resolveQuarterTarget(data, cfg) {
  const label = data.currentQuarter;
  const explicit = cfg.quarter.targets[label];
  if (Number(explicit) > 0) return { target: Number(explicit), source: "config" };
  let monthly = 0;
  (data.buyers || []).forEach((b) => (b.accounts || []).forEach((a) => {
    if (a.type !== "cpa" && Number(a.monthlyTarget) > 0) monthly += a.monthlyTarget;
  }));
  return monthly > 0
    ? { target: monthly * cfg.quarter.monthsPerQuarter, source: "tracker" }
    : { target: null, source: null };
}

/**
 * Quarter progress. Pacing uses calendar days (today counts as elapsed, same
 * as dayOfMonth on the Overview): prorated = target x daysElapsed / daysInQuarter.
 */
function computeQuarterSummary({ label, target, qtdPl, today }) {
  const m = /Q(\d)\s+(\d{4})/.exec(label || "");
  if (!m || !target) return null;
  const q = Number(m[1]), y = Number(m[2]);
  const start = Date.UTC(y, (q - 1) * 3, 1);
  const end = Date.UTC(y, q * 3, 1);
  const daysInQuarter = Math.round((end - start) / 864e5);
  const raw = Math.floor((Date.UTC(today.y, today.m - 1, today.d) - start) / 864e5) + 1;
  const daysElapsed = Math.max(0, Math.min(daysInQuarter, raw));
  const proratedTarget = target * daysElapsed / daysInQuarter;
  return {
    label, target, qtdPl, daysElapsed, daysInQuarter, proratedTarget,
    progressPct: (qtdPl / target) * 100,
    pacingPct: proratedTarget > 0 ? (qtdPl / proratedTarget) * 100 : null,
  };
}

/** Headline cards: quarter target/progress/pacing + active account counts. */
function buildSummary({ data, pv, managed, cpa, today, cfg }) {
  const all = [...pv, ...managed, ...cpa];
  const c = countByStatus(all);
  const { target, source } = resolveQuarterTarget(data, cfg);
  const qtdPl = (data.months || [])
    .filter((mo) => mo.quarter === data.currentQuarter)
    .reduce((s, mo) => s + mo.accounts.reduce((a, x) => a + (Number(x.pl) || 0), 0), 0);
  const quarter = computeQuarterSummary({
    label: data.currentQuarter, target, qtdPl, today: dataAsOf(data, today),
  });
  return {
    quarter: quarter && { ...quarter, targetSource: source },
    accounts: {
      active: c.on_track + c.off_track,
      onTrack: c.on_track,
      offTrack: c.off_track,
      paused: c.paused,
      total: all.length,
    },
  };
}

/** "2026-10" for a Date in the given IANA timezone. */
function currentMonthKey(now, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit",
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}`;
}

module.exports = {
  parseMoney,
  parseTargetFromName,
  classifyCpaLabel,
  countByStatus,
  buildMondayRows,
  computeCpaPacing,
  buildCpaRows,
  evaluateBonus,
  todayParts,
  dataAsOf,
  resolveQuarterTarget,
  computeQuarterSummary,
  buildSummary,
  currentMonthKey,
};

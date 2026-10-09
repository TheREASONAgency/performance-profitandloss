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
  const out = { pv: [], managed: [], all: [] };

  items.forEach((item) => {
    const v = {};
    (item.column_values || []).forEach((c) => { v[c.id] = c.text; });

    // Every item on the board (any group or client type), for the sheet's fallback fill.
    const allLabel = (v[col.onTargetCpa] || "").trim();
    out.all.push({
      name: item.name,
      group: item.group ? item.group.title : null,
      groupExcluded: Boolean(item.group && m.excludeGroupIds.includes(item.group.id)),
      closed: m.excludeOnTargetLabels.some((x) => x.toLowerCase() === allLabel.toLowerCase()),
      cpaL7d: parseMoney(v[col.cpaL7d]),
      adSpend: col.adSpend ? parseMoney(v[col.adSpend]) : null,
    });

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
      if (matchesAny(c.excludeAccounts, buyer.name, a.name)) return;

      // The quarter's per-month target table wins over the tracker's value.
      const override = cpaTargetOverride(buyer.name, a.name, data, cfg);
      const monthlyTarget = override !== null ? override : a.monthlyTarget;
      const hasTarget = Number(monthlyTarget) > 0;
      const live = Boolean(a.liveThisMonth);
      const base = {
        id: `${buyer.id}:${a.name}`,
        name: a.name,
        buyer: buyer.name,
        platform: c.defaultPlatform,
        monthlyTarget: hasTarget ? monthlyTarget : null,
        profit: Number(a.pl) || 0,
        live,
        lastEntry: a.lastEntry || null,
      };

      if (override === 0) { // explicitly "no target this month": visible only if it has activity
        if (live) rows.push({ ...base, status: "unknown", note: "Target is $0 this month" });
        return;
      }
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
          monthlyTarget,
          profit: base.profit,
          daysElapsed,
          daysBasis: c.daysBasis,
          capDaysAtBasis: c.capDaysAtBasis,
        }),
      });
    });
  });

  // Zero-filled placeholders for accounts whose trackers aren't built yet.
  const q = cfg.targets[data.currentQuarter];
  if (q) {
    const idx = q.months.indexOf(data.currentMonth);
    (c.placeholders || []).forEach((label) => {
      const arr = Object.values(q.groups).map((g) => g.accounts[label]).find(Boolean);
      const target = arr && idx >= 0 ? Number(arr[idx]) || 0 : 0;
      rows.push({
        id: `placeholder:${label}`,
        name: label,
        buyer: "Tracker pending",
        platform: c.defaultPlatform,
        monthlyTarget: target > 0 ? target : null,
        profit: 0,
        live: false,
        lastEntry: null,
        placeholder: true,
        status: "paused",
        note: "placeholder, all zeros",
      });
    });
  }

  return sortRows(rows);
}

/**
 * Matcher shared by trackerMatch and excludeAccounts: "Buyer/Account" matches
 * one buyer's offer, "Account" matches that offer under any buyer. Exact,
 * case-insensitive.
 */
function matchesAny(matchers, buyerName, accountName) {
  const norm = (x) => String(x || "").trim().toLowerCase();
  return (matchers || []).some((mm) => {
    const [buyer, name] = mm.includes("/") ? mm.split("/") : [null, mm];
    return norm(name) === norm(accountName) && (buyer === null || norm(buyer) === norm(buyerName));
  });
}

/**
 * Monthly target for a CPA offer from the quarter's target table, or null when
 * the table has nothing for it (then the tracker's own monthlyTarget is used).
 * See `trackerMatch` in lib/status-config.js. Returns 0 for an explicit $0.
 */
function cpaTargetOverride(buyerName, accountName, data, cfg) {
  const q = cfg.targets[data.currentQuarter];
  if (!q) return null;
  const idx = q.months.indexOf(data.currentMonth);
  if (idx < 0) return null;
  for (const [label, matchers] of Object.entries(q.trackerMatch || {})) {
    if (!matchesAny(matchers, buyerName, accountName)) continue;
    for (const g of Object.values(q.groups)) {
      if (g.accounts[label]) return Number(g.accounts[label][idx]) || 0;
    }
  }
  return null;
}

/**
 * Managed-account ad spend goal. Every managed client wants cfg.managed.goal.amount
 * in ad spend while CPA stays under its target. Returns { label, tone }
 * (tone: good | bad | muted). elapsedFraction = share of the quarter elapsed.
 */
function evaluateManagedGoal(row, goal, elapsedFraction) {
  if (!goal) return { label: "No goal set", tone: "muted" };
  if (row.adSpend == null) return { label: "No spend data", tone: "muted" };
  const cpaOver = goal.requireCpaUnderTarget && row.cpaL7d != null &&
    row.cpaTarget != null && row.cpaL7d > row.cpaTarget;
  if (cpaOver) return { label: "CPA over target", tone: "bad" };
  if (row.adSpend >= goal.amount) return { label: "Goal hit", tone: "good" };
  if (!goal.pace) return { label: "In progress", tone: "muted" };
  if (elapsedFraction == null) return { label: "No pace data", tone: "muted" };
  return row.adSpend >= goal.amount * elapsedFraction
    ? { label: "On pace", tone: "good" }
    : { label: "Behind pace", tone: "bad" };
}

/**
 * Share of the goal period elapsed (0..1): the data's day-of-month over days in
 * the month for period "month", or the quarter's elapsed share for "quarter".
 * Anchored to the date data.json represents, like the rest of the tab.
 */
function goalElapsedFraction(data, cfg, quarter) {
  const goal = cfg.managed && cfg.managed.goal;
  if (!goal) return null;
  if (goal.period === "quarter") {
    return quarter && quarter.daysInQuarter ? quarter.daysElapsed / quarter.daysInQuarter : null;
  }
  const d = Number(data && data.dayOfMonth), n = Number(data && data.daysInMonth);
  return d >= 1 && n > 0 ? Math.min(d, n) / n : null;
}

/** Attach goal progress + pace to Managed rows (mutates). `fraction` = goalElapsedFraction(). */
function applyManagedGoal(rows, cfg, fraction) {
  const goal = cfg.managed && cfg.managed.goal;
  rows.forEach((r) => {
    r.goalTarget = goal ? goal.amount : null;
    r.goalPeriod = goal ? goal.period : null;
    r.goalPct = goal && r.adSpend != null ? (r.adSpend / goal.amount) * 100 : null;
    r.goalPace = evaluateManagedGoal(r, goal, fraction);
  });
  return rows;
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

/**
 * Quarter targets. From cfg.targets[quarter] when present (summed over all
 * months and accounts per group); otherwise the tracker's monthly targets x
 * monthsPerQuarter. headline = cfg.quarter.headlineGroups, progress =
 * cfg.quarter.progressGroups (the groups that have actuals).
 */
function resolveQuarterTargets(data, cfg) {
  const q = cfg.targets[data.currentQuarter];
  if (q) {
    const groups = {};
    Object.entries(q.groups).forEach(([key, g]) => {
      groups[key] = {
        label: g.label,
        total: Object.values(g.accounts).reduce(
          (s, arr) => s + arr.reduce((a, n) => a + (Number(n) || 0), 0), 0),
      };
    });
    const pick = (keys) => keys.reduce((s, k) => s + (groups[k] ? groups[k].total : 0), 0);
    return {
      source: "config", groups,
      headline: pick(cfg.quarter.headlineGroups),
      progress: pick(cfg.quarter.progressGroups),
      progressLabel: cfg.quarter.progressGroups.map((k) => groups[k] && groups[k].label).filter(Boolean).join(" + "),
    };
  }
  let monthly = 0;
  (data.buyers || []).forEach((b) => (b.accounts || []).forEach((a) => {
    if (a.type !== "cpa" && Number(a.monthlyTarget) > 0) monthly += a.monthlyTarget;
  }));
  const total = monthly * cfg.quarter.monthsPerQuarter;
  return total > 0
    ? { source: "tracker", groups: { cpa: { label: "CPA", total } }, headline: total, progress: total, progressLabel: "CPA" }
    : { source: null, groups: {}, headline: null, progress: null, progressLabel: "" };
}

/**
 * Quarter progress. Pacing uses calendar days (the as-of day counts as elapsed,
 * same as dayOfMonth on the Overview): prorated = progressTarget x daysElapsed / daysInQuarter.
 */
function computeQuarterSummary({ label, headlineTarget, progressTarget, qtdPl, today }) {
  const m = /Q(\d)\s+(\d{4})/.exec(label || "");
  if (!m || !(headlineTarget || progressTarget)) return null;
  const q = Number(m[1]), y = Number(m[2]);
  const start = Date.UTC(y, (q - 1) * 3, 1);
  const end = Date.UTC(y, q * 3, 1);
  const daysInQuarter = Math.round((end - start) / 864e5);
  const raw = Math.floor((Date.UTC(today.y, today.m - 1, today.d) - start) / 864e5) + 1;
  const daysElapsed = Math.max(0, Math.min(daysInQuarter, raw));
  const proratedTarget = progressTarget ? progressTarget * daysElapsed / daysInQuarter : null;
  return {
    label, headlineTarget, progressTarget, qtdPl, daysElapsed, daysInQuarter, proratedTarget,
    progressPct: progressTarget ? (qtdPl / progressTarget) * 100 : null,
    pacingPct: proratedTarget > 0 ? (qtdPl / proratedTarget) * 100 : null,
  };
}

/** Headline cards: quarter target/progress/pacing + active account counts. */
function buildSummary({ data, pv, managed, cpa, today, cfg }) {
  const all = [...pv, ...managed, ...cpa];
  const c = countByStatus(all);
  const t = resolveQuarterTargets(data, cfg);
  const qtdPl = (data.months || [])
    .filter((mo) => mo.quarter === data.currentQuarter)
    .reduce((s, mo) => s + mo.accounts
      .filter((x) => !matchesAny(cfg.cpa.excludeAccounts, x.buyer, x.account))
      .reduce((a, x) => a + (Number(x.pl) || 0), 0), 0);
  const quarter = computeQuarterSummary({
    label: data.currentQuarter, headlineTarget: t.headline, progressTarget: t.progress,
    qtdPl, today: dataAsOf(data, today),
  });
  return {
    quarter: quarter && {
      ...quarter,
      targetSource: t.source,
      progressLabel: t.progressLabel,
      groups: Object.values(t.groups).filter((g) => g.total > 0).map((g) => ({ label: g.label, total: g.total })),
    },
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
  matchesAny,
  cpaTargetOverride,
  evaluateManagedGoal,
  goalElapsedFraction,
  applyManagedGoal,
  todayParts,
  dataAsOf,
  resolveQuarterTargets,
  computeQuarterSummary,
  buildSummary,
  currentMonthKey,
};

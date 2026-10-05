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
    out[kind].push({
      id: item.id,
      name: item.name,
      url: `https://${m.accountSlug}.monday.com/boards/${m.boardId}/pulses/${item.id}`,
      platform: (col.platform && v[col.platform]) || m.defaultPlatform,
      group: item.group ? item.group.title : null,
      status: classifyCpaLabel(label, m.cpaStatusMap),
      rawLabel: label || null,
      cpaTarget: m.parseTargetFromName ? parseTargetFromName(item.name) : null,
      cpaToday: parseMoney(v[col.cpaToday]),
      cpaL7d: l7d,
    });
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
  currentMonthKey,
};

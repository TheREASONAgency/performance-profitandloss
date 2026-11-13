/**
 * Per-account trend reporting: a daily snapshot of month-to-date spend and CPA L7D, and
 * 7-day / 28-day checkpoints computed from those snapshots.
 *
 * "On track" (team definition): spend is scaling while CPA stays stable or falls.
 */
const DAY = 86400000;
const dayNum = (d) => Math.round(Date.parse(d) / DAY);
const addDays = (d, n) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);

const SPEND_UP = 0.05;   // week-over-week spend growth that counts as "scaling"
const CPA_UP = 0.10;     // CPA more than 10% above a week ago counts as "rising"
const KEEP_DAYS = 150;

/** Add today's snapshot ({label: {mtd, cpa}}) and drop anything older than KEEP_DAYS. */
function record(days, today, snap) {
  const out = { ...(days || {}), [today]: snap };
  const cut = addDays(today, -KEEP_DAYS);
  Object.keys(out).forEach((d) => { if (d < cut) delete out[d]; });
  return out;
}

/** [{date, mtd, cpa, spend}] oldest first; spend = average daily spend since the previous snapshot. */
function series(days, label) {
  const dates = Object.keys(days || {}).filter((d) => days[d] && days[d][label]).sort();
  const out = [];
  dates.forEach((date) => {
    const e = days[date][label];
    const prev = out[out.length - 1];
    let spend = null;
    if (e.mtd != null) {
      if (prev && prev.mtd != null && prev.date.slice(0, 7) === date.slice(0, 7) && e.mtd >= prev.mtd) {
        spend = (e.mtd - prev.mtd) / Math.max(1, dayNum(date) - dayNum(prev.date));
      } else if (!prev || prev.date.slice(0, 7) !== date.slice(0, 7)) {
        // First snapshot of a month: spent since the 1st. If MTD did not reset (still >= last
        // month's figure) the source is stale, so there is no spend to report.
        spend = prev && prev.mtd != null && e.mtd >= prev.mtd ? null : e.mtd / Number(date.slice(8, 10));
      }
    }
    out.push({ date, mtd: e.mtd == null ? null : e.mtd, cpa: e.cpa == null ? null : e.cpa, spend });
  });
  return out;
}

/** One window (W days): daily spend and CPA points plus change vs the previous W days. */
function windowStats(s, today, W) {
  const from = addDays(today, -W), prevFrom = addDays(today, -2 * W);
  const inWin = s.filter((e) => e.date > from && e.date <= today);
  const prevWin = s.filter((e) => e.date > prevFrom && e.date <= from);
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const sp = (xs) => xs.filter((e) => e.spend != null).map((e) => e.spend);
  const spendNow = avg(sp(inWin)), spendPrev = avg(sp(prevWin));
  const enough = sp(prevWin).length >= Math.ceil(W / 2);
  const cpaPts = inWin.filter((e) => e.cpa != null);
  const cpaNow = cpaPts.length ? cpaPts[cpaPts.length - 1].cpa : null;
  const cpaThen = (s.filter((e) => e.cpa != null && Math.abs(dayNum(e.date) - (dayNum(today) - W)) <= 3)
    .sort((a, b) => Math.abs(dayNum(a.date) - (dayNum(today) - W)) - Math.abs(dayNum(b.date) - (dayNum(today) - W)))[0] || {}).cpa;
  const pct = (a, b) => (a != null && b != null && b > 0 ? a / b - 1 : null);
  return {
    days: W,
    spendPts: inWin.filter((e) => e.spend != null).map((e) => [e.date, Math.round(e.spend * 100) / 100]),
    cpaPts: cpaPts.map((e) => [e.date, e.cpa]),
    spendChange: enough ? pct(spendNow, spendPrev) : null,
    cpaChange: pct(cpaNow, cpaThen == null ? null : cpaThen),
  };
}

/**
 * Windows from Meta's own daily numbers (most accurate). daily = { "YYYY-MM-DD": {spend, results} }
 * for one account. Complete days only (through yesterday). Returns null when the data is stale/empty.
 * Spend change = last W days vs the W days before; CPA = spend / results over the window.
 * The CPA chart line is the trailing-7-day CPA, so it reads like Monday's L7D CPA.
 */
function metaWindows(daily, today) {
  const dates = Object.keys(daily || {}).sort();
  if (!dates.length) return null;
  const end = addDays(today, -1);
  if (dates[dates.length - 1] < addDays(end, -1)) return null; // script has not run recently
  const day = (d) => daily[d] || { spend: 0, results: 0 };
  const sum = (to, n, k) => { let t = 0; for (let i = 0; i < n; i++) t += Number(day(addDays(to, -i))[k]) || 0; return t; };
  const cpaAt = (to, n) => { const r = sum(to, n, "results"); return r > 0 ? sum(to, n, "spend") / r : null; };
  const first = dates[0];
  const pct = (a, b) => (a != null && b != null && b > 0 ? a / b - 1 : null);
  const win = (W) => {
    const have = (to, n) => addDays(to, -(n - 1)) >= first;      // history covers the whole window
    const spendPts = [], cpaPts = [];
    for (let i = W - 1; i >= 0; i--) {
      const d = addDays(end, -i);
      if (d < first) continue;
      spendPts.push([d, Math.round(sum(d, 1, "spend") * 100) / 100]);
      const c = cpaAt(d, 7);
      if (c != null) cpaPts.push([d, Math.round(c * 100) / 100]);
    }
    const prevEnd = addDays(end, -W);
    return {
      days: W, source: "Meta", spendPts, cpaPts,
      spendTotal: Math.round(sum(end, W, "spend")),
      spendChange: have(prevEnd, W) ? pct(sum(end, W, "spend"), sum(prevEnd, W, "spend")) : null,
      cpaChange: have(prevEnd, W) ? pct(cpaAt(end, W), cpaAt(prevEnd, W)) : null,
    };
  };
  return { w7: win(7), w28: win(28), span: dayNum(end) - dayNum(first) + 1, cpaNow: cpaAt(end, 7) };
}

const withCpa = (m, snap) => (m.cpaPts.length >= 2 ? m : { ...m, cpaPts: snap.cpaPts, cpaChange: snap.cpaChange });

function summarize(days, label, today, metaDaily) {
  const s = series(days, label);
  const n = s.length;
  const avg = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const win = (from, to) => avg(s.filter((e) => e.date > addDays(today, -from) && e.date <= addDays(today, -to)).map((e) => e.spend));
  const near = (k) => {
    const t = dayNum(today) - k;
    const c = s.filter((e) => e.cpa != null && Math.abs(dayNum(e.date) - t) <= 3).sort((a, b) => Math.abs(dayNum(a.date) - t) - Math.abs(dayNum(b.date) - t))[0];
    return c ? c.cpa : null;
  };
  const latest = [...s].reverse().find((e) => e.cpa != null && dayNum(today) - dayNum(e.date) <= 3);
  const cpaNow = latest ? latest.cpa : null;
  const cpa7 = near(7), cpa28 = near(28);
  const pct = (a, b) => (a != null && b != null && b > 0 ? a / b - 1 : null);
  const spend7 = win(7, 0), spendPrev7 = win(14, 7), spend28 = win(28, 0);
  const change = { cpa7: pct(cpaNow, cpa7), cpa28: pct(cpaNow, cpa28), spend7: pct(spend7, spendPrev7) };

  const meta = metaDaily ? metaWindows(metaDaily, today) : null;
  if (meta) {
    change.spend7 = meta.w7.spendChange;
    if (meta.w7.cpaChange != null) change.cpa7 = meta.w7.cpaChange;
    if (meta.w28.cpaChange != null) change.cpa28 = meta.w28.cpaChange;
  }
  const span = meta ? meta.span : (n ? dayNum(today) - dayNum(s[0].date) + 1 : 0);
  let trend;
  if (!n && !meta) trend = { code: "none", text: "No data yet" };
  else if (span < 7) trend = { code: "building", text: `Building history (${span}/7 days)` };
  else if (change.cpa7 == null) trend = { code: "none", text: "No CPA to compare" };
  else if (change.cpa7 > CPA_UP) trend = { code: "bad", text: "CPA rising" };
  else if (change.spend7 != null && change.spend7 >= SPEND_UP) trend = { code: "good", text: change.cpa7 < -0.05 ? "Scaling · CPA down" : "Scaling · CPA stable" };
  else if (change.spend7 != null) trend = { code: "flat", text: change.spend7 <= -SPEND_UP ? "Spend falling · CPA stable" : "Flat spend · CPA stable" };
  else trend = { code: "flat", text: "CPA stable" };

  return {
    n, trend, change,
    cpa: { now: cpaNow, d7: cpa7, d28: cpa28 },
    spend: { d7: spend7, d28: spend28 },
    // Spend comes from Meta when available. Meta reports 0 results for accounts that do not
    // optimize on purchases, so the CPA line/change then fall back to the daily CPA snapshots.
    w7: meta ? withCpa(meta.w7, windowStats(s, today, 7)) : windowStats(s, today, 7),
    w28: meta ? withCpa(meta.w28, windowStats(s, today, 28)) : windowStats(s, today, 28),
    spark: s.filter((e) => e.cpa != null && e.date > addDays(today, -28)).map((e) => [e.date, e.cpa]),
  };
}

function summarizeAll(days, today, metaDaily) {
  const labels = new Set();
  Object.values(days || {}).forEach((snap) => Object.keys(snap || {}).forEach((l) => labels.add(l)));
  const out = {};
  labels.forEach((l) => { out[l] = summarize(days, l, today, metaDaily && metaDaily[l]); });
  return out;
}

module.exports = { record, series, summarize, summarizeAll, metaWindows };

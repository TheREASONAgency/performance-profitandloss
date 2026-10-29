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
        spend = e.mtd / Number(date.slice(8, 10)); // first snapshot of a month: spent since the 1st
      }
    }
    out.push({ date, mtd: e.mtd == null ? null : e.mtd, cpa: e.cpa == null ? null : e.cpa, spend });
  });
  return out;
}

function summarize(days, label, today) {
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

  const span = n ? dayNum(today) - dayNum(s[0].date) + 1 : 0;
  let trend;
  if (!n) trend = { code: "none", text: "No data yet" };
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
    spark: s.filter((e) => e.cpa != null && e.date > addDays(today, -28)).map((e) => [e.date, e.cpa]),
  };
}

function summarizeAll(days, today) {
  const labels = new Set();
  Object.values(days || {}).forEach((snap) => Object.keys(snap || {}).forEach((l) => labels.add(l)));
  const out = {};
  labels.forEach((l) => { out[l] = summarize(days, l, today); });
  return out;
}

module.exports = { record, series, summarize, summarizeAll };

/**
 * Keeps Hair Loss month totals from Travis's CPA Offers P&L (one tab per month, e.g.
 * "October | 2026"). Finds the "TOTALS" header row and reads the figures under
 * Earnings / Ad Spend / P/L in the first block (the KEEPS block on current tabs).
 */
function money(text) {
  const t = String(text == null ? "" : text).trim();
  if (!t) return null;
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t) || /^\$-/.test(t);
  const n = Number(t.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && /\d/.test(t) ? (neg ? -n : n) : null;
}

function monthTab(now, tz = "America/New_York") {
  const month = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long" }).format(now);
  const year = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(now);
  return `${month} | ${year}`;
}

function parseKeepsTotals(values) {
  const rows = values || [];
  const hi = rows.findIndex((r) => (r || []).some((c) => /^totals$/i.test(String(c).trim())));
  if (hi < 0 || !rows[hi + 1]) return null;
  const head = rows[hi].map((c) => String(c).trim().toLowerCase());
  const at = (re) => head.findIndex((h) => re.test(h));
  const [ci, di, pi] = [at(/^(earnings|revenue)$/), at(/^ad spend$/), at(/^p\/l$/)];
  const vals = rows[hi + 1];
  const out = { revenue: money(vals[ci]), adSpend: money(vals[di]), profit: money(vals[pi]) };
  return out.profit == null ? null : out;
}

module.exports = { parseKeepsTotals, monthTab, money };

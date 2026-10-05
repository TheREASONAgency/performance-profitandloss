/**
 * GET /api/status
 *
 * Server-side only: reads the Monday.com token from a Vercel environment
 * variable (never sent to the browser), pulls PV + Managed accounts from the
 * Monday board, builds CPA-account profit pacing from data.json, and returns
 * one JSON payload for the "Account Status" tab.
 *
 * Each source fails independently: if Monday is unreachable the CPA section
 * still renders, and the response says exactly which source failed and why.
 */
const fs = require("fs");
const path = require("path");
const config = require("../lib/status-config");
const logic = require("../lib/status-logic");

const MONDAY_URL = "https://api.monday.com/v2";
const PAGE_LIMIT = 200;
const MAX_PAGES = 25;
const TIMEOUT_MS = 12000;

const ITEM_FIELDS = `
  id
  name
  group { id title }
  column_values(ids: $cols) { id text }
`;

async function mondayQuery(token, query, variables) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(MONDAY_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
        "API-Version": config.monday.apiVersion,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) {
    throw new Error(
      e.name === "AbortError"
        ? `Monday.com did not respond within ${TIMEOUT_MS / 1000}s`
        : `Could not reach Monday.com (${e.message})`
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error("Monday.com rejected the API token (check MONDAY_API_TOKEN)");
  }
  if (!res.ok) throw new Error(`Monday.com returned HTTP ${res.status}`);

  const json = await res.json();
  if (json.errors && json.errors.length) {
    throw new Error("Monday.com API error: " + json.errors.map((e) => e.message).join("; "));
  }
  return json.data;
}

async function fetchMondayItems() {
  const token = process.env[config.monday.tokenEnv];
  if (!token) throw new Error(`${config.monday.tokenEnv} is not set in the Vercel environment`);

  const cols = Object.values(config.monday.columns).filter(Boolean);
  const items = [];

  const first = await mondayQuery(
    token,
    `query ($boardId: [ID!], $cols: [String!]) {
       boards(ids: $boardId) {
         items_page(limit: ${PAGE_LIMIT}) { cursor items { ${ITEM_FIELDS} } }
       }
     }`,
    { boardId: [config.monday.boardId], cols }
  );
  const board = first.boards && first.boards[0];
  if (!board) throw new Error(`Board ${config.monday.boardId} not found or not visible to this token`);

  let page = board.items_page;
  items.push(...page.items);

  for (let i = 0; page.cursor && i < MAX_PAGES; i++) {
    const next = await mondayQuery(
      token,
      `query ($cursor: String!, $cols: [String!]) {
         next_items_page(limit: ${PAGE_LIMIT}, cursor: $cursor) { cursor items { ${ITEM_FIELDS} } }
       }`,
      { cursor: page.cursor, cols }
    );
    page = next.next_items_page;
    items.push(...page.items);
  }
  return items;
}

async function loadCpaData() {
  const url = process.env[config.cpa.dataUrlEnv];
  if (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CPA data URL returned HTTP ${res.status}`);
    return res.json();
  }
  const candidates = [
    path.join(process.cwd(), config.cpa.dataFile),
    path.join(__dirname, "..", config.cpa.dataFile),
  ];
  for (const p of candidates) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { /* try next */ }
  }
  throw new Error(`Could not read ${config.cpa.dataFile} (is it included in the deployment?)`);
}

function section(rows, extra) {
  return { ok: true, rows, counts: logic.countByStatus(rows), ...extra };
}
function failed(err) {
  return { ok: false, error: err.message, rows: [], counts: logic.countByStatus([]) };
}

module.exports = async function handler(req, res) {
  const out = {
    generatedAt: new Date().toISOString(),
    clientPollSeconds: config.clientPollSeconds,
    statuses: config.statuses,
    pv: null,
    managed: null,
    cpa: null,
  };

  // PV + Managed (Monday.com)
  try {
    const rows = logic.buildMondayRows(await fetchMondayItems(), config);
    out.pv = section(rows.pv);
    out.managed = section(rows.managed);
  } catch (e) {
    out.pv = failed(e);
    out.managed = failed(e);
  }

  // CPA accounts (profit pacing from data.json)
  try {
    const data = await loadCpaData();
    const warnings = [];
    const monthNow = logic.currentMonthKey(new Date(), config.timezone);
    if (data.currentMonth !== monthNow) {
      warnings.push(
        `Tracker data is for ${data.currentMonth}, but it is now ${monthNow}. ` +
        "Figures will update after the next data refresh."
      );
    }
    out.cpa = section(logic.buildCpaRows(data, config), {
      dataUpdated: data.lastUpdated || null,
      monthLabel: data.monthLabel || null,
      daysElapsed: data[config.cpa.daysElapsedField],
      daysBasis: config.cpa.daysBasis,
      warnings,
    });
  } catch (e) {
    out.cpa = failed(e);
  }

  res.setHeader(
    "Cache-Control",
    `public, s-maxage=${config.cacheSeconds}, stale-while-revalidate=${config.cacheSeconds * 5}`
  );
  res.status(200).json(out);
};

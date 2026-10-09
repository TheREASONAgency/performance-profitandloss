#!/usr/bin/env node
/**
 * Rebuilds status.json for the "Account Status" tab.
 *
 *   PV + Managed  <- Monday.com board (needs MONDAY_API_TOKEN)
 *   CPA accounts  <- data.json (already in the repo, built by the pacing job)
 *
 * Run by .github/workflows/refresh-status.yml (Mon/Wed/Fri 6:00 AM Eastern).
 * The token only ever exists in GitHub Actions; it is never sent to the browser.
 *
 * A source that fails keeps its last good rows (marked with an error) and the
 * script exits non-zero AFTER writing, so the failure is red in Actions but
 * the page keeps working.
 */
const fs = require("fs");
const path = require("path");
const config = require("../lib/status-config");
const logic = require("../lib/status-logic");
const sheets = require("../lib/google-sheets");
const sheetBoard = require("../lib/sheet-board");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, config.outputFile);
const MONDAY_URL = "https://api.monday.com/v2";
const PAGE_LIMIT = 200;
const MAX_PAGES = 25;
const TIMEOUT_MS = 20000;

const ITEM_FIELDS = `id name group { id title } column_values(ids: $cols) { id text }`;

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
    throw new Error(`Monday.com rejected the API token (check the ${config.monday.tokenEnv} secret)`);
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
  if (!token) throw new Error(`${config.monday.tokenEnv} is not set`);

  const cols = Object.values(config.monday.columns).filter(Boolean);
  const first = await mondayQuery(
    token,
    `query ($boardId: [ID!], $cols: [String!]) {
       boards(ids: $boardId) { items_page(limit: ${PAGE_LIMIT}) { cursor items { ${ITEM_FIELDS} } } }
     }`,
    { boardId: [config.monday.boardId], cols }
  );
  const board = first.boards && first.boards[0];
  if (!board) throw new Error(`Board ${config.monday.boardId} not found or not visible to this token`);

  let page = board.items_page;
  const items = [...page.items];
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

function readPrevious() {
  try { return JSON.parse(fs.readFileSync(OUT, "utf8")); } catch (_) { return {}; }
}

const section = (rows, extra) => ({ ok: true, rows, counts: logic.countByStatus(rows), ...extra });

/** A failed source keeps its last good rows so the page is never blank. */
function failedSection(err, prev, prevGeneratedAt) {
  const rows = (prev && prev.rows) || [];
  return {
    ok: false,
    error: err.message,
    rows,
    counts: logic.countByStatus(rows),
    // Keep the original "last good" time across consecutive failures.
    lastGood: (prev && (prev.ok === false ? prev.lastGood : prevGeneratedAt)) || null,
  };
}

async function run() {
  const prev = readPrevious();
  const now = new Date();
  const out = {
    generatedAt: now.toISOString(),
    schedule: config.scheduleLabel,
    statuses: config.statuses,
    ...(process.env.STATUS_SEED ? { seed: true } : {}),
  };
  let failures = 0;
  let data = null;

  try {
    if (!config.monday.enabled) {
      out.pv = section([], { disabled: true });
      out.managed = section([], { disabled: true });
    } else {
      const rows = logic.buildMondayRows(await fetchMondayItems(), config);
      out.pv = section(rows.pv);
      out.managed = section(rows.managed);
    }
  } catch (e) {
    failures++;
    const err = process.env.STATUS_SEED
      ? new Error(`Waiting for the first scheduled refresh (${config.scheduleLabel}).`)
      : e;
    console.error("Monday section failed:", e.message);
    out.pv = failedSection(err, prev.pv, prev.generatedAt);
    out.managed = failedSection(err, prev.managed, prev.generatedAt);
  }

  try {
    data = JSON.parse(fs.readFileSync(path.join(ROOT, config.cpa.dataFile), "utf8"));
    const warnings = [];
    const monthNow = logic.currentMonthKey(now, config.timezone);
    if (data.currentMonth !== monthNow) {
      warnings.push(
        `Tracker data is for ${data.currentMonth}, but it is now ${monthNow}. ` +
        "CPA figures will update after the next P&L data refresh."
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
    failures++;
    console.error("CPA section failed:", e.message);
    out.cpa = failedSection(e, prev.cpa, prev.generatedAt);
  }

  // Headline cards. Needs data.json for the quarter; uses kept rows if a source failed.
  try {
    out.summary = data
      ? logic.buildSummary({
          data, pv: out.pv.rows, managed: out.managed.rows, cpa: out.cpa.rows,
          today: logic.todayParts(now, config.timezone), cfg: config,
        })
      : (prev.summary || null);
  } catch (e) {
    failures++;
    console.error("Summary failed:", e.message);
    out.summary = prev.summary || null;
  }
  // Managed goal progress needs the quarter's elapsed share, so it runs after the summary.
  logic.applyManagedGoal(out.managed.rows, config,
    logic.goalElapsedFraction(data, config, out.summary && out.summary.quarter));

  // Master sheet board: targets from the sheet, blanks filled from P&L / Monday.
  try {
    const values = await sheets.getValues(process.env[config.board.serviceAccountEnv], config.board.sheetId, config.board.range);
    const model = sheetBoard.parseBoard(values, config.board);
    sheetBoard.fillActuals(model, sheetBoard.buildSources({
      cpaRows: out.cpa.rows, mondayManaged: out.managed.rows, matchesAny: logic.matchesAny,
      board: config.board, goalAmount: config.managed.goal.amount,
    }));
    out.board = { ok: true, ...model };
  } catch (e) {
    failures++;
    const err = process.env.STATUS_SEED ? new Error(`Waiting for the first scheduled refresh (${config.scheduleLabel}).`) : e;
    console.error("Sheet board failed:", e.message);
    out.board = { ok: false, error: err.message, groups: [], quarter: null,
      lastGood: (prev.board && (prev.board.ok === false ? prev.board.lastGood : prev.generatedAt)) || null,
      ...(prev.board && prev.board.groups ? { groups: prev.board.groups, quarter: prev.board.quarter } : {}) };
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(
    `Wrote ${config.outputFile}: PV ${out.pv.rows.length}, Managed ${out.managed.rows.length}, ` +
    `CPA ${out.cpa.rows.length}` + (failures ? ` (${failures} source(s) failed)` : "")
  );
  return failures;
}

module.exports = { run };

if (require.main === module) {
  run().then((f) => process.exit(f ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });
}

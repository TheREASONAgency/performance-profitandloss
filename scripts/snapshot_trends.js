#!/usr/bin/env node
/**
 * Daily snapshot for trend reporting. Reads the master sheet + Monday (same sources as the
 * Overview), records each account's month-to-date spend and CPA L7D in trends.json, and
 * writes the 7-day / 28-day summaries the dashboard shows. Does NOT touch the sheet or status.json.
 */
const fs = require("fs");
const path = require("path");
const config = require("../lib/status-config");
const logic = require("../lib/status-logic");
const sheets = require("../lib/google-sheets");
const sheetBoard = require("../lib/sheet-board");
const trends = require("../lib/trends");
const statusDays = require("../lib/status-days");
const { fetchMondayItems } = require("./refresh_status");

const OUT = path.join(__dirname, "..", "trends.json");

async function main() {
  const now = new Date();
  const today = statusDays.etDate(now);
  const mondayAll = logic.buildMondayRows(await fetchMondayItems(), config).all;
  const key = process.env[config.board.serviceAccountEnv];
  const model = sheetBoard.parseBoard(await sheets.getValues(key, config.board.sheetId, config.board.range), config.board);
  const sources = sheetBoard.buildSources({ cpaRows: [], mondayAll, matchesAny: logic.matchesAny, board: config.board, goalAmount: config.managed.goal.amount });
  sheetBoard.fillActuals(model, sources);

  const snap = {};
  model.groups.forEach((g) => {
    if (!["spend", "pv", "profit"].includes(g.kind)) return;
    g.rows.forEach((r) => {
      const label = r.label;
      const m = sources.mondayByLabel[sheetBoard.norm(label)];
      const num = (i) => (i >= 0 ? sheetBoard.parseMoneyText(r.cells[i]) : null);
      const mtd = g.kind === "spend" ? num(g.actualCol) : g.kind === "pv" ? num(g.spendCol) : (m && m.spend > 0 ? m.spend : null);
      const cpa = num(g.cpaCol);
      if (mtd == null && cpa == null) return;
      snap[label] = { mtd: mtd == null ? null : mtd, cpa: cpa != null && cpa > 0 ? cpa : null };
    });
  });

  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch (_) {}
  const days = trends.record(prev.days, today, snap);
  const out = { generatedAt: now.toISOString(), today, days, summary: trends.summarizeAll(days, today) };
  fs.writeFileSync(OUT, JSON.stringify(out) + "\n");
  console.log(`Trend snapshot ${today}: ${Object.keys(snap).length} accounts, ${Object.keys(days).length} day(s) of history`);
}

main().catch((e) => { console.error(e); process.exit(1); });

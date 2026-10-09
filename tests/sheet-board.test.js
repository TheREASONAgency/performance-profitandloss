const test = require("node:test");
const assert = require("node:assert");
const config = require("../lib/status-config");
const logic = require("../lib/status-logic");
const sb = require("../lib/sheet-board");

const T = "toggle button for on track off track";
const VALUES = [
  ["Quarterly Goal:", "Total Revenue", "Actual Revenue", "", T],
  ["", "$589,500"],
  ["Retention:"],
  ["Partner", "Target Spend", "Acutal MTD", "Target CPA", "CPA"],
  ["OOO", "$100,000", "", "$65", "", T],
  ["UAC", "$100,000", "", "2.0 ROAS", "", T],
  ["", "Target Profit", "Acutal MTD", "Target CPA", "CPA"],
  ["KEE-HL", "$40,000", "", "$240", "", T],
  ["TRX", "$5,000", "", "$350", "", "On Track"],
  ["DMN", "$5,000", "", "$280", ""],
  ["", "Target CPA", "CPA", "Remaining Spend", "Total Spend"],
  ["GAL", "$400", "", "", "", T],
  [],
  ["Acquisition:"],
  ["October", "Target", "Actual", "Revenue Target", "Revenue Actual", "Quarter"],
  ["HG Retainer", "5", "1", "$37,500", "", "# of 10", T],
  ["PV Lite", "1", "", "$7,500", "", "# of 3", T],
  ["Total:", "6", "1", "$45,000", "$0", ""],
];

test("parses groups, tones, headers and fixes the Actual typo", () => {
  const m = sb.parseBoard(VALUES, config.board);
  assert.deepStrictEqual(m.groups.map((g) => g.tone), ["gray", "blue", "purple", "green"]);
  assert.strictEqual(m.groups[0].headers[1], "Actual MTD");
  assert.strictEqual(m.quarter.revenue, "$589,500");
  assert.strictEqual(m.quarter.toggle.cell, "E1");
  assert.strictEqual(m.groups[3].rows[0].toggle.cell, "G16");
  assert.strictEqual(m.groups[3].firstColLabel, "October");
  assert.deepStrictEqual(m.groups[3].headers, ["Target", "Actual", "Revenue Target", "Revenue Actual", "Quarter"]);
  const tot = m.groups[3].rows[2];
  assert.ok(tot.total && tot.toggle === null);
  assert.deepStrictEqual(tot.cells, ["6", "1", "$45,000", "$0", ""]);
});

test("toggle exists only when the cell is non-empty; state parsed", () => {
  const m = sb.parseBoard(VALUES, config.board);
  const blue = m.groups[1].rows;
  assert.strictEqual(blue.find((r) => r.label === "DMN").toggle, null);
  assert.strictEqual(blue.find((r) => r.label === "TRX").toggle.state, "on");
  assert.strictEqual(blue.find((r) => r.label === "KEE-HL").toggle.state, null);
  assert.strictEqual(sb.listToggles(m).length, 8);
});

test("fills only blank cells from sources and leaves the rest empty", () => {
  const m = sb.parseBoard(VALUES, config.board);
  const sources = sb.buildSources({
    cpaRows: [{ buyer: "Travis", name: "Keeps", profit: 12345 }, { buyer: "Joe", name: "TrimRx", profit: 100 }, { buyer: "Kurt", name: "TrimRx", profit: 50 }],
    mondayAll: [{ name: "GAL (<$400)", cpaL7d: 380.5, adSpend: 25000 }],
    matchesAny: logic.matchesAny, board: config.board, goalAmount: 100000,
  });
  sb.fillActuals(m, sources);
  const blue = m.groups[1].rows, purple = m.groups[2].rows[0];
  assert.strictEqual(blue.find((r) => r.label === "KEE-HL").cells[1], "$12,345");
  assert.strictEqual(blue.find((r) => r.label === "TRX").cells[1], "$150");
  assert.strictEqual(blue.find((r) => r.label === "DMN").cells[1], "");
  assert.deepStrictEqual(purple.cells, ["$400", "$380.50", "$75,000", "$25,000"]);
  assert.strictEqual(m.groups[0].rows[0].cells[1], ""); // retainers: no source -> blank
});

test("never overwrites a value typed in the sheet", () => {
  const v = JSON.parse(JSON.stringify(VALUES));
  v[7][2] = "$999";
  const m = sb.parseBoard(v, config.board);
  sb.fillActuals(m, { profitByLabel: { "kee-hl": 1 }, managedByLabel: {} });
  assert.strictEqual(m.groups[1].rows[0].cells[1], "$999");
});

test("Monday fallback: fills blank/zero cells only, never real values, and refreshes remaining spend", () => {
  const v = JSON.parse(JSON.stringify(VALUES));
  v[4][2] = "$0";            // OOO Actual MTD written as $0 by the Meta script
  v[5][2] = "$900";          // UAC already has a real Meta number
  v[11] = ["GAL", "$400", "", "$100,000", "$0", T];
  const m = sb.parseBoard(v, config.board);
  const src = sb.buildSources({
    cpaRows: [], matchesAny: logic.matchesAny, board: config.board, goalAmount: 100000,
    mondayAll: [
      { name: "OOO ($65)", cpaL7d: 70, adSpend: 1234 },
      { name: "UAC (2.0 ROAS)", cpaL7d: 50, adSpend: 777 },
      { name: "GAL (<$400)", cpaL7d: 380.5, adSpend: 25000 },
      { name: "GAL (<$400)", cpaL7d: 1, adSpend: 1, closed: true },   // closed duplicate loses
    ],
  });
  sb.fillActuals(m, src);
  const [ooo, uac] = m.groups[0].rows, gal = m.groups[2].rows[0];
  assert.deepStrictEqual([ooo.cells[1], ooo.cells[3]], ["$1,234", "$70"]);   // $0 -> Monday
  assert.strictEqual(uac.cells[1], "$900");                                  // real value kept
  assert.deepStrictEqual(gal.cells, ["$400", "$380.50", "$75,000", "$25,000"]);
});

test("Monday fallback skips profit rows' Actual MTD and zero Monday values", () => {
  const m = sb.parseBoard(VALUES, config.board);
  sb.fillActuals(m, { profitByLabel: {}, goalAmount: 100000,
    mondayByLabel: { "kee-hl": { cpa: 0, spend: 5000, rank: 0 } } });
  const kee = m.groups[1].rows.find((r) => r.label === "KEE-HL");
  assert.deepStrictEqual(kee.cells, ["$40,000", "", "$240", ""]); // spend never goes into profit; zero CPA ignored
});

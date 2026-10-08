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
  ["", "October", "November", "", "December", "Quarter"],
  ["HG Retainer", "# of 5", "# of 5", "", "# of 5", "# of 10", T],
];

test("parses groups, tones, headers and fixes the Actual typo", () => {
  const m = sb.parseBoard(VALUES, config.board);
  assert.deepStrictEqual(m.groups.map((g) => g.tone), ["gray", "blue", "purple", "green"]);
  assert.strictEqual(m.groups[0].headers[1], "Actual MTD");
  assert.strictEqual(m.quarter.revenue, "$589,500");
  assert.strictEqual(m.quarter.toggle.cell, "E1");
  assert.strictEqual(m.groups[3].rows[0].toggle.cell, "G16");
});

test("toggle exists only when the cell is non-empty; state parsed", () => {
  const m = sb.parseBoard(VALUES, config.board);
  const blue = m.groups[1].rows;
  assert.strictEqual(blue.find((r) => r.label === "DMN").toggle, null);
  assert.strictEqual(blue.find((r) => r.label === "TRX").toggle.state, "on");
  assert.strictEqual(blue.find((r) => r.label === "KEE-HL").toggle.state, null);
  assert.strictEqual(sb.listToggles(m).length, 7);
});

test("fills only blank cells from sources and leaves the rest empty", () => {
  const m = sb.parseBoard(VALUES, config.board);
  const sources = sb.buildSources({
    cpaRows: [{ buyer: "Travis", name: "Keeps", profit: 12345 }, { buyer: "Joe", name: "TrimRx", profit: 100 }, { buyer: "Kurt", name: "TrimRx", profit: 50 }],
    mondayManaged: [{ name: "GAL (<$400)", cpaL7d: 380.5, adSpend: 25000 }],
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

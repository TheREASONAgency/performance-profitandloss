const test = require("node:test");
const assert = require("node:assert");
const config = require("../lib/status-config");
const logic = require("../lib/status-logic");
const sb = require("../lib/sheet-board");

const T = "toggle button for on track off track";
const VALUES = [
  ["", "Total Revenue", "Actual Revenue"],
  ["Quarterly Goal:", "$589,500", "$78,908", "", "Off Track"],
  ["Monthly Goal:", "$149,000", "$78,908", "", T],
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
  assert.strictEqual(m.goals.labels.revenue, "Total Revenue");
  assert.deepStrictEqual(m.goals.rows.map((g) => [g.kind, g.revenue, g.actual]),
    [["quarterly", "$589,500", "$78,908"], ["monthly", "$149,000", "$78,908"]]);
  assert.deepStrictEqual(m.goals.rows[0].toggle, { cell: "E2", state: "off" });
  assert.strictEqual(m.goals.rows[1].toggle.state, null);
  assert.strictEqual(m.groups[3].rows[0].toggle.cell, "G17");
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
  assert.strictEqual(sb.listToggles(m).length, 9);
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
  v[8][2] = "$999";
  const m = sb.parseBoard(v, config.board);
  sb.fillActuals(m, { profitByLabel: { "kee-hl": 1 }, managedByLabel: {} });
  assert.strictEqual(m.groups[1].rows[0].cells[1], "$999");
});

test("Monday fallback: PV rows fill blank/zero cells only; Partner rows take Monday; remaining spend refreshes", () => {
  const v = JSON.parse(JSON.stringify(VALUES));
  v[5][2] = "$0";            // OOO Actual MTD written as $0 by the Meta script
  v[6][2] = "$900";          // UAC already has a real Meta number
  v[12] = ["GAL", "$400", "", "$100,000", "$0", T];
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
  assert.strictEqual(uac.cells[1], "$777");                                  // Partner rows: Monday overrides the sheet
  assert.deepStrictEqual(gal.cells, ["$400", "$380.50", "$75,000", "$25,000"]);
});

test("Monday fallback skips profit rows' Actual MTD and zero Monday values", () => {
  const m = sb.parseBoard(VALUES, config.board);
  sb.fillActuals(m, { profitByLabel: {}, goalAmount: 100000,
    mondayByLabel: { "kee-hl": { cpa: 0, spend: 5000, rank: 0 } } });
  const kee = m.groups[1].rows.find((r) => r.label === "KEE-HL");
  assert.deepStrictEqual(kee.cells, ["$40,000", "", "$240", ""]); // spend never goes into profit; zero CPA ignored
});

test("group colors follow the sheet's data-row color; white keeps the default tone", () => {
  assert.strictEqual(sb.colorHex({ red: 1, green: 1, blue: 1 }), "");
  assert.strictEqual(sb.colorHex(null), "");
  assert.strictEqual(sb.colorHex({ red: 0.8, green: 0.2 }), "#cc3300");
  const m = sb.parseBoard(VALUES, config.board);
  const bg = VALUES.map(() => []);
  bg[m.groups[1].headerRow - 1][1] = "#cccccc";
  bg[m.groups[1].rows[0].row - 1][1] = "#ff9900";
  sb.applyColors(m, bg);
  assert.strictEqual(m.groups[1].color, "#ff9900");
  assert.strictEqual(m.groups[0].color, undefined);
});

test("mondayWrites: only PV Total Spend cells that Monday filled, with column letters", () => {
  const v = JSON.parse(JSON.stringify(VALUES));
  v[12] = ["GAL", "$400", "", "$100,000", "$0", T];     // PV row at sheet row 13
  const m = sb.parseBoard(v, config.board);
  sb.fillActuals(m, { profitByLabel: {}, goalAmount: 100000,
    mondayByLabel: { gal: { cpa: 380, spend: 800.29, rank: 0 }, ooo: { cpa: 0, spend: 5, rank: 0 } } });
  assert.deepStrictEqual(sb.mondayWrites(m).filter((x) => x.label === "GAL"), [
    { a1: "C13", value: 380, label: "GAL" },
    { a1: "E13", value: 800.29, label: "GAL" },
  ]);
});

test("PV CPA: Monday L7D CPA when present, otherwise N/A; real values kept; written back", () => {
  const v = JSON.parse(JSON.stringify(VALUES));
  v[12] = ["GAL", "$400", "", "$100,000", "$0", T];
  v.splice(13, 0, ["HEY", "$225", "", "$100,000", "$0", T], ["HMD", "$350", "$300", "$100,000", "$0", T], ["ELE", "$300", "N/A", "$100,000", "$0", T]);
  const m = sb.parseBoard(v, config.board);
  sb.fillActuals(m, { profitByLabel: {}, goalAmount: 100000,
    mondayByLabel: { gal: { cpa: 380.5, spend: 0, rank: 0 }, ele: { cpa: 250, spend: 0, rank: 0 } } });
  const pv = m.groups[2].rows;
  assert.strictEqual(pv[0].cells[1], "$380.50");   // GAL: Monday
  assert.strictEqual(pv[1].cells[1], "N/A");       // HEY: no Monday row at all
  assert.strictEqual(pv[2].cells[1], "$300");      // HMD: real value kept
  assert.strictEqual(pv[3].cells[1], "$250");      // ELE: N/A is replaced once Monday has a figure
  const w = sb.mondayWrites(m).filter((x) => /^C/.test(x.a1));
  assert.deepStrictEqual(w.map((x) => [x.label, x.value]), [["GAL", 380.5], ["HEY", "N/A"], ["ELE", 250]]);
});

test("On Hold is a third toggle state", () => {
  assert.strictEqual(sb.parseToggleValue("On Hold"), "hold");
  assert.strictEqual(sb.parseToggleValue("on track"), "on");
  assert.strictEqual(sb.parseToggleValue("Off Track"), "off");
});

test("Partner (spend) rows: Monday overrides stale sheet values; rows without Monday data keep the sheet value", () => {
  const v = JSON.parse(JSON.stringify(VALUES));
  v[5][2] = "$5,802"; v[5][4] = "$99";   // OOO: stale Meta-script values
  v[6][2] = "$777";                       // UAC: no Monday data -> keep
  const m = sb.parseBoard(v, config.board);
  sb.fillActuals(m, { profitByLabel: {}, goalAmount: 100000,
    mondayByLabel: { ooo: { cpa: 70, spend: 1234, rank: 0 } } });
  const [ooo, uac] = m.groups[0].rows;
  assert.deepStrictEqual([ooo.cells[1], ooo.cells[3]], ["$1,234", "$70"]);
  assert.strictEqual(uac.cells[1], "$777");
});

test("mondayWrites also writes Partner rows' Actual MTD and CPA from Monday", () => {
  const m = sb.parseBoard(VALUES, config.board);
  sb.fillActuals(m, { profitByLabel: {}, goalAmount: 100000,
    mondayByLabel: { ooo: { cpa: 70, spend: 1234, rank: 0 } } });
  assert.deepStrictEqual(sb.mondayWrites(m).filter((x) => x.label === "OOO"), [
    { a1: "E6", value: 70, label: "OOO" },
    { a1: "C6", value: 1234, label: "OOO" },
  ]);
});

test("two active Monday items for one label: the one with an L7D CPA wins", () => {
  const src = sb.buildSources({ cpaRows: [], matchesAny: logic.matchesAny, board: config.board, goalAmount: 100000,
    mondayAll: [
      { name: "OOO ($100)", cpaL7d: null, adSpend: 512.22 },
      { name: "OOO ($60)", cpaL7d: 130.93, adSpend: 6910.18 },
    ] });
  assert.deepStrictEqual(src.mondayByLabel.ooo, { cpa: 130.93, spend: 6910.18, rank: 0 });
});

test("mondayWrites writes a blank CPA Offers CPA (KEE-HL) from Monday L7D", () => {
  const m = sb.parseBoard(VALUES, config.board);
  sb.fillActuals(m, { profitByLabel: {}, goalAmount: 100000,
    mondayByLabel: { "kee-hl": { cpa: 204.08, spend: 0, rank: 0 } } });
  assert.deepStrictEqual(sb.mondayWrites(m).filter((x) => x.label === "KEE-HL"), [{ a1: "E9", value: 204.08, label: "KEE-HL" }]);
});

test("meetings in status: same status adds 1, a change restarts at 1; counting starts on the start date", () => {
  const sd = require("../lib/status-days");
  assert.strictEqual(sd.nextCount("on", 3, "on"), 4);
  assert.strictEqual(sd.nextCount("on", 3, "off"), 1);
  assert.strictEqual(sd.nextCount(null, null, "on"), 1);
  assert.strictEqual(sd.nextCount("hold", null, "hold"), 1);
  assert.strictEqual(sd.countingStarted(new Date("2026-10-29T20:00:00Z"), "2026-10-30"), false);
  assert.strictEqual(sd.countingStarted(new Date("2026-10-30T14:00:00Z"), "2026-10-30"), true);
});

test("status cells carry the count cell right after them (G, or H for Acquisition)", () => {
  const v = JSON.parse(JSON.stringify(VALUES));
  v[5][6] = "4";                                  // OOO: count under the status cell (G6)
  const m = sb.parseBoard(v, config.board);
  assert.deepStrictEqual(m.groups[0].rows[0].toggle, { cell: "F6", state: null, countCell: "G6", count: 4 });
  assert.deepStrictEqual(m.groups[3].rows[0].toggle.countCell, "H17");
  assert.strictEqual(m.groups[3].rows[0].toggle.count, null);
});

test("Monday label match: a new item with data beats an older empty one in a better-ranked group", () => {
  const src = sb.buildSources({ cpaRows: [], matchesAny: logic.matchesAny, board: config.board, goalAmount: 100000,
    mondayAll: [
      { name: "LFA (CPA <$650 DEMO)>", cpaL7d: null, adSpend: null, groupExcluded: false },
      { name: "LFA ($300 CPQL)", cpaL7d: 287.75, adSpend: 22306.8, groupExcluded: true },
      { name: "UAC (CPBC <$250)", cpaL7d: null, adSpend: null, groupExcluded: false },
      { name: "UAC (P/L +$3000)", cpaL7d: 23.4, adSpend: 34763.52, groupExcluded: true },
      { name: "XYZ (closed)", cpaL7d: 5, adSpend: 5, closed: true },
      { name: "XYZ (open, empty)", cpaL7d: null, adSpend: null },
    ] });
  assert.deepStrictEqual(src.mondayByLabel.lfa, { cpa: 287.75, spend: 22306.8, rank: 1 });
  assert.deepStrictEqual(src.mondayByLabel.uac, { cpa: 23.4, spend: 34763.52, rank: 1 });
  assert.strictEqual(src.mondayByLabel.xyz.rank, 0);   // open item beats the closed one even if empty
});

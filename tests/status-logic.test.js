// Run: node --test tests/
const test = require("node:test");
const assert = require("node:assert");
const cfg = require("../lib/status-config");
const L = require("../lib/status-logic");

test("parseMoney handles board text formats", () => {
  assert.strictEqual(L.parseMoney("$506.14"), 506.14);
  assert.strictEqual(L.parseMoney("1,234"), 1234);
  assert.strictEqual(L.parseMoney("490"), 490);
  for (const v of ["$-", "N/A", "", null, undefined, "0", "$0.00"]) {
    assert.strictEqual(L.parseMoney(v), null, String(v));
  }
});

test("parseTargetFromName reads the first $ amount", () => {
  assert.strictEqual(L.parseTargetFromName("GAL (<$400)"), 400);
  assert.strictEqual(L.parseTargetFromName("HEY ($225)"), 225);
  assert.strictEqual(L.parseTargetFromName("DME (CPA ~$224)"), 224);
  assert.strictEqual(L.parseTargetFromName("SCH/CCH"), null);
  assert.strictEqual(L.parseTargetFromName("RHE ($"), null);
});

test("On Target CPA -> status mapping", () => {
  const m = cfg.monday.cpaStatusMap;
  assert.strictEqual(L.classifyCpaLabel("On Target", m), "on_track");
  assert.strictEqual(L.classifyCpaLabel("Over", m), "off_track");
  assert.strictEqual(L.classifyCpaLabel("N/A", m), "paused");
  assert.strictEqual(L.classifyCpaLabel("  on target ", m), "on_track");
  assert.strictEqual(L.classifyCpaLabel("Stuck", m), "unknown");
  assert.strictEqual(L.classifyCpaLabel("", m), "unknown");
  assert.strictEqual(L.classifyCpaLabel(null, m), "unknown");
});

const item = (id, name, groupId, type, label, today, l7d) => ({
  id, name, group: { id: groupId, title: groupId },
  column_values: [
    { id: cfg.monday.columns.clientType, text: type },
    { id: cfg.monday.columns.onTargetCpa, text: label },
    { id: cfg.monday.columns.cpaToday, text: today },
    { id: cfg.monday.columns.cpaL7d, text: l7d },
  ],
});

test("buildMondayRows splits PV/Managed and drops non-accounts", () => {
  const rows = L.buildMondayRows([
    item("1", "GAL (<$400)", "group_mkrzbq48", "PV / TESTING", "Over", "0", "490"),
    item("2", "UAC (CPBC <$250)", "topics", "Managed", "On Target", "$136.51", null),
    item("3", "HEY ($225)", "group_mkrzbq48", "PV / TESTING", "N/A", null, null),
    item("4", "Agenda row", "group_mm63yzx2", "PV / TESTING", "", null, null),   // excluded group
    item("5", "ARI", "topics", "Managed", "CLOSED", "$55", null),                // excluded label
    item("6", "Some SOP", "topics", "SOP", "On Target", null, null),             // other client type
    item("7", "TIT (<$200)", "group_mktr2b1m", "PV / TESTING", "Over", null, null), // closed group
  ], cfg);
  assert.deepStrictEqual(rows.pv.map((r) => r.name), ["GAL (<$400)", "HEY ($225)"]);
  assert.deepStrictEqual(rows.managed.map((r) => r.name), ["UAC (CPBC <$250)"]);
  assert.strictEqual(rows.pv[0].status, "off_track");
  assert.strictEqual(rows.pv[0].cpaToday, null);   // "0" is not a real CPA
  assert.strictEqual(rows.pv[0].cpaL7d, 490);
  assert.strictEqual(rows.pv[0].cpaTarget, 400);
  assert.strictEqual(rows.pv[1].status, "paused");
  assert.strictEqual(rows.managed[0].status, "on_track");
  assert.strictEqual(rows.managed[0].platform, "Meta");
});

test("computeCpaPacing: $15,000 target, day 5 => $2,500 expected", () => {
  const base = { monthlyTarget: 15000, daysBasis: 30, capDaysAtBasis: true };
  const behind = L.computeCpaPacing({ ...base, profit: 2000, daysElapsed: 5 });
  assert.strictEqual(behind.dailyTarget, 500);
  assert.strictEqual(behind.expectedToDate, 2500);
  assert.strictEqual(behind.status, "off_track");
  assert.strictEqual(behind.delta, -500);
  assert.strictEqual(behind.pacingPct, 80);

  assert.strictEqual(L.computeCpaPacing({ ...base, profit: 2500, daysElapsed: 5 }).status, "on_track"); // exactly on pace
  assert.strictEqual(L.computeCpaPacing({ ...base, profit: 3000, daysElapsed: 5 }).status, "on_track");
  assert.strictEqual(L.computeCpaPacing({ ...base, profit: 0, daysElapsed: 5 }).status, "off_track");
  assert.strictEqual(L.computeCpaPacing({ ...base, profit: -100, daysElapsed: 1 }).status, "off_track");
});

test("computeCpaPacing caps day 31 at the 30-day basis (configurable)", () => {
  const args = { monthlyTarget: 3000, profit: 3000, daysElapsed: 31, daysBasis: 30 };
  assert.strictEqual(L.computeCpaPacing({ ...args, capDaysAtBasis: true }).expectedToDate, 3000);
  assert.strictEqual(L.computeCpaPacing({ ...args, capDaysAtBasis: true }).status, "on_track");
  assert.ok(L.computeCpaPacing({ ...args, capDaysAtBasis: false }).expectedToDate > 3000);
});

test("buildCpaRows: skips purchases-type offers, handles no-target and not-live", () => {
  const data = {
    dayOfMonth: 5,
    buyers: [{
      id: "joe", name: "Joe", accounts: [
        { name: "TrimRx", liveThisMonth: true, monthlyTarget: 15000, pl: 1000 },
        { name: "Keeps", liveThisMonth: false, monthlyTarget: 15000, pl: 0 },
        { name: "Remedy", type: "cpa", liveThisMonth: true, cpaTarget: 700 },
        { name: "NoTarget", liveThisMonth: true, monthlyTarget: null, pl: 50 },
        { name: "Winner", liveThisMonth: true, monthlyTarget: 3000, pl: 900 },
      ],
    }],
  };
  const rows = L.buildCpaRows(data, cfg);
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.deepStrictEqual(Object.keys(by).sort(), ["Keeps", "TrimRx", "Winner"]);
  assert.strictEqual(by.TrimRx.status, "off_track");
  assert.strictEqual(by.Winner.status, "on_track");   // 900 >= 3000/30*5 = 500
  assert.strictEqual(by.Keeps.status, "paused");
  assert.strictEqual(rows[0].status, "off_track");     // off-track sorts first
});

test("currentMonthKey respects the timezone", () => {
  // 2026-11-01 03:00 UTC is still Oct 31 in Chicago.
  assert.strictEqual(L.currentMonthKey(new Date("2026-11-01T03:00:00Z"), "America/Chicago"), "2026-10");
  assert.strictEqual(L.currentMonthKey(new Date("2026-11-01T03:00:00Z"), "UTC"), "2026-11");
});

test("evaluateManagedGoal: $100K spend goal, CPA under target, period pace", () => {
  const goal = cfg.managed.goal;
  assert.strictEqual(goal.amount, 100000);
  assert.strictEqual(goal.period, "month");
  const row = { adSpend: 30000, cpaL7d: 200, cpaTarget: 224 };
  assert.strictEqual(L.evaluateManagedGoal(row, goal, 0.25).label, "On pace");        // needs 25,000
  assert.strictEqual(L.evaluateManagedGoal(row, goal, 0.5).label, "Behind pace");     // needs 50,000
  assert.strictEqual(L.evaluateManagedGoal({ ...row, cpaL7d: 250 }, goal, 0.25).label, "CPA over target");
  assert.strictEqual(L.evaluateManagedGoal({ ...row, adSpend: 100000 }, goal, 0.25).label, "Goal hit");
  assert.strictEqual(L.evaluateManagedGoal({ ...row, adSpend: null }, goal, 0.25).label, "No spend data");
  assert.strictEqual(L.evaluateManagedGoal(row, goal, null).label, "No pace data");
  assert.strictEqual(L.evaluateManagedGoal(row, { ...goal, pace: false }, 0.5).label, "In progress");
  assert.strictEqual(L.evaluateManagedGoal({ ...row, cpaL7d: null }, goal, 0.25).label, "On pace"); // unknown CPA is not a fail
});

test("goalElapsedFraction: month uses the data's day-of-month, quarter uses the quarter share", () => {
  const data = { dayOfMonth: 5, daysInMonth: 31 };
  assert.strictEqual(L.goalElapsedFraction(data, cfg, null), 5 / 31);
  assert.strictEqual(L.goalElapsedFraction({}, cfg, null), null);
  const q = { ...cfg, managed: { goal: { ...cfg.managed.goal, period: "quarter" } } };
  assert.strictEqual(L.goalElapsedFraction(data, q, { daysElapsed: 46, daysInQuarter: 92 }), 0.5);
  assert.strictEqual(L.goalElapsedFraction(data, q, null), null);
});

test("applyManagedGoal sets progress %, period and pace from the elapsed share", () => {
  const rows = [{ adSpend: 20000, cpaL7d: 100, cpaTarget: 200 }, { adSpend: null }];
  L.applyManagedGoal(rows, cfg, 0.5);
  assert.strictEqual(rows[0].goalPct, 20);
  assert.strictEqual(rows[0].goalPeriod, "month");
  assert.strictEqual(rows[0].goalPace.label, "Behind pace");   // needs 50,000
  assert.strictEqual(rows[1].goalPct, null);
  assert.strictEqual(rows[1].goalPace.label, "No spend data");
});

test("MTD Spend text column parses into adSpend on Managed rows", () => {
  assert.strictEqual(cfg.monday.columns.adSpend, "text_mm7xtsh1");
  const item = (type, spend) => ({
    id: "1", name: "DME (CPA ~$224)", group: { id: "topics", title: "G" },
    column_values: [
      { id: cfg.monday.columns.clientType, text: type },
      { id: cfg.monday.columns.onTargetCpa, text: "On Target" },
      { id: cfg.monday.columns.adSpend, text: spend },
    ],
  });
  assert.strictEqual(L.buildMondayRows([item("Managed", "$12,345.67")], cfg).managed[0].adSpend, 12345.67);
  assert.strictEqual(L.buildMondayRows([item("Managed", "")], cfg).managed[0].adSpend, null);
  assert.strictEqual(L.buildMondayRows([item("Managed", "$-")], cfg).managed[0].adSpend, null);
});

test("buildMondayRows reads ad spend from the configured column (null when absent)", () => {
  const withCol = { ...cfg, monday: { ...cfg.monday, columns: { ...cfg.monday.columns, adSpend: "numeric_test" } } };
  const mk = (id, name, type, l7d, spend) => ({
    id, name, group: { id: "topics", title: "G" },
    column_values: [
      { id: cfg.monday.columns.clientType, text: type },
      { id: cfg.monday.columns.onTargetCpa, text: "Over" },
      { id: cfg.monday.columns.cpaL7d, text: l7d },
      { id: "numeric_test", text: spend },
    ],
  });
  const items = [mk("1", "GAL (<$400)", "PV / TESTING", "490", "1200"), mk("2", "DME (CPA ~$224)", "Managed", "200", "3500.5")];
  const r = L.buildMondayRows(items, withCol);
  assert.strictEqual(r.pv[0].cpaGap, 90);            // 490 - 400, positive = over target
  assert.strictEqual(r.managed[0].adSpend, 3500.5);
  assert.strictEqual(r.managed[0].cpaGap, -24);
  assert.strictEqual(L.buildMondayRows(items, cfg).managed[0].adSpend, null);   // default: no cumulative column
});

test("Q4 2026 target table: your Oct/Nov/Dec numbers, with Medvi at $5,000/month", () => {
  const q = cfg.targets["Q4 2026"];
  assert.deepStrictEqual(q.months, ["2026-10", "2026-11", "2026-12"]);
  const monthSums = (g) => [0, 1, 2].map((i) => Object.values(q.groups[g].accounts).reduce((s, a) => s + a[i], 0));
  assert.deepStrictEqual(monthSums("retainers"), [127000, 181500, 211500]);   // matches the supplied Retainers row
  assert.deepStrictEqual(monthSums("cpa"), [60000, 80000, 100000]);           // supplied 55/75/95K + Medvi 5K each month
  assert.deepStrictEqual(Object.keys(q.groups.cpa.accounts), ["Keeps: HL", "Quad", "NAD+", "TRX", "Medvi"]); // RUG removed
  const t = L.resolveQuarterTargets({ currentQuarter: "Q4 2026" }, cfg);
  assert.strictEqual(t.source, "config");
  assert.strictEqual(t.groups.retainers.total, 520000);
  assert.strictEqual(t.groups.cpa.total, 240000);
  assert.strictEqual(t.headline, 760000);            // retainers + CPA
  assert.strictEqual(t.progress, 240000);            // only CPA has actuals
  assert.strictEqual(t.progressLabel, "CPA");
});

test("resolveQuarterTargets falls back to tracker monthly targets x 3 for an unconfigured quarter", () => {
  const data = {
    currentQuarter: "Q1 2027",
    buyers: [{ accounts: [
      { name: "A", monthlyTarget: 15000 }, { name: "B", monthlyTarget: 40000 },
      { name: "C", type: "cpa", cpaTarget: 700 }, { name: "D", monthlyTarget: null },
    ] }],
  };
  const t = L.resolveQuarterTargets(data, cfg);
  assert.strictEqual(t.source, "tracker");
  assert.strictEqual(t.headline, 165000);
  assert.strictEqual(t.progress, 165000);
});

test("cpaTargetOverride maps table labels to tracker offers for the current month", () => {
  const d = (month) => ({ currentQuarter: "Q4 2026", currentMonth: month });
  assert.strictEqual(L.cpaTargetOverride("Travis", "Keeps", d("2026-10"), cfg), 40000);
  assert.strictEqual(L.cpaTargetOverride("Travis", "Keeps", d("2026-11"), cfg), 45000);
  assert.strictEqual(L.cpaTargetOverride("Travis", "Keeps", d("2026-12"), cfg), 50000);
  assert.strictEqual(L.cpaTargetOverride("Joe", "Keeps", d("2026-10"), cfg), null);      // only Travis/Keeps is HL
  assert.strictEqual(L.cpaTargetOverride("Joe", "TrimRx", d("2026-10"), cfg), 5000);     // TRX, any buyer
  assert.strictEqual(L.cpaTargetOverride("Kurt", "trimrx", d("2026-11"), cfg), 10000);   // case-insensitive
  assert.strictEqual(L.cpaTargetOverride("Kurt", "Medvi", d("2026-10"), cfg), 5000);         // only Kurt runs Medvi
  assert.strictEqual(L.cpaTargetOverride("Jack", "Medvi", d("2026-12"), cfg), null);
  assert.strictEqual(L.cpaTargetOverride("Stefan", "Medvi GLP1", d("2026-10"), cfg), null);  // GLP1 not tracked
  assert.strictEqual(L.cpaTargetOverride("Rory", "Rugiet", d("2026-10"), cfg), null);    // removed from the table
  assert.strictEqual(L.cpaTargetOverride("Travis", "Keeps", d("2027-01"), cfg), null);   // outside the quarter
  assert.strictEqual(L.cpaTargetOverride("Travis", "Keeps", { currentQuarter: "Q1 2027", currentMonth: "2027-01" }, cfg), null);
});

test("Only Kurt's Medvi is tracked: Jack's Medvi and Medvi GLP1 are excluded", () => {
  const data = {
    currentQuarter: "Q4 2026", currentMonth: "2026-10", dayOfMonth: 5,
    buyers: [
      { id: "kurt", name: "Kurt", accounts: [{ name: "Medvi", liveThisMonth: false, monthlyTarget: 15000, pl: 0 }] },
      { id: "jack", name: "Jack", accounts: [{ name: "Medvi", liveThisMonth: false, monthlyTarget: 15000, pl: 0 }] },
      { id: "stefan", name: "Stefan", accounts: [{ name: "Medvi GLP1", liveThisMonth: true, monthlyTarget: 15000, pl: 100 }] },
    ],
  };
  const rows = L.buildCpaRows(data, cfg).filter((r) => !r.placeholder);
  assert.deepStrictEqual(rows.map((r) => `${r.buyer}/${r.name}:${r.monthlyTarget}`), ["Kurt/Medvi:5000"]);
});

test("matchesAny: Buyer/Account vs Account, case-insensitive, exact", () => {
  assert.ok(L.matchesAny(["Rugiet"], "Rory", "rugiet"));
  assert.ok(L.matchesAny(["Rory/Rugiet"], "Rory", "Rugiet"));
  assert.ok(!L.matchesAny(["Rory/Rugiet"], "Joe", "Rugiet"));
  assert.ok(!L.matchesAny(["Medvi"], "Kurt", "Medvi GLP1"));
  assert.ok(!L.matchesAny(undefined, "Kurt", "Medvi"));
});

test("buildCpaRows: Rugiet excluded, Medvi $5K, Quad/NAD+ zero placeholders, tracker fallback", () => {
  const data = {
    currentQuarter: "Q4 2026", currentMonth: "2026-11", dayOfMonth: 10,
    buyers: [
      { id: "joe", name: "Joe", accounts: [{ name: "TrimRx", liveThisMonth: true, monthlyTarget: 15000, pl: 2000 }] },
      { id: "rory", name: "Rory", accounts: [{ name: "Rugiet", liveThisMonth: true, monthlyTarget: 15000, pl: -578 }] },
      { id: "kurt", name: "Kurt", accounts: [
        { name: "Medvi", liveThisMonth: true, monthlyTarget: 15000, pl: 1000 },     // table says 5,000
        { name: "AltRx", liveThisMonth: true, monthlyTarget: 15000, pl: 6000 },     // not in table -> tracker 15000
      ] },
    ],
  };
  const rows = L.buildCpaRows(data, cfg);
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.deepStrictEqual(Object.keys(by).sort(), ["AltRx", "Medvi", "NAD+", "Quad", "TrimRx"]);   // no Rugiet
  assert.strictEqual(by.TrimRx.monthlyTarget, 10000);            // Nov TRX target, not the tracker's 15000
  assert.strictEqual(by.TrimRx.status, "off_track");             // 2000 < 3333
  assert.strictEqual(by.Medvi.monthlyTarget, 5000);
  assert.strictEqual(by.Medvi.expectedToDate, 5000 / 30 * 10);   // 1,667
  assert.strictEqual(by.Medvi.status, "off_track");              // 1000 < 1667
  assert.strictEqual(by.AltRx.monthlyTarget, 15000);
  assert.strictEqual(by.AltRx.status, "on_track");               // 6000 >= 5000
  assert.strictEqual(by.Quad.placeholder, true);
  assert.strictEqual(by.Quad.profit, 0);
  assert.strictEqual(by.Quad.monthlyTarget, 10000);              // Nov Quad target from the table
  assert.strictEqual(by["NAD+"].monthlyTarget, 10000);
  assert.strictEqual(by.Quad.status, "paused");                  // placeholders never score as off track
  assert.strictEqual(by.Quad.expectedToDate, undefined);
});

test("computeQuarterSummary: Q4 2026, day 7 of 92, separate headline and progress targets", () => {
  const q = L.computeQuarterSummary({ label: "Q4 2026", headlineTarget: 745000, progressTarget: 920000, qtdPl: 5000, today: { y: 2026, m: 10, d: 7 } });
  assert.strictEqual(q.daysInQuarter, 92);
  assert.strictEqual(q.daysElapsed, 7);
  assert.strictEqual(q.headlineTarget, 745000);
  assert.strictEqual(q.proratedTarget, 70000);       // 920000 * 7 / 92
  assert.ok(Math.abs(q.progressPct - (5000 / 920000 * 100)) < 1e-9);
  assert.ok(Math.abs(q.pacingPct - (5000 / 70000 * 100)) < 1e-9);
  assert.strictEqual(L.computeQuarterSummary({ label: "Q4 2026", headlineTarget: 1000, progressTarget: 1000, qtdPl: 0, today: { y: 2027, m: 2, d: 1 } }).daysElapsed, 92); // capped
  assert.strictEqual(L.computeQuarterSummary({ label: "Q4 2026", headlineTarget: null, progressTarget: null, qtdPl: 0, today: { y: 2026, m: 10, d: 7 } }), null);
});

test("buildSummary: headline $760K, progress vs the CPA target, Rugiet's P&L excluded", () => {
  const data = {
    currentQuarter: "Q4 2026", currentMonth: "2026-10", dayOfMonth: 5,
    buyers: [],
    months: [
      { month: "2026-09", quarter: "Q3 2026", accounts: [{ pl: 99999 }] },
      { month: "2026-10", quarter: "Q4 2026", accounts: [
        { buyer: "Travis", account: "Keeps", pl: 1500 },
        { buyer: "Joe", account: "TrimRx", pl: -500 },
        { buyer: "Rory", account: "Rugiet", pl: -578 },       // excluded from this tab
        { buyer: "Joe", account: "Blue Haven", purchases: 2 },
      ] },
    ],
  };
  const s = L.buildSummary({
    data, today: { y: 2026, m: 10, d: 30 }, cfg,
    pv: [{ status: "on_track" }, { status: "paused" }],
    managed: [{ status: "off_track" }],
    cpa: [{ status: "on_track" }, { status: "unknown" }],
  });
  const q = s.quarter;
  assert.strictEqual(q.headlineTarget, 760000);
  assert.strictEqual(q.progressTarget, 240000);
  assert.strictEqual(q.qtdPl, 1000);                 // 1500 - 500, Rugiet excluded
  assert.strictEqual(q.daysElapsed, 5);              // the data's date (Oct 5), not today (Oct 30)
  assert.ok(Math.abs(q.progressPct - (1000 / 240000 * 100)) < 1e-9);
  assert.deepStrictEqual(q.groups, [{ label: "Retainers", total: 520000 }, { label: "CPA", total: 240000 }]);
  assert.strictEqual(q.progressLabel, "CPA");
  assert.deepStrictEqual(s.accounts, { active: 3, onTrack: 2, offTrack: 1, paused: 1, total: 5 });
});

test("dataAsOf prefers the data's own date, falls back to the clock", () => {
  assert.deepStrictEqual(L.dataAsOf({ currentMonth: "2026-10", dayOfMonth: 5 }, { y: 2026, m: 10, d: 7 }), { y: 2026, m: 10, d: 5 });
  assert.deepStrictEqual(L.dataAsOf({}, { y: 2026, m: 10, d: 7 }), { y: 2026, m: 10, d: 7 });
});

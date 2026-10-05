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

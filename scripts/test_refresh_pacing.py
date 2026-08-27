#!/usr/bin/env python3
"""Tests for the pacing parser.

CI runs this before every live refresh. A red test blocks the publish.
Run locally with:  python3 scripts/test_refresh_pacing.py

Fixtures below are copied from the real shapes found in the buyer sheets:
side-by-side account blocks, an optional Notes column, an extra CLICKS/CPC
pair, 'Earnings' used instead of 'REVENUE', and #DIV/0! in the footer.
"""

import datetime as dt
import sys
import unittest
from collections import Counter

import refresh_pacing as rp
import should_run as sr


# Kurt's August tab: ALT RX in columns A-E (with Notes), MEDVI in F-K
# (with CLICKS and CPC). This is the hardest real layout.
KURT_AUGUST = [
    ["ALT RX", "ALT RX", "ALT RX", "ALT RX", "", "MEDVI", "MEDVI", "MEDVI",
     "MEDVI", "MEDVI", "MEDVI"],
    ["DATE", "REVENUE", "AD SPEND", "P/L", "Notes", "DATE", "REVENUE",
     "AD SPEND", "P/L", "CLICKS", "CPC"],
    ["08/01/2026", "$0", "$297.64", "-$297.64", "", "08/01/2026", "", "",
     "$0.00", "", "0"],
    ["08/02/2026", "$0", "$269.04", "-$269.04", "", "08/02/2026", "", "",
     "$0.00", "", "0"],
    ["08/03/2026", "$0", "$32.91", "-$32.91", "", "08/03/2026", "", "",
     "$0.00", "", "0"],
    ["08/04/2026", "$0", "$246.57", "-$246.57", "", "08/04/2026", "", "",
     "$0.00", "", "0"],
    ["08/05/2026", "", "", "$0.00", "", "08/05/2026", "", "", "$0.00", "", "0"],
    ["", "", "", "", "", "", "", "", "", "", ""],
    ["TOTALS", "Earnings", "Ad Spend", "P/L", "", "TOTALS", "Earnings",
     "Ad Spend", "P/L", "Total Clicks", "TOTAL - CPC"],
    ["", "$0", "$846", "-$846", "", "", "$0", "$0", "$0", "", ""],
    ["", "", "TARGET 20%", "#DIV/0!", "", "", "", "TARGET 20%", "#DIV/0!",
     "", ""],
]

# Jack's tab: a leading spacer column, so the banner sits at the block's
# first column but the block itself starts one column in.
JACK_APRIL = [
    ["", "Medvi", "Medvi", "Medvi", "Medvi", "", "TrimRx", "TrimRx", "TrimRx",
     "TrimRx"],
    ["", "DATE", "REVENUE", "AD SPEND", "P/L", "", "DATE", "REVENUE",
     "AD SPEND", "P/L"],
    ["", "04/01/2026", "$24,750", "$19,987", "$4,763", "", "04/01/2026", "",
     "", "$0"],
    ["", "04/02/2026", "$35,250", "$29,382", "$5,868", "", "04/02/2026", "",
     "", "$0"],
]

# An older tab that says 'Earnings' rather than 'REVENUE'.
LEGACY_EARNINGS = [
    ["Rugiet", "Rugiet", "Rugiet", "Rugiet"],
    ["Date", "Earnings", "Ad Spend", "P/L"],
    ["02/04/2025", "$750", "$282.84", "$467.16"],
    ["02/05/2025", "$250", "$1,261.34", "-$1,011.34"],
]


class TestParsingHelpers(unittest.TestCase):
    def test_normalize_folds_spacing_and_case(self):
        self.assertEqual(rp.normalize("ALT RX"), "ALTRX")
        self.assertEqual(rp.normalize("AltRx"), "ALTRX")
        self.assertEqual(rp.normalize("MEDVI | GLP1"), "MEDVIGLP1")
        self.assertEqual(rp.normalize("DME | GLP"), "DMEGLP")

    def test_parse_money(self):
        self.assertEqual(rp.parse_money("$1,234.56"), 1234.56)
        self.assertEqual(rp.parse_money("-$846"), -846.0)
        self.assertEqual(rp.parse_money("(123)"), -123.0)
        self.assertEqual(rp.parse_money("$0"), 0.0)
        self.assertIsNone(rp.parse_money("#DIV/0!"))
        self.assertIsNone(rp.parse_money(""))
        self.assertIsNone(rp.parse_money(None))

    def test_parse_money_distinguishes_zero_from_blank(self):
        # This is the whole staleness question: a typed 0 is data, a blank
        # cell is an unfilled day. They must not collapse together.
        self.assertEqual(rp.parse_money("$0"), 0.0)
        self.assertIsNone(rp.parse_money(""))

    def test_parse_date(self):
        self.assertEqual(rp.parse_date("08/01/2026"), dt.date(2026, 8, 1))
        self.assertEqual(rp.parse_date("2026-08-01"), dt.date(2026, 8, 1))
        self.assertIsNone(rp.parse_date("TOTALS"))
        self.assertIsNone(rp.parse_date(""))


class TestBlockDetection(unittest.TestCase):
    def test_finds_both_side_by_side_blocks(self):
        blocks = rp.find_blocks(KURT_AUGUST)
        self.assertEqual(len(blocks), 2)
        self.assertEqual([b["label_key"] for b in blocks], ["ALTRX", "MEDVI"])

    def test_block_columns_respect_their_own_width(self):
        alt, medvi = rp.find_blocks(KURT_AUGUST)
        self.assertEqual(alt["columns"]["date"], 0)
        self.assertEqual(alt["columns"]["spend"], 2)
        self.assertEqual(alt["columns"]["notes"], 4)
        self.assertNotIn("clicks", alt["columns"])

        self.assertEqual(medvi["columns"]["date"], 5)
        self.assertEqual(medvi["columns"]["spend"], 7)
        self.assertEqual(medvi["columns"]["clicks"], 9)

    def test_medvi_spend_is_not_read_from_altrx(self):
        # Regression guard: fixed-offset parsing would smear ALT RX's spend
        # into MEDVI and invent ~$846 of spend for an untouched account.
        _, medvi = rp.find_blocks(KURT_AUGUST)
        rows = rp.read_block_rows(KURT_AUGUST, medvi)
        self.assertTrue(all(r["spend"] is None for r in rows))

    def test_handles_leading_spacer_column(self):
        blocks = rp.find_blocks(JACK_APRIL)
        self.assertEqual([b["label_key"] for b in blocks], ["MEDVI", "TRIMRX"])

    def test_accepts_earnings_as_revenue(self):
        blocks = rp.find_blocks(LEGACY_EARNINGS)
        self.assertEqual(len(blocks), 1)
        rows = rp.read_block_rows(LEGACY_EARNINGS, blocks[0])
        self.assertEqual(rows[0]["revenue"], 750.0)


class TestRowReading(unittest.TestCase):
    def test_stops_at_totals_footer(self):
        alt = rp.find_blocks(KURT_AUGUST)[0]
        rows = rp.read_block_rows(KURT_AUGUST, alt)
        self.assertEqual(len(rows), 5)
        self.assertEqual(rows[-1]["date"], dt.date(2026, 8, 5))

    def test_does_not_absorb_the_totals_numbers(self):
        # -$846 in the footer must never land in a daily row.
        alt = rp.find_blocks(KURT_AUGUST)[0]
        rows = rp.read_block_rows(KURT_AUGUST, alt)
        self.assertNotIn(-846.0, [r["pl"] for r in rows])
        self.assertAlmostEqual(
            sum(r["spend"] or 0 for r in rows), 846.16, places=2
        )

    def test_notes_are_captured(self):
        grid = [
            ["MEDVI | GLP1"] * 5,
            ["DATE", "REVENUE", "AD SPEND", "P/L", "Notes"],
            ["06/17/2026", "$0", "$0.66", "-$0.66", "paused to check CV event"],
        ]
        block = rp.find_blocks(grid)[0]
        rows = rp.read_block_rows(grid, block)
        self.assertEqual(rows[0]["notes"], "paused to check CV event")


class TestPayload(unittest.TestCase):
    """Pacing math, checked against known values from the live dashboard."""

    TRACKER = [
        {
            "buyer_id": "travis", "buyer_name": "Travis", "sheet_id": "s1",
            "account": "Keeps", "label_key": "KEEPS", "status": "Active",
            "type": "pl", "monthly_target": 15000.0, "cpa_target": None,
        },
        {
            "buyer_id": "joe", "buyer_name": "Joe", "sheet_id": "s2",
            "account": "Remedy", "label_key": "REMEDY", "status": "Active",
            "type": "cpa", "monthly_target": None, "cpa_target": 700.0,
        },
    ]

    def _payload(self, monthly, today=dt.date(2026, 8, 10)):
        return rp.build_payload(self.TRACKER, monthly, {}, {}, today)

    def test_prorated_target_matches_live_dashboard(self):
        # 15000 / 31 * 10 = 4838.71 on the 10th of August.
        payload = self._payload({("travis", "Keeps"): {}})
        account = payload["buyers"][0]["accounts"][0]
        self.assertEqual(account["proratedTarget"], 4838.71)
        self.assertEqual(payload["daysInMonth"], 31)
        self.assertEqual(payload["dayOfMonth"], 10)

    def test_pacing_pct_matches_live_dashboard(self):
        monthly = {
            ("travis", "Keeps"): {
                "2026-08": {"revenue": 18200.0, "spend": 12984.0,
                            "pl": 5216.0, "purchases": 0.0, "has_data": True}
            }
        }
        account = self._payload(monthly)["buyers"][0]["accounts"][0]
        self.assertEqual(account["pl"], 5216)
        self.assertEqual(account["pacingPct"], 107.8)

    def test_negative_pacing(self):
        monthly = {
            ("travis", "Keeps"): {
                "2026-08": {"revenue": 0.0, "spend": 847.0, "pl": -847.0,
                            "purchases": 0.0, "has_data": True}
            }
        }
        account = self._payload(monthly)["buyers"][0]["accounts"][0]
        self.assertEqual(account["pacingPct"], -17.5)

    def test_payout_and_target_cpa_are_not_published(self):
        # They live in another system and would go stale here.
        account = self._payload({})["buyers"][0]["accounts"][0]
        self.assertNotIn("payout", account)
        self.assertNotIn("targetCpa", account)

    def test_live_this_month_follows_the_sheet_not_the_tracker(self):
        # Kurt's TrimRx case: still an Active tracker row, but nothing typed
        # into the active month, so it must not reach the Overview tab.
        monthly = {
            ("travis", "Keeps"): {
                "2026-07": {"revenue": 10.0, "spend": 1.0, "pl": 9.0,
                            "purchases": 0.0, "has_data": True}
            }
        }
        account = self._payload(monthly)["buyers"][0]["accounts"][0]
        self.assertEqual(account["status"], "Active")
        self.assertFalse(account["liveThisMonth"])

    def test_live_this_month_true_when_the_month_has_entries(self):
        monthly = {
            ("travis", "Keeps"): {
                "2026-08": {"revenue": 0.0, "spend": 12.0, "pl": -12.0,
                            "purchases": 0.0, "has_data": True}
            }
        }
        account = self._payload(monthly)["buyers"][0]["accounts"][0]
        self.assertTrue(account["liveThisMonth"])

    def test_buyer_carries_a_sheet_link_using_the_naming_convention(self):
        buyer = self._payload({})["buyers"][0]
        self.assertEqual(buyer["sheetTitle"], "Travis | CPA Offer P&L")
        self.assertEqual(buyer["sheetUrl"],
                         "https://docs.google.com/spreadsheets/d/s1/edit")

    def test_missing_target_yields_null_not_a_crash(self):
        tracker = [dict(self.TRACKER[0], monthly_target=None)]
        payload = rp.build_payload(tracker, {}, {}, {}, dt.date(2026, 8, 10))
        account = payload["buyers"][0]["accounts"][0]
        self.assertIsNone(account["proratedTarget"])
        self.assertIsNone(account["pacingPct"])

    def test_cpa_account_shape(self):
        monthly = {
            ("joe", "Remedy"): {
                "2026-08": {"revenue": 0.0, "spend": 14191.0, "pl": 0.0,
                            "purchases": 8.0, "has_data": True}
            }
        }
        account = self._payload(monthly)["buyers"][1]["accounts"][0]
        self.assertEqual(account["type"], "cpa")
        self.assertEqual(account["purchases"], 8)
        self.assertEqual(account["cpa"], 1774)  # 14191 / 8
        self.assertEqual(account["cpaTarget"], 700.0)
        self.assertNotIn("pacingPct", account)

    def test_cpa_with_zero_purchases_does_not_divide_by_zero(self):
        monthly = {
            ("joe", "Remedy"): {
                "2026-08": {"revenue": 0.0, "spend": 333.0, "pl": 0.0,
                            "purchases": 0.0, "has_data": True}
            }
        }
        account = self._payload(monthly)["buyers"][1]["accounts"][0]
        self.assertIsNone(account["cpa"])
        self.assertEqual(account["adSpend"], 333)

    def test_empty_months_are_dropped_but_current_month_survives(self):
        payload = self._payload({("travis", "Keeps"): {}})
        self.assertEqual([m["month"] for m in payload["months"]], ["2026-08"])
        self.assertEqual(payload["months"][0]["status"], "in-progress")
        self.assertEqual(payload["months"][0]["accounts"], [])

    def test_months_are_oldest_first_and_carry_a_quarter(self):
        monthly = {
            ("travis", "Keeps"): {
                "2026-05": {"revenue": 10.0, "spend": 1.0, "pl": 9.0,
                            "purchases": 0.0, "has_data": True},
                "2026-07": {"revenue": 20.0, "spend": 2.0, "pl": 18.0,
                            "purchases": 0.0, "has_data": True},
            }
        }
        months = self._payload(monthly)["months"]
        self.assertEqual([m["month"] for m in months],
                         ["2026-05", "2026-07", "2026-08"])
        self.assertEqual([m["quarter"] for m in months],
                         ["Q2 2026", "Q3 2026", "Q3 2026"])

    def test_daily_matrices_span_previous_and_current_month(self):
        # The Daily tab looks back 30 days ending yesterday, which crosses a
        # month boundary for most of the month.
        daily = {("travis", "Keeps"): {
            "2026-07-30": {"revenue": 10.0, "spend": 5.0},
            "2026-08-02": {"revenue": 20.0, "spend": 8.0},
        }}
        payload = rp.build_payload(self.TRACKER, {}, daily, {},
                                   dt.date(2026, 8, 10))
        dates = [r["date"] for r in payload["dailySpend"]["rows"]]
        self.assertTrue(any(d.startswith("2026-07") for d in dates))
        self.assertTrue(any(d.startswith("2026-08") for d in dates))

    def test_days_with_no_entry_are_absent_not_zero(self):
        # Publishing a 0 for a day nobody has filled in makes the chart draw a
        # real zero instead of a gap — the start-of-month version of the
        # trailing-day problem.
        daily = {("travis", "Keeps"): {
            "2026-08-03": {"revenue": 10.0, "spend": 5.0},
        }}
        payload = rp.build_payload(self.TRACKER, {}, daily, {},
                                   dt.date(2026, 8, 10))
        dates = [r["date"] for r in payload["dailyRevenue"]["rows"]]
        self.assertEqual(dates, ["2026-08-03"])
        self.assertNotIn("2026-08-01", dates)

    def test_no_daily_data_yields_no_rows(self):
        payload = self._payload({})
        self.assertEqual(payload["dailySpend"]["rows"], [])

    def test_february_prorating(self):
        payload = self._payload({}, today=dt.date(2026, 2, 14))
        self.assertEqual(payload["daysInMonth"], 28)
        account = payload["buyers"][0]["accounts"][0]
        self.assertEqual(account["proratedTarget"], 7500.0)

    def test_quarter_labelling(self):
        self.assertEqual(rp.quarter_of("2026-08"), "Q3 2026")
        self.assertEqual(rp.quarter_of("2026-04"), "Q2 2026")
        self.assertEqual(rp.quarter_of("2026-01"), "Q1 2026")
        self.assertEqual(rp.quarter_of("2026-12"), "Q4 2026")

    def test_month_key_rolls_back_across_new_year(self):
        self.assertEqual(rp.month_key(dt.date(2026, 2, 10), 3), "2025-11")


class TestSchedule(unittest.TestCase):
    """The DST gate. GitHub cron is UTC-only, so the workflow fires at both
    candidate hours and should_run() must let exactly one through."""

    UTC = dt.timezone.utc

    def _fires(self, year):
        """Exactly what the three cron lines in the workflow will fire."""
        day = dt.datetime(year, 1, 1, tzinfo=self.UTC)
        end = dt.datetime(year + 1, 1, 1, tzinfo=self.UTC)
        while day < end:
            dow = day.isoweekday()          # cron: 1=Mon .. 7=Sun
            if 2 <= dow <= 5:
                yield day.replace(hour=16)
                yield day.replace(hour=17)
            if dow == 1:                     # Monday morning and afternoon
                yield day.replace(hour=12)
                yield day.replace(hour=13)
                yield day.replace(hour=19)
                yield day.replace(hour=20)
            day += dt.timedelta(days=1)

    def _allowed(self, year=2026):
        return [f.astimezone(sr.ZONE)
                for f in sorted(self._fires(year)) if sr.should_run(f)]

    def test_exactly_one_noon_run_per_tue_fri(self):
        counts = Counter(l.date() for l in self._allowed() if l.hour == 12)
        self.assertTrue(all(c == 1 for c in counts.values()))
        tue_fri = sum(
            1 for i in range(365)
            if (dt.date(2026, 1, 1) + dt.timedelta(i)).weekday() in (1, 2, 3, 4)
        )
        self.assertEqual(len(counts), tue_fri)

    def test_exactly_one_monday_morning_run_per_monday(self):
        mornings = [l for l in self._allowed() if l.hour == 8]
        self.assertEqual(len(mornings), 52)
        self.assertTrue(all(l.weekday() == 0 for l in mornings))

    def test_exactly_one_monday_afternoon_run_per_monday(self):
        afternoons = [l for l in self._allowed() if l.hour == 15]
        self.assertEqual(len(afternoons), 52)
        self.assertTrue(all(l.weekday() == 0 for l in afternoons))

    def test_no_weekend_runs(self):
        self.assertFalse([l for l in self._allowed() if l.weekday() >= 5])

    def test_only_the_intended_local_slots_survive(self):
        slots = {(l.weekday(), l.hour) for l in self._allowed()}
        self.assertEqual(slots, {(1,12),(2,12),(3,12),(4,12),(0,8),(0,15)})

    def test_gate_halves_the_firings(self):
        # Both candidate hours fire; exactly one of each pair is allowed.
        self.assertEqual(len(self._allowed()) * 2, len(list(self._fires(2026))))

    def test_survives_spring_forward(self):
        # Tue-Fri noon slot around the March 2026 spring-forward.
        # 2026-03-05 is a Thursday (before), 2026-03-10 is a Tuesday (after).
        self.assertTrue(sr.should_run(dt.datetime(2026,3,5,17,tzinfo=self.UTC)))
        self.assertFalse(sr.should_run(dt.datetime(2026,3,5,16,tzinfo=self.UTC)))
        self.assertTrue(sr.should_run(dt.datetime(2026,3,10,16,tzinfo=self.UTC)))
        self.assertFalse(sr.should_run(dt.datetime(2026,3,10,17,tzinfo=self.UTC)))

    def test_survives_fall_back(self):
        # Tue-Fri noon slot around the November 2026 fall-back.
        # 2026-10-30 is a Friday (before), 2026-11-03 is a Tuesday (after).
        self.assertTrue(sr.should_run(dt.datetime(2026,10,30,16,tzinfo=self.UTC)))
        self.assertFalse(sr.should_run(dt.datetime(2026,10,30,17,tzinfo=self.UTC)))
        self.assertTrue(sr.should_run(dt.datetime(2026,11,3,17,tzinfo=self.UTC)))
        self.assertFalse(sr.should_run(dt.datetime(2026,11,3,16,tzinfo=self.UTC)))

    def test_monday_slots_survive_spring_forward(self):
        # 2026-03-02 is a Monday before the switch (EST, UTC-5);
        # 2026-03-09 is a Monday after it (EDT, UTC-4).
        self.assertTrue(sr.should_run(dt.datetime(2026,3,2,13,tzinfo=self.UTC)))   # 8am EST
        self.assertFalse(sr.should_run(dt.datetime(2026,3,2,12,tzinfo=self.UTC)))
        self.assertTrue(sr.should_run(dt.datetime(2026,3,2,20,tzinfo=self.UTC)))   # 3pm EST
        self.assertFalse(sr.should_run(dt.datetime(2026,3,2,19,tzinfo=self.UTC)))
        self.assertTrue(sr.should_run(dt.datetime(2026,3,9,12,tzinfo=self.UTC)))   # 8am EDT
        self.assertFalse(sr.should_run(dt.datetime(2026,3,9,13,tzinfo=self.UTC)))
        self.assertTrue(sr.should_run(dt.datetime(2026,3,9,19,tzinfo=self.UTC)))   # 3pm EDT
        self.assertFalse(sr.should_run(dt.datetime(2026,3,9,20,tzinfo=self.UTC)))

    def test_monday_slots_survive_fall_back(self):
        # 2026-10-26 is a Monday before the switch (EDT, UTC-4);
        # 2026-11-02 is a Monday after it (EST, UTC-5).
        self.assertTrue(sr.should_run(dt.datetime(2026,10,26,12,tzinfo=self.UTC)))  # 8am EDT
        self.assertFalse(sr.should_run(dt.datetime(2026,10,26,13,tzinfo=self.UTC)))
        self.assertTrue(sr.should_run(dt.datetime(2026,10,26,19,tzinfo=self.UTC)))  # 3pm EDT
        self.assertFalse(sr.should_run(dt.datetime(2026,10,26,20,tzinfo=self.UTC)))
        self.assertTrue(sr.should_run(dt.datetime(2026,11,2,13,tzinfo=self.UTC)))   # 8am EST
        self.assertFalse(sr.should_run(dt.datetime(2026,11,2,12,tzinfo=self.UTC)))
        self.assertTrue(sr.should_run(dt.datetime(2026,11,2,20,tzinfo=self.UTC)))   # 3pm EST
        self.assertFalse(sr.should_run(dt.datetime(2026,11,2,19,tzinfo=self.UTC)))

    def test_holds_across_a_second_year(self):
        mornings = [l for l in self._allowed(2027) if l.hour == 8]
        afternoons = [l for l in self._allowed(2027) if l.hour == 15]
        self.assertEqual(len(mornings), 52)
        self.assertEqual(len(afternoons), 52)


if __name__ == "__main__":
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""Tests for the compliance scraper.

CI runs this before every live scrape. A red test blocks the publish.
Run locally with:  python3 scripts/test_scrape_compliance.py

The fixtures in fixtures/ are the real rendered markup of the three policy
pages, captured from a headless browser on a GitHub runner (the authoring
session had no network route to Meta). They are what the extractor is
written against, so these tests exercise the real thing rather than a
hand-made approximation of it — including the page chrome that has to be
kept out of the policy text.

Nothing here touches the network: fetch_html is stubbed throughout.
"""

import datetime as dt
import os
import unittest

import scrape_compliance as sc


FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")

UTC = dt.timezone.utc
WEEK_1 = dt.datetime(2026, 9, 7, 12, 0, tzinfo=UTC)
WEEK_2 = dt.datetime(2026, 9, 14, 12, 0, tzinfo=UTC)

# Boilerplate that lives in the site footer, inside <main> but not part of
# any policy. If this ever shows up in a section, the chrome filter broke.
FOOTER_MARKERS = [
    "We have the same policies around the world",
    "Our global team of over 15,000 reviewers",
    "Outside experts, academics, NGOs and policymakers",
]


def fixture(name: str) -> str:
    with open(os.path.join(FIXTURES, f"{name}.html"), encoding="utf-8") as handle:
        return handle.read()


def serve(pages: dict[str, str]):
    """A fetch_html stand-in that serves fixture HTML by URL substring."""
    def fetch(url: str) -> str:
        for key, html in pages.items():
            if key in url:
                return html
        raise AssertionError(f"unexpected fetch: {url}")
    return fetch


def all_fixtures() -> dict[str, str]:
    return {s["id"]: fixture(s["id"]) for s in sc.SOURCES}


class TestExtractionAgainstRealPages(unittest.TestCase):
    def test_titles_come_from_the_page(self):
        expected = {
            "health-wellness": "Health and Wellness",
            "drugs-pharmaceuticals": "Drugs and Pharmaceuticals",
            "personal-attributes": "Privacy Violations and Personal Attributes",
        }
        for name, title in expected.items():
            self.assertEqual(sc.extract_policy(fixture(name))["title"], title)

    def test_each_page_yields_its_real_sections(self):
        headings = {
            name: [s["heading"] for s in sc.extract_policy(fixture(name))["sections"]]
            for name in ("health-wellness", "drugs-pharmaceuticals",
                         "personal-attributes")
        }
        self.assertEqual(headings["health-wellness"],
                         ["Health and Wellness", "Overview", "Guidelines",
                          "Adult Products and Reproductive Health",
                          "Overview", "Guidelines"])
        # The drugs page is the deepest: five policy areas, each with its
        # own Overview and Guidelines.
        for expected in ("High-Risk Drugs, Non-Medical Drugs and Entheogens",
                         "Prescription Drugs", "Over-The-Counter Drugs",
                         "Cannabis and Cannabis Derived Products"):
            self.assertIn(expected, headings["drugs-pharmaceuticals"])
        self.assertIn("Additional Guidelines for Ads",
                      headings["personal-attributes"])

    def test_policy_text_is_substantial(self):
        for name in ("health-wellness", "drugs-pharmaceuticals",
                     "personal-attributes"):
            sections = sc.extract_policy(fixture(name))["sections"]
            total = sum(len(s["text"]) for s in sections)
            self.assertGreater(total, 3000, f"{name} lost most of its text")

    def test_real_policy_language_survives(self):
        drugs = sc.extract_policy(fixture("drugs-pharmaceuticals"))["sections"]
        text = " ".join(s["text"] for s in drugs)
        self.assertIn("LegitScript", text)
        self.assertIn("over-the-counter", text.lower())

    def test_site_footer_is_not_mistaken_for_policy(self):
        for name in ("health-wellness", "drugs-pharmaceuticals",
                     "personal-attributes"):
            policy = sc.extract_policy(fixture(name))
            blob = " ".join(s["heading"] + " " + s["text"]
                            for s in policy["sections"])
            for marker in FOOTER_MARKERS:
                self.assertNotIn(marker, blob, f"{name} leaked footer chrome")
            self.assertNotIn("Enforcement",
                             [s["heading"] for s in policy["sections"]])

    def test_breadcrumb_is_not_part_of_the_policy(self):
        for name in ("health-wellness", "drugs-pharmaceuticals",
                     "personal-attributes"):
            blob = " ".join(s["text"]
                            for s in sc.extract_policy(fixture(name))["sections"])
            self.assertNotIn("Home Policies Ad Standards", blob)

    def test_inline_links_stay_in_their_sentence(self):
        # "Ads Must Comply with the Community Standard on Privacy Violations"
        # is one sentence with a link in the middle of it.
        sections = sc.extract_policy(fixture("personal-attributes"))["sections"]
        text = " ".join(s["text"] for s in sections)
        self.assertIn("Community Standard on Privacy Violations", text)

    def test_link_text_never_becomes_a_heading(self):
        # An inline "here" link has the same DOM shape as a section heading.
        for name in ("health-wellness", "drugs-pharmaceuticals",
                     "personal-attributes"):
            headings = [s["heading"]
                        for s in sc.extract_policy(fixture(name))["sections"]]
            self.assertNotIn("here", headings)
            for heading in headings:
                self.assertGreater(len(heading), 3, f"{name}: {heading!r}")

    def test_change_log_labels_are_not_sections(self):
        for name in ("health-wellness", "drugs-pharmaceuticals",
                     "personal-attributes"):
            headings = [s["heading"]
                        for s in sc.extract_policy(fixture(name))["sections"]]
            self.assertNotIn("CHANGE LOG", headings)
            self.assertNotIn("Policy details", headings)


class TestMetasOwnRevisionDates(unittest.TestCase):
    """Meta stamps each policy with its own change log — better evidence of a
    real change than our hash diff, so it has to be read correctly."""

    def test_dates_are_iso_and_newest_first(self):
        policy = sc.extract_policy(fixture("drugs-pharmaceuticals"),
                                   dt.date(2026, 9, 6))
        updates = policy["policyUpdates"]
        self.assertTrue(updates)
        self.assertEqual(updates, sorted(updates, reverse=True))
        for value in updates:
            dt.date.fromisoformat(value)  # raises if malformed
        self.assertIn("2025-02-27", updates)
        self.assertIn("2024-06-12", updates)

    def test_today_resolves_against_the_scrape_date(self):
        # The pages say "Today"; it must become the date we scraped, not
        # whatever day the test happens to run.
        policy = sc.extract_policy(fixture("health-wellness"),
                                   dt.date(2026, 9, 6))
        self.assertIn("2026-09-06", policy["policyUpdates"])
        policy = sc.extract_policy(fixture("health-wellness"),
                                   dt.date(2027, 1, 15))
        self.assertIn("2027-01-15", policy["policyUpdates"])
        self.assertNotIn("2026-09-06", policy["policyUpdates"])


class TestExtractionEdgeCases(unittest.TestCase):
    def test_empty_page_yields_nothing(self):
        policy = sc.extract_policy("<html><body></body></html>")
        self.assertEqual(policy["sections"], [])

    def test_page_without_main_does_not_explode(self):
        policy = sc.extract_policy(
            "<html><body><div><h1>T</h1></div></body></html>")
        self.assertEqual(policy["sections"], [])

    def test_short_main_keeps_its_only_child(self):
        # content_children must not treat a one-child page as chrome.
        html = ("<html><body><main><div><div>A Heading</div>"
                "<div>" + "Body text that is clearly long enough. " * 3 +
                "</div></div></main></body></html>")
        policy = sc.extract_policy(html)
        self.assertEqual([s["heading"] for s in policy["sections"]],
                         ["A Heading"])


class TestDiffing(unittest.TestCase):
    def setUp(self):
        self.source = sc.SOURCES[0]
        self.sections = sc.extract_policy(fixture("health-wellness"))["sections"]

    def _first_run(self):
        return sc.diff_sections(self.source, self.sections, None, WEEK_1)

    def test_first_run_flags_nothing(self):
        sections, events = self._first_run()
        self.assertEqual(events, [])
        self.assertTrue(all(not s["changed"] for s in sections))

    def test_unchanged_page_flags_nothing(self):
        sections, _ = self._first_run()
        again, events = sc.diff_sections(
            self.source, self.sections, {"sections": sections}, WEEK_2)
        self.assertEqual(events, [])
        self.assertTrue(all(not s["changed"] for s in again))

    def test_edit_flags_only_the_section_that_changed(self):
        sections, _ = self._first_run()
        edited = [dict(s) for s in self.sections]
        edited[2]["text"] = edited[2]["text"] + " Newly added restriction."
        after, events = sc.diff_sections(
            self.source, edited, {"sections": sections}, WEEK_2)

        self.assertEqual([s["heading"] for s in after if s["changed"]],
                         [edited[2]["heading"]])
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "changed")
        self.assertEqual(events[0]["source"], "Health & Wellness")
        self.assertEqual(events[0]["sourceId"], "health-wellness")
        self.assertEqual(events[0]["date"], "2026-09-14")

    def test_added_and_removed_sections_are_logged(self):
        sections, _ = self._first_run()
        rewritten = [dict(s) for s in self.sections[:-1]]
        rewritten.append({"heading": "Brand New Rule",
                          "text": "Something Meta did not say before, at length."})
        after, events = sc.diff_sections(
            self.source, rewritten, {"sections": sections}, WEEK_2)

        kinds = {(e["type"], e["heading"]) for e in events}
        self.assertIn(("new", "Brand New Rule"), kinds)
        self.assertTrue(any(e["type"] == "removed" for e in events))
        self.assertTrue(
            next(s for s in after if s["heading"] == "Brand New Rule")["changed"])

    def test_repeated_headings_get_distinct_ids(self):
        # Every policy area on these pages has its own "Overview" and
        # "Guidelines"; they must not collapse into one another.
        sections, _ = sc.diff_sections(
            sc.SOURCES[1],
            sc.extract_policy(fixture("drugs-pharmaceuticals"))["sections"],
            None, WEEK_1)
        ids = [s["id"] for s in sections]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertIn("overview", ids)
        self.assertIn("overview-2", ids)


class TestSourceIsolation(unittest.TestCase):
    """One broken page must never cost us the others (the lesson the sheets
    pipeline learned the hard way: one unreadable sheet took every buyer down)."""

    def setUp(self):
        self._real_fetch = sc.fetch_html
        self.pages = all_fixtures()
        sc.fetch_html = serve(self.pages)

    def tearDown(self):
        sc.fetch_html = self._real_fetch

    def test_all_configured_sources_are_scraped(self):
        payload, errors = sc.build_payload(None, WEEK_1)
        self.assertEqual(errors, [])
        self.assertEqual([s["id"] for s in payload["sources"]],
                         [s["id"] for s in sc.SOURCES])
        for source in payload["sources"]:
            self.assertTrue(source["sections"])
            self.assertTrue(source["title"])
            self.assertTrue(source["policyUpdates"])

    def test_a_failed_source_keeps_its_last_good_text(self):
        first, _ = sc.build_payload(None, WEEK_1)

        def flaky(url: str) -> str:
            if "personal-attributes" in url:
                raise RuntimeError("HTTP 403")
            return serve(self.pages)(url)

        sc.fetch_html = flaky
        second, errors = sc.build_payload(first, WEEK_2)

        broken = next(s for s in second["sources"] if s["id"] == "personal-attributes")
        healthy = next(s for s in second["sources"] if s["id"] == "health-wellness")

        self.assertEqual(len(errors), 1)
        self.assertIn("HTTP 403", broken["error"])
        # Text survives, and lastChecked stays at the last *successful* check
        # so the page never implies stale text was confirmed today.
        self.assertTrue(broken["sections"])
        self.assertEqual(broken["lastChecked"], "2026-09-07T12:00:00Z")
        self.assertEqual(broken["erroredAt"], "2026-09-14T12:00:00Z")
        self.assertTrue(broken["title"])
        # The healthy sources are unaffected.
        self.assertIsNone(healthy["error"])
        self.assertEqual(healthy["lastChecked"], "2026-09-14T12:00:00Z")

    def test_a_restructured_page_is_an_error_not_an_empty_section_list(self):
        first, _ = sc.build_payload(None, WEEK_1)
        self.pages["personal-attributes"] = "<html><body><main></main></body></html>"
        second, errors = sc.build_payload(first, WEEK_2)

        broken = next(s for s in second["sources"] if s["id"] == "personal-attributes")
        self.assertEqual(len(errors), 1)
        self.assertIn("Parsed zero sections", broken["error"])
        self.assertTrue(broken["sections"])  # last good copy retained

    def test_carried_forward_sections_are_not_flagged_as_changed(self):
        first, _ = sc.build_payload(None, WEEK_1)
        self.pages["personal-attributes"] = "<html><body><main></main></body></html>"
        second, _ = sc.build_payload(first, WEEK_2)
        broken = next(s for s in second["sources"] if s["id"] == "personal-attributes")
        self.assertTrue(all(not s["changed"] for s in broken["sections"]))

    def test_seed_placeholder_does_not_count_as_a_baseline(self):
        # The committed seed has empty sections per source. The first real
        # run must treat that as "no baseline", not as "everything is new".
        seed = {
            "seed": True,
            "sources": [dict(s, sections=[], lastChecked=None, error=None)
                        for s in sc.SOURCES],
            "changeLog": [],
        }
        payload, errors = sc.build_payload(seed, WEEK_1)
        self.assertEqual(errors, [])
        self.assertEqual(payload["changeLog"], [])
        self.assertTrue(all(not x["changed"]
                            for s in payload["sources"] for x in s["sections"]))

    def test_changelog_is_newest_first_and_bounded(self):
        first, _ = sc.build_payload(None, WEEK_1)
        first["changeLog"] = [{"date": "2026-01-01", "type": "changed",
                               "source": "old", "sourceId": "old",
                               "heading": f"Filler {i}"}
                              for i in range(sc.MAX_CHANGELOG)]
        self.pages["health-wellness"] = self.pages["health-wellness"].replace(
            "Meta restricts advertising content",
            "Meta now further restricts advertising content")
        second, _ = sc.build_payload(first, WEEK_2)

        self.assertEqual(len(second["changeLog"]), sc.MAX_CHANGELOG)
        self.assertEqual(second["changeLog"][0]["date"], "2026-09-14")
        self.assertEqual(second["changeLog"][0]["sourceId"], "health-wellness")


class TestConfiguration(unittest.TestCase):
    def test_sources_are_well_formed_and_unique(self):
        ids = [s["id"] for s in sc.SOURCES]
        self.assertEqual(len(ids), len(set(ids)), "source ids must be unique")
        for source in sc.SOURCES:
            self.assertTrue(source["url"].startswith("https://"),
                            f"{source['id']} must be fetched over https")
            self.assertTrue(source["label"])

    def test_every_source_has_a_fixture(self):
        # A new source without a fixture is a source nothing tests.
        for source in sc.SOURCES:
            self.assertTrue(
                os.path.exists(os.path.join(FIXTURES, f"{source['id']}.html")),
                f"missing fixture for {source['id']}")


if __name__ == "__main__":
    unittest.main(verbosity=2)

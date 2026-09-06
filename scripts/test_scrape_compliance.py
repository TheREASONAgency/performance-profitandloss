#!/usr/bin/env python3
"""Tests for the compliance scraper.

CI runs this before every live scrape. A red test blocks the publish.
Run locally with:  python3 scripts/test_scrape_compliance.py

The fixtures below stand in for the two markup shapes a policy page can
plausibly take — flat sibling headings, and headings buried in nested
wrapper divs the way a React-rendered page emits them — plus the failure
modes the pipeline has to survive: a page that won't fetch, and a page that
fetches fine but parses to nothing because it was restructured.

Nothing here touches the network. fetch_html is monkeypatched throughout.
"""

import datetime as dt
import unittest

import requests

import scrape_compliance as sc


UTC = dt.timezone.utc
WEEK_1 = dt.datetime(2026, 9, 7, 12, 0, tzinfo=UTC)
WEEK_2 = dt.datetime(2026, 9, 14, 12, 0, tzinfo=UTC)

# Flat markup: headings and body text are siblings.
FLAT = """
<html><body><main>
  <h1>Health and wellness</h1>
  <p>Ads must not promote unsafe products.</p>
  <h2>Supplements</h2>
  <p>Ads may not promote unsafe supplements.</p>
  <ul><li>No before-and-after images.</li></ul>
  <h2>Weight loss</h2>
  <p>Ads must target people 18 or older.</p>
</main></body></html>
"""

# The same content as a React-style page would emit it: the heading and its
# body sit in separate nested wrappers, so they are not siblings at all.
NESTED = """
<html><body><main>
  <div class="section"><div class="hd"><h2>Supplements</h2></div>
    <div class="bd"><div><p>Ads may not promote unsafe supplements.</p></div></div></div>
  <div class="section"><div class="hd"><h2>Weight loss</h2></div>
    <div class="bd"><div><p>Ads must target people 18 or older.</p></div></div></div>
</main></body></html>
"""

# Chrome, nav and script content that must never reach the policy text.
NOISY = """
<html><body>
  <nav><a href="/">Transparency Center</a></nav>
  <main>
    <script>window.__DATA__ = {"junk": true};</script>
    <style>.a { color: red; }</style>
    <h2>Prescription drugs</h2>
    <p>Only certified pharmacies may advertise.</p>
  </main>
  <footer>Meta 2026</footer>
</body></html>
"""

SOURCE = {"id": "health-wellness", "label": "Health & Wellness",
          "url": "https://example.test/health-wellness/"}


def serve(pages: dict[str, str]):
    """Build a fetch_html stand-in that serves canned HTML by URL substring."""
    def fetch(url: str) -> str:
        for key, html in pages.items():
            if key in url:
                return html
        raise AssertionError(f"unexpected fetch: {url}")
    return fetch


class TestExtraction(unittest.TestCase):
    def test_splits_flat_markup_by_heading(self):
        sections = sc.extract_sections(FLAT)
        self.assertEqual([s["heading"] for s in sections],
                         ["Health and wellness", "Supplements", "Weight loss"])

    def test_finds_headings_inside_nested_wrappers(self):
        # A sibling-only walk would return nothing here — the body text is
        # two divs deep, not a sibling of its heading.
        sections = sc.extract_sections(NESTED)
        self.assertEqual([s["heading"] for s in sections],
                         ["Supplements", "Weight loss"])
        self.assertEqual(sections[0]["text"],
                         "Ads may not promote unsafe supplements.")

    def test_sections_are_mutually_exclusive(self):
        # The h1's text must NOT swallow its h2 subsections: if it did, a
        # change in one subsection would flag its parent as changed too.
        sections = sc.extract_sections(FLAT)
        top = next(s for s in sections if s["heading"] == "Health and wellness")
        self.assertEqual(top["text"], "Ads must not promote unsafe products.")
        self.assertNotIn("Supplements", top["text"])
        self.assertNotIn("18 or older", top["text"])

    def test_list_items_are_kept_with_their_section(self):
        sections = sc.extract_sections(FLAT)
        supplements = next(s for s in sections if s["heading"] == "Supplements")
        self.assertIn("No before-and-after images.", supplements["text"])

    def test_drops_script_style_and_navigation_chrome(self):
        sections = sc.extract_sections(NOISY)
        self.assertEqual([s["heading"] for s in sections], ["Prescription drugs"])
        text = sections[0]["text"]
        self.assertNotIn("__DATA__", text)
        self.assertNotIn("color: red", text)
        self.assertNotIn("Transparency Center", text)

    def test_page_with_no_headings_still_yields_reviewable_text(self):
        sections = sc.extract_sections(
            "<html><body><main><p>Some policy prose.</p></main></body></html>")
        self.assertEqual(len(sections), 1)
        self.assertIn("Some policy prose.", sections[0]["text"])

    def test_empty_page_yields_nothing(self):
        self.assertEqual(sc.extract_sections("<html><body></body></html>"), [])


class TestDiffing(unittest.TestCase):
    def _first_run(self):
        return sc.diff_sections(SOURCE, sc.extract_sections(FLAT), None, WEEK_1)

    def test_first_run_flags_nothing(self):
        # No baseline yet. Flagging every section on day one would bury the
        # real changes that follow.
        sections, events = self._first_run()
        self.assertEqual(events, [])
        self.assertTrue(all(not s["changed"] for s in sections))

    def test_unchanged_page_flags_nothing(self):
        sections, _ = self._first_run()
        prev = {"sections": sections}
        again, events = sc.diff_sections(
            SOURCE, sc.extract_sections(FLAT), prev, WEEK_2)
        self.assertEqual(events, [])
        self.assertTrue(all(not s["changed"] for s in again))

    def test_edit_flags_only_the_section_that_changed(self):
        sections, _ = self._first_run()
        prev = {"sections": sections}
        edited = FLAT.replace("Ads must target people 18 or older.",
                              "Ads must target people 21 or older.")
        after, events = sc.diff_sections(
            SOURCE, sc.extract_sections(edited), prev, WEEK_2)

        changed = [s["heading"] for s in after if s["changed"]]
        self.assertEqual(changed, ["Weight loss"])
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "changed")
        self.assertEqual(events[0]["heading"], "Weight loss")
        self.assertEqual(events[0]["source"], "Health & Wellness")
        self.assertEqual(events[0]["sourceId"], "health-wellness")
        self.assertEqual(events[0]["date"], "2026-09-14")

    def test_added_and_removed_sections_are_logged(self):
        sections, _ = self._first_run()
        prev = {"sections": sections}
        rewritten = FLAT.replace(
            "<h2>Weight loss</h2>\n  <p>Ads must target people 18 or older.</p>",
            "<h2>Cosmetic procedures</h2>\n  <p>No graphic imagery.</p>")
        after, events = sc.diff_sections(
            SOURCE, sc.extract_sections(rewritten), prev, WEEK_2)

        kinds = {(e["type"], e["heading"]) for e in events}
        self.assertIn(("new", "Cosmetic procedures"), kinds)
        self.assertIn(("removed", "Weight loss"), kinds)
        self.assertTrue(
            next(s for s in after if s["heading"] == "Cosmetic procedures")["changed"])

    def test_duplicate_headings_get_distinct_ids(self):
        html = ("<html><body><main><h2>Overview</h2><p>One.</p>"
                "<h2>Overview</h2><p>Two.</p></main></body></html>")
        sections, _ = sc.diff_sections(
            SOURCE, sc.extract_sections(html), None, WEEK_1)
        self.assertEqual([s["id"] for s in sections], ["overview", "overview-2"])


class TestSourceIsolation(unittest.TestCase):
    """One broken page must never cost us the others (the lesson the sheets
    pipeline learned the hard way: one unreadable sheet took every buyer down)."""

    def setUp(self):
        self._real_fetch = sc.fetch_html
        self.pages = {
            "health-wellness": FLAT,
            "drugs-pharmaceuticals": NOISY,
            "personal-attributes": NESTED,
        }
        sc.fetch_html = serve(self.pages)

    def tearDown(self):
        sc.fetch_html = self._real_fetch

    def test_all_configured_sources_are_scraped(self):
        payload, errors = sc.build_payload(None, WEEK_1)
        self.assertEqual(errors, [])
        self.assertEqual([s["id"] for s in payload["sources"]],
                         [s["id"] for s in sc.SOURCES])
        self.assertTrue(all(s["sections"] for s in payload["sources"]))

    def test_a_failed_source_keeps_its_last_good_text(self):
        first, _ = sc.build_payload(None, WEEK_1)

        def flaky(url: str) -> str:
            if "personal-attributes" in url:
                raise requests.RequestException("403 Forbidden")
            return serve(self.pages)(url)

        sc.fetch_html = flaky
        second, errors = sc.build_payload(first, WEEK_2)

        broken = next(s for s in second["sources"] if s["id"] == "personal-attributes")
        healthy = next(s for s in second["sources"] if s["id"] == "health-wellness")

        self.assertEqual(len(errors), 1)
        self.assertIn("403 Forbidden", broken["error"])
        # Text survives, and lastChecked stays at the last *successful* check
        # so the page never implies stale text was confirmed today.
        self.assertTrue(broken["sections"])
        self.assertEqual(broken["lastChecked"], "2026-09-07T12:00:00Z")
        self.assertEqual(broken["erroredAt"], "2026-09-14T12:00:00Z")
        # The healthy sources are unaffected.
        self.assertIsNone(healthy["error"])
        self.assertEqual(healthy["lastChecked"], "2026-09-14T12:00:00Z")

    def test_a_restructured_page_is_an_error_not_an_empty_section_list(self):
        first, _ = sc.build_payload(None, WEEK_1)
        self.pages["personal-attributes"] = "<html><body></body></html>"
        second, errors = sc.build_payload(first, WEEK_2)

        broken = next(s for s in second["sources"] if s["id"] == "personal-attributes")
        self.assertEqual(len(errors), 1)
        self.assertIn("Parsed zero sections", broken["error"])
        self.assertTrue(broken["sections"])  # last good copy retained

    def test_carried_forward_sections_are_not_flagged_as_changed(self):
        first, _ = sc.build_payload(None, WEEK_1)
        self.pages["personal-attributes"] = "<html><body></body></html>"
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
        self.pages["health-wellness"] = FLAT.replace(
            "Ads must target people 18 or older.",
            "Ads must target people 21 or older.")
        second, _ = sc.build_payload(first, WEEK_2)

        self.assertEqual(len(second["changeLog"]), sc.MAX_CHANGELOG)
        self.assertEqual(second["changeLog"][0]["heading"], "Weight loss")
        self.assertEqual(second["changeLog"][0]["date"], "2026-09-14")


class TestConfiguration(unittest.TestCase):
    def test_sources_are_well_formed_and_unique(self):
        ids = [s["id"] for s in sc.SOURCES]
        self.assertEqual(len(ids), len(set(ids)), "source ids must be unique")
        for source in sc.SOURCES:
            self.assertTrue(source["url"].startswith("https://"),
                            f"{source['id']} must be fetched over https")
            self.assertTrue(source["label"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

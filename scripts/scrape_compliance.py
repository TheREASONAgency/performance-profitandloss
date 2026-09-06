#!/usr/bin/env python3
"""
Rebuild compliance.json for the REA Pacing Dashboard's Compliance tab.

Scrapes each Meta ad-policy page in SOURCES weekly (see
.github/workflows/refresh-compliance.yml) and diffs every section's text
against the previous run, so the dashboard can flag what changed without
storing every historical version.

Never hand-edit compliance.json. This script owns it, same as
refresh_pacing.py owns data.json — the two are separate files on separate
schedules so one refresh can never clobber the other's output.

One unreachable page never takes the others down: a source that fails keeps
the text from its last good run, is marked with the error on the page, and
the job still publishes everything else — then exits non-zero so the failure
is visible in Actions rather than passing silently.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import sys

import requests
from bs4 import BeautifulSoup

# The policy pages the dashboard tracks. Adding one is a line here — the
# page picks it up as a new sub-tab with no other change.
SOURCES = [
    {
        "id": "health-wellness",
        "label": "Health & Wellness",
        "url": (
            "https://transparency.meta.com/policies/ad-standards/"
            "restricted-goods-services/health-wellness/"
        ),
    },
    {
        "id": "drugs-pharmaceuticals",
        "label": "Drugs & Pharmaceuticals",
        "url": (
            "https://transparency.meta.com/policies/ad-standards/"
            "restricted-goods-services/drugs-pharmaceuticals/"
        ),
    },
    {
        "id": "personal-attributes",
        "label": "Personal Attributes",
        "url": (
            "https://transparency.meta.com/policies/ad-standards/"
            "objectionable-content/privacy-violations-personal-attributes/"
        ),
    },
]

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_PATH = os.path.join(REPO_ROOT, "compliance.json")

# A generic browser UA — the transparency center has been seen serving a
# stripped-down page to non-browser clients.
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

# Keep the change log bounded so the file doesn't grow forever.
MAX_CHANGELOG = 100


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "section"


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def fetch_html(url: str) -> str:
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.text


def extract_sections(html: str) -> list[dict]:
    """Split the page's main content into sections by heading.

    The page's exact markup isn't something this script can pin to (Meta can
    restructure it any time), so instead of relying on sibling structure —
    which breaks the moment a heading and its body text sit in nested wrapper
    divs, a near-certainty on a modern React site — this pulls every heading
    and text-bearing block in *document order* regardless of nesting depth,
    then assigns each block of text to whichever heading most recently
    preceded it. That also keeps sections mutually exclusive: unlike a
    strict hierarchy walk (h1 "owns" its h2 children's text too), a change
    inside one subsection can't also flag its parent section as changed.
    """
    soup = BeautifulSoup(html, "html.parser")

    for tag in soup(["script", "style", "nav", "header", "footer"]):
        tag.decompose()

    main = soup.find("main") or soup.body or soup
    blocks = main.find_all(["h1", "h2", "h3", "h4", "p", "li", "blockquote"])

    sections: list[dict] = []
    current_heading: str | None = None
    current_parts: list[str] = []

    def flush() -> None:
        if current_heading is None:
            return
        text = clean_text(" ".join(current_parts))
        if text:
            sections.append({"heading": current_heading, "text": text})

    for block in blocks:
        if block.name in ("h1", "h2", "h3", "h4"):
            flush()
            current_heading = clean_text(block.get_text(" "))
            current_parts = []
        else:
            current_parts.append(block.get_text(" "))
    flush()

    if not sections:
        # No usable heading/paragraph structure at all — fall back to one
        # section holding the whole page's text so a redesign still produces
        # something reviewable instead of silently going empty.
        text = clean_text(main.get_text(" "))
        if text:
            sections.append({"heading": "Policy text", "text": text})

    return sections


def load_previous() -> dict | None:
    if not os.path.exists(OUTPUT_PATH):
        return None
    try:
        with open(OUTPUT_PATH, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (json.JSONDecodeError, OSError):
        return None


def diff_sections(source: dict, sections: list[dict], prev_source: dict | None,
                  now: dt.datetime) -> tuple[list[dict], list[dict]]:
    """Hash this source's sections and diff them against its last good run.

    Returns (sections, change events). Nothing is flagged as changed or new
    on a source's first successful run — there is no baseline to compare
    against, and flagging every section on day one would bury the real
    changes that follow.
    """
    had_baseline = prev_source is not None and bool(prev_source.get("sections"))
    prev_by_slug = {s["id"]: s for s in (prev_source or {}).get("sections", [])}

    date_str = now.strftime("%Y-%m-%d")
    seen_slugs: set[str] = set()
    out_sections: list[dict] = []
    events: list[dict] = []

    def event(kind: str, heading: str) -> dict:
        return {
            "date": date_str,
            "type": kind,
            "source": source["label"],
            "sourceId": source["id"],
            "heading": heading,
        }

    for section in sections:
        slug = slugify(section["heading"])
        base_slug, n = slug, 2
        while slug in seen_slugs:
            slug = f"{base_slug}-{n}"
            n += 1
        seen_slugs.add(slug)

        text_hash = hash_text(section["text"])
        prior = prev_by_slug.get(slug)
        changed = had_baseline and prior is not None and prior.get("textHash") != text_hash
        is_new = had_baseline and prior is None

        if changed:
            events.append(event("changed", section["heading"]))
        elif is_new:
            events.append(event("new", section["heading"]))

        out_sections.append({
            "id": slug,
            "heading": section["heading"],
            "text": section["text"],
            "textHash": text_hash,
            "changed": changed or is_new,
        })

    if had_baseline:
        for slug in set(prev_by_slug) - seen_slugs:
            events.append(event("removed", prev_by_slug[slug]["heading"]))

    return out_sections, events


def scrape_source(source: dict, prev_source: dict | None,
                  now: dt.datetime) -> tuple[dict, list[dict], str | None]:
    """Scrape one policy page. Returns (source payload, events, error).

    On any failure the previous run's sections are carried forward untouched
    and the error is recorded on the source, so the tab keeps showing the
    last known policy text — clearly stamped with when it was last confirmed
    — instead of going blank.
    """
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    base = {
        "id": source["id"],
        "label": source["label"],
        "url": source["url"],
    }

    def failed(message: str) -> tuple[dict, list[dict], str]:
        print(f"  ERROR: {message}")
        carried = (prev_source or {}).get("sections", [])
        return (
            {
                **base,
                # lastChecked stays at the last *successful* check so the page
                # never implies stale text was confirmed today.
                "lastChecked": (prev_source or {}).get("lastChecked"),
                "error": message,
                "erroredAt": stamp,
                "sections": [dict(s, changed=False) for s in carried],
            },
            [],
            message,
        )

    try:
        html = fetch_html(source["url"])
    except requests.RequestException as exc:
        return failed(f"Could not fetch {source['url']}: {exc}")

    sections = extract_sections(html)
    if not sections:
        return failed(
            f"Parsed zero sections from {source['url']} — the page layout "
            f"likely changed; fix extract_sections() in scrape_compliance.py"
        )

    out_sections, events = diff_sections(source, sections, prev_source, now)
    changed = sum(1 for s in out_sections if s["changed"])
    print(f"  {len(out_sections)} sections, {changed} changed since last check")

    return (
        {**base, "lastChecked": stamp, "error": None, "sections": out_sections},
        events,
        None,
    )


def build_payload(previous: dict | None, now: dt.datetime) -> tuple[dict, list[str]]:
    prev_by_id = {s["id"]: s for s in (previous or {}).get("sources", [])}
    prev_changelog = (previous or {}).get("changeLog", [])

    sources: list[dict] = []
    events: list[dict] = []
    errors: list[str] = []

    for source in SOURCES:
        print(f"Scraping {source['label']} ({source['url']})")
        payload, source_events, error = scrape_source(
            source, prev_by_id.get(source["id"]), now
        )
        sources.append(payload)
        events.extend(source_events)
        if error:
            errors.append(f"{source['label']}: {error}")

    return {
        "lastChecked": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sources": sources,
        "changeLog": (events + prev_changelog)[:MAX_CHANGELOG],
    }, errors


def main() -> None:
    previous = load_previous()
    payload, errors = build_payload(previous, dt.datetime.now(dt.timezone.utc))

    if all(s.get("error") for s in payload["sources"]):
        sys.exit(
            "Every source failed — leaving compliance.json untouched.\n  "
            + "\n  ".join(errors)
        )

    with open(OUTPUT_PATH, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")

    sections = sum(len(s["sections"]) for s in payload["sources"])
    changed = sum(1 for s in payload["sources"] for x in s["sections"] if x["changed"])
    ok = sum(1 for s in payload["sources"] if not s.get("error"))
    print(f"Wrote {OUTPUT_PATH}: {ok}/{len(payload['sources'])} sources, "
          f"{sections} sections, {changed} changed since last check")

    # The good sources are written and committable; still fail the job so a
    # broken source is visible in Actions instead of passing green.
    if errors:
        sys.exit(
            "PARTIAL_FAILURE: published the sources that worked, kept the last "
            "good text for the ones that did not:\n  " + "\n  ".join(errors)
        )


if __name__ == "__main__":
    main()

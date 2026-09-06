#!/usr/bin/env python3
"""
Rebuild compliance.json for the REA Pacing Dashboard's Compliance tab.

Scrapes Meta's Health & Wellness restricted-goods-and-services ad policy page
weekly (see .github/workflows/refresh-compliance.yml) and diffs each section's
text against the previous run, so the dashboard can flag what changed without
storing every historical version.

Never hand-edit compliance.json. This script owns it, same as
refresh_pacing.py owns data.json — the two are separate files on separate
schedules so one refresh can never clobber the other's output.
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

SOURCE_URL = (
    "https://transparency.meta.com/policies/ad-standards/"
    "restricted-goods-services/health-wellness/"
)

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


def build_payload(sections: list[dict], previous: dict | None,
                   now: dt.datetime) -> dict:
    had_baseline = previous is not None and not previous.get("seed")
    prev_by_slug = {s["id"]: s for s in (previous or {}).get("sections", [])}
    prev_changelog = (previous or {}).get("changeLog", [])

    date_str = now.strftime("%Y-%m-%d")
    seen_slugs: set[str] = set()
    out_sections: list[dict] = []
    events: list[dict] = []

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
            events.append({"date": date_str, "type": "changed", "heading": section["heading"]})
        elif is_new:
            events.append({"date": date_str, "type": "new", "heading": section["heading"]})

        out_sections.append({
            "id": slug,
            "heading": section["heading"],
            "text": section["text"],
            "textHash": text_hash,
            "changed": changed or is_new,
        })

    if had_baseline:
        for slug in set(prev_by_slug) - seen_slugs:
            events.append({
                "date": date_str,
                "type": "removed",
                "heading": prev_by_slug[slug]["heading"],
            })

    return {
        "lastChecked": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sourceUrl": SOURCE_URL,
        "sections": out_sections,
        "changeLog": (events + prev_changelog)[:MAX_CHANGELOG],
    }


def main() -> None:
    try:
        html = fetch_html(SOURCE_URL)
    except requests.RequestException as exc:
        sys.exit(f"Could not fetch {SOURCE_URL}: {exc}")

    sections = extract_sections(html)
    if not sections:
        sys.exit(
            "Parsed zero sections from the policy page — the page layout "
            "likely changed. Leaving compliance.json untouched; fix "
            "extract_sections() in scrape_compliance.py before re-running."
        )

    previous = load_previous()
    payload = build_payload(sections, previous, dt.datetime.now(dt.timezone.utc))

    with open(OUTPUT_PATH, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")

    changed_count = sum(1 for s in payload["sections"] if s["changed"])
    print(f"Wrote {OUTPUT_PATH}: {len(payload['sections'])} sections, "
          f"{changed_count} changed since last check")


if __name__ == "__main__":
    main()

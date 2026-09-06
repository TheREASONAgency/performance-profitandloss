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

Why a headless browser and not requests: these pages are client-rendered.
A plain requests.get answers HTTP 400 with a 253KB Facebook app shell
containing zero headings and zero paragraphs; a full browser header set
gets 200 but still no content. Only a rendered page yields policy text.
That was measured against the live pages, not assumed.

Why the extractor ignores CSS classes: Meta's design system emits
generated atomic class names (x1motxo8, xeuugli...) that churn. Everything
here keys on structure instead — <main>'s child layout, the
heading-then-body pair each section is built from, and whether text sits
inside a link. Verified against captured markup from all three pages; the
fixtures in scripts/fixtures/ are that markup.

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

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# Keep the change log bounded so the file doesn't grow forever.
MAX_CHANGELOG = 100

# Meta stamps each policy with its own revision dates, which beat any hash
# diff for "when did this actually change".
DATE_RE = re.compile(r"^(Today|Yesterday|[A-Z][a-z]{2} \d{1,2}, \d{4})$")

# Tags that sit inside a sentence rather than forming a block of their own.
INLINE_TAGS = {"a", "b", "i", "em", "strong", "u", "span", "br", "sup", "sub"}

# Chrome that appears in the article column but is not policy text.
SKIP_LABELS = {"Policy details", "CHANGE LOG"}


# --------------------------------------------------------------------------
# Small parsing helpers
# --------------------------------------------------------------------------

def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "section"


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def own_text(el) -> str:
    """Text belonging to this element itself, not to its children."""
    return clean_text("".join(c for c in el.children if isinstance(c, str)))


def element_children(el) -> list:
    return [c for c in el.children if getattr(c, "name", None)]


def is_inline_only(el) -> bool:
    return all(c.name in INLINE_TAGS for c in element_children(el))


def block_text(el) -> str:
    """One block's text, keeping any links that sit inside its sentence."""
    return clean_text(el.get_text(" ")) if is_inline_only(el) else own_text(el)


def in_link(el) -> bool:
    return el.name == "a" or el.find_parent("a") is not None


# --------------------------------------------------------------------------
# Fetching
# --------------------------------------------------------------------------

def fetch_html(url: str) -> str:
    """Render a policy page in headless Chromium and return its HTML.

    Imported lazily so the tests — which stub this out — don't need a
    browser installed.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page(
                user_agent=USER_AGENT,
                viewport={"width": 1280, "height": 2400},
                locale="en-US",
            )
            response = page.goto(url, wait_until="networkidle", timeout=60000)
            if response is not None and response.status >= 400:
                raise RuntimeError(f"HTTP {response.status} from {url}")
            # The policy body hydrates after networkidle on a slow run.
            page.wait_for_timeout(3000)
            return page.content()
        finally:
            browser.close()


# --------------------------------------------------------------------------
# Extraction
# --------------------------------------------------------------------------

def content_children(main) -> list:
    """The article blocks of <main>, without the page chrome.

    <main> lays out as: breadcrumb and title, the policy article, sometimes
    a block of worked examples, then a fixed site-footer nav strip. Position
    identifies them rather than class names, and the footer is only dropped
    when it really looks like the nav strip (short, several links), so a page
    with a different shape loses nothing.
    """
    kids = element_children(main)
    if len(kids) < 2:
        return kids
    body = kids[1:]
    if len(body) > 1:
        last = body[-1]
        if len(clean_text(last.get_text(" "))) < 600 and len(last.find_all("a")) >= 2:
            body = body[:-1]
    return body


def is_heading(el, text: str) -> bool:
    """Is this block a section heading?

    Meta builds each section as one parent holding a short heading block
    followed by its body. Link text never qualifies: an inline link ("here")
    has the same shape, and so do the footer's nav cards.
    """
    parent = el.parent
    if parent is None or in_link(el):
        return False
    sibs = element_children(parent)
    if len(sibs) < 2 or sibs[0] is not el:
        return False
    if len(text) > 90 or text.endswith((".", ":", "!", "?", ",")):
        return False
    if len(sibs) == 2:
        return True
    # Lists of worked examples put the heading ahead of many siblings; only
    # treat it as one when what follows clearly outweighs it.
    rest = clean_text(" ".join(s.get_text(" ") for s in sibs[1:]))
    return len(rest) >= max(120, 3 * len(text))


def policy_update_dates(soup, today: dt.date) -> list[str]:
    """Meta's own revision dates, from the CHANGE LOG beside the title."""
    label = next((el for el in soup.find_all(True)
                  if own_text(el) == "CHANGE LOG"), None)
    if label is None:
        return []

    def to_iso(text: str) -> str | None:
        if text == "Today":
            return today.isoformat()
        if text == "Yesterday":
            return (today - dt.timedelta(days=1)).isoformat()
        try:
            return dt.datetime.strptime(text, "%b %d, %Y").date().isoformat()
        except ValueError:
            return None

    anc = label
    for _ in range(6):
        anc = anc.parent
        if anc is None:
            break
        found, seen = [], set()
        for el in anc.find_all(True):
            text = own_text(el)
            if DATE_RE.match(text) and text not in seen:
                seen.add(text)
                iso = to_iso(text)
                if iso:
                    found.append(iso)
        if found:
            return sorted(set(found), reverse=True)
    return []


def extract_policy(html: str, today: dt.date | None = None) -> dict:
    """Pull the title, Meta's revision dates, and the sections off a page."""
    today = today or dt.date.today()
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["style", "script", "noscript"]):
        tag.decompose()

    h1 = soup.find("h1")
    title = clean_text(h1.get_text(" ")) if h1 else None
    updates = policy_update_dates(soup, today)

    main = soup.find("main") or soup.body or soup
    raw: list[dict] = []
    current: dict | None = None
    consumed: set[int] = set()

    for child in content_children(main):
        for el in child.find_all(True):
            if id(el) in consumed:
                continue
            text = block_text(el)
            if not text or text in SKIP_LABELS or DATE_RE.match(text):
                continue

            heading = own_text(el) or text
            if is_heading(el, heading):
                current = {"heading": heading, "parts": []}
                raw.append(current)
            elif current is not None:
                current["parts"].append(text)
            else:
                continue

            if is_inline_only(el):
                consumed.update(id(d) for d in el.find_all(True))

    sections = []
    for entry in raw:
        # A block's text also appears inside its ancestors; keep the fullest
        # rendering of each passage and drop the fragments it contains.
        parts: list[str] = []
        for part in entry["parts"]:
            if any(part in kept for kept in parts):
                continue
            parts = [kept for kept in parts if kept not in part]
            parts.append(part)
        text = clean_text(" ".join(parts))
        if len(text) >= 40:
            sections.append({"heading": entry["heading"], "text": text})

    return {"title": title, "policyUpdates": updates, "sections": sections}


# --------------------------------------------------------------------------
# Diffing
# --------------------------------------------------------------------------

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


# --------------------------------------------------------------------------
# Payload assembly
# --------------------------------------------------------------------------

def load_previous() -> dict | None:
    if not os.path.exists(OUTPUT_PATH):
        return None
    try:
        with open(OUTPUT_PATH, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (json.JSONDecodeError, OSError):
        return None


def scrape_source(source: dict, prev_source: dict | None,
                  now: dt.datetime) -> tuple[dict, list[dict], str | None]:
    """Scrape one policy page. Returns (source payload, events, error).

    On any failure the previous run's sections are carried forward untouched
    and the error is recorded on the source, so the tab keeps showing the
    last known policy text — clearly stamped with when it was last confirmed
    — instead of going blank.
    """
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    base = {"id": source["id"], "label": source["label"], "url": source["url"]}

    def failed(message: str) -> tuple[dict, list[dict], str]:
        print(f"  ERROR: {message}")
        carried = (prev_source or {}).get("sections", [])
        return (
            {
                **base,
                # lastChecked stays at the last *successful* check so the page
                # never implies stale text was confirmed today.
                "lastChecked": (prev_source or {}).get("lastChecked"),
                "title": (prev_source or {}).get("title"),
                "policyUpdates": (prev_source or {}).get("policyUpdates", []),
                "error": message,
                "erroredAt": stamp,
                "sections": [dict(s, changed=False) for s in carried],
            },
            [],
            message,
        )

    try:
        html = fetch_html(source["url"])
    except Exception as exc:  # noqa: BLE001 - the message is what matters
        return failed(f"Could not fetch {source['url']}: {exc}")

    try:
        policy = extract_policy(html, now.date())
    except Exception as exc:  # noqa: BLE001
        return failed(f"Could not parse {source['url']}: {exc}")

    if not policy["sections"]:
        return failed(
            f"Parsed zero sections from {source['url']} — the page layout "
            f"likely changed; fix extract_policy() in scrape_compliance.py"
        )

    out_sections, events = diff_sections(source, policy["sections"],
                                         prev_source, now)
    changed = sum(1 for s in out_sections if s["changed"])
    print(f"  {len(out_sections)} sections, {changed} changed since last check"
          f" | Meta revisions: {', '.join(policy['policyUpdates']) or 'none listed'}")

    return (
        {
            **base,
            "lastChecked": stamp,
            "title": policy["title"],
            "policyUpdates": policy["policyUpdates"],
            "error": None,
            "sections": out_sections,
        },
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

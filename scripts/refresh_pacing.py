#!/usr/bin/env python3
"""
Rebuild data.json for the REA CPA Pacing Dashboard.

Reads the Accounts and Targets Tracker (source of truth for the account roster
and every target) plus each media buyer's "<Name> | CPA Offer(s) P&L" sheet,
and emits data.json at the repo root.

Never hand-edit data.json. This script owns it.

Auth: set GOOGLE_SA_KEY to the full JSON of a Google service account key.
Every sheet below must be shared (Viewer is enough) with that service
account's client_email.
"""

from __future__ import annotations

import calendar
import datetime as dt
import json
import os
import re
import sys
from collections import defaultdict
from typing import Any

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

# The Accounts and Targets Tracker. Everything about *what* to track lives
# there, not here. Adding an account or changing a target is a sheet edit.
TRACKER_SHEET_ID = os.environ.get(
    "TRACKER_SHEET_ID", "1NY1paU3-5Idv5wbq-7OXClnUvhUO4wrCPVtZYbzChKU"
)

# Buyer sheet titles follow "<Buyer> | CPA Offer P&L". The real files have
# drifted (Offers vs Offer, trailing spaces), so the dashboard labels links
# with the convention rather than whatever the file happens to be called.
SHEET_TITLE_CONVENTION = "{buyer} | CPA Offer P&L"

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_PATH = os.path.join(REPO_ROOT, "data.json")

# How many prior months of history to carry in the payload.
HISTORY_MONTHS = 12


# --------------------------------------------------------------------------
# Small parsing helpers
# --------------------------------------------------------------------------

def normalize(s: Any) -> str:
    """Fold a label to a comparison key: 'ALT RX' and 'AltRx' both -> 'ALTRX'."""
    return re.sub(r"[^A-Z0-9]", "", str(s or "").upper())


def parse_money(cell: Any) -> float | None:
    """Parse a sheet cell into a number. Returns None for blanks and errors.

    Handles '$1,234.56', '-$846', '(123)', '#DIV/0!', '', None.
    """
    if cell is None:
        return None
    s = str(cell).strip()
    if not s or s.startswith("#"):
        return None
    negative = s.startswith("(") and s.endswith(")")
    if negative:
        s = s[1:-1]
    s = s.replace("$", "").replace(",", "").replace("%", "").strip()
    if s in ("", "-", "--"):
        return None
    try:
        value = float(s)
    except ValueError:
        return None
    return -value if negative else value


def parse_date(cell: Any) -> dt.date | None:
    """Parse a sheet date cell. Sheets hands these back as MM/DD/YYYY strings."""
    if cell is None:
        return None
    s = str(cell).strip()
    if not s:
        return None
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y", "%m-%d-%Y"):
        try:
            return dt.datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


# Column header synonyms, normalized. The buyer sheets are not consistent:
# some say REVENUE, some say Earnings; some carry a Notes or CLICKS column.
COLUMN_ALIASES = {
    "date": {"DATE"},
    "revenue": {"REVENUE", "EARNINGS"},
    "spend": {"ADSPEND", "SPEND"},
    "pl": {"PL", "PROFITLOSS", "PANDL"},
    "purchases": {"PURCHASES", "CONVERSIONS", "SALES"},
    "clicks": {"CLICKS", "TOTALCLICKS"},
    "cpc": {"CPC"},
    "notes": {"NOTES", "NOTE"},
}


def classify_header(cell: Any) -> str | None:
    key = normalize(cell)
    for name, aliases in COLUMN_ALIASES.items():
        if key in aliases:
            return name
    return None


# --------------------------------------------------------------------------
# Block detection
# --------------------------------------------------------------------------

def find_blocks(grid: list[list[Any]]) -> list[dict]:
    """Locate every account block in a tab.

    A tab can hold several account blocks laid out side by side, each with its
    own DATE column and its own merged account-name banner in the row above the
    header. Column counts vary between blocks (some carry Notes, CLICKS, CPC).

    Strategy: find each header row (a row containing at least one DATE cell).
    Each DATE cell opens a block; the block owns every column from that DATE up
    to the column before the next DATE in the same row (or the end of the row).
    The account label is the nearest non-empty cell at or right of the block's
    first column in the banner row above.
    """
    blocks: list[dict] = []

    for row_idx, row in enumerate(grid):
        date_cols = [i for i, cell in enumerate(row) if classify_header(cell) == "date"]
        if not date_cols:
            continue

        banner_row = grid[row_idx - 1] if row_idx > 0 else []

        for n, start in enumerate(date_cols):
            end = date_cols[n + 1] if n + 1 < len(date_cols) else len(row)

            columns: dict[str, int] = {}
            for col in range(start, min(end, len(row))):
                name = classify_header(row[col])
                if name and name not in columns:
                    columns[name] = col

            if "date" not in columns:
                continue

            label = ""
            for col in range(start, min(end, len(banner_row))):
                candidate = str(banner_row[col] or "").strip()
                if candidate:
                    label = candidate
                    break
            # Banners sit to the LEFT of the block on a few tabs where the
            # block is preceded by a spacer column.
            if not label and start > 0 and start - 1 < len(banner_row):
                label = str(banner_row[start - 1] or "").strip()

            blocks.append(
                {
                    "label": label,
                    "label_key": normalize(label),
                    "header_row": row_idx,
                    "columns": columns,
                }
            )

    return blocks


def read_block_rows(grid: list[list[Any]], block: dict) -> list[dict]:
    """Read the dated rows of one block, stopping at the totals footer."""
    cols = block["columns"]
    out: list[dict] = []

    for row in grid[block["header_row"] + 1:]:
        date_idx = cols["date"]
        raw = row[date_idx] if date_idx < len(row) else None

        # TOTALS / blank rows end the block's data region. A single blank row
        # is tolerated because a few tabs have a spacer before the footer.
        if normalize(raw).startswith("TOTAL"):
            break
        date = parse_date(raw)
        if date is None:
            if str(raw or "").strip():
                break
            continue

        def cell(name: str):
            idx = cols.get(name)
            if idx is None or idx >= len(row):
                return None
            return row[idx]

        out.append(
            {
                "date": date,
                "revenue": parse_money(cell("revenue")),
                "spend": parse_money(cell("spend")),
                "pl": parse_money(cell("pl")),
                "purchases": parse_money(cell("purchases")),
                "notes": (str(cell("notes") or "").strip() or None),
            }
        )

    return out


# --------------------------------------------------------------------------
# Google Sheets access
# --------------------------------------------------------------------------

def sheets_client():
    raw = os.environ.get("GOOGLE_SA_KEY")
    if not raw:
        sys.exit(
            "GOOGLE_SA_KEY is not set. Paste the full service account JSON key "
            "into the repo secret GOOGLE_SA_KEY (Settings -> Secrets and "
            "variables -> Actions)."
        )
    try:
        info = json.loads(raw)
    except json.JSONDecodeError as exc:
        sys.exit(f"GOOGLE_SA_KEY is not valid JSON: {exc}")

    print(f"Authenticating as {info.get('client_email', '<unknown>')}")
    creds = Credentials.from_service_account_info(info, scopes=SCOPES)
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def fetch_all_tabs(service, sheet_id: str) -> dict[str, list[list[Any]]]:
    """Return {tab_title: grid} for every tab in a spreadsheet."""
    try:
        meta = service.spreadsheets().get(spreadsheetId=sheet_id).execute()
    except Exception as exc:  # noqa: BLE001 - we want the message, not the class
        raise RuntimeError(
            f"Could not open spreadsheet {sheet_id}. If this is a 403, the "
            f"sheet is not shared with the service account. Original: {exc}"
        ) from exc

    titles = [s["properties"]["title"] for s in meta.get("sheets", [])]
    grids: dict[str, list[list[Any]]] = {}

    # batchGet in chunks so a buyer with many month tabs stays one round trip.
    for i in range(0, len(titles), 25):
        chunk = titles[i:i + 25]
        resp = (
            service.spreadsheets()
            .values()
            .batchGet(
                spreadsheetId=sheet_id,
                ranges=[f"'{t}'" for t in chunk],
                valueRenderOption="FORMATTED_VALUE",
            )
            .execute()
        )
        for title, value_range in zip(chunk, resp.get("valueRanges", [])):
            grids[title] = value_range.get("values", [])

    return grids


def load_tracker(service) -> list[dict]:
    grids = fetch_all_tabs(service, TRACKER_SHEET_ID)
    if not grids:
        sys.exit("Accounts and Targets Tracker is empty.")

    grid = next(iter(grids.values()))
    if not grid:
        sys.exit("Accounts and Targets Tracker has no rows.")

    header = [normalize(c) for c in grid[0]]

    def col(name: str) -> int | None:
        key = normalize(name)
        return header.index(key) if key in header else None

    required = ["buyer_id", "buyer_name", "sheet_id", "account"]
    missing = [r for r in required if col(r) is None]
    if missing:
        sys.exit(
            f"Accounts and Targets Tracker is missing required column(s): "
            f"{', '.join(missing)}"
        )

    rows: list[dict] = []
    for raw in grid[1:]:
        def get(name: str):
            idx = col(name)
            if idx is None or idx >= len(raw):
                return None
            value = str(raw[idx]).strip()
            return value or None

        if not get("buyer_id") or not get("account"):
            continue

        account = get("account")
        rows.append(
            {
                "buyer_id": get("buyer_id"),
                "buyer_name": get("buyer_name") or get("buyer_id"),
                "sheet_id": get("sheet_id"),
                "account": account,
                # sheet_label is an optional override for when the banner text
                # in the buyer's sheet doesn't normalize to the account name.
                "label_key": normalize(get("sheet_label") or account),
                "status": get("status") or "Active",
                "type": (get("type") or "pl").lower(),
                "monthly_target": parse_money(get("monthly_target")),
                "cpa_target": parse_money(get("cpa_target")),
            }
        )

    if not rows:
        sys.exit("Accounts and Targets Tracker has no account rows.")

    return rows


# --------------------------------------------------------------------------
# Aggregation
# --------------------------------------------------------------------------

def collect(service, tracker: list[dict]) -> tuple[dict, dict, dict]:
    """Walk every buyer sheet once and fold it into per-month aggregates.

    Returns (monthly, daily, last_entry) keyed by (buyer_id, account).
    """
    monthly: dict = defaultdict(lambda: defaultdict(
        lambda: {"revenue": 0.0, "spend": 0.0, "pl": 0.0, "purchases": 0.0,
                 "has_data": False}
    ))
    daily: dict = defaultdict(lambda: defaultdict(
        lambda: {"revenue": 0.0, "spend": 0.0}
    ))
    last_entry: dict = {}

    by_sheet: dict[str, list[dict]] = defaultdict(list)
    for row in tracker:
        if row["sheet_id"]:
            by_sheet[row["sheet_id"]].append(row)

    for sheet_id, rows in by_sheet.items():
        buyer_names = sorted({r["buyer_name"] for r in rows})
        print(f"Reading sheet {sheet_id} ({', '.join(buyer_names)})")

        grids = fetch_all_tabs(service, sheet_id)
        wanted = {r["label_key"]: r for r in rows}
        seen_labels: set[str] = set()

        for tab_title, grid in grids.items():
            for block in find_blocks(grid):
                seen_labels.add(block["label_key"])
                config = wanted.get(block["label_key"])
                if config is None:
                    continue

                key = (config["buyer_id"], config["account"])

                for record in read_block_rows(grid, block):
                    date = record["date"]
                    month = f"{date.year:04d}-{date.month:02d}"

                    revenue = record["revenue"] or 0.0
                    spend = record["spend"] or 0.0
                    pl = record["pl"]
                    if pl is None:
                        pl = revenue - spend
                    purchases = record["purchases"] or 0.0

                    bucket = monthly[key][month]
                    bucket["revenue"] += revenue
                    bucket["spend"] += spend
                    bucket["pl"] += pl
                    bucket["purchases"] += purchases

                    touched = any(
                        record[f] is not None
                        for f in ("revenue", "spend", "purchases")
                    )
                    if touched:
                        bucket["has_data"] = True
                        prior = last_entry.get(key)
                        if prior is None or date > prior:
                            last_entry[key] = date

                    day = date.isoformat()
                    daily[key][day]["revenue"] += revenue
                    daily[key][day]["spend"] += spend

        for label_key, config in wanted.items():
            if label_key not in seen_labels:
                print(
                    f"  WARNING: no block labelled '{config['account']}' "
                    f"(looking for '{label_key}') found in {sheet_id}"
                )

    return monthly, daily, last_entry


# --------------------------------------------------------------------------
# Payload assembly
# --------------------------------------------------------------------------

def month_key(offset_from: dt.date, back: int) -> str:
    year, month = offset_from.year, offset_from.month - back
    while month <= 0:
        month += 12
        year -= 1
    return f"{year:04d}-{month:02d}"


def month_label(key: str) -> str:
    year, month = key.split("-")
    return f"{calendar.month_name[int(month)]} {year}"


def quarter_of(key: str) -> str:
    year, month = key.split("-")
    return f"Q{(int(month) - 1) // 3 + 1} {year}"


def build_payload(tracker: list[dict], monthly: dict, daily: dict,
                  last_entry: dict, today: dt.date) -> dict:
    current_month = f"{today.year:04d}-{today.month:02d}"
    days_in_month = calendar.monthrange(today.year, today.month)[1]
    day_of_month = today.day
    prorate = day_of_month / days_in_month

    buyers: list[dict] = []
    order: list[str] = []
    grouped: dict[str, list[dict]] = defaultdict(list)
    names: dict[str, str] = {}

    for row in tracker:
        if row["buyer_id"] not in names:
            order.append(row["buyer_id"])
            names[row["buyer_id"]] = row["buyer_name"]
        grouped[row["buyer_id"]].append(row)

    for buyer_id in order:
        accounts: list[dict] = []
        for row in grouped[buyer_id]:
            key = (buyer_id, row["account"])
            bucket = monthly.get(key, {}).get(current_month, {})
            revenue = round(bucket.get("revenue", 0.0))
            spend = round(bucket.get("spend", 0.0))
            pl = round(bucket.get("pl", 0.0))
            purchases = int(bucket.get("purchases", 0.0))
            stale = last_entry.get(key)

            # "Live" is decided by the sheet, not by the tracker: an offer
            # belongs on the Overview only if it has an entry in the month
            # currently being run. Everything else is history and shows up
            # on that buyer's own tab instead.
            entry: dict[str, Any] = {
                "name": row["account"],
                "status": row["status"],
                "lastEntry": stale.isoformat() if stale else None,
                "liveThisMonth": bool(bucket.get("has_data")),
            }

            if row["type"] == "cpa":
                entry.update(
                    {
                        "type": "cpa",
                        "cpaTarget": row["cpa_target"],
                        "purchases": purchases,
                        "adSpend": spend,
                        "cpa": round(spend / purchases) if purchases else None,
                    }
                )
            else:
                target = row["monthly_target"]
                prorated = round(target * prorate, 2) if target else None
                entry.update(
                    {
                        "monthlyTarget": target,
                        "revenue": revenue,
                        "adSpend": spend,
                        "pl": pl,
                        "proratedTarget": prorated,
                        "pacingPct": (
                            round(pl / prorated * 100, 1)
                            if prorated else None
                        ),
                    }
                )

            accounts.append(entry)

        sheet_id = next(
            (r["sheet_id"] for r in grouped[buyer_id] if r["sheet_id"]), None
        )
        buyers.append(
            {
                "id": buyer_id,
                "name": names[buyer_id],
                "accounts": accounts,
                "sheetId": sheet_id,
                "sheetTitle": SHEET_TITLE_CONVENTION.format(buyer=names[buyer_id]),
                "sheetUrl": (
                    f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
                    if sheet_id else None
                ),
            }
        )

    # ---- daily matrices -------------------------------------------------
    def matrix(field: str, months: list[str]) -> dict:
        columns, series = [], []
        for row in tracker:
            key = (row["buyer_id"], row["account"])
            if key not in daily:
                continue
            columns.append(
                {
                    "buyer": row["buyer_name"],
                    "buyerId": row["buyer_id"],
                    "account": row["account"],
                }
            )
            series.append(daily[key])

        # Only emit dates that at least one account actually has an entry for.
        # Emitting every calendar day would publish a 0 for days nobody has
        # filled in yet, and the chart would draw those as a real zero rather
        # than as a gap — the same misread the trailing-day trim exists to
        # prevent, but at the start of a month.
        wanted = set()
        for month in months:
            year, mon = (int(p) for p in month.split("-"))
            for day in range(1, calendar.monthrange(year, mon)[1] + 1):
                wanted.add(f"{year:04d}-{mon:02d}-{day:02d}")

        dates = sorted(
            d for d in wanted if any(d in s for s in series)
        )

        rows = [
            {
                "date": date,
                field: [round(s.get(date, {}).get(field, 0.0)) for s in series],
            }
            for date in dates
        ]
        return {"columns": columns, "rows": rows}

    # The Daily tab shows a rolling 30 days ending yesterday, so the matrices
    # must always carry the previous month as well as the current one.
    recent = [month_key(today, 1), current_month]

    # ---- month-by-month history ----------------------------------------
    def month_accounts(month: str) -> list[dict]:
        out = []
        for row in tracker:
            key = (row["buyer_id"], row["account"])
            bucket = monthly.get(key, {}).get(month)
            if not bucket or not bucket["has_data"]:
                continue
            record: dict[str, Any] = {
                "buyer": row["buyer_name"],
                "buyerId": row["buyer_id"],
                "account": row["account"],
            }
            if row["type"] == "cpa":
                purchases = int(bucket["purchases"])
                spend = round(bucket["spend"])
                record.update(
                    {
                        "type": "cpa",
                        "purchases": purchases,
                        "adSpend": spend,
                        "cpa": round(spend / purchases) if purchases else None,
                        "cpaTarget": row["cpa_target"],
                        "pl": None,
                    }
                )
            else:
                record.update(
                    {
                        "revenue": round(bucket["revenue"]),
                        "adSpend": round(bucket["spend"]),
                        "pl": round(bucket["pl"]),
                    }
                )
            out.append(record)
        out.sort(key=lambda r: -(r.get("pl") or 0))
        return out

    # A flat month list, oldest first. The page groups it into quarters for the
    # Overview accordions and re-slices it per buyer for the Media Buyers tab,
    # so the payload doesn't need to carry the same numbers three ways.
    months: list[dict] = []
    for back in range(HISTORY_MONTHS, -1, -1):
        m = month_key(today, back)
        if m > current_month:
            continue
        accounts = month_accounts(m)
        if not accounts and m != current_month:
            continue
        months.append(
            {
                "month": m,
                "monthLabel": month_label(m),
                "quarter": quarter_of(m),
                "status": "in-progress" if m == current_month else "complete",
                "accounts": accounts,
            }
        )

    return {
        "lastUpdated": dt.datetime.now(dt.timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        ),
        "currentMonth": current_month,
        "monthLabel": month_label(current_month),
        "dayOfMonth": day_of_month,
        "daysInMonth": days_in_month,
        "currentQuarter": quarter_of(current_month),
        "currentYear": today.year,
        "buyers": buyers,
        "dailyRevenue": matrix("revenue", recent),
        "dailySpend": matrix("spend", recent),
        "months": months,
        "trackerSheetId": TRACKER_SHEET_ID,
        "trackerUrl": (
            f"https://docs.google.com/spreadsheets/d/{TRACKER_SHEET_ID}/edit"
        ),
        "sourceSheetIds": {
            row["buyer_id"]: row["sheet_id"] for row in tracker if row["sheet_id"]
        },
    }


def main() -> None:
    service = sheets_client()
    tracker = load_tracker(service)
    print(f"Tracker: {len(tracker)} account rows")

    monthly, daily, last_entry = collect(service, tracker)
    payload = build_payload(tracker, monthly, daily, last_entry,
                            dt.date.today())

    with open(OUTPUT_PATH, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")

    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()

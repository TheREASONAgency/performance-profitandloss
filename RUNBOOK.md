# RUNBOOK — REA CPA Pacing Dashboard

One static page (`index.html`) reading one file (`data.json`). A GitHub Action
rebuilds `data.json` from Google Sheets every day at 18:00 UTC (noon CST) and
pushes a commit; Vercel redeploys on push. No build step, no server.

## Operating rules

- **Never hand-edit `data.json`.** CI owns it. Every failure is a data or access
  problem — fix the sheet or the sharing, then re-run the workflow.
- **Accounts and targets live in the Accounts and Targets Tracker, not in code.**
  Adding an account, retiring one, or changing a target is a sheet edit.
- **Never backfill.** The job rebuilds the entire current month on every run, so a
  missed day fixes itself the next day.
- **Before changing the parser, run `python3 scripts/test_refresh_pacing.py`.**
  CI runs it before every live refresh and a red test blocks the publish.
- **Gotcha:** GitHub pauses scheduled workflows after 60 days of repo inactivity.
  The daily commit normally prevents that, but after a long quiet stretch, check
  the Actions tab.

## The sheets

| Sheet | ID |
|---|---|
| Accounts and Targets Tracker (source of truth) | `1NY1paU3-5Idv5wbq-7OXClnUvhUO4wrCPVtZYbzChKU` |
| Joe \| CPA Offers P&L | `1qF4BvyoOCAUmpZlFrxplmbBTjXMPbzpnwZ5xc8EA-FE` |
| Travis \| CPA Offers P&L | `1BYDzXHh2wlM0CwfYHpK1guJokWdCletwTj9ijBypbu8` |
| Kurt \| CPA Offers P&L | `1ajfiruIBVgZtc5k3v-R89E8FwLzpPktlkGcbAjonYhk` |
| Jack \| CPA Offer P&L | `1qzwI3r7nI0zW6pEolUDkQ0DuIHxr-qN7fKxlK1r9nHk` |
| Stefan Stan \| CPA Offer P&L | `1QbinJO-MqI2OL590iscjVgdKzlBwfXSs0C5alg4Unvk` |

Every one of these must be shared (Viewer is enough) with the service account's
`client_email`. Buyer sheet IDs are read from the tracker's `sheet_id` column —
to point a buyer at a different sheet, change it there, not here.

## The tracker's columns

| Column | Meaning |
|---|---|
| `buyer_id` | stable slug (`joe`, `travis`, …); groups rows into a buyer card |
| `buyer_name` | display name |
| `sheet_id` | that buyer's P&L spreadsheet |
| `account` | display name of the account (`AltRx`) |
| `sheet_label` | optional override when the banner text in the sheet doesn't match — matching is case- and space-insensitive, so `ALT RX` already finds `AltRx`; only fill this in when the names genuinely differ |
| `status` | `Active` / `Inactive`; informational only — what shows on the Overview is driven by the sheet (see below), not by this column |
| `type` | `pl` (revenue/spend/P&L) or `cpa` (purchases vs a CPA target, no P&L) |
| `monthly_target` | dollar P&L goal for the month; blank means pacing is not calculated |
| `cpa_target` | for `type: cpa` rows only |

Payout and target CPA are deliberately **not** in the tracker or on the page.
They are maintained in another system and would go stale here.

## What appears on the Overview tab

The Overview shows only offers that are **live in the active month** — meaning
the buyer's sheet has at least one typed entry for that offer in the current
month. This is decided by the sheet, not by the tracker's `status` column, so
an offer that stops running simply drops off the Overview at the month
boundary with no edit required. It keeps its full history on that buyer's tab
under Media Buyers, and the Overview lists it under "Not running in <month>".

Offers not live this month are also excluded from the pacing denominator, so a
dormant target does not drag a buyer's percentage down.

## How pacing is computed

```
proratedTarget = monthly_target / days_in_month * day_of_month
pacingPct      = P&L_month_to_date / proratedTarget * 100
```

100% means exactly on pace for the day of the month. The bar on each account row
puts 100% at the midpoint, so past the tick mark is on pace.

A blank `monthly_target` yields `null` for both, and the page says "no monthly
target set" rather than showing a misleading 0%.

## How the parser reads a buyer sheet

The buyer sheets are not uniform, so the parser is written to the variation
rather than to one layout:

- A tab can hold **several account blocks side by side**. Each block is opened by
  its own `DATE` column and owns the columns up to the next `DATE`.
- The **account name** comes from the merged banner row directly above the header
  row (or, on tabs with a spacer column, from just left of the block).
- Column headers are matched by **name, not position**: `REVENUE` or `Earnings`,
  `AD SPEND`, `P/L`, and optionally `Notes`, `CLICKS`, `CPC`, `PURCHASES`.
- Rows are read until a `TOTALS` row or a non-date value, so footer figures
  (`$846`, `TARGET 20%`, `#DIV/0!`) never land in daily data.
- A blank cell and a typed `$0` are different: blank means the day was not filled
  in, `$0` means it was. That distinction drives the staleness notice.
- If `P/L` is blank, it is computed as revenue minus spend.

## Staleness

Each account carries `lastEntry` — the most recent date with any typed value.
The page shows a small "last Aug 4" chip on each offer row so an unfilled sheet
doesn't read as a bad month. The rolling-30 chart also stops at the last day
with an entry rather than drawing a cliff to $0 through unfilled days.

## Failures and fixes

| Log message | Cause | Fix |
|---|---|---|
| `GOOGLE_SA_KEY is not set` | Repo secret missing | Add the full service account JSON as `GOOGLE_SA_KEY` under Settings → Secrets and variables → Actions |
| `GOOGLE_SA_KEY is not valid JSON` | Partial paste, or the file path was pasted instead of its contents | Re-paste the entire JSON key file including the outer braces |
| `Could not open spreadsheet <id>` with a 403 | Sheet not shared with the service account | Share that sheet with the `client_email` shown in the `Authenticating as …` log line, Viewer is enough |
| `Could not open spreadsheet <id>` with a 404 | Wrong ID in the tracker's `sheet_id` | Correct the ID in the tracker |
| `Accounts and Targets Tracker is missing required column(s)` | A header was renamed or deleted | Restore the column name; header matching ignores case and spacing but the word must be there |
| `WARNING: no block labelled 'X' found` | Tracker account name doesn't match the sheet's banner, or the month tab hasn't been created | Set `sheet_label` in the tracker to the exact banner text, or have the buyer add the tab |
| Workflow green, numbers unchanged | Nobody updated the sheets | Expected. `data.json` only commits when something actually changed |
| Page loads but says "Could not load data.json" | Deploy served without the data file | Check the last Action run pushed, and that Vercel deployed the repo root with no build command |
| Everything shows `$0` | Month tabs for the current month don't exist yet | Have each buyer add their `Month | YYYY` tab; the job picks it up on the next run |

## Compliance tab

A second, independent pipeline feeds the Compliance tab:
`scripts/scrape_compliance.py` scrapes each Meta ad-policy page weekly
(`.github/workflows/refresh-compliance.yml`, Mondays, plus manual
`workflow_dispatch`) and writes `compliance.json` at the repo root. The page
renders one sub-tab per source.

| Source | Page |
|---|---|
| Health & Wellness | `restricted-goods-services/health-wellness/` |
| Drugs & Pharmaceuticals | `restricted-goods-services/drugs-pharmaceuticals/` |
| Personal Attributes | `objectionable-content/privacy-violations-personal-attributes/` |

- **The scrape needs a headless browser, not `requests`.** These pages are
  client-rendered. A plain `requests.get` answers **HTTP 400** with a 253KB
  Facebook app shell containing zero headings and zero paragraphs; a full
  browser header set gets 200 but still no policy text. Only a rendered page
  yields content, so the job installs Chromium via Playwright. This was
  measured against the live pages, not assumed — don't "simplify" it back to
  `requests`.
- **The extractor deliberately ignores CSS classes.** Meta's design system
  emits generated atomic class names (`x1motxo8`, `xeuugli`…) that churn.
  Everything keys on structure instead: `<main>`'s child layout (breadcrumb,
  article, optional examples block, footer nav strip), the heading-then-body
  pair each section is built from, and whether text sits inside a link —
  link text is never a heading, which is what keeps the footer's nav cards
  and inline "here" links out of the section list.
- **Meta stamps each policy with its own revision dates**, read from the
  CHANGE LOG beside the title into `policyUpdates` (ISO, newest first;
  "Today" resolves to the scrape date). That is better evidence of a real
  change than any hash diff, so the tab leads with it.
- **Adding a policy page is one entry in `SOURCES`** at the top of
  `scrape_compliance.py` — plus a fixture, which a test enforces.
- **`compliance.json` is a separate file from `data.json`, on a separate
  schedule, and machine-owned the same way — never hand-edit it.** The two
  never race or clobber each other's output; the page fetches each
  independently, so a failure in one refresh doesn't take the other tab down.
- Each page is split into sections and each section's text is hashed. A
  section is flagged `changed` when its hash differs from that source's
  previous run; new/removed sections and changes are appended to a bounded
  `changeLog` stamped with which policy they came from. Nothing is flagged on
  a source's first successful run — there's no baseline yet, and flagging
  everything on day one would bury the real changes that follow.
- **One broken source never takes the others down.** A page that fails to
  fetch, or that parses to zero sections, keeps the text from its last good
  run (stamped with when it was last confirmed, and marked "stale" on the
  tab); every other source still publishes. The job then exits non-zero
  **after** committing, so the failure shows up red in Actions instead of
  sitting unnoticed behind a green check. Only if *every* source fails is
  `compliance.json` left untouched entirely.
- Zero sections parsed from a page that rendered fine means Meta restructured
  it — fix `extract_policy()` in `scrape_compliance.py` to match the new
  markup.
- **Before changing the scraper, run `python3 scripts/test_scrape_compliance.py`.**
  CI runs it before every live scrape and a red test blocks the publish. The
  tests run against `scripts/fixtures/` — the real rendered markup of all
  three pages — and never touch the network. When Meta redesigns a page,
  recapture the fixture rather than loosening the tests.
- The committed placeholder has `"seed": true` until the workflow's first
  successful run, same pattern as `data.json`.

## Deploying

Vercel: import the repo, framework preset **Other**, no build command, default
output directory (it serves the repo root). The page is public by design.

## First-time setup checklist

1. Enable Actions on the repo (workflows are often disabled after a transfer).
2. Google Cloud Console → enable the **Google Sheets API** → create a **service
   account** → add a **JSON key**.
3. Paste that JSON as the repo secret `GOOGLE_SA_KEY`.
4. Share all six sheets above with the service account's `client_email` (Viewer).
5. Actions → Refresh Pacing Dashboard → Run workflow. The log should show
   `Authenticating as …`, finish green, and push a `data: refresh YYYY-MM-DD`
   commit if numbers changed.
6. Import the repo on Vercel and confirm the page loads with current numbers.
7. If a `COMPOSIO_KEY` secret exists from the old pipeline, delete it.

# Account Status tab

New tab on the dashboard: PV, Managed and CPA account status with color-coded badges.
Additive only: nothing in the existing tabs or `vercel.json` was changed, and no existing line of `index.html` was removed.

## How it updates

A GitHub Action rebuilds **`status.json` every Monday, Wednesday and Friday at 6:00 AM Eastern**, commits it, and Vercel redeploys. The page just reads `status.json`. Same pattern as `data.json`: **never hand-edit `status.json`.**

- Cron fires at both 10:00 and 11:00 UTC; a gate step lets exactly one through, so it stays 6:00 AM Eastern across daylight saving.
- Run it on demand: Actions → **Refresh Account Status** → Run workflow.
- If Monday fails, that section keeps its last good rows with a red error and "last good" time; the run goes red in Actions.

| File | Role |
|---|---|
| `.github/workflows/refresh-status.yml` | The Mon/Wed/Fri 6 AM ET schedule |
| `scripts/refresh_status.js` | Fetches Monday (server-side), builds `status.json` |
| `lib/status-config.js` | **The one place to change** rules, column IDs, exclusions, pacing basis |
| `lib/status-logic.js` | Pure functions: status mapping and `computeCpaPacing` |
| `tests/status-logic.test.js` | `node --test tests/status-logic.test.js` (also runs in CI before each refresh) |
| `status.json` | Snapshot the page reads (placeholder until the first run) |
| `index.html` | The new "Account Status" tab |

## Setup (one time)

1. GitHub repo → Settings → Secrets and variables → Actions → **New repository secret**: `MONDAY_API_TOKEN` (Monday: Profile → Developers → My access tokens; needs read access to board 9386705349).
2. Merge the branch, then run **Refresh Account Status** once to replace the placeholder.
3. No Vercel changes or environment variables are needed. The token never reaches Vercel or the browser.

## Layout

1. **Card row** (reuses the dashboard's existing `.tile` cards): **Quarter Target** (headline, $760K) · **Progress to Target** (QTD P&L vs the CPA target) · **Pacing** (vs prorated CPA target) · **Accounts** (active count, on/off track).
2. **PV accounts**: primary measure is CPA (today, L7D, target, gap vs target).
3. **Managed accounts**: CPA plus MTD ad spend toward the $100K monthly goal, with a **Spend goal pace** column.
4. **CPA accounts**: profit MTD vs monthly target, target to date, gap and pacing %.

## Status rules

**PV and Managed** (Monday board): **On Target CPA** column.
`On Target` → On Track (green) · `Over` → Off Track (red) · `N/A` → Paused (amber).
Any other label (Stuck, Pending External, blank…) → "No Status" (gray), raw label on hover.
PV vs Managed comes from **Client Type** (`PV / TESTING` / `Managed`).

**CPA accounts** (profit pacing): `dailyTarget = monthlyTarget ÷ 30`, `targetToDate = dailyTarget × daysElapsed`.
**On Track** if profit ≥ targetToDate, else **Off Track**. See `computeCpaPacing`.

## Assumptions (all in `lib/status-config.js`)

1. **Managed accounts live on the same Monday board**, identified by Client Type = `Managed`.
2. **Excluded rows:** groups *Meeting Structure*, *Closed Accounts*, *Partnerships*, and any row labeled `CLOSED` (replicates the board view's filter, which the API can't read).
3. **Client Types not included:** Scaling, SOP, Onboarding, Incoming SAP, NOT ACTIVE.
4. **Target CPA is parsed from the account name** (`GAL (<$400)` → $400); there is no target column.
5. **Platform:** no platform column exists, so every row shows `Meta`.
6. **"CPA accounts" = P&L-type offers in `data.json`** (the Media Buyers' trackers). Offers with `type: "cpa"` (purchases vs CPA target, no profit target) are skipped.
7. **Days elapsed** = `dayOfMonth` in `data.json` (same as the Overview tab), **capped at 30** in 31-day months. Set `capDaysAtBasis: false` to remove the cap.
8. **Offers with no entries this month** show Paused; offers with no monthly target are hidden.
9. **Targets table (Q4 2026)** is in `targets` in config (columns confirmed as Oct / Nov / Dec). Retainers reproduce your subtotal row exactly (127,000 / 181,500 / 211,500). The CPA group is now 60,000 / 80,000 / 100,000: your 55/75/95K plus **Medvi at $5,000 per month** (assumed for all three months). A test enforces these sums. Add a `"Qn YYYY"` entry each quarter.
10. **Quarter Target card = Retainers + CPA = $760,000** (`quarter.headlineGroups`). **Progress and Pacing compare quarter-to-date P&L against the CPA target only ($240,000)** (`quarter.progressGroups`), because retainer revenue isn't tracked in any source yet. The card labels say so. Pacing is calendar-day based and anchored to the date `data.json` represents (same as the Overview).
11. **CPA account targets for the current month come from the table**, replacing the tracker's `monthlyTarget` via `trackerMatch`: Keeps: HL → Travis/Keeps · TRX → TrimRx (any buyer) · Medvi → Kurt/Medvi and Medvi GLP1 (both at $5,000; the table counts Medvi once, so the quarter total is unchanged; add a separate table line if GLP1 is additional). **Jack's Medvi is excluded** because only Kurt runs Medvi. **Rugiet is removed** from this tab (`cpa.excludeAccounts`: its row and its P&L are dropped from the tab and the quarter-to-date figure; the other tabs are unaffected). **Quad and NAD+** show zero-filled **placeholder rows** (`cpa.placeholders`, status Paused, target from the table) until their trackers exist; then add a `trackerMatch` for each and remove it from the list.
12. **Managed ad spend goal: $100,000 per account per month** while CPA stays under target CPA (`managed.goal`; set `period: "quarter"` if spend becomes cumulative). Spend comes from the board's new **MTD Spend** text column (`text_mm7xtsh1`, e.g. "$12,345.67"), which is still empty, so spend shows "—" and "No spend data" until it is filled in. "On pace" = spend ≥ $100K × share of the month elapsed (the data's day-of-month ÷ days in month); "CPA over target" if L7D CPA > target; "Goal hit" at $100K. The bonus/commission payout rule is not modeled.
13. **"Active" accounts** = On Track + Off Track across all three groups (Paused and No Status excluded).
14. **CPA freshness:** profit comes from `data.json`, which its own job refreshes on a different schedule. At 6 AM the status job uses whatever `data.json` last committed (typically the prior day), and the tab shows when that data was refreshed.

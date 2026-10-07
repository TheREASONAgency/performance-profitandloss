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

1. **Card row** (reuses the dashboard's existing `.tile` cards): **Quarter Target** (headline) · **Progress to Target** (QTD P&L, % of target) · **Pacing** (QTD P&L vs prorated quarter target) · **Accounts** (active count, on/off track).
2. **PV accounts**: primary measure is CPA (today, L7D, target, gap vs target).
3. **Managed accounts**: CPA plus ad spend, with a **Bonus pace** column (placeholder, see below).
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
9. **Quarter Target is not stored anywhere yet.** Default = sum of every P&L offer's monthly target in `data.json` × 3 (currently $525,000, including offers with no entries this month). Set `quarter.targets: { "Q4 2026": <number> }` in config to use a real figure.
10. **Quarter pacing** = QTD P&L ÷ (quarter target × days elapsed ÷ days in quarter), calendar days, anchored to the date `data.json` represents (same as the Overview), so a lagging data refresh isn't penalized. QTD P&L sums the current quarter's months in `data.json`.
11. **Managed ad spend** = the board's *Current Spend L7D* (`columns.adSpend`; swap the column ID to use Maximum or Remaining Spend).
12. **Bonus/commission pace is a placeholder, OFF by default** (shows "Rule TBD"). Set `managed.bonus.enabled: true` to try the placeholder rule (CPA L7D ≤ target CPA, optional minimum spend), or edit `metric` / `comparator` / `threshold` once the real rule is final. Logic: `evaluateBonus` in `lib/status-logic.js`.
13. **"Active" accounts** = On Track + Off Track across all three groups (Paused and No Status excluded).
14. **CPA freshness:** profit comes from `data.json`, which its own job refreshes on a different schedule. At 6 AM the status job uses whatever `data.json` last committed (typically the prior day), and the tab shows when that data was refreshed.

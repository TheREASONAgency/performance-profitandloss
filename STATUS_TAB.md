# Account Status tab

New tab on the dashboard: live PV, Managed and CPA account status with color-coded badges.

| File | Role |
|---|---|
| `api/status.js` | Vercel serverless function (`GET /api/status`). Holds the Monday token, fetches the board, returns JSON. |
| `lib/status-config.js` | **The one place to change** rules, column IDs, exclusions, pacing basis, refresh timing. |
| `lib/status-logic.js` | Pure functions: status mapping and the CPA pacing rule (`computeCpaPacing`). |
| `tests/status-logic.test.js` | `node --test tests/status-logic.test.js` |
| `index.html` | New "Account Status" tab (additive; other tabs unchanged). |
| `vercel.json` | Adds the function's `maxDuration` and bundles `data.json` with it. |

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Required | Value |
|---|---|---|
| `MONDAY_API_TOKEN` | **Yes** | Monday.com personal API token (Profile → Developers → My access tokens). Needs read access to board 9386705349. Add to Production **and** Preview. |
| `CPA_DATA_URL` | No | Only if CPA data should come from a URL instead of the deployed `data.json`. |

## Deploy

1. Add `MONDAY_API_TOKEN` in Vercel (Production + Preview).
2. Push this branch → Vercel builds a **preview**. Open it → **Account Status** tab.
3. Check the three sections, then merge to the production branch.
4. No build step or framework change; Vercel picks up `/api` automatically.

## How the status rules work

**PV and Managed** (Monday board): read the **On Target CPA** column.
`On Target` → On Track (green) · `Over` → Off Track (red) · `N/A` → Paused (amber).
Any other label (Stuck, Pending External, blank…) → "No Status" (gray), with the raw label on hover.
PV vs Managed comes from the **Client Type** column (`PV / TESTING` / `Managed`).

**CPA accounts** (profit pacing):
`dailyTarget = monthlyTarget ÷ 30` · `targetToDate = dailyTarget × daysElapsed`
**On Track** if profit ≥ targetToDate, otherwise **Off Track**. Logic: `computeCpaPacing` in `lib/status-logic.js`.

## Assumptions (all in `lib/status-config.js`)

1. **Managed accounts live on the same Monday board**, identified by Client Type = `Managed`.
2. **Excluded rows:** groups *Meeting Structure*, *Closed Accounts*, *Partnerships*, and any row labeled `CLOSED`. The board's saved view filter is not available through the API, so these replicate it.
3. **Client Types not included:** Scaling, SOP, Onboarding, Incoming SAP, NOT ACTIVE.
4. **Target CPA is parsed from the account name** (`GAL (<$400)` → $400). There is no target column.
5. **Platform:** the board has no platform column, so every row shows `Meta`. Set `columns.platform` if one is added.
6. **"CPA accounts" = P&L-type offers in `data.json`** (the Media Buyers' P&L trackers). Offers with `type: "cpa"` (purchases vs CPA target, no profit target) are skipped.
7. **Days elapsed** = `dayOfMonth` in `data.json` (same as the Overview tab), **capped at 30** in 31-day months so the expected figure never exceeds the full monthly target. Set `capDaysAtBasis: false` to remove the cap.
8. **Offers with no entries this month** show as Paused; offers with no monthly target are hidden.

## Freshness

- Monday data: cached at the edge for 60s; the browser re-fetches every 5 minutes while the tab is open (and on "Refresh now").
- CPA profit data: only as fresh as `data.json`, which the existing GitHub Action rebuilds Mon–Fri. The tab warns if `data.json` is from a previous month.
- Each source fails independently, with a clear message in its own section.

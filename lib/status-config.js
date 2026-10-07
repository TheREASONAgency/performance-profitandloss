/**
 * Account Status tab — the ONE place to change rules, column IDs and sources.
 * Nothing else in the codebase hard-codes a Monday column ID or a status rule.
 *
 * Every value here was checked against the live board (9386705349,
 * "Account Health + Blockers") on 2026-10-05. Items marked ASSUMPTION are
 * judgment calls — change them here, not in the logic.
 */
module.exports = {
  // Timezone used to decide what "the current calendar month" is.
  timezone: "America/Chicago",

  // ---- Account targets by quarter ---------------------------------------
  // Monthly target per account, one number per month in `months` order.
  // The three numbers per account are the quarter's three months (Oct, Nov,
  // Dec). Edit here when targets change; add a new "Qn YYYY" entry each quarter.
  //
  // `trackerMatch` links a label below to offer(s) in data.json so that
  // account's target for the CURRENT month replaces the tracker's own
  // monthlyTarget. "Buyer/Account" matches one buyer's offer; "Account"
  // matches that offer name under any buyer (exact, case-insensitive). A
  // target of 0 means "no target this month". Labels with no match (all
  // retainers) count toward the quarter target but get no pacing row. Quad and
  // NAD+ get zero-filled placeholder rows (cpa.placeholders) until their
  // trackers exist.
  targets: {
    "Q4 2026": {
      months: ["2026-10", "2026-11", "2026-12"],
      groups: {
        // Retainer clients + PV Lite + open slots. Revenue actuals for these are
        // not in any source yet, so they feed the headline target only.
        retainers: {
          label: "Retainers",
          accounts: {
            "Blue Haven": [17000, 17000, 17000],
            "Keeps: ED":  [17000, 17000, 17000],
            "UAC":        [10000, 10000, 10000],
            "LF":         [8000, 8000, 8000],
            "OOO":        [12500, 12500, 12500],
            "Open #6":    [7500, 12000, 12000],
            "Open #7":    [27500, 27500, 27500],
            "Open #8":    [10000, 15000, 15000],
            "Open #9":    [10000, 15000, 15000],
            "Open #10":   [0, 10000, 15000],
            "Open #11":   [0, 10000, 15000],
            "Open #12":   [0, 10000, 15000],
            "Open #13":   [0, 10000, 15000],
            "Open #14":   [0, 0, 10000],
            "PV Lite":    [7500, 7500, 7500],
          },
        },
        // Profit-tracked CPA accounts (the Media Buyers' P&L trackers).
        cpa: {
          label: "CPA",
          accounts: {
            "Keeps: HL": [40000, 45000, 50000],
            "Quad":      [5000, 10000, 15000],
            "NAD+":      [5000, 10000, 15000],
            "TRX":       [5000, 10000, 15000],
            "Medvi":     [5000, 5000, 5000],
          },
        },
      },
      // TRX matches TrimRx under every buyer (only live offers get a row).
      trackerMatch: {
        "Keeps: HL": ["Travis/Keeps"],
        "TRX": ["TrimRx"],
        // Only Kurt runs Medvi; Medvi GLP1 (Stefan) shares the same $5K target.
        "Medvi": ["Kurt/Medvi", "Medvi GLP1"],
      },
    },
  },

  // ---- Headline cards ----------------------------------------------------
  quarter: {
    // Groups summed into the Quarter Target card.
    headlineGroups: ["retainers", "cpa"],
    // Groups that have actuals today (CPA P&L from data.json). The progress and
    // pacing cards compare quarter-to-date P&L against ONLY these groups.
    progressGroups: ["cpa"],
    // Fallback for a quarter with no `targets` entry: sum of the tracker's
    // monthly targets x this many months.
    monthsPerQuarter: 3,
  },

  // ---- Managed accounts: ad spend goal ------------------------------------
  // Every managed client wants to reach `amount` in ad spend while holding CPA
  // under its target CPA. Spend comes from the board's "MTD Spend" column, so
  // the goal is per MONTH by default (period: "month"; "quarter" also works if
  // spend becomes cumulative). With `pace` on, "on pace" means spend >= amount
  // x share of the period elapsed. The bonus/commission payout rule itself is
  // not finalized, so this only measures progress toward the spend goal.
  managed: {
    goal: {
      amount: 100000,
      period: "month",
      pace: true,
      requireCpaUnderTarget: true,
    },
  },

  // Snapshot file written by scripts/refresh_status.js and read by the page.
  // The schedule itself (Mon/Wed/Fri 6:00 AM Eastern) is set in
  // .github/workflows/refresh-status.yml; this label is only what the page shows.
  outputFile: "status.json",
  scheduleLabel: "Mon / Wed / Fri at 6:00 AM ET",

  // ---- Status vocabulary (what the badges show) -------------------------
  statuses: {
    on_track:  { label: "On Track",  tone: "good"   },
    off_track: { label: "Off Track", tone: "bad"    },
    paused:    { label: "Paused",    tone: "paused" },
    unknown:   { label: "No Status", tone: "muted"  },
  },

  // ---- PV + Managed accounts (Monday.com) -------------------------------
  monday: {
    boardId: "9386705349",
    // Used only to build "open in Monday" links on each row.
    accountSlug: "reason-agency",
    apiVersion: "2025-04",
    // Name of the GitHub Actions secret holding the API token. It is only
    // ever read inside the refresh job, never sent to the browser.
    tokenEnv: "MONDAY_API_TOKEN",

    columns: {
      clientType: "color_mks84j39",  // Managed / PV / TESTING / Scaling / ...
      onTargetCpa: "color_mkthejpy", // On Target / Over / N/A / ...
      cpaToday: "text_mkthgz97",     // text like "$506.14", "$-", "N/A"
      cpaL7d: "numeric_mm3yt187",    // number, last 7 days
      // Managed ad spend, month to date: the board's "MTD Spend" text column
      // (values like "$12,345.67"). Empty until the team fills it in.
      adSpend: "text_mm7xtsh1",
      // ASSUMPTION: the board has no platform column, so every row gets
      // `defaultPlatform`. Put a column ID here if one is added later.
      platform: null,
    },
    defaultPlatform: "Meta",

    // Which Client Type labels belong to which group.
    // ASSUMPTION: "Scaling", "SOP", "Onboarding", "Incoming SAP" and
    // "NOT ACTIVE" client types are NOT included — add them here to include.
    clientTypes: {
      pv: ["PV / TESTING"],
      managed: ["Managed"],
    },

    // Rows that are not accounts. The existing board view filters these out;
    // the API does not apply view filters, so we replicate them here.
    // ASSUMPTION: meeting agenda rows, closed accounts and partnership
    // placeholders are not tracked accounts.
    excludeGroupIds: [
      "group_mm63yzx2", // Meeting Structure
      "group_mktr2b1m", // Closed Accounts
      "group_mm3pdhdb", // Partnerships
    ],
    excludeOnTargetLabels: ["CLOSED"],

    // The status rule. Keys are lower-case On Target CPA labels.
    // Any other label (or blank) shows as "No Status" with the raw label.
    cpaStatusMap: {
      "on target": "on_track",
      "over": "off_track",
      "n/a": "paused",
    },

    // ASSUMPTION: the CPA target is not its own column; it is written in the
    // account name, e.g. "GAL (<$400)", "HEY ($225)", "DME (CPA ~$224)".
    // The first "$number" in the name is read as the target. Set false to
    // stop parsing (the target cell will then show "—").
    parseTargetFromName: true,
  },

  // ---- CPA accounts (profit pacing, from the Media Buyers' P&L trackers) --
  // Source: data.json, which the existing GitHub Action rebuilds from the
  // buyers' Google Sheets. ASSUMPTION: "CPA accounts" = the P&L-type offers
  // in data.json (they have monthlyTarget + pl). Offers with `type: "cpa"`
  // (purchases vs CPA target, no P&L) have no profit target and are skipped.
  cpa: {
    // Read from the repo file the existing pacing job maintains.
    dataFile: "data.json",

    // Pacing rule: dailyTarget = monthlyTarget / daysBasis
    //              expected   = dailyTarget * daysElapsed
    // On Track when profit >= expected, otherwise Off Track.
    daysBasis: 30,
    // Which data.json field says how many days have elapsed.
    // (Same field the existing Overview uses, so both tabs agree.)
    daysElapsedField: "dayOfMonth",
    // ASSUMPTION: in 31-day months, day 31 would put "expected" above the
    // full monthly target, so days elapsed is capped at daysBasis.
    capDaysAtBasis: true,

    // Offers with no entries this month: show as Paused (true) or hide (false).
    showNotLive: true,
    // Offers with no monthly target: show as "No Status" (true) or hide (false).
    showNoTarget: false,

    // Offers dropped from this tab entirely (rows AND quarter-to-date P&L).
    // Same matcher as targets.trackerMatch: "Buyer/Account" or "Account".
    // The Overview and Media Buyers tabs are not affected.
    // Jack's Medvi offer is not running (only Kurt runs Medvi).
    excludeAccounts: ["Rugiet", "Jack/Medvi"],

    // Zero-filled placeholder rows for CPA accounts whose trackers aren't built
    // yet. Labels must exist in the quarter's targets table (that is where the
    // monthly target comes from). Shown as Paused. Once a tracker exists, add a
    // trackerMatch for the label and remove it from this list.
    placeholders: ["Quad", "NAD+"],

    defaultPlatform: "Meta",
  },
};

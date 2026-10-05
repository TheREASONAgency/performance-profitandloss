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

  // How the page refreshes. Server responses are CDN-cached for `cacheSeconds`;
  // the browser re-fetches every `clientPollSeconds` while the tab is open.
  cacheSeconds: 60,
  clientPollSeconds: 300,

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
    // Vercel environment variable holding the API token (server-side only).
    tokenEnv: "MONDAY_API_TOKEN",

    columns: {
      clientType: "color_mks84j39",  // Managed / PV / TESTING / Scaling / ...
      onTargetCpa: "color_mkthejpy", // On Target / Over / N/A / ...
      cpaToday: "text_mkthgz97",     // text like "$506.14", "$-", "N/A"
      cpaL7d: "numeric_mm3yt187",    // number, last 7 days
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
    // Read from the deployed repo file; override with env CPA_DATA_URL to
    // fetch a URL instead.
    dataFile: "data.json",
    dataUrlEnv: "CPA_DATA_URL",

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

    defaultPlatform: "Meta",
  },
};

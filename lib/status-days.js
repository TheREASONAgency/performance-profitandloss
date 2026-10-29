/**
 * Days each account has been in its current On Track / Off Track / On Hold status.
 * History lives in status.json (`statusDays`); every refresh compares the sheet's
 * current state with the last one: same state keeps its start date, a change restarts
 * it today. Tracking begins on `start` (nothing is recorded before then).
 */
const DAY = 86400000;

function etDate(now, tz = "America/New_York") {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function update(prev, items, today, start) {
  if (!start || today < start) return { tracking: false, startsOn: start || null, items: {} };
  const was = (prev && prev.items) || {};
  const out = {};
  items.forEach(({ key, state }) => {
    if (!state) return;
    out[key] = was[key] && was[key].state === state ? { state, since: was[key].since } : { state, since: today };
  });
  return { tracking: true, startsOn: start, items: out };
}

/** Inclusive day count: the day a status starts is day 1. */
function daysIn(since, today) {
  return Math.round((Date.parse(today) - Date.parse(since)) / DAY) + 1;
}

module.exports = { etDate, update, daysIn };

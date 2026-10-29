/**
 * "Meetings in status": every time a status is clicked during the team call, the count under
 * it goes up by 1 if it is the same status as before, or restarts at 1 if it changed.
 * The count lives in the sheet (the cell right after each status cell), so it is shared by
 * everyone and survives refreshes. Counting begins on `start` (ET date).
 */
function etDate(now, tz = "America/New_York") {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function countingStarted(now, start) {
  return !start || etDate(now) >= start;
}

/** prevState/prevCount = what the sheet holds now; nextState = the status just clicked. */
function nextCount(prevState, prevCount, nextState) {
  return prevState && prevState === nextState && prevCount > 0 ? prevCount + 1 : 1;
}

module.exports = { etDate, countingStarted, nextCount };

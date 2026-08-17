#!/usr/bin/env python3
"""Decide whether a scheduled run should actually refresh.

GitHub cron is UTC-only and does not follow daylight saving, so a single UTC
cron drifts by an hour twice a year. The workflow therefore fires at BOTH
candidate UTC hours for each target and this guard lets exactly one through —
the one that is really the wanted local time in America/New_York.

Targets:
  * Monday-Friday at 12:00 Eastern
  * Monday at 20:00 Eastern (a second pass to catch the week's first day)

Exits 0 and prints "run" when the run should proceed, otherwise prints "skip".
Manual runs (workflow_dispatch) never reach this script.
"""

from __future__ import annotations

import datetime as dt
import sys
from zoneinfo import ZoneInfo

ZONE = ZoneInfo("America/New_York")

# (weekday, hour) in local Eastern time. Monday is 0.
TARGETS = {
    (0, 12), (1, 12), (2, 12), (3, 12), (4, 12),   # weekdays at noon
    (0, 20),                                        # Monday evening
}


def should_run(now_utc: dt.datetime) -> bool:
    local = now_utc.astimezone(ZONE)
    return (local.weekday(), local.hour) in TARGETS


def main() -> None:
    now = dt.datetime.now(dt.timezone.utc)
    local = now.astimezone(ZONE)
    decision = should_run(now)
    print(
        f"UTC {now:%Y-%m-%d %H:%M} = Eastern {local:%Y-%m-%d %H:%M %Z} "
        f"({local:%A}) -> {'run' if decision else 'skip'}"
    )
    # GitHub Actions step output
    print(f"decision={'run' if decision else 'skip'}")
    sys.exit(0)


if __name__ == "__main__":
    main()

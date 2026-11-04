#!/usr/bin/env python3
"""Decide whether a scheduled run should actually refresh.

GitHub cron is UTC-only and does not follow daylight saving, so a single UTC
cron drifts by an hour twice a year. The workflow therefore fires at BOTH
candidate UTC hours for each target and this guard lets exactly one through —
the one that is really the wanted local time in America/Chicago.

Targets:
  * Monday, Wednesday and Friday at 09:00 Central

Exits 0 and prints "run" when the run should proceed, otherwise prints "skip".
Manual runs (workflow_dispatch) never reach this script.
"""

from __future__ import annotations

import datetime as dt
import sys
from zoneinfo import ZoneInfo

ZONE = ZoneInfo("America/Chicago")

# (weekday, hour) in local Central time. Monday is 0.
TARGETS = {(0, 9), (2, 9), (4, 9)}   # Mon / Wed / Fri at 9 AM Central


def should_run(now_utc: dt.datetime) -> bool:
    local = now_utc.astimezone(ZONE)
    return (local.weekday(), local.hour) in TARGETS


def main() -> None:
    now = dt.datetime.now(dt.timezone.utc)
    local = now.astimezone(ZONE)
    decision = should_run(now)
    print(
        f"UTC {now:%Y-%m-%d %H:%M} = Central {local:%Y-%m-%d %H:%M %Z} "
        f"({local:%A}) -> {'run' if decision else 'skip'}"
    )
    # GitHub Actions step output
    print(f"decision={'run' if decision else 'skip'}")
    sys.exit(0)


if __name__ == "__main__":
    main()

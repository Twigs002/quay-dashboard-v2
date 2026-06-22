"""Pull clocked hours per agent from Supabase and write
data/clock_data.json. Used by quay/data.js to feed real clocked hours into
the All Staff page (and any other view that wants real CT instead of the
df/0.85 estimate).

Output shape (current):

    {
      "generated_at": "...",
      "source": "supabase" | "unset" | "error",
      "agents": [ ... THIS WEEK rows, kept for backwards compat ... ],
      "week_start": "...", "week_end": "...",
      "periods": {
        "this-week":  { "agents": [...], "from": "...", "to": "..." },
        "last-week":  { ... },
        "this-month": { ... },        # 21st of prev month → 20th of this (Quay pay cycle)
        "last-90":    { ... },
        "all-time":   { ... },        # last 365 days as a stand-in for "all time"
      }
    }

Environment:
  SUPABASE_URL                 — project URL, e.g. https://<proj>.supabase.co
  SUPABASE_SERVICE_ROLE_KEY    — service role key (read-only is enough)

If either is missing, writes an empty payload and exits 0 so the
workflow doesn't fail when secrets aren't configured.
"""
import datetime
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlencode

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT  = ROOT / "data" / "clock_data.json"

PAGE_SIZE = 1000  # PostgREST default cap — must paginate for periods > a few weeks


def week_window(now: datetime.datetime) -> tuple[datetime.datetime, datetime.datetime]:
    monday = (now - datetime.timedelta(days=now.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    sunday = monday + datetime.timedelta(days=6, hours=23, minutes=59, seconds=59)
    return monday, sunday


def last_week_window(now: datetime.datetime) -> tuple[datetime.datetime, datetime.datetime]:
    m, s = week_window(now - datetime.timedelta(days=7))
    return m, s


def pay_cycle_window(now: datetime.datetime) -> tuple[datetime.datetime, datetime.datetime]:
    """Quay pay cycle: 21st of month M-1 → 20th of month M (inclusive)."""
    if now.day >= 21:
        start_year, start_month = now.year, now.month
    else:
        # Cycle started LAST month's 21st
        if now.month == 1:
            start_year, start_month = now.year - 1, 12
        else:
            start_year, start_month = now.year, now.month - 1
    start = datetime.datetime(start_year, start_month, 21, 0, 0, 0, tzinfo=now.tzinfo)
    # End = 20th of next month, 23:59:59
    if start_month == 12:
        end_year, end_month = start_year + 1, 1
    else:
        end_year, end_month = start_year, start_month + 1
    end = datetime.datetime(end_year, end_month, 20, 23, 59, 59, tzinfo=now.tzinfo)
    return start, end


def last_n_days_window(now: datetime.datetime, n: int) -> tuple[datetime.datetime, datetime.datetime]:
    end = now.replace(hour=23, minute=59, second=59, microsecond=0)
    start = (now - datetime.timedelta(days=n - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return start, end


def normalise_name(name: str) -> str:
    s = re.sub(r"_", " ", name or "")
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", s)
    return s.strip()


def fetch_window(supabase_url: str, service_key: str,
                 frm: datetime.datetime, to: datetime.datetime) -> list[dict]:
    """Page through every clock-OUT event in [frm, to]. duration_hrs is set on
    OUT rows only, so summing OUTs gives the right total."""
    rows: list[dict] = []
    offset = 0
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Accept": "application/json",
    }
    while True:
        # PostgREST supports repeated `ts` query params (gte + lte). Encode
        # the whole param list at once so the '+' inside ISO timezone offsets
        # gets percent-encoded; concatenating a second &ts=lte.…+00:00 by
        # hand turned the '+' into a space and produced 400 Bad Request.
        params = [
            ("select", "duration_hrs,staff_id,staff(name)"),
            ("dir",    "eq.out"),
            ("ts",     f"gte.{frm.isoformat()}"),
            ("ts",     f"lte.{to.isoformat()}"),
            ("order",  "ts.asc"),
            ("offset", str(offset)),
            ("limit",  str(PAGE_SIZE)),
        ]
        url = f"{supabase_url}/rest/v1/events?{urlencode(params)}"
        r = requests.get(url, headers=headers, timeout=60)
        r.raise_for_status()
        batch = r.json() or []
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return rows


def aggregate(rows: list[dict]) -> list[dict]:
    """Rows -> [{id, name, name_normalised, hours, sessions}, ...]."""
    by_agent: dict[str, dict] = {}
    for row in rows:
        sid  = row.get("staff_id") or ""
        name = (row.get("staff") or {}).get("name") or sid
        hrs  = float(row.get("duration_hrs") or 0)
        agg  = by_agent.setdefault(sid, {"id": sid, "name": name, "hours": 0.0, "sessions": 0})
        agg["hours"] += hrs
        agg["sessions"] += 1
    out = []
    for a in by_agent.values():
        out.append({
            "id": a["id"],
            "name": a["name"],
            "name_normalised": normalise_name(a["name"]),
            "hours": round(a["hours"], 3),
            "sessions": a["sessions"],
        })
    return out


def write_payload(payload: dict) -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    print(f"[fetch_clock] wrote {OUT.relative_to(ROOT)} "
          f"({len(payload.get('agents', []))} this-week agents; "
          f"periods: {list((payload.get('periods') or {}).keys())})")


def main() -> int:
    supabase_url = os.environ.get("SUPABASE_URL", "").strip()
    service_key  = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not supabase_url or not service_key:
        print("[fetch_clock] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — writing empty payload.")
        write_payload({
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "week_start": None, "week_end": None, "agents": [], "source": "unset",
            "periods": {},
        })
        return 0

    now = datetime.datetime.now(datetime.timezone.utc)

    # `this-month` here mirrors quay/data.js's PERIODS definition: a rolling
    # 4-week window ending at the most-recent Sunday. The Quay pay cycle
    # (21st → 20th) is a separate concept used by quay-clock's timesheets;
    # don't conflate the two or the All Staff KPI will mismatch the data.js
    # weekly-slice aggregations.
    this_week_start, this_week_end = week_window(now)
    four_weeks_start = this_week_start - datetime.timedelta(days=21)
    windows = {
        "this-week":  (this_week_start, this_week_end),
        "last-week":  last_week_window(now),
        "this-month": (four_weeks_start, this_week_end),  # rolling 4 weeks
        "last-90":    last_n_days_window(now, 90),
        "all-time":   last_n_days_window(now, 365),
    }

    periods: dict[str, dict] = {}
    try:
        for key, (frm, to) in windows.items():
            rows = fetch_window(supabase_url, service_key, frm, to)
            periods[key] = {
                "from": frm.isoformat(),
                "to":   to.isoformat(),
                "agents": aggregate(rows),
            }
            print(f"[fetch_clock] {key}: {len(rows)} events -> {len(periods[key]['agents'])} agents")
    except Exception as exc:
        print(f"[fetch_clock] WARN: Supabase fetch failed: {exc}")
        write_payload({
            "generated_at": now.isoformat(),
            "week_start": windows["this-week"][0].isoformat(),
            "week_end":   windows["this-week"][1].isoformat(),
            "agents": [], "source": "error", "error": str(exc),
            "periods": {},
        })
        return 0

    # Back-compat: top-level "agents" + week bounds mirror this-week so
    # any existing consumer that hasn't been migrated to `periods` keeps
    # rendering correctly.
    this_week = periods["this-week"]
    write_payload({
        "generated_at": now.isoformat(),
        "week_start":   this_week["from"],
        "week_end":     this_week["to"],
        "agents":       this_week["agents"],
        "source":       "supabase",
        "periods":      periods,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())

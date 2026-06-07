"""Pull weekly clocked hours per agent from Supabase and write
data/clock_data.json. Used by quay/data.js to feed real ct hours into
the Work Time tab.

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


def week_window(now: datetime.datetime) -> tuple[str, str]:
    monday = (now - datetime.timedelta(days=now.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    sunday = monday + datetime.timedelta(days=6, hours=23, minutes=59, seconds=59)
    return monday.isoformat() + "Z", sunday.isoformat() + "Z"


def normalise_name(name: str) -> str:
    s = re.sub(r"_", " ", name or "")
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", s)
    return s.strip()


def write_payload(payload: dict) -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    print(f"[fetch_clock] wrote {OUT.relative_to(ROOT)} ({len(payload.get('agents', []))} agents)")


def main() -> int:
    supabase_url = os.environ.get("SUPABASE_URL", "").strip()
    service_key  = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not supabase_url or not service_key:
        print("[fetch_clock] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — writing empty payload.")
        write_payload({
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "week_start": None, "week_end": None, "agents": [], "source": "unset",
        })
        return 0

    now = datetime.datetime.now(datetime.timezone.utc)
    week_from, week_to = week_window(now)

    # PostgREST: pull this week's `out` events (duration_hrs is set on out only),
    # plus the staff names via a select join.
    params = {
        "select": "duration_hrs,staff_id,staff(name)",
        "dir":    "eq.out",
        "ts":     f"gte.{week_from}",  # primary range filter
    }
    url = f"{supabase_url}/rest/v1/events?{urlencode(params)}&ts=lte.{week_to}"
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Accept": "application/json",
    }

    try:
        r = requests.get(url, headers=headers, timeout=30)
        r.raise_for_status()
        rows = r.json()
    except Exception as exc:
        print(f"[fetch_clock] WARN: Supabase fetch failed: {exc}")
        write_payload({
            "generated_at": now.isoformat(), "week_start": week_from, "week_end": week_to,
            "agents": [], "source": "error", "error": str(exc),
        })
        return 0

    by_agent: dict[str, dict] = {}
    for row in rows:
        sid  = row.get("staff_id") or ""
        name = (row.get("staff") or {}).get("name") or sid
        hrs  = float(row.get("duration_hrs") or 0)
        agg  = by_agent.setdefault(sid, {"id": sid, "name": name, "hours": 0.0, "sessions": 0})
        agg["hours"] += hrs
        agg["sessions"] += 1

    agents = []
    for a in by_agent.values():
        agents.append({
            "id": a["id"],
            "name": a["name"],
            "name_normalised": normalise_name(a["name"]),
            "hours": round(a["hours"], 3),
            "sessions": a["sessions"],
        })

    write_payload({
        "generated_at": now.isoformat(),
        "week_start": week_from,
        "week_end": week_to,
        "agents": agents,
        "source": "supabase",
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())

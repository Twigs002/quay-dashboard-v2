"""
Fetch clocked-hours from the quay-clock Apps Script and write
data/clock_data.json. Used by quay/data.js to replace the
`workTime / 0.85` estimate in the Work Time tab with real values.

Environment:
  QUAY_CLOCK_URL  — Apps Script Web App URL (the same URL the PWA POSTs to)

If QUAY_CLOCK_URL is unset, this script writes an empty payload and exits
0 — the dashboard falls back to the old estimate so the build never breaks.

Schedule: called by .github/workflows/update-data.yml right after
fetch_dialfire.py so weekly_data.json + clock_data.json stay in sync.
"""

import datetime
import json
import os
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT  = ROOT / "data" / "clock_data.json"


def week_window(now: datetime.datetime) -> tuple[str, str]:
    """Monday 00:00 UTC → Sunday 23:59:59 UTC of the current week."""
    monday = (now - datetime.timedelta(days=now.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    sunday = monday + datetime.timedelta(days=6, hours=23, minutes=59, seconds=59)
    return monday.isoformat() + "Z", sunday.isoformat() + "Z"


def normalise_name(name: str) -> str:
    """Match `quay/data.js` prettifyName: 'WarrickSolomons' → 'Warrick Solomons'."""
    import re
    s = re.sub(r"_", " ", name or "")
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", s)
    return s.strip()


def post(url: str, action: str, **payload):
    body = {"action": action, **payload}
    r = requests.post(
        url,
        data=json.dumps(body),
        headers={"Content-Type": "text/plain;charset=utf-8"},
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"{action} → {data.get('error', 'unknown error')}")
    return data


def write_payload(payload: dict) -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    print(f"[fetch_clock] wrote {OUT.relative_to(ROOT)} ({len(payload.get('agents', []))} agents)")


def main() -> int:
    url = os.environ.get("QUAY_CLOCK_URL", "").strip()
    if not url:
        print("[fetch_clock] QUAY_CLOCK_URL not set — writing empty payload, dashboard will fall back to estimate.")
        write_payload({
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "week_start": None, "week_end": None, "agents": [], "source": "unset",
        })
        return 0

    now = datetime.datetime.now(datetime.timezone.utc)
    week_from, week_to = week_window(now)
    try:
        data = post(url, "summary", **{"from": week_from, "to": week_to})
    except Exception as exc:
        print(f"[fetch_clock] WARN: summary request failed: {exc}")
        write_payload({
            "generated_at": now.isoformat(), "week_start": week_from, "week_end": week_to,
            "agents": [], "source": "error", "error": str(exc),
        })
        return 0  # never fail the workflow on a transient clock-app outage

    agents = []
    for row in data.get("summary", []):
        name = row.get("name") or ""
        agents.append({
            "id": row.get("id", ""),
            "name": name,
            "name_normalised": normalise_name(name),
            "hours": round(float(row.get("hours", 0) or 0), 3),
            "sessions": int(row.get("sessions", 0) or 0),
        })

    write_payload({
        "generated_at": now.isoformat(),
        "week_start": week_from,
        "week_end": week_to,
        "agents": agents,
        "source": "apps_script",
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())

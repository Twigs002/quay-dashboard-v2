"""Pull per-TEAM call stats for the ClientHub Master campaign and write
data/clienthub_teams.json for the dashboard's "ClientHub · By Team" tab.

In this HubSpot setup each `hubspot_owner_id` IS a team (the team owns its
contacts). Dialfire exposes the owner as the groupable `Contact_Owner` view
(built on `hubspot_owner_id`), so grouping the editsDef_v2 report by
Contact_Owner gives per-team calls + talk-time + leads for any window.

owner_id -> team name comes from data/clienthub_owners.json (a static map
generated via the HubSpot owners API), so this fetcher needs NO HubSpot
credentials in CI — only the Dialfire campaign token.

Environment:
  CAMPAIGN_CLIENTHUB_ID     — ClientHub Master campaign id (BWHH6K3MSJGETZ5S)
  CAMPAIGN_CLIENTHUB_TOKEN  — that campaign's Dialfire access token

If either is missing, writes an empty payload and exits 0 (matches
fetch_clock.py) so the workflow doesn't fail when secrets aren't set.
"""
import datetime
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dialfire_common import API_BASE, LOCALE, SAST, dates_to_timespan, fetch_json  # noqa

ROOT = Path(__file__).resolve().parent.parent
OUT  = ROOT / "data" / "clienthub_teams.json"
OWNER_MAP = ROOT / "data" / "clienthub_owners.json"

# Report columns we pull per owner-group (positional in the response).
COLUMNS = ["completed", "connectTimeDialer", "success"]


def _hours(v):
    """connectTimeDialer as hours. Mirrors parse_row: values are hours unless
    the raw number is implausibly large (>1000), in which case it's ms."""
    try:
        n = float(v) if v not in (None, "", "-") else 0.0
    except (TypeError, ValueError):
        return 0.0
    return n / 3.6e6 if n > 1000 else n


def _num(v):
    try:
        return float(v) if v not in (None, "", "-") else 0.0
    except (TypeError, ValueError):
        return 0.0


def windows_for(today):
    """The three reporting windows: last completed Mon-Sun week, month-to-date,
    and the full previous calendar month. All in SAST."""
    this_monday = today - datetime.timedelta(days=today.weekday())
    last_monday = this_monday - datetime.timedelta(days=7)
    last_sunday = last_monday + datetime.timedelta(days=6)
    month_start = today.replace(day=1)
    last_month_end = month_start - datetime.timedelta(days=1)
    last_month_start = last_month_end.replace(day=1)
    return {
        "last-week":  (last_monday, last_sunday),
        "this-month": (month_start, today),
        "last-month": (last_month_start, last_month_end),
    }


def fetch_window(cid, token, frm, to):
    """Return list of {team, owner_ids[], calls, talkHrs, leads} for a window,
    or None on fetch failure (so we preserve the prior file)."""
    ts = dates_to_timespan(frm, to)
    params = {"access_token": token, "asTree": "true", "timespan": ts,
              "group0": "Contact_Owner"}
    for i, col in enumerate(COLUMNS):
        params[f"column{i}"] = col
    url = f"{API_BASE}/api/campaigns/{cid}/reports/editsDef_v2/report/{LOCALE}"
    data = fetch_json(url, params, "clienthub", f"teams ts={ts}")
    if data is None:
        return None
    groups = (data.get("groups") if isinstance(data, dict) else None) or []
    return groups


def aggregate(groups, owner_map):
    """owner-id groups -> per-team rows (owners sharing a team name merge)."""
    by_team = {}
    for g in groups:
        if not isinstance(g, dict):
            continue
        oid = str(g.get("value", "")).strip()
        if not oid:
            continue
        cols = g.get("columns") or []
        calls = _num(cols[0]) if len(cols) > 0 else 0.0
        talk  = _hours(cols[1]) if len(cols) > 1 else 0.0
        leads = _num(cols[2]) if len(cols) > 2 else 0.0
        # Dialfire returns a small "error" bucket for calls it can't attribute
        # to an owner — keep it as "Unassigned" (honest in the totals). A
        # numeric owner id missing from the map means the map needs a refresh.
        team = owner_map.get(oid) or ("Unassigned" if not oid.isdigit() else f"Unmapped owner {oid}")
        row = by_team.setdefault(team, {"team": team, "owner_ids": [], "calls": 0.0, "talkHrs": 0.0, "leads": 0.0})
        row["owner_ids"].append(oid)
        row["calls"] += calls
        row["talkHrs"] += talk
        row["leads"] += leads
    rows = []
    for r in by_team.values():
        rows.append({
            "team": r["team"],
            "owner_ids": sorted(set(r["owner_ids"])),
            "calls": int(round(r["calls"])),
            "talkHrs": round(r["talkHrs"], 2),
            "leads": int(round(r["leads"])),
        })
    rows.sort(key=lambda r: -r["calls"])
    return rows


def write(payload):
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    n = {k: len(v.get("teams", [])) for k, v in (payload.get("windows") or {}).items()}
    print(f"[fetch_clienthub_teams] wrote {OUT.relative_to(ROOT)} (teams per window: {n})")


def main():
    cid   = os.environ.get("CAMPAIGN_CLIENTHUB_ID", "").strip()
    token = os.environ.get("CAMPAIGN_CLIENTHUB_TOKEN", "").strip()
    now = datetime.datetime.now(datetime.timezone.utc)
    if not cid or not token:
        print("[fetch_clienthub_teams] CAMPAIGN_CLIENTHUB_ID/TOKEN not set — empty payload.")
        write({"generated_at": now.isoformat(), "campaign_id": cid or None,
               "source": "unset", "windows": {}})
        return 0

    owner_map = {}
    if OWNER_MAP.exists():
        try:
            owner_map = json.loads(OWNER_MAP.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"[fetch_clienthub_teams] WARN: bad owner map: {exc}")

    today = datetime.datetime.now(SAST).date()
    windows = {}
    for key, (frm, to) in windows_for(today).items():
        groups = fetch_window(cid, token, frm, to)
        if groups is None:
            print(f"[fetch_clienthub_teams] {key}: FETCH FAILED — preserving prior file, exiting.")
            return 0  # leave the existing clienthub_teams.json untouched
        teams = aggregate(groups, owner_map)
        windows[key] = {
            "from": frm.isoformat(), "to": to.isoformat(),
            "teams": teams,
            "totals": {
                "calls": sum(t["calls"] for t in teams),
                "talkHrs": round(sum(t["talkHrs"] for t in teams), 2),
                "leads": sum(t["leads"] for t in teams),
                "teams": len(teams),
            },
        }
        print(f"[fetch_clienthub_teams] {key} ({frm}->{to}): {len(teams)} teams, "
              f"{windows[key]['totals']['calls']} calls")

    write({"generated_at": now.isoformat(), "campaign_id": cid,
           "source": "dialfire", "windows": windows})
    return 0


if __name__ == "__main__":
    sys.exit(main())

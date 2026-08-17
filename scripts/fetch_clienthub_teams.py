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
from dialfire_common import (  # noqa
    API_BASE, LOCALE, SAST, dates_to_timespan, fetch_json,
    SELLER_STATUSES, RENTAL_STATUSES, EMAIL_STATUSES,
)

ROOT = Path(__file__).resolve().parent.parent
OUT  = ROOT / "data" / "clienthub_teams.json"
OWNER_MAP = ROOT / "data" / "clienthub_owners.json"


def _num(v):
    try:
        return float(v) if v not in (None, "", "-") else 0.0
    except (TypeError, ValueError):
        return 0.0


def windows_for(today):
    """The reporting windows: current week-to-date, last completed Mon-Sun
    week, month-to-date, and the full previous calendar month. All in SAST."""
    this_monday = today - datetime.timedelta(days=today.weekday())
    last_monday = this_monday - datetime.timedelta(days=7)
    last_sunday = last_monday + datetime.timedelta(days=6)
    month_start = today.replace(day=1)
    last_month_end = month_start - datetime.timedelta(days=1)
    last_month_start = last_month_end.replace(day=1)
    return {
        "this-week":  (this_monday, today),
        "last-week":  (last_monday, last_sunday),
        "this-month": (month_start, today),
        "last-month": (last_month_start, last_month_end),
    }


def fetch_owner_calls(cid, token, ts):
    """{owner_id: total calls} — group the report by Contact_Owner. Returns
    None on fetch failure so callers can preserve the prior file."""
    url = f"{API_BASE}/api/campaigns/{cid}/reports/editsDef_v2/report/{LOCALE}"
    params = {"access_token": token, "asTree": "true", "timespan": ts,
              "group0": "Contact_Owner", "column0": "completed"}
    data = fetch_json(url, params, "clienthub", f"owner calls ts={ts}")
    if data is None:
        return None
    out = {}
    for g in (data.get("groups") if isinstance(data, dict) else None) or []:
        if not isinstance(g, dict):
            continue
        oid = str(g.get("value", "")).strip()
        cols = g.get("columns") or []
        if oid:
            out[oid] = _num(cols[0]) if cols else 0.0
    return out


def fetch_owner_leads(cid, token, ts):
    """{owner_id: {seller, rental, email}} — group by Lead_Status then
    Contact_Owner, bucketing statuses (LEAD -> seller, RENTAL_LEAD -> rental,
    GOT_EMAIL -> email). Mirrors dialfire_common.fetch_lead_counts but keyed
    by owner instead of agent."""
    url = f"{API_BASE}/api/campaigns/{cid}/reports/editsDef_v2/report/{LOCALE}"
    params = {"access_token": token, "asTree": "true", "timespan": ts,
              "group0": "Lead_Status", "group1": "Contact_Owner", "column0": "completed"}
    data = fetch_json(url, params, "clienthub", f"owner leads ts={ts}")
    if not (data and isinstance(data, dict)):
        return {}
    seller_up = {s.upper() for s in SELLER_STATUSES}
    rental_up = {s.upper() for s in RENTAL_STATUSES}
    email_up  = {s.upper() for s in EMAIL_STATUSES}
    out = {}
    for sgrp in data.get("groups", []):
        if not isinstance(sgrp, dict):
            continue
        status = str(sgrp.get("value", "")).strip().upper()
        if   status in seller_up: bucket = "seller"
        elif status in rental_up: bucket = "rental"
        elif status in email_up:  bucket = "email"
        else:                     bucket = None
        if bucket is None:
            continue
        for u in sgrp.get("groups", sgrp.get("children", [])):
            if not isinstance(u, dict):
                continue
            oid = str(u.get("value", "")).strip()
            if not oid or oid == "-":
                continue
            cols = u.get("columns") or []
            out.setdefault(oid, {"seller": 0, "rental": 0, "email": 0})[bucket] += int(_num(cols[0]) if cols else 0)
    return out


def aggregate(per_campaign, owner_map):
    """per_campaign: list of (label, owner_calls, owner_leads) — one entry per
    ClientHub campaign (master/new/na). Returns per-team rows keeping both the
    combined totals AND a `by_campaign` split so the dashboard's Lead Sources
    drill-down can show Engine Room CM / NA / New per team.
    (owners sharing a team name merge.)"""
    def team_for(oid):
        # Dialfire returns a small "error" bucket for calls it can't attribute
        # to an owner — keep it as "Unassigned" (honest in the totals). A
        # numeric owner id missing from the map means the map needs a refresh.
        return owner_map.get(oid) or ("Unassigned" if not oid.isdigit() else f"Unmapped owner {oid}")

    by_team = {}
    for lbl, owner_calls, owner_leads in per_campaign:
        owner_ids = set(owner_calls) | set(owner_leads)
        for oid in owner_ids:
            team = team_for(oid)
            lead = owner_leads.get(oid) or {}
            row = by_team.setdefault(team, {
                "team": team, "owner_ids": set(),
                "calls": 0.0, "seller": 0, "rental": 0, "email": 0,
                "by_campaign": {},
            })
            row["owner_ids"].add(oid)
            c = owner_calls.get(oid, 0.0)
            s = int(lead.get("seller", 0))
            r = int(lead.get("rental", 0))
            em = int(lead.get("email", 0))
            row["calls"] += c
            row["seller"] += s
            row["rental"] += r
            row["email"] += em
            bc = row["by_campaign"].setdefault(lbl, {"calls": 0.0, "seller": 0, "rental": 0, "email": 0})
            bc["calls"] += c
            bc["seller"] += s
            bc["rental"] += r
            bc["email"] += em

    rows = [{
        "team": r["team"],
        "owner_ids": sorted(r["owner_ids"]),
        "calls": int(round(r["calls"])),
        "seller": r["seller"],
        "rental": r["rental"],
        "email": r["email"],
        "by_campaign": {
            lbl: {
                "calls": int(round(v["calls"])),
                "seller": v["seller"],
                "rental": v["rental"],
                "email": v["email"],
            }
            for lbl, v in sorted(r["by_campaign"].items(), key=lambda kv: _LABEL_ORDER.get(kv[0], 9))
        },
    } for r in by_team.values()]
    rows.sort(key=lambda r: -r["calls"])
    return rows


def write(payload):
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    n = {k: len(v.get("teams", [])) for k, v in (payload.get("windows") or {}).items()}
    print(f"[fetch_clienthub_teams] wrote {OUT.relative_to(ROOT)} (teams per window: {n})")


# The Engine Room calling floor spans three ClientHub campaigns; stats are
# summed per team across all present campaigns. Each row = (env id var, env
# token var, short label).
CAMPAIGNS = [
    ("CAMPAIGN_CLIENTHUB_ID",           "CAMPAIGN_CLIENTHUB_TOKEN",           "master"),
    ("CAMPAIGN_CLIENTHUB_NEW_ID",       "CAMPAIGN_CLIENTHUB_NEW_TOKEN",       "new"),
    ("CAMPAIGN_CLIENTHUB_NO_ANSWER_ID", "CAMPAIGN_CLIENTHUB_NO_ANSWER_TOKEN", "na"),
]

# Exact Dialfire campaign name -> short label, used when resolving campaigns
# from the DIALFIRE_CAMPAIGNS secret (below).
CLIENTHUB_NAMES = {
    "CLIENTHUB":           "master",
    "CLIENTHUB_NEW":       "new",
    "CLIENTHUB_NO_ANSWER": "na",
}
_LABEL_ORDER = {"master": 0, "new": 1, "na": 2}


def campaigns_from_dialfire_secret():
    """Fallback source: pull the three ClientHub (id, token, label) rows out of
    the DIALFIRE_CAMPAIGNS secret — a JSON list of {id, token, name} that the
    other fetchers already rely on. Lets the daily job self-heal when the
    per-campaign CAMPAIGN_CLIENTHUB_* secrets aren't set (the workflow's
    ClientHub step only passed the master pair, so NEW/NO_ANSWER never flowed
    even when their secrets existed). Master is sorted first so the
    'master failed -> preserve prior file' guard stays meaningful."""
    raw = (os.environ.get("DIALFIRE_CAMPAIGNS") or "").strip()
    if not raw:
        return []
    try:
        rows = json.loads(raw)
    except Exception as exc:
        print(f"[fetch_clienthub_teams] WARN: DIALFIRE_CAMPAIGNS not JSON: {exc}")
        return []
    if not isinstance(rows, list):
        return []
    out = []
    for c in rows:
        if not isinstance(c, dict):
            continue
        lbl = CLIENTHUB_NAMES.get((c.get("name") or "").strip().upper())
        cid = (c.get("id") or "").strip()
        tok = (c.get("token") or "").strip()
        if lbl and cid and tok:
            out.append((cid, tok, lbl))
    out.sort(key=lambda r: _LABEL_ORDER.get(r[2], 9))
    return out


def main():
    now = datetime.datetime.now(datetime.timezone.utc)
    campaigns = [(os.environ.get(i, "").strip(), os.environ.get(t, "").strip(), lbl)
                 for i, t, lbl in CAMPAIGNS]
    campaigns = [(cid, tok, lbl) for cid, tok, lbl in campaigns if cid and tok]
    if not campaigns:
        # Individual secrets absent — derive id+token from DIALFIRE_CAMPAIGNS,
        # which already carries every campaign. Keeps Engine Room alive.
        campaigns = campaigns_from_dialfire_secret()
        if campaigns:
            print(f"[fetch_clienthub_teams] using DIALFIRE_CAMPAIGNS fallback "
                  f"({', '.join(l for _, _, l in campaigns)}).")
    if not campaigns:
        print("[fetch_clienthub_teams] no ClientHub campaign secrets set — empty payload.")
        write({"generated_at": now.isoformat(), "campaigns": [],
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
        ts = dates_to_timespan(frm, to)
        # Keep per-campaign owner calls + seller/rental/email so aggregate() can
        # emit a per-team by_campaign split (Engine Room CM / NA / New).
        per_campaign, contributors = [], []
        for cid, tok, lbl in campaigns:
            calls = fetch_owner_calls(cid, tok, ts)
            if calls is None:
                # The primary (master) failing means preserve the prior file;
                # a secondary campaign failing just drops it from this window.
                if lbl == "master":
                    print(f"[fetch_clienthub_teams] {key}: master FETCH FAILED — preserving prior file, exiting.")
                    return 0
                print(f"[fetch_clienthub_teams] {key}: {lbl} fetch failed — skipping that campaign.")
                continue
            leads = fetch_owner_leads(cid, tok, ts)
            contributors.append(lbl)
            per_campaign.append((lbl, calls, leads))
        teams = aggregate(per_campaign, owner_map)
        windows[key] = {
            "from": frm.isoformat(), "to": to.isoformat(),
            "campaigns": contributors,
            "teams": teams,
            "totals": {
                "calls": sum(t["calls"] for t in teams),
                "seller": sum(t["seller"] for t in teams),
                "rental": sum(t["rental"] for t in teams),
                "email": sum(t["email"] for t in teams),
                "teams": len(teams),
            },
        }
        print(f"[fetch_clienthub_teams] {key} ({frm}->{to}) [{'+'.join(contributors)}]: "
              f"{len(teams)} teams, {windows[key]['totals']['calls']} calls, "
              f"{windows[key]['totals']['seller']} seller, {windows[key]['totals']['rental']} rental, "
              f"{windows[key]['totals']['email']} email")

    write({"generated_at": now.isoformat(),
           "campaigns": [lbl for _, _, lbl in campaigns],
           "source": "dialfire", "windows": windows})
    return 0


if __name__ == "__main__":
    sys.exit(main())

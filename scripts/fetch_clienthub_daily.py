"""Pull per-TEAM ClientHub ("Engine Room") call stats ONE DAY AT A TIME and
write data/clienthub_daily.json, so the dashboard can sum an arbitrary custom
date range client-side (Teams Reporting's Engine Room block).

fetch_clienthub_teams.py publishes only four fixed windows (this/last week,
this/last month) — great for the preset chips, useless for a custom range.
This companion fetcher mirrors fetch_dialfire_daily.py: it issues a one-day
Dialfire timespan per date and stores a compact per-team row per day, which
the browser rolls up over whatever [from, to] the user picks.

It reuses fetch_clienthub_teams' owner->team plumbing verbatim (same Dialfire
report, same owner map, same seller/rental/email bucketing), so the daily
numbers reconcile with the windowed ones by construction.

Environment (identical to fetch_clienthub_teams, plus the daily range knobs):
  CAMPAIGN_CLIENTHUB_ID / _TOKEN            — master ClientHub campaign
  CAMPAIGN_CLIENTHUB_NEW_ID / _TOKEN        — New campaign (optional)
  CAMPAIGN_CLIENTHUB_NO_ANSWER_ID / _TOKEN  — No-Answer campaign (optional)
  DIALFIRE_CAMPAIGNS                        — JSON list fallback (self-heal)
  START_DATE / END_DATE                     — YYYY-MM-DD explicit backfill range;
                                              blank = self-heal (last 7d + gaps in 30d)

If no ClientHub campaign secrets are set, writes/keeps an empty payload and
exits 0 (matches fetch_clienthub_teams) so the workflow never fails on unset
secrets.
"""
import datetime
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dialfire_common import SAST, single_day_timespan  # noqa
# Reuse the exact owner->team pipeline the windowed fetcher already ships.
from fetch_clienthub_teams import (  # noqa
    CAMPAIGNS, aggregate, campaigns_from_dialfire_secret,
    fetch_owner_calls, fetch_owner_leads,
)

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "clienthub_daily.json"
OWNER_MAP = ROOT / "data" / "clienthub_owners.json"


def resolve_campaigns():
    """Same resolution order as fetch_clienthub_teams: explicit per-campaign
    secrets first, DIALFIRE_CAMPAIGNS fallback otherwise."""
    campaigns = [(os.environ.get(i, "").strip(), os.environ.get(t, "").strip(), lbl)
                 for i, t, lbl in CAMPAIGNS]
    campaigns = [(cid, tok, lbl) for cid, tok, lbl in campaigns if cid and tok]
    if not campaigns:
        campaigns = campaigns_from_dialfire_secret()
        if campaigns:
            print("[fetch_clienthub_daily] using DIALFIRE_CAMPAIGNS fallback "
                  f"({', '.join(l for _, _, l in campaigns)}).")
    return campaigns


def load_owner_map():
    if not OWNER_MAP.exists():
        return {}
    try:
        return json.loads(OWNER_MAP.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"[fetch_clienthub_daily] WARN: bad owner map: {exc}")
        return {}


def load_existing():
    try:
        data = json.loads(OUT.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return []
    days = data.get("days") if isinstance(data, dict) else data
    return days if isinstance(days, list) else []


def dates_to_fetch(today):
    """Explicit START_DATE/END_DATE -> that inclusive range. Otherwise
    self-heal: the last 7 days through today, plus any date missing from the
    existing file within the last 30 days (mirrors fetch_dialfire_daily)."""
    yesterday = today - datetime.timedelta(days=1)
    end_env = (os.environ.get("END_DATE") or "").strip()
    start_env = (os.environ.get("START_DATE") or "").strip()

    if end_env or start_env:
        end = datetime.datetime.strptime(end_env or str(yesterday), "%Y-%m-%d").date()
        start = datetime.datetime.strptime(start_env or str(end - datetime.timedelta(days=30)), "%Y-%m-%d").date()
        if start > end:
            start = end
        out, d = [], start
        while d <= end:
            out.append(d)
            d += datetime.timedelta(days=1)
        return out

    dates = {today - datetime.timedelta(days=i) for i in range(8)}
    have = {e.get("date") for e in load_existing() if isinstance(e, dict)}
    d = today - datetime.timedelta(days=30)
    while d <= yesterday:
        if str(d) not in have:
            dates.add(d)
        d += datetime.timedelta(days=1)
    return sorted(dates)


def teams_for_day(campaigns, owner_map, ts):
    """Per-team rows for a single day, or None if the MASTER campaign fetch
    failed (so the caller can skip the day and retry it next run rather than
    persisting a false zero). Secondary campaigns failing just drop out."""
    per_campaign = []
    for cid, tok, lbl in campaigns:
        calls = fetch_owner_calls(cid, tok, ts)
        if calls is None:
            if lbl == "master":
                return None
            print(f"[fetch_clienthub_daily]   {lbl} fetch failed — skipping that campaign.")
            continue
        leads = fetch_owner_leads(cid, tok, ts)
        per_campaign.append((lbl, calls, leads))
    # Strip to the compact shape the browser range-sum needs (drop owner_ids /
    # by_campaign; the Engine Room block shows combined calls/seller/rental/email).
    return [{
        "team": t["team"],
        "calls": t["calls"],
        "seller": t["seller"],
        "rental": t["rental"],
        "email": t["email"],
    } for t in aggregate(per_campaign, owner_map)]


def main():
    now = datetime.datetime.now(datetime.timezone.utc)
    campaigns = resolve_campaigns()
    if not campaigns:
        print("[fetch_clienthub_daily] no ClientHub campaign secrets set — empty payload.")
        existing = load_existing()
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps({"generated_at": now.isoformat(),
                                   "source": "unset", "days": existing},
                                  indent=2, sort_keys=True), encoding="utf-8")
        return 0

    owner_map = load_owner_map()
    today = datetime.datetime.now(SAST).date()
    dates = dates_to_fetch(today)
    print(f"=== ClientHub daily fetch === {dates[0]} -> {dates[-1]} ({len(dates)} days) "
          f"[{'+'.join(l for _, _, l in campaigns)}]")

    days = load_existing()
    fetched = 0
    for d in dates:
        ts = single_day_timespan(d)
        teams = teams_for_day(campaigns, owner_map, ts)
        if teams is None:
            print(f"[fetch_clienthub_daily] {d} (ts={ts}): master FETCH FAILED — skipping, will retry.")
            continue
        date_str = str(d)
        days = [e for e in days if e.get("date") != date_str]
        days.append({"date": date_str, "generated": now.isoformat(), "teams": teams})
        fetched += 1
        tot = sum(t["calls"] for t in teams)
        print(f"[fetch_clienthub_daily] {d} (ts={ts}): {len(teams)} teams, {tot} calls")

    days.sort(key=lambda e: e.get("date", ""), reverse=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"generated_at": now.isoformat(),
                               "source": "dialfire",
                               "campaigns": [l for _, _, l in campaigns],
                               "days": days},
                              indent=2, sort_keys=True), encoding="utf-8")
    print(f"[fetch_clienthub_daily] wrote {OUT.relative_to(ROOT)} — "
          f"{len(days)} day entries ({fetched} fetched this run)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

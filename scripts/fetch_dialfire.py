"""
DialFire Weekly Stats Fetcher (Mon-Sun)
========================================
Fetches the current week's per-agent stats from DialFire and writes to:
  - data/weekly_data.json   (latest snapshot, used by the dashboard)
  - data/history.json       (week-by-week history, used by the charts)

Week boundary: Monday 00:00 -> Sunday 23:59 SAST.
On Mondays we fetch the PREVIOUS completed Mon-Sun week (since the new
week has just started and has no meaningful data yet).

Uses the same per-campaign editsDef_v2 endpoint as backfill_dialfire.py.
Aggregates correctly across all campaigns an agent appears in (this was
broken in earlier versions and in backfill_dialfire.py - see the docstring
of merge_agent_row below).
"""
import os, json, datetime, requests
from datetime import timezone, timedelta
import pytz

from dialfire_common import (
    LOCALE, API_BASE,
    dates_to_timespan, fetch_json, fetch_lead_counts,
    _norm_camp, parse_row, merge_agent_row, finalize,
)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
TIMEZONE = pytz.timezone("Africa/Johannesburg")


# ---------------------------------------------------------------------------
# Date helpers
# ---------------------------------------------------------------------------
def get_week_bounds(now_sast):
    """Return (monday, sunday) for the week we should fetch.

    On Mondays we fetch the PREVIOUS completed week (so the dashboard shows
    last week's full Mon-Sun). On Tue-Sun we fetch the CURRENT week (which
    is partial week-to-date).
    """
    today = now_sast.date()
    weekday = today.weekday()  # 0=Mon ... 6=Sun
    if weekday == 0:
        monday = today - timedelta(days=7)
    else:
        monday = today - timedelta(days=weekday)
    sunday = monday + timedelta(days=6)
    return monday, sunday


# ---------------------------------------------------------------------------
# Campaign helpers
# ---------------------------------------------------------------------------
def fetch_campaign_name(cid, token):
    """GET /api/campaigns/{cid} to get the human-readable name."""
    url = f"{API_BASE}/api/campaigns/{cid}"
    try:
        r = requests.get(url, params={"access_token": token}, timeout=10)
        if r.status_code == 200:
            data = r.json()
            name = (data.get("name") or data.get("title") or data.get("label") or "").strip()
            if name:
                return name
    except Exception as e:
        print(f"  Warning: could not fetch campaign name for {cid}: {e}")
    return cid


def fetch_campaign_week(campaign, ts):
    """Fetch per-agent editsDef_v2 stats for one campaign for the given timespan."""
    cid   = campaign["id"]
    token = campaign["token"]
    label = campaign.get("name", cid)
    base  = f"{API_BASE}/api/campaigns/{cid}"

    print(f"  [{label}] timespan={ts}")

    params = {
        "access_token": token,
        "asTree":       "true",
        "timespan":     ts,
        "group0":       "user",
        "column0":      "completed",
        "column1":      "success",
        "column2":      "successRate",
        "column3":      "workTime",
        "column4":      "connectTimeDialer",
        "column5":      "wrapupTime",
        "column6":      "pauseTime",
        "column7":      "waitTimeDialer",
    }

    data = fetch_json(f"{base}/reports/editsDef_v2/report/{LOCALE}", params, label, f"editsDef_v2 ts={ts}")
    # fetch_json contract (post-2026-07-06): None = fetch failed (HTTP error,
    # poll timeout, JSON parse, network exception). Genuine empty response
    # comes back as {} or {"groups": []}. Callers MUST propagate None so
    # main() can flag data_quality.warnings and preserve prior history.
    if data is None:
        print(f"  [{label}] FETCH FAILED — propagating (do not treat as empty)")
        return None
    if not data:
        print(f"  [{label}] no data (empty response)")
        return []

    grp = data.get("groups", [])
    if not (isinstance(grp, list) and len(grp) > 0):
        print(f"  [{label}] empty groups")
        return []

    print(f"  [{label}] {len(grp)} agent rows")

    lead_counts = fetch_lead_counts(cid, token, ts, label)
    for item in grp:
        if isinstance(item, dict):
            ag = str(item.get("value", "")).strip()
            if ag in lead_counts:
                item["seller"] = lead_counts[ag]["seller"]
                item["rental"] = lead_counts[ag]["rental"]
                item["email"]  = lead_counts[ag]["email"]
    return grp


# ---------------------------------------------------------------------------
# Campaign configuration (env-var driven)
# ---------------------------------------------------------------------------
def load_campaigns():
    """Build the list of (id, token, name) campaign tuples from env vars."""
    campaigns = []

    def add(env_id, env_tok, default_label):
        cid = os.environ.get(env_id, "").strip()
        tok = os.environ.get(env_tok, "").strip()
        if cid and tok:
            name = fetch_campaign_name(cid, tok) or default_label
            campaigns.append({"id": cid, "token": tok, "name": name})
            print(f"  Campaign: {default_label} -> {cid} ({name})")
        elif cid:
            print(f"  Campaign: {default_label} -> {cid} (NO TOKEN, skipping)")

    add("CAMPAIGN_CLIENTHUB_ID",           "CAMPAIGN_CLIENTHUB_TOKEN",           "CLIENTHUB")
    add("CAMPAIGN_CLIENTHUB_NEW_ID",       "CAMPAIGN_CLIENTHUB_NEW_TOKEN",       "CLIENTHUB_NEW")
    add("CAMPAIGN_CLIENTHUB_NO_ANSWER_ID", "CAMPAIGN_CLIENTHUB_NO_ANSWER_TOKEN", "CLIENTHUB_NO_ANSWER")

    i = 1
    while True:
        if not os.environ.get(f"CAMPAIGN_{i}_ID", "").strip():
            break
        add(f"CAMPAIGN_{i}_ID", f"CAMPAIGN_{i}_TOKEN", f"CAMP{i}")
        i += 1

    add("ASSASSINS_CM_ID", "ASSASSINS_CM_TOKEN", "ASSASSINS_CM")
    add("ASSASSINS_NA_ID", "ASSASSINS_NA_TOKEN", "ASSASSINS_NA")
    add("AMIGOS_CM_ID",    "AMIGOS_CM_TOKEN",    "AMIGOS_CM")
    add("AMIGOS_NA_ID",    "AMIGOS_NA_TOKEN",    "AMIGOS_NA")

    # Legacy single-campaign env var
    leg_id  = os.environ.get("DIALFIRE_CAMPAIGN_ID", "").strip()
    leg_tok = os.environ.get("DIALFIRE_CAMPAIGN_TOKEN", "").strip()
    if leg_id and leg_tok and not any(c["id"] == leg_id for c in campaigns):
        name = fetch_campaign_name(leg_id, leg_tok) or "LEGACY"
        campaigns.append({"id": leg_id, "token": leg_tok, "name": name})
        print(f"  Campaign: LEGACY -> {leg_id} ({name})")

    # JSON list fallback
    raw = os.environ.get("DIALFIRE_CAMPAIGNS", "")
    if raw:
        try:
            for c in json.loads(raw):
                if c.get("id") and c.get("token") and not any(x["id"] == c["id"] for x in campaigns):
                    if not c.get("name"):
                        c["name"] = fetch_campaign_name(c["id"], c["token"]) or c["id"]
                    campaigns.append(c)
                    print(f"  Campaign: JSON -> {c['id']} ({c['name']})")
        except json.JSONDecodeError as e:
            print(f"  Warning: could not parse DIALFIRE_CAMPAIGNS: {e}")

    return campaigns


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    now_utc  = datetime.datetime.now(timezone.utc)
    now_sast = now_utc.astimezone(TIMEZONE)
    monday, sunday = get_week_bounds(now_sast)
    ts = dates_to_timespan(monday, sunday)

    print(f"=== DialFire Weekly Fetch ===")
    print(f"Week: {monday} (Mon) -> {sunday} (Sun) | timespan={ts}")

    campaigns = load_campaigns()
    if not campaigns:
        print("ERROR: no campaigns configured.")
        return

    agents = {}
    by_campaign = {}                                      # raw campaign-name -> totals
    by_agent_campaign = {}                                # agent -> {raw campaign -> per-campaign stats}
    fetch_failures = []                                   # campaigns where fetch_json returned None
    empty_after_filter = []                               # campaigns where all rows dropped by parse_row
    for campaign in campaigns:
        rows = fetch_campaign_week(campaign, ts)
        cname    = _norm_camp(campaign.get("name", "")) or campaign.get("name", "")
        raw_name = campaign.get("name", "") or cname      # keep the CM/NA suffix here
        if rows is None:
            # Fetch failed (poll timeout, 5xx, network error). DO NOT record
            # a zero row — that would destructively overwrite good prior data.
            fetch_failures.append(raw_name)
            continue
        tot = {"calls":0, "success":0, "seller":0, "rental":0, "email":0,
               "workTime":0.0, "talkTime":0.0, "wrapTime":0.0,
               "pauseTime":0.0, "waitTime":0.0}
        seen_agents = set()
        dropped_rows = 0                                  # empty-name rows filtered by parse_row
        for row in rows:
            parsed = parse_row(row)
            if parsed is None:
                dropped_rows += 1
                continue
            merge_agent_row(agents, parsed, cname)
            # Preserve per-agent-per-campaign breakdown (Dialfire returns this
            # natively per campaign; we just store it instead of collapsing).
            ag_name = parsed["name"]
            if ag_name not in by_agent_campaign:
                by_agent_campaign[ag_name] = {}
            by_agent_campaign[ag_name][raw_name] = {
                "calls":    parsed["calls"],
                "success":  parsed["success"],
                "seller":   parsed["seller"],
                "rental":   parsed["rental"],
                "email":    parsed["email"],
                "workTime": parsed["workTime"],
                "talkTime": parsed["talkTime"],
            }
            tot["calls"]    += parsed.get("calls", 0)
            tot["success"]  += parsed.get("success", 0)
            tot["seller"]   += parsed.get("seller", 0)
            tot["rental"]   += parsed.get("rental", 0)
            tot["email"]    += parsed.get("email", 0)
            tot["workTime"] += parsed.get("workTime", 0.0)
            tot["talkTime"] += parsed.get("talkTime", 0.0)
            tot["wrapTime"] += parsed.get("wrapTime", 0.0)
            tot["pauseTime"]+= parsed.get("pauseTime", 0.0)
            tot["waitTime"] += parsed.get("waitTime", 0.0)
            seen_agents.add((parsed.get("name") or "").strip().lower())
        # Round floats to keep diff noise low.
        for k in ("workTime","talkTime","wrapTime","pauseTime","waitTime"):
            tot[k] = round(tot[k], 4)
        tot["agent_count"] = len(seen_agents)
        by_campaign[raw_name] = tot
        # A campaign that returned rows but ALL got filtered as empty-name
        # totals-only pseudo-rows is the exact Dialfire quirk that produced
        # the Jun 29 - Jul 5 SPARTANS/VIPERS zero-out. Flag it so the write
        # guard can refuse to overwrite prior good history.
        if rows and dropped_rows == len(rows):
            empty_after_filter.append(raw_name)
            print(f"  [{raw_name}] WARNING: {dropped_rows} row(s) all filtered as empty-name — Dialfire returned totals-only")

    finalize(agents)

    rm_agents    = sorted([a for a in agents.values() if a["is_rm"]],     key=lambda x: -x["calls"])
    fancy_agents = sorted([a for a in agents.values() if not a["is_rm"]], key=lambda x: -x["calls"])

    print()
    print(f"Unique agents: {len(agents)} | RM: {len(rm_agents)} | Fancy: {len(fancy_agents)}")
    for a in rm_agents + fancy_agents:
        grp = "RM   " if a["is_rm"] else "FANCY"
        print(f"  {grp} {a['name']:<22} calls={a['calls']:>4} workH={a['workTime']:>7.2f} cph={a['cph']:>5} campaigns={a.get('campaigns')}")

    # ---- weekly_data.json (current snapshot for the dashboard) ----
    week_str = str(monday)
    # Data-quality warnings become part of the payload so downstream
    # consumers (dashboard, weekly emailer, monthly reports) can gate on
    # them and refuse to draft on suspect data.
    warnings = []
    if fetch_failures:
        warnings.append({
            "kind": "fetch_failed",
            "campaigns": fetch_failures,
            "detail": "Dialfire fetch failed (poll timeout / 5xx / network). "
                      "These campaigns were skipped, NOT recorded as zero.",
        })
    if empty_after_filter:
        warnings.append({
            "kind": "totals_only_response",
            "campaigns": empty_after_filter,
            "detail": "Dialfire returned rows with no per-agent breakdown "
                      "(name is '' or '-'). Totals recorded but per-agent "
                      "attribution is lost for these campaigns.",
        })
    output = {
        "generated":   now_utc.isoformat(),
        "week":        week_str,
        "weekStart":   week_str,
        "weekEnd":     str(sunday),
        "periodStart": week_str,
        "periodEnd":   str(sunday),
        "rm":          rm_agents,
        "fancy":       fancy_agents,
        "by_campaign": by_campaign,
        "by_agent_campaign": by_agent_campaign,
    }
    if warnings:
        output["data_quality"] = {"warnings": warnings}

    os.makedirs("data", exist_ok=True)

    # ---- history.json (week-by-week archive) ----
    hist_path = "data/history.json"
    try:
        with open(hist_path) as f:
            history = json.load(f)
        if isinstance(history, dict):
            history = list(history.values())
        if not isinstance(history, list):
            history = []
    except (FileNotFoundError, json.JSONDecodeError):
        history = []

    # Non-destructive write guard: if we already have an entry for this week
    # and the new fetch is materially WORSE (fewer nonzero campaigns, or a
    # >15% drop in total calls), keep the existing entry. Attach the
    # rejected payload as `_shadow` and the warnings so a human can see why.
    # This is the durable fix for the Jun 29 - Jul 5 SPARTANS/VIPERS drop:
    # a Dialfire quirk that returned totals-only rows silently overwrote a
    # good prior fetch with zeros. Never overwrite good data with worse.
    existing = next((e for e in history
                     if e.get("week") == week_str or e.get("weekStart") == week_str),
                    None)
    keep_existing = False
    if existing:
        new_total = sum((c or {}).get("calls", 0) for c in by_campaign.values())
        old_total = sum((c or {}).get("calls", 0) for c in (existing.get("by_campaign") or {}).values())
        new_nonzero = sum(1 for c in by_campaign.values() if (c or {}).get("calls", 0) > 0)
        old_nonzero = sum(1 for c in (existing.get("by_campaign") or {}).values() if (c or {}).get("calls", 0) > 0)
        # Refuse only on quantitative regression, not on the mere presence
        # of warnings. Warnings are informational and MUST be recorded
        # alongside real data — otherwise a partial improvement (e.g.
        # SPARTANS_CM going 0 → 268 while OTHER campaigns still quirk)
        # gets blocked by the same guard it's supposed to be trying to help.
        regressed_calls    = old_total   > 0 and new_total   < old_total   * 0.85
        regressed_campaigns = old_nonzero > 0 and new_nonzero < old_nonzero * 0.85
        if regressed_calls or regressed_campaigns:
            keep_existing = True
            print(f"\n!! REFUSING to overwrite history.json entry for {week_str}:")
            print(f"   old: {old_total} calls across {old_nonzero} campaigns")
            print(f"   new: {new_total} calls across {new_nonzero} campaigns")
            if warnings:
                print(f"   warnings: {[w['kind'] for w in warnings]}")
            print(f"   Existing entry preserved. Investigate Dialfire response before re-running.")
        elif warnings:
            print(f"\n   Data-quality warnings present ({[w['kind'] for w in warnings]})"
                  f" but new totals ({new_total}/{new_nonzero}) not materially worse than"
                  f" existing ({old_total}/{old_nonzero}) — writing new entry with warnings attached.")

    if keep_existing:
        # Attach the rejected payload under _shadow for post-mortem, plus warnings.
        for e in history:
            if e.get("week") == week_str or e.get("weekStart") == week_str:
                e["_shadow_rejected"] = {"generated": output["generated"],
                                          "warnings": warnings,
                                          "by_campaign_totals":
                                              {k: v.get("calls", 0) for k, v in by_campaign.items()}}
                break
    else:
        history = [e for e in history if e.get("week") != week_str and e.get("weekStart") != week_str]
        history.insert(0, output)

    with open(hist_path, "w") as f:
        json.dump(history, f, indent=2)
    print(f"Updated data/history.json -- {len(history)} weeks total"
          + (" (KEPT existing entry, new fetch rejected)" if keep_existing else ""))

    # Write weekly_data.json to MATCH whatever history[0] now is — so the
    # dashboard's "current snapshot" reads the same data the archive holds.
    # If we rejected the new fetch, the OLD entry stays canonical.
    weekly_out = existing if keep_existing else output
    with open("data/weekly_data.json", "w") as f:
        json.dump(weekly_out, f, indent=2)
    print(f"Wrote data/weekly_data.json ("
          + ("preserved existing" if keep_existing else "new fetch")
          + ")")


if __name__ == "__main__":
    main()

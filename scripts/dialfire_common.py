"""
DialFire Common Module
======================
Shared constants, HTTP helpers, row parsing, and agent logic used by both
fetch_dialfire.py (weekly fetch) and backfill_dialfire.py (historical backfill).
"""
import re, json, time, requests, datetime
from datetime import timezone, timedelta
from zoneinfo import ZoneInfo

# Floor timezone — all callers pass SAST dates (Africa/Johannesburg).
# We compute the "today" reference here in SAST too so the relative-day
# delta lines up with the day boundary the caller meant.
SAST = ZoneInfo("Africa/Johannesburg")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
LOCALE   = "en_US"
API_BASE = "https://api.dialfire.com"

BENCHMARKS = {
    "cph":             45,
    "daily_calls":     315,
    "rm_success_rate": 17,
    "fc_success_rate": 20,
}

SELLER_STATUSES = {"LEAD"}
RENTAL_STATUSES = {"RENTAL_LEAD"}
EMAIL_STATUSES  = {"GOT_EMAIL"}

# Agents who ONLY work these campaigns are classified as "RM" (relationship
# manager). Anyone working a ClientHub variant plus a non-ClientHub campaign
# is "Fancy" (Fancy Caller). Stored lowercase for case-insensitive matching
# downstream — Dialfire returns the names with varying capitalisation across
# campaigns.
RM_CAMPAIGNS = {
    # current Dialfire short names
    "clienthub",
    "clienthub_new",
    "clienthub_no_answer",
    # legacy names that pre-date the rename (kept so historical weeks classify
    # correctly without a re-fetch)
    "clienthub master",
    "new contacts",
    "no answer / not contacted",
}


# ---------------------------------------------------------------------------
# Date helpers
# ---------------------------------------------------------------------------
def dates_to_timespan(date_from, date_to):
    """Convert absolute SAST dates to Dialfire 'X-Yday' relative timespan.

    Callers pass dates in SAST (Africa/Johannesburg) — see
    fetch_dialfire_daily.py / fetch_dialfire.py / backfill_dialfire.py.
    Previously this function computed "today" in UTC, which meant when the
    workflow ran in a time-of-day where the UTC and SAST calendar dates
    differed (between 22:00 UTC and 00:00 UTC), every (today-date).days
    delta was off by one — pushing SAST-Saturday's calls into Sunday's
    bucket and leaving Saturday empty in daily_data.json.

    Reference day boundary now comes from SAST so it matches the caller.

    For RANGES (e.g. the weekly Mon→Sun fetch) we keep the original
    semantics: subtract 1 from the end so the full end day is included
    while the boundary at Y stays open. Single-day buckets must use
    `single_day_timespan()` instead — see its docstring for why.
    """
    today = datetime.datetime.now(SAST).date()
    days_from = (today - date_from).days
    days_to   = (today - date_to).days - 1
    if days_to < 0:
        days_to = 0
    if days_from < days_to:
        days_from = days_to
    return f"{days_from}-{days_to}day"


def single_day_timespan(d):
    """Dialfire timespan covering exactly one SAST calendar day.

    The shared dates_to_timespan helper is built for ranges where the end
    boundary is "today" (so subtracting 1 from `days_to` makes the
    inclusive-on-X / exclusive-on-Y window land on the right Sunday).
    For a single-day fetch in the daily Dialfire pipeline, the same
    subtraction produced timespans like "7-6day" which Dialfire treats
    as inclusive-inclusive — returning Sun + Mon combined and storing
    Monday's call total under Sunday's bucket. Symptom: Sundays show
    non-zero call counts in daily_data.json even though the office is
    closed.

    Emitting `N-Nday` (with N = days-ago for that single date) keeps the
    Dialfire window exactly one day wide.
    """
    today = datetime.datetime.now(SAST).date()
    n = (today - d).days
    if n < 0:
        n = 0
    return f"{n}-{n}day"


# ---------------------------------------------------------------------------
# HTTP helper with 202-polling
# ---------------------------------------------------------------------------
def fetch_json(url, params, label, tag, max_poll=20):
    """GET url with params; handle DialFire's 202-then-poll async pattern.

    Return contract (so callers can distinguish silent data loss from real
    empty results):
      * dict / list  — Dialfire returned parseable JSON (may be structurally
        empty, e.g. {"groups": []}). This is a GENUINE response.
      * None         — fetch FAILED: 4xx, 5xx, poll timeout, JSON parse
        error, or a network exception. Caller MUST treat this differently
        from "no activity" — dropping to zero silently is how a busy week
        with a Dialfire quirk turns into permanent data loss in
        history.json (the Jun 29 - Jul 5 SPARTANS/VIPERS drop).
    Previously every failure returned {} which was indistinguishable from
    an empty-but-successful response.
    """
    try:
        r = requests.get(url, params=params, timeout=30)
        if r.status_code == 202:
            loc = r.headers.get("Location") or r.headers.get("location")
            if not loc:
                try:
                    body = r.json()
                    loc = body.get("url") or body.get("statusUrl") or body.get("location")
                except Exception:
                    pass
            if loc:
                # Exponential-ish backoff up to ~30s per iter; 20 polls → ~5min
                # ceiling. Weekly full-history reports over 100+ agents can
                # exceed the old 30s budget on busy Dialfire tenants.
                delay = 2
                for i in range(max_poll):
                    time.sleep(delay)
                    r2 = requests.get(loc, timeout=30)
                    if r2.status_code == 200:
                        try:    return r2.json()
                        except Exception as e:
                            print(f"  [{label}] {tag} -> poll JSON parse error: {e}")
                            return None
                    if r2.status_code in (401, 403):
                        print(f"  [{label}] {tag} -> poll {r2.status_code}")
                        return None
                    if r2.status_code >= 500 or r2.status_code == 429:
                        print(f"  [{label}] {tag} -> poll HTTP {r2.status_code} (transient)")
                    delay = min(30, int(delay * 1.5))
                print(f"  [{label}] {tag} -> polling timed out after {max_poll} attempts — FETCH FAILED")
                return None
            else:
                # No Location header — retry the same URL. Note this likely
                # spawns a NEW async job each time (Dialfire doesn't dedupe
                # on param hash), so the effective budget is fewer real polls.
                print(f"  [{label}] {tag} -> 202 no poll URL, retrying same URL")
                delay = 3
                for i in range(max_poll):
                    time.sleep(delay)
                    r2 = requests.get(url, params=params, timeout=30)
                    if r2.status_code == 200:
                        try:    return r2.json()
                        except Exception as e:
                            print(f"  [{label}] {tag} -> retry JSON parse error: {e}")
                            return None
                    if r2.status_code in (401, 403):
                        return None
                    if r2.status_code != 202:
                        print(f"  [{label}] {tag} -> retry HTTP {r2.status_code} — FETCH FAILED")
                        return None
                    delay = min(30, int(delay * 1.5))
                print(f"  [{label}] {tag} -> no-Location retry exhausted — FETCH FAILED")
                return None
        if r.status_code in (401, 403):
            print(f"  [{label}] {tag} -> HTTP {r.status_code} (token issue)")
            return None
        if r.status_code == 200:
            try:    return r.json()
            except Exception as e:
                print(f"  [{label}] {tag} -> JSON parse error: {e}")
                return None
        print(f"  [{label}] {tag} -> HTTP {r.status_code} — FETCH FAILED")
        return None
    except Exception as e:
        print(f"  [{label}] {tag} -> network error: {e} — FETCH FAILED")
        return None


# ---------------------------------------------------------------------------
# Campaign helpers
# ---------------------------------------------------------------------------
def _norm_camp(n):
    """Strip CM/NA suffix variants. 'Goal Diggers - CM' -> 'Goal Diggers'."""
    return re.sub(r"\s*[_\-\s]*(CM|NA)\s*$", "", n, flags=re.IGNORECASE).strip()


def fetch_lead_counts(cid, token, ts, label):
    """Lead-status counts per agent for the campaign (editsDef_v2 grouped)."""
    result   = {}
    base_url = f"{API_BASE}/api/campaigns/{cid}/reports/editsDef_v2/report/{LOCALE}"

    params = {
        "access_token": token,
        "asTree":       "true",
        "timespan":     ts,
        "group0":       "Lead_Status",
        "group1":       "user",
        "column0":      "completed",
    }
    data = fetch_json(base_url, params, label, "leads: Lead_Status>user")
    if not (data and isinstance(data, dict)):
        return result

    for sgrp in data.get("groups", []):
        if not isinstance(sgrp, dict):
            continue
        status_val = str(sgrp.get("value", "")).strip().upper()
        bucket = None
        if   status_val in {s.upper() for s in SELLER_STATUSES}: bucket = "seller"
        elif status_val in {s.upper() for s in RENTAL_STATUSES}: bucket = "rental"
        elif status_val in {s.upper() for s in EMAIL_STATUSES}:  bucket = "email"
        elif status_val == "NO_ANSWER":                          bucket = "no_answer"
        if bucket is None:
            continue
        for u in sgrp.get("groups", sgrp.get("children", [])):
            if not isinstance(u, dict):
                continue
            ag = str(u.get("value", "")).strip()
            if not ag or ag in ("-", ""):
                continue
            ucols = u.get("columns", [])
            cnt = 0
            if ucols:
                try:
                    cnt = int(ucols[0]) if ucols[0] not in (None, "", "-") else 0
                except Exception:
                    pass
            if ag not in result:
                result[ag] = {"seller": 0, "rental": 0, "email": 0, "no_answer": 0}
            result[ag][bucket] += cnt
    return result


# ---------------------------------------------------------------------------
# Row parsing
# ---------------------------------------------------------------------------
def parse_row(row):
    """Convert one DialFire 'group' row into our agent dict format."""
    name = str(
        row.get("value") or row.get("name") or row.get("user") or
        row.get("username") or row.get("agent_name") or "Unknown"
    ).strip()
    if not name or name in ("-", "\u2014", "\u2013", "Unknown", "None", ""):
        return None

    # editsDef_v2 returns columns positionally in the order we requested:
    # [completed, success, successRate, workTime].
    cols = row.get("columns", [])
    def _col(i, default=0):
        try:    return float(cols[i] or 0)
        except Exception:  return float(default)

    calls   = int(row.get("completed") or row.get("calls") or _col(0) or 0)
    success = int(row.get("success") or _col(1) or 0)
    wt_raw  = float(row.get("workTime") or _col(3) or 0)
    # workTime from editsDef_v2 is in hours unless the raw integer is > 1000,
    # in which case it's milliseconds.
    work_hrs = wt_raw / 3600000 if wt_raw > 1000 else wt_raw

    talk_hrs  = float(_col(4) or 0)   # connectTimeDialer
    wrap_hrs  = float(_col(5) or 0)   # wrapupTime
    pause_hrs = float(_col(6) or 0)   # pauseTime
    wait_hrs  = float(_col(7) or 0)   # waitTimeDialer

    cph = round(calls / work_hrs, 1) if work_hrs > 0 else 0.0
    sr  = round(success / calls * 100, 1) if calls > 0 else 0.0

    return {
        "name":        name,
        "calls":       calls,
        "success":     success,
        "seller":      int(row.get("seller_lead") or row.get("seller") or 0),
        "rental":      int(row.get("rental_lead") or row.get("rental") or 0),
        "email":       int(row.get("got_email")   or row.get("email")  or 0),
        # hs_lead_status == NO_ANSWER count (mixed in by the live daemon). Used
        # to derive "Answered" = calls - no_answer in finalize().
        "no_answer":   int(row.get("no_answer") or 0),
        "cph":         cph,
        "successRate": sr,
        "workTime":    round(work_hrs, 4),
        "talkTime":    round(talk_hrs, 4),
        "wrapTime":    round(wrap_hrs, 4),
        "pauseTime":   round(pause_hrs, 4),
        "waitTime":    round(wait_hrs, 4),
        "is_rm":       False,
        "meetsTarget": False,
        "campaigns":   [],
    }


# ---------------------------------------------------------------------------
# Agent aggregation
# ---------------------------------------------------------------------------
def merge_agent_row(agents, parsed, cname):
    """Add `parsed` (one campaign's row for an agent) into the running
    `agents` dict.

    For every (agent, campaign) pair we ADD the campaign's counts to the
    agent's running totals -- and append the campaign name. The previous
    implementations had a bug where new-campaign rows only appended the name
    but skipped the counts, so multi-campaign agents only ever reflected
    their first campaign.
    """
    n = parsed["name"]
    if n not in agents:
        # First time we've seen this agent - take parsed as the starting
        # values and start a fresh campaigns list.
        a = parsed.copy()
        a["campaigns"] = [cname] if cname else []
        agents[n] = a
        return

    a = agents[n]
    a["calls"]    += parsed["calls"]
    a["success"]  += parsed["success"]
    a["seller"]   += parsed["seller"]
    a["rental"]   += parsed["rental"]
    a["email"]    += parsed["email"]
    a["no_answer"] = a.get("no_answer", 0) + parsed.get("no_answer", 0)
    a["workTime"]  = round(a["workTime"]  + parsed["workTime"],  4)
    a["talkTime"]  = round(a.get("talkTime",0)  + parsed.get("talkTime",0),  4)
    a["wrapTime"]  = round(a.get("wrapTime",0)  + parsed.get("wrapTime",0),  4)
    a["pauseTime"] = round(a.get("pauseTime",0) + parsed.get("pauseTime",0), 4)
    a["waitTime"]  = round(a.get("waitTime",0)  + parsed.get("waitTime",0),  4)
    if cname and cname not in a["campaigns"]:
        a["campaigns"].append(cname)


# ---------------------------------------------------------------------------
# Classification + final stats
# ---------------------------------------------------------------------------
def finalize(agents):
    """Compute cph, successRate, RM/Fancy classification, meetsTarget,
    plus the three time-share percentages used by the All Staff page."""
    for a in agents.values():
        a["cph"] = round(a["calls"] / a["workTime"], 1) if a["workTime"] > 0 else 0.0
        a["successRate"] = round(a["success"] / a["calls"] * 100, 1) if a["calls"] > 0 else 0.0
        # "Answered" = every reached/dispositioned call, i.e. all completed
        # calls except those left at hs_lead_status = NO_ANSWER. Includes
        # "Declined" outcomes (NOT_ENGAGING, DO_NOT_CONTACT). Clamped >= 0.
        a["answered"] = max(int(a.get("calls", 0)) - int(a.get("no_answer", 0)), 0)

        wt = a.get("workTime", 0) or 0
        a["talkPct"] = round(a.get("talkTime", 0) / wt * 100, 1) if wt > 0 else 0.0
        a["wrapPct"] = round(a.get("wrapTime", 0) / wt * 100, 1) if wt > 0 else 0.0
        a["waitPct"] = round(a.get("waitTime", 0) / wt * 100, 1) if wt > 0 else 0.0
        # "work %" = % of session actively dialling (not paused)
        denom = wt + a.get("pauseTime", 0)
        a["workPct"] = round(wt / denom * 100, 1) if denom > 0 else 0.0

        # Case-insensitive match — Dialfire capitalises ClientHub variants
        # inconsistently ("CLIENTHUB" vs "Clienthub Master").
        camps_lower = {(c or "").strip().lower() for c in a.get("campaigns", [])}
        a["is_rm"] = bool(camps_lower) and camps_lower.issubset(RM_CAMPAIGNS)

        bench = BENCHMARKS["rm_success_rate"] if a["is_rm"] else BENCHMARKS["fc_success_rate"]
        a["meetsTarget"] = (
            a["cph"] >= BENCHMARKS["cph"] and a["successRate"] >= bench
        ) if a["calls"] > 0 else False

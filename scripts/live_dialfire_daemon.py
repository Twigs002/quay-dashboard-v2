#!/usr/bin/env python3
"""
Live Dialfire Daemon
====================
Polls Dialfire "today" stats every ~90s across all configured campaigns in
parallel, aggregates per-agent calls/leads/workTime, and upserts the result
into Supabase's `live_stats` table. Designed to run under launchd.

Inputs:
  - DIALFIRE_CAMPAIGNS env (JSON array of {id, token, name})
      OR ~/.dialfire-campaigns.json with the same shape.
  - SUPABASE_URL                env  (e.g. https://...supabase.co)
  - SUPABASE_SERVICE_ROLE_KEY   env  (service-role JWT)
"""
import os, sys, re, json, time, signal, datetime, pathlib, traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from zoneinfo import ZoneInfo
import requests

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
from dialfire_common import (  # noqa: E402
    LOCALE, API_BASE,
    fetch_json, fetch_lead_counts,
    parse_row, merge_agent_row, finalize,
)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SAST           = ZoneInfo("Africa/Johannesburg")
POLL_SECONDS   = 90
MIN_SLEEP      = 5
MAX_WORKERS    = 15
TIMESPAN       = "0-0day"                          # today (per dialfire_common)
PROJECT_ROOT   = SCRIPT_DIR.parent
LOG_DIR        = PROJECT_ROOT / "logs"
LOG_FILE       = LOG_DIR / "live_daemon.log"
CAMPAIGNS_JSON = pathlib.Path(os.path.expanduser("~/.dialfire-campaigns.json"))

_running = True


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
def log(msg):
    ts = datetime.datetime.now(SAST).strftime("%Y-%m-%d %H:%M:%S")
    line = f"{ts}  {msg}"
    print(line, flush=True)
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except Exception as e:
        print(f"  (log write failed: {e})", flush=True)


# ---------------------------------------------------------------------------
# Campaign loading (env DIALFIRE_CAMPAIGNS or ~/.dialfire-campaigns.json)
# ---------------------------------------------------------------------------
def load_campaigns():
    raw = (os.environ.get("DIALFIRE_CAMPAIGNS") or "").strip()
    if raw:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            raise SystemExit(f"ERROR: DIALFIRE_CAMPAIGNS is not valid JSON: {e}")
        source = "env"
    elif CAMPAIGNS_JSON.exists():
        try:
            with open(CAMPAIGNS_JSON) as f:
                data = json.load(f)
        except json.JSONDecodeError as e:
            raise SystemExit(f"ERROR: {CAMPAIGNS_JSON} is not valid JSON: {e}")
        source = str(CAMPAIGNS_JSON)
    else:
        raise SystemExit(
            "ERROR: no campaigns configured. Set DIALFIRE_CAMPAIGNS env var "
            f"or create {CAMPAIGNS_JSON} (JSON array of id/token/name objects)."
        )

    if not isinstance(data, list):
        raise SystemExit("ERROR: campaigns must be a JSON array.")

    campaigns = []
    for c in data:
        if not isinstance(c, dict):
            continue
        cid, tok = (c.get("id") or "").strip(), (c.get("token") or "").strip()
        if cid and tok:
            campaigns.append({
                "id":    cid,
                "token": tok,
                "name":  (c.get("name") or cid).strip(),
            })
    if not campaigns:
        raise SystemExit("ERROR: campaigns list is empty.")
    return campaigns, source


# ---------------------------------------------------------------------------
# Per-campaign Dialfire fetch (editsDef_v2 + lead-status mix-in)
# ---------------------------------------------------------------------------
def fetch_campaign_today(campaign):
    cid, token = campaign["id"], campaign["token"]
    label = campaign.get("name", cid)
    base  = f"{API_BASE}/api/campaigns/{cid}"

    params = {
        "access_token": token,
        "asTree":       "true",
        "timespan":     TIMESPAN,
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

    data = fetch_json(f"{base}/reports/editsDef_v2/report/{LOCALE}", params, label, "live")
    if not data or not isinstance(data, dict):
        return label, []
    rows = data.get("groups", []) or []
    if not rows:
        return label, []

    try:
        lead_counts = fetch_lead_counts(cid, token, TIMESPAN, label)
    except Exception as e:
        log(f"  [{label}] lead-counts error: {e}")
        lead_counts = {}

    for item in rows:
        if isinstance(item, dict):
            ag = str(item.get("value", "")).strip()
            if ag in lead_counts:
                item["seller"] = lead_counts[ag]["seller"]
                item["rental"] = lead_counts[ag]["rental"]
                item["email"]  = lead_counts[ag]["email"]
    return label, rows


# ---------------------------------------------------------------------------
# Supabase upsert
# ---------------------------------------------------------------------------
_SLUG_RE = re.compile(r"[^a-z0-9]+")

def staff_slug(name):
    s = _SLUG_RE.sub("-", name.lower()).strip("-")
    return s or "unknown"


def prettify(name):
    """Dialfire returns CamelCase names ("LisabellPanze"); the dashboard
    expects spaced ones ("Lisabell Panze") so its first+last name lookups
    match the Supabase staff roster. Mirrors quay/data.js's prettifyName."""
    import re
    return re.sub(r"([a-z])([A-Z])", r"\1 \2", (name or "").replace("_", " ")).strip()


def build_rows(agents, now_iso):
    out = []
    for a in agents.values():
        n = prettify((a.get("name") or "").strip())
        if not n:
            continue
        out.append({
            "staff_id":     staff_slug(n),
            "name":         n,
            "calls":        int(a.get("calls") or 0),
            "leads":        int(a.get("success") or 0),
            "seller_leads": int(a.get("seller") or 0),
            "rental_leads": int(a.get("rental") or 0),
            "email_leads":  int(a.get("email") or 0),
            "work_hours":   round(float(a.get("workTime") or 0), 4),
            "success_rate": round(float(a.get("successRate") or 0), 1),
            "updated_at":   now_iso,
        })
    return out


def upsert_live_stats(rows, supabase_url, service_key):
    if not rows:
        return
    url = f"{supabase_url.rstrip('/')}/rest/v1/live_stats"
    headers = {
        "apikey":        service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates,return=minimal",
    }
    r = requests.post(url, headers=headers, data=json.dumps(rows), timeout=30)
    if r.status_code >= 300:
        log(f"  [supabase] HTTP {r.status_code}: {r.text[:300]}")


# ---------------------------------------------------------------------------
# One poll iteration
# ---------------------------------------------------------------------------
def run_once(campaigns, supabase_url, service_key):
    t0 = time.time()
    agents = {}

    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, max(1, len(campaigns)))) as ex:
        futures = {ex.submit(fetch_campaign_today, c): c for c in campaigns}
        for fut in as_completed(futures):
            c = futures[fut]
            try:
                _label, rows = fut.result()
            except Exception as e:
                log(f"  [{c.get('name', c['id'])}] fetch error: {e}")
                continue
            cname = c.get("name", "") or c["id"]
            for row in rows:
                parsed = parse_row(row)
                if parsed is None:
                    continue
                merge_agent_row(agents, parsed, cname)

    finalize(agents)

    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        upsert_live_stats(build_rows(agents, now_iso), supabase_url, service_key)
    except Exception as e:
        log(f"  [supabase] upsert error: {e}")

    total_calls = sum(int(a.get("calls") or 0) for a in agents.values())
    total_leads = sum(int(a.get("success") or 0) for a in agents.values())
    elapsed = int(time.time() - t0)
    log(f"[live] {len(campaigns)} campaigns -> {len(agents)} agents, "
        f"{total_calls} calls, {total_leads} leads (took {elapsed}s)")
    return elapsed


# ---------------------------------------------------------------------------
# Signal handling + main loop
# ---------------------------------------------------------------------------
def _shutdown(signum, _frame):
    global _running
    log(f"[live] received signal {signum}, shutting down")
    _running = False


def main():
    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT,  _shutdown)

    supabase_url = (os.environ.get("SUPABASE_URL") or "").strip()
    service_key  = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not service_key:
        # Fall back to macOS Keychain so the plist doesn't have to embed the
        # secret. Match the entry created in the setup step:
        #   security add-generic-password -s SUPABASE_SERVICE_ROLE_KEY \
        #     -a supabase-quay-clock -w '<jwt>'
        try:
            import subprocess
            service_key = subprocess.check_output(
                ["security", "find-generic-password",
                 "-s", "SUPABASE_SERVICE_ROLE_KEY",
                 "-a", "supabase-quay-clock", "-w"],
                stderr=subprocess.DEVNULL,
            ).decode().strip()
        except Exception:
            pass
    if not supabase_url:
        raise SystemExit("ERROR: SUPABASE_URL env var not set.")
    if not service_key:
        raise SystemExit(
            "ERROR: SUPABASE_SERVICE_ROLE_KEY not in env or Keychain "
            "(service=SUPABASE_SERVICE_ROLE_KEY, account=supabase-quay-clock).")

    campaigns, source = load_campaigns()

    log("=" * 60)
    log("[live] starting Dialfire live daemon")
    log(f"[live] supabase_url = {supabase_url}")
    log(f"[live] service_key  = {service_key[:8]}...{service_key[-4:]} (len={len(service_key)})")
    log(f"[live] campaigns    = {len(campaigns)} (source: {source})")
    for c in campaigns:
        log(f"[live]   - {c['name']} ({c['id']})")
    log(f"[live] poll interval = {POLL_SECONDS}s, max_workers = {MAX_WORKERS}")
    log("=" * 60)

    while _running:
        try:
            elapsed = run_once(campaigns, supabase_url, service_key)
        except Exception as e:
            log(f"[live] iteration error: {e}")
            log(traceback.format_exc())
            elapsed = 0

        if not _running:
            break
        sleep_for = POLL_SECONDS - elapsed if elapsed < POLL_SECONDS else MIN_SLEEP
        end_at = time.time() + sleep_for
        while _running and time.time() < end_at:
            time.sleep(min(1.0, end_at - time.time()))

    log("[live] exited cleanly")


if __name__ == "__main__":
    main()

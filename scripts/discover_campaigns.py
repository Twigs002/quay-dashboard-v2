"""Discover every campaign under your DialFire tenant and write
data/campaigns.json. Run this once (or on a schedule) so the dashboard
+ fetch_dialfire.py stop needing per-campaign env vars.

Environment:
  DIALFIRE_TENANT_ID
  DIALFIRE_TENANT_TOKEN

Usage (local):
  DIALFIRE_TENANT_ID="<id>" \
  DIALFIRE_TENANT_TOKEN="<token>" \
  python scripts/discover_campaigns.py

The script tries a few likely DialFire tenant-listing endpoints. If
none returns 200, it prints the response from each so we can adjust
the URL to whatever your tenant actually exposes.
"""
from __future__ import annotations
import datetime
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlencode

import requests

ROOT     = Path(__file__).resolve().parent.parent
OUT      = ROOT / "data" / "campaigns.json"
API_BASE = "https://api.dialfire.com"


def env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        print(f"[discover] missing env var: {name}", file=sys.stderr)
        sys.exit(2)
    return v


def fetch_first_ok(urls: list[tuple[str, dict]]) -> dict | None:
    """Try each URL; return the first JSON body that came with HTTP 200."""
    for url, params in urls:
        try:
            r = requests.get(url, params=params, timeout=30,
                             headers={"Accept": "application/json"})
            print(f"[discover] GET {url} → {r.status_code}")
            if r.status_code == 200:
                try:
                    return r.json()
                except ValueError:
                    print(f"[discover]   ↪ non-JSON body: {r.text[:200]!r}")
                    continue
            else:
                print(f"[discover]   ↪ {r.text[:200]!r}")
        except Exception as e:
            print(f"[discover]   ↪ error: {e}")
    return None


def main() -> int:
    tenant_id    = env("DIALFIRE_TENANT_ID")
    tenant_token = env("DIALFIRE_TENANT_TOKEN")

    # DialFire docs use a few different conventions across endpoints.
    # We try the most plausible ones in order.
    attempts = [
        (f"{API_BASE}/api/tenants/{tenant_id}/campaigns",
         {"access_token": tenant_token}),
        (f"{API_BASE}/api/tenants/{tenant_id}/campaigns/",
         {"access_token": tenant_token}),
        (f"{API_BASE}/api/tenants/{tenant_id}/campaigns/list",
         {"access_token": tenant_token}),
        (f"{API_BASE}/api/tenants/{tenant_id}/campaigns",
         {"token": tenant_token}),
    ]
    data = fetch_first_ok(attempts)
    if data is None:
        print("[discover] no endpoint accepted the tenant token. Paste the "
              "response bodies above to me and I'll adjust the URL pattern.",
              file=sys.stderr)
        return 1

    # Normalise whatever shape DialFire returned into a flat list.
    raw_campaigns = data
    if isinstance(data, dict):
        for key in ("campaigns", "items", "data", "results"):
            if key in data and isinstance(data[key], list):
                raw_campaigns = data[key]
                break
    if not isinstance(raw_campaigns, list):
        print(f"[discover] unexpected payload shape: {type(raw_campaigns).__name__}", file=sys.stderr)
        print(json.dumps(data, indent=2)[:2000])
        return 1

    campaigns = []
    for c in raw_campaigns:
        if not isinstance(c, dict):
            continue
        cid = c.get("id") or c.get("campaign_id") or c.get("_id")
        if not cid:
            continue
        campaigns.append({
            "id":          cid,
            "name":        c.get("name") or c.get("title") or cid,
            "status":      c.get("status") or "",
            "access_token": c.get("access_token") or c.get("token") or "",
            "url":         f"https://app.dialfire.com/#/cmp/{cid}",
        })

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "tenant_id":    tenant_id,
        "campaigns":    campaigns,
    }
    OUT.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    print(f"[discover] wrote {OUT.relative_to(ROOT)} ({len(campaigns)} campaigns)")
    for c in campaigns:
        tag = " (has token)" if c["access_token"] else ""
        print(f"  · {c['name']:<40s}  {c['id']}{tag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

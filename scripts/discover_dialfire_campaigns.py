"""
DialFire — Tenant-wide Campaign Discovery
==========================================

Lists every campaign visible under your DialFire tenant token and either
prints them, or merges them into the DIALFIRE_CAMPAIGNS JSON list used
by fetch_dialfire.py.

Required env vars:
    DIALFIRE_TENANT_ID
    DIALFIRE_TENANT_TOKEN    (or DIALFIRE_HUBSPOT_BEARER as a fallback —
                              the same Bearer from the connector page
                              CAN list campaigns on some tenant setups)

Optional:
    DIALFIRE_BASE            override the API base (default
                             https://app.dialfire.com).
    OUTPUT_PATH              where to write the JSON (default
                             scripts/campaigns.discovered.json — gitignored).
                             Push to a GitHub Actions secret via the
                             companion workflow instead of committing.

This script tries a few likely tenant-listing endpoints in order and
reports which one worked, so future DialFire URL changes are easy to
adapt to. If none returns 200, it prints each response body so you
can paste it back and we'll tune the URL.
"""
from __future__ import annotations
import json
import os
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "scripts" / "campaigns.discovered.json"
API_BASE = os.environ.get("DIALFIRE_BASE", "https://app.dialfire.com").rstrip("/")


def env(name: str, default: str | None = None) -> str:
    v = (os.environ.get(name) or "").strip()
    if v:
        return v
    if default is not None:
        return default
    print(f"[discover] missing env var: {name}", file=sys.stderr)
    sys.exit(2)


def try_endpoints(tenant_id: str, token: str) -> tuple[str, list[dict]] | None:
    """Return (winning_url, campaigns_list) or None.

    Tries several plausible tenant-listing endpoints; reports the
    HTTP status of each so unknown shapes are easy to diagnose.
    """
    attempts = [
        # The HubSpot connector endpoint uses /hubspot/api/tenants/...
        # — we try that first because we know the user has access to it.
        (f"{API_BASE}/hubspot/api/tenants/{tenant_id}/campaigns",
         {"Authorization": f"Bearer {token}"}, None),
        # api.dialfire.com is the public REST host.
        (f"https://api.dialfire.com/api/tenants/{tenant_id}/campaigns",
         {}, {"access_token": token}),
        (f"https://api.dialfire.com/api/tenants/{tenant_id}/campaigns",
         {"Authorization": f"Bearer {token}"}, None),
        (f"https://api.dialfire.com/api/tenants/{tenant_id}/campaigns/",
         {}, {"access_token": token}),
    ]
    for url, headers, params in attempts:
        try:
            r = requests.get(url, headers={**headers, "Accept": "application/json"},
                             params=params, timeout=30)
            print(f"[discover] GET {url} -> {r.status_code}")
            if r.status_code == 200:
                try:
                    body = r.json()
                except ValueError:
                    print(f"  non-JSON body: {r.text[:200]!r}")
                    continue
                # Normalise the response shape — DialFire endpoints
                # sometimes return a list, sometimes {campaigns: [...]}.
                items = body if isinstance(body, list) else \
                        body.get("campaigns") or body.get("items") or body.get("data") or []
                if items:
                    return url, items
                print(f"  empty body: {body!r}")
            else:
                print(f"  body: {r.text[:200]!r}")
        except Exception as e:
            print(f"  error: {e!r}")
    return None


def normalise_campaign(c: dict) -> dict | None:
    """Pick the fields fetch_dialfire.py needs."""
    cid = c.get("id") or c.get("campaignId") or c.get("uuid")
    if not cid:
        return None
    # DialFire returns the per-campaign access token as one of these names
    # depending on which endpoint you hit.
    token = (c.get("accessToken") or c.get("access_token")
             or c.get("token") or c.get("apiToken") or "")
    name = (c.get("name") or c.get("title") or c.get("label") or cid).strip()
    return {"id": str(cid), "token": str(token), "name": name}


def main() -> int:
    tenant_id    = env("DIALFIRE_TENANT_ID")
    tenant_token = (os.environ.get("DIALFIRE_TENANT_TOKEN", "").strip()
                    or os.environ.get("DIALFIRE_HUBSPOT_BEARER", "").strip())
    if not tenant_token:
        print("[discover] need DIALFIRE_TENANT_TOKEN or DIALFIRE_HUBSPOT_BEARER", file=sys.stderr)
        return 2

    result = try_endpoints(tenant_id, tenant_token)
    if result is None:
        print("\n[discover] No endpoint accepted the token. Paste the response", file=sys.stderr)
        print("bodies above to me and I'll adjust the URL pattern.", file=sys.stderr)
        return 3
    url, raw = result
    print(f"\n[discover] using endpoint: {url}")
    print(f"[discover] {len(raw)} campaigns returned")

    out = []
    skipped_no_token = 0
    for c in raw:
        norm = normalise_campaign(c)
        if not norm:
            continue
        if not norm["token"]:
            # Token-less campaign — fetch_dialfire.py needs the token,
            # so warn and skip. Some tenant endpoints return campaign
            # metadata without the per-campaign access token; in that
            # case the user has to keep using per-campaign tokens.
            skipped_no_token += 1
            continue
        out.append(norm)
    print(f"[discover] {len(out)} campaigns with tokens, {skipped_no_token} skipped (no token)")

    out_path = Path(os.environ.get("OUTPUT_PATH") or DEFAULT_OUT)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2))
    print(f"[discover] wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

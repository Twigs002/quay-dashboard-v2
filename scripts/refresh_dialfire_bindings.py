"""
DialFire HubSpot Connector — Bulk Binding Refresh
===================================================

Triggers the per-binding contact sync against every NA + CM campaign
in your DialFire <-> HubSpot connector. This is the scripted version
of what the user previously did by hand (113 manual clicks of the
refresh icon, or a JS loop pasted into the browser console).

It hits the connector's internal API directly:
    POST /hubspot/api/tenants/{tenant_id}/connections/{connection_id}
         /bindings/{binding_id}/contacts/synchronize

Required env vars:
    DIALFIRE_HUBSPOT_BEARER   the Bearer token from the Angular scope
                              (see README in scripts/ for how to get it)
    DIALFIRE_TENANT_ID        the tenant UUID
    DIALFIRE_CONNECTION_ID    the connection UUID inside that tenant

Optional:
    DIALFIRE_FILTER_SUFFIX    space-separated list of allowed campaign-
                              title suffixes. Default " - NA  - CM"
                              (the two the user actually refreshes).
                              Set to "" to refresh every binding.
    DIALFIRE_BASE             override the API base (default
                              https://app.dialfire.com).
    DIALFIRE_DRY_RUN          'true' to list which bindings would be hit
                              without firing any POSTs.
"""
from __future__ import annotations
import json
import os
import sys
import time

import requests


def env(name: str, default: str | None = None) -> str:
    v = (os.environ.get(name) or "").strip()
    if v:
        return v
    if default is not None:
        return default
    print(f"[refresh] missing env var: {name}", file=sys.stderr)
    sys.exit(2)


def main() -> int:
    bearer        = env("DIALFIRE_HUBSPOT_BEARER")
    tenant_id     = env("DIALFIRE_TENANT_ID")
    connection_id = env("DIALFIRE_CONNECTION_ID")
    base          = env("DIALFIRE_BASE", "https://app.dialfire.com")
    suffix_raw    = env("DIALFIRE_FILTER_SUFFIX", " - NA  - CM")
    dry_run       = env("DIALFIRE_DRY_RUN", "false").lower() in ("1", "true", "yes")

    suffixes = [s for s in suffix_raw.split("  ") if s.strip()] or [""]
    if suffix_raw.strip():
        print(f"[refresh] filter: title endswith one of {suffixes!r}")
    else:
        print("[refresh] filter: none (every binding)")

    session = requests.Session()
    session.headers.update({
        "Authorization": f"Bearer {bearer}",
        "Accept":        "application/json",
        "Content-Type":  "application/json",
    })

    # 1) Load the connection so we can iterate every binding under it.
    conn_url = f"{base}/hubspot/api/tenants/{tenant_id}/connections/{connection_id}"
    r = session.get(conn_url, timeout=30)
    if r.status_code == 401:
        print("[refresh] 401 — token expired or wrong tenant. Re-grab the Bearer.", file=sys.stderr)
        return 3
    if not r.ok:
        print(f"[refresh] could not load connection: HTTP {r.status_code} {r.text[:200]!r}", file=sys.stderr)
        return 4
    conn = r.json()
    bindings = conn.get("bindings") or []
    if not bindings:
        print("[refresh] connection has no bindings.", file=sys.stderr)
        return 5

    # 2) Filter to the requested suffixes (or all if filter is empty).
    def matches(title: str) -> bool:
        if not suffix_raw.strip():
            return True
        return any(title.endswith(s) for s in suffixes)

    targets = [b for b in bindings if matches(b.get("dialfireCampaignTitle") or b.get("title") or "")]
    print(f"[refresh] {len(targets)} bindings to sync out of {len(bindings)} total")

    if dry_run:
        for b in targets:
            print(f"  WOULD sync  id={b.get('id')}  title={b.get('dialfireCampaignTitle') or b.get('title')!r}")
        return 0

    # 3) Fire one sync per binding, sequentially. 409 / 503 retries once
    # after a short pause (matches the user's manual recovery pattern).
    ok = 0
    failed = []
    for i, b in enumerate(targets, 1):
        bid = b.get("id")
        title = b.get("dialfireCampaignTitle") or b.get("title") or bid
        url = f"{base}/hubspot/api/tenants/{tenant_id}/connections/{connection_id}/bindings/{bid}/contacts/synchronize"
        for attempt in (1, 2):
            try:
                rr = session.post(url, json={}, timeout=60)
            except requests.RequestException as e:
                if attempt == 1:
                    print(f"  [{i:>3}/{len(targets)}] {title!r}: {e!r} — retry in 5s")
                    time.sleep(5)
                    continue
                print(f"  [{i:>3}/{len(targets)}] {title!r}: FAILED ({e!r})")
                failed.append({"id": bid, "title": title, "error": str(e)})
                break
            if rr.status_code in (200, 202, 204):
                print(f"  [{i:>3}/{len(targets)}] {title}  -> {rr.status_code} ok")
                ok += 1
                break
            if rr.status_code in (409, 503) and attempt == 1:
                print(f"  [{i:>3}/{len(targets)}] {title}  -> {rr.status_code}, retrying in 10s")
                time.sleep(10)
                continue
            print(f"  [{i:>3}/{len(targets)}] {title}  -> {rr.status_code} {rr.text[:200]!r}")
            failed.append({"id": bid, "title": title, "status": rr.status_code,
                           "body": rr.text[:500]})
            break
        # Tiny gap between successful POSTs so we don't trip a rate limit.
        time.sleep(0.5)

    print(f"\n[refresh] DONE — {ok}/{len(targets)} ok, {len(failed)} failed")
    if failed:
        print(json.dumps(failed, indent=2))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

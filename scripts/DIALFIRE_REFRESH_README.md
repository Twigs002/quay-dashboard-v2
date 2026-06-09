# DialFire Connector Refresh — Operator Notes

Two on-demand workflows live in `.github/workflows/`:

| Workflow | What it does |
|----------|--------------|
| `DialFire — Refresh HubSpot Bindings` | Fires the per-binding contact sync against every NA + CM campaign in your HubSpot ↔ DialFire connector. Replaces the 113-click manual flow. |
| `DialFire — Discover Tenant Campaigns` | Lists every campaign under your DialFire tenant and uploads `campaigns.discovered.json` as a workflow artifact. Use it to refresh the `DIALFIRE_CAMPAIGNS` secret without manually exporting from DialFire. |

Click **Actions → workflow name → Run workflow** in GitHub to fire either.

## Required GitHub secrets

| Secret | Where to get it |
|--------|-----------------|
| `DIALFIRE_HUBSPOT_BEARER` | Open the connector page → DevTools console → run `angular.element(document.querySelector('iframe')).scope().$root.$$childHead.token` (or similar — the exact path is whatever you used before). Copy the value. |
| `DIALFIRE_TENANT_ID` | Same Angular scope, look for `tenantId`. Or from the URL: `…/tenants/{this part}/…` |
| `DIALFIRE_CONNECTION_ID` | Same scope as the binding loop you ran — `connectionId`. Or from the URL. |
| `DIALFIRE_TENANT_TOKEN` (optional) | If you have a tenant-scoped API token, set it here. Otherwise `DIALFIRE_HUBSPOT_BEARER` will be used as a fallback for the discover script. |

To set/rotate:
```
gh secret set DIALFIRE_HUBSPOT_BEARER --body "ey…"
gh secret set DIALFIRE_TENANT_ID --body "<uuid>"
gh secret set DIALFIRE_CONNECTION_ID --body "<uuid>"
```

## Token lifetime caveat

If the Bearer is a session JWT (typically ~8h), the workflow will start
returning `401` after expiry. Re-grab from the browser and update the
secret. If it turns out to be a long-lived API key, you can stop
worrying about that.

The first time you run the refresh workflow:

1. Use `dry_run = true` to confirm the filter picks the bindings you expect.
2. If the count matches, run again with `dry_run = false`.
3. The output prints `i/N campaign-title -> status` for each binding;
   `409` and `503` are auto-retried once.

## Filter syntax

The `filter_suffix` input is a list of allowed campaign-title suffixes,
**separated by two spaces**. Defaults to `" - NA  - CM"` (matching the
113 bindings the user previously refreshed). Empty filter = refresh
every binding.

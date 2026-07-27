"""Regenerate data/clienthub_owners.json — the owner_id -> team-name map that
fetch_clienthub_teams.py uses to attribute ClientHub calls to a team.

In this HubSpot portal each calling team is a dedicated OWNER account whose
display name is (almost always) the team name doubled — "Warriors Warriors",
"Power Rangers Power Rangers", "Killer_Whales Killer_Whales". A few teams use a
single (multi-word) name — "City Sunsets", "GOAL diggers". Real people
("Marthinus Botha") are owners too but are NOT teams and must be excluded.

The old map was hand-built once and never refreshed, so as teams were added or
renamed in HubSpot it rotted: whole teams went missing and their calls surfaced
in the weekly email as "Unmapped owner <id>". This script rebuilds the map from
the live HubSpot owners API so that can't happen again.

An owner is treated as a TEAM (and mapped) when it is ACTIVE and either:
  (a) its name is a doubled pattern  "X X"  -> team "X", or
  (b) its name canonically matches a known LN team from the roster.
Everything else (individual agents, blank/junk owners) is skipped.

When a mapped team canonically matches an LN-team display name we store that
tidy display name (so "GOAL diggers" -> "Goal Diggers"); otherwise we keep the
name exactly as HubSpot has it (so "TNT", "Killer_Whales" survive verbatim).

Auth (same quay1 token the VA back-fill uses):
  env HUBSPOT_TOKEN, else macOS Keychain service=hubspot-api account=quay1.

Resilience: if the token is absent or the fetch fails / returns implausibly few
teams, the existing data/clienthub_owners.json is LEFT UNTOUCHED and the script
exits 0 — the daily pipeline keeps running on the last-good map (mirrors
fetch_clienthub_teams.py's preserve-on-failure guard).

Usage:
  python scripts/refresh_clienthub_owners.py            # rewrite the map
  python scripts/refresh_clienthub_owners.py --dry-run  # print the diff, write nothing
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "clienthub_owners.json"

HUBSPOT_OWNERS_URL = "https://api.hubapi.com/crm/v3/owners"
SUPABASE_URL = "https://dqszbqiimbfvmmnpgpsb.supabase.co"

# Below this many mapped teams we assume the fetch was partial and refuse to
# overwrite the existing map. The portal has ~70 active team owners.
MIN_TEAMS = 40

# Static LN-team roster — used to prettify display names and to recognise the
# handful of teams whose owner name is a single (non-doubled) string. Mirrors
# LN_TEAMS_FALLBACK in market-analysis-reports/src/weekly_team_report_email.py.
# A live pull from public.ln_teams is preferred (see load_roster); this is the
# fallback so the refresh never blocks on a Supabase blip.
ROSTER_FALLBACK = [
    "ASB Calling", "Amigos", "Assassins", "Avengers", "Babes", "Ballers",
    "Bergscape", "Betties", "Blitz", "Boets", "Bulls", "Cavaliers",
    "Chargers", "City Sunsets", "Clienthub", "Conquerors", "Dealers",
    "Dealmakers", "Dixies", "Dolphins", "Donkeys", "Dragons", "Dutchmen",
    "Engine Room", "Falcons", "Farmers", "Furys", "Gladiators",
    "Goal Diggers", "Gunslingers", "Hawks", "Headbangers", "Hoekers",
    "Hooligans", "Hout Baes", "Huntsmen", "Hustlers", "Invincibles",
    "Jaguars", "Knights", "Koeksisters", "Komorants", "Lions", "Llamas",
    "Musketeers", "Panthers", "Pirates", "Power Rangers", "Prom Queens",
    "Proteas", "Raccoons", "Rentals", "Rockets", "Samurais", "Slayers",
    "Soccer Moms", "Spartans", "Surfers", "Swesties", "Targaryens",
    "Tigers", "TNT", "Tornadoes", "Vikings", "Vipers", "Warriors",
    "Weasels", "Wizards", "Wolves", "Wombats",
]


def canon(name: str) -> str:
    """Mirror app.js Q.teamCanonical / the emailer's team_canonical."""
    return re.sub(r"[^A-Z0-9]", "", (name or "").upper())


def _canon_flex(s: str) -> set[str]:
    """A canonical key plus its trailing-S variants, so 'Soccer Mom' and
    'Soccer Moms' collapse together."""
    c = canon(s)
    out = {c}
    if c.endswith("S"):
        out.add(c[:-1])
    else:
        out.add(c + "S")
    return out


def hubspot_token() -> str:
    tok = (os.environ.get("HUBSPOT_TOKEN") or "").strip()
    if tok:
        return tok
    try:
        return subprocess.check_output(
            ["security", "find-generic-password", "-s", "hubspot-api", "-a", "quay1", "-w"],
            text=True, stderr=subprocess.DEVNULL,
        ).strip()
    except Exception:
        return ""


def fetch_owners(token: str) -> list[dict]:
    """All owners (active + archived) via the HubSpot v3 owners API, paginated."""
    owners: list[dict] = []
    after = None
    while True:
        qs = "?limit=100"
        if after:
            qs += f"&after={after}"
        req = urllib.request.Request(
            HUBSPOT_OWNERS_URL + qs,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode())
        owners.extend(data.get("results") or [])
        after = (((data.get("paging") or {}).get("next") or {}).get("after"))
        if not after:
            break
    return owners


def load_owners_file(path: Path) -> list[dict]:
    """Load a pre-fetched owners dump. Accepts either the HubSpot v3 shape
    ({id, firstName, lastName, archived}) or the flat MCP shape
    ({ownerId, name, isActive}); normalises both to the v3 shape."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    rows = raw.get("results") if isinstance(raw, dict) else raw
    out = []
    for o in rows or []:
        if "ownerId" in o or "isActive" in o:
            name = (o.get("name") or "").strip()
            first, _, last = name.partition(" ")
            out.append({"id": str(o.get("ownerId") or o.get("id") or ""),
                        "firstName": first, "lastName": last,
                        "archived": (o.get("isActive") is False)})
        else:
            out.append(o)
    return out


def _owner_name(o: dict) -> str:
    first = (o.get("firstName") or "").strip()
    last = (o.get("lastName") or "").strip()
    name = (first + " " + last).strip()
    return re.sub(r"\s+", " ", name)


def load_roster() -> list[str]:
    """Live public.ln_teams display names via the Supabase Management API; falls
    back to ROSTER_FALLBACK on any error. Only used for display prettification
    and to recognise single-word (non-doubled) team owners."""
    token = (os.environ.get("SUPABASE_ACCESS_TOKEN") or "").strip()
    if not token:
        try:
            token = subprocess.check_output(
                ["security", "find-generic-password", "-s", "supabase-access-token",
                 "-a", "pagan@quay1.co.za", "-w"],
                text=True, stderr=subprocess.DEVNULL,
            ).strip()
        except Exception:
            token = ""
    if token:
        try:
            ref = SUPABASE_URL.split("//", 1)[1].split(".", 1)[0]
            req = urllib.request.Request(
                f"https://api.supabase.com/v1/projects/{ref}/database/query",
                data=json.dumps({
                    "query": "select name from public.ln_teams where active = true order by display_order"
                }).encode(),
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) supabase-cli",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=30) as r:
                rows = json.loads(r.read().decode()) or []
            names = [row["name"] for row in rows if row.get("name")]
            if len(names) >= 20:
                return names
        except Exception as exc:
            print(f"  · ln_teams live fetch failed, using static roster: {exc}")
    return list(ROSTER_FALLBACK)


def team_for_owner(name: str, roster_by_canon: dict[str, str]) -> str | None:
    """Return the team display name for an owner, or None if it isn't a team."""
    parts = name.split()
    doubled_team: str | None = None
    if len(parts) >= 2 and len(parts) % 2 == 0:
        half = len(parts) // 2
        a, b = " ".join(parts[:half]), " ".join(parts[half:])
        if _canon_flex(a) & _canon_flex(b):
            doubled_team = a  # keep first half verbatim (preserves TNT, Killer_Whales)

    candidate = doubled_team if doubled_team is not None else name

    # Prefer a tidy roster display name when the candidate matches one.
    for key in _canon_flex(candidate):
        if key in roster_by_canon:
            return roster_by_canon[key]

    # Doubled pattern is a strong signal even if the team isn't in the roster
    # yet (e.g. a brand-new team like "Retrievers Retrievers").
    if doubled_team is not None:
        return doubled_team

    return None


def build_map(owners: list[dict], roster: list[str]) -> tuple[dict[str, str], list[str]]:
    roster_by_canon: dict[str, str] = {}
    for t in roster:
        roster_by_canon[canon(t)] = t
    mapping: dict[str, str] = {}
    skipped_active_people: list[str] = []
    for o in owners:
        if not o.get("id"):
            continue
        # NB: we deliberately map archived team owners too — a team account can
        # be archived in HubSpot while its contacts are still live and getting
        # dialled, and dropping it would resurface the "Unmapped owner <id>" bug.
        name = _owner_name(o)
        if not name or name in (".", "-"):
            continue
        team = team_for_owner(name, roster_by_canon)
        if team:
            mapping[str(o["id"])] = team
        elif len(name.split()) >= 2:
            skipped_active_people.append(name)
    return mapping, skipped_active_people


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="Print the diff, write nothing.")
    ap.add_argument("--owners-file", help="Read owners from a JSON dump instead of the "
                    "HubSpot API (for envs whose token lacks the owners scope).")
    args = ap.parse_args()

    old = {}
    if OUT.exists():
        try:
            old = json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            old = {}

    if args.owners_file:
        try:
            owners = load_owners_file(Path(args.owners_file))
        except Exception as e:
            print(f"[refresh_clienthub_owners] could not read --owners-file: {e} — "
                  "leaving existing map untouched.")
            return 0
    else:
        token = hubspot_token()
        if not token:
            print("[refresh_clienthub_owners] no HUBSPOT_TOKEN / keychain token — "
                  "leaving existing map untouched.")
            return 0
        try:
            owners = fetch_owners(token)
        except urllib.error.HTTPError as e:
            print(f"[refresh_clienthub_owners] HubSpot HTTP {e.code}: {e.read().decode()[:300]} — "
                  "leaving existing map untouched.")
            return 0
        except Exception as e:
            print(f"[refresh_clienthub_owners] owner fetch failed: {e} — leaving existing map untouched.")
            return 0

    roster = load_roster()
    mapping, skipped = build_map(owners, roster)

    if len(mapping) < MIN_TEAMS:
        print(f"[refresh_clienthub_owners] only {len(mapping)} teams resolved "
              f"(< {MIN_TEAMS}) — looks partial, leaving existing map untouched.")
        return 0

    # Diff vs the previous map for a human-readable summary.
    added = {k: v for k, v in mapping.items() if k not in old}
    removed = {k: v for k, v in old.items() if k not in mapping}
    renamed = {k: (old[k], mapping[k]) for k in mapping
               if k in old and old[k] != mapping[k]}
    print(f"[refresh_clienthub_owners] {len(owners)} owners scanned → "
          f"{len(mapping)} team owners mapped "
          f"(+{len(added)} new, -{len(removed)} gone, ~{len(renamed)} renamed).")
    for oid, team in sorted(added.items(), key=lambda kv: kv[1]):
        print(f"    + {team:<20} ({oid})")
    for oid, team in sorted(removed.items(), key=lambda kv: kv[1]):
        print(f"    - {team:<20} ({oid})")
    for oid, (o_, n_) in sorted(renamed.items(), key=lambda kv: kv[1][1]):
        print(f"    ~ {o_}  ->  {n_}  ({oid})")

    if args.dry_run:
        print("[refresh_clienthub_owners] --dry-run: nothing written.")
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(mapping, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"[refresh_clienthub_owners] wrote {OUT.relative_to(ROOT)} ({len(mapping)} owners).")
    return 0


if __name__ == "__main__":
    sys.exit(main())

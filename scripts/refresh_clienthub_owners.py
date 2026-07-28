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

There are TWO kinds of mapped owner:

  1. TEAM ACCOUNTS — the dedicated doubled-name owner accounts. An owner is a
     team account when either (a) its name is a doubled pattern "X X" -> team
     "X", or (b) its name canonically matches a known LN team from the roster.

  2. INDIVIDUAL AGENTS — real people who belong to a HubSpot Team. A contact
     owned by an agent still belongs to that agent's team, so the agent's
     owner_id is mapped to their team's display name too. Membership comes from
     the HubSpot Settings Teams API (userIds / secondaryUserIds, cross-referenced
     to owners by userId) with the inline owner.teams field as a fallback. This
     is what makes "team-owned contacts" attribute to the team even when the
     contact is owned by a person rather than the team account.

Only owners that are neither a team account nor a member of any team are skipped
(blank/junk owners, plus people not assigned to a calling team).

When a mapped team canonically matches an LN-team display name we store that
tidy display name (so "GOAL diggers" -> "Goal Diggers"); otherwise we keep the
name exactly as HubSpot has it (so "TNT", "Killer_Whales" survive verbatim).
Agents always inherit the exact display string their team account uses, so both
merge into one row in fetch_clienthub_teams.py.

Auth (the "Quay 1 API 2" private-app token, which carries both
crm.objects.owners.read and settings.users.teams.read):
  env HUBSPOT_TOKEN, else macOS Keychain service=hubspot-api account=quay1.
If the token lacks settings.users.teams.read the teams fetch just no-ops and the
map degrades to team accounts only (still correct, just no agent roll-up).

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
HUBSPOT_TEAMS_URL = "https://api.hubapi.com/settings/v3/users/teams"
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


def fetch_teams(token: str) -> list[dict]:
    """All HubSpot user teams via the Settings API. Each row carries the team
    name and its member user ids: {id, name, userIds, secondaryUserIds}.

    Needs settings.users.teams.read. Returns [] on any failure (missing scope,
    HTTP error, timeout) so agent-to-team mapping simply degrades to the
    team-account map — the pipeline never breaks on this."""
    try:
        req = urllib.request.Request(
            HUBSPOT_TEAMS_URL,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode())
        return data.get("results") or []
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:150]
        print(f"  · teams fetch HTTP {e.code} ({body}) — agent-to-team roll-up skipped.")
        return []
    except Exception as e:
        print(f"  · teams fetch failed ({e}) — agent-to-team roll-up skipped.")
        return []


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


def build_map(owners: list[dict], roster: list[str],
              teams: list[dict]) -> tuple[dict[str, str], dict[str, int]]:
    """owner_id -> team display, for team accounts AND individual agents.

    Team accounts are mapped first and are never overwritten. Agents are then
    mapped to their HubSpot team (Settings Teams API primary members, then
    secondary, then the inline owner.teams field) so team-owned contacts owned by
    a person still roll up to the team."""
    roster_by_canon: dict[str, str] = {canon(t): t for t in roster}
    # canon(team) -> exact display string, so agents inherit the SAME string
    # their team account uses and the two merge downstream.
    canon_to_display: dict[str, str] = dict(roster_by_canon)

    mapping: dict[str, str] = {}
    team_account_ids: set[str] = set()

    # Pass 1 — team-account owners (doubled-name / roster match). NB: we
    # deliberately map archived team owners too — a team account can be archived
    # in HubSpot while its contacts are still live and getting dialled, and
    # dropping it would resurface the "Unmapped owner <id>" bug.
    for o in owners:
        if not o.get("id"):
            continue
        name = _owner_name(o)
        if not name or name in (".", "-"):
            continue
        team = team_for_owner(name, roster_by_canon)
        if team:
            oid = str(o["id"])
            mapping[oid] = team
            team_account_ids.add(oid)
            canon_to_display.setdefault(canon(team), team)

    # Index owners by HubSpot userId (preferring the active record) so team
    # membership — which references user ids — can resolve to an owner id.
    owner_by_userid: dict[str, dict] = {}
    for o in owners:
        uid = o.get("userId") or o.get("userIdIncludingInactive")
        if not uid:
            continue
        uid = str(uid)
        prev = owner_by_userid.get(uid)
        if prev is None or (o.get("archived") is False and prev.get("archived")):
            owner_by_userid[uid] = o

    def display_for_team_name(tname: str | None) -> str | None:
        tname = re.sub(r"\s+", " ", (tname or "").strip())
        if not tname:
            return None
        disp = canon_to_display.get(canon(tname))
        if disp is None:                      # a team with no account/roster match
            disp = tname                      # keep its HubSpot name verbatim,
            canon_to_display[canon(tname)] = disp  # so its agents still group as one
        return disp

    agents_mapped = 0

    # Pass 2a — Settings Teams API. Primary members (userIds) win over secondary
    # so a person on multiple teams lands on their primary team.
    for member_key in ("userIds", "secondaryUserIds"):
        for t in teams:
            disp = display_for_team_name(t.get("name"))
            if not disp:
                continue
            for uid in (t.get(member_key) or []):
                o = owner_by_userid.get(str(uid))
                if not o:
                    continue
                oid = str(o.get("id") or "")
                if not oid or oid in mapping:
                    continue
                mapping[oid] = disp
                agents_mapped += 1

    # Pass 2b — inline owner.teams fallback for any person still unmapped (covers
    # portals/tokens where the Settings Teams API returned nothing).
    for o in owners:
        oid = str(o.get("id") or "")
        if not oid or oid in mapping:
            continue
        ots = o.get("teams") or []
        if not ots:
            continue
        primary = next((x for x in ots if x.get("primary")), ots[0])
        disp = display_for_team_name(primary.get("name"))
        if disp:
            mapping[oid] = disp
            agents_mapped += 1

    stats = {
        "team_accounts": len(team_account_ids),
        "agents_mapped": agents_mapped,
        "teams_total": len(set(mapping.values())),
    }
    return mapping, stats


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

    teams: list[dict] = []
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
        teams = fetch_teams(token)

    roster = load_roster()
    mapping, stats = build_map(owners, roster, teams)

    # The guard tracks TEAM ACCOUNTS only — a partial owners fetch is what we're
    # protecting against; agent counts vary and shouldn't gate the write.
    if stats["team_accounts"] < MIN_TEAMS:
        print(f"[refresh_clienthub_owners] only {stats['team_accounts']} team accounts "
              f"resolved (< {MIN_TEAMS}) — looks partial, leaving existing map untouched.")
        return 0

    # Diff vs the previous map. Owner-id churn is dominated by agents, so the
    # headline compares the set of TEAM NAMES; agent count is reported separately.
    old_teams, new_teams = set(old.values()), set(mapping.values())
    gained = sorted(new_teams - old_teams)
    lost = sorted(old_teams - new_teams)
    print(f"[refresh_clienthub_owners] {len(owners)} owners, {len(teams)} HubSpot teams → "
          f"{stats['team_accounts']} team accounts + {stats['agents_mapped']} agents "
          f"across {stats['teams_total']} teams (map size {len(mapping)}, was {len(old)}).")
    if gained:
        print(f"    + teams: {', '.join(gained)}")
    if lost:
        print(f"    - teams: {', '.join(lost)}")

    if args.dry_run:
        print("[refresh_clienthub_owners] --dry-run: nothing written.")
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(mapping, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"[refresh_clienthub_owners] wrote {OUT.relative_to(ROOT)} ({len(mapping)} owners).")
    return 0


if __name__ == "__main__":
    sys.exit(main())

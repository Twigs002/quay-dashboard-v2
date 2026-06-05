# Quay 1 Performance Dashboard — Component & Metric Reference

Live at https://twigs002.github.io/quay-dashboard-v2/

---

## Architecture (where things live)

```
index.html                 ← shell + script load order
quay/
  config.js                ← targets, benchmarks, revenue rates, red-flag thresholds
  data.js                  ← REAL-DATA ADAPTER: fetches the JSON below, normalises,
                             exposes window.QUAY (agentsFor, totalsFor, campaignsFor,
                             agentHistory, agentCampaigns, project, trailingAvg…)
  lib.js                   ← icons + chart helpers (weeklyTrend, donut, spark, miniBars)
  views.js                 ← tab views (All Staff, Compare, Work Time, Daily,
                             Manager, Lead Sources)
  app.js                   ← shell, sidebar nav, period state, router,
                             Leadership + Operational Overview tabs, modal,
                             sorting, CSV export, print stamp
  styles.css               ← design system + print stylesheet
  quay1-logo*.png          ← brand
data/
  weekly_data.json         ← current Dialfire snapshot (auto-updated)
  history.json             ← 27 weekly snapshots (auto-updated)
scripts/
  fetch_dialfire.py        ← weekly fetcher  → weekly_data.json + history.json
  fetch_dialfire_daily.py  ← daily fetcher   → daily_data.json
  backfill_dialfire.py     ← historical backfill (one-off, by date range)
  dialfire_common.py       ← shared parsing, lead-status mapping, benchmarks
.github/workflows/
  update-data.yml          ← cron 02:27 SAST Mon-Fri → fetch_dialfire.py
  update-daily.yml         ← cron 06:00 SAST daily   → fetch_dialfire_daily.py
  backfill.yml             ← manual dispatch only
```

---

## The 8 tabs

### 1. Leadership Overview *(default landing — directors)*
Strategic snapshot. The view you open if you only have 30 seconds.

- **4 hero KPIs** with sparklines and WoW deltas:
  - **Total Calls** — sum of all agents' calls in the period
  - **Success Rate** — weighted-by-calls average of every agent's `successRate`
  - **Team Efficiency** — average of `Dialler ÷ ConnectTeams` across agents (currently estimated; see *Caveats*)
  - **Est. Revenue** — `Σ(leads × per-lead rand value from config.js)`
- **RM vs Fancy** team cards — side-by-side agent count, calls, leads, success rate vs the team's target (17% RM / 20% Fancy)
- **Progress to target bars** — actual vs `weekly_calls/leads` or `monthly_calls/leads` from `config.js`, with a diagonally-hatched **pace projection** overlay and a footnote like *"3/5 working days elapsed — At pace: 6,200 (88%)"*
- **12-week trend chart** — calls bars + success-rate line
- **Top campaigns by share** — % of total calls per campaign
- **Top 5 performers** — ranked by composite `success × calls`
- **Red flags** — auto-detected: WoW drops, team target gaps, agents below the 100-call floor
- **Historical comparison cards** — calls/leads vs 4-week and 12-week trailing averages

### 2. Operational Overview *(team / floor view)*
Original detailed overview kept from the redesign.

- 4 KPI cards (Calls / Success / Leads / Active callers)
- Weekly Performance Trend (12 weeks)
- Lead Sources donut (top 5 campaigns by call volume + "Other")
- 3 spotlight cards (Top Performer, Best Converting Source, At Risk)
- Top 10 Performers leaderboard
- Insights panel
- Monthly historical mini-charts (Calls / Leads / Emails / Rentals / DialFire hrs)

### 3. All Staff Report
Drill into agent-level performance.

Two views toggle in the top-right segment:
- **Overall Report** — sortable table (click any column header to sort, again to flip direction; rank auto-renumbers). Columns: Calls, Leads, Success, Connect, Volume. Click a row → drill-down modal.
- **Per Caller** — card grid, one per agent. Each card shows: Calls · Leads · CPH · Dialler hrs · **Work %** · **Talk %** + Seller/Rental/Email lead split + campaign chips.

### 4. Compare
Period A vs Period B side-by-side, with variance metrics. (Static placeholder data right now — wiring to real two-period comparison is a future task.)

### 5. Work Time
DialFire dialler time vs ConnectTeams clocked time. Shows per-agent efficiency vs a 70% target line. Includes a CSV upload zone for ConnectTeams exports.

### 6. Daily Stats
Per-caller performance for a single day. Currently approximates by dividing the week's totals by 5 (placeholder until per-day Dialfire feed is wired).

### 7. Manager Reports
Date-range + campaign filter for a campaign-level breakdown.

### 8. Lead Sources *(now actually: Campaigns)*
Per-campaign rollups from Dialfire. **Variants are normalised** — `SURFERS_NA`, `SURFERS_CM`, `SURFERS` show as one *SURFERS* row; `Clienthub Master` collapses to `Clienthub`.

Columns: Campaign · Agents · Calls · Leads · Seller · Rental · Email · Conv. · Volume bar.

Attribution mode is displayed in the side card:
- **Green "Exact attribution"** — week's data carries the `by_agent_campaign` field (Dialfire fetcher v2026-06-05+)
- **Orange caveat** — historical week pre-dating the fetcher upgrade; per-campaign rows over-count when agents are on multiple campaigns

---

## Metric glossary

| Metric | Definition |
|--------|------------|
| **Calls** | Distinct Dialfire-completed call attempts |
| **Leads (Success)** | Calls that resulted in a `LEAD` / `RENTAL_LEAD` / `GOT_EMAIL` status |
| **Seller / Rental / Email** | Per-type breakdown of leads (`LEAD` / `RENTAL_LEAD` / `GOT_EMAIL`) |
| **Success Rate** | `leads / calls × 100` |
| **CPH** | Calls per hour of dialler time |
| **Dialler hrs (df)** | `workTime` from Dialfire — time agent was actively dialling |
| **Talk hrs** | `connectTimeDialer` from Dialfire — time agent was on a call |
| **Talk %** | `talk / dialler × 100` — how much dialler time was actually spent talking |
| **Wrap-up %** | `wrapTime / dialler × 100` — post-call disposition time |
| **Wait %** | `waitTimeDialer / dialler × 100` — time between calls within a dialler session |
| **Pause hrs** | Time agent paused the dialler (manual break) |
| **Work %** | `dialler / (dialler + pause) × 100` — % of clocked session actively dialling vs paused |
| **Efficiency** | `dialler / clocked × 100` — % of total clocked-in time spent dialling. ConnectTeams = clocked. **Currently estimated** as `dialler / 0.85` until real ConnectTeams data is wired |
| **Connect %** | Currently aliased to Talk %. Will become true connect rate (answered / dialled) when Dialfire ships that field |
| **Meets target** | `cph ≥ 45 AND successRate ≥ team_target` — flag computed by the fetcher |
| **Per-lead value** | Rand value assumption per lead (per type — seller/rental/email). Edit `config.js → REVENUE_PER_LEAD` |

---

## Period selector

| Period | Meaning |
|--------|---------|
| **This Week** | Current week's `weekly_data.json` (Mon–Sun) |
| **Last Week** | `history[1]` |
| **This Month** | Aggregate of the last 4 weeks |
| **Last 90 Days** | Aggregate of the last 13 weeks |
| **All Time** | Aggregate of every week in `history.json` |

Switching the period recalculates everything live — KPIs, tables, charts, comparisons.

---

## Config (`quay/config.js`)

One file to edit when targets, benchmarks, or revenue assumptions change:

```js
REVENUE_PER_LEAD: { seller, rental, email, default }   // R per lead by type
BENCHMARKS:       { cph, rm_success_rate, fc_success_rate, efficiency }
FLOOR_TARGETS:    { weekly_calls, weekly_leads, monthly_calls, monthly_leads }
RED_FLAGS:        { calls_drop_pct, success_below_pct, inactive_call_floor }
TEAM_LABELS:      { RM, Fancy }
```

---

## Top-bar toolbar

- **Print** — opens browser print dialog; CSS strips sidebar/topbar/modals and prints a brand-bar header (tab title · period · date)
- **Export CSV** — downloads the current tab's data as CSV (UTF-8 BOM for Excel). Filename: `quay-{tab}-{period-slug}-{YYYY-MM-DD}.csv`

---

## Agent drill-down modal

Click any agent row (Top 10, Top 5, All Staff table, Per Caller card) to open. Shows:

- Hero stats (Calls / Leads / Dialler hrs / CPH)
- **12-week weekly trend** chart for that specific agent
- **Time breakdown** bars: Talk %, Wrap-up %, Wait %, **Work %** (new — work vs paused)
- Lead breakdown (Seller / Rental / Email)
- **Per-campaign breakdown table** with exact attribution when the week's data has `by_agent_campaign`
- Assigned-campaign chip strip

Close with Esc, click outside, or ✕ button.

---

## Caveats / pending work

1. **ConnectTeams data is not yet integrated.** The Work Time tab + Team Efficiency KPI use `dialler / 0.85` as an estimated clocked-in time. Real integration requires either: (a) Connecteam upgrade to API-enabled plan, or (b) the headless-scrape path we explored.
2. **Lead Sources placeholder data on Operational Overview's donut** — Property24 / Facebook / Gumtree are no longer used; the donut auto-derives top 5 campaigns from real data on each render, but the original "lead source" concept is being replaced by campaigns.
3. **Per-campaign exact attribution** kicks in on the next fetcher run (the `by_agent_campaign` field). Historical weeks show the overlap caveat until `backfill.yml` is re-run.
4. **Compare tab** uses static placeholder data — needs a future task to wire Period A / Period B selectors to real periods.
5. **Daily Stats** divides weekly totals by 5 as a placeholder — wiring `daily_data.json` end-to-end is pending.
6. **Dialfire secrets** must be configured on this repo's GitHub Actions secrets (`DIALFIRE_CAMPAIGNS` JSON list recommended) for the auto-fetcher to actually fetch — without it, scheduled runs print *"no campaigns configured"* and the data stays frozen.

---

*Last updated: 2026-06-05*

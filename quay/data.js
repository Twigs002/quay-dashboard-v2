/* Quay 1 — Performance Dashboard · REAL DATA ADAPTER
   Loads /data/weekly_data.json + /data/history.json (Dialfire-fed by the
   GitHub Action) and builds the shape app.js + views.js expect.

   Lead Sources: no real data feed yet — kept as placeholders.
   Connecteam (clocked time): not wired yet — `ct` is estimated as df/0.85 so
   the Work Time tab still renders meaningfully. We'll swap for real values
   once the Connecteam integration lands. */

window.QUAY_READY = (async function () {
  const [weekly, history] = await Promise.all([
    fetch('data/weekly_data.json').then(r => r.json()),
    fetch('data/history.json').then(r => r.json()),
  ]);

  // history may or may not include the current week; ensure latest first.
  const weeks = history.slice().sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  // If the live weekly_data isn't the same week as history[0], unshift it.
  if (!weeks.length || weeks[0].week !== weekly.week) weeks.unshift(weekly);

  // ---- Normalize agent names ('WarrickSolomons' → 'Warrick Solomons') ----
  const prettifyName = raw => (raw || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim();

  // ---- Build per-week agent list ----
  function agentsForWeek(w) {
    const out = [];
    (w.rm || []).forEach((a, i) =>
      out.push(_normAgent(a, 'RM', i)));
    (w.fancy || []).forEach((a, i) =>
      out.push(_normAgent(a, 'Fancy', i + 100)));
    return out;
  }

  function _normAgent(a, team, idx) {
    const calls = a.calls || 0;
    const leads = a.success || 0;            // real "success" = leads converted
    const successRate = a.successRate || (calls ? (leads / calls) * 100 : 0);
    const talkHrs = a.talkTime || 0;
    const workHrs = a.workTime || 0;
    const ctHrs = workHrs > 0 ? workHrs / 0.85 : 0;   // estimated clocked-in
    const eff = ctHrs > 0 ? Math.round((workHrs / ctHrs) * 100) : 85;
    // 'connect' rate proxied from talkPct (real field); fallback 50.
    const connect = a.talkPct ? Math.round(a.talkPct) : 50;
    return {
      id: 'a' + String(idx + 1).padStart(2, '0'),
      name: prettifyName(a.name),
      team,
      calls,
      leads,
      talkMin: Math.round(talkHrs * 60),
      df: +workHrs.toFixed(1),
      ct: +ctHrs.toFixed(1),
      success: +successRate.toFixed(1),
      eff,
      connect,
      seller: a.seller || 0,
      rental: a.rental || 0,
      email: a.email || 0,
      cph: a.cph || 0,
      campaigns: Array.isArray(a.campaigns) ? a.campaigns.slice() : [],
      meetsTarget: !!a.meetsTarget,
      _raw: a,
    };
  }

  // ---- Aggregate multiple weeks into one virtual agent list ----
  function aggregateWeeks(weekList) {
    const byName = new Map();
    weekList.forEach(w => {
      agentsForWeek(w).forEach(a => {
        const key = a.name + '|' + a.team;
        const prev = byName.get(key);
        if (!prev) {
          byName.set(key, { ...a, campaigns: a.campaigns.slice() });
        } else {
          prev.calls += a.calls;
          prev.leads += a.leads;
          prev.talkMin += a.talkMin;
          prev.df = +(prev.df + a.df).toFixed(1);
          prev.ct = +(prev.ct + a.ct).toFixed(1);
          prev.seller += a.seller;
          prev.rental += a.rental;
          prev.email += a.email;
          // Merge campaigns set
          const seen = new Set(prev.campaigns);
          a.campaigns.forEach(c => { if (!seen.has(c)) prev.campaigns.push(c); });
        }
      });
    });
    // Re-derive success rate + cph from aggregated totals
    return [...byName.values()].map(a => ({
      ...a,
      success: a.calls ? +((a.leads / a.calls) * 100).toFixed(1) : 0,
      eff: a.ct ? Math.round((a.df / a.ct) * 100) : 85,
      cph: a.df ? +((a.calls / a.df).toFixed(1)) : 0,
    }));
  }

  // ---- Period selectors ----------------------------------------------------
  const PERIODS = {
    'this-week':  { label: 'This Week',    weeks: 1  },
    'last-week':  { label: 'Last Week',    weeks: 1, offset: 1 },
    'this-month': { label: 'This Month',   weeks: 4  },
    'last-90':    { label: 'Last 90 Days', weeks: 13 },
    'all-time':   { label: 'All Time',     weeks: weeks.length },
  };

  function _sliceFor(periodKey) {
    const p = PERIODS[periodKey] || PERIODS['this-week'];
    const start = p.offset || 0;
    return weeks.slice(start, start + p.weeks);
  }

  function agentsFor(periodKey) {
    const slice = _sliceFor(periodKey);
    return aggregateWeeks(slice).sort((a, b) => b.calls - a.calls);
  }

  function totalsFor(periodKey) {
    const list = agentsFor(periodKey);
    const calls = list.reduce((s, a) => s + a.calls, 0);
    const leads = list.reduce((s, a) => s + a.leads, 0);
    // weighted-by-calls success rate
    const avgSuccess = calls
      ? +((list.reduce((s, a) => s + a.success * a.calls, 0) / calls).toFixed(1))
      : 0;
    return { calls, leads, avgSuccess, active: list.length };
  }

  // ---- Period-over-period deltas (real, not hard-coded) -------------------
  function _periodTotals(weekSlice) {
    const list = aggregateWeeks(weekSlice);
    const calls = list.reduce((s, a) => s + a.calls, 0);
    const leads = list.reduce((s, a) => s + a.leads, 0);
    const avgSuccess = calls
      ? (list.reduce((s, a) => s + a.success * a.calls, 0) / calls)
      : 0;
    return { calls, leads, avgSuccess, active: list.length };
  }

  function _delta(periodKey) {
    const p = PERIODS[periodKey] || PERIODS['this-week'];
    const cur = _sliceFor(periodKey);
    const prev = weeks.slice((p.offset || 0) + p.weeks,
                             (p.offset || 0) + p.weeks * 2);
    if (!prev.length || !cur.length) {
      return { calls: 0, success: 0, leads: 0, active: 0 };
    }
    const a = _periodTotals(cur), b = _periodTotals(prev);
    const pct = (n, d) => d ? +(((n - d) / d) * 100).toFixed(1) : 0;
    return {
      calls:   pct(a.calls,   b.calls),
      leads:   pct(a.leads,   b.leads),
      success: +(a.avgSuccess - b.avgSuccess).toFixed(1),  // points, not pct
      active:  a.active - b.active,
    };
  }

  const DELTAS = {};
  Object.keys(PERIODS).forEach(k => { DELTAS[k] = _delta(k); });

  // ---- Trend series (weekly, monthly) -------------------------------------
  const trendWeeks = weeks.slice(0, 12).reverse();   // oldest → newest
  const WEEKS = trendWeeks.map(w => {
    // 'W' + ISO week number, derived from weekStart
    const d = new Date(w.weekStart + 'T00:00:00Z');
    const onejan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const wnum = Math.ceil(((d - onejan) / 86400000 + onejan.getUTCDay() + 1) / 7);
    return 'W' + wnum;
  });
  const WEEK_CALLS = trendWeeks.map(w => {
    const list = agentsForWeek(w);
    return list.reduce((s, a) => s + a.calls, 0);
  });
  const WEEK_SUCCESS = trendWeeks.map(w => {
    const t = _periodTotals([w]);
    return +t.avgSuccess.toFixed(1);
  });

  // ---- Monthly trend (last 8 months, grouped from weeks) -------------------
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function monthKey(weekStart) {
    const d = new Date(weekStart + 'T00:00:00Z');
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const buckets = new Map();
  weeks.forEach(w => {
    const k = monthKey(w.weekStart);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(w);
  });
  const orderedMonths = [...buckets.keys()].sort();
  const last8 = orderedMonths.slice(-8);
  const MONTHS = last8.map(k => MONTH_NAMES[parseInt(k.split('-')[1], 10) - 1]);
  const monthSeries = last8.map(k => {
    const ws = buckets.get(k);
    const list = aggregateWeeks(ws);
    const sum = (key, src = a => a[key]) => list.reduce((s, a) => s + (src(a) || 0), 0);
    const rentals = ws.reduce((s, w) => s
      + (w.rm || []).reduce((x, a) => x + (a.rental || 0), 0)
      + (w.fancy || []).reduce((x, a) => x + (a.rental || 0), 0), 0);
    const emails = ws.reduce((s, w) => s
      + (w.rm || []).reduce((x, a) => x + (a.email || 0), 0)
      + (w.fancy || []).reduce((x, a) => x + (a.email || 0), 0), 0);
    const dfHours = ws.reduce((s, w) => s
      + (w.rm || []).reduce((x, a) => x + (a.workTime || 0), 0)
      + (w.fancy || []).reduce((x, a) => x + (a.workTime || 0), 0), 0);
    return {
      calls: sum('calls'),
      leads: sum('leads'),
      emails,
      rentals,
      dfHours: Math.round(dfHours),
    };
  });
  const MONTH_CALLS   = monthSeries.map(m => m.calls);
  const MONTH_LEADS   = monthSeries.map(m => m.leads);
  const MONTH_EMAILS  = monthSeries.map(m => m.emails);
  const MONTH_RENTALS = monthSeries.map(m => m.rentals);
  const MONTH_DFHOURS = monthSeries.map(m => m.dfHours);

  // ---- Campaigns (per-campaign rollups from Dialfire data) ------------------
  // CAVEAT: an agent's stats appear under EVERY campaign they're on. Agents
  // working multiple campaigns will be double-counted across campaign rows.
  // (Dialfire's feed doesn't break per-agent calls down per-campaign.)
  const CAMP_PALETTE = ['#3D5BA6', '#FDC503', '#98C5ED', '#2E4582',
                        '#D20A03', '#4C6BB8', '#B98A02', '#9AA3AD',
                        '#2E6FB0', '#6E7C8E', '#5A4FCF', '#21847B'];

  // Group variants: SURFERS_NA + SURFERS_CM + SURFERS -> SURFERS.
  // Also collapses 'X Master' (e.g. 'Clienthub Master' -> 'Clienthub').
  function normalizeCampaignName(raw) {
    if (!raw) return raw;
    let n = String(raw).trim();
    n = n.replace(/_[A-Za-z0-9]{1,6}$/, '');        // strip _NA / _CM / _NEW / etc
    n = n.replace(/\s+Master$/i, '');               // 'Clienthub Master' -> 'Clienthub'
    n = n.trim();
    return n || raw;
  }

  function campaignsFor(periodKey) {
    const slice = _sliceFor(periodKey);
    const byCamp = new Map();

    // Per-week strategy: use exact per-agent-per-campaign breakdown
    // (`by_agent_campaign`) when it's present in the JSON — that's the
    // accurate path. Fall back to the legacy overlap-based aggregation for
    // older weeks that don't carry the breakdown yet.
    slice.forEach(week => {
      if (week.by_agent_campaign && typeof week.by_agent_campaign === 'object') {
        Object.entries(week.by_agent_campaign).forEach(([agentName, perCamp]) => {
          Object.entries(perCamp).forEach(([rawCamp, stats]) => {
            const camp = normalizeCampaignName(rawCamp);
            const cur = byCamp.get(camp) || {
              name: camp, calls: 0, leads: 0, seller: 0, rental: 0, email: 0,
              _agents: new Set(), _exact: true,
            };
            cur.calls  += stats.calls   || 0;
            cur.leads  += stats.success || 0;
            cur.seller += stats.seller  || 0;
            cur.rental += stats.rental  || 0;
            cur.email  += stats.email   || 0;
            cur._agents.add(agentName);
            byCamp.set(camp, cur);
          });
        });
        return;
      }

      // Legacy fallback (week pre-dates the by_agent_campaign field)
      ['rm', 'fancy'].forEach(team => {
        (week[team] || []).forEach(agent => {
          // Dedupe normalized names within a single agent so SURFERS_CM +
          // SURFERS_NA on the same agent doesn't double up the agent's totals.
          const agentCampaigns = new Set(
            (agent.campaigns || []).map(normalizeCampaignName));
          agentCampaigns.forEach(camp => {
            const cur = byCamp.get(camp) || {
              name: camp, calls: 0, leads: 0, seller: 0, rental: 0, email: 0,
              _agents: new Set(), _exact: false,
            };
            cur.calls  += agent.calls   || 0;
            cur.leads  += agent.success || 0;
            cur.seller += agent.seller  || 0;
            cur.rental += agent.rental  || 0;
            cur.email  += agent.email   || 0;
            cur._agents.add(agent.name);
            byCamp.set(camp, cur);
          });
        });
      });
    });
    const list = [...byCamp.values()].map(c => ({
      name: c.name,
      calls: c.calls, leads: c.leads,
      seller: c.seller, rental: c.rental, email: c.email,
      agentsCount: c._agents.size,
      conv: c.calls ? +((c.leads / c.calls) * 100).toFixed(1) : 0,
      exact: !!c._exact,
    })).sort((a, b) => b.calls - a.calls);
    list.forEach((c, i) => { c.color = CAMP_PALETTE[i % CAMP_PALETTE.length]; });
    return list;
  }

  // SOURCES on the Overview donut: top 5 campaigns this period + "Other".
  function _topSourcesFor(periodKey) {
    const all = campaignsFor(periodKey);
    if (all.length <= 6) return all;
    const top = all.slice(0, 5);
    const rest = all.slice(5);
    const other = {
      name: 'Other campaigns',
      calls: rest.reduce((s, c) => s + c.calls, 0),
      leads: rest.reduce((s, c) => s + c.leads, 0),
      seller: rest.reduce((s, c) => s + c.seller, 0),
      rental: rest.reduce((s, c) => s + c.rental, 0),
      email: rest.reduce((s, c) => s + c.email, 0),
      agentsCount: 0,
      color: '#9AA3AD',
    };
    other.conv = other.calls ? +((other.leads / other.calls) * 100).toFixed(1) : 0;
    return [...top, other];
  }
  const SOURCES = _topSourcesFor('this-week');

  // ---- Expose ---------------------------------------------------------------
  window.QUAY = {
    AGENTS: agentsForWeek(weeks[0]),  // current week, sorted natural
    WEEKS, WEEK_CALLS, WEEK_SUCCESS,
    SOURCES, campaignsFor,
    MONTHS, MONTH_CALLS, MONTH_LEADS, MONTH_EMAILS, MONTH_RENTALS, MONTH_DFHOURS,
    PERIODS, DELTAS, agentsFor, totalsFor,
  };
  return window.QUAY;
})();

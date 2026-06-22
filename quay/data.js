/* Quay 1 — Performance Dashboard · REAL DATA ADAPTER
   Loads /data/weekly_data.json + /data/history.json (Dialfire-fed by the
   GitHub Action) and builds the shape app.js + views.js expect.

   Lead Sources: no real data feed yet — kept as placeholders.
   Clocked time (Dialler / Clocked columns on All Staff): real values come
   from data/clock_data.json when the quay-clock fetcher has run (see
   scripts/fetch_clock.py). When no real entry exists for an agent, we
   fall back to the historical `workTime / 0.85` estimate. */

window.QUAY_READY = (async function () {
  const [weekly, history, clockData, dailyData] = await Promise.all([
    fetch('data/weekly_data.json').then(r => r.json()),
    fetch('data/history.json').then(r => r.json()),
    fetch('data/clock_data.json').then(r => r.ok ? r.json() : null).catch(() => null),
    // Per-day stats from fetch_dialfire_daily.py — file may not exist yet
    // if the workflow hasn't run successfully. Treat as empty in that case.
    fetch('data/daily_data.json').then(r => r.ok ? r.json() : []).catch(() => []),
  ]);

  // Build a name → clocked hours map from the quay-clock fetcher output.
  // We try both raw and prettified names so PascalCase/dashed/snake_case
  // entries all match agents from Dialfire.
  //
  // `clockByName` mirrors THIS-WEEK clock data (used inside agentsForWeek
  // when normalising per-week agent records). `clockByPeriod` carries the
  // full per-period totals so agentsFor(period) can overwrite `ct` with
  // the right window's real hours instead of the df/0.85 estimate.
  const clockByName = new Map();
  const clockByPeriod = new Map(); // period -> Map<nameLower, hours>
  // Aliases: Dialfire's prettified agent name -> canonical Supabase staff
  // name. Add new entries here when an agent shows 'est' on All Staff but
  // clearly has Supabase clock events. Keys are lowercase. Mirrors known
  // nicknames + spelling diffs that the first+last fallback can't bridge.
  const CLOCK_ALIAS_DIALFIRE_TO_CANONICAL = {
    'gio':            'Giovon Van Wyk',
    'declan t':       'Declan Ryder Tyler',
    'geneva gomes':   'Geneva Maggie-Nela Gomez',
    'lauren carolus': 'Lauren Stacey Carolus',
    'nicolette':      'Nicolette Van Der Berg',
  };
  // Reverse index: canonical -> [alias, ...] so we can stash extra map keys
  // when building each period's lookup.
  const CLOCK_ALIASES_BY_CANONICAL = {};
  Object.entries(CLOCK_ALIAS_DIALFIRE_TO_CANONICAL).forEach(([alias, canonical]) => {
    const key = canonical.toLowerCase();
    (CLOCK_ALIASES_BY_CANONICAL[key] = CLOCK_ALIASES_BY_CANONICAL[key] || []).push(alias);
  });

  // Index by full name AND "first last" (skipping middle names) — Dialfire's
  // prettified agent names are usually short ("Douglas Nkulu") while
  // Supabase staff carry full names ("Douglas Mpiana Nkulu"). Without the
  // first+last fallback the All Staff page kept showing 'est' for last-week
  // even though the timesheets were imported.
  const buildNameMap = (agents) => {
    const m = new Map();
    const stash = (key, hours) => {
      if (!key) return;
      // First write wins if multiple staff share the same first+last (rare).
      if (!m.has(key)) m.set(key, hours);
    };
    (agents || []).forEach(a => {
      const hours = Number(a.hours) || 0;
      const stashAllForms = (name) => {
        if (!name) return;
        const full = name.toLowerCase().trim();
        stash(full, hours);
        const parts = name.trim().split(/\s+/);
        if (parts.length >= 2) {
          stash((parts[0] + ' ' + parts[parts.length - 1]).toLowerCase(), hours);
        }
        // Any registered Dialfire-side aliases for this canonical name.
        const aliases = CLOCK_ALIASES_BY_CANONICAL[full];
        if (aliases) aliases.forEach(alias => stash(alias.toLowerCase(), hours));
      };
      stashAllForms(a.name);
      stashAllForms(a.name_normalised);
    });
    return m;
  };
  if (clockData) {
    if (Array.isArray(clockData.agents)) {
      // Back-compat / this-week shortcut for agentsForWeek.
      clockData.agents.forEach(a => {
        const hours = Number(a.hours) || 0;
        if (a.name) clockByName.set(a.name.toLowerCase(), hours);
        if (a.name_normalised) clockByName.set(a.name_normalised.toLowerCase(), hours);
      });
    }
    if (clockData.periods && typeof clockData.periods === 'object') {
      Object.entries(clockData.periods).forEach(([periodKey, payload]) => {
        clockByPeriod.set(periodKey, buildNameMap(payload && payload.agents));
      });
    }
  }

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
    const pauseHrs = a.pauseTime || 0;
    // Prefer real clocked hours from quay-clock when present; otherwise
    // fall back to the historical 0.85 estimate so older weeks keep rendering.
    const prettyName = prettifyName(a.name);
    const clockHrs = clockByName.get((a.name || '').toLowerCase())
                   ?? clockByName.get(prettyName.toLowerCase());
    const ctSource = (clockHrs != null) ? 'clock' : 'estimate';
    const ctHrs = (clockHrs != null && clockHrs > 0)
      ? clockHrs
      : (workHrs > 0 ? workHrs / 0.85 : 0);
    const eff = ctHrs > 0 ? Math.round((workHrs / ctHrs) * 100) : 85;
    // talkPct = talk time as % of work time (Dialfire field, fallback compute)
    const talkPct = a.talkPct != null ? a.talkPct
                                      : (workHrs > 0 ? (talkHrs / workHrs) * 100 : 0);
    // workPct = work time as % of session (work + pause) — how much of the
    // clocked session was spent actively dialling vs paused
    const workPct = a.workPct != null ? a.workPct
                                      : (workHrs + pauseHrs > 0 ? (workHrs / (workHrs + pauseHrs)) * 100 : 0);
    return {
      id: 'a' + String(idx + 1).padStart(2, '0'),
      name: prettifyName(a.name),
      team,
      calls,
      leads,
      talkMin: Math.round(talkHrs * 60),
      df: +workHrs.toFixed(1),
      pauseHrs: +pauseHrs.toFixed(2),
      ct: +ctHrs.toFixed(1),
      ctSource,
      success: +successRate.toFixed(1),
      eff,
      connect: Math.round(talkPct),
      talkPct: +talkPct.toFixed(1),
      workPct: +workPct.toFixed(1),
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
          prev.pauseHrs = +(prev.pauseHrs + a.pauseHrs).toFixed(2);
          prev.seller += a.seller;
          prev.rental += a.rental;
          prev.email += a.email;
          // Merge campaigns set
          const seen = new Set(prev.campaigns);
          a.campaigns.forEach(c => { if (!seen.has(c)) prev.campaigns.push(c); });
        }
      });
    });
    // Re-derive success rate + cph + work/talk % from aggregated totals
    return [...byName.values()].map(a => {
      const talkHrs = a.talkMin / 60;
      const talkPct = a.df > 0 ? +((talkHrs / a.df) * 100).toFixed(1) : 0;
      const workPct = (a.df + a.pauseHrs) > 0
        ? +((a.df / (a.df + a.pauseHrs)) * 100).toFixed(1) : 0;
      return {
        ...a,
        success: a.calls ? +((a.leads / a.calls) * 100).toFixed(1) : 0,
        eff: a.ct ? Math.round((a.df / a.ct) * 100) : 85,
        cph: a.df ? +((a.calls / a.df).toFixed(1)) : 0,
        talkPct, workPct,
        connect: Math.round(talkPct),
      };
    });
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
    const list = aggregateWeeks(slice);
    // If the fetcher produced per-period clock data, override each agent's
    // clocked hours with the real total for THIS period (rather than
    // summing per-week this-week estimates across the slice).
    const periodMap = clockByPeriod.get(periodKey);
    if (periodMap && periodMap.size > 0) {
      list.forEach(a => {
        const name = (a.name || '').trim();
        let real = periodMap.get(name.toLowerCase());
        // Dialfire prettified names tend to be "First Last" while Supabase
        // staff names often have middle names. Fall back to first+last so
        // "Douglas Nkulu" matches "Douglas Mpiana Nkulu".
        if (real == null) {
          const parts = name.split(/\s+/);
          if (parts.length >= 2) {
            real = periodMap.get((parts[0] + ' ' + parts[parts.length - 1]).toLowerCase());
          }
        }
        if (real != null && real > 0) {
          a.ct = +real.toFixed(1);
          a.ctSource = 'clock';
          a.eff = a.df > 0 ? Math.round((a.df / a.ct) * 100) : a.eff;
        }
      });
    }
    return list.sort((a, b) => b.calls - a.calls);
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

  // Totals for the period immediately preceding `periodKey` — used by the
  // Leadership "progress vs last period" bars instead of hard-coded targets.
  function prevTotalsFor(periodKey) {
    const p = PERIODS[periodKey] || PERIODS['this-week'];
    const prev = weeks.slice((p.offset || 0) + p.weeks,
                              (p.offset || 0) + p.weeks * 2);
    if (!prev.length) return { calls: 0, leads: 0, avgSuccess: 0, active: 0 };
    return _periodTotals(prev);
  }

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

  // Period-aware trend window. The Operational Overview lets the user
  // switch between this-week, last-week, this-month, last-90, all-time —
  // the trend chart's window slides to match so the chart and the KPIs
  // above it describe the same horizon.
  function trendSeriesFor(periodKey) {
    const p = PERIODS[periodKey] || PERIODS['this-week'];
    // Number of weeks to plot: keep at least 4, cap at 26.
    const span = Math.min(26, Math.max(4, p.weeks * 4));
    const offset = p.offset || 0;
    // weeks is newest-first; take the slice ending at the period's end.
    const slice = weeks.slice(offset, offset + span).reverse(); // oldest -> newest
    const labels = slice.map(w => {
      const d = new Date(w.weekStart + 'T00:00:00Z');
      const onejan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const wnum = Math.ceil(((d - onejan) / 86400000 + onejan.getUTCDay() + 1) / 7);
      return 'W' + wnum;
    });
    const callsSeries = slice.map(w => agentsForWeek(w).reduce((s, a) => s + a.calls, 0));
    const succSeries  = slice.map(w => +(_periodTotals([w]).avgSuccess).toFixed(1));
    return { labels, calls: callsSeries, success: succSeries, weekCount: slice.length };
  }

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

  // ---- Daily Stats (per-day data from update-daily.yml workflow) -----------
  // dailyData is an array of { date, rm: [...], fancy: [...], generated } —
  // newest-first. Used by the Daily Stats tab.
  const dailyByDate = new Map();
  (Array.isArray(dailyData) ? dailyData : []).forEach(d => {
    if (d && d.date) dailyByDate.set(d.date, d);
  });
  const dailyDates = [...dailyByDate.keys()].sort().reverse();
  function dailyFor(dateStr) {
    const entry = dailyByDate.get(dateStr);
    if (!entry) return null;
    // Convert the same way agentsForWeek does so name/team/eff/etc line up
    // with the rest of the dashboard.
    const out = [];
    (entry.rm    || []).forEach((a, i) => out.push(_normAgent(a, 'RM', i)));
    (entry.fancy || []).forEach((a, i) => out.push(_normAgent(a, 'Fancy', i + 100)));
    return out.sort((a, b) => b.calls - a.calls);
  }
  function latestDailyDate() {
    return dailyDates[0] || null;
  }

  // ---- Monthly Breakdown — All Time -----------------------------------------
  // One row per calendar month covering every week we have data for.
  // Returns newest-first so the dashboard table reads top-down chronologically.
  // Unique RM/Fancy counts are de-duped across weeks by agent name so a single
  // person who worked 4 weeks doesn't get counted 4 times.
  function monthlyBreakdown() {
    return orderedMonths
      .slice()                          // newest-first so we reverse the orderedMonths
      .sort()
      .reverse()
      .map(k => {
        const ws = buckets.get(k);
        const [year, monthNum] = k.split('-').map(Number);
        const label = `${MONTH_NAMES[monthNum - 1]} ${year}`;
        const rmNames = new Set();
        const fancyNames = new Set();
        let calls = 0, seller = 0, rental = 0, email = 0, leads = 0;
        let dfHours = 0;
        ws.forEach(w => {
          (w.rm || []).forEach(a => {
            if (a && a.name) rmNames.add(a.name);
            calls   += a.calls    || 0;
            seller  += a.seller   || 0;
            rental  += a.rental   || 0;
            email   += a.email    || 0;
            leads   += a.leads    || 0;
            dfHours += a.workTime || 0;
          });
          (w.fancy || []).forEach(a => {
            if (a && a.name) fancyNames.add(a.name);
            calls   += a.calls    || 0;
            seller  += a.seller   || 0;
            rental  += a.rental   || 0;
            email   += a.email    || 0;
            leads   += a.leads    || 0;
            dfHours += a.workTime || 0;
          });
        });
        // Weighted-by-calls success rate so a big-volume week doesn't get
        // averaged equally with a quiet one.
        const successWeighted = ws.reduce((s, w) => {
          const total = _periodTotals([w]);
          return s + total.avgSuccess * total.calls;
        }, 0);
        const totalCalls = ws.reduce((s, w) => s + _periodTotals([w]).calls, 0);
        const successRate = totalCalls
          ? +(successWeighted / totalCalls).toFixed(1)
          : 0;
        return {
          key: k,
          label,
          weeks: ws.length,
          rmCount: rmNames.size,
          fancyCount: fancyNames.size,
          activeCount: rmNames.size + fancyNames.size,
          calls,
          seller,
          rental,
          email,
          leads,
          successRate,
          dfHours: +dfHours.toFixed(2),
          cph: dfHours ? +(calls / dfHours).toFixed(1) : 0,
        };
      });
  }

  // Per-week breakdown across ALL weeks — newest-first.
  // Mirrors monthlyBreakdown() but each record represents a single week,
  // suitable for the Compare tab's Week vs Week picker.
  function weeksBreakdown() {
    return weeks.map(w => {
      const t = _periodTotals([w]);
      const names = new Set();
      let seller = 0, rental = 0, email = 0, dfHours = 0;
      (w.rm || []).forEach(a => {
        if (a && a.name) names.add(a.name);
        seller  += a.seller   || 0;
        rental  += a.rental   || 0;
        email   += a.email    || 0;
        dfHours += a.workTime || 0;
      });
      (w.fancy || []).forEach(a => {
        if (a && a.name) names.add(a.name);
        seller  += a.seller   || 0;
        rental  += a.rental   || 0;
        email   += a.email    || 0;
        dfHours += a.workTime || 0;
      });
      const d = new Date(w.weekStart + 'T00:00:00Z');
      const label = 'Wk of ' + d.toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', timeZone: 'UTC',
      }) + ' (W' + isoWeekNum(d) + ')';
      return {
        key:         w.weekStart,
        label,
        activeCount: names.size,
        calls:       t.calls,
        leads:       t.leads,
        successRate: +t.avgSuccess.toFixed(1),
        cph:         dfHours ? +(t.calls / dfHours).toFixed(1) : 0,
        seller, rental, email,
        dfHours:     +dfHours.toFixed(2),
      };
    });
  }

  // Per-week breakdown for the weeks inside a given calendar month —
  // used by the Monthly tab's click-to-expand drill-down.
  function weeksInMonth(monthK) {
    const ws = (buckets.get(monthK) || []).slice().sort((a, b) =>
      a.weekStart.localeCompare(b.weekStart)
    );
    return ws.map(w => {
      const t = _periodTotals([w]);
      const names = new Set();
      let seller = 0, rental = 0, email = 0, dfHours = 0;
      (w.rm || []).forEach(a => {
        if (a && a.name) names.add(a.name);
        seller  += a.seller   || 0;
        rental  += a.rental   || 0;
        email   += a.email    || 0;
        dfHours += a.workTime || 0;
      });
      (w.fancy || []).forEach(a => {
        if (a && a.name) names.add(a.name);
        seller  += a.seller   || 0;
        rental  += a.rental   || 0;
        email   += a.email    || 0;
        dfHours += a.workTime || 0;
      });
      const d = new Date(w.weekStart + 'T00:00:00Z');
      const label = d.toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', timeZone: 'UTC',
      }) + ' (W' + isoWeekNum(d) + ')';
      return {
        weekStart:   w.weekStart,
        label,
        calls:       t.calls,
        leads:       t.leads,
        successRate: +t.avgSuccess.toFixed(1),
        seller, rental, email,
        dfHours:     +dfHours.toFixed(2),
        cph:         dfHours ? +(t.calls / dfHours).toFixed(1) : 0,
        activeCount: names.size,
      };
    });
  }
  function isoWeekNum(d) {
    const onejan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d - onejan) / 86400000 + onejan.getUTCDay() + 1) / 7);
  }

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
  // Public alias so the Overview donut can re-compute as the period changes.
  const sourcesFor = _topSourcesFor;

  // ---- Expose ---------------------------------------------------------------
  // ---- Forecasting / pace projection ---------------------------------------
  // Fractions of period elapsed (used to project end-of-period totals).
  // 'this-week' assumes Mon-Fri working week; weekend visits count as Fri.
  // 'this-month' uses calendar days of current month.
  // Other periods are historical / complete → no projection (factor=1).
  function periodElapsed(periodKey) {
    const now = new Date();
    if (periodKey === 'this-week') {
      const dow = now.getDay(); // 0=Sun, 1=Mon..6=Sat
      const workedDays = (dow === 0 || dow === 6) ? 5 : Math.min(5, dow);
      return { elapsed: workedDays, total: 5, fraction: workedDays / 5 };
    }
    if (periodKey === 'this-month') {
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      return { elapsed: now.getDate(), total: lastDay, fraction: now.getDate() / lastDay };
    }
    return { elapsed: 1, total: 1, fraction: 1 };
  }

  // Projected end-of-period value given current actuals.
  function project(periodKey, value) {
    const e = periodElapsed(periodKey);
    if (!e.fraction || e.fraction >= 1) return Math.round(value);
    return Math.round(value / e.fraction);
  }

  // Average of a given key across the trailing N weeks (excluding current).
  function trailingAvg(key, n) {
    const slice = weeks.slice(1, 1 + n);
    if (!slice.length) return 0;
    let total = 0;
    slice.forEach(w => {
      ['rm', 'fancy'].forEach(team =>
        (w[team] || []).forEach(a => { total += (a[key] || 0); }));
    });
    return Math.round(total / slice.length);
  }

  // ---- Per-agent history (used by the drill-down modal) ------------------
  // Returns [{ weekStart, weekEnd, calls, leads, success%, talkHrs, dfHrs }, ...]
  // sorted OLDEST first so the modal's trend chart reads left → right.
  function agentHistory(agentName) {
    const target = (agentName || '').trim();
    const targetLower = target.toLowerCase();
    const targetPretty = prettifyName(target).toLowerCase();
    const out = [];
    weeks.slice().reverse().forEach(w => {                  // oldest first
      let row = null;
      ['rm', 'fancy'].forEach(team => {
        (w[team] || []).forEach(a => {
          const an = (a.name || '').toLowerCase();
          if (an === targetLower || prettifyName(a.name).toLowerCase() === targetPretty) row = a;
        });
      });
      out.push({
        weekStart: w.weekStart,
        weekEnd:   w.weekEnd,
        calls:     row ? (row.calls || 0)        : 0,
        leads:     row ? (row.success || 0)      : 0,
        success:   row ? (row.successRate || 0)  : 0,
        talkHrs:   row ? (row.talkTime || 0)     : 0,
        dfHrs:     row ? (row.workTime || 0)     : 0,
        seller:    row ? (row.seller || 0)       : 0,
        rental:    row ? (row.rental || 0)       : 0,
        email:     row ? (row.email || 0)        : 0,
        present:   !!row,
      });
    });
    return out;
  }

  // Per-agent-per-campaign breakdown for the period (uses by_agent_campaign).
  function agentCampaigns(agentName, periodKey) {
    const slice = _sliceFor(periodKey);
    const target = (agentName || '').trim();
    const targetPretty = prettifyName(target);
    const byCamp = {};
    slice.forEach(w => {
      if (!w.by_agent_campaign) return;
      Object.entries(w.by_agent_campaign).forEach(([an, perCamp]) => {
        if (an !== target && prettifyName(an) !== targetPretty) return;
        Object.entries(perCamp).forEach(([rawCamp, st]) => {
          const camp = normalizeCampaignName(rawCamp);
          const cur = byCamp[camp] || { name: camp, calls: 0, leads: 0, seller: 0, rental: 0, email: 0 };
          cur.calls  += st.calls   || 0;
          cur.leads  += st.success || 0;
          cur.seller += st.seller  || 0;
          cur.rental += st.rental  || 0;
          cur.email  += st.email   || 0;
          byCamp[camp] = cur;
        });
      });
    });
    return Object.values(byCamp).sort((a, b) => b.calls - a.calls);
  }

  // Map a period key onto a {fromISO, toISO} range, used by Supabase
  // queries that need a date filter (e.g. clock_out_reports lookups for
  // the All Staff "LN & Assistants" sub-tab). Earliest day in the period's
  // week-slice → start; latest weekStart + 7 days → end.
  function periodDateRange(periodKey) {
    const slice = _sliceFor(periodKey);
    if (!slice.length) {
      const to = new Date();
      const from = new Date(to.getTime() - 30 * 86400 * 1000);
      return { fromISO: from.toISOString(), toISO: to.toISOString() };
    }
    const earliest = slice[slice.length - 1].weekStart;
    const latest   = slice[0].weekStart;
    const fromISO = new Date(earliest + 'T00:00:00Z').toISOString();
    const toMs    = new Date(latest + 'T00:00:00Z').getTime() + 7 * 86400 * 1000;
    return { fromISO, toISO: new Date(toMs).toISOString() };
  }

  window.QUAY = {
    AGENTS: agentsForWeek(weeks[0]),  // current week, sorted natural
    WEEKS, WEEK_CALLS, WEEK_SUCCESS, trendSeriesFor,
    SOURCES, sourcesFor, campaignsFor,
    monthlyBreakdown, weeksBreakdown,
    dailyDates, dailyFor, latestDailyDate,
    MONTHS, MONTH_CALLS, MONTH_LEADS, MONTH_EMAILS, MONTH_RENTALS, MONTH_DFHOURS,
    PERIODS, DELTAS, agentsFor, totalsFor, prevTotalsFor, weeksInMonth,
    periodElapsed, project, trailingAvg,
    agentHistory, agentCampaigns,
    periodDateRange,
  };
  return window.QUAY;
})();

/* Quay 1 — Performance Dashboard · REAL DATA ADAPTER
   Loads /data/weekly_data.json + /data/history.json (Dialfire-fed by the
   GitHub Action) and builds the shape app.js + views.js expect.

   Lead Sources: no real data feed yet — kept as placeholders.
   Clocked time (Dialler / Clocked columns on All Staff): real values come
   from data/clock_data.json when the quay-clock fetcher has run (see
   scripts/fetch_clock.py). When no real entry exists for an agent, we
   fall back to the historical `workTime / 0.85` estimate. */

window.QUAY_READY = (async function () {
  const [weekly, history, clockData, dailyData, clienthubData] = await Promise.all([
    fetch('data/weekly_data.json').then(r => r.json()),
    fetch('data/history.json').then(r => r.json()),
    fetch('data/clock_data.json').then(r => r.ok ? r.json() : null).catch(() => null),
    // Per-day stats from fetch_dialfire_daily.py — file may not exist yet
    // if the workflow hasn't run successfully. Treat as empty in that case.
    fetch('data/daily_data.json').then(r => r.ok ? r.json() : []).catch(() => []),
    // ClientHub Master per-team stats (fetch_clienthub_teams.py). Null until
    // the workflow has run; the tab renders a friendly empty state then.
    fetch('data/clienthub_teams.json').then(r => r.ok ? r.json() : null).catch(() => null),
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
  const clockByWeek = new Map();   // weekStart 'YYYY-MM-DD' -> Map<nameLower, hours>
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
    'test':           'Jason Hendricks',
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
    // Per-week clocked hours keyed by Monday weekStart (matches how weekly
    // Dialfire data is sliced), so a CUSTOM date range can sum real hours
    // across the weeks it covers instead of using the df/0.85 estimate.
    if (clockData.by_week && typeof clockData.by_week === 'object') {
      Object.entries(clockData.by_week).forEach(([weekKey, agents]) => {
        clockByWeek.set(weekKey, buildNameMap(agents));
      });
    }
  }

  // history may or may not include the current week; ensure latest first.
  // Drop malformed rows with no weekStart so the sort key can't throw.
  const weeks = history.slice()
    .filter(w => w && w.weekStart)
    .sort((a, b) => String(b.weekStart).localeCompare(String(a.weekStart)));
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
    // "Lead" = SELLER lead only (per business definition) — keeps the count
    // honest: an email-collected outcome is a success but not a lead.
    // "Success Rate" = Dialfire's raw `success` column ÷ calls, matching v1
    // and the team's 12% target (all positive outcomes, not seller-only).
    const leads = a.seller || 0;
    const rawSuccess = a.success || 0;
    const successRate = calls ? +((rawSuccess / calls) * 100).toFixed(1) : 0;
    const talkHrs = a.talkTime || 0;
    const workHrs = a.workTime || 0;
    const pauseHrs = a.pauseTime || 0;
    // Default to the df/0.85 estimate here; `agentsFor(periodKey)` overrides
    // ct with the CORRECT-period clocked hours from clockByPeriod once we
    // know which pill's window we're rendering. The old clockByName
    // shortcut always fed THIS-WEEK's clock bucket into every row it
    // touched — so a "Last Week" or "Prior Week" pill was rendering last
    // week's Dialfire numbers next to this-week's clock hours (Declan
    // showing 829 calls + 2.8h clocked in the same row). Cleaner to just
    // estimate here and let the period override do the real work.
    const prettyName = prettifyName(a.name);
    const ctSource = 'estimate';
    const ctHrs = workHrs > 0 ? workHrs / 0.85 : 0;
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
      rawSuccess,
      // Answered = calls reached (calls − No Answer), from the Dialfire fetcher.
      // Null when the source snapshot pre-dates the field.
      answered: a.answered != null ? a.answered : null,
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
  // Merge a set of already-normalized per-agent lists (one per week OR per
  // day) into cumulative totals, re-deriving rates from the sums. Shared by
  // weekly (aggregateWeeks) and daily (aggregateDailyRange) aggregation so
  // both paths produce identical record shapes.
  function _mergeAgentLists(lists) {
    const byName = new Map();
    lists.forEach(list => {
      (list || []).forEach(a => {
        const key = a.name + '|' + a.team;
        const prev = byName.get(key);
        if (!prev) {
          byName.set(key, { ...a, campaigns: (a.campaigns || []).slice() });
        } else {
          prev.calls += a.calls;
          prev.leads += a.leads;
          prev.rawSuccess = (prev.rawSuccess || 0) + (a.rawSuccess || 0);
          prev.talkMin += a.talkMin;
          prev.df = +(prev.df + a.df).toFixed(1);
          prev.ct = +(prev.ct + a.ct).toFixed(1);
          prev.pauseHrs = +(prev.pauseHrs + a.pauseHrs).toFixed(2);
          prev.seller += a.seller;
          prev.rental += a.rental;
          prev.email += a.email;
          // Merge campaigns set
          const seen = new Set(prev.campaigns);
          (a.campaigns || []).forEach(c => { if (!seen.has(c)) prev.campaigns.push(c); });
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
        success: a.calls ? +(((a.rawSuccess || 0) / a.calls) * 100).toFixed(1) : 0,
        eff: a.ct ? Math.round((a.df / a.ct) * 100) : 85,
        cph: a.df ? +((a.calls / a.df).toFixed(1)) : 0,
        talkPct, workPct,
        connect: Math.round(talkPct),
      };
    });
  }
  function aggregateWeeks(weekList) {
    return _mergeAgentLists(weekList.map(w => agentsForWeek(w)));
  }
  // Aggregate per-day records across [fromYmd, toYmd] inclusive. Fallback for
  // agentsForRange when a range encloses no complete Mon–Sun week (e.g.
  // "yesterday" or a 2–3 day span) but per-day data covers it. Returns null
  // when no daily snapshots fall in the span. Clocked hours stay estimated
  // (df/0.85 via _normAgent) since clock data is weekly, not daily.
  function aggregateDailyRange(fromYmd, toYmd) {
    const dates = dailyDates
      .filter(d => d >= fromYmd && d <= toYmd)
      .sort();                                   // ascending: oldest → newest
    if (!dates.length) return null;
    const list = _mergeAgentLists(dates.map(d => dailyFor(d)))
      .sort((x, y) => y.calls - x.calls);
    return { list, dates };
  }

  // ---- Period selectors ----------------------------------------------------
  const PERIODS = {
    // Week model (corrected 2026-07-14): the Dialfire weekly fetcher writes
    // weeks[0] = the IN-PROGRESS current week (it can briefly lag to the just-
    // finished week at the very start of a week, until that week's first cron
    // runs — periodElapsed's `stale` flag detects that). So weeks[0] = this
    // week, weeks[1] = last completed week, weeks[2] = the week before.
    // (An earlier 2026-07-06 note wrongly assumed weeks[0] was always the last
    // COMPLETED week and relabelled the pills one week older — that made the
    // dashboard permanently a week behind; reverted here.)
    //
    // `current-week` is a live, week-to-date period aggregated from
    // daily_data.json (Mon → today), NOT a weeks[] slice. It's what the "This
    // Week" chip uses so the in-progress week is correct even during the
    // start-of-week weekly-fetcher lag. The frozen this-week/last-week keys
    // keep their weeks[]-offset meaning (weeks[0] / weeks[1]) for internal
    // callers and the "Last Week" chip. See the `current-week` branches in
    // agentsFor / campaignsFor / periodElapsed / DELTAS below and GLOBAL_QUICK
    // in app.js. `last-week` is date-anchored in _sliceFor so it stays the
    // real previous calendar week even if weeks[0] is momentarily lagging.
    'current-week':  { label: 'This Week',       weeks: 0, liveWeek: true },
    'this-week':     { label: 'This Week',       weeks: 1  },
    'last-week':     { label: 'Last Week',       weeks: 1, offset: 1 },
    'this-month':    { label: 'This Month',      weeks: 4  },
    // Billing Period follows Quay 1's payroll cycle: 21st of month M-1
    // through 20th of month M inclusive. Aggregation reuses agentsForRange
    // so only complete Mon-Sun weeks fully inside the window are included;
    // the trailing day (20th if it falls mid-week) is picked up by the
    // clockByPeriod override which reads clock_data.json's billing-period
    // bucket. `dayBased: true` is a sentinel _sliceFor uses to return []
    // rather than misleading weekly data if someone forgets to route
    // through the delegation branch in agentsFor.
    'billing-period':{ label: 'Billing Period',  weeks: 0, dayBased: true },
    'last-90':       { label: 'Last 90 Days',    weeks: 13 },
    'all-time':      { label: 'All Time',        weeks: weeks.length },
  };

  // SAST-anchored current billing period. If today's date is >= 21, the
  // cycle started on the 21st of THIS month and ends on the 20th of NEXT
  // month. If today <= 20, the cycle started on the 21st of LAST month
  // and ends on the 20th of THIS month. Returns { fromYmd, toYmd } as
  // 'YYYY-MM-DD' strings so it drops straight into agentsForRange.
  function billingPeriodWindow(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Johannesburg',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const g = (t) => parseInt(parts.find(p => p.type === t).value, 10);
    const y = g('year'), m = g('month'), d = g('day');
    const startY = d >= 21 ? y : (m === 1 ? y - 1 : y);
    const startM = d >= 21 ? m : (m === 1 ? 12   : m - 1);
    const endY   = startM === 12 ? startY + 1 : startY;
    const endM   = startM === 12 ? 1         : startM + 1;
    const pad2 = (n) => String(n).padStart(2, '0');
    return {
      fromYmd: `${startY}-${pad2(startM)}-21`,
      toYmd:   `${endY}-${pad2(endM)}-20`,
    };
  }

  // SAST-anchored current calendar week: Monday (00:00 SAST) → today. Feeds the
  // live `current-week` period (the "This Week" chip). Returns { fromYmd, toYmd }
  // as 'YYYY-MM-DD' so it drops straight into agentsForRange's daily fallback.
  function currentWeekWindow(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Johannesburg',
      year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    }).formatToParts(now);
    const g = (t) => parts.find(p => p.type === t).value;
    const ymd = `${g('year')}-${g('month')}-${g('day')}`;
    const back = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[g('weekday')] || 0;
    return { fromYmd: _addDaysYmd(ymd, -back), toYmd: ymd };
  }

  function _sliceFor(periodKey) {
    // Date-anchor "Last Week" to the actual previous calendar week (weekStart
    // === last Monday), so it stays the real last completed week even when
    // weeks[0] is momentarily lagging to the just-finished week at the very
    // start of a week (before that week's first Dialfire cron runs). Falls
    // back to the plain weeks[1] offset if that week isn't in history.
    if (periodKey === 'last-week') {
      const lastMon = _addDaysYmd(currentWeekWindow().fromYmd, -7);
      const w = weeks.find(x => x.weekStart === lastMon);
      if (w) return [w];
    }
    const p = PERIODS[periodKey] || PERIODS['this-week'];
    const start = p.offset || 0;
    return weeks.slice(start, start + p.weeks);
  }

  // Custom-range twin of agentsFor: strict week inclusion (only complete
  // Mon-Sun weeks fully inside [fromYmd, toYmd]). No per-period clock
  // override — the clockByPeriod map is keyed by preset period names, so
  // custom ranges fall back to the aggregated per-week clock estimate
  // baked into aggregateWeeks. Returns the list decorated with an `_range`
  // sidecar so the caller can render "covers X → Y · N complete weeks".
  function agentsForRange(fromYmd, toYmd) {
    if (!fromYmd || !toYmd) {
      const empty = [];
      empty._range = { requestedFrom: fromYmd, requestedTo: toYmd,
                       effectiveFrom: null, effectiveTo: null, weeksIncluded: 0 };
      return empty;
    }
    const [a, b] = fromYmd <= toYmd ? [fromYmd, toYmd] : [toYmd, fromYmd];
    const enclose = (lo, hi) => weeks.filter(w => {
      if (!w.weekStart) return false;
      const wEnd = _addDaysYmd(w.weekStart, 6);
      return w.weekStart >= lo && wEnd <= hi;
    });
    let slice = enclose(a, b);
    // Auto-snap: if the strict enclose returns 0 weeks AND the user's TO is
    // mid-week (Mon-Sat), extend TO forward to the nearest following Sunday
    // so the user's obvious intent — "show me last week" typed as Jun 29 to
    // Jul 4 — actually lands the Jun 29 - Jul 5 block instead of a red
    // "no complete Mon-Sun weeks" error. Report the snap in _range so the
    // view can render a small "auto-adjusted to X" caption.
    let snappedTo = null;
    // Only auto-snap a genuine multi-day range (a !== b). A single-day pick
    // must fall through to the daily fallback below — otherwise selecting a
    // lone Monday would extend TO to that same week's Sunday and enclose the
    // whole Mon-Sun week, silently turning "just Monday" into "the week".
    if (slice.length === 0 && a !== b) {
      // Days until next Sunday (Sun=0 in JS Date). If b is already Sunday
      // there's nothing to extend, so leave it — the strict-empty case will
      // still surface a red message for that.
      const bDate = new Date(b + 'T00:00:00+02:00');
      const dow = bDate.getDay();
      if (dow !== 0) {
        const daysToSun = (7 - dow) % 7;   // Mon=6, Sat=1
        const ext = new Date(bDate);
        ext.setDate(ext.getDate() + daysToSun);
        const yyyy = ext.getFullYear();
        const mm = String(ext.getMonth() + 1).padStart(2, '0');
        const dd = String(ext.getDate()).padStart(2, '0');
        snappedTo = `${yyyy}-${mm}-${dd}`;
        const snapped = enclose(a, snappedTo);
        if (snapped.length > 0) slice = snapped;
      }
    }
    // Daily fallback: still no complete week enclosed, but we DO have per-day
    // snapshots covering the requested span — aggregate those so single-day
    // ("yesterday") and partial-week ranges show real numbers instead of an
    // empty "no complete weeks" state.
    if (slice.length === 0) {
      const daily = aggregateDailyRange(a, b);
      if (daily && daily.list.length) {
        daily.list._range = {
          requestedFrom: a, requestedTo: b,
          effectiveFrom: daily.dates[0],
          effectiveTo: daily.dates[daily.dates.length - 1],
          weeksIncluded: 0, daysIncluded: daily.dates.length,
          granularity: 'daily', autoSnappedTo: null,
        };
        return daily.list;
      }
    }
    const list = aggregateWeeks(slice).sort((x, y) => y.calls - x.calls);
    // Override each agent's clocked hours with the REAL per-week totals summed
    // across the weeks in this slice, when the clock fetcher has emitted
    // by_week data. Without it (older clock_data.json) we keep the df/0.85
    // estimate — so this only ever adds accuracy, never regresses. This is
    // what makes a custom date range show real clocked hours (no 'est').
    if (clockByWeek.size > 0 && slice.length > 0) {
      list.forEach(a => {
        const name = (a.name || '').trim();
        const fullKey = name.toLowerCase();
        const parts = name.split(/\s+/);
        const flKey = parts.length >= 2
          ? (parts[0] + ' ' + parts[parts.length - 1]).toLowerCase()
          : null;
        let total = 0, found = false;
        slice.forEach(w => {
          const wm = clockByWeek.get(w.weekStart);
          if (!wm) return;
          let h = wm.get(fullKey);
          if (h == null && flKey) h = wm.get(flKey);
          if (h != null) { total += h; found = true; }
        });
        if (found && total > 0) {
          a.ct = +total.toFixed(1);
          a.ctSource = 'clock';
          a.eff = a.df > 0 ? Math.round((a.df / a.ct) * 100) : a.eff;
        }
      });
    }
    let effFrom = null, effTo = null;
    slice.forEach(w => {
      const ws = w.weekStart;
      const we = _addDaysYmd(ws, 6);
      if (!effFrom || ws < effFrom) effFrom = ws;
      if (!effTo   || we > effTo)   effTo   = we;
    });
    list._range = { requestedFrom: a, requestedTo: b,
                    effectiveFrom: effFrom, effectiveTo: effTo,
                    weeksIncluded: slice.length,
                    autoSnappedTo: snappedTo && slice.length > 0 ? snappedTo : null };
    return list;
  }

  function agentsFor(periodKey) {
    // Live current week ("This Week" chip). weekly_data.json only holds
    // COMPLETED weeks, so the in-progress week is aggregated from daily_data
    // (Mon → today) via agentsForRange's daily fallback. Clocked hours come
    // from clock_data.json's in-progress `this-week` bucket (the clock fetcher
    // names the calendar-week-in-progress `this-week`, which is exactly this
    // window — see the CLOCK_KEY_MAP note below for why the Dialfire keys differ).
    if (periodKey === 'current-week') {
      const w = currentWeekWindow();
      const list = agentsForRange(w.fromYmd, w.toYmd);
      const periodMap = clockByPeriod.get('this-week');
      if (periodMap && periodMap.size > 0) {
        list.forEach(a => {
          const name = (a.name || '').trim();
          let real = periodMap.get(name.toLowerCase());
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
    // Billing Period is a day-based window (21st to 20th), so it does not
    // fit the weekly-slice model _sliceFor uses. Delegate to agentsForRange
    // which already knows how to aggregate Mon-Sun weeks fully inside an
    // arbitrary date range; then apply the billing-period clock override
    // below so hours come from clock_data.json's billing-period bucket.
    if (periodKey === 'billing-period') {
      const w = billingPeriodWindow();
      const list = agentsForRange(w.fromYmd, w.toYmd);
      const periodMap = clockByPeriod.get('billing-period');
      if (periodMap && periodMap.size > 0) {
        list.forEach(a => {
          const name = (a.name || '').trim();
          let real = periodMap.get(name.toLowerCase());
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
    const slice = _sliceFor(periodKey);
    const list = aggregateWeeks(slice);
    // If the fetcher produced per-period clock data, override each agent's
    // clocked hours with the real total for THIS period (rather than
    // summing per-week this-week estimates across the slice).
    //
    // Align each Dialfire weekly slice with the matching clock_data.json
    // bucket (corrected 2026-07-14, now that weeks[0] = the in-progress week):
    //   this-week (weeks[0], current week)  -> clock's `this-week` bucket
    //   last-week (weeks[1], last complete) -> clock's `last-week` bucket
    // Without this the clocked-hours override would land a different span than
    // the calls, producing bogus "N calls + Mh clocked" rows.
    const CLOCK_KEY_MAP = {
      'this-week':  'this-week',   // weeks[0] = current week    = clock's this-week bucket
      'last-week':  'last-week',   // weeks[1] = last complete   = clock's last-week bucket
      'this-month': 'this-month',
      'last-90':    'last-90',
      'all-time':   'all-time',
    };
    const clockKey = CLOCK_KEY_MAP.hasOwnProperty(periodKey)
      ? CLOCK_KEY_MAP[periodKey]
      : periodKey;
    const periodMap = clockKey ? clockByPeriod.get(clockKey) : null;
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
    // Sum the raw `success` counts directly — avoids the ~0.05% drift from
    // multiplying calls × a.success (which is toFixed(1)-rounded per agent).
    const successCount = list.reduce((s, a) => s + (a.rawSuccess || 0), 0);
    const avgSuccess = calls ? +((successCount / calls) * 100).toFixed(1) : 0;
    return { calls, leads, avgSuccess, active: list.length };
  }

  // Floor-wide "Avg. Daily Output": average calls per agent per working day
  // across the last-90 (~13 week / 3 month) window. Covers the whole calling
  // floor (RM + Fancy — that's all agentsFor returns; LN/assistants are a
  // separate dataset). Working days = 5/week (matches periodElapsed). Uses
  // the actual number of weeks available, so it degrades gracefully before
  // 13 weeks of history exist.
  function floorDailyAverage() {
    const weeksN = _sliceFor('last-90').length || (PERIODS['last-90'].weeks || 13);
    const list = agentsFor('last-90');
    const agents = list.length;
    const totalCalls = list.reduce((s, a) => s + (a.calls || 0), 0);
    const days = weeksN * 5;
    const perAgentPerDay = (agents && days) ? +(totalCalls / agents / days).toFixed(1) : 0;
    return { perAgentPerDay, agents, weeks: weeksN, days, totalCalls };
  }

  // ---- Period-over-period deltas (real, not hard-coded) -------------------
  function _periodTotals(weekSlice) {
    const list = aggregateWeeks(weekSlice);
    const calls = list.reduce((s, a) => s + a.calls, 0);
    const leads = list.reduce((s, a) => s + a.leads, 0);
    const successCount = list.reduce((s, a) => s + (a.rawSuccess || 0), 0);
    const avgSuccess = calls ? (successCount / calls) * 100 : 0;
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
  // NOTE: DELTAS['current-week'] is a live week-to-date delta that needs the
  // daily snapshots (dailyDates/dailyByDate), which are initialized further
  // below — so it is (re)computed there, after that section, to avoid a
  // temporal-dead-zone ReferenceError at module load.

  // Totals for the period immediately preceding `periodKey` — used by the
  // Leadership "progress vs last period" bars instead of hard-coded targets.
  function prevTotalsFor(periodKey) {
    // Live current week's "previous period" baseline is the last completed
    // full week (weeks[0]) — there is no weeks[] slice for the in-progress week.
    if (periodKey === 'current-week') return _periodTotals(weeks.slice(0, 1));
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
  // Per-metric sparkline series so the KPI cards each show their own
  // history. Previously every KPI re-used WEEK_CALLS with a fake
  // ascending tilt — the sparklines were decoration, not data.
  const WEEK_LEADS = trendWeeks.map(w => {
    const list = agentsForWeek(w);
    return list.reduce((s, a) => s + (a.leads || 0), 0);
  });
  const WEEK_ACTIVE = trendWeeks.map(w => agentsForWeek(w).length);

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

  // Live current-week delta (deferred from the DELTAS block above so the daily
  // snapshots are initialized). Compares this week-to-date against the SAME
  // weekday span of last week (Mon..today-7) using daily data — a fair pace
  // delta, not partial-week-vs-full-week. Falls back to zeros if either side
  // has no daily coverage yet.
  (function () {
    const w = currentWeekWindow();
    const curList = agentsFor('current-week');
    // Compare against the SAME days that the current week actually has data
    // for (not the nominal Mon→today window). Early in the day today's daily
    // snapshot may not be ingested yet, so pinning the baseline to the real
    // covered span keeps the WoW delta like-for-like instead of comparing
    // N days against N+1. dailyDates is newest-first.
    const curDates = dailyDates.filter(d => d >= w.fromYmd && d <= w.toYmd);
    const prevAgg = curDates.length
      ? aggregateDailyRange(
          _addDaysYmd(curDates[curDates.length - 1], -7),  // oldest covered day − 7
          _addDaysYmd(curDates[0], -7))                    // newest covered day − 7
      : null;
    const prevList = prevAgg ? prevAgg.list : [];
    const sum = (list, f) => list.reduce((s, a) => s + f(a), 0);
    const rate = (list) => { const c = sum(list, a => a.calls); return c ? (sum(list, a => a.rawSuccess || 0) / c) * 100 : 0; };
    const pct = (n, d) => d ? +(((n - d) / d) * 100).toFixed(1) : 0;
    DELTAS['current-week'] = {
      calls:   pct(sum(curList, a => a.calls), sum(prevList, a => a.calls)),
      leads:   pct(sum(curList, a => a.leads), sum(prevList, a => a.leads)),
      success: +(rate(curList) - rate(prevList)).toFixed(1),
      active:  curList.length - prevList.length,
    };
  })();

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
    // Live current week: build the slice from daily snapshots (Mon → today)
    // instead of weeks[]. Daily entries carry the same by_agent_campaign /
    // rm / fancy shape as weekly ones, so the aggregation below is unchanged.
    let slice;
    if (periodKey === 'current-week') {
      const w = currentWeekWindow();
      slice = dailyDates
        .filter(d => d >= w.fromYmd && d <= w.toYmd)
        .map(d => dailyByDate.get(d))
        .filter(Boolean);
    } else {
      slice = _sliceFor(periodKey);
    }
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
            // 'leads' = seller leads only (per business definition).
            // Rental + email stay as their own columns.
            cur.leads  += stats.seller  || 0;
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
            cur.leads  += agent.seller  || 0;     // seller only
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
    if (periodKey === 'current-week') {
      // Live week-to-date: working days elapsed so far (Mon-Fri, weekend
      // counts as the full 5). Drives the Overview pace/projection bars.
      const dow = now.getDay(); // 0=Sun, 1=Mon..6=Sat
      const workedDays = (dow === 0 || dow === 6) ? 5 : Math.min(5, dow);
      return { elapsed: workedDays, total: 5, fraction: workedDays / 5, stale: false };
    }
    if (periodKey === 'this-week') {
      // The 'this-week' bucket in weekly_data is whichever week the Dialfire
      // fetcher last wrote. On Mondays the fetcher returns last week's full
      // Mon-Sun until the morning cron runs.
      const sowIso = (() => {
        const d = new Date();
        const day = (d.getDay() + 6) % 7; // 0=Mon..6=Sun
        d.setHours(0,0,0,0); d.setDate(d.getDate() - day);
        return d.toISOString().slice(0, 10);
      })();
      const dataWeekStart = (weeks[0] && weeks[0].weekStart) || null;
      if (dataWeekStart && dataWeekStart !== sowIso) {
        // Data is for a previous week. Flag as `stale` so the dashboard
        // hides pace bars + "projected" text — the COO opening on
        // Monday morning would otherwise see *last* week's numbers
        // framed as "this week, complete (100%)". The label says it
        // out loud now.
        return { elapsed: 5, total: 5, fraction: 1, stale: true,
                 staleReason: 'Data is for week of ' + dataWeekStart + '; this week not yet ingested' };
      }
      const dow = now.getDay(); // 0=Sun, 1=Mon..6=Sat
      const workedDays = (dow === 0 || dow === 6) ? 5 : Math.min(5, dow);
      return { elapsed: workedDays, total: 5, fraction: workedDays / 5, stale: false };
    }
    if (periodKey === 'this-month') {
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      return { elapsed: now.getDate(), total: lastDay, fraction: now.getDate() / lastDay, stale: false };
    }
    return { elapsed: 1, total: 1, fraction: 1, stale: false };
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

  // Canonical form for team-name matching: uppercased, punctuation stripped.
  // Bridges `LN_TEAMS_ALL` ("Power Rangers"), raw Dialfire campaign prefixes
  // ("POWER_RANGERS"), and clock EOD divisions ("Powerrangers") into one key.
  function teamCanonical(name) {
    return String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  // Per-agent stats broken down by team (normalized campaign name), across
  // the selected period. Feeds the Teams Reporting tab and the future
  // weekly per-team email digest.
  // Skips legacy weeks that pre-date the `by_agent_campaign` field so the
  // team breakdown stays exact — the fall-back overlap counting used by
  // `campaignsFor` would attribute an agent's calls to every campaign they
  // touch, which is wrong for a per-team-per-agent view.
  function _aggregatePerAgentPerTeam(weekSlice) {
    const agents = new Map(); // prettyName -> record
    weekSlice.forEach(week => {
      if (!week.by_agent_campaign || typeof week.by_agent_campaign !== 'object') return;
      Object.entries(week.by_agent_campaign).forEach(([agentName, perCamp]) => {
        const pretty = prettifyName(agentName);
        let entry = agents.get(pretty);
        if (!entry) {
          entry = {
            name: pretty,
            byTeam: new Map(), // canonicalKey -> { team, calls, seller, rental, email, workTime, talkTime }
            calls: 0, seller: 0, rental: 0, email: 0,
            workTime: 0, talkTime: 0,
            weeksSeen: 0,
          };
          agents.set(pretty, entry);
        }
        entry.weeksSeen += 1;
        Object.entries(perCamp).forEach(([rawCamp, st]) => {
          const team = normalizeCampaignName(rawCamp);
          const key  = teamCanonical(team);
          let tstat = entry.byTeam.get(key);
          if (!tstat) {
            tstat = { team, calls: 0, seller: 0, rental: 0, email: 0, workTime: 0, talkTime: 0 };
            entry.byTeam.set(key, tstat);
          }
          const c = st.calls    || 0;
          const s = st.seller   || 0;
          const r = st.rental   || 0;
          const em = st.email   || 0;
          const wt = st.workTime || 0;
          const tt = st.talkTime || 0;
          tstat.calls += c; tstat.seller += s; tstat.rental += r; tstat.email += em;
          tstat.workTime += wt; tstat.talkTime += tt;
          entry.calls += c; entry.seller += s; entry.rental += r; entry.email += em;
          entry.workTime += wt; entry.talkTime += tt;
        });
      });
    });
    return Array.from(agents.values());
  }

  function perAgentPerTeam(periodKey) {
    return _aggregatePerAgentPerTeam(_sliceFor(periodKey));
  }

  // Add N days to a YYYY-MM-DD string, returning a new YYYY-MM-DD.
  // Timezone-agnostic — we treat the string as a calendar date, not an instant.
  function _addDaysYmd(ymd, n) {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return dt.toISOString().slice(0, 10);
  }

  // Custom-range version: include only weeks whose entire 7-day span
  // [weekStart, weekStart+6] is fully inside [fromYmd, toYmd] (STRICT mode).
  // Using overlap-mode would contaminate the totals with days outside the
  // requested range — e.g. picking 1–30 June with the week starting 29 Jun
  // included would drag in 5 days of July stats.
  //
  // Callers get an `_range` sidecar on the returned array describing which
  // whole weeks got picked up so the UI can show "covers 1 Jun → 28 Jun · 4
  // complete weeks".
  function perAgentPerTeamRange(fromYmd, toYmd) {
    if (!fromYmd || !toYmd) return _perAgentPerTeamRangeResult([], fromYmd, toYmd);
    const [a, b] = fromYmd <= toYmd ? [fromYmd, toYmd] : [toYmd, fromYmd];
    const slice = weeks.filter(w => {
      if (!w.weekStart) return false;
      const wStart = w.weekStart;
      const wEnd = _addDaysYmd(w.weekStart, 6);
      return wStart >= a && wEnd <= b;   // strict — fully inside
    });
    return _perAgentPerTeamRangeResult(slice, a, b);
  }

  function _perAgentPerTeamRangeResult(slice, fromYmd, toYmd) {
    const rows = _aggregatePerAgentPerTeam(slice);
    // Effective range = earliest weekStart to latest weekStart+6 covered.
    // Empty slice → null so the UI can show "no complete weeks in range".
    let effFrom = null, effTo = null;
    slice.forEach(w => {
      const ws = w.weekStart;
      const we = _addDaysYmd(ws, 6);
      if (!effFrom || ws < effFrom) effFrom = ws;
      if (!effTo   || we > effTo)   effTo   = we;
    });
    rows._range = { requestedFrom: fromYmd, requestedTo: toYmd,
                    effectiveFrom: effFrom, effectiveTo: effTo,
                    weeksIncluded: slice.length };
    return rows;
  }

  // Canonical LN team roster — single source of truth is public.ln_teams
  // in the quay-clock Supabase project. See supabase/migrations/ln_teams.sql.
  //
  // The static fallback below MUST stay in sync with the seed rows in that
  // migration; it's the safety net when window.sb is missing, when the
  // fetch errors out, or when RLS blocks an unauthenticated boot. Without
  // it a network blip would empty the LN Stats team picker.
  const LN_TEAMS_FALLBACK = [
    'ASB Calling', 'Amigos', 'Assassins', 'Avengers', 'Babes', 'Ballers',
    'Bergscape', 'Betties', 'Blitz', 'Boets', 'Bulls', 'Cavaliers',
    'Chargers', 'City Sunsets', 'Clienthub', 'Conquerors', 'Dealers',
    'Dealmakers', 'Dixies', 'Dolphins', 'Donkeys', 'Dragons', 'Dutchmen',
    'Engine Room', 'Falcons', 'Farmers', 'Furys', 'Gladiators',
    'Goal Diggers', 'Gunslingers', 'Hawks', 'Headbangers', 'Hoekers',
    'Hooligans', 'Hout Baes', 'Huntsmen', 'Hustlers', 'Invincibles',
    'Jaguars', 'Knights', 'Koeksisters', 'Komorants', 'Lions', 'Llamas',
    'Musketeers', 'Panthers', 'Pirates', 'Power Rangers', 'Prom Queens',
    'Proteas', 'Raccoons', 'Rentals', 'Rockets', 'Samurais', 'Slayers',
    'Soccer Moms', 'Spartans', 'Surfers', 'Swesties', 'Targaryens',
    'Tigers', 'TNT', 'Tornadoes', 'Vikings', 'Vipers', 'Warriors',
    'Weasels', 'Wizards', 'Wolves', 'Wombats',
  ];

  async function loadLnTeams() {
    try {
      if (!window.sb || !window.sb.from) return LN_TEAMS_FALLBACK.slice();
      const { data, error } = await window.sb
        .from('ln_teams')
        .select('name, display_order')
        .eq('active', true)
        .order('display_order', { ascending: true });
      if (error) throw error;
      const names = (data || []).map(r => r && r.name).filter(Boolean);
      if (!names.length) return LN_TEAMS_FALLBACK.slice();
      return names;
    } catch (e) {
      console.warn('[data.js] ln_teams fetch failed, using static fallback:', e && e.message || e);
      return LN_TEAMS_FALLBACK.slice();
    }
  }

  const LN_TEAMS_ALL = await loadLnTeams();

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
    WEEKS, WEEK_CALLS, WEEK_SUCCESS, WEEK_LEADS, WEEK_ACTIVE, trendSeriesFor,
    SOURCES, sourcesFor, campaignsFor,
    monthlyBreakdown, weeksBreakdown,
    dailyDates, dailyFor, latestDailyDate,
    MONTHS, MONTH_CALLS, MONTH_LEADS, MONTH_EMAILS, MONTH_RENTALS, MONTH_DFHOURS,
    CLIENTHUB: clienthubData,
    clienthubTeams: (windowKey) => (clienthubData && clienthubData.windows && clienthubData.windows[windowKey]) || null,
    PERIODS, DELTAS, agentsFor, agentsForRange, totalsFor, prevTotalsFor, floorDailyAverage, weeksInMonth,
    periodElapsed, project, trailingAvg,
    agentHistory, agentCampaigns,
    perAgentPerTeam, perAgentPerTeamRange, teamCanonical, normalizeCampaignName,
    periodDateRange,
    billingPeriodWindow,
    LN_TEAMS_ALL,
  };
  return window.QUAY;
})();

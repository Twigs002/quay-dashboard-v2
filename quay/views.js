/* Quay 1 — secondary tab views (All Staff, Compare, Daily, Manager, Lead Sources) */

window.VIEWS = (function () {
  const Q = window.QUAY, I = window.ICON, C = window.CHART;
  const fmt = n => n.toLocaleString('en-ZA');
  const initials = name => name.split(' ').map(w => w[0]).slice(0, 2).join('');
  const effClass = e => e >= 70 ? 'ok' : e >= 60 ? 'warn' : 'bad';
  const sucClass = s => s >= 15 ? 'ok' : s >= 11 ? 'warn' : 'bad';

  function agentRow(a, rank, scaleMax) {
    const sc = sucClass(a.success);
    const ec = effClass(a.eff);
    // Volume bar scales to the busiest agent in the current list so the
    // bar still reads as a proportion when periods change (was hardcoded /720).
    const maxC = scaleMax && scaleMax > 0 ? scaleMax : (a.calls || 1);
    const bar = Math.min(100, (a.calls / maxC) * 100);
    const df = a.df != null ? a.df : 0;
    const ct = a.ct != null ? a.ct : 0;
    const eff = a.eff != null ? a.eff : 0;
    const ctSrc = a.ctSource === 'clock'
      ? '<span class="pill" style="background:var(--green-tint);color:var(--green);font-size:9.5px;font-weight:700;margin-left:5px;padding:1px 6px">real</span>'
      : '<span class="pill" style="background:#EEF0F6;color:var(--muted);font-size:9.5px;font-weight:700;margin-left:5px;padding:1px 6px" title="estimated DF / 0.85 — agent not in the clock data yet">est</span>';
    return `<tr data-agent="${a.name}" data-rank="${rank}" data-name="${a.name}" data-team="${a.team}" data-calls="${a.calls}" data-leads="${a.leads}" data-success="${a.success}" data-connect="${a.connect}" data-df="${df}" data-ct="${ct}" data-eff="${eff}" style="cursor:pointer">
      <td class="num" style="color:var(--muted);font-weight:700;width:40px">${rank}</td>
      <td><div class="agent-cell">
        <div class="avatar">${initials(a.name)}</div>
        <div><div class="agent-name">${a.name}</div></div>
      </div></td>
      <td><span class="pill ${a.team === 'RM' ? 'rm' : 'fancy'}">${a.team}</span></td>
      <td class="num tnum">${fmt(a.calls)}</td>
      <td class="num tnum">${fmt(a.leads)}</td>
      <td class="num"><span class="pill ${sc}">${a.success}%</span></td>
      <td class="num tnum">${a.connect}%</td>
      <td class="num tnum">${df.toFixed(1)}h</td>
      <td class="num tnum">${ct.toFixed(1)}h${ctSrc}</td>
      <td class="num"><span class="pill ${ec}">${eff}%</span></td>
      <td class="num"><div class="cell-bar"><div class="track"><span style="width:${bar}%"></span></div></div></td>
    </tr>`;
  }

  // ---------------------------------------------------- ALL STAFF
  function allStaff(period) {
    const agents = Q.agentsFor(period).slice().sort((a, b) => b.calls - a.calls);
    const scaleMax = agents.length ? agents[0].calls : 1;
    const rows = agents.map((a, i) => agentRow(a, i + 1, scaleMax)).join('');
    const cards = agents.map(a => perCallerCard(a)).join('');
    const tCalls = agents.reduce((s, a) => s + a.calls, 0);
    const tLeads = agents.reduce((s, a) => s + a.leads, 0);
    const totDf  = agents.reduce((s, a) => s + (a.df || 0), 0);
    const totCt  = agents.reduce((s, a) => s + (a.ct || 0), 0);
    const haveClock = agents.some(a => a.ctSource === 'clock');
    const avgEff = agents.length ? Math.round(agents.reduce((s, a) => s + (a.eff || 0), 0) / agents.length) : 0;
    return `
    <div class="tab-view">
      <div class="card">
        <div class="panel" style="justify-content:space-between">
          <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end">
            <div class="field"><label>From</label><input type="date" value="2026-06-01"></div>
            <div class="field"><label>To</label><input type="date" value="2026-06-05"></div>
            <div class="field"><label>Team</label><select><option>All teams</option><option>RM</option><option>Fancy</option></select></div>
            <button class="btn btn-primary">${I.filter} Apply</button>
          </div>
          <div class="seg" id="staffSeg">
            <button class="active" data-view="overall">Overall Report</button>
            <button data-view="per">Per Caller</button>
          </div>
        </div>
      </div>

      <div class="row mt" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px">
        ${miniStat('Roster size', agents.length + ' agents', 'RM + Fancy combined', I.users)}
        ${miniStat('Total calls', fmt(tCalls), 'across selected range', I.phone)}
        ${miniStat('Total leads', fmt(tLeads), 'seller · rental · email', I.target)}
        ${miniStat('Avg efficiency', avgEff + '%', 'DialFire ÷ clocked time · target ≥70%', I.bolt)}
        ${miniStat('Dialler vs clocked', totDf.toFixed(0) + 'h / ' + totCt.toFixed(0) + 'h', haveClock ? 'real data from quay-clock' : 'estimated — no clock data yet', I.clock)}
      </div>

      <div class="card mt" id="staffOverall">
        <div class="card-head">
          <div><h3>Agent-level performance</h3><div class="sub">Calls · leads · dialler vs clocked hours · efficiency · click any column to sort</div></div>
          <button class="btn js-export">${I.download} Export CSV</button>
        </div>
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr>
              <th class="num">#</th>
              <th data-sort="name|str">Agent<span class="sort-ind"></span></th>
              <th data-sort="team|str">Team<span class="sort-ind"></span></th>
              <th class="num" data-sort="calls|num">Calls<span class="sort-ind"></span></th>
              <th class="num" data-sort="leads|num">Leads<span class="sort-ind"></span></th>
              <th class="num" data-sort="success|num">Success<span class="sort-ind"></span></th>
              <th class="num" data-sort="connect|num">Connect<span class="sort-ind"></span></th>
              <th class="num" data-sort="df|num">Dialler<span class="sort-ind"></span></th>
              <th class="num" data-sort="ct|num">Clocked<span class="sort-ind"></span></th>
              <th class="num" data-sort="eff|num">Eff %<span class="sort-ind"></span></th>
              <th class="num">Volume</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>

      <div class="mt staff-cards" id="staffPerCaller" style="display:none">${cards}</div>
    </div>`;
  }

  // ---- Per-caller card (richer per-agent view from real fields) ----
  function perCallerCard(a) {
    const sc = sucClass(a.success);
    const onTarget = !!a.meetsTarget;
    const camps = (a.campaigns || []).map(c =>
      `<span class="pill" style="font-size:10.5px;padding:3px 9px;background:#EDF1F8;border-color:#D8E0EC;color:#3D5BA6">${c}</span>`
    ).join('');
    const stat = (label, value) =>
      `<div><div class="kpi-label" style="margin:0;font-size:10.5px">${label}</div>
       <div class="tnum" style="font-family:var(--serif);font-weight:700;font-size:17px;color:var(--ink);margin-top:2px">${value}</div></div>`;
    return `<div class="card card-pad pc-card" data-agent="${a.name}" style="cursor:pointer">
      <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px">
        <div class="avatar" style="width:42px;height:42px;font-size:14px">${initials(a.name)}</div>
        <div style="flex:1;min-width:0">
          <div class="agent-name" style="font-size:15.5px;line-height:1.2">${a.name}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:5px">
            <span class="pill ${a.team === 'RM' ? 'rm' : 'fancy'}" style="font-size:10px;padding:2px 8px">${a.team}</span>
            ${onTarget ? '<span class="pill ok" style="font-size:10px;padding:2px 8px">✓ on target</span>' : ''}
            <span class="pill ${sc}" style="font-size:10px;padding:2px 8px">${a.success}% success</span>
          </div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px 16px">
        ${stat('Calls', fmt(a.calls))}
        ${stat('Leads', fmt(a.leads))}
        ${stat('CPH', a.cph || '—')}
        ${stat('Dialler hrs', a.df.toFixed(1) + 'h')}
        ${stat('Work %',  (a.workPct != null ? a.workPct : 0) + '%')}
        ${stat('Talk %',  (a.talkPct != null ? a.talkPct : a.connect) + '%')}
      </div>
      ${(a.seller || a.rental || a.email) ? `
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line);display:flex;gap:18px;font-size:12px">
        <div><b style="color:var(--ink)">${fmt(a.seller)}</b> <span style="color:var(--muted)">seller</span></div>
        <div><b style="color:var(--ink)">${fmt(a.rental)}</b> <span style="color:var(--muted)">rental</span></div>
        <div><b style="color:var(--ink)">${fmt(a.email)}</b> <span style="color:var(--muted)">email</span></div>
      </div>` : ''}
      ${camps ? `<div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:5px">${camps}</div>` : ''}
    </div>`;
  }

  function miniStat(label, value, sub, icon) {
    return `<div class="card card-pad">
      <div style="display:flex;align-items:center;gap:12px">
        <div class="kpi-ic">${icon}</div>
        <div><div class="kpi-label" style="margin:0;white-space:nowrap">${label}</div>
        <div style="font-family:var(--serif);font-size:24px;font-weight:600;color:var(--ink);line-height:1.15;white-space:nowrap">${value}</div></div>
      </div>
      <div class="kpi-foot" style="margin-top:12px">${sub}</div>
    </div>`;
  }

  // ---------------------------------------------------- COMPARE
  // Month vs Month is data-driven from monthlyBreakdown(). The picker
  // defaults to (latest, latest-1); on change the table re-renders
  // in-place (no full route shell rebuild — handled in app.js segWire).
  function compare() {
    const months = (Q.monthlyBreakdown && Q.monthlyBreakdown()) || [];
    // Default selection: most recent vs the month before.
    const defA = months[0] ? months[0].key : '';
    const defB = months[1] ? months[1].key : (months[0] ? months[0].key : '');

    const monthOpts = (selected) => months.map(m =>
      `<option value="${m.key}" ${m.key === selected ? 'selected' : ''}>${m.label}</option>`).join('');

    // Week vs Week pulls from the existing PERIODS — this-week vs last-week.
    const wA = Q.totalsFor('this-week');
    const wB = Q.totalsFor('last-week');

    return `
    <div class="tab-view">
      <div class="card">
        <div class="panel" style="gap:18px;flex-wrap:wrap">
          <div class="seg" id="cmpSeg">
            <button data-cmp-mode="week" class="active">${I.calendar} Week vs Week</button>
            <button data-cmp-mode="month">${I.cal2} Month vs Month</button>
          </div>
        </div>
      </div>

      <!-- WEEK vs WEEK panel -->
      <div id="cmpWeekPanel">
        <div class="card mt">
          <div class="card-head"><div><h3>This week vs Last week</h3><div class="sub">Calls, leads & success rate</div></div></div>
          ${cmpTable([
            ['Active callers',   wA.active,        wB.active,        { kind: 'count' }],
            ['Total calls',      wA.calls,         wB.calls,         { kind: 'count' }],
            ['Total leads',      wA.leads,         wB.leads,         { kind: 'count' }],
            ['Avg success rate', wA.avgSuccess,    wB.avgSuccess,    { kind: 'pct',  suffix: '%' }],
          ], 'This week', 'Last week')}
        </div>
      </div>

      <!-- MONTH vs MONTH panel -->
      <div id="cmpMonthPanel" style="display:none">
        <div class="card mt">
          <div class="panel" style="gap:18px;flex-wrap:wrap;align-items:flex-end">
            <div class="field"><label>Month A</label>
              <select id="cmpMonthA">${monthOpts(defA)}</select>
            </div>
            <div class="field"><label>Month B</label>
              <select id="cmpMonthB">${monthOpts(defB)}</select>
            </div>
          </div>
          <div id="cmpMonthBody">${renderMonthCompare(months, defA, defB)}</div>
        </div>
      </div>
    </div>`;
  }

  // Renders just the inner month-comparison body — used both on initial
  // mount and when the month dropdowns change (wired in app.js segWire).
  function renderMonthCompare(months, keyA, keyB) {
    const lookup = new Map(months.map(m => [m.key, m]));
    const a = lookup.get(keyA);
    const b = lookup.get(keyB);
    if (!a || !b) {
      return `<div class="muted" style="padding:24px;text-align:center;font-size:13.5px">
        Pick two months to compare.
      </div>`;
    }
    return cmpTable([
      ['Weeks of data',    a.weeks,       b.weeks,       { kind: 'count' }],
      ['Active callers',   a.activeCount, b.activeCount, { kind: 'count' }],
      ['Total calls',      a.calls,       b.calls,       { kind: 'count' }],
      ['Avg success rate', a.successRate, b.successRate, { kind: 'pct',  suffix: '%' }],
      ['Avg calls/hr',     a.cph,         b.cph,         { kind: 'rate', decimals: 1 }],
      ['Seller leads',     a.seller,      b.seller,      { kind: 'count' }],
      ['Rental leads',     a.rental,      b.rental,      { kind: 'count' }],
      ['Emails collected', a.email,       b.email,       { kind: 'count' }],
      ['Dialler hours',    a.dfHours,     b.dfHours,     { kind: 'hours' }],
    ], a.label, b.label);
  }

  // One reusable table renderer for both Week and Month comparisons.
  // The Change column shows absolute delta with a unit-appropriate
  // suffix — never a misleading % on raw hours.
  function cmpTable(rows, labelA, labelB) {
    const fmtVal = (v, opts) => {
      if (opts.kind === 'pct')   return Number(v).toFixed(1) + (opts.suffix || '%');
      if (opts.kind === 'hours') return Number(v).toFixed(2) + 'h';
      if (opts.kind === 'rate')  return Number(v).toFixed(opts.decimals ?? 1);
      return fmt(Math.round(Number(v) || 0));
    };
    const fmtDelta = (av, bv, opts) => {
      const diff = Number(av) - Number(bv);
      const sign = diff > 0 ? '+' : '';
      if (opts.kind === 'pct')   return sign + diff.toFixed(1) + ' pts';
      if (opts.kind === 'hours') return sign + diff.toFixed(2) + 'h';
      if (opts.kind === 'rate')  return sign + diff.toFixed(opts.decimals ?? 1);
      return sign + fmt(Math.round(diff));
    };
    const body = rows.map(([label, av, bv, opts]) => {
      const diff = Number(av) - Number(bv);
      const cls = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
      const ic  = diff > 0 ? I.up : diff < 0 ? I.down : '';
      return `<tr>
        <td style="font-weight:600;color:var(--ink)">${label}</td>
        <td class="num tnum">${fmtVal(av, opts)}</td>
        <td class="num tnum">${fmtVal(bv, opts)}</td>
        <td class="num"><span class="delta ${cls}">${ic}${fmtDelta(av, bv, opts)}</span></td>
      </tr>`;
    }).join('');
    return `<div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Metric</th><th class="num">${labelA}</th><th class="num">${labelB}</th><th class="num">Change</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
  }

  // ---------------------------------------------------- DAILY
  // Picks a specific date and renders per-caller stats. Backed by
  // data/daily_data.json (written by the update-daily.yml workflow);
  // shows an empty-state with backfill instructions if no entry exists.
  function daily(period, selectedDate) {
    const available = (Q.dailyDates || []).slice();
    const date = selectedDate || (available[0] || null);
    const agents = (Q.dailyFor && date) ? (Q.dailyFor(date) || []) : [];
    const scaleMax = agents.length ? agents[0].calls : 1;
    const rows = agents.map((a, i) => agentRow(a, i + 1, scaleMax)).join('');
    const totCalls = agents.reduce((s, a) => s + a.calls, 0);
    const totLeads = agents.reduce((s, a) => s + a.leads, 0);

    // Friendly label "Thursday · 5 June 2026"
    const labelFor = (ymd) => {
      if (!ymd) return '—';
      const d = new Date(ymd + 'T00:00:00Z');
      const weekday = d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
      const day = d.getUTCDate();
      const month = d.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
      const year = d.getUTCFullYear();
      return `${weekday} · ${day} ${month} ${year}`;
    };
    const prettyDate = labelFor(date);

    // The empty-state message when no data exists for the picked date
    // OR when the daily fetcher has never run.
    const emptyMsg = !available.length
      ? `No per-day data yet — the <code>update-daily.yml</code> workflow needs to populate <code>data/daily_data.json</code>. ` +
        `Trigger it manually with a start_date / end_date in GitHub Actions, or wait for the daily 06:00 SAST cron.`
      : `No data captured for <b>${escapeHtml(prettyDate)}</b>. ` +
        `The most recent date with stats is <b>${available[0]}</b>.`;

    return `
    <div class="tab-view">
      <div class="card">
        <div class="panel" style="justify-content:space-between">
          <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
            <div class="field">
              <label>Date</label>
              <input id="dailyDate" type="date" value="${date || ''}" ${available.length ? `min="${available[available.length - 1]}" max="${available[0]}"` : ''}>
            </div>
            <button class="btn" data-daily-jump="today">Today</button>
            <button class="btn" data-daily-jump="yesterday">Yesterday</button>
            <button class="btn" data-daily-step="-1">${'◀'} Prev day</button>
            <button class="btn" data-daily-step="1">Next day ${'▶'}</button>
          </div>
          <button class="btn js-export">${I.download} Export CSV</button>
        </div>
      </div>
      <div class="row g-3 mt">
        ${miniStat('Calls', fmt(totCalls), prettyDate, I.phone)}
        ${miniStat('Leads', fmt(totLeads), 'seller · rental · email', I.target)}
        ${miniStat('Active callers', agents.length + '', 'logged dialling time', I.users)}
      </div>
      <div class="card mt">
        <div class="card-head"><div><h3>Per-caller performance — ${escapeHtml(prettyDate)}</h3><div class="sub">${available.length} day${available.length === 1 ? '' : 's'} of history available</div></div></div>
        ${agents.length ? `
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th class="num">#</th><th>Agent</th><th>Team</th><th class="num">Calls</th><th class="num">Leads</th><th class="num">Success</th><th class="num">Connect</th><th class="num">Dialler</th><th class="num">Clocked</th><th class="num">Eff %</th><th class="num">Volume</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
        ` : `<div class="muted" style="padding:24px;text-align:center;font-size:13.5px;line-height:1.6">${emptyMsg}</div>`}
      </div>
      <!-- End-of-day reports submitted on this date (populated by app.js after mount) -->
      <div class="mt" id="dailyReportsHost" data-daily-date="${date || ''}"></div>
    </div>`;
  }

  // Tiny local helper used by the daily empty-state msg.
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // ---------------------------------------------------- MANAGER
  function manager(period) {
    period = period || 'this-week';
    // Real campaign data — the same source the Lead Sources tab uses.
    const camps = (Q.campaignsFor(period) || []).slice().sort((a, b) => b.calls - a.calls);
    const totals = camps.reduce((t, c) => {
      t.calls += c.calls || 0;
      t.seller += c.seller || 0;
      t.rental += c.rental || 0;
      t.email += c.email || 0;
      t.leads += c.leads || 0;
      return t;
    }, { calls: 0, seller: 0, rental: 0, email: 0, leads: 0 });
    const rows = camps.map((c, i) => {
      const conv = c.conv != null ? c.conv : (c.calls ? +((c.leads / c.calls) * 100).toFixed(1) : 0);
      const cv = conv >= 12 ? 'ok' : conv >= 7 ? 'warn' : 'bad';
      return `<tr>
        <td class="num" style="color:var(--muted);font-weight:700;width:40px">${i + 1}</td>
        <td><div class="agent-cell">
          <span style="width:11px;height:11px;border-radius:3px;background:${c.color || '#3D5BA6'};display:inline-block"></span>
          <span class="agent-name">${c.name}</span></div></td>
        <td class="num tnum">${fmt(c.calls || 0)}</td>
        <td class="num tnum">${fmt(c.seller || 0)}</td>
        <td class="num tnum">${fmt(c.rental || 0)}</td>
        <td class="num tnum">${fmt(c.email || 0)}</td>
        <td class="num"><span class="pill ${cv}">${conv}%</span></td>
      </tr>`;
    }).join('');
    const totalRow = camps.length ? `<tr style="background:var(--paper);font-weight:700">
      <td></td>
      <td style="color:var(--ink)">All campaigns</td>
      <td class="num tnum">${fmt(totals.calls)}</td>
      <td class="num tnum">${fmt(totals.seller)}</td>
      <td class="num tnum">${fmt(totals.rental)}</td>
      <td class="num tnum">${fmt(totals.email)}</td>
      <td class="num tnum">${totals.calls ? +((totals.leads / totals.calls) * 100).toFixed(1) : 0}%</td>
    </tr>` : '';
    const periodLabel = (Q.PERIODS[period] && Q.PERIODS[period].label) || period;

    // ---- Monthly graphs --------------------------------------------------
    // Re-uses the Operational Overview's miniCard painter (.mc el is wired
    // by managerWire() in app.js after this view mounts).
    const monthCard = (label, icon, series, color, unit) => {
      const last = series[series.length - 1], prev = series[series.length - 2] || 1;
      const pct = (((last - prev) / prev) * 100).toFixed(1);
      const up  = last >= prev;
      return `<div class="card mini">
        <div class="mini-head">${icon} ${label} by month</div>
        <div class="mini-sub">last 8 months</div>
        <div class="mini-val tnum">${fmt(last)}${unit || ''}<span style="color:${up ? 'var(--green)' : 'var(--red)'}">${up ? '▲' : '▼'} ${Math.abs(pct)}%</span></div>
        <div style="margin-top:10px" class="mc" data-series='${JSON.stringify(series)}' data-color="${color}"></div>
      </div>`;
    };
    const monthlyGraphs = `
      <div class="card mt card-pad">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:14px">
          <div><h3 style="margin:0">Monthly trends</h3><div class="sub">Last 8 months across the engine room · ${Q.MONTHS[0]} → ${Q.MONTHS[Q.MONTHS.length - 1]}</div></div>
        </div>
        <div class="row mini-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px">
          ${monthCard('Calls',   I.phone,  Q.MONTH_CALLS,   '#3D5BA6')}
          ${monthCard('Leads',   I.target, Q.MONTH_LEADS,   '#B98A02')}
          ${monthCard('Rentals', I.home,   Q.MONTH_RENTALS, '#4C6BB8')}
          ${monthCard('Emails',  I.mail,   Q.MONTH_EMAILS,  '#2E6FB0')}
        </div>
      </div>`;
    return `
    <div class="tab-view">
      ${monthlyGraphs}
      <div class="mt" id="managerFlagsHost"></div>
      <div class="card mt">
        <div class="card-head">
          <div><h3>Campaign performance · ${periodLabel}</h3>
            <div class="sub">${camps.length} campaign${camps.length === 1 ? '' : 's'} with activity · ranked by calls done</div></div>
          <button class="btn js-export">${I.download} Export CSV</button>
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th class="num" style="width:40px">#</th>
            <th>Campaign</th>
            <th class="num">Calls done</th>
            <th class="num">Seller leads</th>
            <th class="num">Rental leads</th>
            <th class="num">Emails</th>
            <th class="num">Conv.</th>
          </tr></thead>
          <tbody>
            ${rows || `<tr><td colspan="7" class="muted" style="text-align:center;padding:30px">No campaign activity for ${periodLabel.toLowerCase()} yet.</td></tr>`}
            ${totalRow}
          </tbody>
        </table></div>
      </div>
    </div>`;
  }

  // ---------------------------------------------------- LEAD SOURCES (now: Campaigns)
  function leadSources(period) {
    const camps = Q.campaignsFor(period || 'this-week');
    if (!camps.length) {
      return `<div class="tab-view"><div class="card card-pad">
        <h3 style="font-family:var(--serif);margin:0 0 8px">No campaign data</h3>
        <div class="sub">No campaigns found for this period.</div></div></div>`;
    }
    const totalCalls = camps.reduce((s, c) => s + c.calls, 0);
    const totalLeads = camps.reduce((s, c) => s + c.leads, 0);
    const totalEmails = camps.reduce((s, c) => s + c.email, 0);
    const totalSeller = camps.reduce((s, c) => s + c.seller, 0);
    const totalRental = camps.reduce((s, c) => s + c.rental, 0);
    const maxCalls = camps[0].calls || 1;
    const best = camps.slice().sort((a, b) => b.conv - a.conv)[0];

    const rows = camps.map((c, i) => {
      const conv = c.conv;
      const pill = conv >= 12 ? 'ok' : conv >= 7 ? 'warn' : 'bad';
      const bar = (c.calls / maxCalls) * 100;
      return `<tr>
        <td class="num" style="font-weight:700;color:var(--muted);width:40px">${i + 1}</td>
        <td><div class="agent-cell">
          <span style="width:11px;height:11px;border-radius:3px;background:${c.color};display:inline-block"></span>
          <span class="agent-name">${c.name}</span></div></td>
        <td class="num tnum">${c.agentsCount}</td>
        <td class="num tnum">${fmt(c.calls)}</td>
        <td class="num tnum">${fmt(c.leads)}</td>
        <td class="num tnum">${fmt(c.seller)}</td>
        <td class="num tnum">${fmt(c.rental)}</td>
        <td class="num tnum">${fmt(c.email)}</td>
        <td class="num"><span class="pill ${pill}">${conv}%</span></td>
        <td class="num"><div class="cell-bar"><div class="track"><span style="width:${bar}%;background:${c.color}"></span></div></div></td>
      </tr>`;
    }).join('');

    return `
    <div class="tab-view">
      <div class="row" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px">
        ${miniStat('Best converter', best.name, best.conv + '% (' + fmt(best.leads) + ' / ' + fmt(best.calls) + ')', I.star)}
        ${miniStat('Seller leads', fmt(totalSeller), 'across all campaigns', I.medal)}
        ${miniStat('Rental leads', fmt(totalRental), 'across all campaigns', I.home)}
        ${miniStat('Email leads',  fmt(totalEmails), 'across all campaigns', I.mail)}
        ${miniStat('Campaigns running', camps.length + '', best.agentsCount + ' agents on top campaign', I.layers)}
      </div>

      <div class="row g-2-1 mt">
        <div class="card">
          <div class="card-head"><div><h3>Campaign performance</h3>
            <div class="sub">Ranked by call volume · ${Q.PERIODS[period || 'this-week'].label} · variants like SURFERS_NA + SURFERS_CM are grouped</div></div>
            <button class="btn js-export">${I.download} Export CSV</button></div>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr>
              <th class="num">#</th><th>Campaign</th>
              <th class="num">Agents</th><th class="num">Calls</th>
              <th class="num">Leads</th><th class="num">Seller</th>
              <th class="num">Rental</th><th class="num">Email</th>
              <th class="num">Conv.</th><th class="num">Volume</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
        </div>

        <div class="card card-pad">
          <div class="eyebrow">${camps[0].exact ? I.check : I.alert} About these numbers</div>
          ${camps[0].exact ? `
            <p style="font-size:12.5px;color:var(--slate);line-height:1.7;margin-top:10px">
              <b style="color:var(--green)">Exact attribution.</b>
              The Dialfire fetcher now stores per-agent stats per campaign, so
              when an agent works multiple campaigns each row reflects only
              the calls/leads they made on that specific campaign.
            </p>` : `
            <p style="font-size:12.5px;color:var(--slate);line-height:1.7;margin-top:10px">
              Each agent's call/lead/email totals appear under <b>every campaign they're tagged on</b>.
              When agents work multiple campaigns, the per-campaign rows
              <b>over-count</b>. (Historical week — pre-dates the per-campaign breakdown.)
            </p>`}
          <p style="font-size:12.5px;color:var(--slate);line-height:1.7;margin-top:10px">
            Variants like <code>SURFERS_NA</code>, <code>SURFERS_CM</code> and <code>SURFERS</code> are merged into one <b>SURFERS</b> row.
          </p>
          <div style="font-size:12.5px;color:var(--slate);line-height:1.7;margin-top:14px">
            <b style="color:var(--ink)">Period totals:</b><br>
            ${fmt(totalCalls)} calls · ${fmt(totalLeads)} leads · ${fmt(totalEmails)} emails
          </div>
        </div>
      </div>
    </div>`;
  }

  // ---------------------------------------------------- MONTHLY BREAKDOWN
  // One row per calendar month — newest-first. Matches the
  // "Monthly Breakdown — All Time" pattern from the management dashboard
  // so the two surfaces line up.
  function monthly() {
    const rows = Q.monthlyBreakdown ? Q.monthlyBreakdown() : [];
    const srPill = sr => sr >= 18 ? 'ok' : sr >= 14 ? 'warn' : 'bad';

    const body = rows.length ? rows.map(r => `
      <tr data-month-row="${r.key}" class="month-row">
        <td><a href="#" class="month-link" data-month-key="${r.key}">
          <span class="month-caret" aria-hidden="true">▸</span> ${r.label}
        </a></td>
        <td class="muted">${r.weeks} week${r.weeks === 1 ? '' : 's'}</td>
        <td>
          <span class="pill" style="background:#E7EEF4;color:var(--blue);font-size:11px;padding:3px 9px">${r.rmCount} RMs</span>
          <span class="pill" style="background:#F3EBF8;color:#5A4FCF;font-size:11px;padding:3px 9px;margin-left:6px">${r.fancyCount} Fancy</span>
        </td>
        <td class="num tnum" style="font-weight:700">${fmt(r.calls)}</td>
        <td class="num"><span class="pill ${srPill(r.successRate)}">${r.successRate}%</span></td>
        <td class="num tnum">${fmt(r.seller)}</td>
        <td class="num tnum">${fmt(r.rental)}</td>
        <td class="num tnum">${fmt(r.email)}</td>
      </tr>
      <tr data-month-detail="${r.key}" style="display:none;background:#FAFBFC">
        <td colspan="8" style="padding:0">
          <div class="month-weeks-host" data-month-key="${r.key}"></div>
        </td>
      </tr>`).join('') : `
      <tr><td colspan="8" class="muted" style="text-align:center;padding:34px">
        No monthly data yet — backfill needs to land first.
      </td></tr>`;

    return `
    <div class="tab-view">
      <div class="card">
        <div class="card-head">
          <div><h3>Monthly Breakdown · All Time</h3>
            <div class="sub">Aggregated from every week of DialFire history we have</div>
          </div>
          <button class="btn js-export">${I.download} Export CSV</button>
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th>Month</th>
            <th>Weeks</th>
            <th>Callers</th>
            <th class="num">Total Calls</th>
            <th class="num">Success Rate</th>
            <th class="num">Seller Leads</th>
            <th class="num">Rental Leads</th>
            <th class="num">Emails</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table></div>
      </div>
    </div>`;
  }

  // Per-week breakdown table for the Monthly tab's drill-down.
  function monthWeeksTable(monthKey) {
    const weeks = (Q.weeksInMonth && Q.weeksInMonth(monthKey)) || [];
    if (!weeks.length) {
      return `<div class="muted" style="padding:18px;text-align:center;font-size:13px">
        No weekly data for this month.
      </div>`;
    }
    const srPill = sr => sr >= 18 ? 'ok' : sr >= 14 ? 'warn' : 'bad';
    const body = weeks.map(w => `
      <tr>
        <td style="font-weight:600;color:var(--ink)">${w.label}</td>
        <td class="num tnum">${w.activeCount}</td>
        <td class="num tnum" style="font-weight:700">${fmt(w.calls)}</td>
        <td class="num"><span class="pill ${srPill(w.successRate)}">${w.successRate}%</span></td>
        <td class="num tnum">${w.cph}</td>
        <td class="num tnum">${fmt(w.seller)}</td>
        <td class="num tnum">${fmt(w.rental)}</td>
        <td class="num tnum">${fmt(w.email)}</td>
        <td class="num tnum">${w.dfHours.toFixed(2)}h</td>
      </tr>`).join('');
    return `<div style="padding:14px 18px">
      <div class="sub" style="font-size:12px;margin-bottom:8px">Per-week breakdown</div>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr>
          <th>Week of</th>
          <th class="num">Callers</th>
          <th class="num">Calls</th>
          <th class="num">Success</th>
          <th class="num">CPH</th>
          <th class="num">Seller</th>
          <th class="num">Rental</th>
          <th class="num">Emails</th>
          <th class="num">Dialler hrs</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </div>`;
  }

  return { allStaff, compare, daily, manager, leadSources, monthly, renderMonthCompare, monthWeeksTable };
})();

/* Quay 1 — app shell, Overview, navigation + period state */

(function () {
  const Q = window.QUAY, I = window.ICON, C = window.CHART, V = window.VIEWS;
  const CFG = window.QUAY_CONFIG || {};
  const fmt = n => n.toLocaleString('en-ZA');
  const initials = name => name.split(' ').map(w => w[0]).slice(0, 2).join('');

  let period = 'this-week';
  let tab = 'leadership';
  // nav preference: 'auto' (collapse on narrow), 'open' (force expanded), 'collapsed' (force rail)
  let navPref = localStorage.getItem('q1nav') || 'auto';
  const AUTO_BP = 1080;
  const navCollapsed = () =>
    navPref === 'open' ? false : navPref === 'collapsed' ? true : window.innerWidth < AUTO_BP;

  const TABS = [
    { id: 'leadership', label: 'Leadership',     icon: I.medal,    title: 'Leadership Overview',  sub: 'Strategic snapshot for directors · revenue, targets, red flags' },
    { id: 'overview',   label: 'Overview',       icon: I.trophy,   title: 'Operational Overview', sub: 'A single view of call-floor performance' },
    { id: 'staff',      label: 'All Staff',      icon: I.calendar, title: 'All Staff Report',     sub: 'Drill into agent-level performance' },
    { id: 'compare',    label: 'Compare',        icon: I.scale,    title: 'Period Comparison',    sub: 'Week vs week · month vs month' },
    { id: 'worktime',   label: 'Work Time',      icon: I.clock,    title: 'Work Time & Efficiency', sub: 'DialFire dialler time vs clocked-in time' },
    { id: 'daily',      label: 'Daily Stats',    icon: I.cal2,     title: 'Daily Stats',          sub: 'Per-caller performance for a single day' },
    { id: 'manager',    label: 'Manager Reports',icon: I.chart,    title: 'Manager Reports',      sub: 'Filter by date range and campaign' },
    { id: 'sources',    label: 'Lead Sources',   icon: I.target,   title: 'Lead Source Efficacy', sub: 'Which source converts best' },
  ];

  // ---------------------------------------------------- SHELL
  function shell() {
    const navItems = TABS.map(t => `
      <button class="nav-item ${t.id === tab ? 'active' : ''}" data-tab="${t.id}" title="${t.label}">
        ${t.icon}<span>${t.label}</span>
      </button>`).join('');
    document.getElementById('app').innerHTML = `
      <aside class="sidebar">
        <div class="brand">
          <img class="brand-logo" src="quay/quay1-logo-crop.png" alt="Quay 1 International Realty">
          <div class="brand-mini">Q1</div>
        </div>
        <nav class="nav">
          <div class="nav-label">Performance</div>
          ${navItems}
        </nav>
        <div class="sidebar-foot">
          <span class="live-dot"></span><span class="foot-text">Live · synced 4 min ago</span>
          <div class="foot-tag">Navigating Success</div>
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <div class="topbar-left">
            <button class="nav-toggle" id="navToggle" aria-label="Collapse sidebar" title="Collapse sidebar">${I.panel}</button>
            <div class="topbar-titles"><h1 id="tabTitle"></h1><p id="tabSub"></p></div>
          </div>
          <div class="topbar-right">
            <div class="period" id="period">
              ${Object.entries(Q.PERIODS).map(([k, p]) =>
                `<button data-period="${k}" class="${k === period ? 'active' : ''}">${p.label}</button>`).join('')}
            </div>
            <button class="btn" id="btnPrint" title="Print / save as PDF">${I.print} Print</button>
            <button class="btn btn-primary" id="btnExport" title="Download current tab as CSV">${I.download} Export CSV</button>
          </div>
        </header>
        <div class="content" id="content"></div>
      </main>`;

    document.querySelectorAll('.nav-item').forEach(b =>
      b.addEventListener('click', () => { tab = b.dataset.tab; shell(); }));
    document.querySelectorAll('#period button').forEach(b =>
      b.addEventListener('click', () => { period = b.dataset.period; shell(); }));
    document.getElementById('btnPrint').addEventListener('click', () => window.print());
    document.getElementById('btnExport').addEventListener('click', exportCurrentTab);

    const appEl = document.getElementById('app');
    const tbtn = document.getElementById('navToggle');
    const syncNav = () => {
      const c = navCollapsed();
      appEl.classList.toggle('nav-collapsed', c);
      tbtn.title = c ? 'Expand sidebar' : 'Collapse sidebar';
    };
    syncNav();
    tbtn.addEventListener('click', () => {
      const want = !navCollapsed();                 // desired collapsed state
      const auto = window.innerWidth < AUTO_BP;
      navPref = (want === auto) ? 'auto' : (want ? 'collapsed' : 'open');
      localStorage.setItem('q1nav', navPref);
      syncNav();
    });
    // auto-respond to viewport changes while in 'auto' mode
    if (!window.__q1resize) {
      window.__q1resize = true;
      window.addEventListener('resize', () => {
        if (navPref !== 'auto') return;
        const app = document.getElementById('app');
        const tb = document.getElementById('navToggle');
        if (!app || !tb) return;
        const c = navCollapsed();
        app.classList.toggle('nav-collapsed', c);
        tb.title = c ? 'Expand sidebar' : 'Collapse sidebar';
      });
    }

    const meta = TABS.find(t => t.id === tab);
    document.getElementById('tabTitle').textContent = meta.title;
    document.getElementById('tabSub').textContent = meta.sub;
    // Stamp print-time metadata used by the @media print header strip
    document.body.dataset.printTitle  = meta.title;
    document.body.dataset.printPeriod = (Q.PERIODS[period] || {}).label || period;
    document.body.dataset.printDate   = new Date().toLocaleDateString('en-ZA',
      { day: '2-digit', month: 'short', year: 'numeric' });
    render();
  }

  // ---------------------------------------------------- ROUTER
  function render() {
    const host = document.getElementById('content');
    if (tab === 'leadership')    { host.innerHTML = leadership(); afterLeadership(); }
    else if (tab === 'overview') { host.innerHTML = overview(); afterOverview(); }
    else if (tab === 'staff')    { host.innerHTML = V.allStaff(period); staffWire(); }
    else if (tab === 'compare')  { host.innerHTML = V.compare(); segWire(); }
    else if (tab === 'worktime') host.innerHTML = V.workTime(period);
    else if (tab === 'daily')    host.innerHTML = V.daily(period);
    else if (tab === 'manager')  host.innerHTML = V.manager();
    else if (tab === 'sources')  host.innerHTML = V.leadSources(period);
    host.scrollTop = 0;
  }
  function segWire() {
    document.querySelectorAll('.seg').forEach(seg =>
      seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      })));
  }
  function staffWire() {
    const seg = document.getElementById('staffSeg');
    const overall = document.getElementById('staffOverall');
    const per = document.getElementById('staffPerCaller');
    if (!seg || !overall || !per) return;
    seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      seg.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const view = b.dataset.view;
      overall.style.display = view === 'overall' ? '' : 'none';
      per.style.display     = view === 'per'     ? 'grid' : 'none';
    }));
    sortableWire(document.getElementById('staffOverall'));
    wireAgentClicks();
  }

  // ---- Sortable tables: th[data-sort="key|type"] makes a header sortable.
  //  type: 'num' (numeric) or 'str' (string). Click toggles asc/desc.
  function sortableWire(root) {
    if (!root) return;
    root.querySelectorAll('th[data-sort]').forEach(th => {
      th.style.cursor = 'pointer';
      th.title = 'Click to sort';
      th.addEventListener('click', () => {
        const [key, type] = th.dataset.sort.split('|');
        const dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
        const tbody = root.querySelector('tbody');
        if (!tbody) return;
        const rows = [...tbody.querySelectorAll('tr')];
        rows.sort((a, b) => {
          const av = a.dataset[key] ?? '';
          const bv = b.dataset[key] ?? '';
          if (type === 'num') {
            return (dir === 'asc' ? 1 : -1) * (parseFloat(av) - parseFloat(bv));
          }
          return (dir === 'asc' ? 1 : -1) * String(av).localeCompare(String(bv));
        });
        // Re-rank the leftmost cell if it contains a rank number
        rows.forEach((r, i) => {
          const rank = r.querySelector('td:first-child .medal, td:first-child');
          if (rank && /^\d+$/.test((rank.textContent || '').trim())) {
            rank.textContent = i + 1;
          }
        });
        rows.forEach(r => tbody.appendChild(r));
        root.querySelectorAll('th[data-sort]').forEach(x => x.dataset.dir = '');
        root.querySelectorAll('th[data-sort] .sort-ind').forEach(s => s.textContent = '');
        th.dataset.dir = dir;
        const ind = th.querySelector('.sort-ind');
        if (ind) ind.textContent = dir === 'asc' ? ' ▲' : ' ▼';
      });
    });
  }
  // ---------------------------------------------------- AGENT DRILL-DOWN
  function openAgentModal(name) {
    const all = Q.agentsFor(period);
    const a = all.find(x => x.name === name);
    if (!a) return;
    const hist = Q.agentHistory(name).slice(-12);  // last 12 weeks present
    const camps = Q.agentCampaigns(name, period);
    const onTarget = !!a.meetsTarget;
    const sc = a.success >= 15 ? 'ok' : a.success >= 11 ? 'warn' : 'bad';
    const totals = camps.reduce((s, c) => ({
      calls: s.calls + c.calls, leads: s.leads + c.leads,
      seller: s.seller + c.seller, rental: s.rental + c.rental, email: s.email + c.email
    }), { calls: 0, leads: 0, seller: 0, rental: 0, email: 0 });

    const campRows = camps.length ? camps.map(c => {
      const conv = c.calls ? ((c.leads / c.calls) * 100).toFixed(1) : '0.0';
      return `<tr>
        <td>${c.name}</td>
        <td class="num tnum">${fmt(c.calls)}</td>
        <td class="num tnum">${fmt(c.leads)}</td>
        <td class="num"><span class="pill ${conv >= 15 ? 'ok' : conv >= 10 ? 'warn' : 'bad'}">${conv}%</span></td>
      </tr>`;
    }).join('') : `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:18px">No per-campaign breakdown for this period (week pre-dates the new fetcher field).</td></tr>`;

    const r = a._raw || {};
    const wt = r.workTime || 0;
    const pct = (n) => wt > 0 ? Math.round((n || 0) / wt * 100) : 0;
    const talkP = pct(r.talkTime), wrapP = pct(r.wrapTime), waitP = pct(r.waitTime);

    const html = `
      <div class="modal-backdrop" id="agentModalBackdrop"></div>
      <div class="modal" id="agentModal">
        <div class="modal-head">
          <div style="display:flex;align-items:center;gap:14px">
            <div class="avatar" style="width:46px;height:46px;font-size:15px">${initials(a.name)}</div>
            <div>
              <div style="font-family:var(--serif);font-size:22px;font-weight:700;color:var(--ink)">${a.name}</div>
              <div style="display:flex;gap:6px;margin-top:5px;flex-wrap:wrap">
                <span class="pill ${a.team === 'RM' ? 'rm' : 'fancy'}" style="font-size:10.5px">${a.team}</span>
                <span class="pill ${sc}" style="font-size:10.5px">${a.success}% success</span>
                ${onTarget ? '<span class="pill ok" style="font-size:10.5px">✓ on target</span>' : ''}
              </div>
            </div>
          </div>
          <button class="btn modal-close" id="agentModalClose">✕ Close</button>
        </div>
        <div class="modal-body">
          <div class="row g-3">
            <div class="card card-pad"><div class="kpi-label" style="margin:0">Calls (${Q.PERIODS[period].label})</div><div style="font-family:var(--serif);font-size:24px;font-weight:700;color:var(--ink);margin-top:4px">${fmt(a.calls)}</div></div>
            <div class="card card-pad"><div class="kpi-label" style="margin:0">Leads</div><div style="font-family:var(--serif);font-size:24px;font-weight:700;color:var(--ink);margin-top:4px">${fmt(a.leads)}</div></div>
            <div class="card card-pad"><div class="kpi-label" style="margin:0">Dialler hrs</div><div style="font-family:var(--serif);font-size:24px;font-weight:700;color:var(--ink);margin-top:4px">${a.df.toFixed(1)}h</div></div>
            <div class="card card-pad"><div class="kpi-label" style="margin:0">CPH</div><div style="font-family:var(--serif);font-size:24px;font-weight:700;color:var(--ink);margin-top:4px">${a.cph || '—'}</div></div>
          </div>

          <div class="row g-2-1 mt">
            <div class="card">
              <div class="card-head"><div><h3>Weekly trend</h3><div class="sub">Last ${hist.length} weeks · calls + success rate</div></div></div>
              <div class="chart-wrap"><div id="agentTrend"></div></div>
            </div>
            <div class="card card-pad">
              <h3 style="font-family:var(--serif);margin:0 0 12px;font-size:16px">Time breakdown</h3>
              ${timeRow('Talk', talkP, 'var(--blue)')}
              ${timeRow('Wrap-up', wrapP, 'var(--amber)')}
              ${timeRow('Wait',    waitP, '#9AA3AD')}
              <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--line);font-size:12.5px;color:var(--slate);line-height:1.7">
                <b style="color:var(--ink)">Leads breakdown</b><br>
                Seller <b class="tnum" style="color:var(--ink)">${fmt(a.seller || 0)}</b> ·
                Rental <b class="tnum" style="color:var(--ink)">${fmt(a.rental || 0)}</b> ·
                Email <b class="tnum" style="color:var(--ink)">${fmt(a.email || 0)}</b>
              </div>
            </div>
          </div>

          <div class="card mt">
            <div class="card-head"><div><h3>Per-campaign breakdown</h3>
              <div class="sub">${camps.length ? `${camps.length} campaigns · totals: ${fmt(totals.calls)} calls / ${fmt(totals.leads)} leads` : 'No data'}</div></div></div>
            <div class="tbl-wrap"><table class="tbl">
              <thead><tr><th>Campaign</th><th class="num">Calls</th><th class="num">Leads</th><th class="num">Conv.</th></tr></thead>
              <tbody>${campRows}</tbody>
            </table></div>
          </div>

          ${(a.campaigns || []).length ? `<div style="margin-top:16px;display:flex;flex-wrap:wrap;gap:6px">
            ${a.campaigns.map(c => `<span class="pill" style="font-size:10.5px;padding:3px 9px;background:#EDF1F8;border-color:#D8E0EC;color:#3D5BA6">${c}</span>`).join('')}
          </div>` : ''}
        </div>
      </div>`;

    let mount = document.getElementById('agentModalMount');
    if (!mount) {
      mount = document.createElement('div');
      mount.id = 'agentModalMount';
      document.body.appendChild(mount);
    }
    mount.innerHTML = html;
    document.body.style.overflow = 'hidden';

    const close = () => {
      mount.innerHTML = '';
      document.body.style.overflow = '';
      document.removeEventListener('keydown', escClose);
    };
    const escClose = e => { if (e.key === 'Escape') close(); };
    document.getElementById('agentModalClose').addEventListener('click', close);
    document.getElementById('agentModalBackdrop').addEventListener('click', close);
    document.addEventListener('keydown', escClose);

    // Render the trend chart
    const labels = hist.map(h => {
      const d = new Date(h.weekStart + 'T00:00:00Z');
      return (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
    });
    const calls = hist.map(h => h.calls);
    const succ  = hist.map(h => h.success);
    if (calls.length) {
      C.weeklyTrend(document.getElementById('agentTrend'), labels, calls, succ);
    }
  }

  function timeRow(label, pct, color) {
    return `<div style="margin-top:10px">
      <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:5px">
        <span style="color:var(--slate);font-weight:600">${label}</span>
        <span class="tnum" style="color:var(--ink);font-weight:700">${pct}%</span>
      </div>
      <div class="eff-track"><span style="width:${Math.min(100, pct)}%;background:${color}"></span></div>
    </div>`;
  }

  // ---------------------------------------------------- EXPORT (CSV)
  function exportCurrentTab() {
    const stamp = new Date().toISOString().slice(0, 10);
    const periodLabel = (Q.PERIODS[period] || {}).label || period;
    const safe = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const filename = `quay-${tab}-${safe(periodLabel)}-${stamp}.csv`;
    let rows;
    if (tab === 'sources')         rows = csvCampaigns();
    else if (tab === 'compare')    rows = csvCompare();
    else if (tab === 'manager')    rows = csvManager();
    else                            rows = csvAgents();
    downloadCSV(filename, rows);
  }

  function csvAgents() {
    const agents = Q.agentsFor(period);
    const header = ['Name', 'Team', 'Calls', 'Leads', 'Success %', 'Connect %',
      'CPH', 'Dialler hrs', 'Talk hrs', 'Seller', 'Rental', 'Email',
      'Meets target', 'Campaigns'];
    const out = [header];
    agents.forEach(a => out.push([
      a.name, a.team, a.calls, a.leads, a.success, a.connect,
      a.cph || 0, a.df, (a.talkMin / 60).toFixed(2),
      a.seller || 0, a.rental || 0, a.email || 0,
      a.meetsTarget ? 'yes' : 'no',
      (a.campaigns || []).join('; '),
    ]));
    return out;
  }
  function csvCampaigns() {
    const camps = Q.campaignsFor(period);
    const header = ['Campaign', 'Agents', 'Calls', 'Leads', 'Seller', 'Rental',
      'Email', 'Conversion %', 'Attribution'];
    const out = [header];
    camps.forEach(c => out.push([
      c.name, c.agentsCount, c.calls, c.leads, c.seller, c.rental, c.email,
      c.conv, c.exact ? 'exact' : 'overlap',
    ]));
    return out;
  }
  function csvCompare() {
    const totals = key => Q.totalsFor(key);
    const a = totals('this-week'), b = totals('last-week');
    const header = ['Metric', 'This Week', 'Last Week', 'Δ'];
    const delta = (x, y) => y ? +(((x - y) / y) * 100).toFixed(1) + ' %' : '—';
    return [header,
      ['Total calls', a.calls, b.calls, delta(a.calls, b.calls)],
      ['Total leads', a.leads, b.leads, delta(a.leads, b.leads)],
      ['Avg success rate %', a.avgSuccess, b.avgSuccess, (a.avgSuccess - b.avgSuccess).toFixed(1) + ' pts'],
      ['Active callers', a.active, b.active, (a.active - b.active)],
    ];
  }
  function csvManager() {
    // Manager tab currently shows campaign data; reuse the campaign CSV.
    return csvCampaigns();
  }

  function downloadCSV(filename, rows) {
    const esc = v => {
      const s = (v == null ? '' : String(v));
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = rows.map(r => r.map(esc).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }

  // ---------------------------------------------------- OVERVIEW
  function overview() {
    const t = Q.totalsFor(period);
    const d = Q.DELTAS[period];
    const agents = Q.agentsFor(period).slice().sort((a, b) => b.calls - a.calls);
    const top = agents[0];
    const src = Q.SOURCES.slice().sort((a, b) => b.conv - a.conv);
    const bestSrc = src[0];
    const risk = agents.slice().sort((a, b) => a.success - b.success)[0];

    const kpi = (icon, label, val, deltaVal, foot) => {
      const cls = deltaVal > 0 ? 'up' : deltaVal < 0 ? 'down' : 'flat';
      const ic = deltaVal > 0 ? I.up : deltaVal < 0 ? I.down : '';
      const dtxt = deltaVal === 0 ? 'no change' : Math.abs(deltaVal) + (label.includes('Rate') ? ' pts' : '%');
      return `<div class="card kpi">
        <div class="kpi-top"><div class="kpi-ic">${icon}</div>
          <span class="delta ${cls}">${ic}${dtxt}</span></div>
        <div class="kpi-label">${label}</div>
        <div class="kpi-val tnum">${val}</div>
        <div class="kpi-foot">${foot}</div>
        <div class="spark">${C.spark(Q.WEEK_CALLS.slice(-8).map((v,i)=>v*(1+i*0.002)))}</div>
      </div>`;
    };

    const top10 = agents.slice(0, 10).map((a, i) => {
      const medal = i === 0 ? 'g' : i === 1 ? 's' : i === 2 ? 'b' : 'n';
      const sc = a.success >= 15 ? 'ok' : a.success >= 11 ? 'warn' : 'bad';
      const bar = Math.min(100, (a.calls / agents[0].calls) * 100);
      return `<tr data-agent="${a.name}" style="cursor:pointer">
        <td><div class="medal ${medal}">${i + 1}</div></td>
        <td><div class="agent-cell"><div class="avatar">${initials(a.name)}</div>
          <div><div class="agent-name">${a.name}</div><div class="agent-sub">${a.team} desk</div></div></div></td>
        <td class="num tnum">${fmt(a.calls)}</td>
        <td class="num tnum">${fmt(a.leads)}</td>
        <td class="num"><span class="pill ${sc}">${a.success}%</span></td>
        <td class="num"><div class="cell-bar"><div class="track"><span style="width:${bar}%"></span></div></div></td>
      </tr>`;
    }).join('');

    const srcRows = src.map(s => `
      <div class="src-row">
        <div class="src-name"><span class="legend-swatch" style="background:${s.color}"></span>${s.name}</div>
        <div class="src-meta">${fmt(s.calls)} calls · ${s.conv}%</div>
        <div class="src-bar"><span style="width:${(s.calls / src[0].calls) * 100}%;background:${s.color}"></span></div>
      </div>`).join('');

    return `
    <div class="tab-view">
      <!-- KPIs -->
      <div class="row kpis">
        ${kpi(I.phone, 'Total Calls', fmt(t.calls), d.calls, 'vs previous ' + Q.PERIODS[period].label.toLowerCase())}
        ${kpi(I.trophy, 'Avg Success Rate', t.avgSuccess + '%', d.success, 'contact-to-lead conversion')}
        ${kpi(I.target, 'Total Leads', fmt(t.leads), d.leads, 'seller · rental · email')}
        ${kpi(I.users, 'Active Callers', t.active + '', d.active, 'RM + Fancy desks combined')}
      </div>

      <!-- trend + sources -->
      <div class="row g-2-1 mt">
        <div class="card">
          <div class="card-head">
            <div><h3>Weekly Performance Trend</h3><div class="sub">Calls &amp; success rate · 12 weeks</div></div>
            <div class="legend" style="padding:0">
              <span class="legend-item"><span class="legend-swatch" style="background:#FDC503"></span>Calls</span>
              <span class="legend-item"><span class="legend-swatch" style="background:#3D5BA6"></span>Success rate</span>
            </div>
          </div>
          <div class="chart-wrap"><div id="trendChart"></div></div>
        </div>
        <div class="card">
          <div class="card-head"><div><h3>Lead Sources</h3><div class="sub">Share of calls</div></div></div>
          <div style="display:flex;justify-content:center;padding:18px 24px 6px"><div id="donut" style="max-width:200px;width:100%"></div></div>
          <div class="src-list">${srcRows}</div>
        </div>
      </div>

      <!-- spotlights -->
      <div class="row g-3 mt">
        <div class="card spot win">
          <div class="eyebrow">${I.trophy} Top Performer</div>
          <div style="display:flex;align-items:center;gap:12px;margin-top:12px">
            <div class="avatar" style="width:44px;height:44px;font-size:15px">${initials(top.name)}</div>
            <div><div class="spot-name" style="margin:0">${top.name}</div>
            <div class="spot-stat">${top.team} desk</div></div>
          </div>
          <div class="spot-stat" style="margin-top:14px"><b>${fmt(top.calls)}</b> calls · <b>${top.leads}</b> leads · <b>${top.success}%</b> success</div>
        </div>
        <div class="card spot">
          <div class="eyebrow">${I.target} Best Converting Source</div>
          <div class="spot-name">${bestSrc.name}</div>
          <div class="spot-stat" style="margin-top:6px">Leading conversion across all channels</div>
          <div class="spot-stat" style="margin-top:14px"><b>${bestSrc.conv}%</b> conversion · <b>${fmt(bestSrc.leads)}</b> leads from <b>${fmt(bestSrc.calls)}</b> calls</div>
        </div>
        <div class="card spot risk">
          <div class="eyebrow" style="color:var(--red)">${I.alert} At Risk</div>
          <div style="display:flex;align-items:center;gap:12px;margin-top:12px">
            <div class="avatar" style="width:44px;height:44px;font-size:15px;background:var(--red-tint);border-color:#E3BDB0;color:var(--red)">${initials(risk.name)}</div>
            <div><div class="spot-name" style="margin:0">${risk.name}</div>
            <div class="spot-stat">below success target</div></div>
          </div>
          <div class="spot-stat" style="margin-top:14px"><b>${risk.success}%</b> success · target <b>15%</b> · ${fmt(risk.calls)} calls</div>
        </div>
      </div>

      <!-- insights + top10 -->
      <div class="row g-2-1 mt" style="align-items:start">
        <div class="card">
          <div class="card-head"><div><h3>Top 10 Performers</h3><div class="sub">Ranked by calls · open All Staff for the full roster</div></div>
            <button class="btn" data-goto="staff">${I.eye} View all</button></div>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th style="width:48px">Rank</th><th>Agent</th><th class="num">Calls</th><th class="num">Leads</th><th class="num">Success</th><th class="num">Volume</th></tr></thead>
            <tbody>${top10}</tbody>
          </table></div>
        </div>
        <div class="card">
          <div class="card-head"><div><h3>Insights</h3><div class="sub">Auto-generated · ${Q.PERIODS[period].label}</div></div></div>
          <div class="insights">${insights(t, d, top, bestSrc, risk, src)}</div>
        </div>
      </div>

      <!-- monthly -->
      <div class="divider-note">Historical breakdown · monthly trend</div>
      <div class="row mini-grid">
        ${miniCard('Calls', I.phone, Q.MONTH_CALLS, '#3D5BA6')}
        ${miniCard('Leads', I.target, Q.MONTH_LEADS, '#B98A02')}
        ${miniCard('Emails', I.mail, Q.MONTH_EMAILS, '#2E6FB0')}
        ${miniCard('Rentals', I.home, Q.MONTH_RENTALS, '#4C6BB8')}
        ${miniCard('DialFire hrs', I.clock, Q.MONTH_DFHOURS, '#D20A03')}
      </div>
    </div>`;
  }

  function miniCard(label, icon, series, color) {
    const last = series[series.length - 1], prev = series[series.length - 2];
    const pct = (((last - prev) / prev) * 100).toFixed(1);
    const unit = label === 'DialFire hrs' ? 'h' : '';
    return `<div class="card mini">
      <div class="mini-head">${icon} ${label} by month</div>
      <div class="mini-sub">last 8 months</div>
      <div class="mini-val tnum">${fmt(last)}${unit}<span>▲ ${pct}%</span></div>
      <div style="margin-top:10px" class="mc" data-series='${JSON.stringify(series)}' data-color="${color}"></div>
    </div>`;
  }

  function insights(t, d, top, bestSrc, risk, src) {
    const worstSrc = src[src.length - 1];
    const items = [
      { type: 'up', html: `<b>Call volume climbed ${Math.abs(d.calls)}%</b> versus the previous period while success rate improved ${Math.abs(d.success)} pts — momentum is healthy across both desks.`,
        action: 'Lock in the current dialling cadence' },
      { type: 'info', html: `<b>${bestSrc.name}</b> is the strongest channel at <b>${bestSrc.conv}% conversion</b>, well ahead of ${worstSrc.name} (${worstSrc.conv}%).`,
        action: 'Shift spend toward ' + bestSrc.name },
      { type: 'warn', html: `<b>${risk.name}</b> is converting at just <b>${risk.success}%</b>, below the 15% target despite ${fmt(risk.calls)} calls — likely a quality not volume issue.`,
        action: 'Schedule a call-quality coaching session' },
      { type: 'up', html: `<b>${top.name}</b> leads the floor with ${fmt(top.calls)} calls and ${top.success}% success — a useful benchmark for the team.`,
        action: 'Share top-performer call recordings' },
    ];
    return items.map(it => `
      <div class="insight">
        <div class="insight-ic ${it.type}">${it.type === 'up' ? I.up : it.type === 'warn' ? I.alert : I.spark}</div>
        <div class="insight-body"><p>${it.html}</p>
          <div class="insight-action">${I.arrow}${it.action}</div></div>
      </div>`).join('');
  }

  function afterOverview() {
    C.weeklyTrend(document.getElementById('trendChart'), Q.WEEKS, Q.WEEK_CALLS, Q.WEEK_SUCCESS);
    const total = Q.SOURCES.reduce((s, x) => s + x.calls, 0);
    C.donut(document.getElementById('donut'),
      Q.SOURCES.map(s => ({ value: s.calls, color: s.color })),
      fmt(total), 'total calls');
    document.querySelectorAll('.mc').forEach(el =>
      C.miniBars(el, JSON.parse(el.dataset.series), el.dataset.color));
    document.querySelectorAll('[data-goto]').forEach(b =>
      b.addEventListener('click', () => { tab = b.dataset.goto; shell(); }));
    wireAgentClicks();
  }

  // ---------------------------------------------------- LEADERSHIP OVERVIEW
  function leadership() {
    const agents = Q.agentsFor(period);
    const t = Q.totalsFor(period);
    const d = Q.DELTAS[period];

    // Split by team
    const rm = agents.filter(a => a.team === 'RM');
    const fc = agents.filter(a => a.team === 'Fancy');
    const teamTotals = team => {
      const calls = team.reduce((s, a) => s + a.calls, 0);
      const leads = team.reduce((s, a) => s + a.leads, 0);
      const sr = calls ? +((leads / calls) * 100).toFixed(1) : 0;
      const target = team === rm
        ? (CFG.BENCHMARKS && CFG.BENCHMARKS.rm_success_rate) || 17
        : (CFG.BENCHMARKS && CFG.BENCHMARKS.fc_success_rate) || 20;
      return { calls, leads, sr, target, n: team.length };
    };
    const rmT = teamTotals(rm), fcT = teamTotals(fc);

    // Revenue estimate: split leads by type if possible
    const rev = CFG.REVENUE_PER_LEAD || { default: 10000 };
    const seller = agents.reduce((s, a) => s + (a.seller || 0), 0);
    const rental = agents.reduce((s, a) => s + (a.rental || 0), 0);
    const email  = agents.reduce((s, a) => s + (a.email  || 0), 0);
    const typed  = seller + rental + email;
    const untyped = Math.max(0, t.leads - typed);
    const revenue = seller * (rev.seller || rev.default)
                  + rental * (rev.rental || rev.default)
                  + email  * (rev.email  || rev.default)
                  + untyped * (rev.default);

    // Efficiency: avg dialler/clocked across agents
    const eff = agents.length
      ? Math.round(agents.reduce((s, a) => s + (a.eff || 0), 0) / agents.length)
      : 0;

    // Top campaigns by call share
    const camps = Q.campaignsFor(period).slice(0, 5);
    const campTotal = Q.campaignsFor(period).reduce((s, c) => s + c.calls, 0) || 1;

    // Red flags
    const flags = redFlags(agents, d, rmT, fcT);

    // Progress to target
    const targets = CFG.FLOOR_TARGETS || {};
    const tgtCalls = (period === 'this-week' || period === 'last-week')
      ? targets.weekly_calls : targets.monthly_calls;
    const tgtLeads = (period === 'this-week' || period === 'last-week')
      ? targets.weekly_leads : targets.monthly_leads;
    const progress = (cur, tgt) => tgt > 0 ? Math.min(100, (cur / tgt) * 100) : 0;
    const tgtClass = pct => pct >= 95 ? 'ok' : pct >= 75 ? 'warn' : 'bad';

    const top5 = agents.slice().sort((a, b) => (b.success * b.calls) - (a.success * a.calls)).slice(0, 5);

    const kpi = (icon, label, val, delta, foot) => {
      const cls = delta == null ? 'flat' : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
      const ic = delta == null ? '' : delta > 0 ? I.up : delta < 0 ? I.down : '';
      const dtxt = delta == null ? '' : (delta === 0 ? 'no change' :
        Math.abs(delta) + (label.includes('Rate') ? ' pts' : '%'));
      return `<div class="card kpi">
        <div class="kpi-top"><div class="kpi-ic">${icon}</div>
          ${delta != null ? `<span class="delta ${cls}">${ic}${dtxt}</span>` : ''}
        </div>
        <div class="kpi-label">${label}</div>
        <div class="kpi-val tnum">${val}</div>
        <div class="kpi-foot">${foot}</div>
        <div class="spark">${C.spark(Q.WEEK_CALLS.slice(-8).map((v,i)=>v*(1+i*0.002)))}</div>
      </div>`;
    };

    const teamCard = (label, td, accent) => `
      <div class="card card-pad">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px">
          <div>
            <div class="kpi-label" style="margin:0">${label}</div>
            <div style="font-family:var(--serif);font-size:22px;font-weight:700;color:var(--ink);margin-top:4px">
              ${td.n} agents · ${fmt(td.calls)} calls
            </div>
          </div>
          <span class="pill ${td.sr >= td.target ? 'ok' : td.sr >= td.target - 3 ? 'warn' : 'bad'}" style="font-size:11px">
            ${td.sr}% success
          </span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px 16px;margin-top:14px;font-size:12.5px">
          <div><div class="kpi-label" style="margin:0;font-size:10.5px">Leads</div>
            <div class="tnum" style="font-weight:700;font-size:16px;color:var(--ink)">${fmt(td.leads)}</div></div>
          <div><div class="kpi-label" style="margin:0;font-size:10.5px">Target</div>
            <div class="tnum" style="font-weight:700;font-size:16px;color:var(--ink)">${td.target}%</div></div>
          <div><div class="kpi-label" style="margin:0;font-size:10.5px">vs Target</div>
            <div class="tnum" style="font-weight:700;font-size:16px;color:${td.sr >= td.target ? 'var(--green)' : 'var(--red)'}">${(td.sr - td.target > 0 ? '+' : '')}${(td.sr - td.target).toFixed(1)} pts</div></div>
        </div>
      </div>`;

    const campRows = camps.map(c => {
      const pct = ((c.calls / campTotal) * 100).toFixed(1);
      return `<div class="src-row">
        <div class="src-name"><span class="legend-swatch" style="background:${c.color}"></span>${c.name}</div>
        <div class="src-meta">${fmt(c.calls)} calls · ${pct}%</div>
        <div class="src-bar"><span style="width:${pct}%;background:${c.color}"></span></div>
      </div>`;
    }).join('');

    const flagItems = flags.length ? flags.map(f => `
      <div class="insight">
        <div class="insight-ic ${f.type}">${f.type === 'warn' ? I.alert : f.type === 'down' ? I.down : I.spark}</div>
        <div class="insight-body"><p>${f.html}</p>
          ${f.action ? `<div class="insight-action">${I.arrow}${f.action}</div>` : ''}
        </div>
      </div>`).join('') : `<div style="padding:18px 24px;color:var(--muted);font-size:13px">
        No red flags this period — the floor is on track.
      </div>`;

    const elapsed = Q.periodElapsed(period);
    const showPace = elapsed.fraction > 0 && elapsed.fraction < 1;
    const tgtBar = (label, cur, tgt) => {
      if (!tgt) return '';
      const pct = progress(cur, tgt);
      const projected = Q.project(period, cur);
      const projPct = progress(projected, tgt);
      const cls = tgtClass(showPace ? projPct : pct);
      const fillColor = cls === 'ok' ? 'var(--green)' : cls === 'warn' ? 'var(--amber)' : 'var(--red)';
      return `<div style="margin-top:14px">
        <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:6px">
          <span style="color:var(--ink);font-weight:600">${label}</span>
          <span class="tnum" style="color:var(--muted)">${fmt(cur)} / ${fmt(tgt)} <b style="color:var(--ink)">(${pct.toFixed(0)}%)</b></span>
        </div>
        <div class="eff-track" style="position:relative">
          <span style="width:${pct}%;background:${fillColor}"></span>
          ${showPace ? `<span style="position:absolute;left:0;top:0;height:100%;width:${Math.min(100,projPct)}%;background:repeating-linear-gradient(45deg,transparent 0 5px,${fillColor}33 5px 10px);border-right:2px dashed ${fillColor};opacity:.85"></span>` : ''}
        </div>
        ${showPace ? `<div style="display:flex;justify-content:space-between;font-size:11.5px;margin-top:5px;color:var(--muted)">
          <span>${elapsed.elapsed}/${elapsed.total} ${period === 'this-week' ? 'working days' : 'days'} elapsed</span>
          <span>At pace: <b class="tnum" style="color:${projPct >= 95 ? 'var(--green)' : projPct >= 75 ? 'var(--amber)' : 'var(--red)'}">${fmt(projected)} (${projPct.toFixed(0)}%)</b></span>
        </div>` : ''}
      </div>`;
    };

    return `
    <div class="tab-view">
      <!-- Hero KPIs -->
      <div class="row kpis">
        ${kpi(I.phone,   'Total Calls',        fmt(t.calls), d.calls,   'vs previous ' + Q.PERIODS[period].label.toLowerCase())}
        ${kpi(I.trophy,  'Success Rate',       t.avgSuccess + '%', d.success, 'contact-to-lead conversion')}
        ${kpi(I.bolt,    'Team Efficiency',    eff + '%', null, 'dialler ÷ clocked-in time')}
        ${kpi(I.medal,   'Est. Revenue',       'R ' + fmt(Math.round(revenue)), null, fmt(t.leads) + ' leads × per-lead value (config.js)')}
      </div>

      <!-- Team split + Target progress -->
      <div class="row g-2-1 mt">
        <div style="display:flex;flex-direction:column;gap:16px">
          <div class="card-head" style="padding:0">
            <div><h3 style="font-family:var(--serif);font-size:17px;color:var(--ink);margin:0">RM vs Fancy</h3>
              <div class="sub" style="font-size:12px">Side-by-side team performance</div></div>
          </div>
          ${teamCard(CFG.TEAM_LABELS?.RM    || 'Relationship Managers', rmT, '#3D5BA6')}
          ${teamCard(CFG.TEAM_LABELS?.Fancy || 'Fancy Callers',         fcT, '#B98A02')}
        </div>
        <div class="card card-pad">
          <div class="card-head" style="padding:0;border:0"><div>
            <h3 style="margin:0">Progress to target</h3>
            <div class="sub">${period === 'this-week' || period === 'last-week' ? 'Weekly floor targets' : 'Monthly floor targets'} · edit in config.js</div>
          </div></div>
          ${tgtBar('Total calls', t.calls, tgtCalls)}
          ${tgtBar('Total leads', t.leads, tgtLeads)}
          <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);line-height:1.7">
            Revenue estimate uses <b style="color:var(--ink)">R${fmt(rev.seller || rev.default)} seller / R${fmt(rev.rental || rev.default)} rental / R${fmt(rev.email || rev.default)} email</b>. Adjust in <code>quay/config.js</code> for accuracy.
          </div>
        </div>
      </div>

      <!-- Top campaigns + Trend -->
      <div class="row g-2-1 mt">
        <div class="card">
          <div class="card-head"><div><h3>Weekly trend</h3><div class="sub">Calls &amp; success rate · 12 weeks</div></div>
            <div class="legend" style="padding:0">
              <span class="legend-item"><span class="legend-swatch" style="background:#FDC503"></span>Calls</span>
              <span class="legend-item"><span class="legend-swatch" style="background:#3D5BA6"></span>Success</span>
            </div></div>
          <div class="chart-wrap"><div id="lTrendChart"></div></div>
        </div>
        <div class="card">
          <div class="card-head"><div><h3>Top campaigns by share</h3><div class="sub">% of total calls this period</div></div></div>
          <div class="src-list">${campRows || '<div style="padding:18px 24px;color:var(--muted);font-size:13px">No campaign data yet.</div>'}</div>
        </div>
      </div>

      <!-- Top performers + Red flags -->
      <div class="row g-2-1 mt" style="align-items:start">
        <div class="card">
          <div class="card-head"><div><h3>Top 5 performers</h3><div class="sub">Ranked by composite (success rate × calls)</div></div>
            <button class="btn" data-goto="staff">${I.eye} View all</button></div>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th style="width:48px">Rank</th><th>Agent</th><th class="num">Calls</th><th class="num">Leads</th><th class="num">Success</th></tr></thead>
            <tbody>${top5.map((a, i) => {
              const medal = i === 0 ? 'g' : i === 1 ? 's' : i === 2 ? 'b' : 'n';
              const sc = a.success >= 15 ? 'ok' : a.success >= 11 ? 'warn' : 'bad';
              return `<tr data-agent="${a.name}" style="cursor:pointer">
                <td><div class="medal ${medal}">${i + 1}</div></td>
                <td><div class="agent-cell"><div class="avatar">${initials(a.name)}</div>
                  <div><div class="agent-name">${a.name}</div><div class="agent-sub">${a.team} desk</div></div></div></td>
                <td class="num tnum">${fmt(a.calls)}</td>
                <td class="num tnum">${fmt(a.leads)}</td>
                <td class="num"><span class="pill ${sc}">${a.success}%</span></td>
              </tr>`;
            }).join('')}</tbody>
          </table></div>
        </div>
        <div class="card">
          <div class="card-head"><div><h3>Red flags</h3><div class="sub">Auto-detected from this period</div></div></div>
          <div class="insights">${flagItems}</div>
        </div>
      </div>

      <!-- Historical comparisons -->
      ${historicalComparison(t)}
    </div>`;
  }

  function historicalComparison(t) {
    const avgCalls4   = Q.trailingAvg('calls',   4);
    const avgCalls12  = Q.trailingAvg('calls',  12);
    const avgLeads4   = Q.trailingAvg('success', 4);
    const avgLeads12  = Q.trailingAvg('success', 12);

    if (!avgCalls4 && !avgCalls12) return '';

    const cmpCard = (label, cur, baseline, baselineLabel, unit = '') => {
      if (!baseline) return '';
      const diff = cur - baseline;
      const pct = ((diff / baseline) * 100).toFixed(1);
      const up = diff >= 0;
      return `<div class="card card-pad">
        <div class="kpi-label" style="margin:0">${label}</div>
        <div style="display:flex;align-items:baseline;gap:10px;margin-top:6px">
          <div style="font-family:var(--serif);font-size:22px;font-weight:700;color:var(--ink);white-space:nowrap">${fmt(cur)}${unit}</div>
          <span class="delta ${up ? 'up' : 'down'}">${up ? I.up : I.down}${Math.abs(pct)}%</span>
        </div>
        <div class="kpi-foot" style="margin-top:8px">${baselineLabel}: <b class="tnum" style="color:var(--slate)">${fmt(baseline)}${unit}</b></div>
      </div>`;
    };

    return `
      <div class="divider-note">Historical comparison · this period vs recent averages</div>
      <div class="row g-3">
        ${cmpCard('Calls vs 4-week avg',  t.calls, avgCalls4,  'Avg last 4 weeks')}
        ${cmpCard('Calls vs 12-week avg', t.calls, avgCalls12, 'Avg last 12 weeks')}
        ${cmpCard('Leads vs 4-week avg',  t.leads, avgLeads4,  'Avg last 4 weeks')}
      </div>`;
  }

  function redFlags(agents, deltas, rmT, fcT) {
    const flags = [];
    const cfg = (CFG.RED_FLAGS) || {};
    const cd = cfg.calls_drop_pct      ?? -15;
    const sb = cfg.success_below_pct   ?? -3;
    const ic = cfg.inactive_call_floor ?? 100;

    // 1) Big WoW drop in calls
    if (deltas.calls != null && deltas.calls <= cd) {
      flags.push({ type: 'down',
        html: `<b>Call volume down ${Math.abs(deltas.calls)}%</b> vs previous period — investigate cause.`,
        action: 'Open Compare tab for week-vs-week breakdown' });
    }
    // 2) RM team below target by more than threshold
    if (rmT.sr < rmT.target + sb) {
      flags.push({ type: 'warn',
        html: `<b>RM success rate at ${rmT.sr}%</b> — ${(rmT.target - rmT.sr).toFixed(1)} pts below the ${rmT.target}% target.`,
        action: 'Review RM coaching cadence' });
    }
    if (fcT.sr < fcT.target + sb) {
      flags.push({ type: 'warn',
        html: `<b>Fancy success rate at ${fcT.sr}%</b> — ${(fcT.target - fcT.sr).toFixed(1)} pts below the ${fcT.target}% target.`,
        action: 'Review Fancy desk lead quality' });
    }
    // 3) Inactive / very-low-call agents
    const inactive = agents.filter(a => a.calls < ic).sort((a, b) => a.calls - b.calls).slice(0, 3);
    inactive.forEach(a => {
      flags.push({ type: 'warn',
        html: `<b>${a.name}</b> made only <b>${fmt(a.calls)}</b> calls — well below the ${ic}-call floor.`,
        action: 'Confirm clocked time + dialler issues' });
    });
    return flags;
  }

  function afterLeadership() {
    if (Q.WEEKS && Q.WEEKS.length) {
      C.weeklyTrend(document.getElementById('lTrendChart'),
        Q.WEEKS, Q.WEEK_CALLS, Q.WEEK_SUCCESS);
    }
    document.querySelectorAll('[data-goto]').forEach(b =>
      b.addEventListener('click', () => { tab = b.dataset.goto; shell(); }));
    wireAgentClicks();
  }

  // Globally wire any element with data-agent to open the drill-down modal.
  function wireAgentClicks(scope) {
    (scope || document).querySelectorAll('[data-agent]').forEach(el => {
      if (el.__agentWired) return;
      el.__agentWired = true;
      el.addEventListener('click', e => {
        // Don't intercept clicks on buttons inside the row
        if (e.target.closest('button, a, input, select')) return;
        openAgentModal(el.dataset.agent);
      });
    });
  }

  shell();
})();

/* Quay 1 — app shell, Overview, navigation + period state */

(function () {
  const Q = window.QUAY, I = window.ICON, C = window.CHART, V = window.VIEWS;
  const CFG = window.QUAY_CONFIG || {};
  // Shared green/amber/red helpers (single source of truth — see views.js).
  // Fallbacks mirror CFG.BENCHMARKS in case views.js loads after this script.
  const _PILLS = window.QUAY_PILLS || {
    sucClass: s => s >= 17 ? 'ok' : s >= 14 ? 'warn' : 'bad',
    effClass: e => e >= 70 ? 'ok' : e >= 60 ? 'warn' : 'bad',
    cphClass: c => c >= 45 ? 'ok' : c >= 35 ? 'warn' : 'bad',
  };
  const sucClass = _PILLS.sucClass;
  const effClass = _PILLS.effClass;
  const cphClass = _PILLS.cphClass;
  const fmt = n => n.toLocaleString('en-ZA');
  const initials = name => name.split(' ').map(w => w[0]).slice(0, 2).join('');

  // ---- session (everyone who logs in is admin) ----
  const SESSION_KEY = 'quay_dash_session_v1';
  let session = (function () {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch { return null; }
  })();
  function setSession(s) {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
    session = s;
  }

  let period = 'this-week';
  let tab = 'overview'; // default landing; switched to 'leadership' for superusers below
  let dailyPicked = null; // selected date on the Daily Stats tab (yyyy-mm-dd)
  let staffTeamFilter = 'all'; // 'all' | 'RM' | 'Fancy' — All Staff tab team dropdown
  // Active segment on the All Staff tab: 'overall' | 'per' | 'ln'. Persisted
  // across re-renders (e.g. period change) so users don't get bounced back
  // to Callers · Overall every time the page rebuilds.
  let staffSegView = 'overall';
  // Cache for the LN & Assistants sub-tab so flipping between segs
  // doesn't re-hit Supabase. Keyed by period so a period change forces
  // a refetch on next click.
  let lnReportsState = { period: null, loading: false, error: null, data: null };
  // Name of the agent currently shown in the drill-down modal (or null if
  // closed). Top-bar period clicks check this to re-render the modal with
  // the new period's data instead of leaving the user on the underlying tab.
  let currentAgentModalName = null;

  // ---- standard schedule (8am–5pm Mon–Fri) ----
  // Soft target: we surface variance, we don't enforce it.
  const SCHEDULE = {
    start_hr: 8,   start_min: 0,
    end_hr: 17,    end_min: 0,
    late_grace_min: 15,    // clocked in by 08:15 counts as on-time
    early_grace_min: 15,   // clocked out after 16:45 counts as full day
  };
  // ---- SAST timezone helpers ----
  // The dashboard can be opened from any browser timezone but every
  // business date (pay period, EOD report calendar day, schedule week) is
  // in Africa/Johannesburg (SAST, UTC+2 year-round, no DST). Reading
  // .getDate()/.getHours() off a JS Date trusts the browser zone, which
  // silently mis-bucket dates for off-shore supers. Use these helpers for
  // anything date-bucketed by SAST.
  const SAST_TZ = 'Africa/Johannesburg';
  const _SAST_YMD_FMT = new Intl.DateTimeFormat('en-CA', {
    timeZone: SAST_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const _SAST_HM_FMT = new Intl.DateTimeFormat('en-GB', {
    timeZone: SAST_TZ, hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', weekday: 'short',
  });
  // Returns the SAST calendar date string (yyyy-mm-dd) for a Date.
  function sastDateStr(d) { return _SAST_YMD_FMT.format(d || new Date()); }
  // Returns { hour, weekday } in SAST. weekday: 0=Sun..6=Sat to match
  // JS Date.getDay() semantics.
  function sastHourAndWeekday(d) {
    const parts = _SAST_HM_FMT.formatToParts(d || new Date());
    const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const wd = parts.find(p => p.type === 'weekday').value; // 'Mon' .. 'Sun'
    const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { hour, weekday: WD[wd] != null ? WD[wd] : new Date().getDay() };
  }
  // SAST wall-clock date string (yyyy-mm-dd) → UTC ISO string for the
  // SAST midnight of that day. SAST is UTC+2, so SAST 00:00 = UTC 22:00
  // previous day.
  function sastDateStartUtcISO(yyyyMmDd) {
    const [y, m, d] = yyyyMmDd.split('-').map(s => parseInt(s, 10));
    return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - 2 * 3600 * 1000).toISOString();
  }
  function sastDateEndUtcISO(yyyyMmDd) {
    const [y, m, d] = yyyyMmDd.split('-').map(s => parseInt(s, 10));
    return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) - 2 * 3600 * 1000).toISOString();
  }

  // Per-week schedule adherence — populated by loadScheduleData() then read
  // by overview()'s adherence card + redFlags(). Shape:
  //   { byStaff: Map<id, { name, days: { yyyy-mm-dd: { first, last } }, late, early, missed }>,
  //     weekStart, weekEnd, asOf }
  let schedule = null;
  let pinBuf = '', pinErr = false, loginError = '';
  // nav preference: 'auto' (collapse on narrow), 'open' (force expanded), 'collapsed' (force rail)
  let navPref = localStorage.getItem('q1nav') || 'auto';
  const AUTO_BP = 1080;
  const navCollapsed = () =>
    navPref === 'open' ? false : navPref === 'collapsed' ? true : window.innerWidth < AUTO_BP;

  const TABS = [
    { id: 'leadership', section: 'Performance', label: 'Leadership',     icon: I.medal,    title: 'Leadership Overview',  sub: 'Strategic snapshot for directors · revenue, targets, red flags' },
    { id: 'overview',   section: 'Performance', label: 'Overview',       icon: I.trophy,   title: 'Operational Overview', sub: 'A single view of call-floor performance' },
    { id: 'live',       section: 'Performance', label: 'Live Floor',     icon: I.users,    title: 'Live Floor',           sub: "Who's on the clock now · today's calls + leads · mobile-friendly" },
    { id: 'staff',      section: 'People',      label: 'All Staff',      icon: I.calendar, title: 'All Staff Report',     sub: 'Drill into agent-level performance' },
    { id: 'manager',    section: 'People',      label: 'Red Flags',      icon: I.chart,    title: 'Red Flags',            sub: 'Auto-detected this period · monthly trends below' },
    { id: 'daily',      section: 'Time',        label: 'Daily Stats',    icon: I.cal2,     title: 'Daily Stats',          sub: 'Per-caller performance for a single day' },
    { id: 'monthly',    section: 'Time',        label: 'Monthly',        icon: I.cal2,     title: 'Monthly Breakdown',    sub: 'Month-by-month roll-up across every week of data' },
    { id: 'compare',    section: 'Time',        label: 'Compare',        icon: I.scale,    title: 'Period Comparison',    sub: 'Week vs week · month vs month' },
    { id: 'sources',    section: 'Strategy',    label: 'Lead Sources',   icon: I.target,   title: 'Lead Source Efficacy', sub: 'Which source converts best' },
    { id: 'clocks',     section: 'Admin',       label: 'Clocks',         icon: I.clock,    title: 'Clocks',               sub: 'Staff hours, requests & team — manage everything in one place' },
    { id: 'payroll',    section: 'Admin',       label: 'Payroll',        icon: I.cal2,     title: 'Payroll · Divisions Allocations', sub: 'Pay-period hours by division — 21st → 20th' },
  ];

  // ---- Payroll tab state (super-only) ----
  // Holds the active pay period, sub-tab, cached shifts + allocations so
  // the view doesn't re-fetch on every sub-tab toggle. Re-fetched whenever
  // the period dropdown changes.
  let payrollState = {
    period: window.PAYROLL ? window.PAYROLL.currentPayPeriod() : null,
    activeView: 'allShifts',
    shifts: null,
    allocations: null,
    loading: false,
    error: null,
  };

  // ---------------------------------------------------- LOGIN
  let loginUser = localStorage.getItem('quay_dash_last_user') || '';

  function renderLogin() {
    // 6-digit PIN, matched to quay-clock (admin-set-pin Edge Function
    // refuses anything that isn't /^\d{6}$/). Hard-coded the literal
    // here rather than DRYing because the dashboard has no shared
    // constants module and one extra dot in an array is cheap.
    const dots = [0,1,2,3,4,5].map(i =>
      `<div class="pin-dot ${i < pinBuf.length ? 'filled' : ''}"></div>`).join('');
    document.getElementById('app').innerHTML = `
      <div class="dash-login ${pinErr ? 'pin-error' : ''}">
        <div class="dash-login-box">
          <img src="quay/quay1-logo-crop.png" alt="Quay 1" class="dash-login-logo">
          <h1>Quay 1 Performance Dashboard</h1>
          <div class="dash-login-sub">Sign in with your admin username + PIN</div>
          <input id="dashUser" class="dash-login-user" type="text" autocomplete="username"
                 autocapitalize="none" autocorrect="off"
                 placeholder="username" value="${escapeHtml(loginUser || '')}">
          <div class="pin-dots">${dots}</div>
          <div class="dash-login-err">${loginError ? escapeHtml(loginError) : ''}</div>
          <div class="keypad">
            ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="key" data-d="${n}">${n}</button>`).join('')}
            <button class="key alt" data-back>← Back</button>
            <button class="key" data-d="0">0</button>
            <button class="key alt" data-clear>Clear</button>
          </div>
          <div class="dash-login-foot">Only Roster rows with <b>admin = true</b> can sign in.</div>
        </div>
      </div>`;
    const u = document.getElementById('dashUser');
    if (u) u.addEventListener('input', () => { loginUser = u.value; });
    document.querySelectorAll('.dash-login .key[data-d]').forEach(b =>
      b.addEventListener('click', () => {
        if (pinBuf.length >= 6) return;
        pinBuf += b.dataset.d; pinErr = false; loginError = '';
        renderLogin();
        if (pinBuf.length === 6) submitLogin();
      }));
    const back = document.querySelector('.dash-login .key[data-back]');
    if (back) back.addEventListener('click', () => { pinBuf = pinBuf.slice(0, -1); renderLogin(); });
    const clr = document.querySelector('.dash-login .key[data-clear]');
    if (clr) clr.addEventListener('click', () => { pinBuf = ''; loginError = ''; renderLogin(); });
  }

  async function submitLogin() {
    const u = document.getElementById('dashUser');
    if (u) loginUser = u.value;
    const username = String(loginUser || '').trim().toLowerCase();
    if (!username) {
      pinErr = true; loginError = 'Enter your username first'; pinBuf = '';
      setTimeout(() => { pinErr = false; renderLogin(); }, 600); renderLogin(); return;
    }
    try {
      const email = `${username}@${CFG.AUTH_EMAIL_DOMAIN || 'quay1.local'}`;
      const { data, error } = await window.sb.auth.signInWithPassword({ email, password: pinBuf });
      if (error || !data.user) throw new Error('Username or PIN not recognised');
      // Confirm this user is in the staff table AND is_admin.
      const { data: staff, error: sErr } = await window.sb.from('staff')
        .select('id, name, role, team, is_admin, is_super, active')
        .eq('auth_user_id', data.user.id).maybeSingle();
      if (sErr || !staff || !staff.is_admin || staff.active === false) {
        await window.sb.auth.signOut();
        throw new Error('Not an admin');
      }
      setSession({
        id: staff.id, name: staff.name, role: staff.role || '', team: staff.team || '',
        admin: true, super: !!staff.is_super,
      });
      if (staff.is_super) tab = 'leadership'; // superusers land on Leadership by default
      try { localStorage.setItem('quay_dash_last_user', username); } catch {}
      pinBuf = ''; loginError = '';
      shell();
    } catch (e) {
      pinErr = true; loginError = String(e.message || e); pinBuf = '';
      setTimeout(() => { pinErr = false; renderLogin(); }, 600);
      renderLogin();
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  // Stable slug for use in red-flag keys, route data attrs, etc.
  // Lowercase + ascii word chars only so the result is safe in URLs + selectors.
  function slug(s) {
    return String(s || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  // Stable week-start key (e.g. 'wk-2026-06-01') for any flag whose lifetime
  // is a calendar week — keeps acks from one week bleeding into the next.
  function wkKeyFor(d) {
    const x = new Date(d || Date.now());
    const dow = (x.getDay() + 6) % 7;       // Monday = 0
    x.setHours(0,0,0,0);
    x.setDate(x.getDate() - dow);
    return 'wk-' + x.toISOString().slice(0,10);
  }

  async function signOut() {
    try { await window.sb.auth.signOut(); } catch {}
    setSession(null);
    pinBuf = ''; loginError = ''; pinErr = false;
    renderLogin();
  }

  // Human-readable date range for the active period — e.g. "16–22 Jun 2026".
  // Anchors numbers to a concrete window so screenshots stay interpretable.
  function periodRangeSuffix() {
    try {
      if (!Q.periodDateRange) return '';
      const r = Q.periodDateRange(period);
      if (!r || !r.fromISO || !r.toISO) return '';
      const from = new Date(r.fromISO);
      const to   = new Date(new Date(r.toISO).getTime() - 86400 * 1000); // inclusive end
      const monthYear = d => d.toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' });
      const day = d => d.getDate();
      const sameMonth = from.getFullYear() === to.getFullYear() && from.getMonth() === to.getMonth();
      const label = sameMonth
        ? `${day(from)}–${day(to)} ${monthYear(to)}`
        : `${day(from)} ${from.toLocaleDateString('en-ZA',{month:'short'})} – ${day(to)} ${monthYear(to)}`;
      return ` · ${label}`;
    } catch { return ''; }
  }

  // ---------------------------------------------------- SHELL
  function shell() {
    // We're authenticated when supabase has an active session AND we know
    // the staff row. setSession({...staff}) is set by submitLogin/setSession.
    if (!session || !session.id) { renderLogin(); return; }
    // Filter tabs by role: only superusers see Leadership + Payroll.
    const visibleTabs = TABS.filter(t =>
      (t.id !== 'leadership' || session.super) &&
      (t.id !== 'payroll'    || session.super)
    );
    // If a non-super lands on a hidden tab (e.g. via deep link), bounce to overview.
    if (!visibleTabs.find(t => t.id === tab)) tab = 'overview';
    // Group nav items by section (Performance / People / Time / Strategy / Admin).
    // Reduces cognitive load — see Miller's 7±2.
    const sectionOrder = ['Performance', 'People', 'Time', 'Strategy', 'Admin'];
    const navItems = sectionOrder
      .map(sec => {
        const items = visibleTabs.filter(t => t.section === sec);
        if (!items.length) return '';
        const buttons = items.map(t => `
          <button class="nav-item ${t.id === tab ? 'active' : ''}" data-tab="${t.id}" title="${t.label}">
            ${t.icon}<span>${t.label}</span>
          </button>`).join('');
        return `<div class="nav-section"><span>${sec}</span></div>${buttons}`;
      })
      .join('');
    const navMobileOptions = visibleTabs.map(t =>
      `<option value="${t.id}" ${t.id === tab ? 'selected' : ''}>${t.label}</option>`
    ).join('');
    document.getElementById('app').innerHTML = `
      <aside class="sidebar">
        <div class="brand">
          <img class="brand-logo" src="quay/quay1-logo-crop.png" alt="Quay 1 International Realty">
          <div class="brand-mini">Q1</div>
        </div>
        <select class="nav-mobile" id="navMobile" aria-label="Switch tab">
          ${navMobileOptions}
        </select>
        <nav class="nav">
          ${navItems}
        </nav>
        <div class="sidebar-foot">
          <div class="signed-as">
            <div class="signed-av">${initials(session.name || 'A')}</div>
            <div class="signed-who">
              <div class="signed-n">${escapeHtml(session.name || '')}</div>
              <div class="signed-r">${session.super ? 'Superuser' : 'Manager'}${session.role ? ' · ' + escapeHtml(session.role) : ''}</div>
            </div>
            <button class="signed-out" id="signOut" title="Sign out">${I.arrow}</button>
          </div>
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
            ${tab === 'overview' ? `
            <button class="live-flags-badge" id="liveFlagsBadge" title="Open Red Flags to action these flags">
              <span class="lfb-pulse"></span>
              <span class="lfb-icon">⚑</span>
              <span class="lfb-count" id="lfbCount">0</span>
              <span class="lfb-label">red flag<span id="lfbS"></span></span>
            </button>` : ''}
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
      b.addEventListener('click', () => {
        // Switching tabs makes the agent drill-down's context stale — close it.
        closeAgentModalIfOpen();
        tab = b.dataset.tab; shell();
      }));
    const navMobile = document.getElementById('navMobile');
    if (navMobile) navMobile.addEventListener('change', () => {
      closeAgentModalIfOpen();
      tab = navMobile.value; shell();
    });
    document.querySelectorAll('#period button').forEach(b =>
      b.addEventListener('click', () => {
        period = b.dataset.period;
        // Preserve an open agent drill-down across the period change. The
        // shell rebuild re-renders #app (the modal lives in a body-level
        // mount so it survives), but the modal's data is stale until we
        // re-open it with the new period.
        const reopenAgent = currentAgentModalName;
        shell();
        if (reopenAgent) openAgentModal(reopenAgent);
      }));
    document.getElementById('btnPrint').addEventListener('click', () => window.print());
    document.getElementById('btnExport').addEventListener('click', exportCurrentTab);
    const lfb = document.getElementById('liveFlagsBadge');
    if (lfb) lfb.addEventListener('click', () => { tab = 'manager'; shell(); });
    updateLiveFlagsBadge();
    const so = document.getElementById('signOut');
    if (so) so.addEventListener('click', signOut);

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
    document.getElementById('tabSub').textContent = meta.sub + periodRangeSuffix();
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
    if (tab === 'leadership' && !session?.super) { tab = 'overview'; }
    if (tab === 'payroll'    && !session?.super) { tab = 'overview'; }
    if (tab === 'leadership')    { host.innerHTML = leadership(); afterLeadership(); }
    else if (tab === 'overview') { host.innerHTML = overview(); afterOverview(); }
    else if (tab === 'staff')    { host.innerHTML = V.allStaff(period, staffTeamFilter); staffWire(); }
    else if (tab === 'compare')  { host.innerHTML = V.compare(); segWire(); }
    else if (tab === 'daily')    { host.innerHTML = V.daily(period, dailyPicked); dailyWire(); }
    else if (tab === 'monthly')  { host.innerHTML = V.monthly(); monthlyWire(); }
    else if (tab === 'manager')  { host.innerHTML = V.manager(period); managerWire(); }
    else if (tab === 'sources')  host.innerHTML = V.leadSources(period);
    else if (tab === 'payroll')  { host.innerHTML = V.payroll(payrollState); payrollWire(); }
    else if (tab === 'clocks')   { host.innerHTML = clocksIframe(); wireClocks(); }
    else if (tab === 'live')     { host.innerHTML = renderLiveFloor(); liveFloorWire(); }
    // Any per-card "Export CSV" button shares the topbar export handler.
    document.querySelectorAll('#content .js-export').forEach(b => {
      if (b.__exportWired) return; b.__exportWired = true;
      b.addEventListener('click', exportCurrentTab);
    });
    host.scrollTop = 0;
  }

  // ---- Clocks tab — iframe the quay-clock admin and hand off the session
  function clocksIframe() {
    const src = CFG.CLOCK_ADMIN_EMBED || '';
    return `<div class="clocks-frame">
      <iframe id="clocksIframe" src="${src}" title="Quay 1 Clocks"
              loading="lazy" referrerpolicy="no-referrer"></iframe>
    </div>`;
  }

  function wireClocks() {
    // When the embedded admin says it's ready, hand off the current
    // Supabase session (access + refresh token) so the iframe doesn't
    // ask for a second login. Listener is idempotent; origin gated.
    if (!window.__quayClocksWired) {
      window.__quayClocksWired = true;
      const ALLOWED_ORIGINS = new Set([
        'https://twigs002.github.io',
        location.origin,
      ]);
      window.addEventListener('message', async (ev) => {
        if (!ALLOWED_ORIGINS.has(ev.origin)) return;
        const m = ev.data;
        if (!m || m.type !== 'quay-admin-ready') return;
        const target = ev.source;
        if (!target) return;
        try {
          const { data } = await window.sb.auth.getSession();
          if (!data?.session) return;
          target.postMessage({
            type: 'quay-supabase-session',
            session: {
              access_token: data.session.access_token,
              refresh_token: data.session.refresh_token,
            },
          }, ev.origin);
        } catch {}
      });
    }
  }
  // ---------------------------------------------------- PAYROLL (super-only)
  function payrollWire() {
    // Period picker — re-fetch when changed.
    const sel = document.getElementById('payrollPeriod');
    if (sel) sel.addEventListener('change', () => {
      const all = window.PAYROLL.payPeriodsForPicker(12);
      const next = all.find(p => p.label === sel.value);
      if (!next) return;
      payrollState.period = next;
      payrollState.shifts = null;
      payrollState.allocations = null;
      payrollFetchAndRender();
    });
    // Sub-tab buttons — switch view without re-fetching.
    document.querySelectorAll('#payrollSubNav button[data-payroll-view]').forEach(b => {
      b.addEventListener('click', () => {
        payrollState.activeView = b.dataset.payrollView;
        // Re-render shell so the host pane swaps to the new sub-view.
        shell();
      });
    });
    // First mount: hydrate config from DB, then kick off the fetch if
    // we haven't already. Config load + shift fetch run in parallel so
    // tab open isn't bottle-necked by either.
    if (payrollState.shifts === null && !payrollState.loading) {
      payrollFetchAndRender();
    }
  }

  async function payrollFetchAndRender() {
    if (!window.PAYROLL) return;
    payrollState.loading = true;
    payrollState.error = null;
    // Render the loading state immediately.
    if (tab === 'payroll') shell();
    try {
      // Make sure CONFIG is hydrated before parsing notes. Both calls
      // are network-bound so kick them off in parallel; the algorithm
      // doesn't run until both have resolved.
      const { start, end } = payrollState.period;
      const [shifts] = await Promise.all([
        window.PAYROLL.fetchShiftsForPeriod(start, end),
        window.PAYROLL.ensureConfigLoaded(),
      ]);
      const allocations = window.PAYROLL.computeAllocations(shifts);
      payrollState.shifts = shifts;
      payrollState.allocations = allocations;
    } catch (e) {
      console.warn('[payroll] fetch failed', e);
      payrollState.error = String(e.message || e);
      payrollState.shifts = [];
      payrollState.allocations = { empTeamHours: new Map(), empTotalHours: new Map(), rawVariantsPerTeam: new Map() };
    } finally {
      payrollState.loading = false;
      if (tab === 'payroll') shell();
    }
  }

  // ----- Config sub-view event wiring -----
  // Handles add / edit / delete / reorder across all 5 reference tables.
  // After every successful mutation, reloads CONFIG from Supabase and
  // re-renders the sub-view. Shows a small green pill on success / red
  // on failure.
  function payrollConfigWire() {
    const root = document.getElementById('payrollConfig');
    if (!root) return;
    const sb = window.sb;
    const P = window.PAYROLL;

    function pill(msg, ok) {
      const el = root.querySelector('[data-cf-pill]');
      if (!el) return;
      el.textContent = msg;
      el.className = 'cf-pill' + (ok ? '' : ' err');
      el.style.display = '';
      setTimeout(() => { el.style.display = 'none'; }, 2400);
    }

    async function reloadAndRerender(msg) {
      await P.reloadConfig();
      pill(msg || 'Saved', true);
      if (tab === 'payroll') shell();
    }

    function fieldVal(name) {
      const el = root.querySelector(`[data-cf-input="${name}"]`);
      return el ? String(el.value || '').trim() : '';
    }

    async function patch(table, id, payload) {
      if (!id) {
        pill('No id — refresh DB first', false);
        return false;
      }
      const { error } = await sb.from(table).update(payload).eq('id', id);
      if (error) { pill(error.message, false); return false; }
      return true;
    }
    async function del(table, id) {
      if (!id) {
        pill('No id — refresh DB first', false);
        return false;
      }
      const { error } = await sb.from(table).delete().eq('id', id);
      if (error) { pill(error.message, false); return false; }
      return true;
    }
    async function insert(table, payload) {
      const { error } = await sb.from(table).insert(payload);
      if (error) { pill(error.message, false); return false; }
      return true;
    }

    // --- Live alias-pattern tester ---
    const testIn = root.querySelector('[data-cf-input="alias-test"]');
    const testOut = root.querySelector('[data-cf-test-out]');
    if (testIn && testOut) {
      const update = () => {
        const v = String(testIn.value || '');
        if (!v) { testOut.textContent = '—'; testOut.classList.add('empty'); return; }
        const teams = P.parseTeams(v);
        testOut.classList.remove('empty');
        testOut.textContent = teams.length ? teams.join(' · ') : '(dropped)';
      };
      testIn.addEventListener('input', update);
    }

    // --- Refresh from DB ---
    const reloadBtn = root.querySelector('[data-cf-action="reload"]');
    if (reloadBtn) reloadBtn.addEventListener('click', async () => {
      const ok = await P.reloadConfig();
      pill(ok ? 'Reloaded from Supabase' : 'Reload failed — see console', ok);
      if (tab === 'payroll') shell();
    });

    // --- Canonical Divisions ---
    root.querySelectorAll('[data-cf-action="canon-add"]').forEach(b => b.addEventListener('click', async () => {
      const name = fieldVal('canon-name');
      const order = parseInt(fieldVal('canon-order'), 10);
      if (!name) { pill('Name required', false); return; }
      if (!Number.isFinite(order)) { pill('Valid order required', false); return; }
      const ok = await insert('payroll_canonical_divisions', { name, display_order: order, active: true });
      if (ok) await reloadAndRerender('Division added');
    }));
    root.querySelectorAll('[data-cf-action="canon-edit"]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.id, prev = b.dataset.name;
      const next = prompt(`Rename "${prev}" to:`, prev);
      if (!next || next === prev) return;
      const ok = await patch('payroll_canonical_divisions', id, { name: next });
      if (ok) await reloadAndRerender('Division renamed');
    }));
    root.querySelectorAll('[data-cf-action="canon-delete"]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.id, name = b.dataset.name;
      if (!confirm(`Delete the "${name}" division? Shifts that used it will show up as non-canonical until you re-add it.`)) return;
      const ok = await del('payroll_canonical_divisions', id);
      if (ok) await reloadAndRerender('Division removed');
    }));
    // Up/down arrows — swap display_order with neighbour.
    const canonRows = root.querySelectorAll('[data-cf-row="canon"]');
    root.querySelectorAll('[data-cf-action="canon-up"],[data-cf-action="canon-down"]').forEach(b => b.addEventListener('click', async () => {
      const dir = b.dataset.cfAction === 'canon-up' ? -1 : 1;
      const i = parseInt(b.dataset.i, 10);
      const j = i + dir;
      if (j < 0 || j >= canonRows.length) return;
      const a = canonRows[i], c = canonRows[j];
      const aId = a.dataset.cfId, cId = c.dataset.cfId;
      if (!aId || !cId) { pill('Reorder needs DB rows — deploy schema first', false); return; }
      const aOrd = parseInt(a.querySelector('.cf-ord').textContent.trim(), 10);
      const cOrd = parseInt(c.querySelector('.cf-ord').textContent.trim(), 10);
      const ok1 = await patch('payroll_canonical_divisions', aId, { display_order: cOrd });
      if (!ok1) return;
      const ok2 = await patch('payroll_canonical_divisions', cId, { display_order: aOrd });
      if (ok2) await reloadAndRerender('Reordered');
    }));

    // --- Typo Map ---
    root.querySelectorAll('[data-cf-action="typo-add"]').forEach(b => b.addEventListener('click', async () => {
      const key = fieldVal('typo-key'), canonical = fieldVal('typo-canonical');
      if (!key || !canonical) { pill('Both fields required', false); return; }
      const ok = await insert('payroll_typo_map', { key, canonical });
      if (ok) await reloadAndRerender('Typo added');
    }));
    root.querySelectorAll('[data-cf-action="typo-edit"]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.id;
      const next = prompt(`Canonical for "${b.dataset.key}":`, b.dataset.canonical);
      if (!next || next === b.dataset.canonical) return;
      const ok = await patch('payroll_typo_map', id, { canonical: next });
      if (ok) await reloadAndRerender('Typo updated');
    }));
    root.querySelectorAll('[data-cf-action="typo-delete"]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm(`Delete typo "${b.dataset.key}"?`)) return;
      const ok = await del('payroll_typo_map', b.dataset.id);
      if (ok) await reloadAndRerender('Typo removed');
    }));

    // --- Alias Patterns ---
    root.querySelectorAll('[data-cf-action="alias-add"]').forEach(b => b.addEventListener('click', async () => {
      const pattern = fieldVal('alias-pattern');
      const target  = fieldVal('alias-target');
      const priority = parseInt(fieldVal('alias-priority'), 10);
      if (!pattern || !target) { pill('Pattern + target required', false); return; }
      if (!Number.isFinite(priority)) { pill('Valid priority required', false); return; }
      // Validate the regex client-side so we don't write garbage.
      try { new RegExp(pattern, 'i'); }
      catch (e) { pill('Invalid regex: ' + e.message, false); return; }
      const ok = await insert('payroll_alias_patterns', { pattern, target, priority });
      if (ok) await reloadAndRerender('Alias added');
    }));
    root.querySelectorAll('[data-cf-action="alias-edit"]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.id;
      const nextPattern = prompt(`Regex source (case-insensitive):`, b.dataset.pattern);
      if (nextPattern == null) return;
      const nextTarget = prompt(`Target canonical:`, b.dataset.target);
      if (nextTarget == null) return;
      const nextPriority = prompt(`Priority (lower = earlier):`, b.dataset.priority);
      if (nextPriority == null) return;
      const prio = parseInt(nextPriority, 10);
      if (!nextPattern || !nextTarget || !Number.isFinite(prio)) {
        pill('Invalid values', false); return;
      }
      try { new RegExp(nextPattern, 'i'); }
      catch (e) { pill('Invalid regex: ' + e.message, false); return; }
      const ok = await patch('payroll_alias_patterns', id,
        { pattern: nextPattern, target: nextTarget, priority: prio });
      if (ok) await reloadAndRerender('Alias updated');
    }));
    root.querySelectorAll('[data-cf-action="alias-delete"]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm(`Delete alias /${b.dataset.pattern}/i?`)) return;
      const ok = await del('payroll_alias_patterns', b.dataset.id);
      if (ok) await reloadAndRerender('Alias removed');
    }));

    // --- Per-Agent Default Team ---
    root.querySelectorAll('[data-cf-action="def-add"]').forEach(b => b.addEventListener('click', async () => {
      const agent_name  = fieldVal('def-agent');
      const default_team = fieldVal('def-team');
      if (!agent_name || !default_team) { pill('Both fields required', false); return; }
      const ok = await insert('payroll_default_team', { agent_name, default_team });
      if (ok) await reloadAndRerender('Default added');
    }));
    root.querySelectorAll('[data-cf-action="def-edit"]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.id;
      const next = prompt(`Default team for ${b.dataset.agent}:`, b.dataset.team);
      if (!next || next === b.dataset.team) return;
      const ok = await patch('payroll_default_team', id, { default_team: next });
      if (ok) await reloadAndRerender('Default updated');
    }));
    root.querySelectorAll('[data-cf-action="def-delete"]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm(`Delete default-team entry for "${b.dataset.agent}"?`)) return;
      const ok = await del('payroll_default_team', b.dataset.id);
      if (ok) await reloadAndRerender('Default removed');
    }));

    // --- Drop Standalone ---
    root.querySelectorAll('[data-cf-action="drop-add"]').forEach(b => b.addEventListener('click', async () => {
      const code = fieldVal('drop-code').toLowerCase();
      if (!code) { pill('Code required', false); return; }
      const ok = await insert('payroll_drop_standalone', { code });
      if (ok) await reloadAndRerender('Code added');
    }));
    root.querySelectorAll('[data-cf-action="drop-delete"]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm(`Delete short-code "${b.dataset.code}"? Notes that contain only this code will stop being dropped.`)) return;
      const ok = await del('payroll_drop_standalone', b.dataset.id);
      if (ok) await reloadAndRerender('Code removed');
    }));
  }

  function segWire() {
    document.querySelectorAll('.seg').forEach(seg =>
      seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        // Compare tab seg buttons carry data-cmp-mode and gate which panel shows.
        const mode = b.dataset.cmpMode;
        if (mode) {
          const wk = document.getElementById('cmpWeekPanel');
          const mo = document.getElementById('cmpMonthPanel');
          if (wk) wk.style.display = mode === 'week'  ? '' : 'none';
          if (mo) mo.style.display = mode === 'month' ? '' : 'none';
        }
      })));
    // Month vs Month dropdowns — re-render just the inner table body.
    const ma = document.getElementById('cmpMonthA');
    const mb = document.getElementById('cmpMonthB');
    const body = document.getElementById('cmpMonthBody');
    if (ma && mb && body) {
      const months = (Q.monthlyBreakdown && Q.monthlyBreakdown()) || [];
      const redraw = () => {
        body.innerHTML = V.renderMonthCompare(months, ma.value, mb.value);
      };
      ma.addEventListener('change', redraw);
      mb.addEventListener('change', redraw);
    }
    // Week vs Week dropdowns — same pattern as Month vs Month.
    const wa = document.getElementById('cmpWeekA');
    const wb = document.getElementById('cmpWeekB');
    const wbody = document.getElementById('cmpWeekBody');
    if (wa && wb && wbody) {
      const weeksB = (Q.weeksBreakdown && Q.weeksBreakdown()) || [];
      const redrawW = () => {
        wbody.innerHTML = V.renderWeekCompare(weeksB, wa.value, wb.value);
      };
      wa.addEventListener('change', redrawW);
      wb.addEventListener('change', redrawW);
    }
  }
  // Click a month label to inline-expand its per-week breakdown.
  function monthlyWire() {
    document.querySelectorAll('a.month-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const key = link.dataset.monthKey;
        const detail = document.querySelector(`tr[data-month-detail="${key}"]`);
        const caret = link.querySelector('.month-caret');
        if (!detail) return;
        const isOpen = detail.style.display !== 'none';
        if (isOpen) {
          detail.style.display = 'none';
          if (caret) caret.textContent = '▸';
          return;
        }
        // Lazy-render the inner table on first open.
        const host = detail.querySelector('.month-weeks-host');
        if (host && !host.dataset.rendered) {
          host.innerHTML = V.monthWeeksTable(key);
          host.dataset.rendered = '1';
        }
        detail.style.display = '';
        if (caret) caret.textContent = '▾';
      });
    });
  }

  function dailyWire() {
    const available = (Q.dailyDates || []).slice();      // newest first
    const currentISO = () => new Date().toISOString().slice(0, 10);
    const yesterdayISO = () => {
      const d = new Date(); d.setDate(d.getDate() - 1);
      return d.toISOString().slice(0, 10);
    };
    const pick = (newDate) => {
      if (!newDate) return;
      dailyPicked = newDate;
      shell();
    };
    const stepFromCurrent = (delta) => {
      // Step through the AVAILABLE dates so prev/next don't jump to a blank day.
      const cur = dailyPicked || available[0];
      if (!cur) return;
      const idx = available.indexOf(cur);
      if (idx < 0) return;
      // Note: available is newest-first, so "prev day" means INCREASING index.
      const targetIdx = idx - delta; // delta -1 = prev day = older = higher idx
      const nextIdx = idx + (delta > 0 ? -1 : 1);
      if (nextIdx >= 0 && nextIdx < available.length) pick(available[nextIdx]);
    };
    const dateEl = document.getElementById('dailyDate');
    if (dateEl) dateEl.addEventListener('change', e => pick(e.target.value));
    document.querySelectorAll('[data-daily-jump]').forEach(b =>
      b.addEventListener('click', () => {
        const t = b.dataset.dailyJump;
        const target = t === 'today' ? currentISO() : yesterdayISO();
        // If the exact day isn't available, fall back to the most recent
        // available date that's <= target.
        const usable = available.find(d => d <= target) || available[0];
        pick(usable);
      })
    );
    document.querySelectorAll('[data-daily-step]').forEach(b =>
      b.addEventListener('click', () => stepFromCurrent(parseInt(b.dataset.dailyStep, 10)))
    );
    // Populate the day's EOD reports card. Lazy-loads on first use.
    populateDailyReports();
  }

  // Renders the End-of-day Report list for whichever date the Daily Stats
  // tab is showing. Reuses the same _reports cache the Daily Reports tab
  // uses, so toggling between tabs doesn't re-fetch.
  function populateDailyReports() {
    const host = document.getElementById('dailyReportsHost');
    if (!host) return;
    const date = host.dataset.dailyDate;
    if (!date) return;
    if (_reports == null) {
      host.innerHTML = '<div class="card card-pad muted" style="text-align:center;padding:18px">Loading day reports…</div>';
      loadReports().then(() => { if (tab === 'daily') populateDailyReports(); });
      return;
    }
    // Filter to reports clocked-out on this SAST calendar day. The user
    // picked `date` (yyyy-mm-dd) in the SAST-anchored picker; Supabase
    // hands back r.clocked_out_at as UTC ISO ("…Z"). Convert the SAST
    // 00:00→23:59 wall-clock bounds to UTC for string comparison.
    const dayStart = sastDateStartUtcISO(date);
    const dayEnd   = sastDateEndUtcISO(date);
    const dayReports = _reports.filter(r =>
      r.clocked_out_at >= dayStart && r.clocked_out_at <= dayEnd
    );
    if (dayReports.length === 0) {
      host.innerHTML = `<div class="card card-pad">
        <div class="card-head" style="border:0;padding:0;margin-bottom:6px">
          <h3>End-of-day reports — ${escapeHtml(date)}</h3>
        </div>
        <div class="muted" style="font-size:13px">No LN/Assistant reports submitted on this date.</div>
      </div>`;
      return;
    }
    const num = n => (n == null ? '0' : Number(n).toLocaleString('en-ZA'));
    const dateFmt = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const cards = dayReports.map(r => {
      const name = escapeHtml(_staffNamesById.get(r.staff_id) || r.staff_id);
      const designation = (r.designation || '').replace('_', ' ');
      return `<details class="report-card">
        <summary>
          <div class="report-head">
            <div>
              <div class="report-name">${name}</div>
              <div class="report-sub">${escapeHtml(designation)} · ${escapeHtml(r.division || '—')} · clocked out ${dateFmt(r.clocked_out_at)}</div>
            </div>
            <div class="report-stat-strip">
              <span><b>${num(r.hs_calls_made + r.df_calls)}</b><small>calls</small></span>
              <span><b>${num(r.hs_leads_vals + r.df_leads_vals + r.wa_leads_vals)}</b><small>leads/vals</small></span>
              <span><b>${num(r.df_hours)}h</b><small>dialler</small></span>
            </div>
          </div>
        </summary>
        <div class="report-body">
          <div class="report-section">
            <h5>📊 HubSpot Work Summary</h5>
            <div class="report-grid">
              <div><span>📋 Tasks Completed</span><b>${num(r.hs_tasks_completed)}</b></div>
              <div><span>📞 Calls Made</span><b>${num(r.hs_calls_made)}</b></div>
              <div><span>💻 Emails Sent</span><b>${num(r.hs_emails_sent)}</b></div>
              <div><span>📲 WhatsApp's sent</span><b>${num(r.hs_whatsapps_sent)}</b></div>
              <div><span>✅ Answered Contacts</span><b>${num(r.hs_answered_contacts)}</b></div>
              <div><span>🎯 Leads/Vals</span><b>${num(r.hs_leads_vals)}</b></div>
              <div><span>♻️ Reconverted Leads</span><b>${num(r.hs_reconverted_leads)}</b></div>
            </div>
          </div>
          <div class="report-section">
            <h5>☎️🔥 DialFire Canvassing</h5>
            <div class="report-grid">
              <div><span>📞 Calls</span><b>${num(r.df_calls)}</b></div>
              <div><span>📧 Email Successes</span><b>${num(r.df_email_successes)}</b></div>
              <div><span>🏡 Leads/Vals</span><b>${num(r.df_leads_vals)}</b></div>
              <div><span>⏰ Hours</span><b>${num(r.df_hours)}</b></div>
            </div>
          </div>
          <div class="report-section">
            <h5>📲 WhatsApp Campaigns</h5>
            <div class="report-grid">
              <div><span>🤳 WhatsApps sent</span><b>${num(r.wa_sent)}</b></div>
              <div><span>▶️ Responses</span><b>${num(r.wa_responses)}</b></div>
              <div><span>🎯 Leads/Vals</span><b>${num(r.wa_leads_vals)}</b></div>
            </div>
          </div>
          ${r.notes ? `<div class="report-section">
            <h5>🔷📈 Notes</h5>
            <div class="report-notes">${escapeHtml(r.notes)}</div>
          </div>` : ''}
        </div>
      </details>`;
    }).join('');
    host.innerHTML = `<div class="card">
      <div class="card-head"><div><h3>End-of-day reports — ${escapeHtml(date)}</h3>
        <div class="sub">${dayReports.length} submission${dayReports.length === 1 ? '' : 's'} from LN/Assistant on this day</div></div></div>
      <div style="padding:14px 18px 18px">${cards}</div>
    </div>`;
  }

  function managerWire() {
    document.querySelectorAll('#content .mc').forEach(el =>
      C.miniBars(el, JSON.parse(el.dataset.series), el.dataset.color));
    const host = document.getElementById('managerFlagsHost');
    if (host) {
      host.innerHTML = flagsCardHtml(currentFlags());
      wireFlagAckButtons(host);
    }
    // The Red Flags tab used to host a sortable campaign table; that table
    // was retired when the tab was simplified to flags + monthly trends.
    // Campaign drill-downs are now only reachable from the Overview tab.
  }

  function staffWire() {
    const seg = document.getElementById('staffSeg');
    const overall = document.getElementById('staffOverall');
    const per = document.getElementById('staffPerCaller');
    const lnPane = document.getElementById('staffLnReports');
    if (!seg || !overall || !per) return;
    seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      seg.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const view = b.dataset.view;
      staffSegView = view;
      overall.style.display = view === 'overall' ? '' : 'none';
      per.style.display     = view === 'per'     ? 'grid' : 'none';
      if (lnPane) lnPane.style.display = view === 'ln' ? '' : 'none';
      // Lazy-load LN reports on first click for this period — and on
      // re-click after a period change. The cache key is the period.
      if (view === 'ln') lnReportsHydrate();
    }));
    // Restore last-active segment after a re-render (period change, etc.).
    // The view always mounts with 'overall' as the active class, so we
    // trigger a programmatic click on the saved segment to swap it back.
    if (staffSegView && staffSegView !== 'overall') {
      const restoreBtn = seg.querySelector(`button[data-view="${staffSegView}"]`);
      if (restoreBtn) restoreBtn.click();
    }
    // Team filter — re-render the tab when the dropdown changes so the
    // KPI strip, table, and per-caller cards all reflect the filtered set.
    const teamSel = document.getElementById('staffTeamFilter');
    if (teamSel) teamSel.addEventListener('change', () => {
      staffTeamFilter = teamSel.value;
      shell();
    });
    sortableWire(document.getElementById('staffOverall'));
    wireAgentClicks();
    // Re-wire the LN notes expandable cells if hydration already happened
    // for the current period (e.g. after a re-render).
    lnReportsWireDetails();
  }

  // Fetch clock_out_reports for the current period, render into the
  // staffLnReports container. Safe to call repeatedly — second call for
  // the same period uses the cached data.
  async function lnReportsHydrate() {
    const lnPane = document.getElementById('staffLnReports');
    if (!lnPane) return;
    // Cache hit — render from memory.
    if (lnReportsState.period === period && lnReportsState.data) {
      lnPane.innerHTML = V.lnReports(lnReportsState.data);
      sortableWire(lnPane);
      lnReportsWireDetails();
      return;
    }
    if (lnReportsState.loading && lnReportsState.period === period) return;
    if (!window.sb) {
      lnPane.innerHTML = `<div class="card card-pad" style="color:var(--red)">Supabase client not initialised — can't load reports.</div>`;
      return;
    }
    lnReportsState = { period, loading: true, error: null, data: null };
    lnPane.innerHTML = `<div class="card card-pad" style="text-align:center;color:var(--muted);padding:40px">Loading end-of-day reports for ${escapeHtml((Q.PERIODS[period]||{}).label || period)}…</div>`;
    try {
      const { fromISO, toISO } = Q.periodDateRange(period);
      // FK embed: PostgREST resolves clock_out_reports.staff_id → public.staff.
      const { data, error } = await window.sb.from('clock_out_reports')
        .select('id, staff_id, designation, division, clocked_out_at, hs_tasks_completed, hs_calls_made, hs_emails_sent, hs_whatsapps_sent, hs_answered_contacts, hs_leads_vals, hs_reconverted_leads, df_calls, df_email_successes, df_leads_vals, df_hours, wa_sent, wa_responses, wa_leads_vals, notes, staff:staff_id(name)')
        .gte('clocked_out_at', fromISO)
        .lte('clocked_out_at', toISO)
        .order('clocked_out_at', { ascending: false });
      if (error) throw error;
      lnReportsState = { period, loading: false, error: null, data: data || [] };
      lnPane.innerHTML = V.lnReports(lnReportsState.data);
      sortableWire(lnPane);
      lnReportsWireDetails();
    } catch (e) {
      lnReportsState = { period, loading: false, error: e, data: null };
      lnPane.innerHTML = `<div class="card card-pad" style="color:var(--red)">Could not load reports: ${escapeHtml(String(e.message || e))}</div>`;
    }
  }

  // Click-to-expand for the truncated notes cell in the recent-submissions
  // table. Mirrors the request-reason cell behaviour in the Clocks tab.
  function lnReportsWireDetails() {
    const lnPane = document.getElementById('staffLnReports');
    if (!lnPane) return;
    lnPane.querySelectorAll('td.reason-cell').forEach(cell => {
      if (cell.dataset.bound === '1') return;
      cell.dataset.bound = '1';
      cell.addEventListener('click', () => cell.classList.toggle('details-open'));
    });
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
  function closeAgentModalIfOpen() {
    const mount = document.getElementById('agentModalMount');
    if (mount) mount.innerHTML = '';
    document.body.style.overflow = '';
    currentAgentModalName = null;
  }

  function openAgentModal(name) {
    const all = Q.agentsFor(period);
    const a = all.find(x => x.name === name);
    if (!a) { currentAgentModalName = null; return; }
    currentAgentModalName = name;
    const hist = Q.agentHistory(name).slice(-12);  // last 12 weeks present
    const camps = Q.agentCampaigns(name, period);
    const onTarget = !!a.meetsTarget;
    const sc = sucClass(a.success);
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
        <td class="num"><span class="pill ${sucClass(+conv)}">${conv}%</span></td>
      </tr>`;
    }).join('') : `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:18px">No per-campaign breakdown for this period (week pre-dates the new fetcher field).</td></tr>`;

    const r = a._raw || {};
    const wt = r.workTime || 0;
    const pct = (n) => wt > 0 ? Math.round((n || 0) / wt * 100) : 0;
    const talkP = pct(r.talkTime), wrapP = pct(r.wrapTime), waitP = pct(r.waitTime);
    // Work % = dialler ÷ (dialler + pause) — how much of clocked session was actively dialling
    const workP = a.workPct != null ? Math.round(a.workPct) : 0;

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
              <h3 style="font-family:var(--serif);margin:0 0 4px;font-size:16px">Time breakdown</h3>
              <div class="sub" style="font-size:11.5px;margin-bottom:10px">As % of dialler (work) time</div>
              ${timeRow('Talk',    talkP, 'var(--blue)')}
              ${timeRow('Wrap-up', wrapP, 'var(--amber)')}
              ${timeRow('Wait',    waitP, '#9AA3AD')}
              <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">
                <div class="sub" style="font-size:11.5px;margin:0 0 8px">Session activity (work vs paused)</div>
                ${timeRow('Work %', workP, 'var(--green)')}
              </div>
            </div>
            <div class="card card-pad">
              <h3 style="font-family:var(--serif);margin:0 0 4px;font-size:16px">Leads breakdown</h3>
              <div class="sub" style="font-size:11.5px;margin-bottom:10px">Seller · Rental · Email · share of total leads</div>
              ${(() => {
                const sel = a.seller || 0, rnt = a.rental || 0, eml = a.email || 0;
                const tot = sel + rnt + eml;
                const pct = n => tot > 0 ? Math.round((n / tot) * 100) : 0;
                const leadRow = (label, count, share, color) => `
                  <div style="margin-top:10px">
                    <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:5px">
                      <span style="color:var(--slate);font-weight:600">${label}</span>
                      <span class="tnum" style="color:var(--ink);font-weight:700">${fmt(count)} <span style="color:var(--muted);font-weight:600">· ${share}%</span></span>
                    </div>
                    <div class="eff-track"><span style="width:${Math.min(100, share)}%;background:${color}"></span></div>
                  </div>`;
                return `
                  ${leadRow('Seller', sel, pct(sel), 'var(--blue)')}
                  ${leadRow('Rental', rnt, pct(rnt), 'var(--amber)')}
                  ${leadRow('Email',  eml, pct(eml), 'var(--green)')}
                  <div style="margin-top:14px;padding-top:10px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);display:flex;justify-content:space-between">
                    <span>Total leads</span>
                    <b class="tnum" style="color:var(--ink);font-weight:700">${fmt(tot)}</b>
                  </div>`;
              })()}
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
      currentAgentModalName = null;
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

  // ---------------------------------------------------- CAMPAIGN DRILL-DOWN
  // Click a campaign row (Overview tab, lead-sources view) → modal showing
  // the campaign totals up top and a per-agent breakdown. Per-agent-per-campaign
  // numbers come from Q.agentCampaigns(agent, period) (backed by
  // weekly_data.json's by_agent_campaign). If a week pre-dates that field
  // the agent simply won't appear in the per-campaign list for that week —
  // we fall back to the agent's overall period stats with a note.
  function openCampaignModal(campaignName) {
    if (!campaignName) return;
    const camps = Q.campaignsFor(period) || [];
    const camp = camps.find(c => c.name === campaignName);
    if (!camp) return;
    const allAgents = Q.agentsFor(period) || [];
    // Build per-agent stats for THIS campaign. Two passes:
    //   1) Exact: ask Q.agentCampaigns(agent, period) which is sourced from
    //      week.by_agent_campaign.
    //   2) Fallback: if no exact rows came back AND the agent's `campaigns`
    //      array lists this campaign (the only signal historical weeks have),
    //      attribute their period totals with a 'fallback' note.
    const exact = [];
    const fallback = [];
    allAgents.forEach(a => {
      const perCamp = Q.agentCampaigns ? (Q.agentCampaigns(a.name, period) || []) : [];
      const hit = perCamp.find(c => c.name === campaignName);
      if (hit && (hit.calls || hit.leads)) {
        exact.push({
          name: a.name, team: a.team,
          calls: hit.calls || 0, leads: hit.leads || 0,
          seller: hit.seller || 0, rental: hit.rental || 0, email: hit.email || 0,
          cph: a.cph, // overall CPH — we don't have per-campaign CPH client-side
          success: hit.calls ? +((hit.leads / hit.calls) * 100).toFixed(1) : 0,
          source: 'exact',
        });
      } else if ((a.campaigns || []).some(c => c === campaignName
                  || c.toLowerCase() === campaignName.toLowerCase())) {
        fallback.push({
          name: a.name, team: a.team,
          calls: a.calls, leads: a.leads,
          seller: a.seller || 0, rental: a.rental || 0, email: a.email || 0,
          cph: a.cph,
          success: a.success,
          source: 'fallback',
        });
      }
    });
    const rows = exact.concat(fallback).sort((a, b) => b.calls - a.calls);
    const conv = camp.calls ? +((camp.leads / camp.calls) * 100).toFixed(1) : 0;
    const sc = c => sucClass(c);
    const colorDot = camp.color
      ? `<span style="width:14px;height:14px;border-radius:4px;background:${camp.color};display:inline-block;margin-right:10px;vertical-align:middle"></span>`
      : '';

    const rowsHtml = rows.length ? rows.map(r => `
      <tr data-agent="${escapeHtml(r.name)}" style="cursor:pointer">
        <td><div class="agent-cell">
          <div class="avatar">${initials(r.name)}</div>
          <div>
            <div class="agent-name">${escapeHtml(r.name)}</div>
            ${r.source === 'fallback'
              ? '<div class="agent-sub" style="color:var(--muted);font-size:11px">overall period · per-campaign split N/A</div>'
              : `<div class="agent-sub">${r.team} desk</div>`}
          </div>
        </div></td>
        <td><span class="pill ${r.team === 'RM' ? 'rm' : 'fancy'}">${r.team}</span></td>
        <td class="num tnum">${fmt(r.calls)}</td>
        <td class="num tnum">${fmt(r.leads)}</td>
        <td class="num"><span class="pill ${sc(r.success)}">${r.success}%</span></td>
        <td class="num tnum">${r.cph || '—'}</td>
      </tr>`).join('')
      : `<tr><td colspan="6" class="muted" style="text-align:center;padding:24px">No agent activity recorded for this campaign in this period.</td></tr>`;

    const anyFallback = rows.some(r => r.source === 'fallback');
    const html = `
      <div class="modal-backdrop" id="campaignModalBackdrop"></div>
      <div class="modal" id="campaignModal">
        <div class="modal-head">
          <div style="display:flex;align-items:center;gap:6px">
            <div>
              <div style="font-family:var(--serif);font-size:22px;font-weight:700;color:var(--ink)">
                ${colorDot}${escapeHtml(camp.name)}
              </div>
              <div class="sub" style="margin-top:4px;font-size:12.5px">
                ${camp.agentsCount} agent${camp.agentsCount === 1 ? '' : 's'} ·
                ${Q.PERIODS[period].label} ·
                ${camp.exact ? 'exact per-agent attribution' : 'overlap-based aggregation (historical week)'}
              </div>
            </div>
          </div>
          <button class="btn modal-close" id="campaignModalClose">✕ Close</button>
        </div>
        <div class="modal-body">
          <div class="row g-3">
            <div class="card card-pad"><div class="kpi-label" style="margin:0">Calls done</div>
              <div style="font-family:var(--serif);font-size:24px;font-weight:700;color:var(--ink);margin-top:4px">${fmt(camp.calls)}</div></div>
            <div class="card card-pad"><div class="kpi-label" style="margin:0">Total leads</div>
              <div style="font-family:var(--serif);font-size:24px;font-weight:700;color:var(--ink);margin-top:4px">${fmt(camp.leads)}</div></div>
            <div class="card card-pad"><div class="kpi-label" style="margin:0">Conversion</div>
              <div style="font-family:var(--serif);font-size:24px;font-weight:700;color:var(--ink);margin-top:4px">
                <span class="pill ${sc(conv)}" style="font-size:18px;padding:4px 10px">${conv}%</span>
              </div></div>
            <div class="card card-pad"><div class="kpi-label" style="margin:0">Leads breakdown</div>
              <div style="font-family:var(--serif);font-size:15px;font-weight:600;color:var(--ink);margin-top:6px;line-height:1.5">
                <b>${fmt(camp.seller)}</b> seller ·
                <b>${fmt(camp.rental)}</b> rental ·
                <b>${fmt(camp.email)}</b> email
              </div></div>
          </div>

          <div class="card mt">
            <div class="card-head"><div>
              <h3>Per-caller stats — ${escapeHtml(camp.name)}</h3>
              <div class="sub">${rows.length} agent${rows.length === 1 ? '' : 's'} contributed this period · click a row for the full drill-down</div>
            </div></div>
            <div class="tbl-wrap"><table class="tbl">
              <thead><tr>
                <th>Agent</th>
                <th>Team</th>
                <th class="num">Calls</th>
                <th class="num">Leads</th>
                <th class="num">Success</th>
                <th class="num">CPH</th>
              </tr></thead>
              <tbody>${rowsHtml}</tbody>
            </table></div>
          </div>

          ${anyFallback ? `<div class="muted" style="font-size:12px;line-height:1.6;margin-top:12px">
            <b style="color:var(--slate)">Note:</b>
            Some agents show their overall period stats instead of per-campaign
            numbers — those weeks pre-date the per-agent-per-campaign breakdown.
          </div>` : ''}
        </div>
      </div>`;

    let mount = document.getElementById('campaignModalMount');
    if (!mount) {
      mount = document.createElement('div');
      mount.id = 'campaignModalMount';
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
    document.getElementById('campaignModalClose').addEventListener('click', close);
    document.getElementById('campaignModalBackdrop').addEventListener('click', close);
    document.addEventListener('keydown', escClose);

    // Let the per-agent rows open the existing agent drill-down. The
    // campaign modal stays mounted underneath so the user can close back
    // into it (or the agent modal will sit on top).
    mount.querySelectorAll('tr[data-agent]').forEach(tr => {
      tr.addEventListener('click', () => openAgentModal(tr.dataset.agent));
    });
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
    else if (tab === 'monthly')    rows = csvMonthly();
    else if (tab === 'daily')      rows = csvDaily();
    else if (tab === 'payroll')    rows = csvPayroll();
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
  function csvDaily() {
    const date = dailyPicked || (Q.latestDailyDate && Q.latestDailyDate()) || null;
    const agents = (date && Q.dailyFor) ? (Q.dailyFor(date) || []) : [];
    const header = ['Date','Name','Team','Calls','Leads','Success %','Connect %','Dialler hrs','Clocked hrs','Eff %','Seller','Rental','Email'];
    const out = [header];
    agents.forEach(a => out.push([
      date, a.name, a.team, a.calls, a.leads, a.success, a.connect,
      a.df, a.ct, a.eff, a.seller || 0, a.rental || 0, a.email || 0,
    ]));
    return out;
  }

  function csvMonthly() {
    const rows = Q.monthlyBreakdown ? Q.monthlyBreakdown() : [];
    const header = ['Month','Weeks','RMs','Fancy','Total Calls','Success %','Seller Leads','Rental Leads','Emails'];
    const out = [header];
    rows.forEach(r => out.push([
      r.label, r.weeks, r.rmCount, r.fancyCount, r.calls, r.successRate,
      r.seller, r.rental, r.email,
    ]));
    return out;
  }

  function csvCompare() {
    // Mirror whichever picker mode is currently active in the Compare tab.
    // If the Month panel is visible, export the Month-A vs Month-B rows
    // (9 metrics). Otherwise export Week-A vs Week-B (8 metrics).
    const monthVisible = (() => {
      const mo = document.getElementById('cmpMonthPanel');
      return mo && mo.style.display !== 'none';
    })();

    const delta = (x, y, opts) => {
      const d = Number(x) - Number(y);
      const sign = d > 0 ? '+' : '';
      if (opts === 'pct')   return sign + d.toFixed(1) + ' pts';
      if (opts === 'hours') return sign + d.toFixed(2) + 'h';
      if (opts === 'rate')  return sign + d.toFixed(1);
      return sign + Math.round(d);
    };

    if (monthVisible) {
      const months = (Q.monthlyBreakdown && Q.monthlyBreakdown()) || [];
      const keyA = (document.getElementById('cmpMonthA') || {}).value || (months[0] && months[0].key);
      const keyB = (document.getElementById('cmpMonthB') || {}).value || (months[1] && months[1].key);
      const lookup = new Map(months.map(m => [m.key, m]));
      const a = lookup.get(keyA), b = lookup.get(keyB);
      if (!a || !b) return [['Metric','A','B','Change'], ['No data']];
      const header = ['Metric', a.label, b.label, 'Change'];
      return [header,
        ['Weeks of data',    a.weeks,       b.weeks,       delta(a.weeks, b.weeks)],
        ['Active callers',   a.activeCount, b.activeCount, delta(a.activeCount, b.activeCount)],
        ['Total calls',      a.calls,       b.calls,       delta(a.calls, b.calls)],
        ['Avg success rate', a.successRate.toFixed(1) + '%', b.successRate.toFixed(1) + '%', delta(a.successRate, b.successRate, 'pct')],
        ['Avg calls/hr',     a.cph.toFixed(1), b.cph.toFixed(1), delta(a.cph, b.cph, 'rate')],
        ['Seller leads',     a.seller,  b.seller,  delta(a.seller, b.seller)],
        ['Rental leads',     a.rental,  b.rental,  delta(a.rental, b.rental)],
        ['Emails collected', a.email,   b.email,   delta(a.email, b.email)],
        ['Dialler hours',    a.dfHours.toFixed(2) + 'h', b.dfHours.toFixed(2) + 'h', delta(a.dfHours, b.dfHours, 'hours')],
      ];
    }

    const weeks = (Q.weeksBreakdown && Q.weeksBreakdown()) || [];
    const keyA = (document.getElementById('cmpWeekA') || {}).value || (weeks[0] && weeks[0].key);
    const keyB = (document.getElementById('cmpWeekB') || {}).value || (weeks[1] && weeks[1].key);
    const lookup = new Map(weeks.map(w => [w.key, w]));
    const a = lookup.get(keyA), b = lookup.get(keyB);
    if (!a || !b) return [['Metric','A','B','Change'], ['No data']];
    const header = ['Metric', a.label, b.label, 'Change'];
    return [header,
      ['Active callers',   a.activeCount, b.activeCount, delta(a.activeCount, b.activeCount)],
      ['Total calls',      a.calls,       b.calls,       delta(a.calls, b.calls)],
      ['Avg success rate', a.successRate.toFixed(1) + '%', b.successRate.toFixed(1) + '%', delta(a.successRate, b.successRate, 'pct')],
      ['Avg calls/hr',     a.cph.toFixed(1), b.cph.toFixed(1), delta(a.cph, b.cph, 'rate')],
      ['Seller leads',     a.seller,  b.seller,  delta(a.seller, b.seller)],
      ['Rental leads',     a.rental,  b.rental,  delta(a.rental, b.rental)],
      ['Emails collected', a.email,   b.email,   delta(a.email, b.email)],
      ['Dialler hours',    a.dfHours.toFixed(2) + 'h', b.dfHours.toFixed(2) + 'h', delta(a.dfHours, b.dfHours, 'hours')],
    ];
  }
  function csvManager() {
    // Manager tab currently shows campaign data; reuse the campaign CSV.
    return csvCampaigns();
  }

  // Payroll exports whichever sub-view is currently active so the file
  // mirrors what's on screen.
  function csvPayroll() {
    const s = payrollState || {};
    const view = s.activeView || 'allShifts';
    const periodLbl = s.period ? s.period.label : '';
    if (view === 'allShifts') {
      const out = [['Agent', 'Type', 'Date in', 'Time in', 'Date out', 'Time out', 'Employee notes', 'Shift hours (HH:MM)', 'Shift hours (Decimal)']];
      (s.shifts || []).forEach(sh => {
        const d = window.PAYROLL.decimalToHHMM(sh.shiftHours);
        const fmtD = iso => iso ? new Date(iso).toISOString().slice(0, 10) : '';
        const fmtT = iso => {
          if (!iso) return '';
          const dt = new Date(iso);
          return `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
        };
        out.push([sh.agentName, sh.designation || '', fmtD(sh.clockInAt), fmtT(sh.clockInAt),
          fmtD(sh.clockOutAt), fmtT(sh.clockOutAt), sh.note || '', d, sh.shiftHours.toFixed(2)]);
      });
      return out;
    }
    if (view === 'perAgent') {
      const out = [['Agent', 'Team / Division', 'Hours (HH:MM)', 'Hours (Decimal)', '% of Agent Time', 'Hourly Rate', 'R-amount']];
      if (s.allocations) {
        const ETH = s.allocations.empTeamHours;
        const ETOT = s.allocations.empTotalHours;
        const EMETA = s.allocations.empMeta || new Map();
        const agents = Array.from(ETH.keys()).sort((a, b) => a.localeCompare(b));
        agents.forEach(agent => {
          const teams = Array.from(ETH.get(agent).entries()).sort((a, b) => b[1] - a[1]);
          const total = ETOT.get(agent) || 0;
          const rate = EMETA.get(agent) ? EMETA.get(agent).hourlyRate : null;
          let sumPay = 0;
          teams.forEach(([t, hrs]) => {
            const pct = total > 0 ? (hrs / total) * 100 : 0;
            const pay = rate != null ? hrs * rate : null;
            if (pay != null) sumPay += pay;
            out.push([agent, t, window.PAYROLL.decimalToHHMM(hrs), hrs.toFixed(2),
              pct.toFixed(1) + '%', rate == null ? '' : rate.toFixed(2),
              pay == null ? '' : pay.toFixed(2)]);
          });
          out.push([agent + ' — TOTAL', '', window.PAYROLL.decimalToHHMM(total),
            total.toFixed(2), '100.0%',
            rate == null ? '' : rate.toFixed(2),
            rate == null ? '' : sumPay.toFixed(2)]);
        });
      }
      return out;
    }
    if (view === 'earnings') {
      const out = [['First name', 'Last name', 'Designation', 'Division',
        'Hours (HH:MM)', 'Hours (Decimal)', 'Hourly Rate', 'Total Pay']];
      if (s.allocations) {
        const ETOT = s.allocations.empTotalHours;
        const EMETA = s.allocations.empMeta || new Map();
        const agents = Array.from(ETOT.keys()).sort((a, b) => a.localeCompare(b));
        let gHrs = 0, gPay = 0;
        agents.forEach(agent => {
          const total = ETOT.get(agent) || 0;
          const meta = EMETA.get(agent) || {};
          const rate = meta.hourlyRate;
          const pay = rate != null ? total * rate : null;
          gHrs += total;
          if (pay != null) gPay += pay;
          const parts = (agent || '').split(/\s+/);
          const fn = parts.slice(0, -1).join(' ') || parts[0] || '';
          const ln = parts.length > 1 ? parts[parts.length - 1] : '';
          out.push([fn, ln, meta.designation || '', meta.division || '',
            window.PAYROLL.decimalToHHMM(total), total.toFixed(2),
            rate == null ? '' : rate.toFixed(2),
            pay == null ? '' : pay.toFixed(2)]);
        });
        out.push(['TOTAL', '', '', '',
          window.PAYROLL.decimalToHHMM(gHrs), gHrs.toFixed(2), '', gPay.toFixed(2)]);
      }
      return out;
    }
    if (view === 'byDivision') {
      // Wide pivot — match the on-screen layout.
      const ETH = s.allocations ? s.allocations.empTeamHours : new Map();
      const ETOT = s.allocations ? s.allocations.empTotalHours : new Map();
      const teamEmp = new Map();
      ETH.forEach((teams, emp) => teams.forEach((hrs, t) => {
        if (!teamEmp.has(t)) teamEmp.set(t, new Map());
        teamEmp.get(t).set(emp, hrs);
      }));
      let maxHead = 1;
      teamEmp.forEach(m => { if (m.size > maxHead) maxHead = m.size; });
      const header = ['Division'];
      for (let i = 1; i <= maxHead; i++) { header.push(`F NAME / LN NAME ${i}`); header.push('PERCENTAGE'); }
      header.push('Notes');
      const out = [header];
      const rowFor = (team, note) => {
        const members = teamEmp.get(team) || new Map();
        const sorted = Array.from(members.entries()).map(([emp, hrs]) => {
          const tot = ETOT.get(emp) || 0;
          return { emp, pct: tot > 0 ? hrs / tot : 0 };
        }).sort((a, b) => b.pct - a.pct);
        const row = [team];
        for (let i = 0; i < maxHead; i++) {
          if (i < sorted.length) {
            row.push(sorted[i].emp);
            row.push(Math.round(window.PAYROLL.roundHalfUp(sorted[i].pct) * 100) + '%');
          } else { row.push(''); row.push(''); }
        }
        row.push(note);
        return row;
      };
      window.PAYROLL.CANONICAL_TEAMS.forEach(t => {
        const members = teamEmp.get(t);
        out.push(rowFor(t, (members && members.size) ? '' : 'no agents this period'));
      });
      const nonCanon = [];
      teamEmp.forEach((_m, t) => {
        if (!window.PAYROLL.CANONICAL_SET.has(t) && t !== '(No team noted)') nonCanon.push(t);
      });
      nonCanon.sort((a, b) => a.localeCompare(b));
      if (nonCanon.length || teamEmp.has('(No team noted)')) {
        out.push(['--- Not in master list — review ---']);
        nonCanon.forEach(t => out.push(rowFor(t, 'Not in master list')));
        if (teamEmp.has('(No team noted)')) out.push(rowFor('(No team noted)', 'Shifts where the Employee notes field was blank'));
      }
      return out;
    }
    if (view === 'divisionCosts') {
      // Cost-attribution wide pivot — mirrors the Excel bookkeeper sheet.
      const SDL_RATE = 0.011;
      const ETH = s.allocations ? s.allocations.empTeamHours : new Map();
      const ETOT = s.allocations ? s.allocations.empTotalHours : new Map();
      const EMETA = s.allocations ? (s.allocations.empMeta || new Map()) : new Map();
      const teamEmp = new Map();
      ETH.forEach((teams, emp) => teams.forEach((hrs, t) => {
        if (!teamEmp.has(t)) teamEmp.set(t, new Map());
        teamEmp.get(t).set(emp, hrs);
      }));
      let maxHead = 1;
      teamEmp.forEach(m => { if (m.size > maxHead) maxHead = m.size; });
      const header = ['Division'];
      for (let i = 1; i <= maxHead; i++) {
        header.push(`Fancy / LN name ${i}`);
        header.push('Payroll amount');
        header.push('SDL');
        header.push('Percentage');
        header.push('Div contribution');
      }
      header.push('Total Fancy/LN');
      header.push('Notes');
      const out = [header];
      // Floor-level PAYROLL/SDL totals (each agent once) + per-slot CONTRIB.
      // Mirrors the on-screen Division Costs grand-total semantics.
      const gtCountedEmps = new Set();
      let gtPayrollTotal = 0;
      let gtSdlTotal = 0;
      const gtContrib = new Array(maxHead).fill(0);
      let gtRowTotal = 0;
      const fmt2 = n => (n == null ? '' : Number(n).toFixed(2));
      const rowFor = (team, note) => {
        const members = teamEmp.get(team) || new Map();
        const enriched = Array.from(members.entries()).map(([emp, hrs]) => {
          const meta = EMETA.get(emp);
          const rate = meta ? meta.hourlyRate : null;
          const total = ETOT.get(emp) || 0;
          const payroll = rate != null ? total * rate : null;
          const sdl = payroll != null ? payroll * SDL_RATE : null;
          const pct = total > 0 ? (hrs / total) : 0;
          // (PAYROLL × PCT) / 2 + (SDL × PCT) — SDL is NOT halved.
          const contrib = (payroll != null && sdl != null)
            ? (payroll * pct) / 2 + (sdl * pct)
            : null;
          return { emp, payroll, sdl, contrib, pct };
        }).sort((a, b) => (b.contrib || 0) - (a.contrib || 0));
        const row = [team];
        let rowTotal = 0;
        for (let i = 0; i < maxHead; i++) {
          if (i < enriched.length) {
            const x = enriched[i];
            row.push(x.emp);
            row.push(fmt2(x.payroll));
            row.push(fmt2(x.sdl));
            row.push((x.pct * 100).toFixed(1) + '%');
            row.push(fmt2(x.contrib));
            if (!gtCountedEmps.has(x.emp)) {
              if (x.payroll != null) gtPayrollTotal += x.payroll;
              if (x.sdl != null)     gtSdlTotal += x.sdl;
              gtCountedEmps.add(x.emp);
            }
            if (x.contrib != null) { gtContrib[i] += x.contrib; rowTotal += x.contrib; }
          } else {
            row.push(''); row.push(''); row.push(''); row.push(''); row.push('');
          }
        }
        row.push(fmt2(rowTotal));
        row.push(note);
        gtRowTotal += rowTotal;
        return row;
      };
      window.PAYROLL.CANONICAL_TEAMS.forEach(t => {
        const members = teamEmp.get(t);
        out.push(rowFor(t, (members && members.size) ? '' : 'no agents this period'));
      });
      const nonCanon = [];
      teamEmp.forEach((_m, t) => {
        if (!window.PAYROLL.CANONICAL_SET.has(t) && t !== '(No team noted)') nonCanon.push(t);
      });
      nonCanon.sort((a, b) => a.localeCompare(b));
      if (nonCanon.length || teamEmp.has('(No team noted)')) {
        out.push(['--- Not in master list — review ---']);
        nonCanon.forEach(t => out.push(rowFor(t, 'Not in master list')));
        if (teamEmp.has('(No team noted)')) out.push(rowFor('(No team noted)', 'Shifts where the Employee notes field was blank'));
      }
      // Grand-total row — floor PAYROLL/SDL in slot 0 only, per-slot CONTRIB.
      const tot = ['GRAND TOTAL'];
      for (let i = 0; i < maxHead; i++) {
        tot.push('');
        tot.push(i === 0 ? fmt2(gtPayrollTotal) : '');
        tot.push(i === 0 ? fmt2(gtSdlTotal) : '');
        tot.push('');
        tot.push(fmt2(gtContrib[i]));
      }
      tot.push(fmt2(gtRowTotal));
      tot.push('');
      out.push(tot);
      return out;
    }
    if (view === 'dataQuality') {
      const rv = (s.allocations || {}).rawVariantsPerTeam || new Map();
      const out = [['Pay period', periodLbl], [], ['Canonical Team', 'Original notes / variants seen', '# variants']];
      const teams = Array.from(rv.keys()).sort((a, b) => a.localeCompare(b));
      teams.forEach(t => {
        const variants = Array.from(rv.get(t)).sort((a, b) => a.localeCompare(b));
        out.push([t, variants.join(' | '), variants.length]);
      });
      return out;
    }
    return [['No data']];
  }

  // Defensive: clear any leftover dark-mode state from earlier builds.
  document.documentElement.removeAttribute('data-theme');
  try { localStorage.removeItem('q1theme'); } catch (e) {}

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

    const top10 = agents.slice(0, 6).map((a, i) => {
      const medal = i === 0 ? 'g' : i === 1 ? 's' : i === 2 ? 'b' : 'n';
      const sc = sucClass(a.success);
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
        ${kpi(I.trophy, 'Avg Success Rate', t.avgSuccess + '%', d.success, 'all positive outcomes ÷ calls')}
        ${kpi(I.target, 'Total Leads', fmt(t.leads), d.leads, 'seller · rental · email')}
        ${kpi(I.users, 'Active Callers', t.active + '', d.active, 'RM + Fancy desks combined')}
      </div>

      <!-- trend + sources -->
      <div class="row g-2-1 mt">
        <div class="card">
          <div class="card-head">
            <div><h3>Weekly Performance Trend</h3><div class="sub">Calls &amp; success rate · trailing window ending ${Q.PERIODS[period].label.toLowerCase()}</div></div>
            <div class="legend" style="padding:0">
              <span class="legend-item"><span class="legend-swatch" style="background:#FDC503"></span>Calls</span>
              <span class="legend-item"><span class="legend-swatch" style="background:#3D5BA6"></span>Success rate</span>
            </div>
          </div>
          <div class="chart-wrap"><div id="trendChart"></div></div>
        </div>
        <div class="card">
          <div class="card-head"><div><h3>Lead Sources</h3><div class="sub">Share of calls · ${Q.PERIODS[period].label}</div></div></div>
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
          <div class="spot-stat" style="margin-top:14px"><b>${risk.success}%</b> success · target <b>${(CFG.BENCHMARKS && CFG.BENCHMARKS.rm_success_rate) || 17}%</b> · ${fmt(risk.calls)} calls</div>
        </div>
      </div>

      <!-- schedule adherence (real clock-in data) -->
      <div class="mt">
        ${scheduleAdherenceCard()}
      </div>

      <!-- insights + top10 -->
      <div class="row g-2-1 mt" style="align-items:start">
        <div class="card">
          <div class="card-head"><div><h3>Top 6 Performers</h3><div class="sub">Ranked by calls · open All Staff for the full roster</div></div>
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
    const last = series[series.length - 1] || 0;
    const prev = series[series.length - 2] || 0;
    // Guard the % — a zero baseline used to print "Infinity%".
    const pct = prev ? (((last - prev) / prev) * 100).toFixed(1) : '—';
    const up = last >= prev;
    const unit = label === 'DialFire hrs' ? 'h' : '';
    return `<div class="card mini">
      <div class="mini-head">${icon} ${label} by month</div>
      <div class="mini-sub">last 8 months</div>
      <div class="mini-val tnum">${fmt(last)}${unit}<span style="color:${up ? 'var(--green)' : 'var(--red)'}">${pct === '—' ? '—' : (up ? '▲' : '▼') + ' ' + Math.abs(parseFloat(pct)) + '%'}</span></div>
      <div style="margin-top:10px" class="mc" data-series='${JSON.stringify(series)}' data-color="${color}"></div>
    </div>`;
  }

  function insights(t, d, top, bestSrc, risk, src) {
    const worstSrc = src[src.length - 1];
    // Sign-aware momentum insight — the previous version hard-coded
    // "climbed … momentum is healthy" even when call volume or success
    // rate fell. Now we branch on the sign and switch to a "dropped …
    // investigate trend" copy + red/down icon when negative.
    const callsUp = (d.calls || 0) >= 0;
    const succUp  = (d.success || 0) >= 0;
    const momentumType = (callsUp && succUp) ? 'up'
                      : (!callsUp && !succUp) ? 'down'
                      : 'warn';
    const callsCopy = callsUp
      ? `<b>Call volume climbed ${Math.abs(d.calls)}%</b> versus the previous period`
      : `<b>Call volume dropped ${Math.abs(d.calls)}%</b> versus the previous period`;
    const succCopy = succUp
      ? `success rate improved ${Math.abs(d.success)} pts — momentum is healthy across both desks.`
      : `success rate slipped ${Math.abs(d.success)} pts — investigate the trend.`;
    const momentumAction = (callsUp && succUp)
      ? 'Lock in the current dialling cadence'
      : 'Dig into what changed period-over-period';
    const items = [
      { type: momentumType, html: `${callsCopy} while ${succCopy}`,
        action: momentumAction },
      { type: 'info', html: `<b>${bestSrc.name}</b> is the strongest channel at <b>${bestSrc.conv}% conversion</b>, well ahead of ${worstSrc.name} (${worstSrc.conv}%).`,
        action: 'Shift spend toward ' + bestSrc.name },
      { type: 'warn', html: `<b>${risk.name}</b> is converting at just <b>${risk.success}%</b>, below the ${(CFG.BENCHMARKS && CFG.BENCHMARKS.rm_success_rate) || 17}% target despite ${fmt(risk.calls)} calls — likely a quality not volume issue.`,
        action: 'Schedule a call-quality coaching session' },
      { type: 'up', html: `<b>${top.name}</b> leads the floor with ${fmt(top.calls)} calls and ${top.success}% success — a useful benchmark for the team.`,
        action: 'Share top-performer call recordings' },
    ];
    const iconFor = t => t === 'up' ? I.up
                       : t === 'down' ? I.down
                       : t === 'warn' ? I.alert
                       : I.spark;
    return items.map(it => `
      <div class="insight">
        <div class="insight-ic ${it.type}">${iconFor(it.type)}</div>
        <div class="insight-body"><p>${it.html}</p>
          <div class="insight-action">${I.arrow}${it.action}</div></div>
      </div>`).join('');
  }

  function afterOverview() {
    // Both the weekly trend chart and the lead-sources donut follow the
    // topbar period selector, so the visuals match the KPI block above.
    const trend = (Q.trendSeriesFor ? Q.trendSeriesFor(period) : null)
      || { labels: Q.WEEKS, calls: Q.WEEK_CALLS, success: Q.WEEK_SUCCESS };
    C.weeklyTrend(document.getElementById('trendChart'), trend.labels, trend.calls, trend.success);
    const periodSources = Q.sourcesFor ? Q.sourcesFor(period) : Q.SOURCES;
    const total = periodSources.reduce((s, x) => s + x.calls, 0);
    C.donut(document.getElementById('donut'),
      periodSources.map(s => ({ value: s.calls, color: s.color })),
      fmt(total), 'total calls');
    document.querySelectorAll('.mc').forEach(el =>
      C.miniBars(el, JSON.parse(el.dataset.series), el.dataset.color));
    document.querySelectorAll('[data-goto]').forEach(b =>
      b.addEventListener('click', () => { tab = b.dataset.goto; shell(); }));
    wireAgentClicks();
    wireFlagAckButtons();
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

    // Revenue estimate — looks up per-team R/lead from TEAM_RAND_PER_LEAD
    // (source: "Rand per Lead" sheet column F, = (annual sales × 4%) ÷ units).
    // Falls back to REVENUE_PER_LEAD.default for unmapped / generic campaigns.
    const rev = CFG.REVENUE_PER_LEAD || { default: 100506 };
    const teamRates = CFG.TEAM_RAND_PER_LEAD || {};
    const teamRateLookup = (() => {
      const ci = new Map();
      Object.entries(teamRates).forEach(([k, v]) => ci.set(String(k).toLowerCase(), Number(v)));
      return (camp) => ci.get(String(camp || '').toLowerCase().trim());
    })();
    // Revenue ceiling — sellers and rentals use different rates; emails are
    // a successful outcome but contribute R0.
    //   seller × per-team rate (closed-unit comm from "Rand per Lead" sheet)
    //   rental × CFG.RENTAL_RAND_PER_LEAD (single base — set in config.js)
    //   email  × 0
    const camps0 = Q.campaignsFor(period);
    const rentalRate = Number(CFG.RENTAL_RAND_PER_LEAD || 0);
    let revenue = 0;
    let sellerLeads = 0, rentalLeads = 0;
    let sellerMatched = 0, sellerUnmatched = 0;
    camps0.forEach(c => {
      const s = c.seller || 0;
      const r = c.rental || 0;
      sellerLeads += s;
      rentalLeads += r;
      if (s > 0) {
        const rate = teamRateLookup(c.name);
        if (rate != null) { revenue += s * rate; sellerMatched += s; }
        else              { revenue += s * (rev.default || 100506); sellerUnmatched += s; }
      }
      if (r > 0) revenue += r * rentalRate;
    });

    // Efficiency: avg dialler/clocked across agents
    const eff = agents.length
      ? Math.round(agents.reduce((s, a) => s + (a.eff || 0), 0) / agents.length)
      : 0;

    // Top campaigns by call share
    const camps = Q.campaignsFor(period).slice(0, 5);
    const campTotal = Q.campaignsFor(period).reduce((s, c) => s + c.calls, 0) || 1;

    // Red flags — Leadership view skips the per-person schedule flags
    // (no-shows, chronic lateness). Those are HR/manager territory and
    // still surface on Overview where managers see them.
    const flags = redFlags(agents, d, rmT, fcT, { includeSchedule: false, includeInactive: false });

    // Progress vs last period — beat your previous week / month rather
    // than a stale hard-coded floor target.
    const prev = Q.prevTotalsFor(period);
    const tgtCalls = prev.calls;
    const tgtLeads = prev.leads;
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

    // Re-use the shared Red Flags card template so leadership and manager
    // never drift on layout / ack behaviour.
    const flagsCard = flagsCardHtml(flags, { sub: 'Auto-detected from this period' });

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
      <div class="construction-banner" role="status" aria-live="polite">
        <svg class="cb-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/></svg>
        <div>
          <b>Still under construction</b> — this view is a work in progress.
          <div class="cb-sub">Numbers, layout, and metrics may change while we finalise the leadership snapshot.</div>
        </div>
      </div>
      <!-- Hero KPIs -->
      <div class="row kpis">
        ${kpi(I.phone,   'Total Calls',        fmt(t.calls), d.calls,   'vs previous ' + Q.PERIODS[period].label.toLowerCase())}
        ${kpi(I.trophy,  'Success Rate',       t.avgSuccess + '%', d.success, 'all positive outcomes ÷ calls · matches Dialfire')}
        ${kpi(I.bolt,    'Team Efficiency',    eff + '%', null, 'dialler ÷ clocked-in time')}
        ${kpi(I.medal,   'Estimated revenue',  'R ' + fmt(Math.round(revenue)), null,
              fmt(sellerLeads) + ' seller × team rate + ' + fmt(rentalLeads) + ' rental × R' + fmt(rentalRate) + ' · emails R0')}
      </div>

      <div class="divider-note">Strategic snapshot</div>
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
            <h3 style="margin:0">Pace vs last period</h3>
            <div class="sub">${period === 'this-week' || period === 'last-week' ? 'Beat last week’s totals' : 'Beat last month’s totals'} · auto-set from actuals</div>
          </div></div>
          ${tgtBar('Total calls', t.calls, tgtCalls)}
          ${tgtBar('Total leads', t.leads, tgtLeads)}
          <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);line-height:1.7">
            Revenue estimate uses <b style="color:var(--ink)">R${fmt(rev.seller || rev.default)} seller / R${fmt(rev.rental || rev.default)} rental / R${fmt(rev.email || rev.default)} email</b>. Adjust in <code>quay/config.js</code> for accuracy.
          </div>
        </div>
      </div>

      <div class="divider-note">Performance trends</div>
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

      <!-- Revenue model — per-campaign breakdown that drove the ceiling -->
      ${revenueModelCard(camps0, teamRateLookup, rev.default, rentalRate)}

      <!-- Top performers + Red flags. align-items:stretch so the
           shorter Top-5 card fills the same row height as the
           longer Red Flags card (with its attended-flags collapsible)
           — without this the page shows a tall empty gap below the
           Top-5 card and before Historical Comparison. -->
      <div class="divider-note">People &amp; flags</div>
      <div class="row g-2-1 mt" style="align-items:stretch">
        <div class="card" style="display:flex;flex-direction:column">
          <div class="card-head"><div><h3 id="leadership-top5-h">Top 5 performers</h3><div class="sub">Ranked by composite (success rate × calls)</div></div>
            <button class="btn" data-goto="staff">${I.eye} View all</button></div>
          <div class="tbl-wrap" style="flex:1"><table class="tbl" aria-labelledby="leadership-top5-h">
            <thead><tr><th style="width:48px">Rank</th><th>Agent</th><th class="num">Calls</th><th class="num">Leads</th><th class="num">Success</th></tr></thead>
            <tbody>${top5.map((a, i) => {
              const medal = i === 0 ? 'g' : i === 1 ? 's' : i === 2 ? 'b' : 'n';
              const sc = sucClass(a.success);
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
        ${flagsCard}
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

  // Renders the per-campaign breakdown driving the Revenue Ceiling KPI.
  // Splits seller (per-team rate) from rental (flat base). Emails are
  // shown as a count but contribute R0.
  function revenueModelCard(campaigns, rateLookup, fallback, rentalRate) {
    const rentalR = Number(rentalRate || 0);
    const rows = (campaigns || [])
      .filter(c => (c.seller || 0) + (c.rental || 0) + (c.email || 0) > 0)
      .map(c => {
        const rate = rateLookup(c.name);
        const matched = rate != null;
        const r = matched ? rate : fallback;
        const sellerRev = (c.seller || 0) * r;
        const rentalRev = (c.rental || 0) * rentalR;
        return { name: c.name, seller: c.seller || 0, rental: c.rental || 0, email: c.email || 0,
                 rate: r, matched, sellerRev, rentalRev, revenue: sellerRev + rentalRev };
      })
      .sort((a, b) => b.revenue - a.revenue);
    if (!rows.length) return '';
    return `
      <div class="card mt">
        <div class="card-head"><div><h3>Revenue model</h3>
          <div class="sub">Sellers × team rate (from "Rand per Lead") + rentals × R${fmt(rentalR)} · emails contribute R0</div></div></div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th>Campaign / Team</th>
            <th class="num">Seller</th><th class="num">@ R/lead</th>
            <th class="num">Rental</th>
            <th class="num">Email</th>
            <th class="num">Revenue</th>
          </tr></thead>
          <tbody>${rows.map(r => `
            <tr>
              <td><b>${r.name}</b> ${r.matched ? '' : '<span class="pill" style="background:#EEF0F6;color:var(--muted);font-size:10px;font-weight:700;margin-left:6px" title="Campaign not in TEAM_RAND_PER_LEAD — using floor average">floor avg</span>'}</td>
              <td class="num tnum">${fmt(r.seller)}</td>
              <td class="num tnum" style="color:var(--muted)">R ${fmt(r.rate)}</td>
              <td class="num tnum">${fmt(r.rental)}</td>
              <td class="num tnum" style="color:var(--muted)">${fmt(r.email)}</td>
              <td class="num tnum"><b>R ${fmt(Math.round(r.revenue))}</b></td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </div>`;
  }

  // Live Dialfire stats pushed by the local Mac daemon (every ~90s).
  // Reads from public.live_stats; the dashboard subscribes via Supabase
  // realtime in subscribeRealtime() so updates land instantly.
  let liveStats = []; // [{ staff_id, name, calls, leads, work_hours, success_rate, updated_at }]
  let liveStatsByName = new Map(); // lookup: name lowercased + first+last form
  async function loadLiveStats() {
    if (!window.sb) return;
    try {
      const { data, error } = await window.sb
        .from('live_stats')
        .select('staff_id,name,calls,leads,seller_leads,rental_leads,email_leads,work_hours,success_rate,updated_at')
        .order('calls', { ascending: false });
      if (error) throw error;
      liveStats = data || [];
      liveStatsByName = new Map();
      const stash = (key, row) => {
        if (key && !liveStatsByName.has(key)) liveStatsByName.set(key, row);
      };
      liveStats.forEach(row => {
        const n = (row.name || '').trim();
        if (n) {
          stash(n.toLowerCase(), row);
          const parts = n.split(/\s+/);
          if (parts.length >= 2) {
            stash((parts[0] + ' ' + parts[parts.length - 1]).toLowerCase(), row);
          }
        }
      });
    } catch (e) {
      console.warn('[live] loadLiveStats failed', e.message || e);
    }
  }
  function liveStatsFor(name) {
    const n = (name || '').trim().toLowerCase();
    if (!n) return null;
    let row = liveStatsByName.get(n);
    if (!row) {
      const parts = name.trim().split(/\s+/);
      if (parts.length >= 2) {
        row = liveStatsByName.get((parts[0] + ' ' + parts[parts.length - 1]).toLowerCase());
      }
    }
    return row || null;
  }
  function liveStatsFreshness() {
    if (!liveStats.length) return null;
    let latest = 0;
    liveStats.forEach(r => {
      const t = r.updated_at ? new Date(r.updated_at).getTime() : 0;
      if (t > latest) latest = t;
    });
    return latest ? new Date(latest) : null;
  }

  // ─── Floor Health + Live Floor ──────────────────────────────────────
  // Quick "is the floor healthy?" pill for executives. Reads from the same
  // flag/KPI sources the rest of the dashboard uses so it never drifts.
  function floorHealth() {
    const flags = (typeof currentFlags === 'function') ? currentFlags() : [];
    const openFlagCount = flags.filter(f => !f.key || !flagAcks.has(f.key)).length;
    let t = { calls: 0, leads: 0, avgSuccess: 0 };
    try { t = Q.totalsFor(period) || t; } catch {}
    const targetSR = (CFG.RED_FLAGS && CFG.RED_FLAGS.target_success_rate) || 12;
    const sr = t.avgSuccess || 0;

    let status = 'green';
    const reasons = [];
    if (openFlagCount >= 3) {
      status = 'red';
      reasons.push(`${openFlagCount} open red flags`);
    } else if (openFlagCount >= 1) {
      status = 'amber';
      reasons.push(`${openFlagCount} open red flag${openFlagCount === 1 ? '' : 's'}`);
    }
    if (sr > 0 && sr < targetSR * 0.7) {
      status = 'red';
      reasons.push(`Success rate ${sr.toFixed(1)}% (target ${targetSR}%)`);
    } else if (sr > 0 && sr < targetSR) {
      if (status !== 'red') status = 'amber';
      reasons.push(`Success rate ${sr.toFixed(1)}% below ${targetSR}% target`);
    }
    if (status === 'green') reasons.push('All metrics on track');
    return { status, reasons, openFlagCount, successRate: sr };
  }

  function floorHealthPillHtml() {
    const h = floorHealth();
    const labelMap = { green: 'Healthy', amber: 'Watch', red: 'Critical' };
    return `<button class="health-pill health-pill--${h.status}" id="floorHealthPill"
              title="${escapeHtml(h.reasons.join(' · '))}">
      <span class="health-dot"></span>
      <span class="health-status">Floor: ${labelMap[h.status]}</span>
      <span class="health-reason">${escapeHtml(h.reasons.join(' · '))}</span>
    </button>`;
  }

  // The Live Floor view: one card per agent currently clocked in (or out
  // today), driven by schedule.byStaff (loaded from Supabase events) and
  // enriched with today's Dialfire call/lead counts when available.
  function renderLiveFloor() {
    const todayKey = sastDateStr(new Date());
    // Sort hierarchy (top -> bottom):
    //   1. Active callers — calls > 0, ordered by calls desc (matches the
    //      quay-clock admin vibe of "people doing things first").
    //   2. On-the-clock but no calls yet.
    //   3. Already clocked out for the day.
    //   4. Not in yet / no schedule entry.
    // Each card is collected with a sort key so we can flatten at the end.
    const cards = [];  // [{key: [bucket, -calls, name], html}]

    // Per-agent today's calls/leads. PRIMARY source is the live_stats table
    // (Mac daemon polls Dialfire every ~90s, pushes via Supabase realtime).
    // If no live row for an agent we fall back to the most-recent daily
    // snapshot so newly-clocked-in agents aren't blank between daemon polls.
    const latestDate = (Q.latestDailyDate && Q.latestDailyDate()) || null;
    const todayList = latestDate ? (Q.dailyFor && Q.dailyFor(latestDate)) || [] : [];
    const callsByName = new Map();
    todayList.forEach(a => {
      const k = (a.name || '').trim().toLowerCase();
      if (k) callsByName.set(k, a);
    });

    let onlineCount = 0, offlineCount = 0, totalRoster = 0;
    let totalCallsToday = 0, totalLeadsToday = 0;
    let activeCallerCount = 0;

    if (schedule && schedule.byStaff && schedule.byStaff.size) {
      schedule.byStaff.forEach(rec => {
        totalRoster++;
        const today = rec.days && rec.days[todayKey];
        const inAt = today && today.first ? today.first : null;
        const outAt = today && today.last ? today.last : null;
        const isIn = !!(inAt && (!outAt || outAt < inAt));
        if (isIn) onlineCount++; else offlineCount++;

        const initials = (rec.name || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
        const avColor = avatarColor(rec.name);
        const cardClass = isIn ? 'live-card live-card--in' : 'live-card live-card--out';
        const pillClass = isIn ? 'live-pill live-pill--in' : 'live-pill live-pill--out';
        const pillText  = isIn ? 'On the clock' : (outAt ? 'Clocked out' : 'Not in yet');

        // Prefer live_stats; fall back to the daily snapshot.
        const fullKey = (rec.name || '').toLowerCase().trim();
        const parts = (rec.name || '').trim().split(/\s+/);
        const flKey = parts.length >= 2 ? (parts[0] + ' ' + parts[parts.length - 1]).toLowerCase() : null;
        const liveRow = liveStatsFor(rec.name);
        const dailyAgent = callsByName.get(fullKey) || (flKey && callsByName.get(flKey)) || null;
        const todayCalls  = liveRow ? liveRow.calls         : (dailyAgent ? dailyAgent.calls  : null);
        // "Leads" = seller leads only. Rental + email stay as their own columns.
        const todayLeads  = liveRow ? liveRow.seller_leads  : (dailyAgent ? (dailyAgent.seller || 0) : null);
        const todayRental = liveRow ? liveRow.rental_leads  : (dailyAgent ? dailyAgent.rental : null);
        const todayEmail  = liveRow ? liveRow.email_leads   : (dailyAgent ? dailyAgent.email  : null);
        if (todayCalls != null) totalCallsToday += todayCalls;
        if (todayLeads != null) totalLeadsToday += todayLeads;  // seller leads only
        if (todayCalls && todayCalls > 0) activeCallerCount++;

        const fmtT = (d) => d ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' }) : '—';
        const elapsedMs = inAt ? (Math.max(outAt || new Date(), inAt) - inAt) : 0;
        const elapsedH = elapsedMs > 0 ? (elapsedMs / 3.6e6) : 0;
        const elapsedTxt = elapsedH > 0 ? `${Math.floor(elapsedH)}h ${Math.round((elapsedH % 1) * 60)}m` : '—';

        const html = `<div class="${cardClass}" data-agent-id="${escapeHtml(rec.id)}">
          <div class="live-card-head">
            <div class="live-av" style="background:${avColor}">${initials}</div>
            <div style="flex:1 1 auto;min-width:0">
              <div class="live-card-name">${escapeHtml(rec.name)}</div>
              <div class="live-card-team">${isIn ? 'In at ' + fmtT(inAt) + ' · ' + elapsedTxt : (outAt ? 'Out at ' + fmtT(outAt) : 'Awaiting clock-in')}</div>
            </div>
            <span class="${pillClass}">${pillText}</span>
          </div>
          <div class="live-card-meta">
            <div>
              <div class="live-stat-label">Calls</div>
              <div class="live-stat-val tnum">${todayCalls != null ? fmt(todayCalls) : '—'}</div>
            </div>
            <div title="Calls touching leads in LEAD status. Includes follow-up calls — true per-period leads need Dialfire Processing report scope.">
              <div class="live-stat-label">Lead·calls</div>
              <div class="live-stat-val tnum">${todayLeads != null ? fmt(todayLeads) : '—'}</div>
            </div>
            <div title="Calls touching leads in RENTAL_LEAD status. Same caveat as Lead·calls.">
              <div class="live-stat-label">Rental·calls</div>
              <div class="live-stat-val tnum">${todayRental != null ? fmt(todayRental) : '—'}</div>
            </div>
            <div title="Calls touching leads in GOT_EMAIL status. Includes follow-up calls to previously-emailed leads.">
              <div class="live-stat-label">Email·calls</div>
              <div class="live-stat-val tnum">${todayEmail != null ? fmt(todayEmail) : '—'}</div>
            </div>
            <div title="Lead·calls ÷ total calls. Not a true conversion rate until Dialfire's per-period transitions endpoint is integrated.">
              <div class="live-stat-label">L/C %</div>
              <div class="live-stat-val tnum">${(todayCalls && todayLeads != null) ? ((todayLeads / todayCalls) * 100).toFixed(1) + '%' : '—'}</div>
            </div>
          </div>
        </div>`;
        // Bucket: 0=actively calling today, 1=on clock no calls,
        // 2=clocked out, 3=not in yet. Sort within bucket by calls desc
        // then name asc. The Map iteration order is staff-table order so
        // names tie-break alphabetically anyway when stable-sorted.
        const callsForSort = todayCalls || 0;
        let bucket;
        if (callsForSort > 0) bucket = 0;
        else if (isIn) bucket = 1;
        else if (outAt) bucket = 2;
        else bucket = 3;
        cards.push({ bucket, calls: callsForSort, name: rec.name || '', html });
      });
    }
    // Sort + render in the requested order. Active callers float to the top
    // (highest calls first), then on-the-clock with zero, then clocked-out,
    // then not-in-yet.
    cards.sort((a, b) => {
      if (a.bucket !== b.bucket) return a.bucket - b.bucket;
      if (a.calls !== b.calls) return b.calls - a.calls;
      return a.name.localeCompare(b.name);
    });

    // Live-stats freshness wins as the headline "last update" when we have
    // it — it's what makes the dashboard actually live.
    const liveTs = liveStatsFreshness();
    const refreshedAt = (liveTs || (schedule && schedule.asOf))
      ? (liveTs || schedule.asOf).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Johannesburg' })
      : '—';
    const liveBadge = liveTs
      ? '<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#DCF3E5;color:#0E6B3A;font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-left:6px">● Live</span>'
      : '<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#FFE9CB;color:#6B3F00;font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-left:6px">Snapshot</span>';
    const summary = `<div class="live-summary">
      <div class="live-summary-stat">
        <div class="live-summary-val tnum">${onlineCount}</div>
        <div class="live-summary-label">On the clock</div>
      </div>
      <div class="live-summary-stat">
        <div class="live-summary-val tnum">${totalRoster - onlineCount}</div>
        <div class="live-summary-label">Not in yet</div>
      </div>
      <div class="live-summary-stat">
        <div class="live-summary-val tnum">${fmt(totalCallsToday)}</div>
        <div class="live-summary-label">Calls today</div>
      </div>
      <div class="live-summary-stat">
        <div class="live-summary-val tnum">${fmt(totalLeadsToday)}</div>
        <div class="live-summary-label">Leads today</div>
      </div>
      <div class="live-refresh-meta">
        <span style="display:inline-block">Refreshed ${escapeHtml(refreshedAt)} SAST${liveBadge}</span>
      </div>
    </div>`;

    const grid = cards.length
      ? `<div class="live-grid">${cards.map(c => c.html).join('')}</div>`
      : `<div class="card card-pad" style="text-align:center;color:var(--muted);padding:60px 20px">
          ${schedule ? 'No clock-in events recorded yet for the active roster.' : 'Loading live floor data — clock events are streaming from quay-clock.'}
        </div>`;

    return `<div class="tab-view">${summary}${grid}</div>`;
  }

  function liveFloorWire() {
    // Re-render the Live Floor on any new clock event. We piggy-back on the
    // existing realtime channel — wireRealtimeChannel() is already invoked
    // elsewhere; here we just refresh schedule + live_stats and re-render.
    if (window.sb) {
      if (!schedule) loadScheduleData().then(() => { if (tab === 'live') render(); });
      // Always do an initial pull of live_stats so the tab isn't empty
      // while we wait for the next daemon push.
      loadLiveStats().then(() => { if (tab === 'live') render(); });
    }
  }

  // Build a deterministic avatar background for a name. Same Quay-blue palette
  // as the quay-clock admin so the look is consistent across the suite.
  const _AVATAR_PALETTE = ['#3D5BA6','#1E3A8A','#3F7BC4','#2F8FB3'];
  function avatarColor(name) {
    const s = (name || '').toLowerCase();
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return _AVATAR_PALETTE[h % _AVATAR_PALETTE.length];
  }

  // Computes the same flags the Overview card shows, for re-use elsewhere
  // (e.g. the Red Flags tab). Mirrors the prelude inside overview() but only
  // grabs the inputs redFlags() actually needs.
  function currentFlags() {
    if (!Q || !Q.agentsFor || !Q.DELTAS) return [];
    const agents = Q.agentsFor(period) || [];
    const d = Q.DELTAS[period] || {};
    const rm = agents.filter(a => a.team === 'RM');
    const fc = agents.filter(a => a.team === 'Fancy');
    const teamTotals = team => {
      if (!team.length) return null;       // empty team → skip the flag entirely
      const calls = team.reduce((s, a) => s + a.calls, 0);
      const leads = team.reduce((s, a) => s + a.leads, 0);
      const sr = calls ? +((leads / calls) * 100).toFixed(1) : 0;
      const target = team === rm
        ? (CFG.BENCHMARKS && CFG.BENCHMARKS.rm_success_rate) || 17
        : (CFG.BENCHMARKS && CFG.BENCHMARKS.fc_success_rate) || 20;
      return { calls, leads, sr, target, n: team.length };
    };
    return redFlags(agents, d, teamTotals(rm), teamTotals(fc));
  }

  // Returns ready-to-mount HTML for the Red Flags card. Pair with
  // wireFlagAckButtons() after injecting so the Mark-attended pills work.
  function flagsCardHtml(flags, opts) {
    const sub = (opts && opts.sub) || 'Auto-detected from this period · click Mark attended to clear them';
    const openFlags = flags.filter(f => !f.key || !flagAcks.has(f.key));
    const items = openFlags.length ? openFlags.map(f => {
      const key = f.key || '';
      return `<div class="insight" data-flag-key="${key}">
        <div class="insight-ic ${f.type}">${f.type === 'warn' ? I.alert : f.type === 'down' ? I.down : I.spark}</div>
        <div class="insight-body"><p>${f.html}</p>
          ${f.action ? `<div class="insight-action">${I.arrow}${f.action}</div>` : ''}
        </div>
        ${key ? `<button class="insight-ack" data-flag-key="${key}" title="Mark this flag as attended to">Mark attended</button>` : ''}
      </div>`;
    }).join('') : `<div style="padding:18px 24px;color:var(--muted);font-size:13px">
        No red flags this period — the floor is on track.
      </div>`;
    return `<div class="card">
      <div class="card-head"><div><h3>Red flags</h3><div class="sub">${sub}</div></div></div>
      <div class="insights">${items}</div>
      ${attendedFlagsSectionHtml(flags)}
    </div>`;
  }

  // Collapsible "Attended (N)" section listing every flag a manager has
  // acked. Each row shows what the flag was, who acked it, when, and a
  // small "Un-attend" button that deletes the row from flag_acks. Hidden
  // entirely when there are no acks.
  function attendedFlagsSectionHtml(currentList) {
    if (!flagAcks || flagAcks.size === 0) return '';
    // Build a lookup of currently-live flags so an ack against a still-open
    // key shows the canonical HTML. Acks against keys not in the live list
    // (e.g. last-week's flags, or flags that resolved themselves) fall back
    // to the snapshot stored on the ack record.
    const liveByKey = new Map();
    (currentList || []).forEach(f => { if (f.key) liveByKey.set(f.key, f); });
    // Stable order: most recently acked first.
    const acks = [...flagAcks.values()].sort((a, b) => {
      const ta = a.acked_at ? new Date(a.acked_at).getTime() : 0;
      const tb = b.acked_at ? new Date(b.acked_at).getTime() : 0;
      return tb - ta;
    });
    const fmtSast = (iso) => {
      if (!iso) return '—';
      try {
        return new Date(iso).toLocaleString('en-ZA', {
          timeZone: 'Africa/Johannesburg',
          day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
        });
      } catch { return iso; }
    };
    const rows = acks.map(a => {
      const live = liveByKey.get(a.flag_key);
      // Prefer the live flag text. Fall back to whatever snapshot we
      // saved into `note` when the flag was first acked. Final fallback
      // is a muted placeholder so the row still renders.
      const html = live ? live.html
        : (a.note ? a.note
        : '<span class="muted">[flag no longer current]</span>');
      const ackedBy = a.acked_by ? (_staffNamesById.get(a.acked_by) || a.acked_by) : '—';
      return `<div class="insight" data-attended-key="${escapeHtml(a.flag_key)}">
        <div class="insight-ic" style="background:#EEF0F6;color:var(--muted)">${I.check || '✓'}</div>
        <div class="insight-body">
          <p>${html}</p>
          <div class="insight-action" style="color:var(--muted)">
            attended by <b>${escapeHtml(ackedBy)}</b> · ${escapeHtml(fmtSast(a.acked_at))}
          </div>
        </div>
        <button class="insight-ack insight-unack" data-unack-key="${escapeHtml(a.flag_key)}"
                title="Bring this flag back into the open list">Un-attend</button>
      </div>`;
    }).join('');
    return `<details class="attended-flags">
      <summary>Attended (${flagAcks.size})</summary>
      <div class="insights">${rows}</div>
    </details>`;
  }

  function redFlags(agents, deltas, rmT, fcT, opts) {
    const flags = [];
    const includeSchedule = !opts || opts.includeSchedule !== false;
    // Leadership view passes includeInactive:false to suppress the
    // per-agent "X made only N calls" flags — those are manager-level
    // noise that crowded the strategic view.
    const includeInactive = !opts || opts.includeInactive !== false;
    const cfg = (CFG.RED_FLAGS) || {};
    const cd = cfg.calls_drop_pct      ?? -15;
    const sb = cfg.success_below_pct   ?? -3;
    const ic = cfg.inactive_call_floor ?? 100;
    // Week-bucket all "this period"-scoped flags so acks expire weekly
    // instead of inheriting from a prior period that shared the key.
    const wk = wkKeyFor(new Date());

    // 1) Big WoW drop in calls
    if (deltas && deltas.calls != null && deltas.calls <= cd) {
      flags.push({ type: 'down',
        key: `calls_drop:${period}:${wk}`,
        html: `<b>Call volume down ${Math.abs(deltas.calls)}%</b> vs previous period — investigate cause.`,
        action: 'Open Compare tab for week-vs-week breakdown' });
    }
    // 2) RM team below target by more than threshold — only when we actually
    // have data for the team (no fallback that fires on empty rosters).
    if (rmT && rmT.sr < rmT.target + sb) {
      flags.push({ type: 'warn',
        key: `sr_low:rm:${period}:${wk}`,
        html: `<b>RM success rate at ${rmT.sr}%</b> — ${(rmT.target - rmT.sr).toFixed(1)} pts below the ${rmT.target}% target.`,
        action: 'Review RM coaching cadence' });
    }
    if (fcT && fcT.sr < fcT.target + sb) {
      flags.push({ type: 'warn',
        key: `sr_low:fc:${period}:${wk}`,
        html: `<b>Fancy success rate at ${fcT.sr}%</b> — ${(fcT.target - fcT.sr).toFixed(1)} pts below the ${fcT.target}% target.`,
        action: 'Review Fancy desk lead quality' });
    }
    // 3) Inactive / very-low-call agents — manager territory, gated.
    if (includeInactive) {
      const inactive = agents.filter(a => a.calls < ic).sort((a, b) => a.calls - b.calls).slice(0, 3);
      inactive.forEach(a => {
        flags.push({ type: 'warn',
          key: `inactive:${slug(a.name)}:${wk}`,
          html: `<b>${escapeHtml(a.name)}</b> made only <b>${fmt(a.calls)}</b> calls — well below the ${ic}-call floor.`,
          action: 'Confirm clocked time + dialler issues' });
      });
    }
    // Append clock-based schedule flags (no-shows, chronic lateness, etc.)
    return includeSchedule ? flags.concat(scheduleFlags()) : flags;
  }

  function afterLeadership() {
    const trend = (Q.trendSeriesFor ? Q.trendSeriesFor(period) : null)
      || { labels: Q.WEEKS, calls: Q.WEEK_CALLS, success: Q.WEEK_SUCCESS };
    if (trend.labels && trend.labels.length) {
      C.weeklyTrend(document.getElementById('lTrendChart'),
        trend.labels, trend.calls, trend.success);
    }
    document.querySelectorAll('[data-goto]').forEach(b =>
      b.addEventListener('click', () => { tab = b.dataset.goto; shell(); }));
    wireAgentClicks();
    wireFlagAckButtons();
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

  // ---- Schedule analytics ----------------------------------------------
  // Pulls the last 7 days of events from Supabase using the logged-in
  // admin's session (events_select_authn RLS policy allows reads to any
  // authenticated user). Aggregates per-staff per-day first-in / last-out
  // and counts late starts, early finishes, and missed weekdays.
  async function loadScheduleData() {
    if (!session) return;
    try {
      const now = new Date();
      const monday = startOfThisWeek(now);
      const weekEnd = new Date(monday); weekEnd.setDate(weekEnd.getDate() + 6); weekEnd.setHours(23,59,59,999);
      // Admins + superusers are exempt from clock-in expectations — they
      // don't need to clock in, so we drop them from schedule adherence
      // entirely (no late/missed flags, not counted in % punctual).
      const [{ data: staff }, { data: events }] = await Promise.all([
        window.sb.from('staff')
          .select('id, name, active, is_admin')
          .eq('active', true)
          .eq('is_admin', false),
        window.sb.from('events').select('staff_id, ts, dir')
          .gte('ts', monday.toISOString()).lte('ts', weekEnd.toISOString())
          .order('ts', { ascending: true }),
      ]);
      const byStaff = new Map();
      (staff || []).forEach(s => byStaff.set(s.id, {
        id: s.id, name: s.name, days: {},
        late: 0, early: 0, missed: 0, avgStartMin: null, avgEndMin: null,
      }));
      (events || []).forEach(e => {
        const rec = byStaff.get(e.staff_id);
        if (!rec) return;
        const d = new Date(e.ts);
        // Bucket by SAST calendar date, NOT UTC. An event at SAST 00:30
        // (UTC 22:30 previous day) was previously bucketed against the
        // wrong date, making the early-morning shift "disappear".
        const key = sastDateStr(d);
        if (!rec.days[key]) rec.days[key] = { first: null, last: null };
        if (e.dir === 'in'  && !rec.days[key].first) rec.days[key].first = d;
        if (e.dir === 'out') rec.days[key].last = d;
      });
      // Compute aggregates per staff over Mon..min(today, Fri).
      const today = new Date(); today.setHours(0,0,0,0);
      const todaySast = sastDateStr(new Date());
      // Loop Mon..Fri up to but not past today.
      const days = [];
      for (let i = 0; i < 5; i++) {
        const d = new Date(monday); d.setDate(d.getDate() + i);
        if (d <= today) days.push(d);
      }
      const lateThreshold = SCHEDULE.start_hr * 60 + SCHEDULE.start_min + SCHEDULE.late_grace_min;
      const earlyThreshold = SCHEDULE.end_hr * 60 + SCHEDULE.end_min - SCHEDULE.early_grace_min;
      byStaff.forEach((rec) => {
        let startSum = 0, startCount = 0, endSum = 0, endCount = 0;
        days.forEach(d => {
          // Key by SAST so it lines up with the bucket above.
          const key = sastDateStr(d);
          const entry = rec.days[key];
          if (!entry || !entry.first) {
            // Don't count today as 'missed' until past 09:00 SAST.
            const isToday = key === todaySast;
            if (!isToday || sastHourAndWeekday().hour >= 9) rec.missed++;
            return;
          }
          // Compare in SAST wall-clock minutes (not browser-local).
          const inS = sastHourAndWeekday(entry.first);
          const startMin = inS.hour * 60
            + parseInt(_SAST_HM_FMT.formatToParts(entry.first).find(p => p.type === 'minute').value, 10);
          startSum += startMin; startCount++;
          if (startMin > lateThreshold) rec.late++;
          if (entry.last) {
            const outS = sastHourAndWeekday(entry.last);
            const endMin = outS.hour * 60
              + parseInt(_SAST_HM_FMT.formatToParts(entry.last).find(p => p.type === 'minute').value, 10);
            endSum += endMin; endCount++;
            if (endMin < earlyThreshold) rec.early++;
          }
        });
        rec.avgStartMin = startCount ? Math.round(startSum / startCount) : null;
        rec.avgEndMin   = endCount   ? Math.round(endSum / endCount)     : null;
        rec.daysWorked  = startCount;
      });
      schedule = {
        byStaff,
        weekStart: monday,
        weekEnd,
        asOf: new Date(),
        evaluatedDays: days.length,
      };
    } catch (e) {
      console.warn('[schedule] load failed', e);
      schedule = null;
    }
  }
  function startOfThisWeek(d) {
    const x = new Date(d); const dow = (x.getDay() + 6) % 7;
    x.setHours(0,0,0,0); x.setDate(x.getDate() - dow); return x;
  }
  function fmtHHMM(min) {
    if (min == null) return '—';
    const h = Math.floor(min / 60), m = min % 60;
    return ('0'+h).slice(-2) + ':' + ('0'+m).slice(-2);
  }

  // ---- Schedule adherence card (rendered inside Operational Overview) ---
  // Headline-only summary: today's clocked-in count + week punctuality %.
  // The per-caller breakdown lives in the Clocks tab now.
  function scheduleAdherenceCard() {
    if (!schedule) {
      return `<div class="card card-pad">
        <h3 style="margin:0 0 6px">Schedule adherence</h3>
        <div class="muted" style="font-size:13px">Loading clock data…</div>
      </div>`;
    }
    const rows = [...schedule.byStaff.values()];
    const totalStaff = rows.length;
    // SAST today; bucket keys in loadScheduleData() are SAST yyyy-mm-dd.
    const todayKey = sastDateStr(new Date());
    const clockedInToday = rows.filter(r => r.days[todayKey] && r.days[todayKey].first).length;
    const onTimeDays = rows.reduce((s, r) => s + (r.daysWorked - r.late), 0);
    const totalDays  = rows.reduce((s, r) => s + r.daysWorked + r.missed, 0);
    const punctuality = totalDays ? Math.round((onTimeDays / totalDays) * 100) : 0;
    const punctTone = punctuality >= 90 ? 'ok' : punctuality >= 75 ? 'warn' : 'bad';
    const inTone    = totalStaff && clockedInToday / totalStaff >= 0.9 ? 'ok'
                    : totalStaff && clockedInToday / totalStaff >= 0.6 ? 'warn' : 'bad';

    return `<div class="card card-pad">
      <div class="card-head" style="border:0;padding:0;margin-bottom:10px">
        <div><h3>Schedule adherence</h3><div class="sub">Standard day · 08:00 – 17:00 Mon–Fri · admins exempt · full breakdown in Clocks tab</div></div>
      </div>
      <div class="row g-2-1" style="gap:14px">
        <div class="kpi" style="padding:14px 16px">
          <div class="kpi-label">Clocked in today</div>
          <div class="kpi-val tnum"><span class="pill ${inTone}" style="font-size:18px;font-weight:800;padding:6px 12px">${clockedInToday}/${totalStaff}</span></div>
          <div class="kpi-foot">staff on the clock right now</div>
        </div>
        <div class="kpi" style="padding:14px 16px">
          <div class="kpi-label">Punctual this week</div>
          <div class="kpi-val tnum"><span class="pill ${punctTone}" style="font-size:18px;font-weight:800;padding:6px 12px">${punctuality}%</span></div>
          <div class="kpi-foot">on-time days / scheduled days · ${schedule.evaluatedDays} weekday${schedule.evaluatedDays===1?'':'s'} so far</div>
        </div>
      </div>
    </div>`;
  }

  // ---- Schedule-based red flags (appended to the existing redFlags() list)
  function scheduleFlags() {
    if (!schedule) return [];
    const out = [];
    // SAST anchors — todayKey must match the SAST-keyed bucket in
    // loadScheduleData; dow/hour must read SAST so a super opening from
    // London at 06:00 (SAST 08:00) doesn't see Friday as Thursday.
    const todayKey = sastDateStr(new Date());
    const wkKey = schedule.weekStart ? sastDateStr(schedule.weekStart) : todayKey;
    const { hour: sastHour, weekday: dow } = sastHourAndWeekday();
    const isWeekday = dow >= 1 && dow <= 5;
    // 1) Anyone not clocked in yet but it's past 09:00 SAST on a weekday.
    if (isWeekday && sastHour >= 9) {
      schedule.byStaff.forEach(r => {
        const day = r.days[todayKey];
        if (!day || !day.first) {
          out.push({ type: 'warn',
            key: `no_clockin:${slug(r.name)}:${todayKey}`,
            html: `<b>${escapeHtml(r.name)}</b> hasn't clocked in yet today.`,
            action: 'Check with them or log a shift-change request' });
        }
      });
    }
    // 2) Anyone late 3+ times this week.
    schedule.byStaff.forEach(r => {
      if (r.late >= 3) out.push({ type: 'warn',
        key: `chronic_late:${slug(r.name)}:${wkKey}`,
        html: `<b>${escapeHtml(r.name)}</b> clocked in late <b>${r.late}×</b> this week (avg start ${fmtHHMM(r.avgStartMin)}).`,
        action: 'Worth a one-on-one' });
    });
    // 3) Anyone with no-shows on weekdays (excluding today before 09:00).
    schedule.byStaff.forEach(r => {
      if (r.missed >= 2) out.push({ type: 'down',
        key: `multi_missed:${slug(r.name)}:${wkKey}`,
        html: `<b>${escapeHtml(r.name)}</b> missed <b>${r.missed}</b> weekday${r.missed > 1 ? 's' : ''} this week — no clock-in event.`,
        action: 'Submit a shift-change request if it was a one-off' });
    });
    return out;
  }

  // Boot: try to restore an existing Supabase session, then render.
  (async function bootAuth() {
    try {
      const { data: { user } } = await window.sb.auth.getUser();
      if (user) {
        const { data: staff } = await window.sb.from('staff')
          .select('id, name, role, team, is_admin, is_super, active')
          .eq('auth_user_id', user.id).maybeSingle();
        if (staff && staff.is_admin && staff.active !== false) {
          setSession({
            id: staff.id, name: staff.name, role: staff.role || '', team: staff.team || '',
            admin: true, super: !!staff.is_super,
          });
          if (staff.is_super) tab = 'leadership';
          loadScheduleData().then(() => {
            updateLiveFlagsBadge();
            if (tab === 'overview' || tab === 'leadership') shell();
          });
          loadFlagAcks();
          subscribeRealtime();
        } else {
          await window.sb.auth.signOut(); setSession(null);
        }
      }
    } catch { /* fall through to login */ }
    shell();
  })();

  // ─── Red-flag acks (flag-checklist persistence) ──────────────────────
  // Maps flag_key → { acked_at, acked_by, name } for any flag a manager
  // has marked as 'attended to'. Backed by the Supabase `flag_acks` table,
  // so a tick on one device shows up on every other.
  const flagAcks = new Map();
  async function loadFlagAcks() {
    if (!window.sb) return;
    try {
      // Pull acks + the staff name behind each ack so we can render who attended.
      // `note` carries a snapshot of the flag's HTML at ack time, so the
      // Attended log can still show context for flags that have since
      // resolved themselves.
      const { data, error } = await window.sb
        .from('flag_acks')
        .select('flag_key, acked_at, acked_by, note');
      if (error) throw error;
      flagAcks.clear();
      (data || []).forEach(r => flagAcks.set(r.flag_key, r));
      // Make sure the staff-name lookup is populated so the Attended log
      // can resolve acked_by (a staff.id) into a readable name.
      if (_staffNamesById.size === 0 && window.sb) {
        try {
          const { data: staff } = await window.sb.from('staff').select('id, name');
          (staff || []).forEach(s => _staffNamesById.set(s.id, s.name));
        } catch {}
      }
      updateLiveFlagsBadge();
    } catch (e) {
      console.warn('[flag_acks] load failed', e);
    }
  }
  async function ackFlag(key, snapshot) {
    if (!window.sb || !session) return;
    // Snapshot the flag's html so the Attended log can show context even
    // after the underlying flag has gone away (e.g. a chronic-late flag
    // that expired the following week). Falls back to looking the flag
    // up in currentFlags() if the caller didn't pre-supply one.
    let note = snapshot || null;
    if (!note) {
      try {
        const live = (currentFlags() || []).find(f => f.key === key);
        if (live) note = live.html;
      } catch {}
    }
    flagAcks.set(key, {
      flag_key: key, acked_at: new Date().toISOString(),
      acked_by: session.id, note,
    });
    rerenderFlagsInPlace();
    updateLiveFlagsBadge();
    try {
      await window.sb.from('flag_acks').upsert({
        flag_key: key, acked_by: session.id, note,
      });
    } catch (e) {
      console.warn('[flag_acks] ack failed', e);
      flagAcks.delete(key);
      rerenderFlagsInPlace();
    }
  }
  async function unackFlag(key) {
    if (!window.sb) return;
    const prev = flagAcks.get(key);
    flagAcks.delete(key);
    rerenderFlagsInPlace();
    updateLiveFlagsBadge();
    try {
      await window.sb.from('flag_acks').delete().eq('flag_key', key);
    } catch (e) {
      console.warn('[flag_acks] unack failed', e);
      if (prev) flagAcks.set(key, prev);
      rerenderFlagsInPlace();
    }
  }
  // Drop any flag rows that have been acked out of the DOM. If a card ends
  // up empty as a result we trigger a full shell() so the empty-state
  // message renders, and so the card heights re-flow cleanly.
  //
  // Trigger a full shell() any time an ack actually changes the DOM so the
  // Attended (N) collapsible at the bottom of the card reflects the new
  // ack count; an in-place removal alone would leave that stale.
  function rerenderFlagsInPlace() {
    if (tab !== 'overview' && tab !== 'leadership' && tab !== 'manager') return;
    let removed = 0;
    document.querySelectorAll('.insight[data-flag-key]').forEach(el => {
      const key = el.dataset.flagKey;
      if (!key || !flagAcks.has(key)) return;
      el.remove();
      removed++;
    });
    if (removed) {
      updateLiveFlagsBadge();
      shell();
    }
  }
  function wireFlagAckButtons(root) {
    (root || document).querySelectorAll('.insight-ack').forEach(b => {
      if (b.__wired) return; b.__wired = true;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        // Un-attend button (sits inside the Attended section) carries
        // data-unack-key; the regular Mark-attended button uses data-flag-key.
        const unackKey = b.dataset.unackKey;
        if (unackKey) {
          unackFlag(unackKey);
          // Full re-render so the flag reappears in the open list above.
          if (tab === 'overview' || tab === 'leadership' || tab === 'manager') shell();
          return;
        }
        const key = b.dataset.flagKey;
        if (!key) return;
        flagAcks.has(key) ? unackFlag(key) : ackFlag(key);
      });
    });
  }

  // ─── Daily Reports (LN/Assistant end-of-day form on quay-clock) ─────
  // Pulls clock_out_reports + decorates each row with the submitter's
  // staff name. Loaded on first open of the Daily Stats tab and refreshed
  // by the realtime subscription below.
  let _reports = null;                    // array of report rows
  let _staffNamesById = new Map();
  let _reportsLoading = false;
  async function loadReports() {
    if (!window.sb) return;
    _reportsLoading = true;
    try {
      const { data: rows, error } = await window.sb
        .from('clock_out_reports')
        .select('*')
        .order('clocked_out_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      _reports = rows || [];
      // Best-effort lookup of staff names (single query, RLS allows reads).
      if (_staffNamesById.size === 0) {
        const { data: staff } = await window.sb.from('staff').select('id, name');
        (staff || []).forEach(s => _staffNamesById.set(s.id, s.name));
      }
    } catch (e) {
      console.warn('[reports] load failed', e);
      _reports = [];
    } finally {
      _reportsLoading = false;
    }
  }

  // ─── Team Directory (native — no longer requires Clocks iframe) ────
  // Pulls public.staff + each staff member's latest event so we can
  // render live status. Add/Edit modal posts to admin-create-staff
  // (Edge Function) for new rows, or PATCHes public.staff for edits.
  let _team = null;             // [{id,name,...,status,lastIn,lastOut}]
  let _teamLoading = false;
  let _teamFilter = '';
  let _teamModal = null;        // form state when modal is open

  async function loadTeam() {
    if (!window.sb) return;
    _teamLoading = true;
    try {
      const { data: staff, error } = await window.sb
        .from('staff')
        .select('*')
        .eq('active', true)
        .order('name', { ascending: true });
      if (error) throw error;
      // One small query per staff to grab their last two events — same
      // pattern the clock admin uses. Cheap for an office-sized roster.
      const decorated = await Promise.all((staff || []).map(async (s) => {
        const { data: ev } = await window.sb
          .from('events').select('ts, dir')
          .eq('staff_id', s.id)
          .order('ts', { ascending: false })
          .limit(2);
        let status = 'out', lastIn = '', lastOut = '';
        (ev || []).forEach(e => {
          if (e.dir === 'in'  && !lastIn)  lastIn  = e.ts;
          if (e.dir === 'out' && !lastOut) lastOut = e.ts;
        });
        if (lastIn && (!lastOut || lastIn > lastOut)) status = 'in';
        return { ...s, status, lastIn, lastOut };
      }));
      decorated.sort((a, b) => {
        if (a.status !== b.status) return a.status === 'in' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      _team = decorated;
    } catch (e) {
      console.warn('[team] load failed', e);
      _team = [];
    } finally {
      _teamLoading = false;
    }
  }

  function renderTeamView() {
    if (_team == null && !_teamLoading) {
      loadTeam().then(() => { if (tab === 'team') shell(); });
    }
    const q = _teamFilter.trim().toLowerCase();
    const rows = (_team || []).filter(s =>
      !q || s.name.toLowerCase().includes(q)
         || (s.designation || '').toLowerCase().includes(q)
    );
    const desigLabel = (d) => ({
      super_admin: 'Super Admin',
      manager:     'Manager',
      rm:          'RM',
      fancy:       'Fancy',
      ln:          'LN',
      assistant:   'Assistant',
    }[d] || (d || '—'));
    const onCount = (_team || []).filter(s => s.status === 'in').length;
    const totalCount = (_team || []).length;

    const rel = (iso) => {
      if (!iso) return '—';
      const t = new Date(iso).getTime();
      const m = Math.max(0, Math.round((Date.now() - t) / 60000));
      if (m < 60) return m + 'm ago';
      const h = Math.round(m / 60);
      return h < 24 ? h + 'h ago' : Math.round(h / 24) + 'd ago';
    };

    return `<div class="tab-view">
      <div class="card card-pad">
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          <input id="teamSearch" type="search" placeholder="Search name or designation..."
                 value="${escapeHtml(_teamFilter)}"
                 style="flex:1;min-width:200px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font-family:Montserrat">
          <div class="muted" style="font-size:13px"><b style="color:var(--green)">${onCount}</b> on the clock · <b>${totalCount}</b> active staff</div>
          <button class="btn btn-primary" id="teamAddBtn">${I.plus || '+'} Add staff</button>
        </div>
      </div>
      <div class="card mt">
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th>Name</th>
            <th>Status</th>
            <th>Designation</th>
            <th>Last clocked</th>
            <th class="r"></th>
          </tr></thead>
          <tbody>
            ${_team == null ? '<tr><td colspan="5" class="muted" style="text-align:center;padding:30px">Loading…</td></tr>' :
              rows.length === 0 ? '<tr><td colspan="5" class="muted" style="text-align:center;padding:30px">No staff match.</td></tr>' :
              rows.map(s => `<tr>
                <td><div class="agent-cell"><div class="avatar">${escapeHtml(initialsOf(s.name))}</div>
                  <div class="agent-name">${escapeHtml(s.name)}</div></div></td>
                <td><span class="pill ${s.status === 'in' ? 'ok' : ''}" style="font-size:11px;padding:3px 9px">${s.status === 'in' ? '● On the clock' : 'Clocked out'}</span></td>
                <td>${escapeHtml(desigLabel(s.designation))}</td>
                <td class="muted tnum" style="font-size:12.5px">${s.status === 'in' ? 'in ' + rel(s.lastIn) : (s.lastOut ? 'out ' + rel(s.lastOut) : '—')}</td>
                <td class="r"><button class="btn small" data-edit-staff-id="${escapeHtml(s.id)}">Edit</button></td>
              </tr>`).join('')}
          </tbody>
        </table></div>
      </div>
      ${_teamModal ? renderTeamModal() : ''}
    </div>`;
  }

  function initialsOf(name) {
    return String(name || '?').split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
  }

  function renderTeamModal() {
    const f = _teamModal;
    const isEdit = f.mode === 'edit';
    const designations = [
      ['super_admin', 'Super Admin'],
      ['manager',     'Manager'],
      ['rm',          'RM (Relationship Manager)'],
      ['fancy',       'Fancy Caller'],
      ['ln',          'LN (Lead Nurturer)'],
      ['assistant',   'Assistant'],
    ];
    return `<div class="modal-back" id="teamModalBack"></div>
      <div class="modal" role="dialog" style="width:min(560px, calc(100vw - 32px))">
        <div class="modal-head">
          <h3 style="margin:0">${isEdit ? 'Edit ' + escapeHtml(f.name) : 'Add a staff member'}</h3>
          <button class="modal-close" id="teamModalClose">×</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:12px">
          <label class="field"><span>Name</span>
            <input id="tmName" type="text" value="${escapeHtml(f.name)}" placeholder="e.g. Thandi Mokoena" ${isEdit ? '' : 'autofocus'}>
          </label>
          ${isEdit ? `
            <label class="field"><span>Username (login id)</span>
              <input type="text" value="${escapeHtml(f.id)}" disabled>
            </label>
            <label class="field"><span>PIN (6 digits — leave blank to keep current)</span>
              <input id="tmPin" type="text" inputmode="numeric" maxlength="6" value="${escapeHtml(f.pin)}" placeholder="••••••">
            </label>` : `
            <label class="field"><span>Username</span>
              <input id="tmId" type="text" value="${escapeHtml(f.id)}" placeholder="auto from name" autocapitalize="off">
              <div class="muted" style="font-size:11px;margin-top:3px">Lower-case, no spaces. Auto-generated from name; edit to override.</div>
            </label>
            <label class="field"><span>PIN (6 digits, they'll use this to log in)</span>
              <input id="tmPin" type="text" inputmode="numeric" maxlength="6" value="${escapeHtml(f.pin)}" placeholder="6 digits">
            </label>
          `}
          <label class="field"><span>Designation</span>
            <select id="tmDesignation">
              ${designations.map(([v, l]) => `<option value="${v}" ${f.designation === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <label class="field"><span>Hourly rate (R)</span>
              <input id="tmRate" type="number" step="0.01" min="0" value="${escapeHtml(f.hourly_rate)}" placeholder="e.g. 75.00">
            </label>
            <label class="field"><span>Weekly hours</span>
              <input id="tmHours" type="number" step="0.5" min="0" max="80" value="${escapeHtml(f.weekly_hours)}" placeholder="e.g. 40">
            </label>
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:13.5px">
            <input id="tmAdmin" type="checkbox" ${f.admin ? 'checked' : ''}>
            <span>Admin — can open the manager dashboard</span>
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:13.5px">
            <input id="tmSuper" type="checkbox" ${f.super ? 'checked' : ''}>
            <span>Superuser — can also see Leadership</span>
          </label>
          ${f.error ? `<div class="banner" style="display:block">${escapeHtml(f.error)}</div>` : ''}
        </div>
        <div class="modal-foot">
          <button class="btn" id="teamModalCancel">Cancel</button>
          <button class="btn btn-primary" id="teamModalSave" ${f.busy ? 'disabled' : ''}>${f.busy ? 'Saving…' : (isEdit ? 'Save changes' : 'Add staff')}</button>
        </div>
      </div>`;
  }

  function wireTeamView() {
    const search = document.getElementById('teamSearch');
    if (search) search.addEventListener('input', (e) => {
      _teamFilter = e.target.value;
      // Re-render rows only, keep search-input focus.
      const tbody = document.querySelector('#content .tbl tbody');
      if (tbody) shell(); else shell();
    });
    const addBtn = document.getElementById('teamAddBtn');
    if (addBtn) addBtn.addEventListener('click', () => {
      _teamModal = {
        mode: 'add', name: '', id: '', pin: '',
        designation: 'fancy',
        hourly_rate: '', weekly_hours: '',
        admin: false, super: false,
        busy: false, error: '',
      };
      shell();
    });
    document.querySelectorAll('button[data-edit-staff-id]').forEach(b => {
      b.addEventListener('click', () => {
        const s = (_team || []).find(x => x.id === b.dataset.editStaffId);
        if (!s) return;
        _teamModal = {
          mode: 'edit',
          id: s.id, name: s.name, pin: '',
          designation: s.designation || 'fancy',
          hourly_rate:  s.hourly_rate  != null ? String(s.hourly_rate)  : '',
          weekly_hours: s.weekly_hours != null ? String(s.weekly_hours) : '',
          admin: !!s.is_admin, super: !!s.is_super,
          busy: false, error: '',
        };
        shell();
      });
    });
    if (_teamModal) wireTeamModal();
  }

  function wireTeamModal() {
    const f = _teamModal;
    const close = () => { _teamModal = null; shell(); };
    document.getElementById('teamModalBack').addEventListener('click', close);
    document.getElementById('teamModalClose').addEventListener('click', close);
    document.getElementById('teamModalCancel').addEventListener('click', close);
    const name = document.getElementById('tmName');
    const idIn = document.getElementById('tmId');
    const pin  = document.getElementById('tmPin');
    let idTouched = !!f.id;
    if (name) name.addEventListener('input', () => {
      f.name = name.value;
      if (f.mode === 'add' && !idTouched && idIn) {
        const slug = name.value.toLowerCase().trim()
          .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
        idIn.value = slug; f.id = slug;
      }
    });
    if (idIn) idIn.addEventListener('input', () => { idTouched = true; f.id = idIn.value; });
    if (pin)  pin.addEventListener('input', () => {
      f.pin = pin.value.replace(/\D/g, '').slice(0, 6); pin.value = f.pin;
    });
    document.getElementById('tmDesignation').addEventListener('change', (e) => {
      f.designation = e.target.value;
      // Sync Admin + Super checkboxes to match the chosen role so users
      // don't have to remember to also untick a stale 'Super' from when
      // the person used to be super_admin.
      //   super_admin → Admin + Super
      //   manager     → Admin only
      //   anything else → neither
      const isSuper = f.designation === 'super_admin';
      const isAdmin = isSuper || f.designation === 'manager';
      f.super = isSuper;
      f.admin = isAdmin;
      const adm = document.getElementById('tmAdmin');
      const sup = document.getElementById('tmSuper');
      if (adm) adm.checked = isAdmin;
      if (sup) sup.checked = isSuper;
    });
    document.getElementById('tmRate').addEventListener('input',  (e) => { f.hourly_rate  = e.target.value; });
    document.getElementById('tmHours').addEventListener('input', (e) => { f.weekly_hours = e.target.value; });
    document.getElementById('tmAdmin').addEventListener('change',(e) => { f.admin = e.target.checked; });
    document.getElementById('tmSuper').addEventListener('change',(e) => { f.super = e.target.checked; });
    document.getElementById('teamModalSave').addEventListener('click', saveTeamModal);
  }

  async function saveTeamModal() {
    const f = _teamModal;
    if (!f) return;
    f.error = '';
    if (!f.name.trim()) { f.error = 'Name is required'; shell(); return; }
    if (f.mode === 'add' && (!f.pin || f.pin.length !== 6)) {
      f.error = 'PIN must be 6 digits';
      shell(); return;
    }
    f.busy = true; shell();
    try {
      if (f.mode === 'add') {
        // Call the same admin-create-staff Edge Function the clock admin uses.
        const { data: { session: s } } = await window.sb.auth.getSession();
        if (!s) throw new Error('Not signed in');
        const res = await fetch(`${CFG.SUPABASE_URL}/functions/v1/admin-create-staff`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${s.access_token}`,
            'apikey': CFG.SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            id: f.id.trim() || f.name, name: f.name.trim(), pin: f.pin,
            admin: !!f.admin, is_super: !!f.super,
            hourly_rate:  f.hourly_rate  === '' ? null : Number(f.hourly_rate),
            weekly_hours: f.weekly_hours === '' ? null : Number(f.weekly_hours),
            designation: f.designation || null,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.ok === false) throw new Error(body.error || 'Could not create staff');
      } else {
        // Direct PATCH for non-PIN fields — RLS allows it for admins.
        const patch = {
          name: f.name.trim(),
          is_admin: !!f.admin, is_super: !!f.super,
          designation: f.designation || null,
          hourly_rate:  f.hourly_rate  === '' ? null : Number(f.hourly_rate),
          weekly_hours: f.weekly_hours === '' ? null : Number(f.weekly_hours),
        };
        const { error } = await window.sb.from('staff').update(patch).eq('id', f.id);
        if (error) throw new Error(error.message);

        // If the admin entered a new PIN, route it through admin-set-pin
        // (Edge Function) which uses the service role to reset the auth password.
        if (f.pin && f.pin.length === 6) {
          const { data: { session: s } } = await window.sb.auth.getSession();
          if (!s) throw new Error('Not signed in');
          const res = await fetch(`${CFG.SUPABASE_URL}/functions/v1/admin-set-pin`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${s.access_token}`,
              'apikey': CFG.SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({ id: f.id, pin: f.pin }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok || body.ok === false) {
            throw new Error(body.error || 'PIN updated locally but admin-set-pin Edge Function failed (deploy it to enable PIN resets)');
          }
        }
      }
      _teamModal = null;
      _team = null; // force a re-load to pick up the new/edited row + fresh status
      shell();
    } catch (e) {
      f.busy = false;
      f.error = String(e.message || e);
      shell();
    }
  }

  // ─── Live red-flags badge ────────────────────────────────────────────
  // Top-right pill mirroring the full Red Flags card — counts every open
  // flag (schedule + business) so the badge and the on-screen list agree.
  function updateLiveFlagsBadge() {
    const el = document.getElementById('liveFlagsBadge');
    if (!el) return;
    let flags = [];
    try { flags = currentFlags(); } catch { flags = []; }
    // Don't count flags that have already been attended to.
    const n = flags.filter(f => !f.key || !flagAcks.has(f.key)).length;
    const countEl = document.getElementById('lfbCount');
    const sEl = document.getElementById('lfbS');
    if (countEl) countEl.textContent = String(n);
    if (sEl) sEl.textContent = n === 1 ? '' : 's';
    el.classList.toggle('active', n > 0);
    el.classList.toggle('clear',  n === 0);
  }

  // ─── Realtime: refresh schedule data whenever an event lands in
  // Supabase. Same pattern as the admin app — debounced, fallback poll.
  let _rtChannel = null;
  let _rtReloadTimer = null;
  let _rtPending = false;       // tab was hidden when a reload tried to fire
  function dashIsBusy() {
    // Don't blow away an open drill-down modal or the gate.
    return !!document.querySelector('.modal-back, .modal');
  }
  function rtScheduleReload() {
    clearTimeout(_rtReloadTimer);
    _rtReloadTimer = setTimeout(() => {
      if (document.visibilityState !== 'visible') { _rtPending = true; return; }
      loadScheduleData().then(() => {
        updateLiveFlagsBadge();
        if (!dashIsBusy() && (tab === 'overview' || tab === 'leadership' || tab === 'live')) shell();
      });
    }, 2000);
  }
  // When the tab becomes visible again, drain any queued realtime reload.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && _rtPending) {
      _rtPending = false;
      rtScheduleReload();
    }
  });
  function subscribeRealtime() {
    if (_rtChannel || !window.sb) return;
    try {
      _rtChannel = window.sb
        .channel('dash-feed')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, rtScheduleReload)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'clock_out_reports' }, () => {
          loadReports().then(() => {
            // Daily Stats embeds the EOD report list for the picked date.
            if (tab === 'daily' && !dashIsBusy()) populateDailyReports();
          });
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'staff' }, () => {
          // Invalidate so next Team tab visit pulls fresh roster.
          _team = null;
          if (tab === 'team' && !dashIsBusy()) shell();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'flag_acks' }, () => {
          // Full re-render — an un-ack from another device or admin needs
          // the hidden flag to reappear, which a DOM-only update can't do.
          loadFlagAcks().then(() => {
            updateLiveFlagsBadge();
            if (dashIsBusy()) return;
            if (tab === 'overview' || tab === 'leadership' || tab === 'manager') shell();
          });
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'live_stats' }, () => {
          // Mac daemon just upserted fresh Dialfire numbers. Reload + repaint
          // the Live Floor if it's the active tab. Other tabs read from the
          // weekly snapshot so they don't need this realtime nudge.
          if (typeof loadLiveStats === 'function') {
            loadLiveStats().then(() => {
              if (!dashIsBusy() && tab === 'live') shell();
            });
          }
        })
        .subscribe();
    } catch (e) { console.warn('[rt] subscribe failed', e); }
  }
  // Fallback slow poll in case the websocket drops silently. Skips the
  // full re-render if a modal is open or the user is mid-interaction —
  // updateLiveFlagsBadge() still runs so the topbar count stays accurate.
  setInterval(() => {
    if (!session || document.visibilityState !== 'visible') return;
    loadScheduleData().then(() => {
      updateLiveFlagsBadge();
      if (dashIsBusy()) return;
      if (tab === 'overview' || tab === 'leadership') shell();
    });
  }, 5 * 60 * 1000);
})();

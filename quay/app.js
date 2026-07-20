/* Quay 1 — app shell, Overview, navigation + period state */

(function () {
  // Page-load timestamp — fallback for the live-sync label when data.js
  // doesn't expose a snapshot time.
  if (!window.QUAY_LOADED_AT) window.QUAY_LOADED_AT = Date.now();
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

  let period = 'current-week'; // default: the live, in-progress "This Week" chip
  let tab = 'overview'; // default landing; switched to 'leadership' for superusers below
  let dailyPicked = null; // selected date on the Daily Stats tab (yyyy-mm-dd)
  let staffTeamFilter = 'all'; // 'all' | 'RM' | 'Fancy' — All Staff tab team dropdown
  // Overview + All Staff are migrated onto the global header range (gDateFrom/
  // gDateTo below) — they no longer keep their own From/To state.
  let leadDateFrom = null;     // Leadership custom range (custom-only tab, no quick pills)
  let leadDateTo   = null;
  let liveDateFrom = null;     // Live Floor: a range switches from live cards to a historical table
  let liveDateTo   = null;
  let cmpAgDateFrom = null;    // Compare · Agent-vs-Agent custom range (overrides topbar period when both set)
  let cmpAgDateTo   = null;
  // Global header date range — the single From/To that the shared header date
  // bar drives. Consumed by every tab that has been migrated onto it (see
  // GLOBAL_RANGE_TABS). Overrides the period whenever both ends are set.
  let gDateFrom = null;
  let gDateTo   = null;
  // Tabs migrated onto the global header control (chips + From/To range). For
  // these the header owns the range and the tab no longer draws its own bar.
  // Non-migrated data tabs still show the header chips (which set `period`) and
  // keep their own in-page range picker until migrated.
  const GLOBAL_RANGE_TABS = new Set(['overview', 'staff']);
  // Quick chips shown in the header on every tab except Payroll. Keys are
  // Q.PERIODS keys; labels match the picker the user signed off on.
  const GLOBAL_QUICK = [
    // "This Week" = live in-progress week (key `current-week`, aggregated from
    // daily data so it's correct even during the start-of-week weekly-fetcher
    // lag). "Last Week" = last completed calendar week (key `last-week`,
    // date-anchored in data.js). weeks[0] is the current week, so `last-week`
    // (weeks[1]) is the correct last-completed-week bucket.
    ['current-week', 'This Week'], ['last-week', 'Last Week'], ['this-month', 'This Month'],
    ['last-90', 'Last 90 Days'], ['all-time', 'All Time'],
  ];
  // The label a user actually sees for a period key. Prefers the quick-chip
  // wording (what they clicked) over the frozen, misleadingly-named
  // Q.PERIODS.label, so the header chip, subtitle, and drill-down modal all
  // agree on what to call the active window.
  function periodLabelFor(key) {
    const q = GLOBAL_QUICK.find(([k]) => k === key);
    return (q && q[1]) || (Q.PERIODS[key] || {}).label || key;
  }
  // Live Floor role filter, rendered into the header bar (Live Floor is
  // today/historical, not period-based, so it gets these instead of the chips).
  const DESIG_OPTS = [['all', 'All'], ['rm', 'RM'], ['ln', 'LN'], ['fancy', 'Fancy']];
  let liveDesig = 'all';       // Live Floor role filter: all | rm | ln | fancy
  let chWindow = 'last-week';  // ClientHub Teams tab window: last-week | this-month | last-month
  // Active segment on the All Staff tab: 'overall' | 'per' | 'ln'. Persisted
  // across re-renders (e.g. period change) so users don't get bounced back
  // to Callers · Overall every time the page rebuilds.
  let staffSegView = 'overall';
  // Cache for the LN & Assistants sub-tab so flipping between segs
  // doesn't re-hit Supabase. Keyed by cacheKey (period OR the custom
  // From/To range) so either a period change or a range change forces
  // a refetch on next click. Custom range wins over period when set,
  // matching the Callers Overall / Per Agent sub-views.
  let lnReportsState = { cacheKey: null, loading: false, error: null, data: null };
  // Name of the agent currently shown in the drill-down modal (or null if
  // closed). Top-bar period clicks check this to re-render the modal with
  // the new period's data instead of leaving the user on the underlying tab.
  let currentAgentModalName = null;

  // ---- standard schedule (8am–5pm Mon–Fri) ----
  // Soft target: we surface variance, we don't enforce it.
  const SCHEDULE = {
    start_hr: 8,   start_min: 0,
    end_hr: 17,    end_min: 0,
    late_grace_min: 9,     // clocked in before 08:10 counts as on-time
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
    { id: 'ln',         section: 'People',      label: 'LN Stats',       icon: I.target,   title: 'LN Leaderboard',       sub: 'Per-LN efficiency, leads per 100 touches, compliance · from end-of-day reports' },
    { id: 'monthly',    section: 'Time',        label: 'Monthly',        icon: I.cal2,     title: 'Monthly Breakdown',    sub: 'Month-by-month roll-up across every week of data' },
    { id: 'compare',    section: 'Time',        label: 'Compare',        icon: I.scale,    title: 'Period Comparison',    sub: 'Week vs week · month vs month' },
    { id: 'sources',    section: 'Strategy',    label: 'Lead Sources',   icon: I.target,   title: 'Lead Source Efficacy', sub: 'Which source converts best' },
    { id: 'clienthub',  section: 'Strategy',    label: 'Engine Room',    icon: I.phone,   title: 'Engine Room calling',  sub: 'Per-team calls, seller leads, rental leads & emails across the ClientHub campaigns' },
    { id: 'clocks',     section: 'Admin',       label: 'Clocks',         icon: I.clock,    title: 'Clocks',               sub: 'Staff hours, requests & team — manage everything in one place' },
    { id: 'team',       section: 'Admin',       label: 'Staff',          icon: I.users,    title: 'Staff Directory',      sub: 'Roster · clock-in status · forgot-to-clock-out · mark absent · broker logins' },
    { id: 'payroll',    section: 'Admin',       label: 'Payroll',        icon: I.cal2,     title: 'Payroll · Divisions Allocations', sub: 'Pay-period hours by division — 21st → 20th' },
    { id: 'teams-report', section: 'Admin',     label: 'Teams Reporting', icon: I.medal,   title: 'Teams Reporting',      sub: 'Pick teams · see who called for them (incl. cross-team) · division cost-attribution · export PDF/PNG' },
  ];

  // The dedicated Payroll role sees only these tabs: Clocks, Staff (Directory)
  // and Payroll. Super wins over Payroll, so a superuser who also carries the
  // payroll marker keeps full access.
  const PAYROLL_TAB_IDS = new Set(['clocks', 'team', 'payroll']);
  // A login is a Payroll login when its designation is 'payroll' (settable in
  // the Add-Staff form, no DB migration needed) OR the optional is_payroll flag
  // is set (if that column ever gets added). Designation is the primary path.
  const isPayrollLogin = (st) => !!st && (st.designation === 'payroll' || !!st.is_payroll);
  const payrollRole = () => !!(session && session.payroll && !session.super);
  const defaultTabFor = () =>
    (session && session.super) ? 'leadership' : payrollRole() ? 'payroll' : 'overview';

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
    divCostTeams: [], // Division Costs view: [] = all, else selected division names
    hideSdl: false,   // true while the Division Costs card is shown inside Teams Reporting
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
        .select('*')
        .eq('auth_user_id', data.user.id).maybeSingle();
      // Payroll logins are a restricted role (Clocks / Staff / Payroll only) and
      // may sign in without the is_admin flag (designation 'payroll' is enough).
      if (sErr || !staff || !(staff.is_admin || isPayrollLogin(staff)) || staff.active === false) {
        await window.sb.auth.signOut();
        throw new Error('Not an admin');
      }
      setSession({
        id: staff.id, name: staff.name, role: staff.role || '', team: staff.team || '',
        admin: true, super: !!staff.is_super, payroll: isPayrollLogin(staff),
      });
      if (staff.is_super) tab = 'leadership';           // superusers land on Leadership
      else if (isPayrollLogin(staff)) tab = 'payroll';  // payroll role lands on Payroll
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
  // Single shared util — was duplicated in app.js, views.js, payroll.js.
  // Re-exposed on window so the other modules can drop their copies.
  window.QUAY_ESC = escapeHtml;
  // Relative-time label for the sidebar live-sync indicator. Pulls the
  // freshest signal we've got — Q.snapshot timestamp if data.js exposed
  // one, otherwise the page load time. Previously hard-coded "4 min ago".
  function liveSyncedLabel() {
    const Q = window.QUAY;
    const ts = (Q && (Q.dataAsOf || Q.snapshot || Q.generated))
      || (window.QUAY_LOADED_AT || Date.now());
    const mins = Math.max(0, Math.round((Date.now() - Number(ts)) / 60000));
    let rel;
    if (mins < 1)      rel = 'just now';
    else if (mins < 60) rel = mins + ' min ago';
    else if (mins < 24 * 60) rel = Math.round(mins / 60) + 'h ago';
    else                rel = Math.round(mins / (24 * 60)) + 'd ago';
    return 'Live · synced ' + rel;
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

  // Human-readable date range for a given period key — e.g. "16–22 Jun 2026".
  // Anchors numbers to a concrete window so labels stay interpretable (the
  // quick-period LABELS like "This Week" are colloquial; the concrete range
  // resolves any ambiguity about exactly which week/month is meant).
  function formatPeriodRange(key) {
    try {
      if (!Q.periodDateRange) return '';
      const r = Q.periodDateRange(key);
      if (!r || !r.fromISO || !r.toISO) return '';
      const from = new Date(r.fromISO);
      const to   = new Date(new Date(r.toISO).getTime() - 86400 * 1000); // inclusive end
      const monthYear = d => d.toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' });
      const day = d => d.getDate();
      const sameMonth = from.getFullYear() === to.getFullYear() && from.getMonth() === to.getMonth();
      return sameMonth
        ? `${day(from)}–${day(to)} ${monthYear(to)}`
        : `${day(from)} ${from.toLocaleDateString('en-ZA',{month:'short'})} – ${day(to)} ${monthYear(to)}`;
    } catch { return ''; }
  }
  // Active-period range as a " · <range>" subtitle suffix.
  function periodRangeSuffix() {
    const l = formatPeriodRange(period);
    return l ? ` · ${l}` : '';
  }

  // The effective date window for a tab's subtitle + print header — matches
  // whatever date control governs that tab's body, so the header label never
  // contradicts the on-screen data. Empty string = the tab has no date scope
  // (or carries its own dates inline), so no label is shown.
  function tabWindowLabel(tab) {
    const rng = (f, t) => `${f} → ${t}`;
    const periodLabel = () => {
      const s = periodRangeSuffix();
      return s ? s.replace(/^ · /, '') : periodLabelFor(period);
    };
    if (GLOBAL_RANGE_TABS.has(tab)) return (gDateFrom && gDateTo) ? rng(gDateFrom, gDateTo) : periodLabel();
    switch (tab) {
      case 'live':         return (liveDateFrom && liveDateTo) ? rng(liveDateFrom, liveDateTo) : 'today';
      case 'leadership':   return (leadDateFrom && leadDateTo) ? rng(leadDateFrom, leadDateTo) : '';
      case 'ln':           return (_lnDateFrom && _lnDateTo)   ? rng(_lnDateFrom, _lnDateTo)   : periodLabel();
      case 'teams-report': return (_trDateFrom && _trDateTo)   ? rng(_trDateFrom, _trDateTo)   : periodLabel();
      case 'manager':
      case 'sources':      return periodLabel();
      // monthly / compare / clienthub / clocks / team / payroll carry their own
      // dating in the body (or have none) — no header date label.
      default:             return '';
    }
  }

  // ---------------------------------------------------- SHELL
  function shell() {
    // We're authenticated when supabase has an active session AND we know
    // the staff row. setSession({...staff}) is set by submitLogin/setSession.
    if (!session || !session.id) { renderLogin(); return; }
    // Filter tabs by role: only superusers see Leadership + Teams Reporting.
    // Payroll is visible to managers too (they need pay-period hours).
    // The dedicated Payroll role is restricted to just Clocks / Staff / Payroll.
    const PAYROLL_ONLY = payrollRole();
    const visibleTabs = TABS.filter(t => {
      if (PAYROLL_ONLY) return PAYROLL_TAB_IDS.has(t.id);
      return (t.id !== 'leadership'   || session.super) &&
             (t.id !== 'teams-report' || session.super);
    });
    // If someone lands on a hidden tab (e.g. via deep link), bounce to their
    // role's home tab (Payroll -> Payroll; everyone else -> Overview).
    if (!visibleTabs.find(t => t.id === tab)) tab = defaultTabFor();
    // Group nav items by section (Performance / People / Time / Strategy / Admin).
    // Reduces cognitive load — see Miller's 7±2.
    const sectionOrder = ['Performance', 'People', 'Time', 'Strategy', 'Admin'];
    const navItems = sectionOrder
      .map(sec => {
        const items = visibleTabs.filter(t => t.section === sec);
        if (!items.length) return '';
        const buttons = items.map(t => `
          <button class="nav-item ${t.id === tab ? 'active' : ''}" data-tab="${t.id}" title="${t.label}"${t.id === tab ? ' aria-current="page"' : ''}>
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
              <div class="signed-r">${session.super ? 'Superuser' : payrollRole() ? 'Payroll' : 'Manager'}${session.role ? ' · ' + escapeHtml(session.role) : ''}</div>
            </div>
            <button class="signed-out" id="signOut" title="Sign out" aria-label="Sign out">${I.arrow}</button>
          </div>
          <span class="live-dot"></span><span class="foot-text">${liveSyncedLabel()}</span>
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
            <button class="live-flags-badge" id="liveFlagsBadge" title="Open Red Flags to action these flags">
              <span class="lfb-pulse"></span>
              <span class="lfb-icon">⚑</span>
              <span class="lfb-count" id="lfbCount">0</span>
              <span class="lfb-label">red flag<span id="lfbS"></span></span>
            </button>
            <button class="btn" id="btnPrint" title="Print / save as PDF">${I.print} Print</button>
            <button class="btn btn-primary" id="btnExport" title="Download current tab as CSV">${I.download} Export CSV</button>
          </div>
        </header>
        ${globalDateBar(tab)}
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
    // Global header chips — set the period and clear any active global range.
    document.querySelectorAll('[data-gperiod]').forEach(b =>
      b.addEventListener('click', () => {
        period = b.dataset.gperiod;
        gDateFrom = null; gDateTo = null;
        // Preserve an open agent drill-down across the period change. The
        // shell rebuild re-renders #app (the modal lives in a body-level
        // mount so it survives), but the modal's data is stale until we
        // re-open it with the new period.
        const reopenAgent = currentAgentModalName;
        shell();
        if (reopenAgent) openAgentModal(reopenAgent);
      }));
    // Global header From/To range (shown only on migrated tabs).
    wireDatePicker('g', (kind, value) => {
      if (kind === 'from') gDateFrom = value;
      else if (kind === 'to') gDateTo = value;
      else { gDateFrom = null; gDateTo = null; }
    });
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
    const winLabel = tabWindowLabel(tab);
    document.getElementById('tabTitle').textContent = meta.title;
    document.getElementById('tabSub').textContent = meta.sub + (winLabel ? ` · ${winLabel}` : '');
    // Stamp print-time metadata used by the @media print header strip
    document.body.dataset.printTitle  = meta.title;
    document.body.dataset.printPeriod = winLabel || ((Q.PERIODS[period] || {}).label || period);
    document.body.dataset.printDate   = new Date().toLocaleDateString('en-ZA',
      { day: '2-digit', month: 'short', year: 'numeric' });
    render();
  }

  // Tabs that own an in-page date control of their own (a From/To picker, a
  // window selector, or an embedded iframe with its own pills). The shared
  // header bar is suppressed on these so no page ever shows two date ranges:
  //   leadership   — custom From/To only (revenue/pace need a real range)
  //   ln           — end-of-day report From/To picker
  //   teams-report — per-team From/To picker
  //   compare      — week/month/agent sub-views + their own agent A/B range
  //   clienthub    — Engine Room window selector (last-week/this-month/last-month)
  //   clocks       — embeds the quay-clock admin, which has its own pills
  //   team         — Staff Directory roster: no date dimension at all
  //   monthly      — all-time month-by-month roll-up: ignores period entirely
  // Payroll (own Billing Period) and Live Floor (own consolidated bar) are
  // handled explicitly in globalDateBar().
  const OWN_DATE_CONTROL = new Set([
    'leadership', 'ln', 'teams-report', 'compare', 'clienthub', 'clocks', 'team', 'monthly',
  ]);

  // Live Floor's header bar — the role filter (All/RM/LN/Fancy) plus its own
  // From/To range, consolidated up here so the floor isn't split across three
  // bars. Live Floor is today/historical (not period-based), so it shows these
  // instead of the quick chips. When a range is set it flips to historical
  // mode, where the role filter no longer applies — so we swap in a label.
  function liveDateBar() {
    const liveRange = !!(liveDateFrom && liveDateTo);
    const left = liveRange
      ? `<div class="live-range-label">Historical range</div>`
      : `<div class="qf-chips" role="group" aria-label="Filter the floor by role">${DESIG_OPTS.map(([k, l]) =>
          `<button class="qf-chip ${liveDesig === k ? 'active' : ''}" data-livedesig="${k}" type="button" aria-pressed="${liveDesig === k}">${l}</button>`).join('')}</div>`;
    return `<div class="datebar">${left}${datePickerMarkup('live', liveDateFrom, liveDateTo)}</div>`;
  }

  // Full-width date bar below the topbar — the single date control on tabs that
  // don't own one themselves. Quick chips set `period`; migrated tabs
  // (GLOBAL_RANGE_TABS) also get the global From/To range. Suppressed entirely
  // on tabs that own a date control (OWN_DATE_CONTROL), on Payroll (own Billing
  // Period selector), so a page never shows two date ranges.
  function globalDateBar(tab) {
    if (tab === 'payroll') return '';
    if (tab === 'live') return liveDateBar();   // role filter + its own range
    if (OWN_DATE_CONTROL.has(tab)) return '';   // tab owns its date control
    const migrated = GLOBAL_RANGE_TABS.has(tab);
    const gRange = migrated && !!(gDateFrom && gDateTo);
    const chips = `<div class="qf-chips" role="group" aria-label="Quick period">${GLOBAL_QUICK.map(([k, lbl]) => {
      const on = !gRange && period === k;
      const rangeText = formatPeriodRange(k);
      const title = rangeText ? `${lbl} · ${rangeText}` : lbl;
      // When a custom range overrides the chips, dim them so it's clear they're
      // no longer driving the view (the active range shows in the picker).
      return `<button class="qf-chip ${on ? 'active' : ''}${gRange ? ' overridden' : ''}" data-gperiod="${k}" type="button" aria-pressed="${on}" title="${escapeHtml(title)}">${lbl}</button>`;
    }).join('')}</div>`;
    const range = migrated ? datePickerMarkup('g', gDateFrom, gDateTo) : '';
    return `<div class="datebar">${chips}${range}</div>`;
  }

  // Shared custom date-range picker markup (mirrors the All Staff / LN /
  // Teams pattern). `prefix` namespaces the input ids: `${prefix}DateFrom`,
  // `${prefix}DateTo`, `${prefix}DateClear`. Reused by Overview + Leadership.
  function datePickerMarkup(prefix, from, to) {
    // Cap at TODAY in SAST, not UTC — after 22:00 SAST the UTC date is still
    // "yesterday", which would wrongly bar picking today near midnight.
    const today = sastDateStr(new Date());
    const active = !!(from && to);
    return `<div class="ln-date-picker" aria-label="Custom date range">
      <label class="muted" for="${prefix}DateFrom">From</label>
      <input id="${prefix}DateFrom" type="date" value="${from || ''}" max="${today}">
      <span class="muted" aria-hidden="true">→</span>
      <label class="muted" for="${prefix}DateTo">To</label>
      <input id="${prefix}DateTo" type="date" value="${to || ''}" max="${today}">
      ${active ? `<button class="btn" id="${prefix}DateClear" type="button" style="padding:5px 10px;font-size:12px">Clear</button>` : ''}
    </div>`;
  }
  // Wire a datePickerMarkup instance. `onChange(kind, value)` is called with
  // ('from'|'to', value) or ('clear'); it should update the caller's state.
  // Re-renders via shell() and restores focus to the edited field.
  function wireDatePicker(prefix, onChange) {
    const f = document.getElementById(`${prefix}DateFrom`);
    const t = document.getElementById(`${prefix}DateTo`);
    const c = document.getElementById(`${prefix}DateClear`);
    const refocus = (id) => { const el = document.getElementById(id); if (el) el.focus(); };
    if (f) f.addEventListener('change', (e) => { onChange('from', e.target.value || null); shell(); refocus(`${prefix}DateFrom`); });
    if (t) t.addEventListener('change', (e) => { onChange('to', e.target.value || null); shell(); refocus(`${prefix}DateTo`); });
    if (c) c.addEventListener('click', () => { onChange('clear'); shell(); });
  }
  // Sum a per-agent list into the {calls,leads,avgSuccess,active} shape that
  // Q.totalsFor returns — used when a custom range replaces the period totals.
  function _totalsFromList(list) {
    const calls = list.reduce((s, a) => s + (a.calls || 0), 0);
    const leads = list.reduce((s, a) => s + (a.leads || 0), 0);
    const sc    = list.reduce((s, a) => s + (a.rawSuccess || 0), 0);
    return { calls, leads, avgSuccess: calls ? +((sc / calls) * 100).toFixed(1) : 0, active: list.length };
  }

  // ---------------------------------------------------- ROUTER
  function render() {
    const host = document.getElementById('content');
    if (tab === 'leadership'   && !session?.super) { tab = 'overview'; }
    if (tab === 'teams-report' && !session?.super) { tab = 'overview'; }
    if (tab === 'leadership')    { host.innerHTML = leadership(); afterLeadership(); }
    else if (tab === 'overview') { host.innerHTML = overview(); afterOverview(); }
    else if (tab === 'staff')    {
      const asRange = (gDateFrom && gDateTo) ? { from: gDateFrom, to: gDateTo } : null;
      host.innerHTML = V.allStaff(period, staffTeamFilter, asRange);
      staffWire();
    }
    else if (tab === 'compare')  {
      const agRange = (cmpAgDateFrom && cmpAgDateTo) ? { from: cmpAgDateFrom, to: cmpAgDateTo } : null;
      host.innerHTML = V.compare(period, agRange); segWire();
    }
    else if (tab === 'monthly')  { host.innerHTML = V.monthly(); monthlyWire(); }
    else if (tab === 'manager')  { host.innerHTML = V.manager(period); managerWire(); }
    else if (tab === 'ln')       { host.innerHTML = renderLnLeaderboard(); wireLnLeaderboard(); }
    else if (tab === 'sources')  host.innerHTML = V.leadSources(period);
    else if (tab === 'clienthub'){ host.innerHTML = renderClientHubTeams(); wireClientHubTeams(); }
    else if (tab === 'payroll')  { payrollState.hideSdl = false; host.innerHTML = V.payroll(payrollState); payrollWire(); }
    else if (tab === 'clocks')   { host.innerHTML = clocksIframe(); wireClocks(); }
    else if (tab === 'team')     { host.innerHTML = renderTeamView(); wireTeamView(); }
    else if (tab === 'live')     { host.innerHTML = renderLiveFloor(); liveFloorWire(); }
    else if (tab === 'teams-report') { payrollState.hideSdl = true; host.innerHTML = renderTeamsReporting(); wireTeamsReporting(); }
    // Any per-card "Export CSV" button shares the topbar export handler.
    document.querySelectorAll('#content .js-export').forEach(b => {
      if (b.__exportWired) return; b.__exportWired = true;
      b.addEventListener('click', exportCurrentTab);
    });
    // Reset scroll to top only when the tab has actually CHANGED. Live Floor
    // is re-rendered every ~90s from realtime pushes; scrolling to the top
    // mid-read was the "roster jumps every 90 seconds" bug. On same-tab
    // re-renders keep the user's scroll position.
    if (render._lastTab !== tab) {
      host.scrollTop = 0;
      render._lastTab = tab;
    }
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
    // When the embedded admin says it's ready, hand off ONLY the current
    // short-lived Supabase access_token — never the refresh_token.
    //
    // Audit finding C2 (P1): passing the refresh token lets the iframe
    // origin hold a durable session on its own — a future XSS on
    // twigs002.github.io/quay-clock/ could exfiltrate it for long-term
    // impersonation. The access token expires in ~1h; the iframe can
    // re-request via postMessage on expiry (implemented on quay-clock
    // side — expiry triggers a fresh 'quay-admin-ready' message).
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
              // refresh_token intentionally omitted — see C2 comment above.
              expires_at: data.session.expires_at,
            },
          }, ev.origin);
          // Deep-link: a payroll "Edit day" button may have asked to open a
          // specific staff member's timesheet on an exact day. The admin is now
          // ready + authed, so hand off the target; it opens once its data loads.
          if (window.__clockEditTarget) {
            const t = window.__clockEditTarget;
            window.__clockEditTarget = null;
            target.postMessage({ type: 'quay-open-editor', staffId: t.staffId, day: t.day, agentName: t.agentName }, ev.origin);
          }
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
        // Reset the Division Costs filter when leaving that view so it doesn't
        // silently persist an old selection when the user returns.
        if (b.dataset.payrollView !== 'divisionCosts') payrollState.divCostTeams = [];
        // Re-render shell so the host pane swaps to the new sub-view.
        shell();
      });
    });
    // Division Costs — multi-select division picker (present only on that view).
    payrollDivPickerWire();
    // "Edit day →" deep-links (on the no-team / unpaired-punch lists): stash the
    // target, switch to the Clocks tab. The fresh admin iframe boots, reports
    // ready, and wireClocks hands it the target to open (see quay-open-editor).
    if (!window.__clockEditWired) {
      window.__clockEditWired = true;
      document.addEventListener('click', (ev) => {
        const btn = ev.target.closest && ev.target.closest('[data-clock-edit]');
        if (!btn) return;
        ev.preventDefault();
        window.__clockEditTarget = {
          staffId: btn.dataset.clockEdit,
          day: btn.dataset.clockDay,
          agentName: btn.dataset.clockName,
        };
        tab = 'clocks';
        shell();
      });
    }
    // First mount: hydrate config from DB, then kick off the fetch if
    // we haven't already. Config load + shift fetch run in parallel so
    // tab open isn't bottle-necked by either.
    if (payrollState.shifts === null && !payrollState.loading) {
      payrollFetchAndRender();
    }
  }

  // Wires the Division Costs multi-select division picker. Ticking a box
  // re-renders ONLY the table (via V.payrollDivisionCostsTable) so the open
  // menu, its search text and scroll position all survive — no full shell().
  let _divPickerDocBound = false;
  function payrollDivPickerWire() {
    const btn = document.getElementById('divCostPickerBtn');
    const menu = document.getElementById('divCostMenu');
    if (!btn || !menu) return;
    const list = document.getElementById('divCostList');
    const search = document.getElementById('divCostSearch');
    const clearBtn = document.getElementById('divCostClear');
    const V = window.VIEWS || {};

    const closeMenu = () => { menu.style.display = 'none'; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu.style.display === 'block') { closeMenu(); return; }
      menu.style.display = 'block';
      btn.setAttribute('aria-expanded', 'true');
      if (search) search.focus();
    });
    // Clicks inside the menu shouldn't reach the document outside-click closer.
    menu.addEventListener('click', (e) => e.stopPropagation());

    const applySelection = () => {
      if (!list) return;
      const checked = Array.from(list.querySelectorAll('input[type=checkbox]:checked')).map(c => c.value);
      payrollState.divCostTeams = checked;
      const host = document.getElementById('divCostTableHost');
      const alloc = payrollState.allocations || {};
      // The standalone Division Costs report tags its host with data-hide-sdl
      // so live re-renders keep the SDL column hidden.
      const hideSdl = !!(host && host.dataset.hideSdl === '1');
      if (host && V.payrollDivisionCostsTable) {
        host.innerHTML = V.payrollDivisionCostsTable(alloc.empTeamHours, alloc.empTotalHours, alloc.empMeta, checked, { hideSdl });
      }
      const summary = document.getElementById('divCostSummary');
      if (summary && V.divCostSummary) summary.textContent = V.divCostSummary(checked);
      const count = document.getElementById('divCostCount');
      if (count) count.textContent = checked.length ? `${checked.length} selected` : 'All divisions';
      const cap = document.getElementById('divCostCaption');
      const allCap = hideSdl
        ? 'Cost-attribution pivot · PAYROLL = total hrs × rate · DIV CONTRIBUTION = half the wage for hours on this division (50% split · head office carries the other half)'
        : 'Cost-attribution pivot · PAYROLL = total hrs × rate · SDL = 1.1% levy · DIV CONTRIBUTION = half the wage for hours on this division + its SDL share (50% split · head office carries the other half)';
      if (cap) cap.innerHTML = checked.length
        ? `Showing ${checked.length} selected division${checked.length === 1 ? '' : 's'} · use the Divisions picker to change`
        : allCap;
    };

    if (list) list.addEventListener('change', (e) => {
      if (e.target && e.target.matches('input[type=checkbox]')) applySelection();
    });
    if (clearBtn) clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      list.querySelectorAll('input[type=checkbox]:checked').forEach(c => { c.checked = false; });
      applySelection();
    });
    if (search) search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      list.querySelectorAll('label.divcost-opt').forEach(lab => {
        const name = (lab.textContent || '').trim().toLowerCase();
        lab.style.display = (!q || name.includes(q)) ? '' : 'none';
      });
    });

    // Outside-click closes the menu. Bound once on document; it re-resolves
    // the (re-rendered) elements by id each time so it survives shell() rebuilds.
    if (!_divPickerDocBound) {
      _divPickerDocBound = true;
      document.addEventListener('click', () => {
        const m = document.getElementById('divCostMenu');
        if (m && m.style.display === 'block') {
          m.style.display = 'none';
          const b = document.getElementById('divCostPickerBtn');
          if (b) b.setAttribute('aria-expanded', 'false');
        }
      });
    }
  }

  async function payrollFetchAndRender() {
    if (!window.PAYROLL) return;
    payrollState.loading = true;
    payrollState.error = null;
    // Render the loading state immediately.
    if (tab === 'payroll' || tab === 'teams-report') shell();
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
      if (tab === 'payroll' || tab === 'teams-report') shell();
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
        seg.querySelectorAll('button').forEach(x => { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
        b.classList.add('active'); b.setAttribute('aria-pressed', 'true');
        // Compare tab seg buttons carry data-cmp-mode and gate which panel shows.
        const mode = b.dataset.cmpMode;
        if (mode) {
          const wk = document.getElementById('cmpWeekPanel');
          const mo = document.getElementById('cmpMonthPanel');
          const ag = document.getElementById('cmpAgentPanel');
          if (wk) wk.style.display = mode === 'week'  ? '' : 'none';
          if (mo) mo.style.display = mode === 'month' ? '' : 'none';
          if (ag) ag.style.display = mode === 'agent' ? '' : 'none';
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
    // Agent vs Agent dropdowns — snapshot the current period's roster
    // and swap in the inner body when either picker changes.
    const aga = document.getElementById('cmpAgentA');
    const agb = document.getElementById('cmpAgentB');
    const agbody = document.getElementById('cmpAgentBody');
    if (aga && agb && agbody) {
      const rosterFor = () => {
        // Self-contained: latest complete week by default (Compare has no
        // period control), matching V.compare()'s activePeriod. Uses last-week
        // (weeks[1], last completed) — this-week is now the in-progress week.
        const list = (cmpAgDateFrom && cmpAgDateTo)
          ? ((Q.agentsForRange && Q.agentsForRange(cmpAgDateFrom, cmpAgDateTo)) || [])
          : ((Q.agentsFor && Q.agentsFor('last-week')) || []);
        return list.slice().sort((a, b) => b.calls - a.calls);
      };
      let roster = rosterFor();
      const redrawAg = () => {
        agbody.innerHTML = V.renderAgentCompare(roster, aga.value, agb.value);
      };
      aga.addEventListener('change', redrawAg);
      agb.addEventListener('change', redrawAg);
      // Agent-vs-Agent custom date range. Re-scope the roster + dropdown
      // options and re-render the body IN PLACE — never shell(), which would
      // reset the seg back to Week vs Week. The picker markup lives inside
      // #cmpAgentPanel, so it only shows on the Agent-vs-Agent view.
      const agRebuild = () => {
        roster = rosterFor();
        const prevA = aga.value, prevB = agb.value;
        const opt = (sel) => roster.map(a =>
          `<option value="${escapeHtml(a.name)}" ${a.name === sel ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('');
        const keepA = roster.some(a => a.name === prevA) ? prevA : (roster[0] ? roster[0].name : '');
        const keepB = roster.some(a => a.name === prevB) ? prevB : (roster[1] ? roster[1].name : (roster[0] ? roster[0].name : ''));
        aga.innerHTML = opt(keepA);
        agb.innerHTML = opt(keepB);
        redrawAg();
        const note = document.getElementById('cmpAgNote');
        if (note) note.textContent = (cmpAgDateFrom && cmpAgDateTo)
          ? `Custom range · ${cmpAgDateFrom} → ${cmpAgDateTo}`
          : 'Roster & numbers use the latest complete week — pick a custom date range below to change the window.';
      };
      const agF = document.getElementById('cmpAgDateFrom');
      const agT = document.getElementById('cmpAgDateTo');
      const agC = document.getElementById('cmpAgDateClear');
      if (agF) agF.addEventListener('change', (e) => { cmpAgDateFrom = e.target.value || null; agRebuild(); });
      if (agT) agT.addEventListener('change', (e) => { cmpAgDateTo = e.target.value || null; agRebuild(); });
      if (agC) agC.addEventListener('click', () => {
        cmpAgDateFrom = null; cmpAgDateTo = null;
        if (agF) agF.value = ''; if (agT) agT.value = '';
        agRebuild();
      });
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
    // SAST-aware "today" / "yesterday" — never trust the browser's UTC
    // slice, which shifts the day for viewers past 22:00 SAST.
    const currentISO = () => sastDateStr(new Date());
    const yesterdayISO = () => {
      const now = new Date();
      const sastMidnight = new Date(sastDateStr(now) + 'T00:00:00+02:00');
      sastMidnight.setDate(sastMidnight.getDate() - 1);
      return sastDateStr(sastMidnight);
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
      seg.querySelectorAll('button').forEach(x => { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
      b.classList.add('active'); b.setAttribute('aria-pressed', 'true');
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
    // Date control lives in the shared header bar now (wired in shell()).
    sortableWire(document.getElementById('staffOverall'));
    wireAgentClicks();
    // Re-wire the LN notes expandable cells if hydration already happened
    // for the current period (e.g. after a re-render).
    lnReportsWireDetails();
  }

  // Fetch clock_out_reports for the current period (or custom From/To
  // range if the staff picker has both ends set), render into the
  // staffLnReports container. Safe to call repeatedly — second call for
  // the same cache key uses the cached data. The custom range takes
  // precedence over the topbar period, matching the Callers Overall /
  // Per Agent sub-views on this same tab.
  async function lnReportsHydrate() {
    const lnPane = document.getElementById('staffLnReports');
    if (!lnPane) return;
    const usingRange = !!(gDateFrom && gDateTo);
    const cacheKey = usingRange ? `range:${gDateFrom}..${gDateTo}` : `period:${period}`;
    // Cache hit — render from memory.
    if (lnReportsState.cacheKey === cacheKey && lnReportsState.data) {
      lnPane.innerHTML = V.lnReports(lnReportsState.data);
      sortableWire(lnPane);
      lnReportsWireDetails();
      return;
    }
    if (lnReportsState.loading && lnReportsState.cacheKey === cacheKey) return;
    if (!window.sb) {
      lnPane.innerHTML = `<div class="card card-pad" style="color:var(--red)">Supabase client not initialised — can't load reports.</div>`;
      return;
    }
    lnReportsState = { cacheKey, loading: true, error: null, data: null };
    const loadingLabel = usingRange
      ? `${gDateFrom} → ${gDateTo}`
      : ((Q.PERIODS[period]||{}).label || period);
    lnPane.innerHTML = `<div class="card card-pad" style="text-align:center;color:var(--muted);padding:40px">Loading end-of-day reports for ${escapeHtml(loadingLabel)}…</div>`;
    try {
      // When the custom picker is set, build an inclusive SAST day range
      // (start-of-from-day → end-of-to-day) so clocks logged anywhere on
      // those local dates are included — same shape as _lnPeriodRange().
      // Otherwise fall back to the period-derived range.
      let fromISO, toISO;
      if (usingRange) {
        const [a, b] = gDateFrom <= gDateTo
          ? [gDateFrom, gDateTo]
          : [gDateTo, gDateFrom];
        fromISO = new Date(a + 'T00:00:00+02:00').toISOString();
        toISO   = new Date(b + 'T23:59:59+02:00').toISOString();
      } else {
        ({ fromISO, toISO } = Q.periodDateRange(period));
      }
      // FK embed: PostgREST resolves clock_out_reports.staff_id → public.staff.
      const { data, error } = await window.sb.from('clock_out_reports')
        .select('id, staff_id, designation, division, clocked_out_at, hs_tasks_completed, hs_calls_made, hs_emails_sent, hs_whatsapps_sent, hs_answered_contacts, hs_leads_vals, hs_reconverted_leads, df_calls, df_email_successes, df_leads_vals, df_hours, wa_sent, wa_responses, wa_leads_vals, notes, staff:staff_id(name)')
        .gte('clocked_out_at', fromISO)
        .lte('clocked_out_at', toISO)
        .order('clocked_out_at', { ascending: false });
      if (error) throw error;
      lnReportsState = { cacheKey, loading: false, error: null, data: data || [] };
      lnPane.innerHTML = V.lnReports(lnReportsState.data);
      sortableWire(lnPane);
      lnReportsWireDetails();
    } catch (e) {
      lnReportsState = { cacheKey, loading: false, error: e, data: null };
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
      // Keep the native columnheader role (so header->cell association and
      // aria-sort stay meaningful); just make it keyboard-focusable/activatable
      // and advertise the sort state. (Overriding role=button voided both.)
      th.setAttribute('tabindex', '0');
      if (!th.hasAttribute('aria-sort')) th.setAttribute('aria-sort', 'none');
      const doSort = () => {
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
          return (dir === 'asc' ? 1 : -1) * String(av).localeCompare(String(bv, undefined, { sensitivity: 'base' }));
        });
        // Re-rank the leftmost cell if it contains a rank number
        rows.forEach((r, i) => {
          const rank = r.querySelector('td:first-child .medal, td:first-child');
          if (rank && /^\d+$/.test((rank.textContent || '').trim())) {
            rank.textContent = i + 1;
          }
        });
        rows.forEach(r => tbody.appendChild(r));
        root.querySelectorAll('th[data-sort]').forEach(x => {
          x.dataset.dir = '';
          x.setAttribute('aria-sort', 'none');
        });
        root.querySelectorAll('th[data-sort] .sort-ind').forEach(s => s.textContent = '');
        th.dataset.dir = dir;
        th.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : 'descending');
        const ind = th.querySelector('.sort-ind');
        if (ind) ind.textContent = dir === 'asc' ? ' ▲' : ' ▼';
      };
      th.addEventListener('click', doSort);
      th.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); doSort(); }
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

  // Focus management for modal dialogs (WCAG 2.4.3 / 2.1.2): move focus into
  // the dialog on open, trap Tab within it while open, and restore focus to
  // whatever triggered it on close. Call after the modal markup is mounted;
  // returns a teardown() to run inside the modal's own close handler.
  function wireModalFocus(mountEl) {
    const dialog = (mountEl && (mountEl.querySelector('[role="dialog"]') || mountEl.firstElementChild)) || null;
    const prevFocus = document.activeElement;
    const SEL = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const focusables = () => dialog
      ? Array.from(dialog.querySelectorAll(SEL)).filter(el => el.offsetParent !== null || el === document.activeElement)
      : [];
    const firstEl = focusables()[0];
    if (firstEl) firstEl.focus();
    else if (dialog && typeof dialog.focus === 'function') dialog.focus();
    const onKey = e => {
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) return;
      const a = f[0], b = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
      else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
    };
    if (mountEl) mountEl.addEventListener('keydown', onKey);
    return function teardown() {
      if (mountEl) mountEl.removeEventListener('keydown', onKey);
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
    };
  }

  // The date scope currently in effect for agent-level figures on the active
  // tab — a custom range when one is set, else null (period). Keeps the
  // drill-down modal and CSV export in agreement with the on-screen tables.
  function activeAgentRange() {
    if (GLOBAL_RANGE_TABS.has(tab) && gDateFrom && gDateTo) return { from: gDateFrom, to: gDateTo };
    if (tab === 'live' && liveDateFrom && liveDateTo)       return { from: liveDateFrom, to: liveDateTo };
    if (tab === 'leadership' && leadDateFrom && leadDateTo) return { from: leadDateFrom, to: leadDateTo };
    return null;
  }

  function openAgentModal(name) {
    const range = activeAgentRange();
    const all = range ? (Q.agentsForRange(range.from, range.to) || []) : Q.agentsFor(period);
    const a = all.find(x => x.name === name);
    if (!a) { currentAgentModalName = null; return; }
    currentAgentModalName = name;
    const hist = Q.agentHistory(name).slice(-12);  // last 12 weeks present
    // Per-campaign attribution is only computed per period, not for an
    // arbitrary range, so we omit it (with an explanatory row) when ranged.
    const camps = range ? [] : Q.agentCampaigns(name, period);
    const scopeLabel = range ? `${range.from} → ${range.to}` : periodLabelFor(period);
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
    }).join('') : `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:18px">${range ? 'Per-campaign breakdown isn\'t available for a custom range — pick a quick period to see it.' : 'No per-campaign breakdown for this period (week pre-dates the new fetcher field).'}</td></tr>`;

    const r = a._raw || {};
    const wt = r.workTime || 0;
    const pct = (n) => wt > 0 ? Math.round((n || 0) / wt * 100) : 0;
    const talkP = pct(r.talkTime), wrapP = pct(r.wrapTime), waitP = pct(r.waitTime);
    // Work % = dialler ÷ (dialler + pause) — how much of clocked session was actively dialling
    const workP = a.workPct != null ? Math.round(a.workPct) : 0;

    const html = `
      <div class="modal-backdrop" id="agentModalBackdrop"></div>
      <div class="modal" id="agentModal" role="dialog" aria-modal="true" aria-labelledby="agentModalTitle">
        <div class="modal-head">
          <div style="display:flex;align-items:center;gap:14px">
            <div class="avatar" style="width:46px;height:46px;font-size:15px">${initials(a.name)}</div>
            <div>
              <div id="agentModalTitle" style="font-family:var(--serif);font-size:22px;font-weight:700;color:var(--ink)">${a.name}</div>
              <div style="display:flex;gap:6px;margin-top:5px;flex-wrap:wrap">
                <span class="pill ${a.team === 'RM' ? 'rm' : 'fancy'}" style="font-size:10.5px">${a.team}</span>
                <span class="pill ${sc}" style="font-size:10.5px">${a.success}% success</span>
                ${onTarget ? '<span class="pill ok" style="font-size:10.5px">on target</span>' : ''}
              </div>
            </div>
          </div>
          <button class="btn modal-close" id="agentModalClose">✕ Close</button>
        </div>
        <div class="modal-body">
          <div class="row g-3">
            <div class="card card-pad"><div class="kpi-label" style="margin:0">Calls (${scopeLabel})</div><div style="font-family:var(--serif);font-size:24px;font-weight:700;color:var(--ink);margin-top:4px">${fmt(a.calls)}</div></div>
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
    const teardownFocus = wireModalFocus(mount);

    const close = () => {
      mount.innerHTML = '';
      document.body.style.overflow = '';
      document.removeEventListener('keydown', escClose);
      teardownFocus();
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
      <div class="modal" id="campaignModal" role="dialog" aria-modal="true" aria-label="Campaign details">
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
    const teardownFocus = wireModalFocus(mount);

    const close = () => {
      mount.innerHTML = '';
      document.body.style.overflow = '';
      document.removeEventListener('keydown', escClose);
      teardownFocus();
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
    const safe = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    // Stamp the actual on-screen scope (custom range if set, else the period)
    // so the file name matches the exported figures.
    const aRange = activeAgentRange();
    const scope = aRange ? `${aRange.from}_${aRange.to}` : safe((Q.PERIODS[period] || {}).label || period);
    const filename = `quay-${tab}-${scope}-${stamp}.csv`;
    let rows;
    if (tab === 'sources')         rows = csvCampaigns();
    else if (tab === 'compare')    rows = csvCompare();
    else if (tab === 'manager')    rows = csvManager();
    else if (tab === 'monthly')    rows = csvMonthly();
    else if (tab === 'payroll')    rows = csvPayroll();
    else if (tab === 'teams-report') rows = csvPayroll(); // Division Costs card CSV (SDL hidden)
    else                            rows = csvAgents();
    downloadCSV(filename, rows);
  }

  function csvAgents() {
    // Match the on-screen scope: custom range if the tab has one, else period.
    const range = activeAgentRange();
    const agents = range ? (Q.agentsForRange(range.from, range.to) || []) : Q.agentsFor(period);
    const header = ['Name', 'Team', 'Calls', 'Leads', 'Success %', 'Connect %',
      'CPH', 'Dialler hrs', 'Talk hrs', 'Seller', 'Rental', 'Email',
      'Meets target', 'Campaigns'];
    const out = [header];
    agents.forEach(a => out.push([
      a.name, a.team, a.calls, a.leads, a.success, a.connect || 0,
      a.cph || 0, a.df || 0, ((a.talkMin || 0) / 60).toFixed(2),
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
        ['Total calls',  a.calls,       b.calls,       delta(a.calls, b.calls)],
        ['Avg success rate', a.successRate.toFixed(1) + '%', b.successRate.toFixed(1) + '%', delta(a.successRate, b.successRate, 'pct')],
        ['Avg calls/hr', a.cph.toFixed(1), b.cph.toFixed(1), delta(a.cph, b.cph, 'rate')],
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
      ['Total calls',  a.calls,       b.calls,       delta(a.calls, b.calls)],
      ['Avg success rate', a.successRate.toFixed(1) + '%', b.successRate.toFixed(1) + '%', delta(a.successRate, b.successRate, 'pct')],
      ['Avg calls/hr', a.cph.toFixed(1), b.cph.toFixed(1), delta(a.cph, b.cph, 'rate')],
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
    // The standalone Division Costs report (hideSdl) always exports that pivot,
    // regardless of the Payroll tab's remembered sub-view.
    const hideSdl = !!s.hideSdl;
    const view = hideSdl ? 'divisionCosts' : (s.activeView || 'allShifts');
    const periodLbl = s.period ? s.period.label : '';
    if (view === 'allShifts') {
      const out = [['Agent', 'Type', 'Date in', 'Time in', 'Date out', 'Time out', 'Employee notes', 'Shift hours (HH:MM)', 'Shift hours (Decimal)']];
      // SAST-anchored date/time so the CSV matches the on-screen table (which
      // uses Africa/Johannesburg) regardless of the exporter's machine zone.
      const fmtD = iso => iso ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)) : '';
      const fmtT = iso => iso ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)) : '';
      (s.shifts || []).forEach(sh => {
        // Bad clock time (out before in => negative): flag it, don't export a
        // real negative number a clerk would subtract when summing the column.
        const bad = sh.shiftHours < 0;
        const hhmm = bad ? 'BAD TIME' : window.PAYROLL.decimalToHHMM(sh.shiftHours);
        const dec = bad ? 'BAD TIME' : sh.shiftHours.toFixed(2);
        out.push([sh.agentName, sh.designation || '', fmtD(sh.clockInAt), fmtT(sh.clockInAt),
          fmtD(sh.clockOutAt), fmtT(sh.clockOutAt), sh.note || '', hhmm, dec]);
      });
      return out;
    }
    if (view === 'perAgent') {
      const out = [['Agent', 'Team / Division', 'Hours (HH:MM)', 'Hours (Decimal)', '% of Agent Time', 'Hourly Rate', 'R-amount']];
      if (s.allocations) {
        const ETH = s.allocations.empTeamHours;
        const ETOT = s.allocations.empTotalHours;
        const EMETA = s.allocations.empMeta || new Map();
        const agents = Array.from(ETH.keys()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        agents.forEach(agent => {
          const teams = Array.from(ETH.get(agent).entries()).sort((a, b) => b[1] - a[1]);
          const total = ETOT.get(agent) || 0;
          const rate = EMETA.get(agent) ? EMETA.get(agent).hourlyRate : null;
          let sumPay = 0;
          teams.forEach(([t, hrs]) => {
            const pct = total > 0 ? (hrs / total) * 100 : 0;
            const pay = rate != null ? hrs * rate : null;
            if (pay != null) sumPay += pay;
            out.push([agent, t, window.PAYROLL.decimalToHHMM(hrs), (Math.round(hrs * 100) / 100).toFixed(2),
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
        const agents = Array.from(ETOT.keys()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
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
    if (view === 'comparison') {
      const out = [['First name', 'Last name', 'Designation', 'Division',
        'Hours (Decimal)', 'Earned', 'Full Salary', '% of Salary', 'Shortfall']];
      if (s.allocations) {
        const ETOT = s.allocations.empTotalHours;
        const EMETA = s.allocations.empMeta || new Map();
        const agents = Array.from(ETOT.keys()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        let gEarn = 0, gSal = 0, gDiff = 0;
        agents.forEach(agent => {
          const total = ETOT.get(agent) || 0;
          const meta = EMETA.get(agent) || {};
          const rate = meta.hourlyRate;
          const salary = meta.salary;
          const earned = rate != null ? total * rate : null;
          const canCompare = earned != null && salary != null;
          const diff = canCompare ? (salary - earned) : null;
          const pct = canCompare && salary > 0 ? (earned / salary) * 100 : null;
          if (earned != null) gEarn += earned;
          if (salary != null) gSal += salary;
          if (canCompare) gDiff += diff;
          const parts = (agent || '').split(/\s+/);
          const fn = parts.slice(0, -1).join(' ') || parts[0] || '';
          const ln = parts.length > 1 ? parts[parts.length - 1] : '';
          out.push([fn, ln, meta.designation || '', meta.division || '',
            total.toFixed(2),
            earned == null ? '' : earned.toFixed(2),
            salary == null ? '' : salary.toFixed(2),
            pct == null ? '' : pct.toFixed(0),
            diff == null ? '' : diff.toFixed(2)]);
        });
        const gPct = gSal > 0 ? (gEarn / gSal) * 100 : null;
        out.push(['TOTAL', '', '', '', '',
          gEarn.toFixed(2), gSal.toFixed(2),
          gPct == null ? '' : gPct.toFixed(0), gDiff.toFixed(2)]);
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
      nonCanon.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
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
      // Division filter — mirror the on-screen picker so the CSV is WYSIWYG.
      const _nonCanonAll = [];
      teamEmp.forEach((_m, t) => {
        if (!window.PAYROLL.CANONICAL_SET.has(t) && t !== '(No team noted)') _nonCanonAll.push(t);
      });
      const _allRowTeams = window.PAYROLL.CANONICAL_TEAMS
        .concat(_nonCanonAll)
        .concat(teamEmp.has('(No team noted)') ? ['(No team noted)'] : []);
      // Selected divisions (multi-select). Empty = all. Column count is sized
      // to the rendered divisions only, matching the on-screen table.
      const _selSet = new Set((Array.isArray(s.divCostTeams) ? s.divCostTeams : [])
        .filter(t => _allRowTeams.includes(t)));
      const _isFiltered = _selSet.size > 0;
      const _rowTeams = _allRowTeams.filter(t => !_isFiltered || _selSet.has(t));
      let maxHead = 1;
      _rowTeams.forEach(t => { const m = teamEmp.get(t); if (m && m.size > maxHead) maxHead = m.size; });
      const header = ['Division'];
      for (let i = 1; i <= maxHead; i++) {
        header.push(`Fancy / LN name ${i}`);
        header.push('Payroll amount');
        if (!hideSdl) header.push('SDL');
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
            if (!hideSdl) row.push(fmt2(x.sdl));
            row.push((x.pct * 100).toFixed(1) + '%');
            row.push(fmt2(x.contrib));
            if (!gtCountedEmps.has(x.emp)) {
              if (x.payroll != null) gtPayrollTotal += x.payroll;
              if (x.sdl != null)     gtSdlTotal += x.sdl;
              gtCountedEmps.add(x.emp);
            }
            if (x.contrib != null) { gtContrib[i] += x.contrib; rowTotal += x.contrib; }
          } else {
            row.push(''); row.push(''); row.push(''); row.push('');
            if (!hideSdl) row.push('');
          }
        }
        row.push(fmt2(rowTotal));
        row.push(note);
        gtRowTotal += rowTotal;
        return row;
      };
      window.PAYROLL.CANONICAL_TEAMS.forEach(t => {
        if (_isFiltered && !_selSet.has(t)) return;
        const members = teamEmp.get(t);
        out.push(rowFor(t, (members && members.size) ? '' : 'no agents this period'));
      });
      const nonCanon = _nonCanonAll
        .filter(t => !_isFiltered || _selSet.has(t))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      const showNoTeam = teamEmp.has('(No team noted)') && (!_isFiltered || _selSet.has('(No team noted)'));
      if (nonCanon.length || showNoTeam) {
        out.push(['--- Not in master list — review ---']);
        nonCanon.forEach(t => out.push(rowFor(t, 'Not in master list')));
        if (showNoTeam) out.push(rowFor('(No team noted)', 'Shifts where the Employee notes field was blank'));
      }
      // Grand-total row — floor PAYROLL/SDL in slot 0 only, per-slot CONTRIB.
      const tot = ['GRAND TOTAL'];
      for (let i = 0; i < maxHead; i++) {
        tot.push('');
        tot.push(i === 0 ? fmt2(gtPayrollTotal) : '');
        if (!hideSdl) tot.push(i === 0 ? fmt2(gtSdlTotal) : '');
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
      const teams = Array.from(rv.keys()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      teams.forEach(t => {
        const variants = Array.from(rv.get(t)).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
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
    // Custom date range (from the Overview picker) overrides the topbar
    // period for the headline numbers. Deltas + the trailing-window visuals
    // (trend/donut/spotlights/insights) have no range baseline, so they are
    // hidden while a range is active — the KPIs, Top-6 and schedule cards
    // still re-scope to the range.
    const ovRange = (gDateFrom && gDateTo) ? { from: gDateFrom, to: gDateTo } : null;
    const rangedList = ovRange ? Q.agentsForRange(ovRange.from, ovRange.to) : null;
    const rangeMeta = rangedList && rangedList._range;
    const t = rangedList ? _totalsFromList(rangedList) : Q.totalsFor(period);
    const d = rangedList ? { calls: 0, success: 0, leads: 0, active: 0 } : Q.DELTAS[period];
    const agents = (rangedList || Q.agentsFor(period)).slice().sort((a, b) => b.calls - a.calls);
    const top = agents[0];
    const src = Q.SOURCES.slice().sort((a, b) => b.conv - a.conv);
    const bestSrc = src[0];
    const risk = agents.slice().sort((a, b) => a.success - b.success)[0];

    // Delta units explicit — was inferring from the label string, which
    // misclassified "Active Callers" (a raw head count) as a percent.
    // `kind`: 'pct' (rate/share → "pts"), 'count' (head count → bare number),
    // 'pct-of-base' (count change shown as % vs prior, default for rates).
    const kpi = (icon, label, val, deltaVal, foot, kind, sparkSeries) => {
      const cls = deltaVal > 0 ? 'up' : deltaVal < 0 ? 'down' : 'flat';
      const ic = deltaVal > 0 ? I.up : deltaVal < 0 ? I.down : '';
      let dtxt;
      if (deltaVal === 0 || deltaVal == null) {
        dtxt = 'no change';
      } else if (kind === 'pct') {
        dtxt = Math.abs(deltaVal) + ' pts';
      } else if (kind === 'count') {
        dtxt = (deltaVal > 0 ? '+' : '−') + Math.abs(deltaVal);
      } else {
        dtxt = Math.abs(deltaVal) + '%';
      }
      // Sparkline: take the actual metric's recent history when the
      // caller provides it. Falls back to nothing (no sparkline) instead
      // of the previous fake-tilted call-volume series that every KPI
      // was showing regardless of its own metric.
      const spark = (sparkSeries && sparkSeries.length >= 2)
        ? `<div class="spark">${C.spark(sparkSeries.slice(-8))}</div>`
        : '';
      return `<div class="card kpi">
        <div class="kpi-top"><div class="kpi-ic">${icon}</div>
          <span class="delta ${cls}">${ic}${dtxt}</span></div>
        <div class="kpi-label">${label}</div>
        <div class="kpi-val tnum">${val}</div>
        <div class="kpi-foot">${foot}</div>
        ${spark}
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

    const footPrev = ovRange ? 'custom range · no prior baseline'
      : (period === 'current-week' ? 'vs same days last week'
        : ('vs previous ' + Q.PERIODS[period].label.toLowerCase()));
    // Quick filters + the custom-range picker as the prominent control. Chips
    // drive the global period; picking one clears any active custom range.
    // Labels are fixed here (not PERIODS[k].label) because the global period
    // labels are relabelled for the topbar (see PERIODS in data.js). NOTE:
    // weekly_data.json is completed-weeks-only, so "This Week" = the latest
    // completed week (key this-week); the true in-progress week lives on the
    // Live Floor.
    // Date control now lives in the shared header bar (globalDateBar). Only the
    // range caption stays in-page, for the extra "N complete weeks" context.
    const ovCaption = ovRange ? `<div class="range-caption" style="margin-top:0">Custom range · covers <b>${(rangeMeta && rangeMeta.effectiveFrom) || ovRange.from}</b> → <b>${(rangeMeta && rangeMeta.effectiveTo) || ovRange.to}</b>${rangeMeta && rangeMeta.weeksIncluded === 0 ? ' · <span style="color:var(--red)">no complete Mon-Sun weeks in range</span>' : (rangeMeta ? ` · ${rangeMeta.weeksIncluded} complete week${rangeMeta.weeksIncluded === 1 ? '' : 's'}` : '')}</div>` : '';

    return `
    <div class="tab-view">
      ${ovCaption}
      <!-- KPIs -->
      <div class="row kpis">
        ${kpi(I.phone,  'Total Calls',       fmt(t.calls),    d.calls,   footPrev, 'pct-of-base', Q.WEEK_CALLS)}
        ${kpi(I.trophy, 'Avg Success Rate',  t.avgSuccess + '%', d.success, 'successes ÷ calls', 'pct', Q.WEEK_SUCCESS)}
        ${kpi(I.target, 'Total Leads',       fmt(t.leads),    d.leads,   'seller · rental · email', 'pct-of-base', Q.WEEK_LEADS)}
        ${kpi(I.users,  'Active Callers',    t.active + '',   d.active,  'RM + Fancy desks combined', 'count', Q.WEEK_ACTIVE)}
      </div>

      ${ovRange ? '' : `
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
      </div>`}

      <!-- schedule adherence (real clock-in data) + LN daily recap -->
      <div class="mt">
        ${scheduleAdherenceCard()}
        ${lnDailyRecapCard()}
      </div>

      <!-- insights + top10 -->
      <div class="row ${ovRange ? '' : 'g-2-1'} mt" style="align-items:start">
        <div class="card">
          <div class="card-head"><div><h3>Top 6 Performers</h3><div class="sub">Ranked by calls · open All Staff for the full roster</div></div>
            <button class="btn" data-goto="staff">${I.eye} View all</button></div>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th style="width:48px">Rank</th><th>Agent</th><th class="num">Calls</th><th class="num">Leads</th><th class="num">Success</th><th class="num">Volume</th></tr></thead>
            <tbody>${top10}</tbody>
          </table></div>
        </div>
        ${ovRange ? '' : `<div class="card">
          <div class="card-head"><div><h3>Insights</h3><div class="sub">Auto-generated · ${Q.PERIODS[period].label}</div></div></div>
          <div class="insights">${insights(t, d, top, bestSrc, risk, src)}</div>
        </div>`}
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
    // These cards are hidden while a custom range is active, so guard on the
    // host elements existing before rendering into them.
    const trendEl = document.getElementById('trendChart');
    if (trendEl) {
      const trend = (Q.trendSeriesFor ? Q.trendSeriesFor(period) : null)
        || { labels: Q.WEEKS, calls: Q.WEEK_CALLS, success: Q.WEEK_SUCCESS };
      C.weeklyTrend(trendEl, trend.labels, trend.calls, trend.success);
    }
    const donutEl = document.getElementById('donut');
    if (donutEl) {
      const periodSources = Q.sourcesFor ? Q.sourcesFor(period) : Q.SOURCES;
      const total = periodSources.reduce((s, x) => s + x.calls, 0);
      C.donut(donutEl, periodSources.map(s => ({ value: s.calls, color: s.color })),
        fmt(total), 'total calls');
    }
    document.querySelectorAll('.mc').forEach(el =>
      C.miniBars(el, JSON.parse(el.dataset.series), el.dataset.color));
    document.querySelectorAll('[data-goto]').forEach(b =>
      b.addEventListener('click', () => { tab = b.dataset.goto; shell(); }));
    // Date control lives in the shared header bar now (wired in shell()).
    wireAgentClicks();
    wireFlagAckButtons();
  }

  // ---------------------------------------------------- LEADERSHIP OVERVIEW
  function leadership() {
    // All-Stars: custom-range-only tab. It's in OWN_DATE_CONTROL, so the global
    // quick-period chips are suppressed and this tab's own From/To picker is the
    // sole control. With a range set, agent-derived numbers re-scope via
    // the period-only sections (revenue, pace, trends, campaigns, historical)
    // are hidden — they have no meaning for an arbitrary span.
    const leadRange = (leadDateFrom && leadDateTo) ? { from: leadDateFrom, to: leadDateTo } : null;
    const rangedList = leadRange ? Q.agentsForRange(leadRange.from, leadRange.to) : null;
    const leadMeta = rangedList && rangedList._range;
    const agents = rangedList || Q.agentsFor(period);
    const t = rangedList ? _totalsFromList(rangedList) : Q.totalsFor(period);
    const d = rangedList ? { calls: null, success: null } : Q.DELTAS[period];

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
    const flags = redFlags(agents, Q.DELTAS[period], rmT, fcT, { includeSchedule: false, includeInactive: false });

    // Progress vs last period — beat your previous week / month rather
    // than a stale hard-coded floor target.
    const prev = Q.prevTotalsFor(period);
    const tgtCalls = prev.calls;
    const tgtLeads = prev.leads;
    const progress = (cur, tgt) => tgt > 0 ? Math.min(100, (cur / tgt) * 100) : 0;
    const tgtClass = pct => pct >= 95 ? 'ok' : pct >= 75 ? 'warn' : 'bad';

    const top5 = agents.slice().sort((a, b) => (b.success * b.calls) - (a.success * a.calls)).slice(0, 5);

    const kpi = (icon, label, val, delta, foot, kind, sparkSeries) => {
      const cls = delta == null ? 'flat' : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
      const ic = delta == null ? '' : delta > 0 ? I.up : delta < 0 ? I.down : '';
      let dtxt = '';
      if (delta != null) {
        if (delta === 0) dtxt = 'no change';
        else if (kind === 'pct')   dtxt = Math.abs(delta) + ' pts';
        else if (kind === 'count') dtxt = (delta > 0 ? '+' : '−') + Math.abs(delta);
        else                       dtxt = Math.abs(delta) + '%';
      }
      const spark = (sparkSeries && sparkSeries.length >= 2)
        ? `<div class="spark">${C.spark(sparkSeries.slice(-8))}</div>`
        : '';
      return `<div class="card kpi">
        <div class="kpi-top"><div class="kpi-ic">${icon}</div>
          ${delta != null ? `<span class="delta ${cls}">${ic}${dtxt}</span>` : ''}
        </div>
        <div class="kpi-label">${label}</div>
        <div class="kpi-val tnum">${val}</div>
        <div class="kpi-foot">${foot}</div>
        ${spark}
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
    // Stale = the underlying data isn't for this period yet (e.g. Monday
    // morning before the daily cron has imported this week's snapshot).
    // Hide pace bars in that case — projecting from last week's numbers
    // framed as "this week" misleads the COO into thinking targets are
    // already hit / missed.
    const showPace = elapsed.fraction > 0 && elapsed.fraction < 1 && !elapsed.stale;
    const tgtBar = (label, cur, tgt) => {
      if (!tgt) return '';
      if (elapsed.stale) {
        return `<div style="margin-top:14px">
          <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:6px">
            <span style="color:var(--ink);font-weight:600">${label}</span>
            <span class="tnum" style="color:var(--muted)">target ${fmt(tgt)}</span>
          </div>
          <div class="eff-track" style="position:relative;opacity:.4">
            <span style="width:0%;background:var(--muted)"></span>
          </div>
          <div style="font-size:11.5px;margin-top:5px;color:var(--muted);font-style:italic">Waiting for today's data import</div>
        </div>`;
      }
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
          <span>${elapsed.elapsed}/${elapsed.total} ${period === 'current-week' || period === 'this-week' ? 'working days' : 'days'} elapsed</span>
          <span>At pace: <b class="tnum" style="color:${projPct >= 95 ? 'var(--green)' : projPct >= 75 ? 'var(--amber)' : 'var(--red)'}">${fmt(projected)} (${projPct.toFixed(0)}%)</b></span>
        </div>` : ''}
      </div>`;
    };
    // Stale-data banner on this tab so the user knows what they're looking at.
    const staleBanner = elapsed.stale ? `
      <div class="construction-banner" role="status" aria-live="polite" style="background:var(--amber-tint);border-left-color:var(--amber)">
        <svg class="cb-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
        <div>
          <b>Waiting for this week's data</b> — the daily import hasn't run yet.
          You're currently seeing the most recent complete week (${escapeHtml(elapsed.staleReason || '')}).
          <div class="cb-sub">Pace bars and projections are hidden until the import lands.</div>
        </div>
      </div>` : '';

    const leadFoot = leadRange ? 'custom range · no prior baseline'
      : (period === 'current-week' ? 'vs same days last week'
        : ('vs previous ' + Q.PERIODS[period].label.toLowerCase()));
    const leadCaption = leadRange
      ? `<div class="range-caption">Custom range · covers <b>${(leadMeta && leadMeta.effectiveFrom) || leadRange.from}</b> → <b>${(leadMeta && leadMeta.effectiveTo) || leadRange.to}</b>${leadMeta && leadMeta.weeksIncluded === 0 ? ' · <span style="color:var(--red)">no complete Mon-Sun weeks in range</span>' : (leadMeta ? ` · ${leadMeta.weeksIncluded} complete week${leadMeta.weeksIncluded === 1 ? '' : 's'} · revenue, pace &amp; trend sections hidden for custom ranges` : '')}</div>`
      : '';
    const leadFilterBar = `
      <div class="card ov-filterbar" style="justify-content:flex-end">
        ${datePickerMarkup('lead', leadDateFrom, leadDateTo)}
      </div>
      ${leadCaption}`;

    return `
    <div class="tab-view">
      ${leadFilterBar}
      ${leadRange ? '' : staleBanner}
      <!-- Hero KPIs -->
      <div class="row kpis">
        ${kpi(I.phone,  'Total Calls',       fmt(t.calls),        d.calls,   leadFoot, 'pct-of-base', Q.WEEK_CALLS)}
        ${kpi(I.trophy, 'Success Rate',      t.avgSuccess + '%',  d.success, 'successes ÷ calls', 'pct', Q.WEEK_SUCCESS)}
        ${kpi(I.bolt,   'Team Efficiency',   eff + '%',           null,      'dialler ÷ clocked-in time')}
        ${leadRange
          ? kpi(I.users, 'Active Callers', t.active + '', null, 'RM + Fancy desks combined')
          : kpi(I.medal, 'Estimated revenue', 'R ' + fmt(Math.round(revenue)), null,
              fmt(sellerLeads) + ' seller · ' + fmt(rentalLeads) + ' rental — see model below')}
      </div>

      <div class="divider-note">Strategic snapshot</div>
      <!-- Team split + Target progress -->
      <div class="row ${leadRange ? '' : 'g-2-1'} mt">
        <div style="display:flex;flex-direction:column;gap:16px">
          <div class="card-head" style="padding:0">
            <div><h3 style="font-family:var(--serif);font-size:17px;color:var(--ink);margin:0">RM vs Fancy</h3>
              <div class="sub" style="font-size:12px">Side-by-side team performance</div></div>
          </div>
          ${teamCard(CFG.TEAM_LABELS?.RM    || 'Relationship Managers', rmT, '#3D5BA6')}
          ${teamCard(CFG.TEAM_LABELS?.Fancy || 'Fancy Callers',         fcT, '#B98A02')}
        </div>
        ${leadRange ? '' : `<div class="card card-pad">
          <div class="card-head" style="padding:0;border:0"><div>
            <h3 style="margin:0">Pace vs last period</h3>
            <div class="sub">${period === 'current-week' || period === 'this-week' || period === 'last-week' ? 'Beat last week’s totals' : 'Beat last month’s totals'} · auto-set from actuals</div>
          </div></div>
          ${tgtBar('Total calls', t.calls, tgtCalls)}
          ${tgtBar('Total leads',     t.leads, tgtLeads)}
          <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);line-height:1.7">
            Revenue estimate uses <b style="color:var(--ink)">R${fmt(rev.seller || rev.default)} seller / R${fmt(rev.rental || rev.default)} rental / R${fmt(rev.email || rev.default)} email</b>. Adjust in <code>quay/config.js</code> for accuracy.
          </div>
        </div>`}
      </div>

      ${leadRange ? '' : `<div class="divider-note">Performance trends</div>
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

      <div class="divider-note">Revenue model</div>
      <!-- Revenue model — per-campaign breakdown that drove the ceiling -->
      ${revenueModelCard(camps0, teamRateLookup, rev.default, rentalRate)}`}

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
      ${leadRange ? '' : historicalComparison(t)}
    </div>`;
  }

  function historicalComparison(t) {
    const avgCalls4   = Q.trailingAvg('calls',   4);
    const avgCalls12  = Q.trailingAvg('calls',  12);
    // Comparing seller-leads (t.leads) against the trailing average of
    // the same field — was using 'success' (any positive outcome — seller
    // + rental + email + others), which understated the trend when most
    // successes were non-seller leads.
    const avgLeads4   = Q.trailingAvg('leads', 4);
    const avgLeads12  = Q.trailingAvg('leads', 12);

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
        ${cmpCard('Leads vs 4-week avg',      t.leads, avgLeads4,  'Avg last 4 weeks')}
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
      // Only pull rows updated since 00:00 SAST today. The daemon
      // doesn't push rows for agents who haven't called yet on a
      // given day, so a row last updated yesterday at 17:00 SAST
      // (their final shift event) carries that staffer's full
      // yesterday total into today until they call again. Filtering
      // here guarantees the Live Floor only reflects calls placed
      // since the start of today SAST.
      const startOfTodaySAST = new Date(sastDateStr(new Date()) + 'T00:00:00+02:00').toISOString();
      const { data, error } = await window.sb
        .from('live_stats')
        .select('staff_id,name,calls,answered,leads,seller_leads,rental_leads,email_leads,work_hours,success_rate,updated_at')
        .gte('updated_at', startOfTodaySAST)
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
  // Staff-name → known Dialfire-side spellings. Bridges cases where a
  // staffer's Supabase name doesn't match Dialfire's prettified name
  // (spelling variants like Gomes vs Gomez, nicknames like Gio,
  // short-form last-names, or a test account tied to a real staffer).
  // Keys are lowercase; values are lowercase strings the Dialfire pipeline
  // may emit for that person. Mirror of quay/data.js
  // CLOCK_ALIAS_DIALFIRE_TO_CANONICAL — keep both in sync.
  const DIALFIRE_ALIASES = {
    'geneva gomez':               ['geneva gomes'],
    'geneva maggie-nela gomez':   ['geneva gomes'],
    'giovon van wyk':             ['gio'],
    'declan ryder tyler':         ['declan t'],
    'lauren stacey carolus':      ['lauren carolus'],
    'nicolette van der berg':     ['nicolette'],
    'jason hendricks':            ['test'],
  };

  // Return every lowercase key we should try when hunting for a Dialfire
  // row for this staff member: exact full name, first+last, and any
  // registered alias spellings.
  function dfKeysFor(name) {
    const raw = (name || '').trim();
    if (!raw) return [];
    const out = [];
    const push = (k) => { const v = (k || '').trim().toLowerCase(); if (v && !out.includes(v)) out.push(v); };
    push(raw);
    const parts = raw.split(/\s+/);
    if (parts.length >= 2) push(parts[0] + ' ' + parts[parts.length - 1]);
    (DIALFIRE_ALIASES[raw.toLowerCase()] || []).forEach(push);
    return out;
  }

  function liveStatsFor(name) {
    for (const k of dfKeysFor(name)) {
      const row = liveStatsByName.get(k);
      if (row) return row;
    }
    return null;
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

  // (Floor Health pill removed 2026-06-23 per user — kept only the small
  // red-flag count badge in the topbar on Overview. The wide pill was
  // duplicating that signal under the page title.)



  // The Live Floor view: one card per agent currently clocked in (or out
  // today), driven by schedule.byStaff (loaded from Supabase events) and
  // enriched with today's Dialfire call/lead counts when available.
  // ─── LN Leaderboard ───────────────────────────────────────────────
  // A dedicated tab for Lead Nurturer + Assistant performance based on
  // end-of-day clock_out_reports submissions. Period filter scopes the
  // active range; per-LN derived metrics make it a triage tool, not
  // just a submissions log.
  let _lnSortBy  = 'totalLeads';
  let _lnSortDir = 'desc';
  let _lnRoleFilter = 'all';        // all | ln | assistant
  let _lnDivisionsPicked = new Set(); // multi-select — empty = all teams
  let _lnDivisionFilterQ = '';        // search box inside the team picker
  let _lnDivisionPickerOpen = false;  // dropdown state
  let _lnDocClickHandler = null;      // module-scoped so re-wires can detach
  let _lnExpandedRow = null;        // staff_id of the row whose notes drawer is open
  let _lnDateFrom = null;           // 'YYYY-MM-DD' SAST when admin overrides the global period
  let _lnDateTo   = null;           // 'YYYY-MM-DD' SAST

  // Canonical team roster — loaded from Supabase public.ln_teams by
  // data.js at boot (see quay/data.js loadLnTeams + the static fallback
  // there). Source of truth mirrors the clock-in EOD form so the LN Stats
  // team filter offers the exact same picks as clock-in. Admin-managed
  // via the ln_teams table; this reference is stable for the tab's life.
  const LN_TEAMS_ALL = Q.LN_TEAMS_ALL;
  // Archived teams (ln_teams.active = false) are hidden from managers but
  // remain editable by superusers, who get them appended to every team
  // picker via lnTeamUniverse(). _isArchivedTeam drives the "· archived" tag.
  const LN_TEAMS_ARCHIVED = Q.LN_TEAMS_ARCHIVED || [];
  const _archivedTeamSet = new Set(LN_TEAMS_ARCHIVED.map(t => String(t).toLowerCase()));
  function lnTeamUniverse() {
    return (session && session.super) ? LN_TEAMS_ALL.concat(LN_TEAMS_ARCHIVED) : LN_TEAMS_ALL.slice();
  }
  function _isArchivedTeam(name) {
    return _archivedTeamSet.has(String(name || '').toLowerCase());
  }
  function _archTag(name) {
    return _isArchivedTeam(name)
      ? ' <span class="muted" style="font-size:10px;font-weight:600">· archived</span>'
      : '';
  }

  function _lnPeriodRange() {
    // Map the global `period` to a [from, to] SAST date range — unless
    // the LN tab's custom-range picker has overridden it, in which case
    // those dates win.
    const now = new Date();
    const todaySast = sastDateStr(now);
    const startOfDay = (s) => new Date(s + 'T00:00:00+02:00');
    const endOfDay   = (s) => new Date(s + 'T23:59:59+02:00');
    const sastMonday = (d) => {
      const x = new Date(d.toLocaleString('en-US', { timeZone: 'Africa/Johannesburg' }));
      const dow = (x.getDay() + 6) % 7;
      x.setDate(x.getDate() - dow);
      return sastDateStr(x);
    };
    if (_lnDateFrom && _lnDateTo) {
      const [a, b] = _lnDateFrom <= _lnDateTo ? [_lnDateFrom, _lnDateTo] : [_lnDateTo, _lnDateFrom];
      return { from: startOfDay(a), to: endOfDay(b), fromKey: a, toKey: b, custom: true };
    }
    let fromKey, toKey;
    // Keys mirror the header chips: current-week (and its this-week alias) =
    // the live in-progress week (Mon→today); last-week = the last completed
    // full calendar week.
    if (period === 'current-week' || period === 'this-week') { fromKey = sastMonday(now); toKey = todaySast; }
    else if (period === 'last-week') { const d = new Date(now); d.setDate(d.getDate() - 7); fromKey = sastMonday(d); const e = new Date(fromKey + 'T00:00:00+02:00'); e.setDate(e.getDate() + 6); toKey = sastDateStr(e); }
    else if (period === 'this-month'){ const d = new Date(now); fromKey = sastDateStr(new Date(d.getFullYear(), d.getMonth(), 1));  toKey = todaySast; }
    else if (period === 'last-month'){ const d = new Date(now); d.setMonth(d.getMonth() - 1); fromKey = sastDateStr(new Date(d.getFullYear(), d.getMonth(), 1)); toKey = sastDateStr(new Date(d.getFullYear(), d.getMonth() + 1, 0)); }
    else if (period === 'billing-period') { const w = Q.billingPeriodWindow(); fromKey = w.fromYmd; toKey = w.toYmd; }
    else if (period === 'last-90')    { fromKey = sastDateStr(new Date(Date.now() - 90 * 86400e3)); toKey = todaySast; }
    else if (period === 'all-time')   { fromKey = '2020-01-01'; toKey = todaySast; }   // spans all held history
    else                              { fromKey = sastDateStr(new Date(Date.now() - 30 * 86400e3)); toKey = todaySast; }
    return { from: startOfDay(fromKey), to: endOfDay(toKey), fromKey, toKey, custom: false };
  }

  function _lnAggregate(reports, range) {
    // Group by staff_id over `range`; return [{staffId, name, designation, ...derived}].
    const inRange = (reports || []).filter(r => {
      const t = r.clocked_out_at ? new Date(r.clocked_out_at) : null;
      return t && t >= range.from && t <= range.to;
    });
    const by = new Map();
    inRange.forEach(r => {
      const k = r.staff_id;
      if (!by.has(k)) by.set(k, {
        staffId: k,
        name: (r.staff && r.staff.name) || _staffNamesById.get(k) || k,
        designation: r.designation || '',
        divisions: new Set(),
        reports: 0,
        hsTasks: 0, hsCalls: 0, hsEmails: 0, hsWas: 0, hsAnswered: 0, hsLeads: 0, hsRecon: 0,
        dfCalls: 0, dfEmails: 0, dfLeads: 0, dfHours: 0,
        waSent: 0, waResp: 0, waLeads: 0,
        byDay: new Map(),  // dayKey -> daily touch count (for sparkline)
        lastSubmit: null,
      });
      const t = by.get(k);
      if (r.division) t.divisions.add(r.division);
      t.reports    += 1;
      t.hsTasks    += r.hs_tasks_completed   || 0;
      t.hsCalls    += r.hs_calls_made        || 0;
      t.hsEmails   += r.hs_emails_sent       || 0;
      t.hsWas      += r.hs_whatsapps_sent    || 0;
      t.hsAnswered += r.hs_answered_contacts || 0;
      t.hsLeads    += r.hs_leads_vals        || 0;
      t.hsRecon    += r.hs_reconverted_leads || 0;
      t.dfCalls    += r.df_calls             || 0;
      t.dfEmails   += r.df_email_successes   || 0;
      t.dfLeads    += r.df_leads_vals        || 0;
      t.dfHours    += Number(r.df_hours      || 0);
      t.waSent     += r.wa_sent              || 0;
      t.waResp     += r.wa_responses         || 0;
      t.waLeads    += r.wa_leads_vals        || 0;
      const ts = r.clocked_out_at ? new Date(r.clocked_out_at) : null;
      if (ts) {
        const day = sastDateStr(ts);
        const touches = (r.hs_calls_made || 0) + (r.df_calls || 0) + (r.hs_emails_sent || 0) + (r.df_email_successes || 0) + (r.hs_whatsapps_sent || 0) + (r.wa_sent || 0);
        t.byDay.set(day, (t.byDay.get(day) || 0) + touches);
        if (!t.lastSubmit || ts > t.lastSubmit) t.lastSubmit = ts;
      }
    });
    return Array.from(by.values());
  }

  function _lnSparkSvg(byDay, range) {
    // Build a 14-day series ending at range.to; one bar per day.
    const days = [];
    const cur = new Date(range.to);
    for (let i = 13; i >= 0; i--) {
      const d = new Date(cur); d.setDate(d.getDate() - i);
      const key = sastDateStr(d);
      days.push({ key, v: byDay.get(key) || 0 });
    }
    const max = Math.max(1, ...days.map(d => d.v));
    const W = 84, H = 22, bw = (W / days.length) - 1;
    const bars = days.map((d, i) => {
      const h = Math.max(1, (d.v / max) * H);
      const x = i * (bw + 1);
      const y = H - h;
      const isToday = d.key === sastDateStr(new Date());
      const fill = d.v === 0 ? '#E0E7F1' : (isToday ? 'var(--yellow)' : 'var(--blue-800)');
      return `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="${fill}" rx="1"/>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-label="14-day touches">${bars}</svg>`;
  }

  function _lnDayKeysInRange(range) {
    const days = [];
    let d = new Date(range.from);
    while (d <= range.to) {
      const dow = new Date(d.toLocaleString('en-US', { timeZone: 'Africa/Johannesburg' })).getDay();
      // Working days only: Mon-Fri SAST.
      if (dow !== 0 && dow !== 6) days.push(sastDateStr(d));
      d.setDate(d.getDate() + 1);
    }
    return days;
  }

  function renderLnLeaderboard() {
    if (_reports == null && !_reportsLoading) {
      loadReports().then(() => { if (tab === 'ln') shell(); });
    }
    if (_reports == null) {
      return `<div class="tab-view"><div class="card card-pad" style="text-align:center;color:var(--muted);padding:60px 20px">Loading end-of-day reports…</div></div>`;
    }
    const range = _lnPeriodRange();
    // Unfiltered baseline (everyone in role + period). Used to compute chip
    // counts and division dropdown options so they stay stable as filters
    // narrow the visible roster.
    const allLns = _lnAggregate(_reports, range)
      .filter(r => {
        const d = (r.designation || '').toLowerCase();
        return d === 'ln' || d === 'assistant';
      });
    const roleOf = (r) => (r.designation || '').toLowerCase();
    const lns = allLns.filter(r => {
      if (_lnRoleFilter === 'ln' && roleOf(r) !== 'ln') return false;
      if (_lnRoleFilter === 'assistant' && roleOf(r) !== 'assistant') return false;
      if (_lnDivisionsPicked.size > 0) {
        // Multi-select: keep the row if ANY of its divisions is picked
        // (union). Empty pick = no filter.
        const divs = Array.from(r.divisions || []);
        if (!divs.some(d => _lnDivisionsPicked.has(d))) return false;
      }
      return true;
    });

    // Notes per staff (most recent in range — shown truncated in table).
    const notesByStaff = new Map();
    (_reports || []).forEach(r => {
      const ts = r.clocked_out_at ? new Date(r.clocked_out_at) : null;
      if (!ts || ts < range.from || ts > range.to) return;
      const txt = (r.notes || '').trim();
      if (!txt) return;
      const prev = notesByStaff.get(r.staff_id);
      if (!prev || ts > prev.ts) notesByStaff.set(r.staff_id, { ts, txt });
    });

    // Compliance — submissions / expected Mon-Fri days in range.
    const expectedDays = _lnDayKeysInRange(range).length || 1;
    lns.forEach(r => {
      const submittedDays = new Set();
      (_reports || []).forEach(rep => {
        if (rep.staff_id !== r.staffId) return;
        const ts = rep.clocked_out_at ? new Date(rep.clocked_out_at) : null;
        if (ts && ts >= range.from && ts <= range.to) submittedDays.add(sastDateStr(ts));
      });
      r.compliance = submittedDays.size / expectedDays;
      r.totalLeads = r.hsLeads + r.dfLeads + r.waLeads;
      r.totalCalls = r.hsCalls + r.dfCalls;
      r.note = (notesByStaff.get(r.staffId) || {}).txt || '';
    });

    // Sort
    const sortDir = _lnSortDir === 'asc' ? 1 : -1;
    lns.sort((a, b) => {
      const av = a[_lnSortBy], bv = b[_lnSortBy];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return sortDir * av.localeCompare(bv, undefined, { sensitivity: 'base' });
      return sortDir * (av - bv);
    });

    // KPI band
    const totalReports = lns.reduce((s, r) => s + r.reports, 0);
    const totalLeads   = lns.reduce((s, r) => s + r.totalLeads, 0);
    const totalHrs     = lns.reduce((s, r) => s + r.dfHours, 0);
    const topByLeads   = lns.slice().sort((a, b) => b.totalLeads - a.totalLeads)[0] || null;

    const kpi = (icon, label, val, foot) => `<div class="card kpi">
      <div class="kpi-top"><div class="kpi-ic">${icon}</div></div>
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-val tnum">${val}</div>
      <div class="kpi-foot">${escapeHtml(foot)}</div>
    </div>`;

    const fmtPct = (v) => v == null ? '—' : (Number(v) * 100).toFixed(0) + '%';
    // Format Dialfire hours as H:MM (matches the EOD form's "3:22" style).
    const fmtHrs = (h) => {
      if (!h || h <= 0) return '—';
      const tot = Math.round(h * 60);
      return Math.floor(tot / 60) + ':' + String(tot % 60).padStart(2, '0');
    };
    // Numeric cell with a muted '—' when zero (so the eye lands on real values).
    // Optional `extra` class tags the cell with its section
    // (.ln-col-hs / -df / -wa, plus -first on the leftmost of each section).
    // Optional `label` populates data-label, used by the mobile stacked layout
    // (≤640px) to render the cell as "Label · value".
    const numCell = (v, extra, label) => `<td class="num tnum${extra ? ' ' + extra : ''}"${label ? ` data-label="${escapeHtml(label)}"` : ''}>${v ? fmt(v) : '<span class="muted">—</span>'}</td>`;

    const sortIndic = (k) => {
      if (k !== _lnSortBy) return '<span class="muted" style="font-size:11px"> ⇅</span>';
      return _lnSortDir === 'asc'
        ? '<span style="color:var(--blue-800);font-size:11px"> ▲</span>'
        : '<span style="color:var(--blue-800);font-size:11px"> ▼</span>';
    };
    const sortHdr = (k, label, opts) => {
      const align = (opts && opts.align) || 'right';
      const cls = align === 'right' ? 'num' : '';
      const extra = (opts && opts.cls) || '';
      const tip = (opts && opts.tip) || '';
      return `<th class="${cls}${extra ? ' ' + extra : ''}" style="cursor:pointer" data-ln-sort="${k}" ${tip ? `title="${escapeHtml(tip)}"` : ''}>${escapeHtml(label)}${sortIndic(k)}</th>`;
    };

    // Filter row counts + division options use the unfiltered baseline.
    const lnCount     = allLns.filter(r => roleOf(r) === 'ln').length;
    const assistCount = allLns.filter(r => roleOf(r) === 'assistant').length;
    // Team list = canonical clock-in roster PLUS any historical divisions
    // seen in reports (in case a team was renamed or archived after data
    // landed). Union, then sort.
    const divisionSet = new Set(lnTeamUniverse());
    allLns.forEach(r => (r.divisions || new Set()).forEach(d => d && divisionSet.add(d)));
    const divisionList = Array.from(divisionSet).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const roleChip = (k, label, count) =>
      `<button class="chip${_lnRoleFilter === k ? ' active' : ''}" data-ln-role="${k}" type="button" aria-pressed="${_lnRoleFilter === k}">${escapeHtml(label)}<span class="chip-count tnum">${count}</span></button>`;

    // Multi-select team picker — mirrors the clock-in EOD form's chip style.
    const q = (_lnDivisionFilterQ || '').trim().toLowerCase();
    const filteredTeams = q
      ? divisionList.filter(t => t.toLowerCase().includes(q))
      : divisionList;
    const pickedCount = _lnDivisionsPicked.size;
    const pickerSummary = pickedCount === 0
      ? 'All teams'
      : pickedCount === 1
        ? Array.from(_lnDivisionsPicked)[0]
        : `${pickedCount} teams`;
    const selectedChips = pickedCount
      ? Array.from(_lnDivisionsPicked).sort().map(t =>
          `<button type="button" class="ln-team-chip on" data-ln-team-remove="${escapeHtml(t)}" title="Remove ${escapeHtml(t)}">${escapeHtml(t)}<span aria-hidden="true"> ×</span></button>`).join('')
      : '';
    const pickerPanel = _lnDivisionPickerOpen ? `
      <div class="ln-team-picker" role="dialog" aria-label="Pick teams">
        <div class="ln-team-picker-head">
          <input id="lnTeamSearch" type="search" placeholder="Search teams…"
                 value="${escapeHtml(_lnDivisionFilterQ || '')}" autocomplete="off">
          <button type="button" id="lnTeamClear" class="btn" style="padding:5px 10px;font-size:12px"${pickedCount ? '' : ' disabled'}>Clear</button>
        </div>
        <div class="ln-team-picker-grid">
          ${filteredTeams.length === 0
            ? '<div class="muted" style="grid-column:1/-1;padding:8px;font-size:12.5px">No teams match</div>'
            : filteredTeams.map(t =>
                `<button type="button" class="ln-team-chip ${_lnDivisionsPicked.has(t) ? 'on' : ''}" data-ln-team-toggle="${escapeHtml(t)}">${escapeHtml(t)}${_archTag(t)}${_lnDivisionsPicked.has(t) ? ' ✓' : ''}</button>`).join('')}
        </div>
      </div>` : '';

    return `<div class="tab-view">
      <div class="card card-pad">
        <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between">
          <div>
            <h3 style="margin:0;font-family:var(--serif);font-size:17px">LN &amp; Assistants Leaderboard</h3>
            <div class="sub" style="margin-top:4px">${lns.length} ${lns.length === 1 ? 'person' : 'people'} reporting · ${range.fromKey} → ${range.toKey} SAST${range.custom ? ' · <b>custom range</b>' : ''} · raw fields from each end-of-day submission</div>
          </div>
          ${datePickerMarkup('ln', _lnDateFrom, _lnDateTo)}
        </div>
      </div>

      <div class="row kpis mt">
        ${kpi(I.target, 'Total Leads',         fmt(totalLeads),                'all channels combined')}
        ${kpi(I.phone,  'EOD Submissions',     fmt(totalReports),              'across ' + lns.length + ' staff this period')}
        ${kpi(I.clock,  'Dialler Hours',       fmtHrs(totalHrs),               'logged on EOD forms')}
        ${kpi(I.trophy, 'Top by Leads',        topByLeads ? fmt(topByLeads.totalLeads) : '—', topByLeads ? topByLeads.name : '—')}
      </div>

      <div class="card mt">
        <div class="ln-filters">
          <div class="chips" role="group" aria-label="Filter by role">
            ${roleChip('all', 'All roles', lnCount + assistCount)}
            ${roleChip('ln', 'Nurturers', lnCount)}
            ${roleChip('assistant', 'Assistants', assistCount)}
          </div>
          <div class="ln-div-wrap" style="position:relative">
            <label class="muted" style="font-size:12px">Teams</label>
            <button type="button" id="lnDivToggle" class="ln-div-select"
                    aria-haspopup="listbox" aria-expanded="${_lnDivisionPickerOpen}"
                    style="text-align:left;cursor:pointer;padding-right:26px;position:relative">
              ${escapeHtml(pickerSummary)}
              <span aria-hidden="true" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);color:var(--muted)">${_lnDivisionPickerOpen ? '▴' : '▾'}</span>
            </button>
            ${pickerPanel}
          </div>
        </div>
        ${pickedCount ? `<div class="ln-team-selected" style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${selectedChips}</div>` : ''}
        <div class="tbl-wrap"><table class="tbl tbl-sortable ln-leaderboard">
          <thead>
            <tr class="ln-grouphdr">
              <th rowspan="2" class="ln-col-name" style="vertical-align:bottom;text-align:left;cursor:pointer" data-ln-sort="name">Name${sortIndic('name')}</th>
              <th rowspan="2" style="vertical-align:bottom">Role</th>
              <th rowspan="2" style="vertical-align:bottom">Division</th>
              <th colspan="7" class="ln-group ln-col-hs ln-col-first">HubSpot Work Summary</th>
              <th colspan="4" class="ln-group ln-col-df ln-col-first">DialFire Canvassing</th>
              <th colspan="3" class="ln-group ln-col-wa ln-col-first">WhatsApp Campaigns</th>
              <th rowspan="2" class="num" style="vertical-align:bottom;cursor:pointer" data-ln-sort="compliance" title="Submitted EOD reports ÷ expected Mon-Fri working days">Compliance${sortIndic('compliance')}</th>
              <th rowspan="2" style="vertical-align:bottom">Last 14d</th>
              <th rowspan="2" style="vertical-align:bottom">Notes</th>
            </tr>
            <tr class="ln-subhdr">
              ${sortHdr('hsTasks',   'Tasks',      { tip: 'HubSpot tasks completed',       cls: 'ln-col-hs ln-col-first' })}
              ${sortHdr('hsCalls',   'Calls',      { tip: 'HubSpot calls made',            cls: 'ln-col-hs' })}
              ${sortHdr('hsEmails',  'Emails',     { tip: 'HubSpot emails sent',           cls: 'ln-col-hs' })}
              ${sortHdr('hsWas',     'WAs',        { tip: 'HubSpot WhatsApps sent',        cls: 'ln-col-hs' })}
              ${sortHdr('hsAnswered','Answered',   { tip: 'HubSpot answered contacts',     cls: 'ln-col-hs' })}
              ${sortHdr('hsLeads',   'Leads',      { tip: 'HubSpot leads / vals',          cls: 'ln-col-hs' })}
              ${sortHdr('hsRecon',   'Reconv.',    { tip: 'HubSpot reconverted leads',     cls: 'ln-col-hs' })}
              ${sortHdr('dfCalls',   'Calls',      { tip: 'Dialfire calls',                cls: 'ln-col-df ln-col-first' })}
              ${sortHdr('dfEmails',  'Email Suc.', { tip: 'Dialfire email successes',      cls: 'ln-col-df' })}
              ${sortHdr('dfLeads',   'Leads',      { tip: 'Dialfire leads / vals',         cls: 'ln-col-df' })}
              ${sortHdr('dfHours',   'Hours',      { tip: 'Dialfire hours',                cls: 'ln-col-df' })}
              ${sortHdr('waSent',    'Sent',       { tip: 'WhatsApp campaign messages sent', cls: 'ln-col-wa ln-col-first' })}
              ${sortHdr('waResp',    'Resp.',      { tip: 'WhatsApp responses',            cls: 'ln-col-wa' })}
              ${sortHdr('waLeads',   'Leads',      { tip: 'WhatsApp leads / vals',         cls: 'ln-col-wa' })}
            </tr>
          </thead>
          <tbody>
            ${lns.length === 0
              ? `<tr><td colspan="20" class="muted" style="text-align:center;padding:30px">No LN / Assistant submissions in this period.</td></tr>`
              : lns.map(r => {
                const role = (r.designation || '').toLowerCase() === 'ln' ? 'LN' : 'Assistant';
                const cls = (r.designation || '').toLowerCase() === 'ln' ? 'rm' : 'fancy';
                const note = r.note || '';
                const noteShort = note.length > 60 ? note.slice(0, 60) + '…' : note;
                const hasNote = !!note;
                const isExpanded = hasNote && _lnExpandedRow === r.staffId;
                const rowAttrs = hasNote
                  ? ` class="has-note${isExpanded ? ' expanded' : ''}" data-ln-row="${escapeHtml(String(r.staffId))}" tabindex="0" role="button" aria-expanded="${isExpanded}"`
                  : '';
                const chev = hasNote ? `<span class="ln-notes-chev" aria-hidden="true">${isExpanded ? '▴' : '▾'}</span>` : '';
                const drawer = isExpanded
                  ? `<tr class="ln-drawer"><td colspan="20"><div class="ln-drawer-inner"><div class="ln-drawer-label">${escapeHtml(r.name)} — notes</div><div class="ln-drawer-note">${escapeHtml(note)}</div></div></td></tr>`
                  : '';
                return `<tr${rowAttrs}>
                  <td class="ln-col-name" data-label="Name"><b>${escapeHtml(r.name)}</b></td>
                  <td data-label="Role"><span class="pill ${cls}" style="font-size:10.5px;padding:2px 8px">${role}</span></td>
                  <td class="muted" style="font-size:12px" data-label="Division">${escapeHtml(Array.from(r.divisions).join(' / ') || '—')}</td>
                  ${numCell(r.hsTasks,         'ln-col-hs ln-col-first', 'HS · Tasks')}
                  ${numCell(r.hsCalls,         'ln-col-hs',              'HS · Calls')}
                  ${numCell(r.hsEmails,        'ln-col-hs',              'HS · Emails')}
                  ${numCell(r.hsWas,           'ln-col-hs',              'HS · WAs')}
                  ${numCell(r.hsAnswered || 0, 'ln-col-hs',              'HS · Answered')}
                  ${numCell(r.hsLeads,         'ln-col-hs',              'HS · Leads')}
                  ${numCell(r.hsRecon || 0,    'ln-col-hs',              'HS · Reconv.')}
                  ${numCell(r.dfCalls,         'ln-col-df ln-col-first', 'DF · Calls')}
                  ${numCell(r.dfEmails,        'ln-col-df',              'DF · Email Suc.')}
                  ${numCell(r.dfLeads,         'ln-col-df',              'DF · Leads')}
                  <td class="num tnum ln-col-df" data-label="DF · Hours">${fmtHrs(r.dfHours)}</td>
                  ${numCell(r.waSent,          'ln-col-wa ln-col-first', 'WA · Sent')}
                  ${numCell(r.waResp || 0,     'ln-col-wa',              'WA · Resp.')}
                  ${numCell(r.waLeads,         'ln-col-wa',              'WA · Leads')}
                  <td class="num" data-label="Compliance"><span class="pill ${r.compliance >= 0.9 ? 'ok' : r.compliance >= 0.6 ? 'warn' : 'bad'}" style="font-size:11px;padding:2px 8px">${fmtPct(r.compliance)}</span></td>
                  <td data-label="Last 14d">${_lnSparkSvg(r.byDay, range)}</td>
                  <td class="muted" style="font-size:12px;max-width:240px" data-label="Notes">${escapeHtml(noteShort) || '<span class="muted">—</span>'}${chev}</td>
                </tr>${drawer}`;
              }).join('')}
          </tbody>
        </table></div>
      </div>
    </div>`;
  }

  function wireLnLeaderboard() {
    document.querySelectorAll('th[data-ln-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const k = th.dataset.lnSort;
        if (_lnSortBy === k) {
          _lnSortDir = _lnSortDir === 'asc' ? 'desc' : 'asc';
        } else {
          _lnSortBy = k;
          _lnSortDir = (k === 'name') ? 'asc' : 'desc';
        }
        shell();
      });
    });
    document.querySelectorAll('button[data-ln-role]').forEach(b => {
      b.addEventListener('click', () => {
        _lnRoleFilter = b.dataset.lnRole;
        shell();
      });
    });
    // Multi-select team picker
    const divToggle = document.getElementById('lnDivToggle');
    if (divToggle) divToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      _lnDivisionPickerOpen = !_lnDivisionPickerOpen;
      shell();
    });
    const divSearch = document.getElementById('lnTeamSearch');
    if (divSearch) {
      divSearch.addEventListener('input', (e) => {
        const caret = e.target.selectionStart;
        _lnDivisionFilterQ = e.target.value;
        shell();
        // Restore focus + caret on the fresh input (shell wipes DOM).
        const s2 = document.getElementById('lnTeamSearch');
        if (s2) { s2.focus(); try { s2.setSelectionRange(caret, caret); } catch (_) {} }
      });
      // Keep the picker open when interacting with the search.
      divSearch.addEventListener('click', (e) => e.stopPropagation());
    }
    document.querySelectorAll('[data-ln-team-toggle]').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = b.dataset.lnTeamToggle;
      if (_lnDivisionsPicked.has(t)) _lnDivisionsPicked.delete(t);
      else _lnDivisionsPicked.add(t);
      shell();
    }));
    document.querySelectorAll('[data-ln-team-remove]').forEach(b => b.addEventListener('click', () => {
      _lnDivisionsPicked.delete(b.dataset.lnTeamRemove);
      shell();
    }));
    const teamClear = document.getElementById('lnTeamClear');
    if (teamClear) teamClear.addEventListener('click', (e) => {
      e.stopPropagation();
      _lnDivisionsPicked.clear();
      _lnDivisionFilterQ = '';
      shell();
    });
    // Click outside the picker closes it. Audit finding E2 (P1):
    // wireLnLeaderboard runs on every shell() re-render, so if the picker
    // stays open while the user toggles chips the previous handler
    // never got removed — listeners stacked, each re-triggering shell()
    // when the user finally clicked outside. Use a module-scoped ref so
    // we can remove the OLD handler at the top of every wire pass.
    if (_lnDocClickHandler) {
      document.removeEventListener('click', _lnDocClickHandler);
      _lnDocClickHandler = null;
    }
    if (_lnDivisionPickerOpen) {
      _lnDocClickHandler = (ev) => {
        if (ev.target.closest('.ln-div-wrap')) return;
        _lnDivisionPickerOpen = false;
        document.removeEventListener('click', _lnDocClickHandler);
        _lnDocClickHandler = null;
        shell();
      };
      // Attach on next tick so this same click doesn't fire it immediately.
      setTimeout(() => {
        if (_lnDocClickHandler) document.addEventListener('click', _lnDocClickHandler);
      }, 0);
    }

    const toggleRow = (id) => {
      _lnExpandedRow = (_lnExpandedRow === id) ? null : id;
      shell();
    };
    document.querySelectorAll('tr[data-ln-row]').forEach(tr => {
      tr.addEventListener('click', () => toggleRow(tr.dataset.lnRow));
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleRow(tr.dataset.lnRow);
        }
      });
    });
    // Custom date-range picker. Both ends required before the override
    // kicks in — partial input keeps the global period in effect.
    // Shared date-picker wiring (preserves focus on the edited field).
    wireDatePicker('ln', (kind, value) => {
      if (kind === 'from') _lnDateFrom = value;
      else if (kind === 'to') _lnDateTo = value;
      else { _lnDateFrom = null; _lnDateTo = null; }
    });
  }

  // ─── Teams Reporting (superuser-only) ────────────────────────────
  // Multi-team picker → per-caller breakdown for anyone (regardless of home
  // team) who logged a call on any of the picked teams' campaigns during the
  // active period. Exportable as PDF (browser print) or PNG (html2canvas).
  //
  // Data source: window.QUAY.perAgentPerTeam(period) — uses week.by_agent_campaign
  // so agents on multi-team campaigns like BABES_CM/NA/NEW get correctly
  // attributed (this is how Staddy shows up when picking Babes).
  let _trTeamsPicked = new Set();     // Title-Case team names ('Babes', 'Amigos')
  let _trTeamFilterQ = '';
  let _trPickerOpen  = false;
  let _trDocClickHandler = null;
  let _trSortBy  = 'calls';
  let _trSortDir = 'desc';
  let _trDateFrom = null;             // 'YYYY-MM-DD' SAST — custom range overrides global period when both set
  let _trDateTo   = null;             // 'YYYY-MM-DD' SAST
  // Subscribers panel (Monday-morning email config). Rows come from
  // team_report_recipients — RLS gates read/write to supers only.
  let _trSubsOpen  = false;           // collapsible section toggle
  let _trSubs      = null;            // null = not loaded, [] = loaded
  let _trSubsLoading = false;
  let _trSubsError = '';
  let _trSubsEditing = null;          // id of the row being edited, or 'new' for the add-row
  let _trSubsDraft = null;            // { email, name, teams: Set, active, send_last_week, send_month_to_date }
  let _trSubsTeamPickerOpen = false;
  let _trSubsTeamFilterQ = '';
  // Fire-now button state. There is intentionally no auto-send toggle —
  // per user rule, every Monday-morning batch stays as drafts until Pagan
  // sends it manually. _trFireStatus is a transient banner
  // ('firing...' -> 'fired' -> '' via setTimeout) that acknowledges the
  // button press. _trFireLastAt is the ISO stamp we wrote last, used in
  // the tooltip.
  let _trFireStatus     = '';        // '', 'firing', 'fired', 'error'
  let _trFireError      = '';
  let _trFireLastAt     = null;      // ISO string, most recent successful fire

  // Map canonical team key → pretty Title-Case name. Seeded from LN_TEAMS_ALL
  // so 'BABES' / 'BAB_ES' / 'babes' all render as "Babes" instead of the
  // Dialfire-side upper-case raw name. Falls back to titleCase(underscores→spaces).
  function _trPrettifyTeam(raw, canonToPretty) {
    const key = Q.teamCanonical(raw);
    if (canonToPretty.has(key)) return canonToPretty.get(key);
    return String(raw || '').toLowerCase().replace(/_/g, ' ')
      .replace(/\b([a-z])/g, m => m.toUpperCase());
  }

  function _trHomeTeamForAgent(entry, pickedCanonSet, canonToPretty) {
    // Pick the team (among selected teams) where this agent made the most
    // calls in the active period. If pickedCanonSet is empty (== all teams),
    // pick the team with the most calls overall.
    let best = null;
    entry.byTeam.forEach((s, key) => {
      if (pickedCanonSet.size && !pickedCanonSet.has(key)) return;
      if (!best || s.calls > best.calls) best = s;
    });
    return best ? _trPrettifyTeam(best.team, canonToPretty) : '—';
  }


  async function _trFireNow() {
    // Write a fresh ISO timestamp to weekly_email_fire_request. The Mac's
    // launchd fire-watcher polls this row every 2 min and, on a change,
    // runs the emailer as a draft-mode job. Debounce via _trFireStatus so
    // impatient double-clicks don't queue two fires.
    if (_trFireStatus === 'firing') return;
    _trFireStatus = 'firing'; _trFireError = ''; shell();
    const stamp = new Date().toISOString();
    try {
      const { error } = await window.sb.from('app_settings')
        .upsert({ key: 'weekly_email_fire_request', value: stamp },
                { onConflict: 'key' });
      if (error) throw error;
      _trFireStatus = 'fired'; _trFireLastAt = stamp;
    } catch (e) {
      _trFireStatus = 'error';
      _trFireError = String(e.message || e);
    }
    shell();
    // Auto-clear the banner after ~6s so the button returns to its resting
    // state. `firing` never times out on its own — only success/error do.
    setTimeout(() => {
      if (_trFireStatus === 'fired' || _trFireStatus === 'error') {
        _trFireStatus = ''; shell();
      }
    }, 6000);
  }

  async function _trLoadSubs() {
    if (_trSubsLoading) return;
    _trSubsLoading = true; _trSubsError = '';
    try {
      const { data, error } = await window.sb.from('team_report_recipients')
        .select('id, email, name, teams, active, send_last_week, send_month_to_date, notes, updated_at')
        .order('email', { ascending: true });
      if (error) throw error;
      _trSubs = data || [];
    } catch (e) {
      _trSubsError = String(e.message || e);
      _trSubs = _trSubs || [];
    } finally {
      _trSubsLoading = false;
      if (tab === 'teams-report') shell();
    }
  }

  function _trSubsStartEdit(row) {
    _trSubsEditing = row ? row.id : 'new';
    _trSubsDraft = {
      email: row ? row.email : '',
      name: row ? (row.name || '') : '',
      teams: new Set(row ? (row.teams || []) : []),
      active: row ? !!row.active : true,
      send_last_week: row ? !!row.send_last_week : true,
      send_month_to_date: row ? !!row.send_month_to_date : false,
      notes: row ? (row.notes || '') : '',
    };
    _trSubsTeamPickerOpen = false;
    _trSubsTeamFilterQ = '';
  }

  function _trSubsCancelEdit() {
    _trSubsEditing = null; _trSubsDraft = null;
    _trSubsTeamPickerOpen = false; _trSubsTeamFilterQ = '';
  }

  async function _trSubsSave() {
    if (!_trSubsDraft) return;
    const payload = {
      email: String(_trSubsDraft.email || '').trim().toLowerCase(),
      name: (_trSubsDraft.name || '').trim() || null,
      teams: Array.from(_trSubsDraft.teams).sort(),
      active: !!_trSubsDraft.active,
      send_last_week: !!_trSubsDraft.send_last_week,
      send_month_to_date: !!_trSubsDraft.send_month_to_date,
      notes: (_trSubsDraft.notes || '').trim() || null,
    };
    if (!payload.email || !/.+@.+\..+/.test(payload.email)) {
      _trSubsError = 'Enter a valid email address before saving.';
      shell();
      return;
    }
    if (payload.teams.length === 0) {
      _trSubsError = 'Pick at least one team before saving.';
      shell();
      return;
    }
    _trSubsError = '';
    try {
      if (_trSubsEditing === 'new') {
        const { error } = await window.sb.from('team_report_recipients').insert(payload);
        if (error) throw error;
      } else {
        const { error } = await window.sb.from('team_report_recipients')
          .update(payload).eq('id', _trSubsEditing);
        if (error) throw error;
      }
      _trSubsCancelEdit();
      await _trLoadSubs();
    } catch (e) {
      _trSubsError = String(e.message || e);
      shell();
    }
  }

  async function _trSubsRemove(id) {
    // Row delete — irreversible, so confirm through the browser dialog.
    // Kept as native confirm() to match the pattern used elsewhere for
    // admin-level destructive actions.
    if (!confirm('Remove this subscriber? They will no longer receive the Monday email.')) return;
    try {
      const { error } = await window.sb.from('team_report_recipients').delete().eq('id', id);
      if (error) throw error;
      await _trLoadSubs();
    } catch (e) {
      _trSubsError = String(e.message || e);
      shell();
    }
  }

  function _trSubsEditRowHtml(draft, isNew) {
    // Reuses the team roster for the multi-select. Superusers also get
    // archived teams (lnTeamUniverse) so they can still edit a subscriber's
    // teams even after a team has been retired.
    const q = (_trSubsTeamFilterQ || '').trim().toLowerCase();
    const _subsRoster = lnTeamUniverse();
    const teamRoster = q
      ? _subsRoster.filter(t => t.toLowerCase().includes(q))
      : _subsRoster;
    const pickedCount = draft.teams.size;
    const summary = pickedCount === 0 ? 'Pick teams…'
      : pickedCount === 1 ? Array.from(draft.teams)[0]
      : `${pickedCount} teams`;
    const picker = _trSubsTeamPickerOpen ? `
      <div class="tr-team-picker" role="dialog" aria-label="Pick teams">
        <div class="tr-team-picker-head">
          <input id="trSubsTeamSearch" type="search" placeholder="Search teams…"
                 value="${escapeHtml(_trSubsTeamFilterQ)}" autocomplete="off">
        </div>
        <div class="tr-team-picker-grid">
          ${teamRoster.map(t =>
            `<button type="button" class="tr-team-chip ${draft.teams.has(t) ? 'on' : ''}" data-trsubs-team-toggle="${escapeHtml(t)}">${escapeHtml(t)}${_archTag(t)}${draft.teams.has(t) ? ' ✓' : ''}</button>`).join('')}
        </div>
      </div>` : '';
    const chips = Array.from(draft.teams).sort().map(t =>
      `<span class="pill" style="font-size:11px;padding:2px 8px;background:var(--blue-800);color:#fff;">${escapeHtml(t)}</span>`).join(' ');
    return `<tr class="tr-subs-edit">
      <td colspan="5" style="padding:14px 16px;background:#F6F7FB;border-top:1px solid var(--line)">
        <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-bottom:10px">
          <div style="flex:1;min-width:200px">
            <label class="muted" for="trSubsEmail" style="font-size:11px;text-transform:uppercase;letter-spacing:.06em">Email</label>
            <input id="trSubsEmail" type="email" value="${escapeHtml(draft.email)}" ${isNew ? '' : 'readonly'} placeholder="name@quay1.co.za"
              style="width:100%;padding:7px 10px;border:1px solid var(--line);border-radius:8px;font-family:inherit;font-size:13px;${isNew ? '' : 'background:#EDEFF4'}">
          </div>
          <div style="flex:1;min-width:160px">
            <label class="muted" for="trSubsName" style="font-size:11px;text-transform:uppercase;letter-spacing:.06em">Name (optional)</label>
            <input id="trSubsName" type="text" value="${escapeHtml(draft.name)}" placeholder="Sheldon"
              style="width:100%;padding:7px 10px;border:1px solid var(--line);border-radius:8px;font-family:inherit;font-size:13px">
          </div>
          <div class="tr-div-wrap" style="position:relative;flex:1;min-width:200px">
            <label class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.06em">Teams</label>
            <button type="button" id="trSubsTeamToggle" class="ln-div-select"
              style="text-align:left;cursor:pointer;padding-right:26px;position:relative;width:100%">
              ${escapeHtml(summary)}
              <span aria-hidden="true" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);color:var(--muted)">${_trSubsTeamPickerOpen ? '▴' : '▾'}</span>
            </button>
            ${picker}
          </div>
        </div>
        ${chips ? `<div style="margin-bottom:10px;display:flex;flex-wrap:wrap;gap:6px">${chips}</div>` : ''}
        <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;font-size:12.5px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input id="trSubsActive" type="checkbox" ${draft.active ? 'checked' : ''}> Active
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input id="trSubsLastWeek" type="checkbox" ${draft.send_last_week ? 'checked' : ''}> Include last week
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input id="trSubsMtd" type="checkbox" ${draft.send_month_to_date ? 'checked' : ''}> Include month-to-date
          </label>
          <div style="margin-left:auto;display:flex;gap:8px">
            <button type="button" class="btn" id="trSubsCancel">Cancel</button>
            <button type="button" class="btn btn-primary" id="trSubsSave">${isNew ? 'Add subscriber' : 'Save changes'}</button>
          </div>
        </div>
        ${_trSubsError ? `<div style="margin-top:8px;color:#D20A03;font-size:12.5px">${escapeHtml(_trSubsError)}</div>` : ''}
      </td>
    </tr>`;
  }

  function _trSubscribersCard() {
    // Kick off the initial load once the tab opens (super-only, RLS gates
    // the query — non-supers wouldn't get here anyway). Also fetch the
    // auto-send flag so the toggle renders in the right position from
    // first paint.
    if (_trSubsOpen && _trSubs == null && !_trSubsLoading) {
      _trLoadSubs();
    }
    const chevron = _trSubsOpen ? '▴' : '▾';
    if (!_trSubsOpen) {
      return `<div class="card mt card-pad" style="cursor:pointer" id="trSubsToggle" role="button" tabindex="0" aria-expanded="false">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <h3 style="margin:0;font-family:var(--serif);font-size:15px">Email subscribers · weekly Monday-morning report</h3>
            <div class="sub" style="margin-top:2px">Who gets the auto-emailed team stats every Monday 08:00 SAST. Draft-only until you flip the send switch.</div>
          </div>
          <div class="muted" style="font-size:16px">${chevron}</div>
        </div>
      </div>`;
    }
    const rows = _trSubs || [];
    const editingNew = _trSubsEditing === 'new';
    const editingRow = _trSubsEditing && _trSubsEditing !== 'new' ? _trSubsEditing : null;
    const tableBody = rows.length === 0 && !editingNew
      ? `<tr><td colspan="5" class="muted" style="text-align:center;padding:22px">No subscribers yet — click <b>+ Add subscriber</b> to add one.</td></tr>`
      : rows.map(r => {
          if (editingRow === r.id && _trSubsDraft) {
            return _trSubsEditRowHtml(_trSubsDraft, false);
          }
          const chips = (r.teams || []).map(t =>
            `<span class="pill rm" style="font-size:10.5px;padding:2px 8px">${escapeHtml(t)}</span>`).join(' ');
          const cadence = [
            r.send_last_week ? 'last week' : null,
            r.send_month_to_date ? 'MTD' : null,
          ].filter(Boolean).join(' + ') || '—';
          return `<tr>
            <td data-label="Email"><b>${escapeHtml(r.email)}</b></td>
            <td data-label="Name">${escapeHtml(r.name || '—')}</td>
            <td data-label="Teams"><div style="display:flex;flex-wrap:wrap;gap:4px">${chips || '<span class="muted">—</span>'}</div></td>
            <td data-label="Cadence">${escapeHtml(cadence)}${r.active ? '' : ' <span class="pill bad" style="font-size:10.5px;padding:2px 8px">paused</span>'}</td>
            <td data-label="Actions" style="text-align:right;white-space:nowrap">
              <button class="btn" data-trsubs-edit="${r.id}" style="padding:4px 10px;font-size:12px">Edit</button>
              <button class="btn" data-trsubs-remove="${r.id}" style="padding:4px 10px;font-size:12px;color:#D20A03">Remove</button>
            </td>
          </tr>`;
        }).join('');
    const newRow = editingNew && _trSubsDraft ? _trSubsEditRowHtml(_trSubsDraft, true) : '';
    // Fire-now button banner text. `firing` shows a spinner-esque label so
    // the operator knows the click landed; `fired` / `error` are transient
    // (auto-cleared by setTimeout in _trFireNow).
    const fireBtnLabel = _trFireStatus === 'firing'
      ? 'Firing…'
      : _trFireStatus === 'fired'
        ? 'Fired ✓ (drafts arrive in ~2 min)'
        : _trFireStatus === 'error'
          ? 'Fire failed — retry?'
          : 'Fire now';
    const fireBtnDisabled = _trFireStatus === 'firing' ? 'disabled' : '';
    const fireBtnColor = _trFireStatus === 'error' ? 'color:#D20A03;' : '';
    // Auto-send toggle — a checkbox rather than a switch to match the rest
    // Draft-only. No auto-send toggle — Pagan reviews every batch before
    // sending manually from Gmail. See feedback_never_auto_send_emails.
    return `<div class="card mt">
      <div class="card-pad" style="cursor:pointer;padding-bottom:12px" id="trSubsToggle" role="button" tabindex="0" aria-expanded="true">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <h3 style="margin:0;font-family:var(--serif);font-size:15px">Email subscribers · weekly Monday-morning report</h3>
            <div class="sub" style="margin-top:2px">Who gets the auto-DRAFTED team stats every Monday 08:00 SAST. Drafts land in Pagan's Gmail; he sends them manually after eyeballing.</div>
          </div>
          <div class="muted" style="font-size:16px">${chevron}</div>
        </div>
      </div>
      <div style="padding:0 16px 10px;display:flex;justify-content:flex-end;align-items:center;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--line)">
        <button class="btn ${_trFireStatus === 'fired' ? 'btn-primary' : ''}" id="trFireNow"
          ${fireBtnDisabled}
          style="padding:6px 14px;font-size:12.5px;${fireBtnColor}"
          title="Trigger the emailer immediately to create drafts for every subscriber. Drafts appear in Gmail within ~2 minutes. Never sends.">
          ${escapeHtml(fireBtnLabel)}
        </button>
      </div>
      ${_trFireError ? `<div style="padding:6px 16px 0;color:#D20A03;font-size:12px">Fire-now write failed: ${escapeHtml(_trFireError)}</div>` : ''}
      <div style="padding:10px 16px 6px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div class="muted" style="font-size:12.5px">${_trSubsLoading ? 'Loading…' : (rows.length + ' subscriber' + (rows.length === 1 ? '' : 's'))}</div>
        <button class="btn btn-primary" id="trSubsAdd" ${editingNew ? 'disabled' : ''} style="padding:6px 14px;font-size:12.5px">+ Add subscriber</button>
      </div>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr>
          <th style="text-align:left">Email</th>
          <th style="text-align:left">Name</th>
          <th style="text-align:left">Teams</th>
          <th style="text-align:left">Cadence</th>
          <th style="text-align:right">Actions</th>
        </tr></thead>
        <tbody>${newRow}${tableBody}</tbody>
      </table></div>
    </div>`;
  }

  function renderTeamsReporting() {
    if (!session?.super) return `<div class="tab-view"><div class="card card-pad"><p class="muted">This tab is available to superusers only.</p></div></div>`;
    // Data source: custom range wins if both dates are set; otherwise the
    // global period button up in the topbar drives it.
    const usingCustomRange = !!(_trDateFrom && _trDateTo);
    let rangeLabel, rangeSuffix, rows, rangeMeta = null;
    if (usingCustomRange) {
      const [a, b] = _trDateFrom <= _trDateTo ? [_trDateFrom, _trDateTo] : [_trDateTo, _trDateFrom];
      rangeLabel = 'Custom range';
      rows = Q.perAgentPerTeamRange(a, b);
      rangeMeta = rows._range || null;
      // Suffix reflects the EFFECTIVE range (complete Mon-Sun weeks fully
      // inside what the user asked for). If nothing was included, be
      // explicit so the user doesn't think "0 callers" means "no work".
      if (rangeMeta && rangeMeta.weeksIncluded > 0) {
        rangeSuffix = ` · covers ${rangeMeta.effectiveFrom} → ${rangeMeta.effectiveTo}`
                    + ` · ${rangeMeta.weeksIncluded} complete week${rangeMeta.weeksIncluded === 1 ? '' : 's'}`;
      } else {
        rangeSuffix = ` · ${a} → ${b} · no complete Mon–Sun weeks in this range`;
      }
    } else {
      rangeLabel = (Q.PERIODS[period] || {}).label || period;
      rangeSuffix = periodRangeSuffix();
      rows = Q.perAgentPerTeam(period);
    }
    // Universe of teams: canonical LN_TEAMS_ALL (Title Case), plus any
    // observed team from the data that isn't already covered by canonical
    // form. Dedupe by teamCanonical so 'Babes' and 'BABES' don't both
    // appear in the picker.
    const canonToPretty = new Map();
    lnTeamUniverse().forEach(t => canonToPretty.set(Q.teamCanonical(t), t));
    const observedByCanon = new Map();
    rows.forEach(r => r.byTeam.forEach(s => {
      const k = Q.teamCanonical(s.team);
      if (!observedByCanon.has(k)) observedByCanon.set(k, s.team);
    }));
    observedByCanon.forEach((rawName, key) => {
      if (!canonToPretty.has(key)) canonToPretty.set(key, _trPrettifyTeam(rawName, canonToPretty));
    });
    const teamList = Array.from(canonToPretty.values())
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    const pickedCanon = new Set(Array.from(_trTeamsPicked).map(Q.teamCanonical));
    const pickedCount = _trTeamsPicked.size;

    // Filter agents: if teams picked, keep those with any calls in any picked team.
    // If no teams picked, show empty state — makes the picker feel purposeful.
    const filtered = pickedCount === 0
      ? []
      : rows.filter(r => {
          let has = false;
          r.byTeam.forEach((_v, key) => { if (pickedCanon.has(key)) has = true; });
          return has;
        }).map(r => {
          // Recompute the row totals scoped to picked teams so the numbers
          // shown reflect the callers' work FOR the selected teams — not
          // their global totals.
          let calls = 0, seller = 0, rental = 0, email = 0, workTime = 0, talkTime = 0;
          const perPicked = [];
          r.byTeam.forEach((s, key) => {
            if (!pickedCanon.has(key)) return;
            calls += s.calls; seller += s.seller; rental += s.rental; email += s.email;
            workTime += s.workTime; talkTime += s.talkTime;
            perPicked.push(s);
          });
          perPicked.sort((a, b) => b.calls - a.calls);
          const teamsWorked = perPicked.map(s => _trPrettifyTeam(s.team, canonToPretty)).join(', ');
          return {
            name: r.name,
            homeTeam: _trHomeTeamForAgent(r, pickedCanon, canonToPretty),
            teamsWorked,
            teamsCount: perPicked.length,
            calls, seller, rental, email, workTime, talkTime,
            leads: seller,  // seller-only definition, matches campaignsFor
            cph: workTime > 0 ? +(calls / workTime).toFixed(1) : 0,  // calls per hour of dialer work time
          };
        });

    // Sort
    const sortDirMul = _trSortDir === 'asc' ? 1 : -1;
    const key = _trSortBy;
    filtered.sort((a, b) => {
      if (key === 'name' || key === 'homeTeam' || key === 'teamsWorked') {
        return String(a[key] || '').localeCompare(String(b[key] || '')) * sortDirMul;
      }
      return ((a[key] || 0) - (b[key] || 0)) * sortDirMul;
    });

    // KPI totals
    const totalCalls   = filtered.reduce((s, r) => s + r.calls, 0);
    const totalSeller  = filtered.reduce((s, r) => s + r.seller, 0);
    const totalRental  = filtered.reduce((s, r) => s + r.rental, 0);
    const totalEmail   = filtered.reduce((s, r) => s + r.email, 0);
    const totalCallers = filtered.length;

    // ── Picker markup (forked from LN Stats)
    const q = (_trTeamFilterQ || '').trim().toLowerCase();
    const filteredTeams = q
      ? teamList.filter(t => t.toLowerCase().includes(q))
      : teamList;
    const pickerSummary = pickedCount === 0
      ? 'Pick teams…'
      : pickedCount === 1
        ? Array.from(_trTeamsPicked)[0]
        : `${pickedCount} teams`;
    const selectedChips = pickedCount
      ? Array.from(_trTeamsPicked).sort().map(t =>
          `<button type="button" class="tr-team-chip on" data-tr-team-remove="${escapeHtml(t)}" title="Remove ${escapeHtml(t)}">${escapeHtml(t)}<span aria-hidden="true"> ×</span></button>`).join('')
      : '';
    const pickerPanel = _trPickerOpen ? `
      <div class="tr-team-picker" role="dialog" aria-label="Pick teams">
        <div class="tr-team-picker-head">
          <input id="trTeamSearch" type="search" placeholder="Search teams…"
                 value="${escapeHtml(_trTeamFilterQ || '')}" autocomplete="off">
          <button type="button" id="trTeamClear" class="btn" style="padding:5px 10px;font-size:12px"${pickedCount ? '' : ' disabled'}>Clear</button>
        </div>
        <div class="tr-team-picker-grid">
          ${filteredTeams.length === 0
            ? '<div class="muted" style="grid-column:1/-1;padding:8px;font-size:12.5px">No teams match</div>'
            : filteredTeams.map(t =>
                `<button type="button" class="tr-team-chip ${_trTeamsPicked.has(t) ? 'on' : ''}" data-tr-team-toggle="${escapeHtml(t)}">${escapeHtml(t)}${_archTag(t)}${_trTeamsPicked.has(t) ? ' ✓' : ''}</button>`).join('')}
        </div>
      </div>` : '';

    const fmt2 = n => Number(n || 0).toLocaleString('en-ZA');
    const fmtHrs = (h) => {
      if (!h || h <= 0) return '—';
      const tot = Math.round(h * 60);
      return Math.floor(tot / 60) + ':' + String(tot % 60).padStart(2, '0');
    };
    const sortIndic = (k) => {
      if (k !== _trSortBy) return '<span class="muted" style="font-size:11px"> ⇅</span>';
      return _trSortDir === 'asc'
        ? '<span style="color:var(--blue-800);font-size:11px"> ▲</span>'
        : '<span style="color:var(--blue-800);font-size:11px"> ▼</span>';
    };
    const sortTh = (k, label, extra) => `<th class="${extra || 'num'}" style="cursor:pointer" data-tr-sort="${k}">${escapeHtml(label)}${sortIndic(k)}</th>`;
    const kpi = (ic, label, val, foot) => `<div class="card kpi">
      <div class="kpi-top"><span class="kpi-ic">${ic}</span><div class="kpi-label">${escapeHtml(label)}</div></div>
      <div class="kpi-val tnum">${val}</div>
      <div class="kpi-foot">${escapeHtml(foot)}</div>
    </div>`;
    const nowLabel = new Date().toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
    const periodLabel = rangeLabel;

    const tableRows = pickedCount === 0
      ? `<tr><td colspan="9" class="muted" style="text-align:center;padding:30px">Pick one or more teams above to see who's calling for them.</td></tr>`
      : filtered.length === 0
        ? `<tr><td colspan="9" class="muted" style="text-align:center;padding:30px">No calls logged on the selected team(s) in this period.</td></tr>`
        : filtered.map(r => `<tr>
            <td data-label="Caller"><b>${escapeHtml(r.name)}</b></td>
            <td data-label="Home team"><span class="pill rm" style="font-size:10.5px;padding:2px 8px">${escapeHtml(r.homeTeam)}</span></td>
            <td class="muted" style="font-size:12px" data-label="Teams worked">${escapeHtml(r.teamsWorked || '—')}</td>
            <td class="num tnum" data-label="Calls">${fmt2(r.calls)}</td>
            <td class="num tnum" data-label="Seller leads">${r.seller ? fmt2(r.seller) : '<span class="muted">—</span>'}</td>
            <td class="num tnum" data-label="Rental leads">${r.rental ? fmt2(r.rental) : '<span class="muted">—</span>'}</td>
            <td class="num tnum" data-label="Email leads">${r.email ? fmt2(r.email) : '<span class="muted">—</span>'}</td>
            <td class="num tnum" data-label="Calls / hr">${r.workTime > 0 ? r.cph.toFixed(1) : '<span class="muted">—</span>'}</td>
            <td class="num tnum" data-label="Talk time">${fmtHrs(r.talkTime)}</td>
          </tr>`).join('');

    const todaySast = sastDateStr(new Date());
    return `<div class="tab-view" id="trPrintable">
      <div class="card card-pad">
        <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between">
          <div>
            <h3 style="margin:0;font-family:var(--serif);font-size:17px">Teams Reporting</h3>
            <div class="sub" style="margin-top:4px">${periodLabel}${rangeSuffix} · exact per-caller × per-team breakdown from Dialfire</div>
          </div>
          <div class="ln-date-picker" aria-label="Custom date range">
            <label class="muted" for="trDateFrom">From</label>
            <input id="trDateFrom" type="date" value="${_trDateFrom || ''}" max="${todaySast}">
            <span class="muted" aria-hidden="true">→</span>
            <label class="muted" for="trDateTo">To</label>
            <input id="trDateTo" type="date" value="${_trDateTo || ''}" max="${todaySast}">
            ${usingCustomRange ? `<button class="btn" id="trDateClear" type="button" style="padding:5px 10px;font-size:12px">Clear</button>` : ''}
            <button class="btn" id="trExportPng" title="Download as PNG image" style="margin-left:6px">${I.download} PNG</button>
          </div>
        </div>
      </div>

      <div class="card mt card-pad">
        <div class="tr-filters">
          <div class="tr-div-wrap" style="position:relative;flex:1;min-width:260px;max-width:520px">
            <label class="muted" style="font-size:12px">Teams (multi-select)</label>
            <button type="button" id="trDivToggle" class="ln-div-select"
                    aria-haspopup="listbox" aria-expanded="${_trPickerOpen}"
                    style="text-align:left;cursor:pointer;padding-right:26px;position:relative;width:100%">
              ${escapeHtml(pickerSummary)}
              <span aria-hidden="true" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);color:var(--muted)">${_trPickerOpen ? '▴' : '▾'}</span>
            </button>
            ${pickerPanel}
          </div>
        </div>
        ${pickedCount ? `<div class="tr-team-selected" style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${selectedChips}</div>` : ''}
      </div>

      <div class="row kpis mt">
        ${kpi(I.users,  'Callers',       fmt2(totalCallers), pickedCount ? 'people who logged calls on the selected team(s)' : 'pick teams to populate')}
        ${kpi(I.phone,  'Total Calls',   fmt2(totalCalls),   pickedCount ? 'across selected team(s), this period'          : '—')}
        ${kpi(I.target, 'Seller Leads',  fmt2(totalSeller),  pickedCount ? 'seller lines only'                              : '—')}
        ${kpi(I.trophy, 'Rental+Email',  fmt2(totalRental + totalEmail), pickedCount ? `${fmt2(totalRental)} rental · ${fmt2(totalEmail)} email` : '—')}
      </div>

      <div class="card mt">
        <div class="card-head" style="padding:14px 16px 6px">
          <h3 style="margin:0;font-family:var(--serif);font-size:15px">Callers on selected team(s)</h3>
          <div class="sub">${pickedCount ? Array.from(_trTeamsPicked).sort().join(', ') : 'no teams picked'} · ${periodLabel}${rangeSuffix} · captured ${nowLabel}</div>
        </div>
        <div class="tbl-wrap"><table class="tbl tbl-sortable">
          <thead>
            <tr>
              <th data-tr-sort="name" style="cursor:pointer;text-align:left">Caller${sortIndic('name')}</th>
              <th data-tr-sort="homeTeam" style="cursor:pointer;text-align:left">Home team${sortIndic('homeTeam')}</th>
              <th data-tr-sort="teamsWorked" style="cursor:pointer;text-align:left">Teams worked${sortIndic('teamsWorked')}</th>
              ${sortTh('calls',  'Calls')}
              ${sortTh('seller', 'Seller')}
              ${sortTh('rental', 'Rental')}
              ${sortTh('email',  'Email')}
              ${sortTh('cph',    'Calls/hr')}
              ${sortTh('talkTime','Talk time')}
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table></div>
      </div>

      ${V.divCostsSection(payrollState)}

      ${_trSubscribersCard()}
    </div>`;
  }

  function wireTeamsReporting() {
    const divToggle = document.getElementById('trDivToggle');
    if (divToggle) divToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      _trPickerOpen = !_trPickerOpen;
      shell();
    });
    const divSearch = document.getElementById('trTeamSearch');
    if (divSearch) {
      divSearch.addEventListener('input', (e) => {
        const caret = e.target.selectionStart;
        _trTeamFilterQ = e.target.value;
        shell();
        const s2 = document.getElementById('trTeamSearch');
        if (s2) { s2.focus(); try { s2.setSelectionRange(caret, caret); } catch (_) {} }
      });
      divSearch.addEventListener('click', (e) => e.stopPropagation());
    }
    document.querySelectorAll('[data-tr-team-toggle]').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = b.dataset.trTeamToggle;
      if (_trTeamsPicked.has(t)) _trTeamsPicked.delete(t);
      else _trTeamsPicked.add(t);
      shell();
    }));
    document.querySelectorAll('[data-tr-team-remove]').forEach(b => b.addEventListener('click', () => {
      _trTeamsPicked.delete(b.dataset.trTeamRemove);
      shell();
    }));
    const clearBtn = document.getElementById('trTeamClear');
    if (clearBtn) clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _trTeamsPicked.clear();
      _trTeamFilterQ = '';
      shell();
    });
    // Same click-outside pattern LN Stats uses — detach the previous
    // module-scoped handler before attaching a new one so listeners don't
    // stack across shell() re-renders.
    if (_trDocClickHandler) {
      document.removeEventListener('click', _trDocClickHandler);
      _trDocClickHandler = null;
    }
    if (_trPickerOpen) {
      _trDocClickHandler = (ev) => {
        if (ev.target.closest('.tr-div-wrap')) return;
        _trPickerOpen = false;
        document.removeEventListener('click', _trDocClickHandler);
        _trDocClickHandler = null;
        shell();
      };
      setTimeout(() => {
        if (_trDocClickHandler) document.addEventListener('click', _trDocClickHandler);
      }, 0);
    }
    document.querySelectorAll('th[data-tr-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const k = th.dataset.trSort;
        if (_trSortBy === k) _trSortDir = _trSortDir === 'asc' ? 'desc' : 'asc';
        else { _trSortBy = k; _trSortDir = (k === 'name' || k === 'homeTeam' || k === 'teamsWorked') ? 'asc' : 'desc'; }
        shell();
      });
    });
    const pngBtn = document.getElementById('trExportPng');
    if (pngBtn) pngBtn.addEventListener('click', exportTeamsReportingPng);
    // Custom date-range picker — override the global period once both ends
    // are filled. Shared wiring preserves focus on the edited field.
    wireDatePicker('tr', (kind, value) => {
      if (kind === 'from') _trDateFrom = value;
      else if (kind === 'to') _trDateTo = value;
      else { _trDateFrom = null; _trDateTo = null; }
    });
    // ── Subscribers card wiring
    const subsToggle = document.getElementById('trSubsToggle');
    if (subsToggle) subsToggle.addEventListener('click', () => {
      _trSubsOpen = !_trSubsOpen;
      if (!_trSubsOpen) { _trSubsCancelEdit(); _trSubsError = ''; }
      shell();
    });
    const subsAdd = document.getElementById('trSubsAdd');
    if (subsAdd) subsAdd.addEventListener('click', () => {
      _trSubsStartEdit(null);
      shell();
    });
    // Fire-now: writes a fresh ISO timestamp to weekly_email_fire_request.
    // The Mac's launchd fire-watcher polls that row every 2 min and runs
    // the emailer as a draft-mode job on any value change.
    const fireBtn = document.getElementById('trFireNow');
    if (fireBtn) fireBtn.addEventListener('click', () => {
      if (_trFireStatus === 'firing') return;
      const ok = confirm(
        "Fire the weekly team-report emailer now?\n\n" +
        "Drafts will appear in Gmail within ~2 minutes for every active " +
        "subscriber. Nothing is sent — you can review each draft first.");
      if (!ok) return;
      _trFireNow();
    });
    document.querySelectorAll('[data-trsubs-edit]').forEach(b =>
      b.addEventListener('click', () => {
        const row = (_trSubs || []).find(r => r.id === b.dataset.trsubsEdit);
        if (row) { _trSubsStartEdit(row); shell(); }
      })
    );
    document.querySelectorAll('[data-trsubs-remove]').forEach(b =>
      b.addEventListener('click', () => _trSubsRemove(b.dataset.trsubsRemove))
    );
    // Edit-row form fields — bind to draft on input so save gets fresh values.
    const bindField = (id, key) => {
      const el = document.getElementById(id);
      if (!el || !_trSubsDraft) return;
      const handler = () => {
        _trSubsDraft[key] = (el.type === 'checkbox') ? el.checked : el.value;
      };
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    };
    bindField('trSubsEmail', 'email');
    bindField('trSubsName', 'name');
    bindField('trSubsActive', 'active');
    bindField('trSubsLastWeek', 'send_last_week');
    bindField('trSubsMtd', 'send_month_to_date');
    const subsSave = document.getElementById('trSubsSave');
    if (subsSave) subsSave.addEventListener('click', _trSubsSave);
    const subsCancel = document.getElementById('trSubsCancel');
    if (subsCancel) subsCancel.addEventListener('click', () => {
      _trSubsCancelEdit(); _trSubsError = ''; shell();
    });
    // Team picker inside the edit row
    const subsTeamToggle = document.getElementById('trSubsTeamToggle');
    if (subsTeamToggle) subsTeamToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      _trSubsTeamPickerOpen = !_trSubsTeamPickerOpen;
      shell();
    });
    const subsTeamSearch = document.getElementById('trSubsTeamSearch');
    if (subsTeamSearch) {
      subsTeamSearch.addEventListener('input', (e) => {
        const caret = e.target.selectionStart;
        _trSubsTeamFilterQ = e.target.value;
        shell();
        const s2 = document.getElementById('trSubsTeamSearch');
        if (s2) { s2.focus(); try { s2.setSelectionRange(caret, caret); } catch (_) {} }
      });
    }
    document.querySelectorAll('[data-trsubs-team-toggle]').forEach(b =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = b.dataset.trsubsTeamToggle;
        if (_trSubsDraft.teams.has(t)) _trSubsDraft.teams.delete(t);
        else _trSubsDraft.teams.add(t);
        shell();
      })
    );

    // ── Division Costs section (embedded, SDL hidden) ─────────────────────
    // Shares the Payroll data pipeline via payrollState. Pay-period picker
    // re-fetches; the division multi-select re-renders in place; first mount
    // kicks off the fetch (payrollFetchAndRender re-renders teams-report when
    // the shifts land — see its tab guards).
    const dcPeriod = document.getElementById('payrollPeriod');
    if (dcPeriod) dcPeriod.addEventListener('change', () => {
      const all = window.PAYROLL.payPeriodsForPicker(12);
      const next = all.find(p => p.label === dcPeriod.value);
      if (!next) return;
      payrollState.period = next;
      payrollState.shifts = null;
      payrollState.allocations = null;
      payrollFetchAndRender();
    });
    payrollDivPickerWire();
    if (window.PAYROLL && payrollState.shifts === null && !payrollState.loading) {
      payrollFetchAndRender();
    }
  }

  // Snapshot the Teams Reporting view as a PNG and trigger a download.
  // Uses html2canvas from the CDN script tag in index.html; degrades to a
  // friendly nudge if the library failed to load (offline / blocked).
  async function exportTeamsReportingPng() {
    const target = document.getElementById('trPrintable');
    if (!target) return;
    if (typeof window.html2canvas !== 'function') {
      alert('PNG export helper failed to load — try the Print button (Save as PDF) instead.');
      return;
    }
    const btn = document.getElementById('trExportPng');
    const prev = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = 'Rendering…'; }
    try {
      const canvas = await window.html2canvas(target, {
        backgroundColor: '#F6F7FB',
        scale: 2,                     // retina-quality
        useCORS: true,
        logging: false,
        windowWidth: target.scrollWidth,
      });
      const teams = Array.from(_trTeamsPicked).sort().join('_').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'all';
      const stamp = (_trDateFrom && _trDateTo)
        ? `${_trDateFrom}_${_trDateTo}`
        : new Date().toISOString().slice(0, 10);
      const link = document.createElement('a');
      link.download = `teams-report_${teams}_${stamp}.png`;
      link.href = canvas.toDataURL('image/png');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (e) {
      console.error('PNG export failed', e);
      alert('PNG export failed: ' + (e && e.message ? e.message : e));
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = prev; }
    }
  }

  // ─── LN Daily Recap (used on Overview tab — top-of-page card) ────
  // Shows YESTERDAY's EOD submissions — the dashboard is reviewed the
  // next morning so the previous day's reports are all in.
  function lnDailyRecapCard() {
    if (_reports == null && !_reportsLoading) {
      loadReports().then(() => { if (tab === 'overview' || tab === 'leadership') shell(); });
    }
    if (_reports == null) return '';
    const y = new Date(); y.setDate(y.getDate() - 1);
    const yKey = sastDateStr(y);
    const fromDate = new Date(yKey + 'T00:00:00+02:00');
    const toDate   = new Date(yKey + 'T23:59:59+02:00');
    const inRange = (_reports || []).filter(r => {
      const ts = r.clocked_out_at ? new Date(r.clocked_out_at) : null;
      return ts && ts >= fromDate && ts <= toDate;
    }).filter(r => {
      const d = (r.designation || '').toLowerCase();
      return d === 'ln' || d === 'assistant';
    });
    if (inRange.length === 0) return '';
    const range = { from: fromDate, to: toDate, fromKey: yKey, toKey: yKey };
    const lns = _lnAggregate(_reports, range)
      .filter(r => { const d = (r.designation || '').toLowerCase(); return d === 'ln' || d === 'assistant'; });
    if (lns.length === 0) return '';
    lns.forEach(r => {
      r._totalLeads = r.hsLeads + r.dfLeads + r.waLeads;
      r._totalCalls = r.hsCalls + r.dfCalls;
    });
    const top = lns.slice().sort((a, b) => b._totalLeads - a._totalLeads)[0];
    const watch = lns.filter(r => r.dfHours >= 2)
                     .sort((a, b) => a._totalLeads - b._totalLeads)[0];
    const submitted = inRange.length;
    const lnsCount = lns.length;
    const fmtH = (h) => {
      const tot = Math.round((h || 0) * 60);
      return Math.floor(tot / 60) + ':' + String(tot % 60).padStart(2, '0');
    };
    const dayLabel = fromDate.toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'short',
      timeZone: 'Africa/Johannesburg',
    });
    return `<section class="card card-pad ln-recap mt" aria-label="LN daily recap">
      <header class="ln-recap-meta">
        <div class="ln-recap-eyebrow">LN Recap · ${escapeHtml(dayLabel)}</div>
        <div class="ln-recap-sub">${submitted} EOD submission${submitted === 1 ? '' : 's'} from ${lnsCount} LN${lnsCount === 1 ? '' : 's'}</div>
        <button class="btn ln-recap-btn" data-goto="ln" type="button">Open LN Stats <span aria-hidden="true">→</span></button>
      </header>
      <div class="ln-recap-cells">
        <div class="ln-recap-cell">
          <div class="kpi-label">Top LN</div>
          <div class="ln-recap-name" title="${escapeHtml(top.name)}">${escapeHtml(top.name)}</div>
          <div class="kpi-foot tnum">${fmt(top._totalLeads)} leads · ${fmt(top._totalCalls)} calls · ${fmtH(top.dfHours)}</div>
        </div>
        <div class="ln-recap-cell">
          <div class="kpi-label">Watch list</div>
          ${watch
            ? `<div class="ln-recap-name" title="${escapeHtml(watch.name)}">${escapeHtml(watch.name)}</div>
               <div class="kpi-foot tnum">${fmt(watch._totalLeads)} leads over ${fmtH(watch.dfHours)}</div>`
            : `<div class="ln-recap-empty">Nobody flagged ✓</div>`}
        </div>
        <div class="ln-recap-cell">
          <div class="kpi-label">Compliance</div>
          <div class="ln-recap-name tnum">${submitted}/${lnsCount}</div>
          <div class="kpi-foot">submissions ÷ LNs reporting</div>
        </div>
      </div>
    </section>`;
  }

  function renderLiveFloor() {
    // Anchor "now" once per render so every card's elapsed calculation
    // agrees. Also drives the stale-daily-snapshot banner check.
    const nowRender = new Date();
    const todayKey = sastDateStr(nowRender);
    // Sort hierarchy (top -> bottom):
    //   0. Active callers — calls > 0, ordered by calls desc (matches the
    //      quay-clock admin vibe of "people doing things first").
    //   1. On-the-clock but no calls yet.
    //   2. Already clocked out for the day.
    //   3. Absent (accounted for, not a no-show).
    //   4. Not in yet / no schedule entry.
    // Each card carries {bucket, calls, name, html} and is flattened at the end.
    const cards = [];

    // Metric definitions — single source of truth shared by the per-card
    // hover tooltips AND the always-visible legend below the summary, so the
    // two can never drift. (Em dashes stripped per house style.)
    const CALLS_DEF    = "Total dial attempts (Dialfire's 'completed' column).";
    const ANSWERED_DEF = "Calls where the person was reached — every completed call except No Answer (includes Declined outcomes).";

    // Per-agent today's calls/leads. PRIMARY source is the live_stats table
    // (Mac daemon polls Dialfire every ~90s, pushes via Supabase realtime).
    // If no live row for an agent we fall back to the most-recent daily
    // snapshot — but ONLY when it's actually for today, otherwise we'd
    // silently render yesterday's numbers as if they were today's (the
    // pre-07:00 SAST window when update-daily.yml hasn't refreshed the
    // snapshot yet — supervisors would see phantom activity).
    const latestDate = (Q.latestDailyDate && Q.latestDailyDate()) || null;
    const dailyIsForToday = latestDate === todayKey;
    const todayList = (dailyIsForToday && Q.dailyFor)
      ? (Q.dailyFor(latestDate) || [])
      : [];
    const callsByName = new Map();
    todayList.forEach(a => {
      const k = (a.name || '').trim().toLowerCase();
      if (k) callsByName.set(k, a);
    });

    let onlineCount = 0, offlineCount = 0, totalRoster = 0;
    let absentCount = 0;
    let clockedOutCount = 0;
    let notInYetCount = 0;
    let totalCallsToday = 0, totalSellerLeads = 0;
    let activeCallerCount = 0;

    if (schedule && schedule.byStaff && schedule.byStaff.size) {
      schedule.byStaff.forEach(rec => {
        // Role filter (RM / LN / Fancy). Applied first so the summary counts
        // and cards both reflect the selected group. 'all' shows everyone.
        if (liveDesig !== 'all' && (rec.designation || '') !== liveDesig) return;
        totalRoster++;
        const today = rec.days && rec.days[todayKey];
        const inAt = today && today.first ? today.first : null;
        const outAt = today && today.last ? today.last : null;
        // Currently clocked in if the most-recent event today was an 'in'.
        // Falls back to the first/last comparison for older days that
        // pre-date the latestDir tracking. NOTE: quay-clock's admin panel
        // has its own "who's on the clock now" derivation — future work
        // should collapse to a single shared helper to prevent drift
        // between the two surfaces.
        const isIn = today && today.latestDir
          ? today.latestDir === 'in'
          : !!(inAt && (!outAt || outAt < inAt));
        if (isIn) onlineCount++; else offlineCount++;

        const initials = (rec.name || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
        const avColor = avatarColor(rec.name);
        const isAbsent = !!rec.absenceToday;
        if (isAbsent && !isIn) absentCount++;
        // Card class differentiates absent (opacity + amber accent) from
        // clocked-out (grey). `.live-card--break` was defined in styles.css
        // but never applied — this line restores the visual distinction so
        // a supervisor scanning 40 cards can spot absences at a glance.
        const cardClass = isIn
          ? 'live-card live-card--in'
          : (isAbsent ? 'live-card live-card--break' : 'live-card live-card--out');
        const pillClass = isIn ? 'live-pill live-pill--in'
                       : (isAbsent ? 'live-pill live-pill--break'
                                   : 'live-pill live-pill--out');
        const pillText  = isIn ? 'On the clock'
                       : (isAbsent ? 'Absent · ' + (rec.absenceToday.reason || 'Absent')
                                   : (outAt ? 'Clocked out' : 'Not in yet'));

        // Prefer live_stats; fall back to the daily snapshot. Both use
        // dfKeysFor() so a name mismatch (Gomes/Gomez, nickname, short
        // last-name) still resolves to the right Dialfire row.
        const liveRow = liveStatsFor(rec.name);
        let dailyAgent = null;
        for (const k of dfKeysFor(rec.name)) {
          dailyAgent = callsByName.get(k);
          if (dailyAgent) break;
        }
        const todayCalls    = liveRow ? liveRow.calls         : (dailyAgent ? dailyAgent.calls  : null);
        const todayAnswered = liveRow ? (liveRow.answered != null ? liveRow.answered : liveRow.calls) : (dailyAgent && dailyAgent.answered != null ? dailyAgent.answered : null);
        // "Leads" = seller leads only. Rental + email stay as their own columns.
        const todayLeads    = liveRow ? liveRow.seller_leads  : (dailyAgent ? (dailyAgent.seller || 0) : null);
        const todayRental   = liveRow ? liveRow.rental_leads  : (dailyAgent ? dailyAgent.rental : null);
        const todayEmail    = liveRow ? liveRow.email_leads   : (dailyAgent ? dailyAgent.email  : null);
        const todaySuccess  = liveRow ? liveRow.success_rate  : (dailyAgent ? dailyAgent.success : null);
        if (todayCalls != null) totalCallsToday += todayCalls;
        if (todayLeads != null) totalSellerLeads += todayLeads;
        if (todayCalls > 0) activeCallerCount++;

        const fmtT = (d) => d ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' }) : '—';
        // Anchor "now" at the render-scope value so cards computed 200ms
        // apart still agree on elapsed time.
        const elapsedMs = inAt ? (Math.max(outAt || nowRender, inAt) - inAt) : 0;
        const elapsedH = elapsedMs > 0 ? (elapsedMs / 3.6e6) : 0;
        const elapsedTxt = elapsedH > 0 ? `${Math.floor(elapsedH)}h ${Math.round((elapsedH % 1) * 60)}m` : '—';

        const forgotTs = rec.forgotRecentTs ? new Date(rec.forgotRecentTs) : null;
        const forgotBadge = forgotTs
          ? `<div title="Forgot to clock out · auto-correction recorded ${forgotTs.toLocaleString('en-GB',{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Africa/Johannesburg'})} SAST" style="display:inline-block;margin-top:4px;padding:2px 8px;border-radius:999px;background:#FFE0E0;color:#8B1A1A;font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase">⚠️ Forgot to clock out</div>`
          : '';

        const html = `<div class="${cardClass}" data-agent-id="${escapeHtml(rec.id)}">
          <div class="live-card-head">
            <div class="live-av" style="background:${avColor}">${initials}</div>
            <div style="flex:1 1 auto;min-width:0">
              <div class="live-card-name">${escapeHtml(rec.name)}</div>
              <div class="live-card-team">${isIn ? 'In at ' + fmtT(inAt) + ' · ' + elapsedTxt : (outAt ? 'Out at ' + fmtT(outAt) : 'Awaiting clock-in')}</div>
              ${forgotBadge}
            </div>
            <span class="${pillClass}">${pillText}</span>
          </div>
          <div class="live-card-meta">
            <div title="${CALLS_DEF}">
              <div class="live-stat-label">Calls</div>
              <div class="live-stat-val tnum">${todayCalls != null ? fmt(todayCalls) : '—'}</div>
            </div>
            <div title="${ANSWERED_DEF}">
              <div class="live-stat-label">Answered</div>
              <div class="live-stat-val tnum">${todayAnswered != null ? fmt(todayAnswered) : '—'}</div>
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
            <div title="Dialfire success rate (answered ÷ calls).">
              <div class="live-stat-label">Success rate</div>
              <div class="live-stat-val tnum">${todaySuccess != null ? todaySuccess.toFixed(1) + '%' : '—'}</div>
            </div>
          </div>
        </div>`;
        // Bucket: 0=actively calling today, 1=on clock no calls,
        // 2=clocked out, 3=absent (accounted for, not a no-show),
        // 4=not in yet. Sort within bucket by calls desc then name asc.
        const callsForSort = todayCalls || 0;
        let bucket;
        if (callsForSort > 0) bucket = 0;
        else if (isIn) bucket = 1;
        else if (outAt) { bucket = 2; clockedOutCount++; }
        else if (isAbsent) bucket = 3;
        else { bucket = 4; notInYetCount++; }
        cards.push({ bucket, calls: callsForSort, name: rec.name || '', html });
      });
    }
    // Sort + render in the requested order. Active callers float to the top
    // (highest calls first), then on-the-clock with zero, then clocked-out,
    // then not-in-yet.
    cards.sort((a, b) => {
      if (a.bucket !== b.bucket) return a.bucket - b.bucket;
      if (a.calls !== b.calls) return b.calls - a.calls;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    // Freshness: use the max updated_at across live_stats rows, but only
    // trust it as "live" if that timestamp is within the last 5 minutes.
    // Older than that = the daemon or the socket is dead and the badge
    // should degrade to "Snapshot" so viewers stop trusting the numbers.
    const LIVE_STALE_MS = 5 * 60 * 1000;
    const liveTs = liveStatsFreshness();
    const isLiveFresh = liveTs && (nowRender.getTime() - liveTs.getTime()) < LIVE_STALE_MS;
    const refreshedTs = liveTs || (schedule && schedule.asOf) || null;
    const refreshedAt = refreshedTs
      ? refreshedTs.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Johannesburg' })
      : '—';
    const liveBadge = isLiveFresh
      ? '<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#DCF3E5;color:#0E6B3A;font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-left:6px">● Live</span>'
      : '<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#FFE9CB;color:#6B3F00;font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-left:6px">Snapshot</span>';
    // notInYet is now the actual not-in-yet count from the bucket loop,
    // not (roster - online - absent) which double-counted anyone who
    // clocked in and back out again as still "not in yet".
    const notInYet = notInYetCount;
    // Guard against rendering a fully-zeroed summary on first paint
    // before schedule has loaded. The grid below already handles the
    // "loading" empty state — matching it here prevents the pre-data
    // flash of "0 on the clock, 0 calls" that misleads supervisors.
    const scheduleReady = !!(schedule && schedule.byStaff && schedule.byStaff.size);
    const summary = scheduleReady ? `<div class="live-summary">
      <div class="live-summary-stat">
        <div class="live-summary-val tnum">${onlineCount}</div>
        <div class="live-summary-label">On the clock</div>
      </div>
      ${absentCount > 0 ? `
      <div class="live-summary-stat">
        <div class="live-summary-val tnum" style="color:#6B3F00">${absentCount}</div>
        <div class="live-summary-label">Absent</div>
      </div>` : ''}
      ${clockedOutCount > 0 ? `
      <div class="live-summary-stat">
        <div class="live-summary-val tnum">${clockedOutCount}</div>
        <div class="live-summary-label">Clocked out</div>
      </div>` : ''}
      <div class="live-summary-stat">
        <div class="live-summary-val tnum">${notInYet}</div>
        <div class="live-summary-label">Not in yet</div>
      </div>
      <div class="live-summary-stat">
        <div class="live-summary-val tnum">${fmt(totalCallsToday)}</div>
        <div class="live-summary-label">Calls today</div>
      </div>
      <div class="live-summary-stat">
        <div class="live-summary-val tnum">${fmt(totalSellerLeads)}</div>
        <div class="live-summary-label">Seller leads today</div>
      </div>
      <div class="live-refresh-meta">
        <span style="display:inline-block">Refreshed ${escapeHtml(refreshedAt)} SAST${liveBadge}</span>
      </div>
    </div>` : '';

    // Show a warning band when the daily snapshot doesn't cover today —
    // typically the pre-07:00 SAST window before update-daily.yml has run
    // (or a daemon outage). Without this the fallback path silently shows
    // yesterday's numbers under today's header.
    const staleDailyBanner = (!dailyIsForToday && latestDate) ? `<div class="card card-pad" style="background:#FFF7E6;border-left:4px solid #C97900;margin-bottom:12px;padding:12px 16px;color:#6B3F00;font-size:13px">
      <b>Daily snapshot is from ${escapeHtml(latestDate)}</b> — today's Dialfire numbers haven't landed yet. Cards show <b>live_stats only</b> until update-daily.yml runs (~07:00 SAST) or the Mac daemon pushes a live row.
    </div>` : '';

    const grid = cards.length
      ? `<div class="live-grid">${cards.map(c => c.html).join('')}</div>`
      : `<div class="card card-pad" style="text-align:center;color:var(--muted);padding:60px 20px">
          ${schedule ? 'No clock-in events recorded yet for the active roster.' : 'Loading live floor data — clock events are streaming from quay-clock.'}
        </div>`;

    // Always-visible metric legend so supervisors don't have to hover to know
    // what Calls vs Answered mean. Reuses the same definitions as the tooltips.
    const legend = `<div class="live-legend">
      <span><b>Calls</b> ${escapeHtml(CALLS_DEF)}</span>
      <span><b>Answered</b> ${escapeHtml(ANSWERED_DEF)}</span>
    </div>`;

    // Live Floor is realtime by default; when a range is set (via the header
    // bar) it switches to a historical per-agent aggregation for that span.
    // The date picker + role filter live in the header now (see liveDateBar).
    const liveRange = (liveDateFrom && liveDateTo) ? { from: liveDateFrom, to: liveDateTo } : null;

    if (liveRange) {
      const hist = Q.agentsForRange(liveRange.from, liveRange.to);
      const hm = hist._range;
      const hTot = hist.reduce((s, a) => s + (a.calls || 0), 0);
      const hLeads = hist.reduce((s, a) => s + (a.leads || 0), 0);
      const rows = hist.slice().sort((a, b) => b.calls - a.calls).map((a, i) => `
        <tr data-agent="${escapeHtml(a.name)}" style="cursor:pointer">
          <td class="num tnum">${i + 1}</td>
          <td>${escapeHtml(a.name)}</td>
          <td><span class="pill">${escapeHtml(a.team)}</span></td>
          <td class="num tnum">${fmt(a.calls)}</td>
          <td class="num tnum">${fmt(a.leads)}</td>
          <td class="num"><span class="pill ${sucClass(a.success)}">${a.success}%</span></td>
        </tr>`).join('');
      const caption = `<div class="range-caption">Custom range · covers <b>${(hm && hm.effectiveFrom) || liveRange.from}</b> → <b>${(hm && hm.effectiveTo) || liveRange.to}</b>${hm && hm.weeksIncluded === 0 ? ' · <span style="color:var(--red)">no complete Mon-Sun weeks in range</span>' : (hm ? ` · ${hm.weeksIncluded} complete week${hm.weeksIncluded === 1 ? '' : 's'}` : '')} · <b>${fmt(hTot)}</b> calls · <b>${fmt(hLeads)}</b> leads. Clear the range to return to the live floor.</div>`;
      const histCard = hist.length ? `<div class="card mt">
        <div class="card-head"><div><h3>Historical performance</h3><div class="sub">Per-agent calls · leads · success for the selected range</div></div></div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th class="num">#</th><th>Agent</th><th>Team</th><th class="num">Calls</th><th class="num">Leads</th><th class="num">Success</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div></div>`
        : `<div class="card card-pad" style="text-align:center;color:var(--muted);padding:48px 20px">No complete Mon-Sun weeks in the selected range.</div>`;
      return `<div class="tab-view">${caption}${histCard}</div>`;
    }

    return `<div class="tab-view">${staleDailyBanner}${summary}${legend}${grid}</div>`;
  }

  function liveFloorWire() {
    // Date-range picker: switches between live cards and a historical table.
    // Wired every render (router calls this after renderLiveFloor). Also wire
    // agent-click drill-down on the historical rows.
    wireDatePicker('live', (kind, value) => {
      if (kind === 'from') liveDateFrom = value;
      else if (kind === 'to') liveDateTo = value;
      else { liveDateFrom = null; liveDateTo = null; }
    });
    // Role filter chips (RM / LN / Fancy) — re-render the live tab in place.
    document.querySelectorAll('[data-livedesig]').forEach(b =>
      b.addEventListener('click', () => { liveDesig = b.dataset.livedesig; shell(); }));
    wireAgentClicks();
    // Warm up schedule + live_stats. Coalesce into ONE re-render at the end
    // — previously each load called render() independently, so on tab open
    // the view repainted twice in ~500ms and the second one snapped scroll
    // back to top mid-read. Promise.allSettled ensures we still render even
    // if one of the two loads fails.
    if (!window.sb) return;
    const jobs = [];
    if (!schedule) jobs.push(loadScheduleData());
    jobs.push(loadLiveStats());
    Promise.allSettled(jobs).then(() => { if (tab === 'live') render(); });
  }

  // ---------------------------------------------------- CLIENTHUB · BY TEAM
  // Per-team calls / talk-time / leads on the ClientHub Master campaign.
  // Each hubspot_owner_id is a team; data from fetch_clienthub_teams.py.
  const CH_WINDOWS = [
    ['this-week',  'This Week'],   // current week-to-date (live)
    ['last-week',  'Last Week'],   // last completed Mon-Sun
    ['this-month', 'This Month'],  // month-to-date
    ['last-month', 'Last Month'],  // full previous calendar month
  ];
  function renderClientHubTeams() {
    const ch = Q.CLIENTHUB;
    if (!ch || !ch.windows) {
      return `<div class="tab-view"><div class="card card-pad" style="text-align:center;color:var(--muted);padding:60px 20px">
        ClientHub team stats aren't available yet. They populate on the next scheduled data refresh (<code>fetch_clienthub_teams.py</code>).
      </div></div>`;
    }
    if (!ch.windows[chWindow]) chWindow = 'last-week';
    const w = ch.windows[chWindow] || { teams: [], totals: {} };
    const teams = (w.teams || []).slice().sort((a, b) => b.calls - a.calls);
    const tot = w.totals || {};
    const maxCalls = teams.length ? teams[0].calls : 1;

    const toggle = CH_WINDOWS.map(([k, lbl]) =>
      `<button class="qf-chip ${chWindow === k ? 'active' : ''}" data-chwin="${k}" type="button" aria-pressed="${chWindow === k}">${lbl}</button>`).join('');

    const kpi = (icon, label, val, foot) => `<div class="card kpi">
      <div class="kpi-top"><div class="kpi-ic">${icon}</div></div>
      <div class="kpi-label">${label}</div>
      <div class="kpi-val tnum">${val}</div>
      <div class="kpi-foot">${foot}</div>
    </div>`;

    const rows = teams.map((t, i) => {
      const bar = Math.min(100, (t.calls / (maxCalls || 1)) * 100);
      const flag = t.team === 'Unassigned' ? ' style="color:var(--muted)"' : '';
      return `<tr${flag}>
        <td class="num tnum">${i + 1}</td>
        <td>${escapeHtml(t.team)}</td>
        <td class="num tnum">${fmt(t.calls)}</td>
        <td class="num tnum">${fmt(t.seller || 0)}</td>
        <td class="num tnum">${fmt(t.rental || 0)}</td>
        <td class="num tnum">${fmt(t.email || 0)}</td>
        <td class="num"><div class="cell-bar"><div class="track"><span style="width:${bar}%"></span></div></div></td>
      </tr>`;
    }).join('');

    const camps = (w.campaigns || []).length ? (w.campaigns || []).join(' + ') : 'ClientHub';
    return `<div class="tab-view">
      <div class="card ov-filterbar">
        <div class="qf-chips">${toggle}</div>
        <div class="live-range-label">${escapeHtml(w.from || '')} → ${escapeHtml(w.to || '')} SAST</div>
      </div>
      <div class="row kpis mt">
        ${kpi(I.phone,  'Total Calls',  fmt(tot.calls || 0), (tot.teams || teams.length) + ' teams')}
        ${kpi(I.target, 'Seller Leads', fmt(tot.seller || 0), 'LEAD outcomes')}
        ${kpi(I.target, 'Rental Leads', fmt(tot.rental || 0), 'RENTAL_LEAD outcomes')}
        ${kpi(I.mail || I.target, 'Emails', fmt(tot.email || 0), 'GOT_EMAIL outcomes')}
      </div>
      <div class="card mt">
        <div class="card-head">
          <div><h3>Engine Room calling</h3><div class="sub">${escapeHtml(camps)} campaigns · calls · seller leads · rental leads · emails, by team</div></div>
          <button class="btn" id="chExport" type="button">${I.download} Export CSV</button>
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th class="num">#</th><th>Team</th>
            <th class="num">Total Calls</th><th class="num">Seller Leads</th>
            <th class="num">Rental Leads</th>
            <th class="num">Emails</th><th class="num">Volume</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:30px">No team data for this window.</td></tr>'}</tbody>
        </table></div>
      </div>
    </div>`;
  }
  function wireClientHubTeams() {
    document.querySelectorAll('[data-chwin]').forEach(b =>
      b.addEventListener('click', () => { chWindow = b.dataset.chwin; shell(); }));
    const exp = document.getElementById('chExport');
    if (exp) exp.addEventListener('click', () => {
      const ch = Q.CLIENTHUB; const w = ch && ch.windows && ch.windows[chWindow];
      if (!w) return;
      const head = ['Team', 'TotalCalls', 'SellerLeads', 'RentalLeads', 'Emails', 'OwnerIDs'];
      const lines = [head.join(',')].concat((w.teams || []).map(t => [
        `"${(t.team || '').replace(/"/g, '""')}"`, t.calls, t.seller || 0, t.rental || 0, t.email || 0,
        `"${(t.owner_ids || []).join(' ')}"`,
      ].join(',')));
      const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `engine_room_${chWindow}_${(w.to || '').replace(/-/g, '')}.csv`;
      a.click(); URL.revokeObjectURL(url);
    });
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
    // Trend chart host only exists when NOT in a custom range (hidden then).
    const lTrendEl = document.getElementById('lTrendChart');
    if (lTrendEl) {
      const trend = (Q.trendSeriesFor ? Q.trendSeriesFor(period) : null)
        || { labels: Q.WEEKS, calls: Q.WEEK_CALLS, success: Q.WEEK_SUCCESS };
      if (trend.labels && trend.labels.length) {
        C.weeklyTrend(lTrendEl, trend.labels, trend.calls, trend.success);
      }
    }
    // Custom-range picker (this tab has no quick pills — custom only).
    wireDatePicker('lead', (kind, value) => {
      if (kind === 'from') leadDateFrom = value;
      else if (kind === 'to') leadDateTo = value;
      else { leadDateFrom = null; leadDateTo = null; }
    });
    document.querySelectorAll('[data-goto]').forEach(b =>
      b.addEventListener('click', () => { tab = b.dataset.goto; shell(); }));
    wireAgentClicks();
    wireFlagAckButtons();
  }

  // Globally wire any element with data-agent to open the drill-down modal.
  // Rows / cards are made keyboard-focusable here (tabindex=0 + role=button)
  // so the existing :focus-visible ring fires and Enter/Space activate the
  // same handler as a click. WCAG 2.1.1 (keyboard) compliance for
  // mouse-only "rows that act like buttons".
  function wireAgentClicks(scope) {
    (scope || document).querySelectorAll('[data-agent]').forEach(el => {
      if (el.__agentWired) return;
      el.__agentWired = true;
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      // Table rows keep their native row/cell semantics (role=button on a <tr>
      // collapses header->cell association); a focusable, labelled row still
      // works with the keyboard handler below. Cards/divs become buttons.
      if (el.tagName === 'TR') {
        if (!el.hasAttribute('aria-label') && el.dataset.agent) el.setAttribute('aria-label', `View ${el.dataset.agent} details`);
      } else if (!el.hasAttribute('role')) {
        el.setAttribute('role', 'button');
      }
      const activate = e => {
        if (e.target.closest('button, a, input, select')) return;
        openAgentModal(el.dataset.agent);
      };
      el.addEventListener('click', activate);
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate(e);
        }
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
      const since48 = new Date(Date.now() - 48 * 3600e3).toISOString();
      const todaySastStr = sastDateStr(new Date());
      const [{ data: staff }, { data: events }, { data: forgotEvents }, { data: absencesToday }] = await Promise.all([
        // Pull is_admin/is_super/designation so we can drop admins,
        // super admins, and managers — they're exempt from clock-in
        // tracking and shouldn't appear on the live floor or in
        // adherence stats.
        window.sb.from('staff')
          .select('id, name, active, is_admin, is_super, designation')
          .eq('active', true)
          .eq('is_admin', false)
          .eq('is_super', false)
          .not('designation', 'in', '(manager,super_admin)'),
        window.sb.from('events').select('staff_id, ts, dir')
          .gte('ts', monday.toISOString()).lte('ts', weekEnd.toISOString())
          .order('ts', { ascending: true }),
        window.sb.from('events').select('staff_id, ts')
          .or('note.ilike.%forgot%,note.ilike.%Auto clock-out%')
          .gte('ts', since48)
          .order('ts', { ascending: false }),
        window.sb.from('absences').select('staff_id,reason,reason_note').eq('date', todaySastStr),
      ]);
      const absencesTodayByStaff = new Map();
      (absencesToday || []).forEach(a => absencesTodayByStaff.set(a.staff_id, a));
      const forgotRecentByStaff = new Map();
      (forgotEvents || []).forEach(e => {
        if (!forgotRecentByStaff.has(e.staff_id)) forgotRecentByStaff.set(e.staff_id, e.ts);
      });
      const byStaff = new Map();
      (staff || []).forEach(s => byStaff.set(s.id, {
        id: s.id, name: s.name, days: {},
        designation: (s.designation || '').toLowerCase(),  // rm | ln | fancy | ... — powers the Live Floor role filter
        late: 0, early: 0, missed: 0, avgStartMin: null, avgEndMin: null,
        forgotRecentTs: forgotRecentByStaff.get(s.id) || null,
        absenceToday: absencesTodayByStaff.get(s.id) || null,
      }));
      (events || []).forEach(e => {
        const rec = byStaff.get(e.staff_id);
        if (!rec) return;
        const d = new Date(e.ts);
        // Bucket by SAST calendar date, NOT UTC. An event at SAST 00:30
        // (UTC 22:30 previous day) was previously bucketed against the
        // wrong date, making the early-morning shift "disappear".
        const key = sastDateStr(d);
        if (!rec.days[key]) rec.days[key] = { first: null, last: null, latestDir: null, latestTs: null };
        if (e.dir === 'in'  && !rec.days[key].first) rec.days[key].first = d;
        if (e.dir === 'out') rec.days[key].last = d;
        // Track the most-recent event regardless of direction. Mid-shift
        // team changes write a synthetic out+in pair; without this the
        // live floor would treat the agent as clocked out after the out
        // half and miss the immediately-following re-in.
        if (!rec.days[key].latestTs || d >= rec.days[key].latestTs) {
          rec.days[key].latestTs  = d;
          rec.days[key].latestDir = e.dir;
        }
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
  // SAST-anchored Monday 00:00 for the week containing `d`. Returns a Date
  // whose UTC instant is that SAST-midnight boundary (SAST is UTC+2 no DST,
  // so SAST 00:00 = UTC 22:00 the previous day). Using browser-local `getDay`
  // / `setHours` here — the naive prior implementation — produced the wrong
  // week bounds for admins outside SAST (a Perth admin at Monday 03:00 local
  // = Sunday 21:00 SAST would query the SUNDAY-anchored week and see
  // everyone as "Not in yet").
  function startOfThisWeek(d) {
    const sw = sastHourAndWeekday(d || new Date());
    // sastHourAndWeekday returns weekday with Sun=0..Sat=6. Convert to
    // Mon=0..Sun=6 to compute days-since-Monday.
    const daysSinceMon = (sw.weekday + 6) % 7;
    const todaySast = sastDateStr(d || new Date());
    // Roll back `daysSinceMon` days from SAST today.
    const [y, m, day] = todaySast.split('-').map(s => parseInt(s, 10));
    const monUtc = new Date(Date.UTC(y, m - 1, day) - (daysSinceMon * 86400e3) - 2 * 3600e3);
    return monUtc;
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
          .select('*')
          .eq('auth_user_id', user.id).maybeSingle();
        if (staff && (staff.is_admin || isPayrollLogin(staff)) && staff.active !== false) {
          setSession({
            id: staff.id, name: staff.name, role: staff.role || '', team: staff.team || '',
            admin: true, super: !!staff.is_super, payroll: isPayrollLogin(staff),
          });
          if (staff.is_super) tab = 'leadership';
          else if (isPayrollLogin(staff)) tab = 'payroll';
          loadScheduleData().then(() => {
            updateLiveFlagsBadge();
            if (tab === 'overview' || tab === 'leadership' || tab === 'payroll') shell();
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
          // staff_public: safe projection — flag-ack name lookup never needs rates.
          const { data: staff } = await window.sb.from('staff_public').select('id, name');
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
      // Best-effort lookup of staff names via safe projection.
      if (_staffNamesById.size === 0) {
        const { data: staff } = await window.sb.from('staff_public').select('id, name');
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
  let _teamSortBy = 'name';     // name | status | designation | lastClocked | forgot
  let _teamSortDir = 'asc';
  let _teamModal = null;        // form state when modal is open (staff + broker)
  let _brokerFilter = '';       // search box on the Brokers sub-view
  let _teamSubTab = 'staff';     // Staff tab sub-view: 'staff' | 'brokers' | 'contracts' (brokers/contracts super-only)
  let _forgotThisWeek = [];     // forgot-to-clock-out events since Monday SAST
  let _absencesToday = new Map(); // staff_id -> {reason, reason_note, marked_by, marked_at}
  let _absenceModal = null;     // { staffId, name, reason, note, busy, error } when open

  // Admin / Manager / Super Admin are exempt from clock-in expectations —
  // they're not callers, so we don't count them in 'on the clock' stats,
  // don't track forgot-to-clock-out for them, and skip schedule-adherence
  // checks. Designation-based so it survives a manager not having
  // is_admin set.
  function isExemptStaff(s) {
    if (!s) return false;
    if (s.is_super || s.is_admin) return true;
    const d = String(s.designation || '').toLowerCase();
    return d === 'super_admin' || d === 'manager' || d === 'payroll';
  }

  // Brokers are a separate class of account: they never clock in and only
  // exist so they can log into the HubSpot marketing dashboard. We treat a
  // row as a broker if the is_broker flag is set OR (legacy) its designation
  // is 'broker'. Brokers are shown ONLY on the super-only Brokers tab — never
  // in the Staff Directory — so managers never see them.
  function isBrokerRow(s) {
    if (!s) return false;
    return s.is_broker === true
        || String(s.designation || '').toLowerCase() === 'broker';
  }

  async function loadTeam() {
    if (!window.sb) return;
    _teamLoading = true;
    try {
      const todaySastStr = sastDateStr(new Date());
      const [{ data: staff, error }, { data: absences }] = await Promise.all([
        window.sb.from('staff').select('*').eq('active', true).order('name', { ascending: true }),
        window.sb.from('absences').select('staff_id,reason,reason_note,marked_by,marked_at').eq('date', todaySastStr),
      ]);
      if (error) throw error;
      _absencesToday = new Map();
      (absences || []).forEach(a => _absencesToday.set(a.staff_id, a));
      // One batched query for forgot-to-clock-out incidents in the last
      // 30 days — both admin-fixed ("Auto-corrected: forgot to clock out")
      // and self-corrected ("Auto clock-out after long shift…") rows.
      const since30 = new Date(Date.now() - 30 * 24 * 3600e3).toISOString();
      const { data: forgotEvents } = await window.sb
        .from('events').select('staff_id, ts')
        .or('note.ilike.%forgot%,note.ilike.%Auto clock-out%')
        .gte('ts', since30)
        .order('ts', { ascending: false });
      const forgotByStaff = new Map();
      // This-week digest (Mon..Sun SAST of the current week).
      const weekStart = startOfThisWeek(new Date());
      _forgotThisWeek = [];
      // Admin / Manager rows shouldn't appear in forgot-to-clock-out
      // tracking — they're exempt from the whole clock-in flow.
      const exemptIds = new Set((staff || []).filter(isExemptStaff).map(s => s.id));
      (forgotEvents || []).forEach(e => {
        if (exemptIds.has(e.staff_id)) return;
        forgotByStaff.set(e.staff_id, (forgotByStaff.get(e.staff_id) || 0) + 1);
        if (new Date(e.ts) >= weekStart) _forgotThisWeek.push(e);
      });
      // Single grouped query for the last 48h of events across the whole
      // roster, then derive each staffer's status client-side. Replaces
      // the previous N+1 pattern (one query per staff row) — ~50 round
      // trips collapse to 1. 48h is enough to catch any "still clocked
      // in from yesterday" case without pulling weeks of history.
      const since48 = new Date(Date.now() - 48 * 3600e3).toISOString();
      const { data: recentEvents } = await window.sb
        .from('events').select('staff_id, ts, dir')
        .gte('ts', since48)
        .order('ts', { ascending: false });
      const lastInByStaff  = new Map();
      const lastOutByStaff = new Map();
      (recentEvents || []).forEach(e => {
        if (e.dir === 'in'  && !lastInByStaff.has(e.staff_id))  lastInByStaff.set(e.staff_id, e.ts);
        if (e.dir === 'out' && !lastOutByStaff.has(e.staff_id)) lastOutByStaff.set(e.staff_id, e.ts);
      });
      const decorated = (staff || []).map((s) => {
        const lastIn  = lastInByStaff.get(s.id)  || '';
        const lastOut = lastOutByStaff.get(s.id) || '';
        const status = (lastIn && (!lastOut || lastIn > lastOut)) ? 'in' : 'out';
        return { ...s, status, lastIn, lastOut, forgotCount30d: forgotByStaff.get(s.id) || 0 };
      });
      decorated.sort((a, b) => {
        if (a.status !== b.status) return a.status === 'in' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
      _team = decorated;
    } catch (e) {
      console.warn('[team] load failed', e);
      _team = [];
    } finally {
      _teamLoading = false;
    }
  }

  // Segmented Staff sub-view toggle shown at the top of the Staff tab for
  // superusers only: Staff Directory, Brokers (login accounts), and Contracts
  // (Aqua Promotions agreement generator + progress). Each was/would otherwise
  // be a separate top-level tab; grouping them keeps the Staff area cohesive.
  function _staffSubToggle() {
    const segs = [
      ['staff',     'Staff Directory'],
      ['brokers',   'Brokers'],
      ['contracts', 'Contracts'],
    ];
    return `<div class="seg" id="staffSubSeg" role="group" aria-label="Staff section" style="margin-bottom:14px">
        ${segs.map(([id, label]) => {
          const on = _teamSubTab === id;
          return `<button class="${on ? 'active' : ''}" data-staff-subtab="${id}" aria-pressed="${on ? 'true' : 'false'}">${label}</button>`;
        }).join('')}
      </div>`;
  }

  function renderTeamView() {
    if (_team == null && !_teamLoading) {
      loadTeam().then(() => { if (tab === 'team') shell(); });
    }
    // The Brokers + Contracts sub-views are super-only. Non-supers never see the
    // toggle and are pinned to the staff roster.
    const canSub = !!(session && session.super);
    const subToggle = canSub ? _staffSubToggle() : '';
    if (canSub && _teamSubTab === 'brokers')   return renderBrokersView(subToggle);
    if (canSub && _teamSubTab === 'contracts') return renderAquaContracts(subToggle);
    // The Staff Directory never shows brokers — they live in the Brokers
    // sub-view. Filtering here (for everyone) keeps managers from ever
    // seeing a broker.
    const roster = (_team || []).filter(s => !isBrokerRow(s));
    const q = _teamFilter.trim().toLowerCase();
    const filtered = roster.filter(s =>
      !q || s.name.toLowerCase().includes(q)
         || (s.designation || '').toLowerCase().includes(q)
    );
    const desigLabel = (d) => ({
      super_admin:     'Super Admin',
      manager:         'Manager',
      rm:              'RM',
      fancy:           'Fancy',
      ln:              'LN',
      assistant:       'Assistant',
      admin_assistant: 'Admin Assistant',
      broker:          'Broker',
      rental_support:  'Rental Support',
      payroll:         'Payroll',
    }[d] || (d || '—'));
    // Status sort weight — on-the-clock first, then absent, then clocked
    // out, then never-showed, then exempt. Matches the natural triage
    // order an admin would scan.
    const statusWeight = (s) => {
      if (isExemptStaff(s)) return 5;
      if (s.status === 'in') return 1;
      if (_absencesToday.has(s.id)) return 2;
      const now = new Date();
      const cob = new Date(sastDateStr(now) + 'T17:00:00+02:00');
      const startOfTodaySAST = new Date(sastDateStr(now) + 'T00:00:00+02:00');
      const hasTodayEvent = s.lastIn && new Date(s.lastIn) >= startOfTodaySAST;
      if (!hasTodayEvent && now >= cob) return 4; // never showed
      return 3; // clocked out
    };
    const lastClockedTs = (s) => {
      const ti = s.lastIn  ? new Date(s.lastIn).getTime()  : 0;
      const to = s.lastOut ? new Date(s.lastOut).getTime() : 0;
      return Math.max(ti, to);
    };
    const sortKey = (s) => {
      switch (_teamSortBy) {
        case 'status':       return statusWeight(s);
        case 'designation':  return desigLabel(s.designation).toLowerCase();
        case 'lastClocked':  return lastClockedTs(s);
        case 'forgot':       return isExemptStaff(s) ? -1 : (s.forgotCount30d || 0);
        case 'name':
        default:             return s.name.toLowerCase();
      }
    };
    const dir = _teamSortDir === 'asc' ? 1 : -1;
    const rows = filtered.slice().sort((a, b) => {
      const av = sortKey(a), bv = sortKey(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return  1 * dir;
      // Stable secondary sort by name so equal-key rows have a deterministic order.
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    const sortIndic = (k) => {
      if (k !== _teamSortBy) return '<span class="muted" style="font-size:11px"> ⇅</span>';
      return _teamSortDir === 'asc'
        ? '<span style="color:var(--blue-800);font-size:11px"> ▲</span>'
        : '<span style="color:var(--blue-800);font-size:11px"> ▼</span>';
    };
    const sortTh = (k, label, cls) =>
      `<th class="${cls || ''}" style="cursor:pointer" data-team-sort="${k}">${escapeHtml(label)}${sortIndic(k)}</th>`;
    // Only count staff who are subject to clock-in (excludes admins,
    // super admins, and managers — they don't need to clock in).
    const trackable = roster.filter(s => !isExemptStaff(s));
    const onCount      = trackable.filter(s => s.status === 'in').length;
    const absentCount  = trackable.filter(s => _absencesToday.has(s.id)).length;
    const accountedFor = onCount + absentCount;
    const totalCount   = trackable.length;
    const missingCount = Math.max(0, totalCount - accountedFor);

    const rel = (iso) => {
      if (!iso) return '—';
      const t = new Date(iso).getTime();
      const m = Math.max(0, Math.round((Date.now() - t) / 60000));
      if (m < 60) return m + 'm ago';
      const h = Math.round(m / 60);
      return h < 24 ? h + 'h ago' : Math.round(h / 24) + 'd ago';
    };

    // Forgot-to-clock-out · this week digest. Aggregates rows from
    // _forgotThisWeek (populated by loadTeam) so admin sees who slipped
    // up over the current week at a glance.
    const nameById = new Map(roster.map(s => [s.id, s.name]));
    const weekByStaff = new Map();
    (_forgotThisWeek || []).forEach(e => {
      if (!weekByStaff.has(e.staff_id)) weekByStaff.set(e.staff_id, []);
      weekByStaff.get(e.staff_id).push(e.ts);
    });
    const weekRows = Array.from(weekByStaff.entries())
      .map(([id, tsList]) => ({ id, name: nameById.get(id) || id, count: tsList.length, dates: tsList }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const fmtShort = (iso) => new Date(iso).toLocaleDateString('en-GB',
      { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Johannesburg' });
    const weekHtml = weekRows.length === 0
      ? `<div class="muted" style="font-size:13px;line-height:1.6">Nobody has forgotten to clock out this week. 🎉</div>`
      : weekRows.map(r => `
          <div style="display:flex;align-items:center;gap:10px;padding:6px 0">
            <span class="pill ${r.count >= 2 ? 'bad' : 'warn'}" style="font-size:11px;padding:3px 9px;flex:0 0 auto">⚠️ ${r.count}×</span>
            <span style="font-weight:600;color:var(--ink);flex:0 0 auto">${escapeHtml(r.name)}</span>
            <span class="muted" style="font-size:12px">${r.dates.map(fmtShort).join(' · ')}</span>
          </div>`).join('');

    return `<div class="tab-view">
      ${subToggle}
      <div class="card card-pad" style="border-left:4px solid ${weekRows.length === 0 ? 'var(--green,#0E6B3A)' : '#8B1A1A'}">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:8px">
          <h3 style="margin:0;font-family:var(--serif);font-size:15px">Forgot to clock out · this week</h3>
          <span class="muted" style="font-size:12px">${_forgotThisWeek.length} incident${_forgotThisWeek.length === 1 ? '' : 's'} since Monday SAST</span>
        </div>
        ${weekHtml}
      </div>
      <div class="card card-pad mt">
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          <input id="teamSearch" type="search" placeholder="Search name or designation..."
                 value="${escapeHtml(_teamFilter)}"
                 style="flex:1;min-width:200px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font-family:Montserrat">
          <div class="muted" style="font-size:13px">
            <b style="color:var(--green)">${onCount}</b> on the clock
            ${absentCount > 0 ? ` · <b style="color:#6B3F00">${absentCount}</b> absent` : ''}
            ${missingCount > 0 ? ` · <b style="color:#8B1A1A">${missingCount}</b> not in yet` : ''}
            · <b>${totalCount}</b> active staff
          </div>
          <button class="btn btn-primary" id="teamAddBtn">${I.plus || '+'} Add staff</button>
        </div>
      </div>
      <div class="card mt">
        <div class="tbl-wrap"><table class="tbl tbl-sortable">
          <thead><tr>
            ${sortTh('name',        'Name')}
            ${sortTh('status',      'Status')}
            ${sortTh('designation', 'Designation')}
            ${sortTh('lastClocked', 'Last clocked')}
            <th class="num" style="cursor:pointer" data-team-sort="forgot" title="Times this staffer forgot to clock out in the last 30 days (admin-corrected or self-corrected events).">Forgot 30d${sortIndic('forgot')}</th>
            <th class="r"></th>
          </tr></thead>
          <tbody>
            ${_team == null ? '<tr><td colspan="6" class="muted" style="text-align:center;padding:30px">Loading…</td></tr>' :
              rows.length === 0 ? '<tr><td colspan="6" class="muted" style="text-align:center;padding:30px">No staff match.</td></tr>' :
              rows.map(s => {
                const exempt = isExemptStaff(s);
                const fc = exempt ? 0 : (s.forgotCount30d || 0);
                const fpill = exempt
                  ? `<span class="muted" style="font-size:11px">—</span>`
                  : (fc === 0 ? `<span class="muted tnum" style="font-size:12px">0</span>`
                              : `<span class="pill ${fc >= 3 ? 'bad' : 'warn'}" style="font-size:11px;padding:3px 9px" title="${fc} forgot-to-clock-out incident${fc === 1 ? '' : 's'} in the last 30 days">⚠️ ${fc}</span>`);
                // Today's status logic:
                //  - exempt rows: 'Exempt'
                //  - clocked in: 'On the clock'
                //  - absence marker today: 'Absent · <reason>'
                //  - no event today AND past 17:00 SAST AND not marked: 'Never showed'
                //  - clocked out at some point today / yesterday: 'Clocked out'
                const ab = _absencesToday.get(s.id);
                const cobDone = (() => {
                  const now = new Date();
                  const cob = new Date(sastDateStr(now) + 'T17:00:00+02:00');
                  return now >= cob;
                })();
                const startOfTodaySAST = new Date(sastDateStr(new Date()) + 'T00:00:00+02:00');
                const hasTodayEvent = s.lastIn && new Date(s.lastIn) >= startOfTodaySAST;
                let statusPill;
                if (exempt) {
                  statusPill = `<span class="pill" style="font-size:11px;padding:3px 9px;background:#EEF0F6;color:#7A8499" title="Admins and managers are exempt from clock-in tracking">Exempt</span>`;
                } else if (ab) {
                  const noteSfx = ab.reason_note ? ' — ' + escapeHtml(ab.reason_note) : '';
                  statusPill = `<span class="pill" style="font-size:11px;padding:3px 9px;background:#FFE9CB;color:#6B3F00" title="Marked absent today · ${escapeHtml(ab.reason)}${noteSfx}">Absent · ${escapeHtml(ab.reason)}</span>`;
                } else if (s.status === 'in') {
                  statusPill = `<span class="pill ok" style="font-size:11px;padding:3px 9px">● On the clock</span>`;
                } else if (!hasTodayEvent && cobDone) {
                  statusPill = `<span class="pill bad" style="font-size:11px;padding:3px 9px" title="No clock-in event today and no absence marker">⚠️ Never showed</span>`;
                } else {
                  statusPill = `<span class="pill" style="font-size:11px;padding:3px 9px">Clocked out</span>`;
                }
                const lastCell = exempt
                  ? `<span class="muted" style="font-size:12.5px">—</span>`
                  : (ab ? '<span class="muted" style="font-size:12.5px">—</span>'
                        : (s.status === 'in' ? 'in ' + rel(s.lastIn) : (s.lastOut ? 'out ' + rel(s.lastOut) : '—')));
                // Action buttons. Login-detail editing lives in the
                // Clocks tab (the quay-clock admin iframe). On Staff
                // Directory we only surface absence-related actions:
                //   - absent today: Unmark + Edit (edits the absence)
                //   - clocked out: Mark absent
                //   - on the clock / exempt: no buttons
                const actionBtn = exempt
                  ? ''
                  : (ab
                      ? `<button class="btn small" data-unmark-absent-id="${escapeHtml(s.id)}" title="Unmark absent">Unmark</button>
                         <button class="btn small" data-edit-absent-id="${escapeHtml(s.id)}" data-edit-absent-name="${escapeHtml(s.name)}" title="Edit absence (reason, note, range)">Edit</button>`
                      : (s.status === 'in'
                          ? ''
                          : `<button class="btn small" data-mark-absent-id="${escapeHtml(s.id)}" data-mark-absent-name="${escapeHtml(s.name)}" title="Mark absent today">Mark absent</button>`));
                return `<tr>
                <td><div class="agent-cell"><div class="avatar">${escapeHtml(initialsOf(s.name))}</div>
                  <div class="agent-name">${escapeHtml(s.name)}</div></div></td>
                <td>${statusPill}</td>
                <td>${escapeHtml(desigLabel(s.designation))}</td>
                <td class="muted tnum" style="font-size:12.5px">${lastCell}</td>
                <td class="num">${fpill}</td>
                <td class="r" style="display:flex;gap:6px;justify-content:flex-end">${actionBtn}</td>
              </tr>`;}).join('')}
          </tbody>
        </table></div>
      </div>
      ${_teamModal ? renderTeamModal() : ''}
      ${_absenceModal ? renderAbsenceModal() : ''}
    </div>`;
  }

  // ─── Mark-absent modal ──────────────────────────────────────────────
  const ABSENCE_REASONS = ['Sick', 'Personal', 'Family', 'Approved leave', 'Other'];

  function _dayCount(startStr, endStr) {
    if (!startStr || !endStr) return 0;
    const a = new Date(startStr + 'T00:00:00');
    const b = new Date(endStr   + 'T00:00:00');
    if (isNaN(a) || isNaN(b) || b < a) return 0;
    return Math.round((b - a) / 86400000) + 1;
  }

  function renderAbsenceModal() {
    const f = _absenceModal;
    const busy = f.busy;
    const opts = ABSENCE_REASONS.map(r =>
      `<option value="${escapeHtml(r)}" ${f.reason === r ? 'selected' : ''}>${escapeHtml(r)}</option>`
    ).join('');
    const days = _dayCount(f.startDate, f.endDate);
    const cta = busy ? 'Saving…' : (days === 1 ? 'Confirm absent' : `Confirm absent · ${days} days`);
    const title = f.mode === 'edit' ? 'Edit absence' : 'Mark absent';
    return `<div class="modal-back" id="absenceModalBack"></div>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="absenceModalTitle" style="width:min(440px, calc(100vw - 32px))">
        <div class="modal-head">
          <h3 id="absenceModalTitle" style="margin:0">${title} · ${escapeHtml(f.name)}</h3>
          <button class="modal-close" id="absenceModalClose" aria-label="Close" title="Close">×</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:12px">
          <label class="field"><span>Reason</span>
            <select id="absReason">${opts}</select>
          </label>
          <label class="field"><span>Note (optional)</span>
            <input id="absNote" type="text" value="${escapeHtml(f.note || '')}" placeholder="e.g. flu, dr's note coming">
          </label>
          <div style="display:flex;gap:10px">
            <label class="field" style="flex:1"><span>Start date</span>
              <input id="absStart" type="date" value="${escapeHtml(f.startDate)}">
            </label>
            <label class="field" style="flex:1"><span>End date</span>
              <input id="absEnd" type="date" value="${escapeHtml(f.endDate)}">
            </label>
          </div>
          <div class="muted" style="font-size:12px;margin-top:-4px">
            ${days > 1 ? `Writes one absence row per day (${days} rows total). Each day can be unmarked individually if they come in early.` : 'Single-day absence. Pick a later End date for sick-leave / approved-leave spans.'}
          </div>
          ${f.error ? `<div class="banner" style="background:#FFE0E0;color:#8B1A1A;padding:8px 10px;border-radius:6px;font-size:12.5px">${escapeHtml(f.error)}</div>` : ''}
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:6px">
            <button class="btn" id="absCancel" ${busy ? 'disabled' : ''}>Cancel</button>
            <button class="btn btn-primary" id="absConfirm" ${busy ? 'disabled' : ''}>${cta}</button>
          </div>
        </div>
      </div>`;
  }

  async function saveAbsence(staffId) {
    const f = _absenceModal;
    if (!f || f.busy) return;
    const reason = (document.getElementById('absReason') || {}).value || 'Other';
    const note   = ((document.getElementById('absNote') || {}).value || '').trim();
    const startStr = (document.getElementById('absStart') || {}).value || f.startDate;
    const endStr   = (document.getElementById('absEnd')   || {}).value || f.endDate;
    const me = session && session.id ? session.id : null;
    if (!me) { f.error = 'No active session — cannot stamp marked_by.'; shell(); return; }
    // Parse the picked YYYY-MM-DD as a pure date — no time component, no
    // timezone conversion. Building rows via `new Date(s + 'T00:00:00')`
    // anchored each day to *local SAST midnight*, then
    // `d.toISOString().slice(0,10)` re-rendered it as the UTC date —
    // silently shifting every absence back by one day (the SAST 29th
    // landed in the DB as 2026-06-28). Now we increment a [y,m,d] tuple
    // directly so the string the user picked is the string we write.
    const splitYmd = (s) => s.split('-').map(Number);
    const [sy, sm, sd] = splitYmd(startStr);
    const [ey, em, ed] = splitYmd(endStr);
    if (!sy || !sm || !sd || !ey || !em || !ed) {
      f.error = 'Pick valid Start and End dates.'; shell(); return;
    }
    // Build comparable Date objects in UTC just for the < check, since
    // we never use them to format the row dates.
    const startUtc = Date.UTC(sy, sm - 1, sd);
    const endUtc   = Date.UTC(ey, em - 1, ed);
    if (endUtc < startUtc) { f.error = 'End date must be on or after Start date.'; shell(); return; }
    if (_dayCount(startStr, endStr) > 60) {
      f.error = 'Range is over 60 days — split into shorter spans if intentional.';
      shell(); return;
    }
    const _pad = (n) => String(n).padStart(2, '0');
    const rows = [];
    // Walk the [y,m,d] tuple day-by-day. Constructing a Date in UTC and
    // bumping its UTCDate keeps month-boundary rollovers correct without
    // tripping over local timezone offsets.
    for (let t = startUtc; t <= endUtc; t += 24 * 3600 * 1000) {
      const d = new Date(t);
      rows.push({
        staff_id: staffId,
        date:     `${d.getUTCFullYear()}-${_pad(d.getUTCMonth()+1)}-${_pad(d.getUTCDate())}`,
        reason,
        reason_note: note || null,
        marked_by:   me,
      });
    }
    f.busy = true; f.error = ''; shell();
    try {
      const { error } = await window.sb.from('absences').upsert(rows, { onConflict: 'staff_id,date' });
      if (error) throw error;
      _absenceModal = null;
      _team = null; // force reload to pick up the new absence(s)
      shell();
      loadTeam().then(() => { if (tab === 'team') shell(); });
    } catch (e) {
      f.busy = false;
      f.error = String(e.message || e);
      shell();
    }
  }

  async function unmarkAbsence(staffId) {
    try {
      const todaySastStr = sastDateStr(new Date());
      const { error } = await window.sb.from('absences')
        .delete().eq('staff_id', staffId).eq('date', todaySastStr);
      if (error) throw error;
      _team = null;
      shell();
      loadTeam().then(() => { if (tab === 'team') shell(); });
    } catch (e) {
      console.warn('[absence] unmark failed', e);
      alert('Could not unmark: ' + (e.message || e));
    }
  }

  function initialsOf(name) {
    return String(name || '?').split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
  }

  function renderTeamModal() {
    const f = _teamModal;
    const isEdit  = f.mode === 'edit';
    const isSuper = !!(session && session.super);
    const isBrokerModal = f.kind === 'broker';

    // Full designation set (brokers are managed on the Brokers tab, so they're
    // deliberately absent here). Managers may only pick the caller/support
    // roles below; everything else is superuser-only.
    const ALL_DESIG = [
      ['super_admin',     'Super Admin'],
      ['manager',         'Manager'],
      ['rm',              'RM (Relationship Manager)'],
      ['fancy',           'Fancy Caller'],
      ['ln',              'LN (Lead Nurturer)'],
      ['assistant',       'Assistant'],
      ['admin_assistant', 'Admin Assistant'],
      ['rental_support',  'Rental Support'],
      ['payroll',         'Payroll (dashboard access)'],
    ];
    const MGR_DESIG = ['rm', 'fancy', 'ln', 'assistant', 'admin_assistant'];
    let desigOpts = isSuper ? ALL_DESIG : ALL_DESIG.filter(([v]) => MGR_DESIG.includes(v));
    // Managers may set salary + hourly rate when ADDING staff (adds run
    // through the service-role Edge Function). Editing pay stays super-only.
    const showPay = !isBrokerModal && (isSuper || f.mode === 'add');
    // Edit-mode safety net: if we're editing someone whose current designation
    // is outside the manager-allowed set, keep it in the list so saving does
    // not silently change it (the value stays disabled-in-spirit — the DB
    // trigger still rejects a non-super trying to change it).
    if (isEdit && f.designation && !desigOpts.some(([v]) => v === f.designation)) {
      const lbl = (ALL_DESIG.find(([v]) => v === f.designation) || [f.designation, f.designation])[1];
      desigOpts = [[f.designation, lbl], ...desigOpts];
    }

    const title = isBrokerModal
      ? (isEdit ? 'Edit broker · ' + escapeHtml(f.name) : 'Add a broker')
      : (isEdit ? 'Edit ' + escapeHtml(f.name)          : 'Add a staff member');
    const saveLabel = isBrokerModal
      ? (isEdit ? 'Save changes' : 'Add broker')
      : (isEdit ? 'Save changes' : 'Add staff');

    return `<div class="modal-back" id="teamModalBack"></div>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="teamModalTitle" style="width:min(560px, calc(100vw - 32px))">
        <div class="modal-head">
          <h3 id="teamModalTitle" style="margin:0">${title}</h3>
          <button class="modal-close" id="teamModalClose" aria-label="Close" title="Close">×</button>
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
          ${isBrokerModal ? `
          <label class="field"><span>Work email</span>
            <input id="tmEmail" type="email" value="${escapeHtml(f.email || '')}" placeholder="name@quay1.co.za" autocapitalize="off">
            <div class="muted" style="font-size:11px;margin-top:3px">Real @quay1.co.za address — used to match their recruitment candidates on the HubSpot dashboard.</div>
          </label>
          ` : `
          <label class="field"><span>Designation</span>
            <select id="tmDesignation">
              ${desigOpts.map(([v, l]) => `<option value="${v}" ${f.designation === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </label>
          ${showPay ? `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <label class="field"><span>Hourly rate (R)</span>
              <input id="tmRate" type="number" step="0.01" min="0" value="${escapeHtml(f.hourly_rate)}" placeholder="e.g. 75.00">
            </label>
            <label class="field"><span>Weekly hours</span>
              <input id="tmHours" type="number" step="0.5" min="0" max="80" value="${escapeHtml(f.weekly_hours)}" placeholder="e.g. 40">
            </label>
          </div>
          <label class="field"><span>Monthly salary (R)</span>
            <input id="tmSalary" type="number" step="0.01" min="0" value="${escapeHtml(f.salary)}" placeholder="e.g. 12000.00">
          </label>
          ` : ''}
          ${isSuper ? `
          <label style="display:flex;align-items:center;gap:8px;font-size:13.5px">
            <input id="tmAdmin" type="checkbox" ${f.admin ? 'checked' : ''}>
            <span>Admin — can open the manager dashboard</span>
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:13.5px">
            <input id="tmSuper" type="checkbox" ${f.super ? 'checked' : ''}>
            <span>Superuser — can also see Leadership</span>
          </label>
          ` : ''}
          `}
          ${f.error ? `<div class="banner" style="display:block">${escapeHtml(f.error)}</div>` : ''}
        </div>
        <div class="modal-foot">
          <button class="btn" id="teamModalCancel">Cancel</button>
          <button class="btn btn-primary" id="teamModalSave" ${f.busy ? 'disabled' : ''}>${f.busy ? 'Saving…' : saveLabel}</button>
        </div>
      </div>`;
  }

  function wireTeamView() {
    // Staff/Brokers sub-tab toggle (super-only). Switching re-renders the tab.
    document.querySelectorAll('#staffSubSeg button[data-staff-subtab]').forEach(b => {
      b.addEventListener('click', () => {
        const v = b.dataset.staffSubtab;
        if (v && v !== _teamSubTab) { _teamSubTab = v; shell(); }
      });
    });
    // When the Brokers sub-view is showing, its wiring is entirely separate
    // from the staff roster — delegate and skip the staff handlers below.
    if (session && session.super && _teamSubTab === 'brokers')   { wireBrokersView();  return; }
    if (session && session.super && _teamSubTab === 'contracts') { wireAquaContracts(); return; }
    const search = document.getElementById('teamSearch');
    if (search) search.addEventListener('input', (e) => {
      _teamFilter = e.target.value;
      const caret = e.target.selectionStart;
      // shell() wipes the DOM — restore focus + caret on the fresh input
      // so the user can keep typing without reclicking.
      shell();
      const s2 = document.getElementById('teamSearch');
      if (s2) {
        s2.focus();
        try { s2.setSelectionRange(caret, caret); } catch (_) {}
      }
    });
    document.querySelectorAll('th[data-team-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const k = th.dataset.teamSort;
        if (_teamSortBy === k) {
          _teamSortDir = _teamSortDir === 'asc' ? 'desc' : 'asc';
        } else {
          _teamSortBy = k;
          // Numeric / time columns default to desc (highest first);
          // alpha columns default to asc.
          _teamSortDir = (k === 'lastClocked' || k === 'forgot' || k === 'status') ? 'desc' : 'asc';
        }
        shell();
      });
    });
    const addBtn = document.getElementById('teamAddBtn');
    if (addBtn) addBtn.addEventListener('click', () => {
      _teamModal = {
        mode: 'add', name: '', id: '', pin: '',
        // Managers pick from RM/Fancy/LN/Assistant/Admin Assistant; default
        // them to RM. Supers keep the wider default of Fancy Caller.
        designation: (session && session.super) ? 'fancy' : 'rm',
        hourly_rate: '', weekly_hours: '', salary: '',
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
          salary:       s.salary       != null ? String(s.salary)       : '',
          admin: !!s.is_admin, super: !!s.is_super,
          busy: false, error: '',
        };
        shell();
      });
    });
    document.querySelectorAll('button[data-mark-absent-id]').forEach(b => {
      b.addEventListener('click', () => {
        const today = sastDateStr(new Date());
        _absenceModal = {
          mode: 'create',
          staffId: b.dataset.markAbsentId,
          name:    b.dataset.markAbsentName,
          reason:  'Sick',
          note:    '',
          startDate: today,
          endDate:   today,
          busy: false, error: '',
        };
        shell();
      });
    });
    document.querySelectorAll('button[data-edit-absent-id]').forEach(b => {
      b.addEventListener('click', () => {
        const today = sastDateStr(new Date());
        const ab = _absencesToday.get(b.dataset.editAbsentId) || {};
        _absenceModal = {
          mode: 'edit',
          staffId: b.dataset.editAbsentId,
          name:    b.dataset.editAbsentName,
          reason:  ab.reason || 'Sick',
          note:    ab.reason_note || '',
          startDate: today,
          endDate:   today,
          busy: false, error: '',
        };
        shell();
      });
    });
    document.querySelectorAll('button[data-unmark-absent-id]').forEach(b => {
      b.addEventListener('click', () => {
        if (confirm('Unmark this person as absent today?')) {
          unmarkAbsence(b.dataset.unmarkAbsentId);
        }
      });
    });
    if (_teamModal) wireTeamModal();
    if (_absenceModal) wireAbsenceModal();
  }

  // Inline modals (absence/team) re-render through shell() on every keystroke,
  // so we can't hold a stable trigger reference to restore focus to. We still
  // deliver the core WCAG needs: move focus into the dialog once on open, trap
  // Tab within it, and wire Esc-to-close.
  function wireInlineModal(stateObj, dialogEl, closeFn) {
    if (!dialogEl) return;
    const SEL = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const list = () => Array.from(dialogEl.querySelectorAll(SEL)).filter(el => el.offsetParent !== null);
    if (stateObj && !stateObj._focused) {
      stateObj._focused = true;
      const first = list()[0];
      if (first) first.focus();
    }
    dialogEl.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); closeFn(); return; }
      if (e.key !== 'Tab') return;
      const f = list();
      if (!f.length) return;
      const a = f[0], b = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
      else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
    });
  }

  function wireAbsenceModal() {
    const close = () => { _absenceModal = null; shell(); };
    const back = document.getElementById('absenceModalBack');
    const x    = document.getElementById('absenceModalClose');
    wireInlineModal(_absenceModal, x ? x.closest('.modal') : null, close);
    const cnl  = document.getElementById('absCancel');
    const ok   = document.getElementById('absConfirm');
    if (back) back.addEventListener('click', close);
    if (x)    x.addEventListener('click', close);
    if (cnl)  cnl.addEventListener('click', close);
    if (ok)   ok.addEventListener('click', () => saveAbsence(_absenceModal.staffId));
    // Keep modal state in sync with date inputs so the day-count CTA
    // updates as the manager picks dates. If End < Start, auto-bump
    // End to match Start (most common intent).
    const sd = document.getElementById('absStart');
    const ed = document.getElementById('absEnd');
    if (sd) sd.addEventListener('change', () => {
      _absenceModal.startDate = sd.value;
      if (_absenceModal.endDate && _absenceModal.endDate < sd.value) _absenceModal.endDate = sd.value;
      shell();
    });
    if (ed) ed.addEventListener('change', () => {
      _absenceModal.endDate = ed.value;
      shell();
    });
  }

  function wireTeamModal() {
    const f = _teamModal;
    const close = () => { _teamModal = null; shell(); };
    const tmClose = document.getElementById('teamModalClose');
    wireInlineModal(_teamModal, tmClose ? tmClose.closest('.modal') : null, close);
    document.getElementById('teamModalBack').addEventListener('click', close);
    tmClose.addEventListener('click', close);
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
    // The following inputs only render for superuser staff modals (and none
    // render for the broker modal), so every lookup is null-guarded.
    const email = document.getElementById('tmEmail');
    if (email) email.addEventListener('input', (e) => { f.email = e.target.value; });
    const desig = document.getElementById('tmDesignation');
    if (desig) desig.addEventListener('change', (e) => {
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
    const rate  = document.getElementById('tmRate');
    if (rate)  rate.addEventListener('input',  (e) => { f.hourly_rate  = e.target.value; });
    const hours = document.getElementById('tmHours');
    if (hours) hours.addEventListener('input', (e) => { f.weekly_hours = e.target.value; });
    const salary = document.getElementById('tmSalary');
    if (salary) salary.addEventListener('input', (e) => { f.salary = e.target.value; });
    const adm2 = document.getElementById('tmAdmin');
    if (adm2) adm2.addEventListener('change',(e) => { f.admin = e.target.checked; });
    const sup2 = document.getElementById('tmSuper');
    if (sup2) sup2.addEventListener('change',(e) => { f.super = e.target.checked; });
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
    const isBrokerModal = f.kind === 'broker';
    f.busy = true; shell();
    try {
      if (f.mode === 'add') {
        // Call the same admin-create-staff Edge Function the clock admin uses.
        const { data: { session: s } } = await window.sb.auth.getSession();
        if (!s) throw new Error('Not signed in');
        const payload = { id: f.id.trim() || f.name, name: f.name.trim(), pin: f.pin };
        if (isBrokerModal) {
          // Brokers never clock in and get no admin/super rights — they only
          // exist to log into the HubSpot marketing dashboard.
          payload.designation = 'broker';
          payload.is_broker   = true;
          payload.admin       = false;
          payload.is_super    = false;
          payload.email       = (f.email || '').trim() || null;
        } else {
          payload.admin        = !!f.admin;
          payload.is_super     = !!f.super;
          payload.hourly_rate  = f.hourly_rate  === '' ? null : Number(f.hourly_rate);
          payload.weekly_hours = f.weekly_hours === '' ? null : Number(f.weekly_hours);
          payload.salary       = f.salary       === '' ? null : Number(f.salary);
          payload.designation  = f.designation || null;
        }
        const res = await fetch(`${CFG.SUPABASE_URL}/functions/v1/admin-create-staff`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${s.access_token}`,
            'apikey': CFG.SUPABASE_ANON_KEY,
          },
          body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.ok === false) throw new Error(body.error || 'Could not create staff');
      } else {
        // Direct PATCH for non-PIN fields — RLS allows it for admins.
        const patch = isBrokerModal
          ? {
              name: f.name.trim(),
              designation: 'broker', is_broker: true,
              email: (f.email || '').trim() || null,
            }
          : {
              name: f.name.trim(),
              is_admin: !!f.admin, is_super: !!f.super,
              designation: f.designation || null,
              hourly_rate:  f.hourly_rate  === '' ? null : Number(f.hourly_rate),
              weekly_hours: f.weekly_hours === '' ? null : Number(f.weekly_hours),
              salary:       f.salary       === '' ? null : Number(f.salary),
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

  // ---------------------------------------------------- BROKERS (super-only)
  // Brokers are login-only accounts for the HubSpot marketing dashboard — no
  // clock-in, no payroll. They live in the staff table (is_broker=true) and
  // reuse the shared add/edit modal in its 'broker' flavour.
  function renderBrokersView(subToggle = '') {
    if (_team == null && !_teamLoading) {
      loadTeam().then(() => { if (tab === 'team') shell(); });
    }
    const q = _brokerFilter.trim().toLowerCase();
    const all = (_team || []).filter(isBrokerRow);
    const brokers = all
      .filter(s => !q || s.name.toLowerCase().includes(q)
                      || (s.email || '').toLowerCase().includes(q)
                      || String(s.id || '').toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const total = all.length;
    const rowsHtml = _team == null
      ? '<tr><td colspan="4" class="muted" style="text-align:center;padding:30px">Loading…</td></tr>'
      : brokers.length === 0
        ? `<tr><td colspan="4" class="muted" style="text-align:center;padding:30px">${total === 0 ? 'No brokers yet. Add one to give them HubSpot dashboard access.' : 'No brokers match.'}</td></tr>`
        : brokers.map(s => {
            const active = s.active !== false;
            const statusPill = active
              ? '<span class="pill ok" style="font-size:11px;padding:3px 9px">Active</span>'
              : '<span class="pill" style="font-size:11px;padding:3px 9px;background:#EEF0F6;color:#7A8499">Disabled</span>';
            const emailCell = s.email
              ? escapeHtml(s.email)
              : '<span class="muted" style="font-size:12px">— no email —</span>';
            return `<tr>
              <td><div class="agent-cell"><div class="avatar">${escapeHtml(initialsOf(s.name))}</div>
                <div class="agent-name">${escapeHtml(s.name)}</div></div></td>
              <td class="muted tnum" style="font-size:12.5px">${escapeHtml(s.id || '')}</td>
              <td style="font-size:12.5px">${emailCell}</td>
              <td class="r" style="display:flex;gap:6px;justify-content:flex-end;align-items:center">${statusPill}
                <button class="btn small" data-edit-broker-id="${escapeHtml(s.id)}">Edit</button></td>
            </tr>`;
          }).join('');
    return `<div class="tab-view">
      ${subToggle}
      <div class="card card-pad" style="border-left:4px solid var(--blue-800,#1B3A6B)">
        <h3 style="margin:0;font-family:var(--serif);font-size:15px">Broker logins</h3>
        <div class="muted" style="font-size:12.5px;margin-top:4px">These accounts sign into the HubSpot marketing dashboard only. They never clock in and have no payroll or performance tracking.</div>
      </div>
      <div class="card card-pad mt">
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          <input id="brokerSearch" type="search" placeholder="Search name, email or username..."
                 value="${escapeHtml(_brokerFilter)}"
                 style="flex:1;min-width:200px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font-family:Montserrat">
          <div class="muted" style="font-size:13px"><b>${total}</b> broker${total === 1 ? '' : 's'}</div>
          <button class="btn btn-primary" id="brokerAddBtn">${I.plus || '+'} Add broker</button>
        </div>
      </div>
      <div class="card mt">
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Name</th><th>Username</th><th>Email</th><th class="r"></th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table></div>
      </div>
      ${_teamModal ? renderTeamModal() : ''}
    </div>`;
  }

  function wireBrokersView() {
    const search = document.getElementById('brokerSearch');
    if (search) search.addEventListener('input', (e) => {
      _brokerFilter = e.target.value;
      const caret = e.target.selectionStart;
      shell();
      const again = document.getElementById('brokerSearch');
      if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch {} }
    });
    const addBtn = document.getElementById('brokerAddBtn');
    if (addBtn) addBtn.addEventListener('click', () => {
      _teamModal = {
        kind: 'broker', mode: 'add',
        name: '', id: '', pin: '', email: '',
        designation: 'broker', is_broker: true,
        admin: false, super: false,
        busy: false, error: '',
      };
      shell();
    });
    document.querySelectorAll('button[data-edit-broker-id]').forEach(b => {
      b.addEventListener('click', () => {
        const s = (_team || []).find(x => x.id === b.dataset.editBrokerId);
        if (!s) return;
        _teamModal = {
          kind: 'broker', mode: 'edit',
          id: s.id, name: s.name, pin: '', email: s.email || '',
          designation: 'broker', is_broker: true,
          admin: false, super: false,
          busy: false, error: '',
        };
        shell();
      });
    });
    if (_teamModal) wireTeamModal();
  }

  // ---------------------------------------------------- AQUA CONTRACTS (super-only)
  // Aqua Promotions (Pty) Ltd agreement generator + progress. Talks to a
  // standalone Apps Script web app (CFG.AQUA_ENDPOINT), completely separate from
  // the Quay 1 recruitment/broker pipeline. Auth is the logged-in user's Supabase
  // JWT, verified server-side (admins/supers only) — no shared secret ships in
  // this public JS. The list is managed by direct DOM injection (never a shell()
  // re-render) so the form inputs are preserved while the user types.

  async function _aquaFetch(payload) {
    const { data } = await window.sb.auth.getSession();
    const accessToken = data && data.session ? data.session.access_token : null;
    if (!accessToken) throw new Error('Not signed in.');
    const res = await fetch(CFG.AQUA_ENDPOINT, {
      method: 'POST',
      // text/plain keeps it a "simple" request (no CORS preflight, which Apps
      // Script web apps reject).
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ accessToken }, payload)),
    });
    return res.json();
  }

  function renderAquaContracts(subToggle = '') {
    const teal = '#0F766E';
    return `<div class="tab-view">
      ${subToggle}
      <div class="card card-pad" style="border-left:4px solid ${teal}">
        <h3 style="margin:0;font-family:var(--serif);font-size:15px">Aqua Promotions contracts</h3>
        <div class="muted" style="font-size:12.5px;margin-top:4px">Generate a Memorandum of Agreement for Aqua Promotions (Pty) Ltd. Kept completely separate from the Quay 1 broker contracts.</div>
      </div>

      <div class="card card-pad mt">
        <div id="aquaFormMsg"></div>
        <label class="field"><span>Full name</span>
          <input id="aqName" type="text" autocomplete="off" placeholder="e.g. Jane Doe"></label>
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          <label class="field" style="flex:1;min-width:200px"><span>ID number</span>
            <input id="aqId" type="text" inputmode="numeric" autocomplete="off" placeholder="13-digit SA ID"></label>
          <label class="field" style="flex:1;min-width:200px"><span>Start date</span>
            <input id="aqStart" type="date"></label>
        </div>
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          <label class="field" style="flex:1;min-width:200px"><span>Remuneration (rand, pro-rata)</span>
            <input id="aqRem" type="text" autocomplete="off" placeholder="e.g. 8000"></label>
          <label class="field" style="flex:1;min-width:200px"><span>Contractor email <span class="muted" style="font-weight:400">(optional)</span></span>
            <input id="aqEmail" type="email" autocomplete="off" placeholder="Leave blank to only file the PDF"></label>
        </div>
        <div class="muted" style="font-size:12px;margin:-4px 0 12px">Entered as a rand amount (formatted R8,000.00 on a pro-rata basis). If an email is given, the contractor is emailed their agreement with Aqua Promotions branding.</div>
        <button class="btn btn-primary" id="aquaGenBtn" style="background:${teal}">Generate agreement</button>
      </div>

      <div class="card mt">
        <div class="card-pad" style="display:flex;align-items:center;gap:12px;padding-bottom:0">
          <strong style="font-size:14px">Generated contracts</strong>
          <span id="aquaCount" class="muted" style="font-size:12.5px"></span>
          <button class="btn small" id="aquaRefreshBtn" style="margin-left:auto">Refresh</button>
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th>Name</th><th>ID</th><th>Start</th><th>Remuneration</th>
            <th>Status</th><th>Created</th><th class="r"></th>
          </tr></thead>
          <tbody id="aquaListBody">
            <tr><td colspan="7" class="muted" style="text-align:center;padding:30px">Loading…</td></tr>
          </tbody>
        </table></div>
      </div>
    </div>`;
  }

  function wireAquaContracts() {
    const msg = (kind, text) => {
      const m = document.getElementById('aquaFormMsg');
      if (!m) return;
      const bg = kind === 'err' ? '#FDECEA' : '#E6F4F1';
      const fg = kind === 'err' ? '#B42318' : '#0B5A54';
      const bd = kind === 'err' ? '#F5C6C0' : '#CDE8E2';
      m.innerHTML = text
        ? `<div style="padding:12px 14px;border-radius:10px;font-size:14px;margin:0 0 14px;background:${bg};color:${fg};border:1px solid ${bd}">${escapeHtml(text)}</div>`
        : '';
    };
    const errRow = (e) => `<tr><td colspan="7" class="muted" style="text-align:center;padding:24px;color:#B42318">Error: ${escapeHtml(String(e))}</td></tr>`;

    function statusPill(s) {
      if (s === 'Signed')     return '<span class="pill ok" style="font-size:11px;padding:3px 9px">Signed</span>';
      if (s === 'Draft sent') return '<span class="pill" style="font-size:11px;padding:3px 9px;background:#E6F4F1;color:#0B5A54">Draft sent</span>';
      return `<span class="pill" style="font-size:11px;padding:3px 9px;background:#EEF2F1;color:#3C4A48">${escapeHtml(s || 'Generated')}</span>`;
    }

    function renderRows(rows) {
      const count = document.getElementById('aquaCount');
      if (count) count.textContent = rows.length + (rows.length === 1 ? ' contract' : ' contracts');
      const body = document.getElementById('aquaListBody');
      if (!body) return;
      if (!rows.length) { body.innerHTML = '<tr><td colspan="7" class="muted" style="text-align:center;padding:30px">No contracts yet.</td></tr>'; return; }
      body.innerHTML = rows.map(r => {
        const actions = [];
        if (r.pdfUrl) actions.push(`<a href="${escapeHtml(r.pdfUrl)}" target="_blank" rel="noopener">PDF</a>`);
        if (r.status !== 'Signed') actions.push(`<a href="#" data-aqua-sign="${escapeHtml(r.folderId)}">Mark signed</a>`);
        return `<tr>
          <td><div class="agent-cell"><div class="avatar">${escapeHtml(initialsOf(r.full_name))}</div>
            <div class="agent-name">${escapeHtml(r.full_name)}${r.email ? `<div class="muted" style="font-size:11.5px;font-weight:400">${escapeHtml(r.email)}</div>` : ''}</div></div></td>
          <td class="muted tnum" style="font-size:12.5px">${escapeHtml(r.id_number)}</td>
          <td style="font-size:12.5px">${escapeHtml(r.start_date)}</td>
          <td style="font-size:12.5px">${escapeHtml(r.remuneration)}</td>
          <td>${statusPill(r.status)}</td>
          <td class="muted tnum" style="font-size:12px">${escapeHtml(r.created)}</td>
          <td class="r" style="white-space:nowrap;font-size:12.5px">${actions.join(' · ')}</td>
        </tr>`;
      }).join('');
      body.querySelectorAll('a[data-aqua-sign]').forEach(a => {
        a.addEventListener('click', async (ev) => {
          ev.preventDefault();
          if (!confirm('Mark this contract as signed?')) return;
          try {
            const res = await _aquaFetch({ kind: 'mark_signed', folderId: a.getAttribute('data-aqua-sign') });
            if (res.ok) loadList(); else msg('err', 'Error: ' + (res.error || 'unknown'));
          } catch (e) { msg('err', 'Network error: ' + e); }
        });
      });
    }

    async function loadList() {
      const body = document.getElementById('aquaListBody');
      if (body) body.innerHTML = '<tr><td colspan="7" class="muted" style="text-align:center;padding:30px">Loading…</td></tr>';
      try {
        const res = await _aquaFetch({ kind: 'list' });
        if (!res.ok) { if (body) body.innerHTML = errRow(res.error || 'unauthorized'); return; }
        renderRows(res.rows || []);
      } catch (e) { if (body) body.innerHTML = errRow(e); }
    }

    const gen = document.getElementById('aquaGenBtn');
    if (gen) gen.addEventListener('click', async () => {
      msg('', '');
      const val = (id) => (document.getElementById(id)?.value || '').trim();
      const fields = { full_name: val('aqName'), id_number: val('aqId'), start_date: val('aqStart'), remuneration: val('aqRem'), email: val('aqEmail') };
      if (!fields.full_name || !fields.id_number) { msg('err', 'Full name and ID number are required.'); return; }
      gen.disabled = true; const label = gen.textContent; gen.textContent = 'Generating…';
      try {
        const res = await _aquaFetch({ fields });
        gen.disabled = false; gen.textContent = label;
        if (!res.ok) { msg('err', 'Error: ' + (res.error || 'unknown')); return; }
        msg('ok', 'Agreement generated for ' + fields.full_name + '.' + (res.emailed ? ' Emailed to the contractor.' : ''));
        ['aqName', 'aqId', 'aqStart', 'aqRem', 'aqEmail'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        loadList();
      } catch (e) {
        gen.disabled = false; gen.textContent = label;
        msg('err', 'Network error: ' + e);
      }
    });

    const refresh = document.getElementById('aquaRefreshBtn');
    if (refresh) refresh.addEventListener('click', loadList);

    loadList();
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
  // Realtime health tracking — needed because .subscribe() by itself gives
  // no visibility into channel death. When the websocket drops (WiFi flake,
  // laptop sleep, Supabase restart) the channel silently stops delivering.
  // _rtStatus captures the last SUBSCRIBED / CHANNEL_ERROR / TIMED_OUT /
  // CLOSED so both the fallback poller and a small UI dot can react.
  let _rtStatus = 'INIT';
  let _rtLastStatusAt = 0;
  function dashIsBusy() {
    // Don't blow away an open drill-down modal or the gate.
    return !!document.querySelector('.modal-back, .modal');
  }
  // Debounce helper — used for the burst-prone tables (live_stats,
  // flag_acks, clock_out_reports, staff). The Mac daemon can upsert many
  // live_stats rows within a few seconds at shift boundaries; without
  // debouncing every row triggers a full shell() re-render.
  function _rtDebounce(fn, ms) {
    let t = null;
    return function debounced() {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
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
  const _reloadReports = _rtDebounce(() => {
    // A new clock_out_reports row lands as soon as an LN or assistant
    // submits their EOD form. Refresh the in-memory _reports cache, then
    // re-render whichever consumer is currently active: Daily Stats has
    // its own inline updater, LN Stats needs a shell() to redraw the
    // leaderboard, and Overview shows a "recent submissions" recap.
    // Previously only Daily Stats was refreshed, so LN Stats stayed
    // stuck on stale data until the user changed tabs or reloaded.
    loadReports().then(() => {
      if (dashIsBusy()) return;
      if (tab === 'daily') populateDailyReports();
      else if (tab === 'ln' || tab === 'overview' || tab === 'leadership') shell();
    });
  }, 1500);
  const _reloadStaff = _rtDebounce(() => {
    _team = null;
    if (tab === 'team' && !dashIsBusy()) shell();
  }, 1500);
  const _reloadFlagAcks = _rtDebounce(() => {
    loadFlagAcks().then(() => {
      updateLiveFlagsBadge();
      if (dashIsBusy()) return;
      if (tab === 'overview' || tab === 'leadership' || tab === 'manager') shell();
    });
  }, 1500);
  const _reloadLiveStats = _rtDebounce(() => {
    if (typeof loadLiveStats !== 'function') return;
    loadLiveStats().then(() => {
      if (!dashIsBusy() && tab === 'live') shell();
    });
  }, 1500);
  // Absences aren't watched by realtime today — admin marks someone
  // absent from another device, the current session's Live Floor keeps
  // showing them under "Not in yet" until the 5-min slow poll fires.
  // Piggy-back on the schedule reload since absencesToday is loaded
  // alongside the events window in loadScheduleData.
  const _reloadAbsences = _rtDebounce(() => {
    loadScheduleData().then(() => {
      updateLiveFlagsBadge();
      if (!dashIsBusy() && (tab === 'live' || tab === 'overview' || tab === 'team')) shell();
    });
  }, 1500);
  function subscribeRealtime() {
    if (_rtChannel || !window.sb) return;
    try {
      // Push the current session's JWT into the realtime socket so RLS-
      // gated postgres_changes messages are delivered. Without this the
      // socket keeps its bootstrap JWT and stops receiving events once
      // that token expires (~1h default).
      const sb = window.sb;
      sb.auth.getSession().then(({ data }) => {
        if (data && data.session && sb.realtime && sb.realtime.setAuth) {
          try { sb.realtime.setAuth(data.session.access_token); } catch {}
        }
      });
      // Refresh realtime auth every time Supabase auto-refreshes the JWT.
      // Idempotent: if a listener is already registered from a prior
      // subscribeRealtime we just add another (harmless).
      if (sb.auth && sb.auth.onAuthStateChange && !window._rtAuthWired) {
        window._rtAuthWired = true;
        sb.auth.onAuthStateChange((event, sess) => {
          if (event === 'TOKEN_REFRESHED' && sess && sb.realtime && sb.realtime.setAuth) {
            try { sb.realtime.setAuth(sess.access_token); } catch {}
          }
        });
      }
      _rtChannel = sb
        .channel('dash-feed')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, rtScheduleReload)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'clock_out_reports' }, _reloadReports)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'staff' }, _reloadStaff)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'flag_acks' }, _reloadFlagAcks)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'live_stats' }, _reloadLiveStats)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'absences' }, _reloadAbsences)
        .subscribe((status) => {
          _rtStatus = status || 'UNKNOWN';
          _rtLastStatusAt = Date.now();
          // On a hard drop, tear the channel down so the next slow-poll
          // tick can rebuild it fresh — .subscribe() itself doesn't
          // recover from CHANNEL_ERROR / TIMED_OUT / CLOSED.
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            try { sb.removeChannel(_rtChannel); } catch {}
            _rtChannel = null;
          }
        });
    } catch (e) { console.warn('[rt] subscribe failed', e); }
  }
  // Rebuild the channel if it silently died. Called from the slow poller.
  function ensureRealtimeAlive() {
    if (!window.sb || !session) return;
    if (_rtChannel && (_rtStatus === 'SUBSCRIBED' || _rtStatus === 'INIT')) return;
    // No live channel — try to rebuild.
    _rtChannel = null;
    subscribeRealtime();
  }
  // Fallback slow poll in case the websocket drops silently. Skips the
  // full re-render if a modal is open or the user is mid-interaction —
  // updateLiveFlagsBadge() still runs so the topbar count stays accurate.
  // Also probes the realtime channel and refreshes live_stats so the Live
  // Floor stays honest even when postgres_changes messages are dropping
  // silently (JWT expiry, socket closed, transient CHANNEL_ERROR).
  setInterval(() => {
    if (!session || document.visibilityState !== 'visible') return;
    ensureRealtimeAlive();
    loadScheduleData().then(() => {
      updateLiveFlagsBadge();
      if (dashIsBusy()) return;
      if (tab === 'overview' || tab === 'leadership' || tab === 'live') shell();
    });
    if (tab === 'live' && typeof loadLiveStats === 'function') {
      loadLiveStats().then(() => {
        if (!dashIsBusy() && tab === 'live') shell();
      });
    }
  }, 5 * 60 * 1000);
})();

/* Quay 1 — shared app switcher ("site switcher").
 *
 * ONE central widget, hosted on the dashboard-v2 Pages site and loaded by every
 * Quay 1 internal app via a single <script> tag:
 *
 *     <script src="https://twigs002.github.io/quay-dashboard-v2/quay-nav.js" defer></script>
 *
 * Each app, once it knows the signed-in user, calls:
 *
 *     QuayNav.mount({ isSuper: <bool>, current: '<site id>' });
 *
 * It turns that app's top-left Quay 1 flag/logo into a click target that drops
 * down a menu of the other apps. It renders ONLY for superusers — for everyone
 * else mount() is a no-op and the logo behaves exactly as before.
 *
 * ADDING A NEW APP  ->  append ONE entry to the SITES array below, redeploy the
 * dashboard-v2 repo, and every app picks it up on the next page load. No edits
 * to the other repos are ever needed again.
 */
window.QuayNav = (function () {
  'use strict';

  // ---- single source of truth: every Quay 1 app in the switcher ------------
  // id      : short key each app passes as `current` so its own row is marked.
  // label   : name shown in the dropdown.
  // sub      : one-line description under the name.
  // url      : where the row links to.
  const SITES = [
    { id: 'dashboard', label: 'Performance Dashboard', sub: 'Live team & caller stats',        url: 'https://twigs002.github.io/quay-dashboard-v2/' },
    { id: 'leads',     label: 'Seller Leads',          sub: 'Seller-lead pipeline',            url: 'https://twigs002.github.io/quay-leads/' },
    { id: 'hubspot',   label: 'Team Insights',         sub: 'HubSpot deals · division directory', url: 'https://twigs002.github.io/quay-hubspot/' },
    { id: 'boarding',  label: 'Boarding Tool',         sub: 'Onboard · provision · offboard',  url: 'https://twigs002.github.io/quay-1-boarding-tool/' },
    // { id: 'newapp', label: '…', sub: '…', url: 'https://…' },   <-- add new apps here
  ];

  // A small colour swatch per app so rows are quick to tell apart. Uses the
  // Quay 1 palette (blue / sky / yellow / red).
  const DOT = {
    dashboard: '#3D5BA6', leads: '#FDC503', hubspot: '#98C5ED', boarding: '#D20A03',
  };
  const DEFAULT_DOT = '#3D5BA6';

  let menuEl = null;      // the floating dropdown (appended to <body>, reused)
  let styleEl = null;     // injected <style> (once)
  let openAnchor = null;  // the logo the menu is currently anchored to
  let currentId = null;   // which app we're on (its row is marked "current")

  const isOpen = () => menuEl && menuEl.classList.contains('is-open');

  function injectStyles() {
    if (styleEl) return;
    styleEl = document.createElement('style');
    styleEl.id = 'quay-nav-styles';
    styleEl.textContent = `
      .quay-nav-anchor { cursor: pointer; }
      .quay-nav-caret {
        display: inline-flex; align-items: center; justify-content: center;
        width: 22px; height: 22px; margin-left: 8px; padding: 0;
        border: 0; border-radius: 999px; cursor: pointer;
        background: rgba(255,255,255,.14); color: #fff;
        transition: background .15s, transform .15s;
        flex: none; -webkit-appearance: none; appearance: none;
      }
      .quay-nav-caret:hover { background: rgba(255,255,255,.28); }
      .quay-nav-caret svg { width: 12px; height: 12px; display: block; transition: transform .18s; }
      .quay-nav-caret[aria-expanded="true"] svg { transform: rotate(180deg); }

      .quay-nav-menu {
        position: fixed; z-index: 2147483000; min-width: 268px; max-width: 320px;
        background: #fff; color: #1A2746;
        border: 1px solid #E0E7F1; border-radius: 14px;
        box-shadow: 0 12px 40px rgba(30,46,89,.22), 0 2px 6px rgba(30,46,89,.10);
        padding: 8px; opacity: 0; transform: translateY(-6px) scale(.98);
        pointer-events: none; transition: opacity .14s ease, transform .14s ease;
        font-family: 'Montserrat', system-ui, -apple-system, sans-serif;
      }
      .quay-nav-menu.is-open { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
      .quay-nav-menu .qn-head {
        font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
        color: #6B7891; padding: 6px 10px 8px;
      }
      .quay-nav-item {
        display: flex; align-items: center; gap: 11px; width: 100%;
        padding: 9px 10px; border-radius: 10px; text-decoration: none;
        color: inherit; background: transparent; border: 0; cursor: pointer;
        text-align: left; transition: background .12s;
      }
      .quay-nav-item:hover { background: #EEF2F8; }
      .quay-nav-item .qn-dot {
        width: 10px; height: 10px; border-radius: 999px; flex: none;
        box-shadow: 0 0 0 3px rgba(0,0,0,.04);
      }
      .quay-nav-item .qn-txt { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
      .quay-nav-item .qn-label { font-size: 13.5px; font-weight: 600; }
      .quay-nav-item .qn-sub { font-size: 11.5px; color: #6B7891; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .quay-nav-item .qn-check { margin-left: auto; color: #2F8F63; flex: none; display: none; }
      .quay-nav-item.is-current { background: #E9F2FB; cursor: default; }
      .quay-nav-item.is-current:hover { background: #E9F2FB; }
      .quay-nav-item.is-current .qn-check { display: block; }
    `;
    document.head.appendChild(styleEl);
  }

  function buildMenu() {
    if (menuEl) return;
    menuEl = document.createElement('div');
    menuEl.className = 'quay-nav-menu';
    menuEl.setAttribute('role', 'menu');
    menuEl.setAttribute('aria-label', 'Switch Quay 1 app');
    document.body.appendChild(menuEl);

    // dismiss handlers (registered once)
    document.addEventListener('click', (e) => {
      if (!isOpen()) return;
      if (menuEl.contains(e.target)) return;
      if (openAnchor && (openAnchor === e.target || openAnchor.contains(e.target))) return;
      const caret = openAnchor && openAnchor.parentNode && openAnchor.parentNode.querySelector('.quay-nav-caret');
      if (caret && (caret === e.target || caret.contains(e.target))) return;
      close();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
  }

  function renderItems() {
    const check = '<svg class="qn-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    const rows = SITES.map((s) => {
      const cur = s.id === currentId;
      const dot = `<span class="qn-dot" style="background:${DOT[s.id] || DEFAULT_DOT}"></span>`;
      const txt = `<span class="qn-txt"><span class="qn-label">${esc(s.label)}</span><span class="qn-sub">${esc(s.sub)}</span></span>`;
      if (cur) {
        return `<div class="quay-nav-item is-current" role="menuitem" aria-current="true">${dot}${txt}${check}</div>`;
      }
      return `<a class="quay-nav-item" role="menuitem" href="${esc(s.url)}">${dot}${txt}</a>`;
    }).join('');
    menuEl.innerHTML = `<div class="qn-head">Switch app</div>${rows}`;
  }

  function positionUnder(anchor) {
    const r = anchor.getBoundingClientRect();
    // Render first (still invisible) to measure, then clamp into the viewport.
    menuEl.style.top = '-9999px';
    menuEl.style.left = '-9999px';
    const mw = menuEl.offsetWidth || 268;
    const mh = menuEl.offsetHeight || 200;
    let left = r.left;
    let top = r.bottom + 10;
    left = Math.min(left, window.innerWidth - mw - 12);
    left = Math.max(12, left);
    if (top + mh > window.innerHeight - 12) top = Math.max(12, r.top - mh - 10);
    menuEl.style.left = left + 'px';
    menuEl.style.top = top + 'px';
  }

  function open(anchor) {
    buildMenu();
    openAnchor = anchor;
    renderItems();
    positionUnder(anchor);
    menuEl.classList.add('is-open');
    const caret = anchor.parentNode && anchor.parentNode.querySelector('.quay-nav-caret');
    if (caret) caret.setAttribute('aria-expanded', 'true');
  }

  function close() {
    if (!menuEl) return;
    menuEl.classList.remove('is-open');
    if (openAnchor) {
      const caret = openAnchor.parentNode && openAnchor.parentNode.querySelector('.quay-nav-caret');
      if (caret) caret.setAttribute('aria-expanded', 'false');
    }
  }

  function toggle(anchor) { (isOpen() && openAnchor === anchor) ? close() : open(anchor); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function caretSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
  }

  /**
   * Wire the switcher onto this app's top-left logo.
   * @param {Object} opts
   * @param {boolean} opts.isSuper  Only superusers get the switcher; else no-op.
   * @param {string}  opts.current  This app's id (marks its own row as current).
   * @param {string|Element} [opts.anchor]  Logo element or selector.
   *        Defaults to 'img.brand-logo'.
   */
  function mount(opts) {
    opts = opts || {};
    if (!opts.isSuper) return;                 // superusers only
    currentId = opts.current || null;
    injectStyles();

    const anchor = typeof opts.anchor === 'string'
      ? document.querySelector(opts.anchor)
      : (opts.anchor || document.querySelector('img.brand-logo'));
    if (!anchor) return;
    if (anchor.getAttribute('data-quay-nav') === '1') return;  // already wired
    anchor.setAttribute('data-quay-nav', '1');

    anchor.classList.add('quay-nav-anchor');
    anchor.setAttribute('role', 'button');
    anchor.setAttribute('tabindex', '0');
    anchor.setAttribute('title', 'Switch Quay 1 app');
    anchor.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggle(anchor); });
    anchor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(anchor); }
    });

    // Visible affordance: a caret chip right after the logo (same flex row).
    const caret = document.createElement('button');
    caret.type = 'button';
    caret.className = 'quay-nav-caret';
    caret.setAttribute('aria-label', 'Switch Quay 1 app');
    caret.setAttribute('aria-haspopup', 'menu');
    caret.setAttribute('aria-expanded', 'false');
    caret.innerHTML = caretSvg();
    caret.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggle(anchor); });
    if (anchor.parentNode) anchor.parentNode.insertBefore(caret, anchor.nextSibling);
  }

  return { mount, SITES };
})();

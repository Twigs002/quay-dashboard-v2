/* Quay 1 — Payroll · Divisions Allocations (super-only tab)

   Native port of the monthly divisions-allocations workflow described in
   `~/Documents/Claude/Projects/Divisions Allocations/QUAY1_DIVISIONS_ALLOCATIONS_SPEC.md`
   and the reference Python implementation
   `~/Documents/Claude/Projects/Divisions Allocations/skill-source/scripts/build_consolidation.py`.

   Reference data (canonical divisions, typo map, alias regex, per-employee
   default team, standalone short-codes) ships inline as static constants
   for v1. Promote to Supabase + admin UI later — the spec lists this as
   the eventual home but the business asked for static-data first to avoid
   schema churn.

   Shifts come from the `events` table in Supabase (already populated by
   the quay-clock PWA). We pair 'in' → 'out' rows client-side, skip
   open shifts (per §2), and treat the `note` on the 'in' row as the
   Employee-notes field. The `staff` table provides the canonical name +
   designation/division.

   Exposes window.PAYROLL with helpers + extends window.VIEWS with views.
   Append `?payrolltest=1` to the URL to run the §7 regression cases in
   the console at module load. */

(function () {
  'use strict'

  // ---------------------------------------------------------------------
  // SAST timezone anchoring
  //
  // The dashboard can be opened by a super from anywhere (London on a
  // weekend, Sydney during a conference, etc.) but every business meaning
  // attached to a calendar date — the 21st-to-20th pay period boundary,
  // the EOD-report filter, the schedule adherence week — is in
  // Africa/Johannesburg (SAST, UTC+2 year-round, no DST). Reading
  // d.getDate() / d.getHours() trusts the browser's local zone, which
  // silently produces wrong data for off-shore users. Use _sastYMD /
  // _sastParts to extract the SAST wall-clock components instead.
  // ---------------------------------------------------------------------

  const SAST_TZ = 'Africa/Johannesburg'

  // Returns the calendar date in SAST as {y, m (0-indexed), d} regardless
  // of the browser's local zone. Built on Intl.DateTimeFormat so it works
  // even when the user is opened from London/Sydney/etc.
  function _sastYMD(d) {
    const when = d || new Date()
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: SAST_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(when)
    const get = k => parseInt(parts.find(p => p.type === k).value, 10)
    return { y: get('year'), m: get('month') - 1, d: get('day') }
  }

  // Build a UTC ISO string for an explicit SAST wall-clock instant. SAST is
  // UTC+2, so the equivalent UTC moment is the wall clock minus 2h. Caller
  // passes Y/M/D and (optionally) H/M/S/ms in SAST. This decouples the
  // function from the browser's local zone entirely.
  function _sastWallToUtcISO(y, m, day, hh, mm, ss, ms) {
    const utcMillis = Date.UTC(y, m, day, hh || 0, mm || 0, ss || 0, ms || 0)
                    - 2 * 3600 * 1000
    return new Date(utcMillis).toISOString()
  }

  // ---------------------------------------------------------------------
  // Reference data — ported verbatim from build_consolidation.py
  //
  // Historically these were `const`s. They've since been promoted to a
  // mutable CONFIG object so the Config sub-tab can swap in values
  // pulled from Supabase (see loadConfigFromSupabase below). The
  // values here stay as the hard-coded FALLBACK for first-load before
  // the DB is reachable / when RLS denies the read / when the tables
  // haven't been deployed yet — the algorithm must always have a sane
  // baseline to fall back on.
  // ---------------------------------------------------------------------

  const CONFIG = {
    // Spec §3.1 — canonical divisions in display order. Order matters for
    // the By Division pivot. Audit finding D2 (P1): reconciled against
    // quay-clock/app.js CLOCK_CAMPAIGNS_ALL (the true source of truth
    // for team names). Added: ASB Calling, Clienthub, Engine Room, Rentals
    // (were silently dropping their hours from By-Division). Removed:
    // Rebels (archived in clock roster — real payroll rows never land
    // against it). TODO: move roster to a shared Supabase `divisions`
    // table so this drift can't happen a fourth time.
    CANONICAL_TEAMS: [
      'Amigos', 'ASB Calling', 'Assassins', 'Avengers', 'Babes', 'Ballers',
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
    ],

    // Spec §3.2 — typo / variant exact-match merges. Applied AFTER the
    // title-case + suffix-strip + apostrophe-strip steps but BEFORE the
    // alias-regex stage.
    TYPO_MAP: {
      'Assasins': 'Assassins',
      'Invicibles': 'Invincibles',
      'Durchmen': 'Dutchmen',
      'Dutchman': 'Dutchmen',
      'Powerrangers': 'Power Rangers',
      'Engineroom': 'Engine Room',
      'Warrio': 'Warriors',
      'Glads': 'Gladiators',
      'Proms': 'Prom Queens',
      'Tnt': 'TNT',
      'Tt': 'TNT',
      'Komarants': 'Komorants',
      'Dealmalers': 'Dealmakers',
      'Ln': 'Hout Baes',
      // singulars → plural canonical
      'Assassin': 'Assassins',
      'Baller': 'Ballers',
      'Charger': 'Chargers',
      'Gunslinger': 'Gunslingers',
      'Knight': 'Knights',
      'Pirate': 'Pirates',
      // spacing / casing variants
      'Citysuns': 'City Sunsets',
      'City Suns': 'City Sunsets',
      'Soccermoms': 'Soccer Moms',
      'Houtbaes': 'Hout Baes',
    },

    // Spec §3.3 — broader regex aliases. Applied AFTER TYPO_MAP. First
    // match wins. Entries are [RegExp, target] tuples; always compiled
    // with the `i` flag, mirroring the Python re.IGNORECASE compiles.
    ALIAS_PATTERNS: [
      [/^engine\s*room\b/i, 'Engine Room'],
      [/^justin\b/i, 'Tigers'],
      [/\bjustin\b/i, 'Tigers'],
      [/\bhubspot\b/i, 'Hout Baes'],
      [/^hout\s*baes\b/i, 'Hout Baes'],
    ],

    // Spec §3.5 — standalone short-codes that should be dropped entirely.
    DROP_STANDALONE: new Set(['cm', 'na', 'va', 'nc', 'cma']),

    // Spec §3.4 — per-employee default team for blank-notes shifts.
    EMPLOYEE_DEFAULT_TEAM: {
      'Claire Murch': 'Nelio Assiss',
    },

    // Derived lookups — rebuilt by _rebuildDerived() whenever
    // CANONICAL_TEAMS changes.
    CANONICAL_LC: {},
    CANONICAL_SET: new Set(),

    // Bumps every time loadConfigFromSupabase succeeds. Cheap signal the
    // Config view can use to invalidate cached children if it ever needs
    // to (currently it just re-renders on every mutation).
    _version: 0,
  }

  // Recompute the canonical-LC map + canonical Set from CONFIG.CANONICAL_TEAMS.
  // Called once at module load and again after every successful DB hydrate.
  function _rebuildDerived() {
    const lc = {}
    CONFIG.CANONICAL_TEAMS.forEach(t => { lc[t.toLowerCase()] = t })
    CONFIG.CANONICAL_LC = lc
    CONFIG.CANONICAL_SET = new Set(CONFIG.CANONICAL_TEAMS)
  }
  _rebuildDerived()

  // Cache for the in-flight Supabase hydrate so concurrent Payroll-tab
  // mounts share one network round-trip.
  let _configLoadPromise = null
  let _configLoadedOnce = false

  // Pulls all 5 reference tables in parallel and replaces the matching
  // fields on CONFIG. On any error (table missing, RLS deny, network),
  // logs a warning and leaves the static fallback constants in place.
  async function loadConfigFromSupabase() {
    if (!window.sb) {
      console.warn('[payroll] Supabase client not ready; using static config fallback')
      return false
    }
    try {
      const [div, typo, alias, def, drop] = await Promise.all([
        window.sb.from('payroll_canonical_divisions')
          .select('id, name, display_order, active')
          .order('display_order', { ascending: true }),
        window.sb.from('payroll_typo_map')
          .select('id, key, canonical')
          .order('key', { ascending: true }),
        window.sb.from('payroll_alias_patterns')
          .select('id, pattern, target, priority')
          .order('priority', { ascending: true }),
        window.sb.from('payroll_default_team')
          .select('id, agent_name, default_team')
          .order('agent_name', { ascending: true }),
        window.sb.from('payroll_drop_standalone')
          .select('id, code')
          .order('code', { ascending: true }),
      ])
      // If ANY of them errored, bail out — partial hydrate could leave
      // CANONICAL_TEAMS empty (and normalizeTeam returning nothing).
      const errs = [div.error, typo.error, alias.error, def.error, drop.error].filter(Boolean)
      if (errs.length) {
        console.warn('[payroll] config DB read failed; using static fallback:', errs)
        return false
      }

      // CANONICAL_TEAMS — active rows only, in display_order.
      if (Array.isArray(div.data) && div.data.length) {
        CONFIG.CANONICAL_TEAMS = div.data
          .filter(r => r.active !== false)
          .map(r => r.name)
        // Keep a side-channel that the view needs for the reorder UI.
        CONFIG._canonicalRows = div.data
      }

      // TYPO_MAP — plain key→canonical object.
      if (Array.isArray(typo.data)) {
        const m = {}
        const rows = []
        typo.data.forEach(r => {
          m[r.key] = r.canonical
          rows.push(r)
        })
        CONFIG.TYPO_MAP = m
        CONFIG._typoRows = rows
      }

      // ALIAS_PATTERNS — compile each source string with the `i` flag.
      // Bad regex strings are warned about + skipped (not fatal).
      if (Array.isArray(alias.data)) {
        const pats = []
        const rows = []
        alias.data.forEach(r => {
          try {
            pats.push([new RegExp(r.pattern, 'i'), r.target])
            rows.push(r)
          } catch (e) {
            console.warn('[payroll] skipping invalid alias pattern', r, e.message)
          }
        })
        CONFIG.ALIAS_PATTERNS = pats
        CONFIG._aliasRows = rows
      }

      // EMPLOYEE_DEFAULT_TEAM
      if (Array.isArray(def.data)) {
        const m = {}
        const rows = []
        def.data.forEach(r => {
          m[r.agent_name] = r.default_team
          rows.push(r)
        })
        CONFIG.EMPLOYEE_DEFAULT_TEAM = m
        CONFIG._defaultRows = rows
      }

      // DROP_STANDALONE — stored lower-case in the DB, mirrored in the Set.
      if (Array.isArray(drop.data)) {
        CONFIG.DROP_STANDALONE = new Set(drop.data.map(r => String(r.code).toLowerCase()))
        CONFIG._dropRows = drop.data
      }

      _rebuildDerived()
      CONFIG._version++
      _configLoadedOnce = true
      return true
    } catch (e) {
      console.warn('[payroll] loadConfigFromSupabase threw; using static fallback', e)
      return false
    }
  }

  // Public coalesced loader — re-uses an in-flight promise so multiple
  // mounts during a single tab open don't fire parallel requests.
  function reloadConfig() {
    _configLoadPromise = loadConfigFromSupabase()
      .finally(() => { _configLoadPromise = null })
    return _configLoadPromise
  }

  // First-load helper used by app.js before the Payroll tab fetches shifts.
  function ensureConfigLoaded() {
    if (_configLoadedOnce) return Promise.resolve(true)
    if (_configLoadPromise) return _configLoadPromise
    return reloadConfig()
  }

  // ---------------------------------------------------------------------
  // Regex helpers — ported from the Python module-level patterns
  // ---------------------------------------------------------------------

  // Emoji + symbol ranges, mirrors the Python EMOJI_RE. We add the `u` flag
  // so the JS engine treats the unicode escapes as code-points, not surrogate
  // halves. The trailing variation-selector U+FE0F is included separately
  // (it follows the modifier and would otherwise survive the strip).
  const EMOJI_RE = /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE0F}]+/gu

  const SUFFIX_RE = /\s+(?:Cm|Na|Va|Nc)$/i
  const TEAM_SPLIT_RE = /\s*(?:\/|&|,|\band\b)\s*/i

  // Outer-punctuation strip — matches the Python `.strip(' \t\n\r.,;:"!()[]{}')`.
  const OUTER_PUNCT_RE = /^[\s.,;:"!()[\]{}]+|[\s.,;:"!()[\]{}]+$/g

  // ---------------------------------------------------------------------
  // Algorithm (spec §4)
  // ---------------------------------------------------------------------

  function titleCaseWord(w) {
    if (!w) return ''
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  }

  // 13-step pipeline. See spec §4.2 + Python `normalize_team()`.
  function normalizeTeam(name) {
    if (name == null) return ''
    let n = String(name)
    if (!n) return ''
    // 1) Strip emojis
    n = n.replace(EMOJI_RE, '')
    // 2) Curly quotes → straight, then strip apostrophes entirely.
    //    MUST happen before the typo-map lookup so "Fury's" → "Furys" matches.
    n = n.replace(/’/g, "'").replace(/‘/g, "'").replace(/'/g, '')
    // 3) Strip outer whitespace + punctuation
    n = n.replace(OUTER_PUNCT_RE, '')
    // 4) Drop if empty
    if (!n) return ''
    // 5) Collapse internal whitespace runs to a single space
    n = n.replace(/\s+/g, ' ')
    // 6) Title-case each word
    n = n.split(' ').map(titleCaseWord).join(' ')
    // 7) Strip CM/NA/VA/NC suffix (after title-case so it only triggers when
    //    the suffix word is the LAST whitespace-separated token).
    n = n.replace(SUFFIX_RE, '').trim()
    // 8) Drop if empty
    if (!n) return ''
    // 9) Standalone short-code → drop
    if (CONFIG.DROP_STANDALONE.has(n.toLowerCase())) return ''
    // 10) Exact typo lookup
    if (Object.prototype.hasOwnProperty.call(CONFIG.TYPO_MAP, n)) n = CONFIG.TYPO_MAP[n]
    // 11) Alias regex — first match wins
    for (const [pat, target] of CONFIG.ALIAS_PATTERNS) {
      if (pat.test(n)) { n = target; break }
    }
    // 12) Canonical-case fix
    if (Object.prototype.hasOwnProperty.call(CONFIG.CANONICAL_LC, n.toLowerCase())) {
      n = CONFIG.CANONICAL_LC[n.toLowerCase()]
    }
    // 13) Return canonical (or non-canonical-but-cleaned) string
    return n
  }

  // Spec §4.1 + §4.3 — split + dedupe.
  function parseTeams(note) {
    if (note == null) return []
    const s = String(note).trim()
    if (!s) return []
    const parts = s.split(TEAM_SPLIT_RE)
    const out = []
    const seen = new Set()
    for (const p of parts) {
      const n = normalizeTeam(p)
      if (!n) continue
      const key = n.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(n)
    }
    return out
  }

  // ---------------------------------------------------------------------
  // Pay-period helpers (spec §6 + Python current_pay_period)
  // ---------------------------------------------------------------------

  // SAST is UTC+02:00 year-round. We treat the period start/end as local
  // SAST midnight and midnight-23:59:59. The dashboard runs in a browser
  // that could be in any timezone — but Quay 1's business hours, the
  // events table, and the spec are all SAST. So we build SAST-aligned
  // Date objects, then convert to UTC when querying Supabase.

  function _ymd(d) {
    // Returns yyyy-mm-dd for a JS Date interpreted in the *local* zone of
    // the caller. We use this only for labels — never for SQL ranges.
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  // Period { start, end } where start/end are Date objects at SAST midnight
  // and 23:59:59.999 respectively. `label` is yyyy-mm-dd → yyyy-mm-dd.
  function currentPayPeriod(today) {
    // Read calendar parts in SAST, not in the browser's local zone, so a
    // super opening the dashboard from London at 23:00 (SAST 01:00 next
    // day) still rolls into the correct pay period.
    const { y, m, d: day } = _sastYMD(today ? new Date(today) : new Date())
    let startY, startM, endY, endM
    if (day >= 21) {
      startY = y; startM = m
      if (m === 11) { endY = y + 1; endM = 0 } else { endY = y; endM = m + 1 }
    } else {
      if (m === 0) { startY = y - 1; startM = 11 } else { startY = y; startM = m - 1 }
      endY = y; endM = m
    }
    // SAST midnight on the 21st. We construct via local-time Date and store
    // as such — `fetchShiftsForPeriod` does the SAST → UTC offset for the
    // SQL bounds.
    const start = new Date(startY, startM, 21, 0, 0, 0, 0)
    const end = new Date(endY, endM, 20, 23, 59, 59, 999)
    return { start, end, label: `${_ymd(start)} → ${_ymd(end)}` }
  }

  // Returns the last N pay periods, newest first. Used to populate a picker.
  function payPeriodsForPicker(count) {
    const N = count || 12
    const out = []
    const today = new Date()
    // Start at the current pay period, then step back one month at a time.
    let cur = currentPayPeriod(today)
    out.push(cur)
    for (let i = 1; i < N; i++) {
      // The previous period ended one day before this period started.
      const prevEnd = new Date(cur.start.getFullYear(), cur.start.getMonth(), 20, 23, 59, 59, 999)
      cur = currentPayPeriod(prevEnd)
      out.push(cur)
    }
    return out
  }

  // ---------------------------------------------------------------------
  // Time helpers
  // ---------------------------------------------------------------------

  function hoursDecimal(startISO, endISO) {
    if (!startISO || !endISO) return 0
    const s = new Date(startISO).getTime()
    const e = new Date(endISO).getTime()
    if (!Number.isFinite(s) || !Number.isFinite(e)) return 0
    return (e - s) / 3600000
  }

  function decimalToHHMM(hrs) {
    if (hrs == null || !Number.isFinite(hrs)) return ''
    const totalMins = Math.round(hrs * 60)
    const sign = totalMins < 0 ? '-' : ''
    const abs = Math.abs(totalMins)
    const h = Math.floor(abs / 60)
    const m = abs % 60
    return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }

  // Spec §5.3.1 — round-half-up. CRITICAL — never use Math.round() here.
  // JavaScript's Math.round() does round-half-away-from-zero, which happens
  // to agree with the spec for positive .5 boundaries (it would give 9 for
  // 8.5), but the business owner specifically asked for the floor(x+0.5)
  // form, and using it explicitly makes the intent obvious to future
  // readers — and avoids any edge case with extremely small floating-point
  // representation differences (e.g. 8.499999... displayed as 8.5).
  // Input is a fraction in [0, 1+ε]; returns a fraction in [0, 1+ε] rounded
  // to nearest whole percentage point.
  function roundHalfUp(rawPct) {
    return Math.floor(rawPct * 100 + 0.5) / 100
  }

  // ---------------------------------------------------------------------
  // Supabase fetch + client-side shift pairing
  // ---------------------------------------------------------------------

  // Convert a SAST wall-clock instant to a UTC ISO string for the Supabase
  // query. SAST is UTC+02:00 — so SAST midnight = UTC 22:00 the previous
  // day.
  //
  // Two calling conventions:
  //   _sastDateToUtcISO(date)
  //     — extracts the SAST calendar parts FROM THE DATE via Intl so the
  //     result is independent of the browser's local zone. Useful for
  //     "this instant on the wall clock in Joburg".
  //   _sastDateToUtcISO({ y, m, d, hh, mm, ss, ms })
  //     — caller supplies explicit SAST wall-clock parts. Useful when the
  //     hh/mm/ss are literal constants (e.g. the 00:00:00.000 / 23:59:59.999
  //     bounds that currentPayPeriod hands fetchShiftsForPeriod).
  function _sastDateToUtcISO(input) {
    if (input && typeof input === 'object' && !(input instanceof Date)) {
      return _sastWallToUtcISO(input.y, input.m, input.d,
        input.hh, input.mm, input.ss, input.ms)
    }
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: SAST_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(input)
    const get = k => parseInt(parts.find(p => p.type === k).value, 10)
    const y = get('year'), m = get('month') - 1, day = get('day')
    const hh = get('hour'), mm = get('minute'), ss = get('second')
    // Intl doesn't surface sub-second precision; preserve the input's ms.
    const ms = (input instanceof Date) ? input.getMilliseconds() : 0
    return _sastWallToUtcISO(y, m, day, hh, mm, ss, ms)
  }

  // Pulls every event in [fromISO, toISO] in pages of PAGE_SIZE, since
  // PostgREST caps a single response at 1000 rows by default. Returns the
  // full array of events ordered by ts asc. Throws on any page error.
  async function _fetchAllEvents(fromISO, toISO) {
    const PAGE_SIZE = 1000
    const all = []
    let offset = 0
    // Safety cap: 50k events in a pay period is wildly more than the
    // floor would ever produce — abort rather than spin forever.
    const MAX_PAGES = 50
    for (let page = 0; page < MAX_PAGES; page++) {
      // Tiebreaker on staff_id: PostgREST .range() pagination is only
      // deterministic when the ORDER BY is total. Two events sharing an
      // exact ts (rare but possible — two staff clocking in the same ms)
      // could otherwise straddle a page boundary unpredictably and either
      // duplicate or skip rows. ts asc, staff_id asc makes the page cut
      // stable across requests.
      const { data, error } = await window.sb.from('events')
        .select('staff_id, ts, dir, note')
        .gte('ts', fromISO).lte('ts', toISO)
        .order('ts', { ascending: true })
        .order('staff_id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1)
      if (error) throw error
      if (!data || data.length === 0) break
      all.push(...data)
      if (data.length < PAGE_SIZE) break
      offset += PAGE_SIZE
    }
    return all
  }

  async function fetchShiftsForPeriod(start, end) {
    if (!window.sb) throw new Error('Supabase client not initialised')
    const fromISO = _sastDateToUtcISO(start)
    const toISO = _sastDateToUtcISO(end)

    // Pull staff first so we can name-decorate the shifts. RLS already
    // allows authenticated reads on both tables (used by other tabs).
    // PostgREST defaults to 1000 rows per query; a full 30-day pay
    // period for ~30 staff easily exceeds that, leaving the tail of the
    // period unpaired and the view empty. _fetchAllEvents paginates.
    const [staffRes, events] = await Promise.all([
      window.sb.from('staff')
        .select('id, name, designation, division, active, hourly_rate, salary, is_broker')
        .order('name', { ascending: true }),
      _fetchAllEvents(fromISO, toISO),
    ])
    if (staffRes.error) throw staffRes.error
    const staff = staffRes.data

    const nameById = new Map()
    const designationById = new Map()
    const divisionById = new Map()
    const rateById = new Map()
    const salaryById = new Map()
    // Brokers are login-only accounts (no clock-in, no payroll). They should
    // never produce clock events, but exclude them defensively so a stray
    // event can never surface a broker in the pay run.
    const brokerIds = new Set();
    (staff || []).forEach(s => {
      nameById.set(s.id, s.name || s.id)
      designationById.set(s.id, s.designation || '')
      divisionById.set(s.id, s.division || '')
      rateById.set(s.id, s.hourly_rate == null ? null : Number(s.hourly_rate))
      salaryById.set(s.id, s.salary == null ? null : Number(s.salary))
      if (s.is_broker === true || String(s.designation || '').toLowerCase() === 'broker') brokerIds.add(s.id)
    })

    // Group events by staff_id, sort each group by ts asc (the order-by
    // above already sorts globally, but we re-sort per-group to be safe).
    const byStaff = new Map();
    (events || []).forEach(e => {
      if (brokerIds.has(e.staff_id)) return   // brokers never enter the pay run
      if (!byStaff.has(e.staff_id)) byStaff.set(e.staff_id, [])
      byStaff.get(e.staff_id).push(e)
    })

    const shifts = []
    byStaff.forEach((rows, staffId) => {
      rows.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)
      let openIn = null
      for (const ev of rows) {
        if (ev.dir === 'in') {
          if (openIn) {
            // Two ins in a row — treat the previous as orphaned (still
            // clocked-in). Per spec §2 we just skip it.
            console.warn('[payroll] orphaned in event (no matching out):',
              staffId, openIn.ts)
          }
          openIn = ev
        } else if (ev.dir === 'out') {
          if (!openIn) {
            console.warn('[payroll] orphaned out event (no matching in):',
              staffId, ev.ts)
            continue
          }
          const hrs = hoursDecimal(openIn.ts, ev.ts)
          shifts.push({
            agentId: staffId,
            agentName: nameById.get(staffId) || staffId,
            designation: designationById.get(staffId) || '',
            division: divisionById.get(staffId) || '',
            hourlyRate: rateById.get(staffId),
            salary: salaryById.get(staffId),
            clockInAt: openIn.ts,
            clockOutAt: ev.ts,
            shiftHours: hrs,
            note: openIn.note || '',
          })
          openIn = null
        }
      }
      // Unpaired trailing 'in' = still on the clock — spec §2 says exclude.
    })

    shifts.sort((a, b) => {
      const n = (a.agentName || '').localeCompare(b.agentName || '', undefined, { sensitivity: 'base' })
      if (n !== 0) return n
      return a.clockInAt < b.clockInAt ? -1 : a.clockInAt > b.clockInAt ? 1 : 0
    })
    return shifts
  }

  // ---------------------------------------------------------------------
  // Allocation aggregation (spec §4.4 – §4.6)
  // ---------------------------------------------------------------------

  function computeAllocations(shifts) {
    const empTeamHours = new Map()      // Map<agent, Map<team, hours>>
    const empTotalHours = new Map()     // Map<agent, hours>
    const empMeta = new Map()           // Map<agent, {hourlyRate, designation, division}>
    const rawVariantsPerTeam = new Map() // Map<canonicalTeam, Set<rawStr>>

    function _bumpTeam(emp, team, hrs) {
      if (!empTeamHours.has(emp)) empTeamHours.set(emp, new Map())
      const m = empTeamHours.get(emp)
      m.set(team, (m.get(team) || 0) + hrs)
    }
    function _addVariant(canonical, raw) {
      if (!raw) return
      if (!rawVariantsPerTeam.has(canonical)) rawVariantsPerTeam.set(canonical, new Set())
      rawVariantsPerTeam.get(canonical).add(raw)
    }

    for (const sh of shifts) {
      if (!sh || sh.shiftHours <= 0) continue
      const emp = sh.agentName
      empTotalHours.set(emp, (empTotalHours.get(emp) || 0) + sh.shiftHours)
      // Stash per-agent metadata once — used by the Earnings sub-view.
      if (!empMeta.has(emp)) {
        empMeta.set(emp, {
          hourlyRate: sh.hourlyRate == null ? null : Number(sh.hourlyRate),
          salary: sh.salary == null ? null : Number(sh.salary),
          designation: sh.designation || '',
          division: sh.division || '',
        })
      }
      const teams = parseTeams(sh.note)
      if (!teams.length) {
        const def = CONFIG.EMPLOYEE_DEFAULT_TEAM[emp]
        if (def) {
          _bumpTeam(emp, def, sh.shiftHours)
          if (sh.note) _addVariant(def, sh.note)
        } else {
          _bumpTeam(emp, '(No team noted)', sh.shiftHours)
          if (sh.note) _addVariant('(No team noted)', sh.note)
        }
      } else {
        const share = sh.shiftHours / teams.length
        // Track raw → canonical variants — matches Python compute_allocations
        // which re-runs the split+normalise so the raw fragment is captured.
        if (typeof sh.note === 'string') {
          for (const raw of sh.note.split(TEAM_SPLIT_RE)) {
            const rn = normalizeTeam(raw)
            if (rn) _addVariant(rn, raw.trim())
          }
        }
        for (const t of teams) _bumpTeam(emp, t, share)
      }
    }
    return { empTeamHours, empTotalHours, empMeta, rawVariantsPerTeam }
  }

  // ---------------------------------------------------------------------
  // Regression tests (spec §7). Gated to `?payrolltest=1` so production
  // loads don't pay the console cost. Wired at module-end after VIEWS extend.
  // ---------------------------------------------------------------------

  function _runTests() {
    const results = []
    function check(label, got, want) {
      const pass = JSON.stringify(got) === JSON.stringify(want)
      results.push({ label, pass, got, want })
      return pass
    }

    // 7.1 — single-team
    check('7.1 single Ballers', parseTeams('Ballers'), ['Ballers'])
    // 7.2 — two-team with &
    check('7.2 Ballers & Targaryens', parseTeams('Ballers & Targaryens'),
      ['Ballers', 'Targaryens'])
    // 7.3 — seven-team comma split
    check('7.3 seven-team comma',
      parseTeams('Tornadoes, Farmers, Hoekers, Surfers, Dutchmen, Llamas, Raccoons'),
      ['Tornadoes', 'Farmers', 'Hoekers', 'Surfers', 'Dutchmen', 'Llamas', 'Raccoons'])
    // 7.4 — emoji + typo, includes U+FE0F variation selector
    check('7.4 emoji warriors', parseTeams('\u{1F6E1}️warriors \u{1F6E1}️'),
      ['Warriors'])
    // 7.5 — suffix strip
    check('7.5 Spartans Cm', parseTeams('Spartans Cm'), ['Spartans'])
    // 7.6 — standalone Cm dropped
    check('7.6 standalone Cm', parseTeams('Cm'), [])
    // 7.7 — apostrophe collapse
    check("7.7 Fury's", parseTeams("Fury's"), ['Furys'])
    // 7.8 — Engine Room aliases (non-canonical canonical-form)
    check('7.8a Engine Room First Day', parseTeams('Engine Room First Day'), ['Engine Room'])
    check('7.8b Engine Room 1st Day', parseTeams('Engine Room 1st Day'), ['Engine Room'])
    check('7.8c Engine Room- First Day', parseTeams('Engine Room- First Day'), ['Engine Room'])
    // 7.9 — Justin → Tigers
    check('7.9a Justin', parseTeams('Justin'), ['Tigers'])
    check('7.9b Justin Day 1', parseTeams('Justin Day 1'), ['Tigers'])
    check('7.9c Justin (tigers', parseTeams('Justin (tigers'), ['Tigers'])
    check('7.9d Justin(tigers', parseTeams('Justin(tigers'), ['Tigers'])
    // 7.10 — Hubspot → Hout Baes
    check('7.10a Hout Baes Hubspot Tasks', parseTeams('Hout Baes Hubspot Tasks'), ['Hout Baes'])
    check('7.10b Houtbaes Hubspot', parseTeams('Houtbaes Hubspot'), ['Hout Baes'])
    check('7.10c Hubspot', parseTeams('Hubspot'), ['Hout Baes'])
    // 7.11 — Claire Murch fallback (whole compute, not just parseTeams)
    {
      const alloc = computeAllocations([{
        agentName: 'Claire Murch', shiftHours: 9, note: '',
      }])
      const m = alloc.empTeamHours.get('Claire Murch')
      check('7.11 Claire blank → Nelio Assiss', m && m.get('Nelio Assiss'), 9)
    }
    // 7.12 — pay-period auto-detect
    {
      const p1 = currentPayPeriod(new Date(2026, 3, 25)) // 25 Apr 2026
      check('7.12a 25 Apr', p1.label, '2026-04-21 → 2026-05-20')
      const p2 = currentPayPeriod(new Date(2026, 4, 15)) // 15 May 2026
      check('7.12b 15 May', p2.label, '2026-04-21 → 2026-05-20')
      const p3 = currentPayPeriod(new Date(2026, 0, 5))  // 5 Jan 2026
      check('7.12c 5 Jan', p3.label, '2025-12-21 → 2026-01-20')
      const p4 = currentPayPeriod(new Date(2026, 11, 21)) // 21 Dec 2026
      check('7.12d 21 Dec', p4.label, '2026-12-21 → 2027-01-20')
    }
    // 7.13 — round-half-up
    check('7.13a 8.4%', roundHalfUp(0.084), 0.08)
    check('7.13b 8.5%', roundHalfUp(0.085), 0.09)
    check('7.13c 8.6%', roundHalfUp(0.086), 0.09)
    check('7.13d 11.42%', roundHalfUp(0.1142), 0.11)
    check('7.13e 32.56%', roundHalfUp(0.3256), 0.33)

    const passed = results.filter(r => r.pass).length
    const failed = results.filter(r => !r.pass)
    // Summary
    const tag = '%c[PAYROLL TEST]'
    const style = failed.length ? 'color:#b1303a;font-weight:700' : 'color:#1c873a;font-weight:700'
    console.log(`${tag} ${passed}/${results.length} cases pass`, style)
    if (failed.length) {
      console.group('[PAYROLL TEST] failures')
      failed.forEach(f => console.warn(f.label, 'got', f.got, 'want', f.want))
      console.groupEnd()
    }
    return { passed, total: results.length, failures: failed }
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  window.PAYROLL = {
    CONFIG,                       // mutable reference-data object (live)
    // Back-compat getter properties so any caller still reaching for
    // PAYROLL.CANONICAL_TEAMS etc. transparently reads from CONFIG.
    get CANONICAL_TEAMS() { return CONFIG.CANONICAL_TEAMS },
    get CANONICAL_LC()    { return CONFIG.CANONICAL_LC },
    get CANONICAL_SET()   { return CONFIG.CANONICAL_SET },
    get TYPO_MAP()        { return CONFIG.TYPO_MAP },
    get ALIAS_PATTERNS()  { return CONFIG.ALIAS_PATTERNS },
    get DROP_STANDALONE() { return CONFIG.DROP_STANDALONE },
    get EMPLOYEE_DEFAULT_TEAM() { return CONFIG.EMPLOYEE_DEFAULT_TEAM },
    normalizeTeam,
    parseTeams,
    currentPayPeriod,
    payPeriodsForPicker,
    hoursDecimal,
    decimalToHHMM,
    roundHalfUp,
    fetchShiftsForPeriod,
    computeAllocations,
    loadConfigFromSupabase,
    reloadConfig,
    ensureConfigLoaded,
    _rebuildDerived,
    _runTests,
  }

  // ---------------------------------------------------------------------
  // Views — extend window.VIEWS (views.js loaded before us)
  // ---------------------------------------------------------------------

  if (!window.VIEWS) window.VIEWS = {}
  const V = window.VIEWS

  // Reusable export-button markup matching the rest of the dashboard's
  // .card-head pattern. The global .js-export listener in app.js (around
  // line 325) auto-wires the click handler to exportCurrentTab(), which
  // routes per active Payroll sub-view via csvPayroll().
  // window.ICON is guaranteed at module-init by index.html's defer order
  // (lib.js → payroll.js); fall back to a literal arrow if absent (Node).
  function _exportBtn() {
    const dl = (window.ICON && window.ICON.download) || ''
    return `<button class="btn js-export">${dl} Export CSV</button>`
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  // SAST-anchored — must not vary with the viewer's browser timezone.
  function _fmtDateLabel(iso) {
    if (!iso) return ''
    const d = new Date(iso)
    if (!Number.isFinite(d.getTime())) return ''
    const { y, m, d: day } = _sastYMD(d)
    return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  function _fmtTimeLabel(iso) {
    if (!iso) return ''
    const d = new Date(iso)
    if (!Number.isFinite(d.getTime())) return ''
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: SAST_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d)
    const get = k => parts.find(p => p.type === k).value
    return `${get('hour')}:${get('minute')}`
  }
  function _fmtZAR(amount) {
    if (amount == null || !Number.isFinite(Number(amount))) return ''
    return 'R ' + Number(amount).toLocaleString('en-ZA', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    })
  }

  // Top-level Payroll view: period picker + sub-tab nav + host for the
  // active sub-view. `state` is the module-level payrollState owned by app.js.
  V.payroll = function (state) {
    const periods = payPeriodsForPicker(12)
    const curLabel = state && state.period ? state.period.label : periods[0].label
    const opts = periods.map(p =>
      `<option value="${esc(p.label)}" ${p.label === curLabel ? 'selected' : ''}>${esc(p.label)}</option>`
    ).join('')

    const subTabs = [
      ['allShifts', 'All Shifts'],
      ['perAgent', 'Per-Agent Allocations'],
      ['byDivision', 'By Division'],
      ['divisionCosts', 'Division Costs'],
      ['earnings', 'Earnings'],
      ['comparison', 'Salary vs Earnings'],
    ]
    const activeView = (state && state.activeView) || 'allShifts'
    const subNav = subTabs.map(([id, label]) =>
      `<button class="${id === activeView ? 'active' : ''}" data-payroll-view="${id}">${label}</button>`
    ).join('')

    let body = ''
    if (state && state.loading) {
      body = `<div class="card card-pad" style="text-align:center;color:var(--muted);padding:40px">Loading shifts for ${esc(curLabel)}…</div>`
    } else if (state && state.error) {
      body = `<div class="card card-pad" style="color:var(--red)">Failed to load: ${esc(state.error)}</div>`
    } else if (!state || !state.shifts) {
      body = `<div class="card card-pad" style="color:var(--muted)">No data yet.</div>`
    } else {
      const shifts = state.shifts
      const alloc = state.allocations
      if (activeView === 'allShifts') body = V.payrollAllShifts(shifts)
      else if (activeView === 'perAgent') body = V.payrollPerAgent(alloc.empTeamHours, alloc.empTotalHours, alloc.empMeta)
      else if (activeView === 'byDivision') body = V.payrollByDivision(alloc.empTeamHours, alloc.empTotalHours)
      else if (activeView === 'divisionCosts') body = V.payrollDivisionCosts(alloc.empTeamHours, alloc.empTotalHours, alloc.empMeta, (state && state.divCostTeam) || 'all')
      else if (activeView === 'earnings') body = V.payrollEarnings(alloc.empTotalHours, alloc.empMeta)
    else if (activeView === 'comparison') body = V.payrollComparison(alloc.empTotalHours, alloc.empMeta)
    }

    return `
    <div class="tab-view">
      <div class="card card-pad">
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:14px">
          <div class="field" style="margin-bottom:0">
            <label>Pay period</label>
            <select id="payrollPeriod" style="min-width:240px">
              ${opts}
            </select>
          </div>
          <div class="seg" id="payrollSubNav" style="flex:1 1 auto">${subNav}</div>
        </div>
      </div>
      <div id="payrollBody" class="mt">${body}</div>
    </div>`
  }

  // Standalone director report — the Division Costs pivot on its own top-level
  // tab (super-only), with the SDL column hidden. Reuses the exact same payroll
  // pay-period data pipeline (shifts + allocations) as V.payroll; the only
  // differences are that it shows a single view and drops the SDL figure.
  // `state` is the shared payrollState owned by app.js.
  V.divCostsReport = function (state) {
    const periods = payPeriodsForPicker(12)
    const curLabel = state && state.period ? state.period.label : periods[0].label
    const opts = periods.map(p =>
      `<option value="${esc(p.label)}" ${p.label === curLabel ? 'selected' : ''}>${esc(p.label)}</option>`
    ).join('')

    let body = ''
    if (state && state.loading) {
      body = `<div class="card card-pad" style="text-align:center;color:var(--muted);padding:40px">Loading shifts for ${esc(curLabel)}…</div>`
    } else if (state && state.error) {
      body = `<div class="card card-pad" style="color:var(--red)">Failed to load: ${esc(state.error)}</div>`
    } else if (!state || !state.shifts || !state.allocations) {
      body = `<div class="card card-pad" style="color:var(--muted)">No data yet.</div>`
    } else {
      const alloc = state.allocations
      body = V.payrollDivisionCosts(alloc.empTeamHours, alloc.empTotalHours, alloc.empMeta,
        (state && state.divCostTeams) || [], { hideSdl: true })
    }

    return `
    <div class="tab-view">
      <div class="card card-pad">
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:14px">
          <div class="field" style="margin-bottom:0">
            <label>Pay period</label>
            <select id="payrollPeriod" style="min-width:240px">
              ${opts}
            </select>
          </div>
        </div>
      </div>
      <div id="payrollBody" class="mt">${body}</div>
    </div>`
  }

  // §5.1 — All Shifts, grouped by agent with blank separator rows.
  V.payrollAllShifts = function (shifts) {
    if (!shifts || !shifts.length) {
      return `<div class="card card-pad" style="color:var(--muted)">No closed shifts in this pay period.</div>`
    }
    // Group by agentName preserving sort order
    const byAgent = new Map()
    for (const sh of shifts) {
      if (!byAgent.has(sh.agentName)) byAgent.set(sh.agentName, [])
      byAgent.get(sh.agentName).push(sh)
    }
    let html = ''
    const totalShifts = shifts.length
    const totalHours = shifts.reduce((s, x) => s + x.shiftHours, 0)
    html += `
      <div class="card">
        <div class="card-head">
          <div>
            <h3>All Shifts</h3>
            <div class="sub">${byAgent.size} agent${byAgent.size === 1 ? '' : 's'} · ${totalShifts} shift${totalShifts === 1 ? '' : 's'} · ${decimalToHHMM(totalHours)} total</div>
          </div>
          ${_exportBtn()}
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th>First name</th>
            <th>Last name</th>
            <th>Type</th>
            <th>Start Date</th>
            <th>In</th>
            <th>End Date</th>
            <th>Out</th>
            <th>Employee notes</th>
            <th class="num">Shift hours</th>
            <th class="num">Total work hours</th>
          </tr></thead>
          <tbody>`
    let first = true
    for (const [agent, list] of byAgent) {
      if (!first) {
        html += `<tr class="payroll-sep"><td colspan="10" style="background:#FAF7EF;border-top:2px solid var(--line);height:8px"></td></tr>`
      }
      first = false
      const total = list.reduce((s, x) => s + x.shiftHours, 0)
      list.forEach((sh, idx) => {
        const nameParts = (sh.agentName || '').split(/\s+/)
        const fn = nameParts.slice(0, -1).join(' ') || nameParts[0] || ''
        const ln = nameParts.length > 1 ? nameParts[nameParts.length - 1] : ''
        const type = sh.designation || 'Shift'
        html += `<tr>
          <td>${esc(fn)}</td>
          <td>${esc(ln)}</td>
          <td>${esc(type)}</td>
          <td class="tnum">${esc(_fmtDateLabel(sh.clockInAt))}</td>
          <td class="tnum">${esc(_fmtTimeLabel(sh.clockInAt))}</td>
          <td class="tnum">${esc(_fmtDateLabel(sh.clockOutAt))}</td>
          <td class="tnum">${esc(_fmtTimeLabel(sh.clockOutAt))}</td>
          <td>${esc(sh.note || '')}</td>
          <td class="num tnum">${decimalToHHMM(sh.shiftHours)}</td>
          <td class="num tnum"><b>${idx === 0 ? decimalToHHMM(total) : ''}</b></td>
        </tr>`
      })
    }
    html += `</tbody></table></div></div>`
    return html
  }

  // §5.2 — Per-Agent Allocations.
  V.payrollPerAgent = function (empTeamHours, empTotalHours, empMeta) {
    if (!empTeamHours || empTeamHours.size === 0) {
      return `<div class="card card-pad" style="color:var(--muted)">No allocations to show for this pay period.</div>`
    }
    const agents = Array.from(empTeamHours.keys()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    let html = `
      <div class="card">
        <div class="card-head">
          <div>
            <h3>Per-Agent Allocations</h3>
            <div class="sub">Each agent's pay-period hours broken down by division · R column = hours × hourly_rate</div>
          </div>
          ${_exportBtn()}
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th>Agent</th>
            <th>Team / Division</th>
            <th class="num">Hours (HH:MM)</th>
            <th class="num">Hours (Decimal)</th>
            <th class="num">% of Agent's Time</th>
            <th class="num">R-amount</th>
          </tr></thead>
          <tbody>`
    let first = true
    for (const agent of agents) {
      if (!first) html += `<tr><td colspan="6" style="height:6px;background:transparent;border:0"></td></tr>`
      first = false
      const teams = Array.from(empTeamHours.get(agent).entries())
        .sort((a, b) => b[1] - a[1])
      const total = empTotalHours.get(agent) || teams.reduce((s, t) => s + t[1], 0)
      const rate = empMeta && empMeta.get(agent) ? empMeta.get(agent).hourlyRate : null
      let sumDec = 0, sumPct = 0, sumPay = 0
      for (const [team, hrs] of teams) {
        const dec = Math.round(hrs * 100) / 100
        const pct = total > 0 ? (hrs / total) * 100 : 0
        sumDec += dec
        sumPct += pct
        const pay = rate != null ? hrs * rate : null
        if (pay != null) sumPay += pay
        html += `<tr>
          <td>${esc(agent)}</td>
          <td>${esc(team)}</td>
          <td class="num tnum">${decimalToHHMM(hrs)}</td>
          <td class="num tnum">${dec.toFixed(2)}</td>
          <td class="num tnum">${pct.toFixed(1)}%</td>
          <td class="num tnum">${pay == null ? '<span style="color:var(--muted)">—</span>' : _fmtZAR(pay)}</td>
        </tr>`
      }
      html += `<tr style="background:var(--paper);font-weight:700">
        <td>${esc(agent)} — TOTAL</td>
        <td>${rate == null ? '<span style="font-weight:400;color:var(--muted);font-size:12px">no rate set</span>' : '<span style="font-weight:400;color:var(--muted);font-size:12px">@ ' + _fmtZAR(rate) + '/hr</span>'}</td>
        <td class="num tnum">${decimalToHHMM(total)}</td>
        <td class="num tnum">${sumDec.toFixed(2)}</td>
        <td class="num tnum">${sumPct.toFixed(1)}%</td>
        <td class="num tnum">${rate == null ? '<span style="color:var(--muted)">—</span>' : _fmtZAR(sumPay)}</td>
      </tr>`
    }
    html += `</tbody></table></div></div>`
    return html
  }

  // §+ — Earnings: payslip-style per-agent summary for whoever cuts cheques.
  V.payrollEarnings = function (empTotalHours, empMeta) {
    if (!empTotalHours || empTotalHours.size === 0) {
      return `<div class="card card-pad" style="color:var(--muted)">No closed shifts in this pay period.</div>`
    }
    const agents = Array.from(empTotalHours.keys()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    let grandHours = 0, grandPay = 0, missingRate = 0
    const rows = agents.map(agent => {
      const total = empTotalHours.get(agent) || 0
      const meta = empMeta ? empMeta.get(agent) : null
      const rate = meta ? meta.hourlyRate : null
      const designation = meta ? meta.designation : ''
      const division = meta ? meta.division : ''
      const pay = rate != null ? total * rate : null
      grandHours += total
      if (pay != null) grandPay += pay
      else missingRate++
      const nameParts = (agent || '').split(/\s+/)
      const fn = nameParts.slice(0, -1).join(' ') || nameParts[0] || ''
      const ln = nameParts.length > 1 ? nameParts[nameParts.length - 1] : ''
      return `<tr>
        <td>${esc(fn)}</td>
        <td>${esc(ln)}</td>
        <td>${esc(designation || '—')}</td>
        <td>${esc(division || '—')}</td>
        <td class="num tnum">${decimalToHHMM(total)}</td>
        <td class="num tnum">${total.toFixed(2)}</td>
        <td class="num tnum">${rate == null ? '<span style="color:var(--red)" title="No hourly_rate set in staff table">— missing</span>' : _fmtZAR(rate)}</td>
        <td class="num tnum">${pay == null ? '<span style="color:var(--red)">—</span>' : _fmtZAR(pay)}</td>
      </tr>`
    }).join('')
    const warn = missingRate > 0
      ? `<div class="sub" style="color:var(--red);margin-top:8px"><b>${missingRate}</b> agent${missingRate === 1 ? '' : 's'} missing an hourly_rate — set it in the quay-clock admin (Edit Staff) so they appear in the total.</div>`
      : ''
    return `
      <div class="card">
        <div class="card-head">
          <div>
            <h3>Earnings</h3>
            <div class="sub">Total hours × hourly_rate per agent for the selected pay period</div>
          </div>
          ${_exportBtn()}
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th>First name</th>
            <th>Last name</th>
            <th>Designation</th>
            <th>Division</th>
            <th class="num">Hours (HH:MM)</th>
            <th class="num">Hours (Decimal)</th>
            <th class="num">Hourly Rate</th>
            <th class="num">Total Pay</th>
          </tr></thead>
          <tbody>${rows}
            <tr style="background:var(--paper);font-weight:700">
              <td colspan="4">TOTAL — ${agents.length} agent${agents.length === 1 ? '' : 's'}</td>
              <td class="num tnum">${decimalToHHMM(grandHours)}</td>
              <td class="num tnum">${grandHours.toFixed(2)}</td>
              <td></td>
              <td class="num tnum">${_fmtZAR(grandPay)}</td>
            </tr>
          </tbody>
        </table></div>
        ${warn}
      </div>`
  }

  // Salary vs Earnings — compares each agent's FULL monthly salary against
  // what they actually earned this pay period (hours × hourly_rate). The
  // "Shortfall" column is what they missed out on by working fewer hours
  // (e.g. only 3 of 4 weeks). A negative shortfall means they earned at or
  // above their salary (overtime), shown in green.
  V.payrollComparison = function (empTotalHours, empMeta) {
    if (!empTotalHours || empTotalHours.size === 0) {
      return `<div class="card card-pad" style="color:var(--muted)">No closed shifts in this pay period.</div>`
    }
    const GREEN = 'var(--green,#0E6B3A)'
    const agents = Array.from(empTotalHours.keys()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    let grandEarned = 0, grandSalary = 0, grandDiff = 0
    let missingRate = 0, missingSalary = 0
    const rows = agents.map(agent => {
      const total = empTotalHours.get(agent) || 0
      const meta = empMeta ? empMeta.get(agent) : null
      const rate = meta ? meta.hourlyRate : null
      const salary = meta ? meta.salary : null
      const designation = meta ? meta.designation : ''
      const division = meta ? meta.division : ''
      const earned = rate != null ? total * rate : null
      // Shortfall only makes sense when we have both a salary and actual earnings.
      const canCompare = earned != null && salary != null
      const diff = canCompare ? (salary - earned) : null   // +ve = missed out
      const pctEarned = canCompare && salary > 0 ? (earned / salary) * 100 : null
      if (earned != null) grandEarned += earned
      if (salary != null) grandSalary += salary
      if (canCompare) grandDiff += diff
      if (rate == null) missingRate++
      if (salary == null) missingSalary++
      const nameParts = (agent || '').split(/\s+/)
      const fn = nameParts.slice(0, -1).join(' ') || nameParts[0] || ''
      const ln = nameParts.length > 1 ? nameParts[nameParts.length - 1] : ''
      const earnedCell = earned == null
        ? '<span style="color:var(--red)" title="No hourly_rate set in staff table">— missing rate</span>'
        : _fmtZAR(earned)
      const salaryCell = salary == null
        ? '<span style="color:var(--red)" title="No salary set in staff table">— no salary</span>'
        : _fmtZAR(salary)
      let diffCell = '<span style="color:var(--muted)">—</span>'
      if (canCompare) {
        if (diff > 0) diffCell = `<span style="color:var(--red);font-weight:700" title="Missed out this period">${_fmtZAR(diff)}</span>`
        else if (diff < 0) diffCell = `<span style="color:${GREEN};font-weight:700" title="Earned above salary (overtime)">+${_fmtZAR(-diff)}</span>`
        else diffCell = _fmtZAR(0)
      }
      const pctCell = pctEarned == null
        ? '<span style="color:var(--muted)">—</span>'
        : `${pctEarned.toFixed(0)}%`
      return `<tr>
        <td>${esc(fn)}</td>
        <td>${esc(ln)}</td>
        <td>${esc(designation || '—')}</td>
        <td>${esc(division || '—')}</td>
        <td class="num tnum">${total.toFixed(2)}</td>
        <td class="num tnum">${earnedCell}</td>
        <td class="num tnum">${salaryCell}</td>
        <td class="num tnum">${pctCell}</td>
        <td class="num tnum">${diffCell}</td>
      </tr>`
    }).join('')
    const grandPct = grandSalary > 0 ? (grandEarned / grandSalary) * 100 : null
    const grandDiffCell = grandDiff > 0
      ? `<span style="color:var(--red)">${_fmtZAR(grandDiff)}</span>`
      : grandDiff < 0 ? `<span style="color:${GREEN}">+${_fmtZAR(-grandDiff)}</span>` : _fmtZAR(0)
    const warns = []
    if (missingRate > 0) warns.push(`<b>${missingRate}</b> agent${missingRate === 1 ? '' : 's'} missing an hourly_rate`)
    if (missingSalary > 0) warns.push(`<b>${missingSalary}</b> missing a salary`)
    const warn = warns.length
      ? `<div class="sub" style="color:var(--red);margin-top:8px">${warns.join(' · ')} — set these in the quay-clock admin (Edit Staff) so they can be compared.</div>`
      : ''
    return `
      <div class="card">
        <div class="card-head">
          <div>
            <h3>Salary vs Earnings</h3>
            <div class="sub">Full monthly salary vs what each agent actually earned this pay period (hours × hourly_rate). Shortfall = what they missed out on by working fewer hours.</div>
          </div>
          ${_exportBtn()}
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th>First name</th>
            <th>Last name</th>
            <th>Designation</th>
            <th>Division</th>
            <th class="num">Hours</th>
            <th class="num">Earned</th>
            <th class="num">Full Salary</th>
            <th class="num" title="Earned as a percentage of full salary">% of Salary</th>
            <th class="num" title="Full salary minus what they earned. Positive = missed out; green = earned above salary.">Shortfall</th>
          </tr></thead>
          <tbody>${rows}
            <tr style="background:var(--paper);font-weight:700">
              <td colspan="5">TOTAL — ${agents.length} agent${agents.length === 1 ? '' : 's'}</td>
              <td class="num tnum">${_fmtZAR(grandEarned)}</td>
              <td class="num tnum">${_fmtZAR(grandSalary)}</td>
              <td class="num tnum">${grandPct == null ? '—' : grandPct.toFixed(0) + '%'}</td>
              <td class="num tnum">${grandDiffCell}</td>
            </tr>
          </tbody>
        </table></div>
        ${warn}
      </div>`
  }

  // §5.3 — By Division (wide pivot). Uses round-half-up for the displayed %.
  V.payrollByDivision = function (empTeamHours, empTotalHours) {
    // Invert empTeamHours into team → { emp: hrs }
    const teamEmp = new Map()
    if (empTeamHours) {
      empTeamHours.forEach((teams, emp) => {
        teams.forEach((hrs, t) => {
          if (!teamEmp.has(t)) teamEmp.set(t, new Map())
          teamEmp.get(t).set(emp, hrs)
        })
      })
    }
    // Headcount per team (max determines column count)
    let maxHead = 1
    teamEmp.forEach(m => { if (m.size > maxHead) maxHead = m.size })
    if (maxHead < 1) maxHead = 1

    // Non-canonical = anything in teamEmp not in CONFIG.CANONICAL_SET,
    // except the (No team noted) bucket which goes last.
    const nonCanonical = []
    teamEmp.forEach((_m, t) => {
      if (!CONFIG.CANONICAL_SET.has(t) && t !== '(No team noted)') nonCanonical.push(t)
    })
    nonCanonical.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    const hasNoTeam = teamEmp.has('(No team noted)')

    // Header
    const headCells = []
    headCells.push('<th>DIVISION</th>')
    for (let n = 1; n <= maxHead; n++) {
      headCells.push(`<th>F NAME / LN NAME ${n}</th>`)
      headCells.push(`<th class="num">PERCENTAGE</th>`)
    }
    headCells.push('<th>NOTES</th>')

    function rowFor(team, note) {
      const members = teamEmp.get(team) || new Map()
      const sorted = Array.from(members.entries()).map(([emp, hrs]) => {
        const tot = empTotalHours.get(emp) || 0
        const raw = tot > 0 ? hrs / tot : 0
        return { emp, hrs, pct: raw }
      }).sort((a, b) => b.pct - a.pct)
      const cells = [`<td><b>${esc(team)}</b></td>`]
      for (let i = 0; i < maxHead; i++) {
        if (i < sorted.length) {
          const x = sorted[i]
          const display = Math.round(roundHalfUp(x.pct) * 100) // back to 0–100 int
          cells.push(`<td>${esc(x.emp)}</td>`)
          cells.push(`<td class="num tnum">${display}%</td>`)
        } else {
          cells.push('<td></td><td></td>')
        }
      }
      cells.push(`<td style="color:var(--muted);font-size:12px">${esc(note)}</td>`)
      const cls = members.size === 0 ? ' class="empty-row"' : ''
      return `<tr${cls}>${cells.join('')}</tr>`
    }

    let body = ''
    // Canonical rows first, in §3.1 order, including empty ones.
    for (const team of CONFIG.CANONICAL_TEAMS) {
      const members = teamEmp.get(team)
      const note = (members && members.size) ? '' : 'no agents this period'
      body += rowFor(team, note)
    }
    // Separator
    if (nonCanonical.length || hasNoTeam) {
      const spanCols = 1 + maxHead * 2 + 1
      body += `<tr class="payroll-noncanon-sep">
        <td colspan="${spanCols}" style="background:var(--red);color:#fff;text-align:center;font-weight:700;letter-spacing:0.4px;padding:10px">
          Not in master list — review
        </td>
      </tr>`
      for (const team of nonCanonical) body += rowFor(team, 'Not in master list')
      if (hasNoTeam) body += rowFor('(No team noted)', 'Shifts where the Employee notes field was blank')
    }

    return `
      <div class="card">
        <div class="card-head">
          <div>
            <h3>By Division</h3>
            <div class="sub">Wide pivot · % of <i>that agent's</i> pay-period time on each division · round-half-up</div>
          </div>
          ${_exportBtn()}
        </div>
        <div class="tbl-wrap"><table class="tbl payroll-bydiv">
          <thead><tr>${headCells.join('')}</tr></thead>
          <tbody>${body}</tbody>
        </table></div>
      </div>`
  }

  // Division Costs — wide pivot for cost-attribution (mirrors the Excel
  // sheet the bookkeeper uses). Per division row: up to N agent blocks of
  // (NAME, PAYROLL AMOUNT, SDL, PERCENTAGE, DIV CONTRIBUTION) + TOTAL
  // FANCY/LN + NOTES.
  //   PAYROLL AMOUNT     = agent's pay-period gross (totalHours × hourly_rate)
  //   SDL                = PAYROLL × 0.011 (SA Skills Development Levy)
  //   PERCENTAGE         = div_hours / total_hours (agent's time share)
  //   DIV CONTRIBUTION   = (PAYROLL × PERCENTAGE) / 2 + (SDL × PERCENTAGE)
  //                        Only the PAYROLL portion is halved; SDL is
  //                        paid in full at its pro-rated share (the SDL
  //                        column itself stays at PAYROLL × 0.011 too —
  //                        not halved).
  //   TOTAL FANCY/LN     = sum of DIV CONTRIBUTION across agents in this row
  // Ordered list of every division available to the Division Costs picker:
  // canonical (master order) + any non-canonical present + the no-team bucket.
  // Shared by the view, the live table re-render, and the CSV export so all
  // three agree on ordering and membership.
  V.divCostAllTeams = function (empTeamHours) {
    const teamEmp = new Map()
    if (empTeamHours) {
      empTeamHours.forEach((teams, emp) => {
        teams.forEach((_hrs, t) => {
          if (!teamEmp.has(t)) teamEmp.set(t, new Set())
          teamEmp.get(t).add(emp)
        })
      })
    }
    const nonCanonical = []
    teamEmp.forEach((_m, t) => {
      if (!CONFIG.CANONICAL_SET.has(t) && t !== '(No team noted)') nonCanonical.push(t)
    })
    nonCanonical.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    return CONFIG.CANONICAL_TEAMS
      .concat(nonCanonical)
      .concat(teamEmp.has('(No team noted)') ? ['(No team noted)'] : [])
  }

  // Just the Division Costs <table> (wrapped in .tbl-wrap), for the given
  // `selected` division names (empty array = all divisions). Kept separate from
  // the card shell so ticking a checkbox can re-render only the table without
  // rebuilding — and closing — the multi-select picker.
  V.payrollDivisionCostsTable = function (empTeamHours, empTotalHours, empMeta, selected, opts) {
    const SDL_RATE = 0.011
    // When hideSdl is set (the standalone "Division Costs" director report),
    // the SDL column is dropped from the header, every agent block, and the
    // grand-total row. The DIV CONTRIBUTION math is UNCHANGED — SDL is still
    // folded into it exactly as before; only the visible figure is hidden.
    const hideSdl = !!(opts && opts.hideSdl)
    const NB = hideSdl ? 4 : 5 // cells per agent block (5 with SDL, 4 without)

    // Invert empTeamHours → team → Map<emp, hrs>
    const teamEmp = new Map()
    if (empTeamHours) {
      empTeamHours.forEach((teams, emp) => {
        teams.forEach((hrs, t) => {
          if (!teamEmp.has(t)) teamEmp.set(t, new Map())
          teamEmp.get(t).set(emp, hrs)
        })
      })
    }

    const nonCanonical = []
    teamEmp.forEach((_m, t) => {
      if (!CONFIG.CANONICAL_SET.has(t) && t !== '(No team noted)') nonCanonical.push(t)
    })
    nonCanonical.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    const hasNoTeam = teamEmp.has('(No team noted)')

    // Selection → which divisions render. Empty = all. Order is always the
    // master canonical order, then non-canonical, then the no-team bucket.
    const selSet = new Set(Array.isArray(selected) ? selected : [])
    const isFiltered = selSet.size > 0
    const canonRows   = CONFIG.CANONICAL_TEAMS.filter(t => !isFiltered || selSet.has(t))
    const nonCanonRows = nonCanonical.filter(t => !isFiltered || selSet.has(t))
    const showNoTeam  = hasNoTeam && (!isFiltered || selSet.has('(No team noted)'))
    const rowTeams = canonRows.concat(nonCanonRows, showNoTeam ? ['(No team noted)'] : [])

    // Column count (agent blocks) is sized to the RENDERED divisions only, so
    // filtering to a few teams collapses the wide pivot to their headcount.
    let maxHead = 1
    rowTeams.forEach(t => { const m = teamEmp.get(t); if (m && m.size > maxHead) maxHead = m.size })
    if (maxHead < 1) maxHead = 1

    // Note text for a division row (canonical / non-canonical / no-team).
    const noteFor = (team) => {
      if (team === '(No team noted)') return 'Shifts where the Employee notes field was blank'
      if (!CONFIG.CANONICAL_SET.has(team)) return 'Not in master list'
      const m = teamEmp.get(team)
      return (m && m.size) ? '' : 'no agents this period'
    }

    // Header — 1 (division) + 5N (agent blocks) + 1 (total) + 1 (notes)
    const headCells = ['<th>DIVISION</th>']
    for (let n = 1; n <= maxHead; n++) {
      headCells.push(`<th>FANCY / LN NAME ${n}</th>`)
      headCells.push(`<th class="num">PAYROLL AMOUNT</th>`)
      if (!hideSdl) headCells.push(`<th class="num">SDL</th>`)
      headCells.push(`<th class="num">PERCENTAGE</th>`)
      headCells.push(`<th class="num">DIV CONTRIBUTION</th>`)
    }
    headCells.push('<th class="num">TOTAL FANCY/LN</th>')
    headCells.push('<th>NOTES</th>')

    // Running grand-totals (bottom row).
    // PAYROLL and SDL are floor-level totals — each agent contributes once
    // regardless of how many division rows they appear on. (Per-slot sums
    // would multiply every agent's pay by the number of divisions they
    // touched, which is the bug we hit.) DIV CONTRIBUTION is genuinely
    // per-slot — slot i = "cost flowed to the i-th-rank agent across all
    // divisions" — and stays an array.
    const gtCountedEmps = new Set()
    let gtPayrollTotal = 0
    let gtSdlTotal = 0
    let gtContrib = new Array(maxHead).fill(0)
    let gtRowTotal = 0

    function rowFor(team, note) {
      const members = teamEmp.get(team) || new Map()
      // Sort by contribution desc so the biggest cost-holder leads.
      const enriched = Array.from(members.entries()).map(([emp, hrs]) => {
        const meta = empMeta && empMeta.get(emp) ? empMeta.get(emp) : null
        const rate = meta ? meta.hourlyRate : null
        const totalHrs = empTotalHours.get(emp) || 0
        const payroll = rate != null ? totalHrs * rate : null
        const sdl = payroll != null ? payroll * SDL_RATE : null
        // PERCENTAGE = fraction of this agent's pay-period time spent
        // on THIS division. Display as the same one-decimal %-of-time
        // format used on the Per-Agent Allocations view.
        const pct = totalHrs > 0 ? (hrs / totalHrs) : 0
        // DIV CONTRIBUTION = (PAYROLL × PCT) / 2 + (SDL × PCT)
        // SDL is NOT halved — only the payroll portion is. SDL itself is
        // PAYROLL × 0.011 and stays at its pro-rated full value here.
        const contrib = (payroll != null && sdl != null)
          ? (payroll * pct) / 2 + (sdl * pct)
          : null
        return { emp, hrs, rate, payroll, sdl, contrib, pct }
      }).sort((a, b) => (b.contrib || 0) - (a.contrib || 0))

      const cells = [`<td><b>${esc(team)}</b></td>`]
      let rowTotal = 0
      for (let i = 0; i < maxHead; i++) {
        if (i < enriched.length) {
          const x = enriched[i]
          cells.push(`<td>${esc(x.emp)}</td>`)
          cells.push(`<td class="num tnum">${x.payroll == null ? '<span style="color:var(--muted)">—</span>' : _fmtZAR(x.payroll)}</td>`)
          if (!hideSdl) cells.push(`<td class="num tnum">${x.sdl == null ? '<span style="color:var(--muted)">—</span>' : _fmtZAR(x.sdl)}</td>`)
          cells.push(`<td class="num tnum">${(x.pct * 100).toFixed(1)}%</td>`)
          cells.push(`<td class="num tnum">${x.contrib == null ? '<span style="color:var(--muted)">—</span>' : _fmtZAR(x.contrib)}</td>`)
          if (!gtCountedEmps.has(x.emp)) {
            if (x.payroll != null) gtPayrollTotal += x.payroll
            if (x.sdl != null)     gtSdlTotal += x.sdl
            gtCountedEmps.add(x.emp)
          }
          if (x.contrib != null) {
            gtContrib[i] += x.contrib
            rowTotal += x.contrib
          }
        } else {
          cells.push('<td></td>'.repeat(NB))
        }
      }
      cells.push(`<td class="num tnum"><b>${rowTotal > 0 ? _fmtZAR(rowTotal) : '<span style="color:var(--muted)">—</span>'}</b></td>`)
      cells.push(`<td style="color:var(--muted);font-size:12px">${esc(note)}</td>`)
      gtRowTotal += rowTotal
      const cls = members.size === 0 ? ' class="empty-row"' : ''
      return `<tr${cls}>${cells.join('')}</tr>`
    }

    let body = ''
    for (const team of canonRows) body += rowFor(team, noteFor(team))
    if (nonCanonRows.length || showNoTeam) {
      const spanCols = 1 + maxHead * NB + 1 + 1
      body += `<tr class="payroll-noncanon-sep">
        <td colspan="${spanCols}" style="background:var(--red);color:#fff;text-align:center;font-weight:700;letter-spacing:0.4px;padding:10px">
          Not in master list — review
        </td>
      </tr>`
      for (const team of nonCanonRows) body += rowFor(team, 'Not in master list')
      if (showNoTeam) body += rowFor('(No team noted)', 'Shifts where the Employee notes field was blank')
    }
    if (!body) {
      const spanCols = 1 + maxHead * NB + 1 + 1
      body = `<tr><td colspan="${spanCols}" style="text-align:center;color:var(--muted);padding:18px">No divisions match the current selection.</td></tr>`
    }

    // Grand-total row. PAYROLL/SDL floor totals print once in slot 0;
    // the per-slot CONTRIB sums print across all slots.
    const totalCells = ['<td><b>GRAND TOTAL</b></td>']
    for (let i = 0; i < maxHead; i++) {
      totalCells.push('<td></td>')
      totalCells.push(`<td class="num tnum">${i === 0 && gtPayrollTotal ? _fmtZAR(gtPayrollTotal) : ''}</td>`)
      if (!hideSdl) totalCells.push(`<td class="num tnum">${i === 0 && gtSdlTotal ? _fmtZAR(gtSdlTotal) : ''}</td>`)
      totalCells.push('<td></td>')
      totalCells.push(`<td class="num tnum">${gtContrib[i] ? _fmtZAR(gtContrib[i]) : ''}</td>`)
    }
    totalCells.push(`<td class="num tnum"><b>${_fmtZAR(gtRowTotal)}</b></td>`)
    totalCells.push('<td></td>')
    body += `<tr style="background:var(--paper);font-weight:700">${totalCells.join('')}</tr>`

    return `<div class="tbl-wrap"><table class="tbl payroll-divcosts">
        <thead><tr>${headCells.join('')}</tr></thead>
        <tbody>${body}</tbody>
      </table></div>`
  }

  // Human summary of the current multi-selection for the picker button.
  V.divCostSummary = function (selected) {
    const n = Array.isArray(selected) ? selected.length : 0
    if (n === 0) return 'All divisions'
    if (n === 1) return selected[0]
    return `${n} divisions`
  }

  V.payrollDivisionCosts = function (empTeamHours, empTotalHours, empMeta, filterTeams, opts) {
    const hideSdl = !!(opts && opts.hideSdl)
    const allRowTeams = V.divCostAllTeams(empTeamHours)
    // Keep only still-valid selections (a team may vanish between pay periods).
    const selected = (Array.isArray(filterTeams) ? filterTeams : [])
      .filter(t => allRowTeams.includes(t))
    const selSet = new Set(selected)

    const allCaption = hideSdl
      ? 'Cost-attribution pivot · PAYROLL = total hrs × rate · DIV CONTRIBUTION = hours on this division × rate'
      : 'Cost-attribution pivot · PAYROLL = total hrs × rate · SDL = 1.1% levy · DIV CONTRIBUTION = hours on this division × rate'
    const subCaption = selected.length === 0
      ? allCaption
      : `Showing ${selected.length} selected division${selected.length === 1 ? '' : 's'} · use the Divisions picker to change`

    const options = allRowTeams.map(t =>
      `<label class="divcost-opt" style="display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:6px;cursor:pointer;font-size:13px">
        <input type="checkbox" value="${esc(t)}"${selSet.has(t) ? ' checked' : ''} style="margin:0;flex:none">
        <span>${esc(t)}</span>
      </label>`).join('')

    return `
      <div class="card">
        <div class="card-head">
          <div>
            <h3>Division Costs</h3>
            <div class="sub" id="divCostCaption">${subCaption}</div>
          </div>
          <div style="display:flex;align-items:flex-end;gap:12px">
            <div class="field" style="margin-bottom:0;position:relative">
              <label>Divisions</label>
              <button type="button" id="divCostPickerBtn" aria-haspopup="true" aria-expanded="false"
                style="min-width:200px;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--paper,#fff);cursor:pointer;font-size:13px;color:inherit">
                <span id="divCostSummary">${esc(V.divCostSummary(selected))}</span>
                <span aria-hidden="true" style="opacity:.55">▾</span>
              </button>
              <div id="divCostMenu" role="menu"
                style="display:none;position:absolute;right:0;top:calc(100% + 6px);z-index:60;background:var(--paper,#fff);border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 34px rgba(15,23,42,.16);width:270px;padding:10px">
                <input type="text" id="divCostSearch" placeholder="Search divisions…" autocomplete="off"
                  style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px;font-size:13px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                  <span style="font-size:11.5px;color:var(--muted)" id="divCostCount">${selected.length ? selected.length + ' selected' : 'All divisions'}</span>
                  <button type="button" id="divCostClear" style="border:none;background:none;color:var(--brass,#b8860b);font-size:12px;cursor:pointer;padding:2px 4px">Clear</button>
                </div>
                <div id="divCostList" style="max-height:280px;overflow:auto;display:flex;flex-direction:column;gap:1px">${options}</div>
              </div>
            </div>
            ${_exportBtn()}
          </div>
        </div>
        <div id="divCostTableHost"${hideSdl ? ' data-hide-sdl="1"' : ''}>${V.payrollDivisionCostsTable(empTeamHours, empTotalHours, empMeta, selected, { hideSdl })}</div>
      </div>`
  }

  // §5.4 — Data Quality maintenance view.
  V.payrollDataQuality = function (rawVariantsPerTeam) {
    if (!rawVariantsPerTeam || rawVariantsPerTeam.size === 0) {
      return `<div class="card card-pad" style="color:var(--muted)">No raw-notes variants to review — every shift either had a clean canonical match or no notes at all.</div>`
    }
    const teams = Array.from(rawVariantsPerTeam.keys()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    const rows = teams.map(t => {
      const variants = Array.from(rawVariantsPerTeam.get(t)).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      const canonical = CONFIG.CANONICAL_SET.has(t)
      return `<tr>
        <td><b>${esc(t)}</b> ${canonical ? '' : '<span class="pill warn" style="font-size:10.5px;padding:2px 7px;margin-left:6px">non-canonical</span>'}</td>
        <td style="font-family:ui-monospace,Menlo,monospace;font-size:12.5px;color:var(--slate)">${esc(variants.join(' | '))}</td>
        <td class="num tnum">${variants.length}</td>
      </tr>`
    }).join('')
    return `
      <div class="card">
        <div class="card-head">
          <div>
            <h3>Data Quality</h3>
            <div class="sub">Every original Employee-notes fragment that resolved to each canonical team — spot bad merges + new typos</div>
          </div>
          ${_exportBtn()}
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th style="width:24%">Canonical Team</th>
            <th>Original notes / variants seen</th>
            <th class="num" style="width:90px"># variants</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>`
  }

  // ---------------------------------------------------------------------
  // Config sub-view — super-only CRUD for the 5 reference-data tables.
  //
  // Rendered by V.payroll() when activeView === 'config'. All buttons
  // carry data-payroll-config-* attributes so payrollConfigWire() in
  // app.js can dispatch the right Supabase mutation.
  // ---------------------------------------------------------------------

  function _rowsCanonical() {
    // Prefer the live DB row list (so we have ids + display_order to
    // PATCH). Fall back to the static array if DB hasn't been hydrated.
    if (CONFIG._canonicalRows && CONFIG._canonicalRows.length) {
      return CONFIG._canonicalRows.slice().sort((a, b) =>
        (a.display_order || 0) - (b.display_order || 0))
    }
    return CONFIG.CANONICAL_TEAMS.map((name, i) => ({
      id: null, name, display_order: (i + 1) * 10, active: true,
    }))
  }
  function _rowsTypo() {
    if (CONFIG._typoRows && CONFIG._typoRows.length) {
      return CONFIG._typoRows.slice().sort((a, b) => a.key.localeCompare(b.key, undefined, { sensitivity: 'base' }))
    }
    return Object.entries(CONFIG.TYPO_MAP)
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))
      .map(([key, canonical]) => ({ id: null, key, canonical }))
  }
  function _rowsAlias() {
    if (CONFIG._aliasRows && CONFIG._aliasRows.length) {
      return CONFIG._aliasRows.slice().sort((a, b) =>
        (a.priority || 0) - (b.priority || 0))
    }
    return CONFIG.ALIAS_PATTERNS.map((p, i) => ({
      id: null, pattern: p[0].source, target: p[1], priority: (i + 1) * 10,
    }))
  }
  function _rowsDefault() {
    if (CONFIG._defaultRows && CONFIG._defaultRows.length) {
      return CONFIG._defaultRows.slice().sort((a, b) =>
        a.agent_name.localeCompare(b.agent_name, undefined, { sensitivity: 'base' }))
    }
    return Object.entries(CONFIG.EMPLOYEE_DEFAULT_TEAM)
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))
      .map(([agent_name, default_team]) => ({ id: null, agent_name, default_team }))
  }
  function _rowsDrop() {
    if (CONFIG._dropRows && CONFIG._dropRows.length) {
      return CONFIG._dropRows.slice().sort((a, b) => a.code.localeCompare(b.code, undefined, { sensitivity: 'base' }))
    }
    return Array.from(CONFIG.DROP_STANDALONE).sort()
      .map(code => ({ id: null, code }))
  }

  function _seedNotice() {
    // Tells the admin the static fallback is in play (so they know
    // adds/edits will fail silently until the schema is deployed).
    if (CONFIG._version > 0) return ''
    return `<div class="card card-pad" style="background:#FFF6E0;border-color:#E3CC8E;color:#7A5A00;margin-bottom:14px;font-size:13px;line-height:1.5">
      <b>Read-only fallback.</b> Reading from the static JS constants — either
      the <code>payroll_*</code> tables aren't deployed yet, RLS blocked the
      read, or the network is down. Edits won't persist until the schema in
      <code>supabase/schema_payroll_config.sql</code> has been applied to
      Supabase. Click <b>Refresh from DB</b> below after deploy.
    </div>`
  }

  // Build a single section card (used by all 5 lists).
  function _configCard(opts) {
    // opts = { id, title, sub, addForm, rows, emptyMsg }
    return `<div class="card payroll-config-card" data-config-id="${opts.id}">
      <div class="card-head"><div>
        <h3>${esc(opts.title)}</h3>
        <div class="sub">${opts.sub}</div>
      </div></div>
      <div class="card-pad" style="border-top:1px solid var(--line)">
        ${opts.addForm}
      </div>
      <div class="payroll-config-list">
        ${opts.rows || `<div class="card-pad" style="color:var(--muted)">${opts.emptyMsg || 'No entries.'}</div>`}
      </div>
    </div>`
  }

  V.payrollConfig = function (_state) {
    const canonRows = _rowsCanonical()
    const typoRows  = _rowsTypo()
    const aliasRows = _rowsAlias()
    const defRows   = _rowsDefault()
    const dropRows  = _rowsDrop()

    // ----- Canonical Divisions -----
    const canonAddForm = `
      <div class="payroll-config-form">
        <input type="text" data-cf-input="canon-name" placeholder="Division name (e.g. Phoenixes)" style="flex:1 1 220px">
        <input type="number" data-cf-input="canon-order" placeholder="Order"
               value="${canonRows.length ? (canonRows[canonRows.length-1].display_order + 10) : 10}"
               style="width:90px">
        <button class="btn btn-primary" data-cf-action="canon-add">+ Add division</button>
      </div>`
    const canonListHtml = canonRows.map((r, i) => `
      <div class="payroll-config-row" data-cf-row="canon" data-cf-id="${esc(r.id || '')}" data-cf-name="${esc(r.name)}">
        <div class="cf-handle">
          <button class="btn-sm" data-cf-action="canon-up"   data-i="${i}" title="Move up"   ${i === 0 ? 'disabled' : ''}>▲</button>
          <button class="btn-sm" data-cf-action="canon-down" data-i="${i}" title="Move down" ${i === canonRows.length - 1 ? 'disabled' : ''}>▼</button>
          <span class="cf-ord tnum">${r.display_order}</span>
        </div>
        <div class="cf-name"><b>${esc(r.name)}</b></div>
        <div class="cf-actions">
          <button class="btn-sm" data-cf-action="canon-edit"   data-id="${esc(r.id || '')}" data-name="${esc(r.name)}">Edit</button>
          <button class="btn-sm danger" data-cf-action="canon-delete" data-id="${esc(r.id || '')}" data-name="${esc(r.name)}">Delete</button>
        </div>
      </div>`).join('')

    // ----- Typo Map -----
    const typoAddForm = `
      <div class="payroll-config-form">
        <input type="text" data-cf-input="typo-key"       placeholder="Typed-as (e.g. Assasins)" style="flex:1 1 200px">
        <span style="color:var(--muted);align-self:center">→</span>
        <input type="text" data-cf-input="typo-canonical" placeholder="Canonical (e.g. Assassins)" style="flex:1 1 200px">
        <button class="btn btn-primary" data-cf-action="typo-add">+ Add typo</button>
      </div>`
    const typoListHtml = typoRows.map(r => `
      <div class="payroll-config-row" data-cf-row="typo" data-cf-id="${esc(r.id || '')}">
        <div class="cf-name"><code>${esc(r.key)}</code> → <b>${esc(r.canonical)}</b></div>
        <div class="cf-actions">
          <button class="btn-sm" data-cf-action="typo-edit"   data-id="${esc(r.id || '')}" data-key="${esc(r.key)}" data-canonical="${esc(r.canonical)}">Edit</button>
          <button class="btn-sm danger" data-cf-action="typo-delete" data-id="${esc(r.id || '')}" data-key="${esc(r.key)}">Delete</button>
        </div>
      </div>`).join('')

    // ----- Alias Patterns -----
    const aliasAddForm = `
      <div class="payroll-config-form">
        <input type="text" data-cf-input="alias-pattern" placeholder="Regex source (e.g. \\bjustin\\b)" style="flex:1 1 220px">
        <span style="color:var(--muted);align-self:center">→</span>
        <input type="text" data-cf-input="alias-target" placeholder="Canonical (e.g. Tigers)" style="flex:1 1 180px">
        <input type="number" data-cf-input="alias-priority" placeholder="Priority"
               value="${aliasRows.length ? (aliasRows[aliasRows.length-1].priority + 10) : 10}"
               style="width:90px">
        <button class="btn btn-primary" data-cf-action="alias-add">+ Add alias</button>
      </div>
      <div class="payroll-config-tester">
        <label>Live test:</label>
        <input type="text" data-cf-input="alias-test" placeholder="Type a raw note to see what it normalises to…" style="flex:1">
        <span class="cf-test-out" data-cf-test-out>—</span>
      </div>`
    const aliasListHtml = aliasRows.map(r => `
      <div class="payroll-config-row" data-cf-row="alias" data-cf-id="${esc(r.id || '')}">
        <div class="cf-ord tnum">${r.priority}</div>
        <div class="cf-name"><code>${esc(r.pattern)}</code> → <b>${esc(r.target)}</b></div>
        <div class="cf-actions">
          <button class="btn-sm" data-cf-action="alias-edit" data-id="${esc(r.id || '')}" data-pattern="${esc(r.pattern)}" data-target="${esc(r.target)}" data-priority="${r.priority}">Edit</button>
          <button class="btn-sm danger" data-cf-action="alias-delete" data-id="${esc(r.id || '')}" data-pattern="${esc(r.pattern)}">Delete</button>
        </div>
      </div>`).join('')

    // ----- Default Team -----
    const defAddForm = `
      <div class="payroll-config-form">
        <input type="text" data-cf-input="def-agent"  placeholder="Agent name (e.g. Claire Murch)" style="flex:1 1 220px">
        <span style="color:var(--muted);align-self:center">→</span>
        <input type="text" data-cf-input="def-team"   placeholder="Default team (e.g. Nelio Assiss)" style="flex:1 1 200px">
        <button class="btn btn-primary" data-cf-action="def-add">+ Add default</button>
      </div>`
    const defListHtml = defRows.map(r => `
      <div class="payroll-config-row" data-cf-row="def" data-cf-id="${esc(r.id || '')}">
        <div class="cf-name"><b>${esc(r.agent_name)}</b> → ${esc(r.default_team)}</div>
        <div class="cf-actions">
          <button class="btn-sm" data-cf-action="def-edit"   data-id="${esc(r.id || '')}" data-agent="${esc(r.agent_name)}" data-team="${esc(r.default_team)}">Edit</button>
          <button class="btn-sm danger" data-cf-action="def-delete" data-id="${esc(r.id || '')}" data-agent="${esc(r.agent_name)}">Delete</button>
        </div>
      </div>`).join('')

    // ----- Drop Standalone -----
    const dropAddForm = `
      <div class="payroll-config-form">
        <input type="text" data-cf-input="drop-code" placeholder="Short-code (e.g. cm)" style="flex:1 1 160px">
        <button class="btn btn-primary" data-cf-action="drop-add">+ Add code</button>
      </div>`
    const dropListHtml = dropRows.map(r => `
      <div class="payroll-config-row" data-cf-row="drop" data-cf-id="${esc(r.id || '')}">
        <div class="cf-name"><code>${esc(r.code)}</code></div>
        <div class="cf-actions">
          <button class="btn-sm danger" data-cf-action="drop-delete" data-id="${esc(r.id || '')}" data-code="${esc(r.code)}">Delete</button>
        </div>
      </div>`).join('')

    return `
      <div class="payroll-config" id="payrollConfig">
        <div class="card card-pad" style="margin-bottom:14px">
          <div style="display:flex;justify-content:space-between;align-items:start;gap:14px;flex-wrap:wrap">
            <div style="max-width:680px">
              <h3 style="margin:0 0 6px;font-family:var(--serif);font-size:18px">Reference data · Config</h3>
              <div style="color:var(--slate);font-size:13px;line-height:1.55">
                These five lists power the §4 algorithm: canonical divisions, exact typo merges,
                regex aliases, per-agent default teams, and short-codes that get dropped entirely.
                Edits go to Supabase and apply to the next Payroll re-render — use the
                <i>Data Quality</i> sub-tab to spot new typos that need adding here.
              </div>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <span class="cf-pill" data-cf-pill style="display:none"></span>
              <button class="btn" data-cf-action="reload">↻ Refresh from DB</button>
            </div>
          </div>
        </div>
        ${_seedNotice()}
        ${_configCard({
          id: 'canon',
          title: 'Canonical Divisions',
          sub: `${canonRows.length} divisions in display order — drives the By Division pivot`,
          addForm: canonAddForm,
          rows: canonListHtml,
        })}
        ${_configCard({
          id: 'typo',
          title: 'Typo Map',
          sub: `${typoRows.length} exact-match merges — applied after title-case, before alias regex`,
          addForm: typoAddForm,
          rows: typoListHtml,
        })}
        ${_configCard({
          id: 'alias',
          title: 'Alias Patterns',
          sub: `${aliasRows.length} regex aliases — case-insensitive, first match wins (priority order)`,
          addForm: aliasAddForm,
          rows: aliasListHtml,
        })}
        ${_configCard({
          id: 'def',
          title: 'Per-Agent Default Team',
          sub: `${defRows.length} agents — fallback team applied when the Employee-notes field is blank`,
          addForm: defAddForm,
          rows: defListHtml,
        })}
        ${_configCard({
          id: 'drop',
          title: 'Drop Standalone Short-codes',
          sub: `${dropRows.length} codes — dropped entirely when they appear alone (e.g. "Cm")`,
          addForm: dropAddForm,
          rows: dropListHtml,
        })}
      </div>`
  }

  // Inject minimal CSS for the Config view. Idempotent — guarded by an
  // attribute on <head>.
  ;(function injectConfigCss() {
    if (typeof document === 'undefined') return
    if (document.documentElement.hasAttribute('data-payroll-config-css')) return
    document.documentElement.setAttribute('data-payroll-config-css', '1')
    const css = `
      .payroll-config-card { margin-bottom:14px }
      .payroll-config-form { display:flex; flex-wrap:wrap; gap:8px; align-items:center }
      .payroll-config-form input { padding:8px 11px; border:1px solid var(--line); border-radius:8px; font-family:Montserrat; font-size:13px }
      .payroll-config-tester { display:flex; gap:8px; align-items:center; margin-top:10px; padding-top:10px; border-top:1px dashed var(--line); font-size:13px }
      .payroll-config-tester label { font-weight:600; color:var(--slate); font-size:12px }
      .payroll-config-tester input { padding:6px 10px; border:1px solid var(--line); border-radius:6px; font-family:Montserrat; font-size:12.5px }
      .cf-test-out { font-family:ui-monospace,Menlo,monospace; font-size:12.5px; padding:4px 9px; background:#F3F0E5; border-radius:6px; color:#3D5BA6; font-weight:700; min-width:90px; text-align:center }
      .cf-test-out.empty { color:var(--muted); font-weight:400 }
      .payroll-config-list { padding:0 }
      .payroll-config-row {
        display:flex; align-items:center; gap:12px;
        padding:9px 18px; border-top:1px solid var(--line);
        font-size:13px;
      }
      .payroll-config-row:first-child { border-top:0 }
      .payroll-config-row .cf-handle { display:flex; align-items:center; gap:4px; min-width:96px }
      .payroll-config-row .cf-ord { color:var(--muted); font-size:11.5px; min-width:32px; text-align:right }
      .payroll-config-row .cf-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
      .payroll-config-row .cf-name code { font-family:ui-monospace,Menlo,monospace; font-size:12px; background:#F3F0E5; padding:1px 6px; border-radius:4px }
      .payroll-config-row .cf-actions { display:flex; gap:6px }
      .btn-sm { padding:5px 10px; font-size:11.5px; border:1px solid var(--line); background:#fff; border-radius:6px; cursor:pointer; font-family:Montserrat; font-weight:600 }
      .btn-sm:hover { background:#F3F0E5 }
      .btn-sm:disabled { opacity:0.4; cursor:not-allowed }
      .btn-sm.danger { color:var(--red); border-color:#E3BDB0 }
      .btn-sm.danger:hover { background:#F8E5DC }
      .cf-pill { padding:4px 10px; border-radius:14px; font-size:11.5px; font-weight:700; background:#DDF2DF; color:#1c873a }
      .cf-pill.err { background:#F8E5DC; color:var(--red) }
    `
    const style = document.createElement('style')
    style.id = 'payroll-config-css'
    style.textContent = css
    document.head.appendChild(style)
  })()

  // Run the regression suite if the URL flag is set. Done LAST so VIEWS
  // is fully wired before tests print their summary.
  try {
    if (typeof location !== 'undefined' && /[?&]payrolltest=1\b/.test(location.search)) {
      _runTests()
    }
  } catch (e) { /* tests are non-blocking */ }
})()

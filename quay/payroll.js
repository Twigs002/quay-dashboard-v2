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
  // Reference data — ported verbatim from build_consolidation.py
  // ---------------------------------------------------------------------

  // Spec §3.1 — 67 canonical divisions in display order. Order matters for
  // the By Division pivot.
  const CANONICAL_TEAMS = [
    'Amigos', 'Assassins', 'Avengers', 'Babes', 'Ballers', 'Boets', 'Bulls',
    'Cavaliers', 'Chargers', 'City Sunsets', 'Conquerors', 'Dealers',
    'Dealmakers', 'Dixies', 'Dolphins', 'Donkeys', 'Dragons', 'Dutchmen',
    'Falcons', 'Farmers', 'Furys', 'Gladiators', 'Goal Diggers', 'Gunslingers',
    'Hawks', 'Headbangers', 'Hoekers', 'Hooligans', 'Hustlers', 'Invincibles',
    'Knights', 'Koeksisters', 'Lions', 'Llamas', 'Musketeers', 'Panthers',
    'Pirates', 'Power Rangers', 'Prom Queens', 'Proteas', 'Raccoons', 'Samurais',
    'Slayers', 'Soccer Moms', 'Spartans', 'Surfers', 'Swesties', 'Targaryens',
    'Tigers', 'TNT', 'Tornadoes', 'Warriors', 'Weasels', 'Wizards', 'Wolves',
    'Wombats', 'Hout Baes', 'Rockets', 'Jaguars', 'Huntsmen', 'Vikings',
    'Blitz', 'Komorants', 'Betties', 'Rebels', 'Vipers', 'Bergscape',
  ]

  // Spec §3.2 — typo / variant exact-match merges. Applied AFTER the title-case
  // + suffix-strip + apostrophe-strip steps but BEFORE the alias-regex stage.
  const TYPO_MAP = {
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
  }

  // Spec §3.3 — broader regex aliases. Applied AFTER TYPO_MAP. First match wins.
  // (Patterns mirror the Python re.IGNORECASE compiles.)
  const ALIAS_PATTERNS = [
    [/^engine\s*room\b/i, 'Engine Room'],
    [/^justin\b/i, 'Tigers'],
    [/\bjustin\b/i, 'Tigers'],
    [/\bhubspot\b/i, 'Hout Baes'],
    [/^hout\s*baes\b/i, 'Hout Baes'],
  ]

  // Spec §3.5 — standalone short-codes that should be dropped entirely.
  const DROP_STANDALONE = new Set(['cm', 'na', 'va', 'nc', 'cma'])

  // Spec §3.4 — per-employee default team for blank-notes shifts.
  const EMPLOYEE_DEFAULT_TEAM = {
    'Claire Murch': 'Nelio Assiss',
  }

  // Build the lower-case lookup once — used for canonical-case fix in step 12.
  const CANONICAL_LC = (function () {
    const m = {}
    CANONICAL_TEAMS.forEach(t => { m[t.toLowerCase()] = t })
    return m
  })()

  // Set of canonical names for quick membership checks (used by the By Division
  // view to figure out which raw teams are "non-canonical").
  const CANONICAL_SET = new Set(CANONICAL_TEAMS)

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
    if (DROP_STANDALONE.has(n.toLowerCase())) return ''
    // 10) Exact typo lookup
    if (Object.prototype.hasOwnProperty.call(TYPO_MAP, n)) n = TYPO_MAP[n]
    // 11) Alias regex — first match wins
    for (const [pat, target] of ALIAS_PATTERNS) {
      if (pat.test(n)) { n = target; break }
    }
    // 12) Canonical-case fix
    if (Object.prototype.hasOwnProperty.call(CANONICAL_LC, n.toLowerCase())) {
      n = CANONICAL_LC[n.toLowerCase()]
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
    const d = today ? new Date(today) : new Date()
    const y = d.getFullYear()
    const m = d.getMonth()        // 0-indexed
    const day = d.getDate()
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

  // Convert a SAST-local Date to a UTC ISO string for the Supabase query.
  // SAST is UTC+02:00 — so SAST midnight = UTC 22:00 the previous day.
  function _sastDateToUtcISO(d) {
    // Treat the Date as a wall-clock SAST timestamp. We DON'T trust the
    // caller's browser zone — we re-anchor by extracting the YMD/HMS parts
    // from the Date (which the caller built in local time, assumed SAST),
    // then construct a UTC moment that represents the same wall-clock
    // instant in SAST.
    const y = d.getFullYear()
    const m = d.getMonth()
    const day = d.getDate()
    const hh = d.getHours()
    const mm = d.getMinutes()
    const ss = d.getSeconds()
    const ms = d.getMilliseconds()
    // SAST = UTC+2, so the equivalent UTC moment is the wall clock minus 2h.
    const utcMillis = Date.UTC(y, m, day, hh, mm, ss, ms) - 2 * 3600 * 1000
    return new Date(utcMillis).toISOString()
  }

  async function fetchShiftsForPeriod(start, end) {
    if (!window.sb) throw new Error('Supabase client not initialised')
    const fromISO = _sastDateToUtcISO(start)
    const toISO = _sastDateToUtcISO(end)

    // Pull staff first so we can name-decorate the shifts. RLS already
    // allows authenticated reads on both tables (used by other tabs).
    const [{ data: staff, error: sErr }, { data: events, error: eErr }] = await Promise.all([
      window.sb.from('staff')
        .select('id, name, designation, division, active')
        .order('name', { ascending: true }),
      window.sb.from('events')
        .select('staff_id, ts, dir, note')
        .gte('ts', fromISO).lte('ts', toISO)
        .order('ts', { ascending: true }),
    ])
    if (sErr) throw sErr
    if (eErr) throw eErr

    const nameById = new Map()
    const designationById = new Map()
    const divisionById = new Map();
    (staff || []).forEach(s => {
      nameById.set(s.id, s.name || s.id)
      designationById.set(s.id, s.designation || '')
      divisionById.set(s.id, s.division || '')
    })

    // Group events by staff_id, sort each group by ts asc (the order-by
    // above already sorts globally, but we re-sort per-group to be safe).
    const byStaff = new Map();
    (events || []).forEach(e => {
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
      const n = (a.agentName || '').localeCompare(b.agentName || '')
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
      const teams = parseTeams(sh.note)
      if (!teams.length) {
        const def = EMPLOYEE_DEFAULT_TEAM[emp]
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
    return { empTeamHours, empTotalHours, rawVariantsPerTeam }
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
    CANONICAL_TEAMS,
    CANONICAL_LC,
    CANONICAL_SET,
    TYPO_MAP,
    ALIAS_PATTERNS,
    DROP_STANDALONE,
    EMPLOYEE_DEFAULT_TEAM,
    normalizeTeam,
    parseTeams,
    currentPayPeriod,
    payPeriodsForPicker,
    hoursDecimal,
    decimalToHHMM,
    roundHalfUp,
    fetchShiftsForPeriod,
    computeAllocations,
    _runTests,
  }

  // ---------------------------------------------------------------------
  // Views — extend window.VIEWS (views.js loaded before us)
  // ---------------------------------------------------------------------

  if (!window.VIEWS) window.VIEWS = {}
  const V = window.VIEWS

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  function _fmtDateLabel(iso) {
    if (!iso) return ''
    const d = new Date(iso)
    if (!Number.isFinite(d.getTime())) return ''
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${dd}`
  }
  function _fmtTimeLabel(iso) {
    if (!iso) return ''
    const d = new Date(iso)
    if (!Number.isFinite(d.getTime())) return ''
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
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
      ['dataQuality', 'Data Quality'],
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
      else if (activeView === 'perAgent') body = V.payrollPerAgent(alloc.empTeamHours, alloc.empTotalHours)
      else if (activeView === 'byDivision') body = V.payrollByDivision(alloc.empTeamHours, alloc.empTotalHours)
      else if (activeView === 'dataQuality') body = V.payrollDataQuality(alloc.rawVariantsPerTeam)
    }

    return `
    <div class="tab-view">
      <div class="card card-pad">
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:14px;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
            <div class="field">
              <label style="display:block;font-size:11px;font-weight:600;color:var(--muted);margin-bottom:4px">PAY PERIOD</label>
              <select id="payrollPeriod" style="padding:9px 12px;border:1px solid var(--line);border-radius:8px;font-family:Montserrat;font-size:13.5px;min-width:240px">
                ${opts}
              </select>
            </div>
            <div style="font-size:12px;color:var(--muted);max-width:380px;line-height:1.5">
              Quay 1 pay periods run the 21st through the 20th of the next month.
              Open shifts (still clocked in) are excluded until they close.
            </div>
          </div>
          <div class="seg" id="payrollSubNav">${subNav}</div>
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
  V.payrollPerAgent = function (empTeamHours, empTotalHours) {
    if (!empTeamHours || empTeamHours.size === 0) {
      return `<div class="card card-pad" style="color:var(--muted)">No allocations to show for this pay period.</div>`
    }
    const agents = Array.from(empTeamHours.keys()).sort((a, b) => a.localeCompare(b))
    let html = `
      <div class="card">
        <div class="card-head"><div>
          <h3>Per-Agent Allocations</h3>
          <div class="sub">Each agent's pay-period hours broken down by division</div>
        </div></div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th>Agent</th>
            <th>Team / Division</th>
            <th class="num">Hours (HH:MM)</th>
            <th class="num">Hours (Decimal)</th>
            <th class="num">% of Agent's Time</th>
          </tr></thead>
          <tbody>`
    let first = true
    for (const agent of agents) {
      if (!first) html += `<tr><td colspan="5" style="height:6px;background:transparent;border:0"></td></tr>`
      first = false
      const teams = Array.from(empTeamHours.get(agent).entries())
        .sort((a, b) => b[1] - a[1])
      const total = empTotalHours.get(agent) || teams.reduce((s, t) => s + t[1], 0)
      let sumDec = 0, sumPct = 0
      for (const [team, hrs] of teams) {
        const dec = Math.round(hrs * 100) / 100
        const pct = total > 0 ? (hrs / total) * 100 : 0
        sumDec += dec
        sumPct += pct
        html += `<tr>
          <td>${esc(agent)}</td>
          <td>${esc(team)}</td>
          <td class="num tnum">${decimalToHHMM(hrs)}</td>
          <td class="num tnum">${dec.toFixed(2)}</td>
          <td class="num tnum">${pct.toFixed(1)}%</td>
        </tr>`
      }
      html += `<tr style="background:#FFF6E0;font-weight:700">
        <td>${esc(agent)} — TOTAL</td>
        <td></td>
        <td class="num tnum">${decimalToHHMM(total)}</td>
        <td class="num tnum">${sumDec.toFixed(2)}</td>
        <td class="num tnum">${sumPct.toFixed(1)}%</td>
      </tr>`
    }
    html += `</tbody></table></div></div>`
    return html
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

    // Non-canonical = anything in teamEmp not in CANONICAL_SET, except the
    // (No team noted) bucket which goes last.
    const nonCanonical = []
    teamEmp.forEach((_m, t) => {
      if (!CANONICAL_SET.has(t) && t !== '(No team noted)') nonCanonical.push(t)
    })
    nonCanonical.sort((a, b) => a.localeCompare(b))
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
      return `<tr>${cells.join('')}</tr>`
    }

    let body = ''
    // Canonical rows first, in §3.1 order, including empty ones.
    for (const team of CANONICAL_TEAMS) {
      const members = teamEmp.get(team)
      const note = (members && members.size) ? '' : 'no agents this period'
      body += rowFor(team, note)
    }
    // Separator
    if (nonCanonical.length || hasNoTeam) {
      const spanCols = 1 + maxHead * 2 + 1
      body += `<tr class="payroll-noncanon-sep">
        <td colspan="${spanCols}" style="background:#C00000;color:#fff;text-align:center;font-weight:700;letter-spacing:0.4px;padding:10px">
          Not in master list — review
        </td>
      </tr>`
      for (const team of nonCanonical) body += rowFor(team, 'Not in master list')
      if (hasNoTeam) body += rowFor('(No team noted)', 'Shifts where the Employee notes field was blank')
    }

    return `
      <div class="card">
        <div class="card-head"><div>
          <h3>By Division</h3>
          <div class="sub">Wide pivot · % of <i>that agent's</i> pay-period time on each division · round-half-up</div>
        </div></div>
        <div class="tbl-wrap"><table class="tbl payroll-bydiv">
          <thead><tr>${headCells.join('')}</tr></thead>
          <tbody>${body}</tbody>
        </table></div>
      </div>`
  }

  // §5.4 — Data Quality maintenance view.
  V.payrollDataQuality = function (rawVariantsPerTeam) {
    if (!rawVariantsPerTeam || rawVariantsPerTeam.size === 0) {
      return `<div class="card card-pad" style="color:var(--muted)">No raw-notes variants to review — every shift either had a clean canonical match or no notes at all.</div>`
    }
    const teams = Array.from(rawVariantsPerTeam.keys()).sort((a, b) => a.localeCompare(b))
    const rows = teams.map(t => {
      const variants = Array.from(rawVariantsPerTeam.get(t)).sort((a, b) => a.localeCompare(b))
      const canonical = CANONICAL_SET.has(t)
      return `<tr>
        <td><b>${esc(t)}</b> ${canonical ? '' : '<span class="pill warn" style="font-size:10.5px;padding:2px 7px;margin-left:6px">non-canonical</span>'}</td>
        <td style="font-family:ui-monospace,Menlo,monospace;font-size:12.5px;color:var(--slate)">${esc(variants.join(' | '))}</td>
        <td class="num tnum">${variants.length}</td>
      </tr>`
    }).join('')
    return `
      <div class="card">
        <div class="card-head"><div>
          <h3>Data Quality</h3>
          <div class="sub">Every original Employee-notes fragment that resolved to each canonical team — spot bad merges + new typos</div>
        </div></div>
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

  // Run the regression suite if the URL flag is set. Done LAST so VIEWS
  // is fully wired before tests print their summary.
  try {
    if (typeof location !== 'undefined' && /[?&]payrolltest=1\b/.test(location.search)) {
      _runTests()
    }
  } catch (e) { /* tests are non-blocking */ }
})()

/* Quay 1 — Central configuration
   Edit values here; every view reads from window.QUAY_CONFIG. */

window.QUAY_CONFIG = {
  // ---- Revenue assumption ----
  // Used for the Leadership Overview "Revenue ceiling" KPI.
  //   - SELLER leads: per-team rate from TEAM_RAND_PER_LEAD below; falls
  //     back to REVENUE_PER_LEAD.default for unmapped campaigns.
  //   - RENTAL leads: flat RENTAL_RAND_PER_LEAD (placeholder until you set
  //     the real base — change the value below).
  //   - EMAIL leads: counted as a success but worth R0.
  REVENUE_PER_LEAD: {
    seller:  100506,   // floor-wide closed-unit avg from "Rand per Lead" sheet
    default: 100506,   // fallback for seller campaigns not in TEAM_RAND_PER_LEAD
  },
  // TODO(user): set the actual rental base — placeholder until then.
  RENTAL_RAND_PER_LEAD: 5000,

  // ---- R per lead, by team (from "Rand per Lead" .numbers sheet) ----
  // Commission per lead = (Annual Sales × 4%) ÷ Units Sold. Looked up by
  // the agent's primary campaign name; falls back to REVENUE_PER_LEAD.default
  // when the campaign doesn't match a team (e.g. agents on Clienthub Master).
  TEAM_RAND_PER_LEAD: {
    'Proteas':       564182,
    'City Sunsets':  256830,
    'Goal Diggers':  401086,
    'Assassins':     131666,
    'Wombats':        62173,
    'Wolves':         74581,
    'Warriors':      103813,
    'Dragons':        44664,
    'Babes':         132110,
    'Musketeers':     94964,
    'Furys':          57835,
    'Tornadoes':     145435,
    'Hooligans':     106331,
    'Amigos':         99387,
    'Weasels':       241356,
    'Dutchmen':      180422,
    'Boets':          71346,
    'Koeksisters':    91353,
    'Prom Queens':   148972,
    'Tigers':        115150,
    'Wizards':        84675,
    'Lions':          52686,
    'Knights':        57906,
    'Power Rangers': 163686,
    'Spartans':       94282,
    'Gladiators':     99400,
    'Surfers':       102689,
    'Chargers':       46564,
    'Hoekers':       162000,
    'Llamas':         42953,
    'Hustlers':      150160,
    'Pirates':        31880,
    'TNT':            55800,
    'Invincibles':    55760,
    'Slayers':        78429,
    'Falcons':        85500,
    'Soccer Moms':   122150,
    'Dealers':        39400,
    'Bulls':          37333,
    'Panthers':       46356,
    'Hawks':          57994,
    'Headbangers':    80356,
    'Avengers':      164000,
    'Gunslingers':    54667,
    'Farmers':       136200,
    'Raccoons':       88600,
    'Targaryens':     27800,
    'Samurais':       76790,
    'Dealmakers':     38000,
  },

  // ---- Performance benchmarks (mirror scripts/dialfire_common.py BENCHMARKS) ----
  BENCHMARKS: {
    cph:             45,    // calls per hour (per-agent floor)
    rm_success_rate: 17,    // % (RM team success threshold)
    fc_success_rate: 20,    // % (Fancy Callers threshold)
    efficiency:      70,    // % work/clocked time (Work Time tab target)
  },

  // ---- Floor-wide period targets (used by Leadership Overview progress bars) ----
  FLOOR_TARGETS: {
    weekly_calls:    7000,
    weekly_leads:    450,
    monthly_calls:   30000,
    monthly_leads:   1900,
  },

  // ---- Red-flag thresholds ----
  RED_FLAGS: {
    calls_drop_pct:        -15,    // %: WoW calls drop triggers a flag
    success_below_pct:     -3,     // pts below team target triggers flag
    inactive_call_floor:   100,    // <N calls in the period -> flagged
  },

  // ---- Display labels ----
  TEAM_LABELS: {
    RM:    'Relationship Managers',
    Fancy: 'Fancy Callers',
  },

  // ---- quay-clock backend ---------------------------------------------
  // Supabase project — same one the staff PWA + admin use. Anon key is
  // safe to commit; RLS gates every write. (Apps Script URL removed —
  // see Twigs002/quay-clock supabase/ for the migration history.)
  SUPABASE_URL:      'https://dqszbqiimbfvmmnpgpsb.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxc3picWlpbWJmdm1tbnBncHNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NDk4OTQsImV4cCI6MjA5NjQyNTg5NH0.M9RQnJEidyIMZAwbELTSPakiSnvuWBdHTjD7nuOdCZY',
  AUTH_EMAIL_DOMAIN: 'quay1.local',

  // URL of the embedded admin (same origin, ?embed=1).
  CLOCK_ADMIN_EMBED: 'https://twigs002.github.io/quay-clock/admin/?embed=1',
};

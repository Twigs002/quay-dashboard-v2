/* Quay 1 — Central configuration
   Edit values here; every view reads from window.QUAY_CONFIG. */

window.QUAY_CONFIG = {
  // ---- Revenue assumption (PLACEHOLDER — swap for real per-lead values) ----
  // Used for the Leadership Overview "Estimated Revenue" KPI.
  REVENUE_PER_LEAD: {
    seller:  10000,    // R per seller lead
    rental:  10000,    // R per rental lead
    email:   10000,    // R per email lead
    default: 10000,    // fallback when type isn't broken out
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

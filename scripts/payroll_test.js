// Node harness for the spec §7 regression cases. Standalone runner so we
// can validate the algorithm without spinning up a browser.
//
//   node scripts/payroll_test.js
//
// Fakes the bare-minimum browser globals payroll.js touches at module load.

global.location = { search: '?payrolltest=1' }
global.window = {}

require('../quay/payroll.js')

// Exit non-zero if any case fails.
const r = global.window.PAYROLL._runTests()
if (r.failures.length) process.exit(1)

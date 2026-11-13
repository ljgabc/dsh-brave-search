// Daylight-saving boundary test for the 7-day usage window.
// Run: TZ=America/New_York node --import ./.test/register.mjs ./.test/dst.mjs
//
// America/New_York sprang forward on 2026-03-08 (02:00 EST → 03:00 EDT), so
// that day is 23 hours long. From 2026-03-10 00:30 EDT, fixed 24-hour
// millisecond steps backwards cross the transition and land one hour early:
// step 2 reports 2026-03-07 for the day that must read 2026-03-08, and every
// earlier step shifts with it. Calendar-day subtraction (setDate) must keep
// the window on the right dates.
//
// The timezone assertion makes the test fail loudly when the TZ environment
// did not apply — on a DST-free clock both arithmetics agree and the test
// would be vacuous.
import assert from 'node:assert/strict'
import { UsageTracker } from '../index.js'

assert.equal(
  Intl.DateTimeFormat().resolvedOptions().timeZone,
  'America/New_York',
  'this test must run with TZ=America/New_York',
)

const clock = new Date(2026, 2, 10, 0, 30, 0).getTime()   // 2026-03-10 00:30 local (EDT)
const tracker = new UsageTracker(null, () => clock)
tracker.recordSearch()

const dates = tracker.snapshot().last7.map(day => day.date)
assert.deepEqual(dates, [
  '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10',
])
assert.equal(tracker.snapshot().last7[6].searches, 1)
console.log('OK: the last-7 window stays calendar-correct across the DST spring-forward day')

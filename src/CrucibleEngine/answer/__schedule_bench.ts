// Bench for the deterministic schedule solver.
// The measured failure it replaces (qwen2.5-1.5b, 2026-08-03): "I have meetings at 9am, 11am
// and 2pm, each one hour. Between 9am and 5pm, what is my longest free block?" answered
// "7 hours 30 minutes" on one run and "11am to 1pm" on another — the latter colliding with
// the 11am meeting. Correct answer: 2 hours, tied between 12pm-2pm and 3pm-5pm.
// Run: npx tsx src/CrucibleEngine/answer/__schedule_bench.ts
import { solveSchedule, parseClock, parseDuration, freeGaps, mergeIntervals, formatClock } from './schedule'

let pass = 0, fail = 0
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  PASS  ${m}`) } else { fail++; console.log(`  FAIL  ${m}`) } }

console.log('— parseClock —')
for (const [s, want] of [['9am', 540], ['9:30am', 570], ['12pm', 720], ['12am', 0], ['noon', 720],
                         ['midnight', 0], ['2pm', 840], ['14:00', 840], ['5 pm', 1020]] as [string, number][]) {
  ok(parseClock(s) === want, `parseClock("${s}") = ${want} (got ${parseClock(s)})`)
}
ok(parseClock('25pm') === null, 'parseClock rejects 25pm')
ok(parseClock('banana') === null, 'parseClock rejects nonsense')

console.log('— parseDuration —')
for (const [s, want] of [['an hour', 60], ['a hour', 60], ['half an hour', 30], ['90 minutes', 90],
                         ['1.5 hours', 90], ['45 mins', 45], ['2h', 120]] as [string, number][]) {
  ok(parseDuration(s) === want, `parseDuration("${s}") = ${want} (got ${parseDuration(s)})`)
}

console.log('— interval maths —')
{
  const merged = mergeIntervals([{ start: 60, end: 120 }, { start: 100, end: 180 }, { start: 300, end: 360 }])
  ok(merged.length === 2 && merged[0].end === 180, 'overlapping intervals merge')
  const gaps = freeGaps({ start: 0, end: 480 }, merged)
  ok(gaps.length === 3, `three gaps around two busy blocks (got ${gaps.length})`)
  ok(freeGaps({ start: 0, end: 60 }, [{ start: 0, end: 60 }]).length === 0, 'fully booked window has no gaps')
  ok(freeGaps({ start: 0, end: 120 }, []).length === 1, 'empty schedule is one big gap')
  // Busy blocks outside the window must not create phantom gaps.
  ok(freeGaps({ start: 600, end: 660 }, [{ start: 0, end: 60 }]).length === 1, 'out-of-window busy ignored')
}

console.log('— the measured regression —')
{
  const s = solveSchedule('I have meetings tomorrow at 9am, 11am and 2pm, each one hour long. Between 9am and 5pm, what is my longest free block?')
  ok(!!s, 'solves the dogfood question')
  if (s) {
    const maxLen = Math.max(...s.free.map(f => f.end - f.start))
    ok(maxLen === 120, `longest gap is 120 minutes (got ${maxLen})`)
    ok(s.longest.length === 2, `tie is reported, not silently broken (got ${s.longest.length})`)
    const spans = s.longest.map(l => `${formatClock(l.start)}-${formatClock(l.end)}`).sort()
    ok(spans[0] === '12pm-2pm' && spans[1] === '3pm-5pm', `tied blocks are 12pm-2pm and 3pm-5pm (got ${spans.join(', ')})`)
    ok(/2 hours/.test(s.text), 'rendered text states the duration')
    // The exact wrong answers the model produced must be impossible here.
    ok(!/7 hours 30/.test(s.text), 'never reproduces the "7 hours 30 minutes" error')
    ok(!/11am–1pm|11am-1pm/.test(s.text), 'never proposes a block overlapping the 11am meeting')
  }
}

console.log('— other real shapes —')
{
  const s = solveSchedule('I have calls at 10am and 3pm, each 30 minutes. Between 9am and 5pm when am I free?')
  ok(!!s, 'parses 30-minute meetings')
  if (s) {
    const maxLen = Math.max(...s.free.map(f => f.end - f.start))
    ok(maxLen === 270, `longest gap 10:30am-3pm = 270 minutes (got ${maxLen})`)
  }
}
{
  const s = solveSchedule('Meetings at 9am, 10am, 11am, 12pm, 1pm, 2pm, 3pm and 4pm, each one hour. Between 9am and 5pm, any free time?')
  ok(!!s && s.free.length === 0, 'fully booked day reports no free time')
  if (s) ok(/no free time/i.test(s.text), 'fully booked wording is explicit')
}

console.log('— refuses what it cannot be sure of (falls through to reasoning) —')
for (const q of [
  'what is the capital of Australia',                                  // not a schedule question
  'I have meetings at 9am and 11am. When am I free?',                  // no window
  'I have meetings between 9am and 5pm. When am I free?',              // no start times, no duration
  'I am busy from 9am to 5pm tomorrow, what should I cook for dinner?', // no free-ask + no duration
  'I have three meetings of varying length between 9am and 5pm, when am I free?', // no shared duration
]) {
  ok(solveSchedule(q) === null, `refuses: "${q.slice(0, 58)}"`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

// Bench for NL→Trigger parsing and the scheduling tools (cont.119, overhaul items 31-35).
// Clock is injected everywhere, so this is deterministic. Run:
//   npx tsx src/CrucibleEngine/automations/__schedule_bench.ts
import { parseTrigger, parseTime } from './parseTrigger'
import { computeNextRun, describeTrigger, validateTrigger } from './store'

// Wednesday 2026-07-29 10:00 local — a midweek anchor, so weekday/weekly maths is observable.
const NOW = new Date(2026, 6, 29, 10, 0, 0).getTime()

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'OK ' : 'XX '} ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

// ── Time parsing ──
const TIMES: Array<[string, string | null]> = [
  ['8am', '08:00'], ['8:30am', '08:30'], ['5pm', '17:00'], ['17:00', '17:00'],
  ['12pm', '12:00'], ['12am', '00:00'], ['noon', '12:00'], ['midnight', '00:00'],
  ['at 6', '18:00'],            // bare evening-ish hour reads as PM
  ['at 9', '09:00'],            // bare morning hour reads as AM
  ['whenever', null],
]
for (const [input, want] of TIMES) check(`parseTime(${JSON.stringify(input)}) = ${want}`, parseTime(input) === want, String(parseTime(input)))

// ── Trigger parsing ──
const CASES: Array<[string, string, (t: any) => boolean]> = [
  ['every weekday at 8am', 'weekdays', t => t.time === '08:00'],
  ['on weekdays at 9', 'weekdays', t => t.time === '09:00'],
  ['monday to friday at 7:30am', 'weekdays', t => t.time === '07:30'],
  ['every monday at 9am', 'weekly', t => t.day === 1 && t.time === '09:00'],
  ['on tuesdays', 'weekly', t => t.day === 2],
  ['every 30 minutes', 'interval', t => t.minutes === 30],
  ['every 2 hours', 'interval', t => t.minutes === 120],
  ['hourly', 'interval', t => t.minutes === 60],
  ['every day at 8am', 'daily', t => t.time === '08:00'],
  ['daily at 18:30', 'daily', t => t.time === '18:30'],
  ['every morning', 'daily', t => t.time === '08:00'],
  ['every evening', 'daily', t => t.time === '19:00'],
  ['in 30 minutes', 'once', t => Math.abs(t.at - (NOW + 30 * 60_000)) < 1000],
  ['in 2 hours', 'once', t => Math.abs(t.at - (NOW + 2 * 3_600_000)) < 1000],
  ['tomorrow at 9am', 'once', t => new Date(t.at).getDate() === 30 && new Date(t.at).getHours() === 9],
  ['at 5pm', 'once', t => new Date(t.at).getHours() === 17 && new Date(t.at).getDate() === 29],
  ['at 9am', 'once', t => new Date(t.at).getDate() === 30],   // 9am today has passed -> tomorrow
]
for (const [text, kind, ok] of CASES) {
  const r = parseTrigger(text, NOW)
  const got = r?.trigger as any
  check(`parse ${JSON.stringify(text)} -> ${kind}`, !!got && got.kind === kind && ok(got), JSON.stringify(got))
  if (got) check(`  ...and validates`, validateTrigger(got), JSON.stringify(got))
}

// Nothing schedule-shaped must return null, never a guessed cadence.
for (const text of ['summarise my inbox', 'do the thing', '']) {
  check(`no cadence in ${JSON.stringify(text)} -> null (never guessed)`, parseTrigger(text, NOW) === null, JSON.stringify(parseTrigger(text, NOW)))
}

// ── weekdays next-run maths ──
const wd = { kind: 'weekdays' as const, time: '08:00' }
const fri = new Date(2026, 6, 31, 10, 0, 0).getTime()      // Friday 10:00
const nextFromFri = computeNextRun(wd, fri)!
check('weekdays from Friday 10:00 skips the weekend to Monday',
  new Date(nextFromFri).getDay() === 1 && new Date(nextFromFri).getHours() === 8,
  new Date(nextFromFri).toString())

const sat = new Date(2026, 7, 1, 10, 0, 0).getTime()       // Saturday
const nextFromSat = computeNextRun(wd, sat)!
check('weekdays from Saturday lands on Monday', new Date(nextFromSat).getDay() === 1, new Date(nextFromSat).toString())

const wedEarly = new Date(2026, 6, 29, 6, 0, 0).getTime()  // Wednesday 06:00
const nextFromWed = computeNextRun(wd, wedEarly)!
check('weekdays from Wednesday 06:00 fires the same morning',
  new Date(nextFromWed).getDay() === 3 && new Date(nextFromWed).getHours() === 8, new Date(nextFromWed).toString())

check('weekdays describes itself', describeTrigger(wd) === 'every weekday at 08:00', describeTrigger(wd))

// Every recurring kind must produce a strictly future run — a non-advancing trigger would
// re-fire in a tight loop against the 30s tick.
for (const t of [wd, { kind: 'daily' as const, time: '08:00' }, { kind: 'weekly' as const, day: 1, time: '08:00' }, { kind: 'interval' as const, minutes: 15 }]) {
  const n = computeNextRun(t, NOW)
  check(`${t.kind} advances strictly past now`, n !== null && n > NOW, String(n))
}

console.log(`\nTOTAL: ${pass}/${pass + fail}`)
if (fail) process.exit(1)

#!/usr/bin/env node
/**
 * ACTIVITY, TRACED THROUGH EVERY LAYER THAT CAN CHANGE THE NUMBER.
 *
 * §40 of the handoff asks for the one thing screenshots cannot give: for known
 * days, the value at each stage of the pipeline, so a discrepancy can be
 * attributed rather than argued about. The stages are
 *
 *   1  the connector's raw response      Google Fit `dataset:aggregate` JSON
 *   2  parsed points                     `stepsFromAggregate`
 *   3  timezone-day aggregation          the bucket label, in HIS zone
 *   4  the normalised report             `activityReport` — source, trend, gap
 *   5  the rendered value                what the surface would actually draw
 *
 * WHAT THIS DOES NOT CLAIM. Run with fixtures — which is how it runs in CI and
 * how it ran when it was written — it proves the TRANSFORMATIONS, not his
 * account. It says so, out loud, at the end of every run. A live run (see
 * `--live`) is the only thing that can compare against the real account, and its
 * absence is reported rather than glossed.
 *
 * The user's own phone total is deliberately NOT used as an oracle anywhere in
 * here. It is evidence that a discrepancy exists, which is a reason to trace;
 * it is not ground truth for what Google Fit returned.
 *
 * Run: npx tsx scripts/activity.mjs
 */
import { stepsFromAggregate, fitWindowStart } from '../server/google.ts'
import { activityReport, seriesBySource, trendOf } from '../server/activity.ts'
import { dayIn } from '../server/clock.ts'

const ZONE = 'Europe/Rome'
let failures = 0
const say = (s) => console.log(s)

/**
 * A bucket exactly as Fit returns one.
 *
 * `startTimeMillis` is a string in the real payload, and the parse has to
 * survive that — it is a `Number(...)` away from being a silent NaN date, which
 * would label every day "Invalid Date" and produce a chart of nothing.
 */
const bucket = (startLocalIso, runs) => ({
  startTimeMillis: String(Date.parse(startLocalIso)),
  endTimeMillis: String(Date.parse(startLocalIso) + 86_400_000),
  dataset: [{
    point: runs.map((v) => ({
      value: [typeof v === 'number' && Number.isInteger(v) ? { intVal: v } : { fpVal: v }],
    })),
  }],
})

/**
 * THE CASES, each one a real failure mode this pipeline has had.
 *
 * `expect` is the count the surface must end up drawing for that day. Where a
 * day is expected to be ABSENT from the response entirely, `expect` is null and
 * the assertion is that nothing anywhere invents a zero for it.
 */
const CASES = [
  {
    what: 'a day with several runs is summed, not sampled',
    // The bug: only the first point of the first dataset was read, so a day
    // walked in three stretches reported the first stretch.
    bucket: bucket('2026-08-05T00:00:00+02:00', [1200, 900, 210]),
    day: '2026-08-05',
    expect: 2310,
  },
  {
    what: 'a float value is counted rather than dropped',
    // The bug: only `intVal` was honoured, so a derived stream reporting
    // `fpVal` came back as zero with no error anywhere.
    bucket: bucket('2026-08-06T00:00:00+02:00', [3010.4]),
    day: '2026-08-06',
    expect: 3010,
  },
  {
    what: 'a real zero survives as a zero',
    // The bug: `.filter(d => d.steps > 0)` deleted it, making "did not walk"
    // and "connector said nothing" the same fact downstream.
    bucket: bucket('2026-08-07T00:00:00+02:00', [0]),
    day: '2026-08-07',
    expect: 0,
  },
  {
    what: 'a bucket starting at local midnight is labelled with the LOCAL day',
    /*
      THE ONE THAT MOVED A WHOLE DAY.

      Midnight in Rome is 22:00 the previous day in UTC. Labelling the bucket by
      the UTC date of its start instant put every day's steps on the day before
      for the whole of a European summer — the exact shape of "the numbers are
      wrong and nothing errored".
    */
    bucket: bucket('2026-08-08T00:00:00+02:00', [4820]),
    day: '2026-08-08',
    expect: 4820,
  },
]

// ── Stages 1–3 ───────────────────────────────────────────────────────────────

say('stage 1→3  raw payload → parsed points → timezone day')
const payload = { bucket: CASES.map((c) => c.bucket) }
const parsed = stepsFromAggregate(payload, ZONE)

for (const c of CASES) {
  const hit = parsed.find((d) => d.date === c.day)
  if (!hit) {
    failures++
    console.error(`FAIL  ${c.what}: no bucket landed on ${c.day} (got ${parsed.map((d) => d.date).join(', ')})`)
    continue
  }
  if (hit.steps !== c.expect) {
    failures++
    console.error(`FAIL  ${c.what}: parsed ${hit.steps}, expected ${c.expect}`)
    continue
  }
  say(`  ok  ${c.day}  ${String(hit.steps).padStart(6)}  ${c.what}`)
}

/*
  The zone is not decoration. Re-parsing the same payload as UTC must move the
  labels — if it does not, the timezone argument is being ignored somewhere and
  the "correct" result above is a coincidence.
*/
{
  const asUtc = stepsFromAggregate(payload, 'UTC')
  if (asUtc.some((d, i) => d.date === parsed[i].date)) {
    failures++
    console.error('FAIL  timezone: labelling was identical in UTC and Europe/Rome — the zone is not reaching the label')
  } else {
    say(`  ok  the same payload labels differently in UTC (${asUtc[0].date}) and Europe/Rome (${parsed[0].date})`)
  }
}

// ── Stage 0: the window the connector asks for ───────────────────────────────

say('')
say('stage 0    the request window')
{
  /*
    THE DEFECT THIS CATCHES IS INVISIBLE FROM EVERY SCREEN.

    Google's `period` bucketing anchors to the START OF THE RANGE. A range
    starting at an instant — `now - 7d`, mid-morning — therefore produces seven
    24-hour windows beginning at the time of day the sync ran, each labelled with
    a calendar date it only partly covers. Nothing errors; the numbers are simply
    somebody else's days.

    Measured live on 2026-08-12 at 09:25 Europe/Rome, the same account, the same
    instant, two windows: 2026-08-09 came back as 12,972 from the old window and
    6,307 from the aligned one; 2026-08-10 as 3,795 and 10,356. The aligned
    figures are the ones his own morning sync had already stored.
  */
  const at = new Date('2026-08-12T09:25:00+02:00')
  const start = fitWindowStart(at, ZONE)
  if (start === null) {
    failures++
    console.error('FAIL  window: no aligned start was computed for a known zone')
  } else {
    const label = dayIn(new Date(start), ZONE)
    const isMidnight = new Date(start).toLocaleTimeString('en-GB', { timeZone: ZONE, hour12: false }) === '00:00:00'
    if (!isMidnight) {
      failures++
      console.error(`FAIL  window: the range starts at ${new Date(start).toISOString()}, which is not local midnight`)
    } else {
      say(`  ok  starts at local midnight on ${label} (${new Date(start).toISOString()})`)
    }
    // Seven whole local days INCLUDING today — the old window's end bucket was
    // dropped entirely, which is the "today hasn't synced yet" in the screenshots.
    const spanDays = Math.round((at.getTime() - start) / 86_400_000)
    if (spanDays !== 6) {
      failures++
      console.error(`FAIL  window: spans ${spanDays} days back rather than 6 whole days plus today`)
    } else {
      say('  ok  covers six whole days plus today, so today has a bucket at all')
    }
  }

  // Winter must not silently shift by an hour.
  const winter = fitWindowStart(new Date('2026-02-12T09:25:00+01:00'), ZONE)
  const winterOk = new Date(winter).toLocaleTimeString('en-GB', { timeZone: ZONE, hour12: false }) === '00:00:00'
  if (!winterOk) {
    failures++
    console.error('FAIL  window: the range is not midnight-aligned outside summer time')
  } else {
    say('  ok  still midnight-aligned in February, when Rome is +01:00')
  }
}

// ── Stage 4: the normalised report ───────────────────────────────────────────

say('')
say('stage 4    observations → ActivityReport')

/** A world holding exactly what the sync would have written. */
const worldWith = (days, extra = []) => ({
  timeZone: ZONE,
  observations: [
    { id: 'gfit-1', source: 'health', at: '2026-08-09T06:00:00Z', text: 'steps', data: { kind: 'steps', days } },
    ...extra,
  ],
})

const person = (over = {}) => ({
  identity: {}, preferences: {}, goals: [], conflicts: [], demands: {}, asked: {}, people: {},
  ...over,
})

const NOW = new Date('2026-08-09T09:00:00+02:00')

{
  const report = activityReport(worldWith(parsed), person(), { now: NOW, windowDays: 7 })

  // The trend window must carry EVERY day, with `null` where nothing was
  // reported. This is the field the chart is now drawn from, so an absence that
  // silently became a zero here would be a zero on screen.
  const byDay = new Map(report.trend.days.map((d) => [d.date, d.value]))
  for (const c of CASES) {
    const got = byDay.get(c.day)
    if (got !== c.expect) {
      failures++
      console.error(`FAIL  report: ${c.day} came through as ${JSON.stringify(got)}, expected ${c.expect}`)
    }
  }

  const untouched = report.trend.days.filter((d) => d.value === null).map((d) => d.date)
  if (!untouched.length) {
    failures++
    console.error('FAIL  report: no day in the window is null — a gap has been filled in with something')
  } else {
    say(`  ok  ${untouched.length} unreported day(s) are null, not zero: ${untouched.join(', ')}`)
  }

  /*
    THE AVERAGE'S DENOMINATOR. Four covered days out of seven must divide by
    four — dividing by seven invents three zero-step days and halves him, which
    is the commonest way a health chart lies.
  */
  const covered = report.trend.covered
  const expectAvg = Math.round(CASES.reduce((a, c) => a + c.expect, 0) / CASES.length)
  if (covered !== CASES.length || report.trend.average !== expectAvg) {
    failures++
    console.error(`FAIL  report: average ${report.trend.average} over ${covered} days, expected ${expectAvg} over ${CASES.length}`)
  } else {
    say(`  ok  average ${report.trend.average} over ${covered} of ${report.trend.windowDays} days (named, not implied)`)
  }

  // Stage 5: what the surface draws is this array and nothing else. The chart
  // is built from `trend.days` in `panes.ts`, so agreement is structural — this
  // asserts the property that made it so, rather than a coincidence of values.
  const headline = report.current?.value ?? null
  const newestDrawn = [...report.trend.days].reverse().find((d) => d.value !== null)
  if (headline !== null && newestDrawn && headline !== newestDrawn.value) {
    failures++
    console.error(`FAIL  render: the headline (${headline}) is not the newest bar the chart draws (${newestDrawn.value} on ${newestDrawn.date})`)
  } else {
    say(`  ok  headline ${headline} is the newest bar the chart draws (${newestDrawn?.date})`)
  }

  say(`  ok  says: ${report.says}`)
}

// ── A disagreement produces no figure and no chart ───────────────────────────

say('')
say('stage 4    two sources that disagree')
{
  /*
    The state the handoff describes: a connected phone app reporting far more
    than Google Fit for the same day. The product rule is that there is NO
    single figure until he rules — and now that the chart reads the report's own
    window, there are no bars either. A chart drawn from one source under a
    headline that refuses to name one would be the same lie in a picture.
  */
  const p = person({
    conflicts: [{
      id: 'c1', metric: 'steps', scope: '2026-08-08', state: 'open', differencePercent: 108,
      readings: [{ source: 'google-fit', value: 4820 }, { source: 'my phone', value: 10040 }],
    }],
    identity: {
      'reading.steps.2026-08-08': { value: 10040, note: 'my phone', by: 'user', status: 'known', at: '2026-08-09T08:00:00Z' },
    },
  })
  const report = activityReport(worldWith(parsed), p, { now: NOW, windowDays: 7 })
  if (report.current !== null || report.source.by !== 'disputed') {
    failures++
    console.error(`FAIL  conflict: a figure was published while two sources disagree (${JSON.stringify(report.current)})`)
  } else {
    say(`  ok  no figure published — ${report.source.why}`)
  }
  if (report.trend.days.some((d) => d.value !== null)) {
    failures++
    console.error('FAIL  conflict: the chart still has bars while the headline refuses to name a number')
  } else {
    say('  ok  the chart is empty too — one source of truth, or none')
  }
}

// ── Live ─────────────────────────────────────────────────────────────────────

say('')
if (process.argv.includes('--live')) {
  const token = process.env.GOOGLE_ACCESS_TOKEN
  if (!token) {
    say('live       SKIPPED — no GOOGLE_ACCESS_TOKEN in the environment.')
    say('           Real-account comparison remains OUTSTANDING.')
  } else {
    const end = Date.now()
    const start = end - 7 * 86_400_000
    const res = await fetch('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        aggregateBy: [{ dataTypeName: 'com.google.step_count.delta' }],
        startTimeMillis: start,
        endTimeMillis: end,
        bucketByTime: { period: { type: 'day', value: 1, timeZoneId: ZONE } },
      }),
    })
    if (!res.ok) {
      say(`live       FAILED — Google returned ${res.status}. Real-account comparison remains OUTSTANDING.`)
    } else {
      const body = await res.json()
      const live = stepsFromAggregate(body, ZONE)
      say(`live       raw buckets: ${body.bucket?.length ?? 0}`)
      for (const d of live) say(`           ${d.date}  ${String(d.steps).padStart(6)}`)
      const report = activityReport(
        { timeZone: ZONE, observations: [{ id: 'live', source: 'health', at: new Date().toISOString(), text: '', data: { kind: 'steps', days: live } }] },
        person(),
        { now: new Date(), windowDays: 7 },
      )
      say(`           report says: ${report.says}`)
      say(`           today (${dayIn(new Date(), ZONE)}): ${report.freshness.haveToday ? report.freshness.todayValue : 'no reading'}`)
    }
  }
} else {
  say('live       NOT RUN. Pass --live with GOOGLE_ACCESS_TOKEN set to compare against the real account.')
  say('           Everything above proves the transformations, not his numbers.')
}

say('')
if (failures) {
  console.error(`${failures} activity lineage violation(s).`)
  process.exit(1)
}
console.log(
  `activity ok — ${CASES.length} known days traced raw → parsed → zone-labelled → report → rendered; ` +
  'gaps stayed null, zeros stayed zero, the average named its denominator, and a disputed metric ' +
  'published neither a figure nor a chart. LIVE ACCOUNT COMPARISON NOT PERFORMED.',
)

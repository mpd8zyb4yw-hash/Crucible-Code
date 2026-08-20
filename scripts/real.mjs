#!/usr/bin/env node
/**
 * SHADOW INTELLIGENCE OVER HIS ACTUAL LIFE — §19 to §23.
 *
 * §13 of `docs/memory-core.md` lists "real data" as the last unverified thing:
 * everything the pipeline has ever been shown is `fixture.ts` or `noise.ts`, both
 * of which were written by somebody who knew what the test was going to assert.
 * §20's whole point is that real life is adversarial in ways synthetic life is
 * not, and the only way to find out how is to run it.
 *
 * WHERE THE EVIDENCE COMES FROM, AND WHY NOT FROM THE EDGE. His ledger lives
 * inside the production Durable Object, behind a session cookie signed with a
 * secret this machine does not have — correctly, since that hostname is public
 * and the object is his calendar, his mail and his location. What IS reachable
 * is the world document, which the object mirrors into KV on every landed write
 * precisely so it stays inspectable:
 *
 *     wrangler kv key get world --namespace-id <…> --remote
 *
 * That document is the same `Observation[]` the observation sink turns into
 * ledger events, through the same `eventsFromWorldObservations` the edge calls.
 * So the evidence here is real and the path it takes is the shipping one; what
 * it is not is the edge's ACCUMULATED ledger, which has every observation ever
 * synced rather than the ones the document still carries. That difference is
 * measured below rather than waved at, because it turns out to be the headline.
 *
 * NOTHING HERE WRITES ANYTHING. The KV read is a read, the store is a temporary
 * file, and no production surface is touched.
 *
 *     npm run real                 pull, rebuild, and report
 *     npm run real -- --file x     use a document already on disk
 *     npm run real -- --scores     dump the candidate score distribution
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { betterSqliteMemoryStore } from '../server/memory/store.ts'
import { eventsFromWorldObservations } from '../server/memory/ingest.ts'
import { rebuild } from '../server/memory/reflect.ts'
import { recordedCycle, renderShadow } from '../server/memory/shadow.ts'
import { INTELLIGENCE_THRESHOLD } from '../server/memory/significance.ts'
import * as inspect from '../server/memory/inspect.ts'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const argv = process.argv.slice(2)
const flag = (n) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? null : argv[i + 1]
}
const NAMESPACE = flag('namespace') ?? '7288f617e7904a0fa9a96bda11dd6540'

// ── The document ─────────────────────────────────────────────────────────────

let raw
const file = flag('file')
if (file) {
  raw = readFileSync(file, 'utf8')
} else {
  process.stderr.write('reading the world document from KV…\n')
  raw = execFileSync('npx', ['wrangler', 'kv', 'key', 'get', 'world', '--namespace-id', NAMESPACE, '--remote'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}
const world = JSON.parse(raw)
const observations = world.observations ?? []
const zone = world.timeZone ?? 'Europe/Rome'
const opts = { timeZone: zone, me: flag('me') ?? world.person?.identity?.email ?? 'cruciblecode1@gmail.com' }

if (!observations.length) {
  console.error('the world document has no observations — nothing to think about')
  process.exit(1)
}

// ── What is actually there ───────────────────────────────────────────────────

const bySource = {}
for (const o of observations) bySource[o.source] = (bySource[o.source] ?? 0) + 1
const days = [...new Set(observations.map((o) => (o.at ?? '').slice(0, 10)).filter(Boolean))].sort()
const withData = observations.filter((o) => o.data).length

console.log('THE EVIDENCE')
console.log(`  ${observations.length} observations · ${days.length} distinct days · ${days[0]} → ${days.at(-1)}`)
console.log(`  by source   ${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
console.log(`  structured  ${withData}/${observations.length} carry typed \`data\`; the rest are a sentence only`)

// ── Through the shipping path ────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'crucible-real-'))
const store = betterSqliteMemoryStore(new Database(join(dir, 'real.db')))
const events = eventsFromWorldObservations(observations, new Date().toISOString())
const written = store.events.append(events)
console.log(`\n  ${written.length} ledger events written (${events.length - written.length} collapsed on dedupeKey)`)

const result = rebuild(store, opts)
console.log(`  rebuilt over ${result.passes} daily passes`)

// ── What it concluded ────────────────────────────────────────────────────────

console.log(`\n${inspect.overview(store)}`)
console.log(`\nENTITIES\n${inspect.entities(store)}`)
console.log(`\nROUTINES\n${inspect.routines(store)}`)
console.log(`\nHYPOTHESES\n${inspect.hypotheses(store)}`)
console.log(`\nPREDICTIONS\n${inspect.predictions(store, 12)}`)

// ── One pass, watched ────────────────────────────────────────────────────────

const now = new Date()
const { shadow } = recordedCycle(store, 'daily', now, opts)
console.log(`\nONE PASS, TODAY\n${shadow ? renderShadow(shadow) : '(no shadow section)'}`)

// ── §24 · the score distribution, so the threshold is calibrated not guessed ──
//
// From the SHADOW RUNS rather than re-judged here. `judgeCandidates` already ran
// the gate against the numbers the cycle reasoned over; a second call from this
// file would score them against a store that has since moved, which is how a
// calibration exercise ends up measuring its own harness.

const runs = store.shadow.recent(1000)
const candidates = runs.flatMap((r) => r.candidates.map((c) => ({ ...c, at: r.startedAt })))

console.log(`\nCANDIDATE SCORES — ${candidates.length} across ${runs.length} passes`)
if (!candidates.length) {
  console.log('  none. See the verdict below; this is a finding, not an empty run.')
} else {
  console.log('  source              score   surfaced  reason')
  for (const c of candidates.sort((a, b) => b.score - a.score)) {
    console.log(
      `  ${c.source.padEnd(19)} ${c.score.toFixed(3)}   ${(c.surfaced ? 'yes' : 'no').padEnd(8)}  ${c.reason ?? ''}`
    )
  }
  const scores = candidates.map((c) => c.score).sort((a, b) => a - b)
  const at = (q) => scores[Math.min(scores.length - 1, Math.floor(q * scores.length))]
  console.log(
    `\n  distribution  min ${scores[0].toFixed(3)} · p50 ${at(0.5).toFixed(3)} · p90 ${at(0.9).toFixed(3)} · max ${scores.at(-1).toFixed(3)}`
  )
  console.log(`  threshold     ${INTELLIGENCE_THRESHOLD}`)
  const bySuppression = {}
  for (const c of candidates) if (!c.surfaced) bySuppression[c.reason ?? 'unknown'] = (bySuppression[c.reason ?? 'unknown'] ?? 0) + 1
  console.log(`  suppressed by ${Object.entries(bySuppression).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}`)
}

const quiet = runs.filter((r) => !r.candidates.some((c) => c.surfaced)).length
console.log(`\n  ${quiet}/${runs.length} passes would have said nothing at all`)

// ── The verdict §23 asks for ─────────────────────────────────────────────────

const routines = store.routines.all()
const hypotheses = store.hypotheses.all()
const entities = store.entities.all()
const bare = entities.filter((e) => e.id.includes('~'))
const coverage = days.length

console.log('\nREAL-DATA ACCEPTANCE (§23)')
const line = (label, pass, detail) => console.log(`  ${pass ? '·' : '!'} ${label.padEnd(34)} ${detail}`)
line('evidence coverage', coverage >= 42, `${coverage} distinct days; routines need 42, hypotheses need 42`)
line(
  'no obvious entity pollution',
  bare.length <= entities.length / 2,
  `${entities.length} entities, ${bare.length} unresolved bare names — ${entities.map((e) => e.label).slice(0, 8).join(', ') || 'none'}`
)
line(
  'routines correspond to behaviour',
  routines.every((r) => r.status !== 'established') || coverage >= 42,
  `${routines.length} learned${routines.length ? ` (${[...new Set(routines.map((r) => r.status))].join(', ')})` : ''}`
)
line(
  'hypotheses remain cautious',
  hypotheses.filter((h) => h.status === 'supported').length === 0 || coverage >= 42,
  `${hypotheses.length} total, ${hypotheses.filter((h) => h.status === 'supported').length} supported`
)
line('candidate volume restrained', candidates.length <= runs.length, `${candidates.length} across ${runs.length} passes`)
line('suppression is common', candidates.some((c) => !c.surfaced) || !candidates.length, `${candidates.filter((c) => !c.surfaced).length} suppressed`)
line('quiet cycles exist', quiet > 0 || !runs.length, `${quiet} of ${runs.length}`)

store.close?.()
rmSync(dir, { recursive: true, force: true })

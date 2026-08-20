/**
 * WHAT THE BRAIN THOUGHT, THIS PASS, WITHOUT ANY OF IT REACHING HIM.
 *
 * §29 and §30. The memory core has been ingesting and reflecting against real
 * data since `host.ts` was installed, and until now the only record of a pass was
 * `ReflectionRun` — six counts and a handful of note strings. That is enough to
 * know a pass ran. It is nowhere near enough to answer the question this milestone
 * actually turns on:
 *
 *     Is this thing's understanding of his life any good?
 *
 * You cannot answer that from counts. `routines: 4` is the same number whether the
 * four are real or whether one of them is "he is at home", and `anomalies: 9` is
 * indistinguishable between a genuinely strange Tuesday and a broken step sensor.
 * What separates those is WHAT CHANGED and WHAT WAS THROWN AWAY — and the second
 * one has never been recorded anywhere, because until `significance.ts` there was
 * nothing that threw anything away on purpose.
 *
 * THE SHAPE OF THE ANSWER: A DIFF, NOT A DUMP.
 *
 * `inspect.ts` already dumps state, and a dump of derived cognition is unreadable
 * after a week of real data — hundreds of entities, thousands of episodes. What is
 * legible, and what a reviewer actually wants, is the delta: the eleven things
 * that moved out of the thousands that did not. So a shadow run takes a census
 * before the cycle, a census after, and records the difference.
 *
 * The census is deliberately shallow — an id and the two or three fields whose
 * movement constitutes news. A deep structural diff would be more thorough and
 * would produce exactly the wall of JSON §17 and §47 both refuse; a reviewer would
 * stop reading it, and a log nobody reads has the same value as no log.
 *
 * WHY IT DOES NOT SURFACE ANYTHING.
 *
 * §30's shadow mode, and it is the point of the file rather than a limitation of
 * it. Candidates are generated, scored, and judged against the significance gate,
 * and the verdict is written down — INCLUDING for the ones that would have been
 * shown. Nothing is handed to `compose`, nothing reaches a slot, and the existing
 * Home is untouched. What that buys is the ability to read four months of "this is
 * what I would have said" before he ever sees the first sentence of it, which is
 * the only order in which a mistake here is cheap.
 *
 * FAILURE IS THE SHADOW RUN'S PROBLEM, NEVER THE CYCLE'S.
 *
 * The census, the diff and the judging are all wrapped: an exception in any of
 * them loses the shadow record for that pass and must never lose the pass. The
 * reflection has already written its derived rows by then, and an inspection
 * artifact taking down cognition would be the tail wagging the dog — the same
 * argument `host.ts` makes about a broken ledger never costing a sync.
 */

import { hash, idOf } from './ids.js'
import { memoryCandidates } from './candidates.js'
import { runCycle, type CycleOptions, type CycleResult } from './reflect.js'
import { judge, type Finding, type SignificanceContext } from './significance.js'
import { hypothesisSentence } from './hypotheses.js'
import { routineSentence } from './routines.js'
import {
  VERSIONS,
  type CandidateRecord,
  type Hypothesis,
  type HypothesisDelta,
  type MemoryStore,
  type Prediction,
  type ReflectionRun,
  type Ref,
  type RoutineModel,
  type ShadowRun,
} from './types.js'
import type { Sample } from './temporal.js'

/** What a census remembers about each row: just enough to tell that it moved. */
interface Census {
  entities: Set<string>
  episodes: Map<string, string>
  routines: Map<string, { status: string; evidence: number; confidence: number }>
  hypotheses: Map<string, { status: string; support: number; contradiction: number; confidence: number }>
  predictions: Set<string>
  outcomes: Set<string>
  sections: Record<string, number>
}

const census = (store: MemoryStore): Census => ({
  entities: new Set(store.entities.all().map((e) => e.id)),
  // `updatedAt`, not the record, because that is the field assembly moves and it
  // is the cheapest possible statement of "this episode is not the one it was".
  episodes: new Map(store.episodes.all().map((e) => [e.id, `${e.status}@${e.updatedAt}`])),
  routines: new Map(
    store.routines.all().map((r) => [r.id, { status: r.status, evidence: r.evidenceCount, confidence: r.confidence }])
  ),
  hypotheses: new Map(
    store.hypotheses
      .all()
      .map((h) => [h.id, { status: h.status, support: h.support, contradiction: h.contradiction, confidence: h.confidence }])
  ),
  predictions: new Set(store.predictions.all().map((p) => p.id)),
  outcomes: new Set(store.predictions.outcomes().map((o) => o.predictionId)),
  sections: {
    entities: store.entities.all().length,
    episodes: store.episodes.all().length,
    routines: store.routines.all().length,
    hypotheses: store.hypotheses.all().length,
    predictions: store.predictions.all().length,
    summaries: store.summaries.all().length,
  },
})

export interface ShadowOptions extends CycleOptions {
  /** What Home is drawing right now, for §49's duplication check. */
  onScreen?: SignificanceContext['onScreen']
  /** id → when it was last surfaced. From the composer's seen-map on a live host. */
  seen?: SignificanceContext['seen']
}

/**
 * RUN A CYCLE AND WATCH IT.
 *
 * The cycle is run by `runCycle` exactly as it would be without this — same
 * arguments, same order, same writes. This is an observer, and if removing it
 * changed the cognition it would have stopped being one.
 */
export function shadowCycle(
  store: MemoryStore,
  kind: ReflectionRun['kind'],
  now: Date,
  opts: ShadowOptions = {}
): { result: CycleResult; shadow: ShadowRun | null } {
  let before: Census | null = null
  try {
    before = census(store)
  } catch {
    // A census that will not read is not a reason to skip the pass.
  }

  const result = runCycle(store, kind, now, opts)
  if (!before) return { result, shadow: null }

  try {
    return { result, shadow: describe(store, before, result, now, opts) }
  } catch (e) {
    /*
      The cycle has already written. Losing the observation of it is a hole in a
      log; letting this throw would be a failed reflection caused by the tooling
      watching the reflection.
    */
    console.warn(`memory: shadow record failed — ${(e as Error).message}`)
    return { result, shadow: null }
  }
}

/**
 * RUN A CYCLE, WATCH IT, AND KEEP THE RECORD. The entry point both hosts use.
 *
 * It exists because the two schedulers reach cognition by different routes: the
 * Mac goes through `host.ts`'s installed singleton, the edge holds its store on
 * the Durable Object and never installs anything. Without this they would each
 * have their own "and then write the shadow run" line, and the edge's would be
 * the one that silently stopped being written — which is the host whose cognition
 * nobody can otherwise see.
 *
 * Persisting is best-effort by design. The pass has already committed its derived
 * rows before this is reached; an inspection artifact that failed to save must not
 * turn a successful reflection into a failed one.
 */
export function recordedCycle(
  store: MemoryStore,
  kind: ReflectionRun['kind'],
  now: Date,
  opts: ShadowOptions = {}
): { result: CycleResult; shadow: ShadowRun | null } {
  const out = shadowCycle(store, kind, now, opts)
  if (out.shadow) {
    try {
      store.shadow.put(out.shadow)
    } catch (e) {
      console.warn(`memory: shadow log write failed — ${(e as Error).message}`)
    }
  }
  return out
}

function describe(
  store: MemoryStore,
  before: Census,
  result: CycleResult,
  now: Date,
  opts: ShadowOptions
): ShadowRun {
  const after = census(store)
  const run = result.run

  // ── Entities ──
  const entitiesAdded: Ref[] = []
  for (const id of after.entities) {
    if (before.entities.has(id)) continue
    const e = store.entities.byId(id)
    entitiesAdded.push({ id, says: e ? `${e.kind} ${e.label}` : id })
  }

  // ── Episodes ──
  const opened: Ref[] = []
  const updated: Ref[] = []
  const closed: Ref[] = []
  for (const [id, mark] of after.episodes) {
    const was = before.episodes.get(id)
    if (mark === was) continue
    const e = store.episodes.byId(id)
    const ref = { id, says: e?.summary ?? `${e?.type ?? '?'} ${e?.startAt ?? ''}` }
    if (was === undefined) opened.push(ref)
    else updated.push(ref)
    // Closed is a status statement and is independent of which of the two above
    // it was: an episode can be assembled already complete.
    if (e && (e.status === 'completed' || e.status === 'cancelled') && !was?.startsWith(e.status)) closed.push(ref)
  }

  // ── Routines ──
  const emerging: Ref[] = []
  const strengthened: Ref[] = []
  const weakened: Ref[] = []
  const inactive: Ref[] = []
  const RANK: Record<string, number> = { candidate: 0, emerging: 1, established: 2, weakening: 1, inactive: 0 }
  for (const [id, nowState] of after.routines) {
    const was = before.routines.get(id)
    const r = store.routines.byId(id)
    const ref = { id, says: r ? saysOf(r) : id }
    if (!was) {
      // A routine that appears already established is still news of the same kind.
      if (nowState.status !== 'candidate') emerging.push(ref)
      continue
    }
    if (nowState.status === 'inactive' && was.status !== 'inactive') inactive.push(ref)
    else if (nowState.status === 'weakening' && was.status !== 'weakening') weakened.push(ref)
    else if ((RANK[nowState.status] ?? 0) > (RANK[was.status] ?? 0)) emerging.push(ref)
    else if (nowState.evidence > was.evidence || nowState.confidence > was.confidence + 0.01) strengthened.push(ref)
  }

  // ── Hypotheses ──
  const hypotheses: HypothesisDelta[] = []
  for (const [id, nowState] of after.hypotheses) {
    const was = before.hypotheses.get(id)
    const h = store.hypotheses.byId(id)
    const supportAdded = nowState.support - (was?.support ?? 0)
    const contradictionAdded = nowState.contradiction - (was?.contradiction ?? 0)
    const confidenceDelta = nowState.confidence - (was?.confidence ?? 0)
    const statusChange = was && was.status !== nowState.status ? `${was.status} → ${nowState.status}` : was ? undefined : `new (${nowState.status})`
    if (!supportAdded && !contradictionAdded && Math.abs(confidenceDelta) < 0.005 && !statusChange) continue
    hypotheses.push({
      id,
      says: h ? hypothesisSentence(h) : id,
      supportAdded,
      contradictionAdded,
      confidenceDelta: Number(confidenceDelta.toFixed(3)),
      statusChange,
    })
  }

  // ── Predictions ──
  const created: Ref[] = []
  for (const id of after.predictions) {
    if (before.predictions.has(id)) continue
    const p = store.predictions.byId(id)
    created.push({ id, says: p ? `${p.target.kind} in ${p.resolutionWindow.start}…${p.resolutionWindow.end}` : id })
  }
  const resolved: ShadowRun['predictions']['resolved'] = []
  for (const id of after.outcomes) {
    if (before.outcomes.has(id)) continue
    const o = store.predictions.outcomeFor(id)
    const p = store.predictions.byId(id)
    if (!o) continue
    resolved.push({
      id,
      says: p ? p.target.kind : id,
      result: o.calibrationResult,
      error: typeof o.error === 'number' ? Number(o.error.toFixed(1)) : undefined,
    })
  }

  // ── Anomalies ──
  const anomalies: Ref[] = result.anomalies.map((a) => ({ id: a.id, says: a.why }))

  // ── Candidates, generated and judged but never surfaced ──
  const candidates = judgeCandidates(store, result, now, opts)

  const snapshotDelta: Record<string, number> = {}
  for (const [k, v] of Object.entries(after.sections)) {
    const d = v - (before.sections[k] ?? 0)
    if (d !== 0) snapshotDelta[k] = d
  }

  const calibration = calibrationSummary(store)

  return {
    id: idOf('shadow', run.kind, hash(run.startedAt)),
    runId: run.id,
    kind: run.kind,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? run.startedAt,
    status: run.status,
    error: run.error ?? null,
    versions: { ...VERSIONS },
    counts: run.counts,
    inputEvents: run.counts.events ?? 0,
    entities: {
      added: entitiesAdded,
      notEntities: run.notes.filter((n) => n.startsWith('not an entity:')),
    },
    episodes: { opened, updated, closed },
    routines: {
      emerging,
      strengthened,
      weakened,
      inactive,
      rejected: run.notes.filter((n) => n.startsWith('routine not kept:')),
    },
    hypotheses,
    predictions: {
      created,
      resolved,
      calibration,
      declined: run.notes.filter((n) => n.startsWith('did not predict')),
    },
    anomalies,
    candidates,
    snapshotDelta,
    notes: run.notes,
  }
}

/**
 * EVERY CANDIDATE THIS PASS COULD HAVE MADE, WITH THE VERDICT ON EACH.
 *
 * `todayValues` is the last sample of each series on the day the pass is about,
 * which is what `explainedAnomaly` needs to decide whether a pattern's condition
 * actually HOLDS today — the join that turns a bare deviation into an explained
 * one. It is read from the series the cycle just computed rather than re-queried,
 * so the judgement is made against the same numbers the cycle reasoned over.
 */
function judgeCandidates(store: MemoryStore, result: CycleResult, now: Date, opts: ShadowOptions): CandidateRecord[] {
  const todayValues: Record<string, number> = {}
  for (const [metric, samples] of Object.entries(result.series)) {
    const last = lastSample(samples)
    if (last !== undefined) todayValues[metric] = last
  }

  const attentions = memoryCandidates(store, result.anomalies, now, todayValues, { timeZone: opts.timeZone })
  const byId = new Map(store.hypotheses.all().map((h) => [h.id, h]))
  const anomalyById = new Map(result.anomalies.map((a) => [a.id, a]))

  /*
    THE TYPED FACTS THE GATE NEEDS, TAKEN OFF THE RECORDS RATHER THAN THE PROSE.

    An `Attention` has scores and a sentence; it does not have the magnitude in
    sigmas or the source diversity, and reading those back out of `detail` would
    be exactly the re-derivation this codebase refuses. So each candidate is
    matched to the record it came from — by id, which is how `candidates.ts`
    constructs them — and the numbers come from there.
  */
  const findings: Finding[] = attentions.map((candidate) => {
    const bare = candidate.id.replace(/:explained$/, '')
    const anomaly = anomalyById.get(bare)
    const hypothesis = byId.get(candidate.id)
    const prediction = store.predictions.byId(candidate.id)

    if (anomaly) {
      return {
        candidate,
        source: candidate.id.endsWith(':explained') ? 'explained_anomaly' : 'anomaly',
        magnitude: sigmasOf(anomaly.magnitude, anomaly.subject, result.series),
        focus: anomaly.subject,
        subject: anomaly.subject,
      }
    }
    if (hypothesis) {
      return {
        candidate,
        source: 'hypothesis',
        coverageDays: hypothesis.temporalCoverageDays,
        diversity: hypothesis.evidenceDiversity,
        propositionKind: hypothesis.proposition.kind,
        distinctValues: distinctIn(result.series[focusOfHypothesis(hypothesis) ?? '']),
        focus: focusOfHypothesis(hypothesis),
      }
    }
    if (prediction) {
      return {
        candidate,
        source: 'prediction',
        probability: prediction.probability,
        interval: intervalOf(prediction, result.series),
        focus: prediction.target.kind,
      }
    }
    return { candidate, source: 'anomaly' }
  })

  return judge(findings, { now, onScreen: opts.onScreen, seen: opts.seen }).map(({ finding, verdict }) => ({
    id: finding.candidate.id,
    says: finding.candidate.detail || finding.candidate.title,
    source: finding.source,
    score: Number(verdict.score.toFixed(3)),
    surfaced: verdict.surfaced,
    reason: verdict.reason,
    why: verdict.why,
    informationBits: verdict.informationBits === undefined ? undefined : Number(verdict.informationBits.toFixed(3)),
    grounds: finding.candidate.because.grounds.slice(0, 4),
  }))
}

/**
 * An anomaly's magnitude in standard deviations of its own series.
 *
 * `Anomaly.magnitude` is "how far out, in the metric's own units" — 2400 steps,
 * 83 minutes — and a floor expressed in those units would have to be different
 * per metric and would silently be wrong for the next one. Sigmas are the unit
 * the question is actually asked in. When the series is not to hand the magnitude
 * is left undefined rather than guessed, and the gate skips that test.
 */
function sigmasOf(magnitude: number, subject: string, series: Record<string, Sample[]>): number | undefined {
  const metric = subject.split('.').pop() ?? ''
  const samples = series[metric]
  if (!samples || samples.length < 4) return undefined
  const values = samples.map((s) => s.value)
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length)
  return sd > 0 ? magnitude / sd : undefined
}

/**
 * A routine in one line.
 *
 * `routineSentence` takes the label from its caller and returns the two halves
 * separately, because the surfaces that draw it put them in different places. A
 * log wants one string, so it joins them — and passes `activityType` as the label,
 * which is the routine's own name for itself rather than a phrasing invented here.
 */
function saysOf(r: RoutineModel): string {
  const { what, cadence } = routineSentence(r, r.activityType)
  return `${what} — ${cadence}`
}

/**
 * A PREDICTION'S WINDOW, AGAINST THE WINDOW IT WOULD HAVE WITHOUT A MODEL.
 *
 * The naive width is three standard deviations of the WHOLE series — the same
 * ±1.5σ construction `predictions.ts` applies to the scoped one, so the two are
 * directly comparable and a ratio of 1 means the scope contributed nothing. Any
 * other denominator (the full range, an interquartile spread) would make the
 * ratio partly an artifact of the two being built differently.
 *
 * Undefined when the prediction has no interval or the metric is not to hand, and
 * the gate then skips the test rather than guessing.
 */
function intervalOf(p: Prediction, series: Record<string, Sample[]>): { width: number; naiveWidth: number } | undefined {
  if (!p.interval) return undefined
  const metric = p.target.kind === 'timing' || p.target.kind === 'measure' ? p.target.metric : null
  const samples = metric ? series[metric] : undefined
  if (!samples || samples.length < 4) return undefined
  const values = samples.map((s) => s.value)
  const m = values.reduce((a, b) => a + b, 0) / values.length
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length)
  return { width: p.interval.upper - p.interval.lower, naiveWidth: 3 * sd }
}

/** How many values a series actually takes. A count metric takes very few. */
const distinctIn = (samples: Sample[] | undefined): number | undefined =>
  samples && samples.length ? new Set(samples.map((s) => s.value)).size : undefined

/** The object a hypothesis is about, for the on-screen check. */
const focusOfHypothesis = (h: Hypothesis): string | undefined =>
  h.proposition.kind === 'association' ? h.proposition.then.metric : h.proposition.kind === 'shift' ? h.proposition.metric : undefined

const lastSample = (samples: Sample[]): number | undefined =>
  samples.length ? samples[samples.length - 1]!.value : undefined

function calibrationSummary(store: MemoryStore): ShadowRun['predictions']['calibration'] {
  const outcomes = store.predictions.outcomes()
  if (!outcomes.length) return null
  const errors = outcomes.map((o) => o.error).filter((e): e is number => typeof e === 'number')
  return {
    samples: outcomes.length,
    hitRate: Number((outcomes.filter((o) => o.calibrationResult === 'correct').length / outcomes.length).toFixed(3)),
    meanError: errors.length ? Number((errors.reduce((a, b) => a + b, 0) / errors.length).toFixed(1)) : 0,
  }
}

// ── Reading one ──────────────────────────────────────────────────────────────

/**
 * A SHADOW RUN AS TEXT, in the layout §29 lays out.
 *
 * Text rather than a UI for the same reason `inspect.ts` gives: a debugger surface
 * is a product decision nobody has made, and this is needed today. Empty sections
 * are omitted — a pass where nothing happened should be three lines, not a page of
 * headings with nothing under them, or nobody will read the pass where something
 * did.
 */
export function renderShadow(s: ShadowRun): string {
  const out: string[] = []
  const section = (title: string, lines: string[]) => {
    if (!lines.length) return
    out.push('', title)
    for (const l of lines) out.push(`  ${l}`)
  }

  out.push(`WORLD MODEL SHADOW RUN  ${s.id}`)
  out.push(`  ${s.kind}  ${s.startedAt} → ${s.finishedAt}  ${s.status}${s.error ? `  ${s.error}` : ''}`)
  out.push(`  ${s.inputEvents} input events · ${JSON.stringify(s.counts)}`)

  section('ENTITIES', [
    ...s.entities.added.map((e) => `+ ${e.says}`),
    ...s.entities.notEntities.map((n) => `· ${n}`),
  ])
  section('EPISODES', [
    ...s.episodes.opened.map((e) => `opened   ${e.says}`),
    ...s.episodes.updated.map((e) => `updated  ${e.says}`),
    ...s.episodes.closed.map((e) => `closed   ${e.says}`),
  ])
  section('ROUTINES', [
    ...s.routines.emerging.map((r) => `emerging      ${r.says}`),
    ...s.routines.strengthened.map((r) => `strengthened  ${r.says}`),
    ...s.routines.weakened.map((r) => `weakened      ${r.says}`),
    ...s.routines.inactive.map((r) => `inactive      ${r.says}`),
    ...s.routines.rejected.map((r) => `· ${r}`),
  ])
  section(
    'HYPOTHESES',
    s.hypotheses.map(
      (h) =>
        `${h.statusChange ? `${h.statusChange}  ` : ''}+${h.supportAdded}/-${h.contradictionAdded} ` +
        `conf ${h.confidenceDelta >= 0 ? '+' : ''}${h.confidenceDelta}  ${h.says}`
    )
  )
  section('PREDICTIONS', [
    ...s.predictions.created.map((p) => `made      ${p.says}`),
    ...s.predictions.resolved.map((p) => `resolved  ${p.result}${p.error !== undefined ? ` (error ${p.error})` : ''}  ${p.says}`),
    ...(s.predictions.calibration
      ? [`calibration  ${s.predictions.calibration.samples} resolved · hit ${s.predictions.calibration.hitRate} · mean error ${s.predictions.calibration.meanError}`]
      : []),
    ...s.predictions.declined.map((d) => `· ${d}`),
  ])
  section('ANOMALIES', s.anomalies.map((a) => a.says))

  /*
    THE HALF THAT IS THE POINT. Surfaced first, then everything that was not, with
    the typed reason — which is what makes "what is this thing throwing away, and
    is that right" a question the log can answer.
  */
  section(
    'CANDIDATES',
    s.candidates.map((c) => {
      const head = c.surfaced ? '→ WOULD SURFACE' : `  suppressed (${c.reason})`
      return `${head}  [${c.score}] ${c.says}\n      ${c.why}\n      ${c.grounds.map((g) => `${g.kind}:${g.says}`).join(' · ')}`
    })
  )

  const delta = Object.entries(s.snapshotDelta)
  section('SNAPSHOT DELTA', delta.map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${v}`))

  return out.join('\n')
}

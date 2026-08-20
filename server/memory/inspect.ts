/**
 * SEEING WHAT IT THINKS, WITHOUT A DEBUGGER AND WITHOUT A UI.
 *
 * §48 asks for enough tooling that development is not blind, and §28 asks that
 * every surfaced observation be traceable. Those are the same requirement seen
 * from two ends, and this file is the answer to both — deliberately as text
 * rather than as a surface, because a production debugger UI is a product
 * decision nobody has made and this is needed today.
 *
 * THE ONE THAT MATTERS IS `explain`. Everything else here is a dump. `explain`
 * walks a conclusion back to the raw source events underneath it, through every
 * intermediate structure, and prints the chain. That is the test §39 describes,
 * available at a prompt: if a conclusion cannot be traced to evidence, this shows
 * exactly where the chain breaks rather than reporting a confident sentence with
 * nothing under it.
 *
 * Nothing here writes. A debugging tool that mutates state is a debugging tool
 * that changes the thing being debugged.
 */

import { hypothesisSentence } from './hypotheses.js'
import { predictionSentence } from './predictions.js'
import { recommendationReport } from './recommendations.js'
import { routineSentence } from './routines.js'
import type { EvidenceRef, MemoryStore } from './types.js'

const clip = (s: string, n = 90): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Everything at a glance: counts per table, and the last few runs. */
export function overview(store: MemoryStore): string {
  const lines: string[] = []
  lines.push(`schema v${store.schemaVersion()}`)
  lines.push(`events ${store.events.count()}  observations ${store.observations.count()}`)
  lines.push(
    `entities ${store.entities.all().length}  relationships ${store.relationships.all().length}  episodes ${store.episodes.all().length}`
  )
  lines.push(
    `routines ${store.routines.all().length}  hypotheses ${store.hypotheses.all().length}  summaries ${store.summaries.all().length}`
  )
  const preds = store.predictions.all()
  lines.push(
    `predictions ${preds.length} (${preds.filter((p) => p.status === 'pending').length} pending)  outcomes ${store.predictions.outcomes().length}`
  )
  lines.push(`recommendations ${store.recommendations.all().length}  outcomes ${store.recommendations.outcomes().length}`)

  const runs = store.runs.recent(5)
  if (runs.length) {
    lines.push('\nlast runs:')
    for (const r of runs) {
      lines.push(`  ${r.startedAt} ${r.kind.padEnd(7)} ${r.status.padEnd(7)} ${JSON.stringify(r.counts)}`)
      // The notes are where "considered and not surfaced" lives, in the same
      // spirit as `InsightRun.notes` — which §28 says to extend rather than to
      // duplicate with a parallel hidden log.
      for (const note of r.notes.slice(0, 3)) lines.push(`      · ${note}`)
    }
  }
  return lines.join('\n')
}

/** The ledger's tail, as it actually arrived. */
export function recentEvents(store: MemoryStore, limit = 20): string {
  const all = store.events.all()
  return all
    .slice(-limit)
    .map((e) => `${e.observedAt} ${e.type.padEnd(20)} ${e.id}`)
    .join('\n')
}

export function entities(store: MemoryStore): string {
  return store.entities
    .all()
    .map(
      (e) =>
        `${e.kind.padEnd(6)} ${e.label.padEnd(24)} conf ${e.confidence.toFixed(2)}  ${e.identities.join(', ') || '(no identity — a bare name)'}${e.aliases.length ? `  aka ${e.aliases.join(', ')}` : ''}`
    )
    .join('\n')
}

export function routines(store: MemoryStore): string {
  return store.routines
    .all()
    .map((r) => {
      const { what, cadence } = routineSentence(r, String(r.context.label ?? r.activityType))
      return `${r.status.padEnd(12)} ${what.padEnd(24)} ${cadence}  [n=${r.evidenceCount} over ${r.temporalCoverageDays}d, p=${r.temporal.recurrenceProbability.toFixed(2)}, conf=${r.confidence.toFixed(2)}]`
    })
    .join('\n')
}

/**
 * Hypotheses with the SPLIT visible, not the confidence.
 *
 * Support-versus-contradiction is the number that says whether a claim has been
 * tested; confidence is a rendering of it. Printing only the second is how a
 * claim at 0.6 from nineteen-of-twenty-three and one at 0.6 from three-of-five
 * become indistinguishable at a glance — and they are not remotely the same
 * thing.
 */
export function hypotheses(store: MemoryStore): string {
  return store.hypotheses
    .all()
    .sort((a, b) => b.confidence - a.confidence)
    .map(
      (h) =>
        `${h.status.padEnd(10)} ${String(h.support).padStart(3)}/${String(h.support + h.contradiction).padEnd(4)} div${h.evidenceDiversity} ${String(h.temporalCoverageDays).padStart(3)}d conf ${h.confidence.toFixed(2)}  ${clip(hypothesisSentence(h))}`
    )
    .join('\n')
}

export function predictions(store: MemoryStore, limit = 20): string {
  const outcomes = new Map(store.predictions.outcomes().map((o) => [o.predictionId, o]))
  return store.predictions
    .all()
    .slice(-limit)
    .map((p) => {
      const o = outcomes.get(p.id)
      const result = o ? `${o.calibrationResult}${typeof o.error === 'number' ? ` (${o.error > 0 ? '+' : ''}${Math.round(o.error)})` : ''}` : p.status
      return `${p.createdAt.slice(0, 10)} ${result.padEnd(20)} ${clip(predictionSentence(p), 70)}`
    })
    .join('\n')
}

export function recommendations(store: MemoryStore): string {
  return recommendationReport(store)
    .map(
      (r) =>
        `${r.subject.padEnd(12)} shown ${r.shown}  accepted ${r.accepted}  dismissed ${r.dismissed}  undecided ${r.undecided}${r.fromModels.length ? `  from ${r.fromModels.join(', ')}` : ''}`
    )
    .join('\n')
}

// ── The evidence chain ───────────────────────────────────────────────────────

/**
 * WALK A CONCLUSION BACK TO THE SOURCE EVENTS UNDERNEATH IT.
 *
 * The question §28 lists — what did it conclude, why, on what evidence, how
 * confidently, through which structures, from which raw records — answered by
 * following ids until they bottom out in the ledger.
 *
 * `seen` is not an optimisation. The graph genuinely has cycles: an episode cites
 * observations, a routine cites episodes, a hypothesis cites observations that
 * belong to those same episodes. Without it this recurses until the stack gives
 * out, which is a stupid way to discover that a trace is circular.
 *
 * A ref that resolves to NOTHING is printed as such rather than skipped. That is
 * the entire diagnostic value: a conclusion citing an id no table holds is a
 * conclusion nobody can check, and silence there would hide exactly the failure
 * this exists to find.
 */
export function explain(store: MemoryStore, id: string, depth = 0, seen = new Set<string>()): string {
  const pad = '  '.repeat(depth)
  if (seen.has(id)) return `${pad}${id} (already shown above)`
  seen.add(id)
  if (depth > 6) return `${pad}${id} (deeper than this trace goes)`

  const kind = id.split(':')[0]

  switch (kind) {
    case 'evt': {
      const e = store.events.byId(id)
      if (!e) break
      // The bottom of every chain. A source said this, at a time, and we kept it
      // verbatim — there is nothing under it to explain.
      return `${pad}EVENT ${e.type} from ${e.source} at ${e.sourceAt}\n${pad}  payload: ${clip(JSON.stringify(e.payload), 120)}`
    }
    case 'obs': {
      const o = store.observations.byId(id)
      if (!o) break
      return [
        `${pad}OBSERVATION ${o.type} (${o.provenance.source}, conf ${o.confidence}) ${clip(JSON.stringify(o.attributes), 100)}`,
        explain(store, o.eventId, depth + 1, seen),
      ].join('\n')
    }
    case 'epi': {
      const e = store.episodes.byId(id)
      if (!e) break
      return [
        `${pad}EPISODE ${e.type} ${e.startAt} — ${e.status}, conf ${e.confidence}: ${e.summary ?? ''}`,
        ...e.observationIds.slice(0, 4).map((o) => explain(store, o, depth + 1, seen)),
      ].join('\n')
    }
    case 'rtn': {
      const r = store.routines.byId(id)
      if (!r) break
      const { what, cadence } = routineSentence(r, String(r.context.label ?? r.activityType))
      return [
        `${pad}ROUTINE ${what}: ${cadence} [${r.status}, n=${r.evidenceCount}, p=${r.temporal.recurrenceProbability.toFixed(2)}]`,
        ...refs(r.evidence).slice(0, 3).map((e) => explain(store, e, depth + 1, seen)),
      ].join('\n')
    }
    case 'hyp': {
      const h = store.hypotheses.byId(id)
      if (!h) break
      return [
        `${pad}HYPOTHESIS ${hypothesisSentence(h)}`,
        `${pad}  ${h.status}: ${h.support} for, ${h.contradiction} against, ${h.evidenceDiversity} sources, ${h.temporalCoverageDays} days, conf ${h.confidence.toFixed(2)}`,
        ...refs(h.evidence).slice(0, 3).map((e) => explain(store, e, depth + 1, seen)),
      ].join('\n')
    }
    case 'prd': {
      const p = store.predictions.byId(id)
      if (!p) break
      const o = store.predictions.outcomeFor(p.id)
      return [
        `${pad}PREDICTION ${predictionSentence(p)} [${p.status}, conf ${p.confidence.toFixed(2)}]`,
        o ? `${pad}  OUTCOME ${o.calibrationResult}, observed ${JSON.stringify(o.observedReality)}${typeof o.error === 'number' ? `, error ${Math.round(o.error)}` : ''}` : `${pad}  not yet resolved`,
        ...p.modelBasis.slice(0, 2).map((b) => explain(store, b, depth + 1, seen)),
      ].join('\n')
    }
    case 'ent': {
      const e = store.entities.byId(id)
      if (!e) break
      return [
        `${pad}ENTITY ${e.kind} "${e.label}" conf ${e.confidence.toFixed(2)} ${e.identities.join(', ') || '(no identity)'}`,
        ...refs(e.evidence).slice(0, 2).map((x) => explain(store, x, depth + 1, seen)),
      ].join('\n')
    }
    case 'fct': {
      const f = store.facts.byId(id)
      if (!f) break
      return [
        `${pad}FACT ${f.predicate} = ${JSON.stringify(f.value)} [${f.knowledgeKind}, by ${f.by}, conf ${f.confidence}]`,
        ...refs(f.evidence).slice(0, 3).map((x) => explain(store, x, depth + 1, seen)),
      ].join('\n')
    }
    case 'tmp': {
      const s = store.summaries.byId(id)
      if (!s) break
      return `${pad}SUMMARY ${s.domain}.${s.metric} ${s.scope}: n=${s.count} mean=${s.mean === null ? '—' : Math.round(s.mean)} sd=${s.stdDev === null ? '—' : Math.round(s.stdDev)}${s.changePoint ? ` change at ${s.changePoint.day} (${Math.round(s.changePoint.before)}→${Math.round(s.changePoint.after)})` : ''}`
    }
  }

  return `${pad}${id} — NOTHING HOLDS THIS ID. The chain is broken here.`
}

const refs = (evidence: EvidenceRef[]): string[] => evidence.map((e) => e.id)

/**
 * EVERY RAW SOURCE EVENT UNDER A CONCLUSION, flattened.
 *
 * `explain` is for reading; this is for asserting. §39's test needs to enumerate
 * the events behind a surfaced item and fail if the list is empty, and doing that
 * against formatted text would be a test of the formatting.
 */
export function evidenceEvents(store: MemoryStore, id: string, seen = new Set<string>()): string[] {
  if (seen.has(id)) return []
  seen.add(id)
  const kind = id.split(':')[0]

  if (kind === 'evt') return store.events.byId(id) ? [id] : []
  if (kind === 'obs') {
    const o = store.observations.byId(id)
    return o ? evidenceEvents(store, o.eventId, seen) : []
  }
  if (kind === 'epi') {
    const e = store.episodes.byId(id)
    return e ? e.observationIds.flatMap((o) => evidenceEvents(store, o, seen)) : []
  }
  if (kind === 'rtn') {
    const r = store.routines.byId(id)
    return r ? refs(r.evidence).flatMap((x) => evidenceEvents(store, x, seen)) : []
  }
  if (kind === 'hyp') {
    const h = store.hypotheses.byId(id)
    return h ? refs(h.evidence).flatMap((x) => evidenceEvents(store, x, seen)) : []
  }
  if (kind === 'prd') {
    const p = store.predictions.byId(id)
    return p ? [...refs(p.evidence), ...p.modelBasis].flatMap((x) => evidenceEvents(store, x, seen)) : []
  }
  if (kind === 'ent') {
    const e = store.entities.byId(id)
    return e ? refs(e.evidence).flatMap((x) => evidenceEvents(store, x, seen)) : []
  }
  if (kind === 'fct') {
    const f = store.facts.byId(id)
    return f ? refs(f.evidence).flatMap((x) => evidenceEvents(store, x, seen)) : []
  }
  return []
}

/** Everything, for a `--dump` that wants one string. */
export function dump(store: MemoryStore): string {
  return [
    '── overview ──',
    overview(store),
    '\n── entities ──',
    entities(store),
    '\n── routines ──',
    routines(store),
    '\n── hypotheses ──',
    hypotheses(store),
    '\n── predictions (tail) ──',
    predictions(store),
    '\n── recommendations ──',
    recommendations(store) || '(none)',
  ].join('\n')
}

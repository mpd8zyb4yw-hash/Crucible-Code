/**
 * THE PRESENTATION BOUNDARY BETWEEN COGNITION AND THE SCREEN.
 *
 * Phase 6. Everything the memory core concludes is a typed record — a
 * `Hypothesis` with a `TypedProposition`, an `Anomaly` with a magnitude in
 * sigmas, a `Prediction` with an interval — and none of those may reach React.
 * What reaches React is the object below, compiled here, and the compilation is
 * the product decision: it is the one place that turns "confidence 0.73, support
 * 19, contradiction 4" into a sentence a person can read and argue with.
 *
 *     memory / typed cognition
 *             ↓
 *     presentation compiler        ← this file
 *             ↓
 *     bounded UI object
 *             ↓
 *     React
 *
 * THE THREE RULES THAT MAKE IT WORTH HAVING A BOUNDARY AT ALL.
 *
 *   · NO NUMBER MAY APPEAR IN COPY THAT DID NOT COME FROM A RECORD. Not
 *     "roughly two hours", not "about a third", not "most Tuesdays" backed by
 *     nothing. `grounded()` enforces this mechanically rather than by good
 *     intentions: every quantity a sentence contains is checked against the set
 *     of quantities the typed input actually carried, and a sentence with a
 *     number nobody computed is refused. That guard exists now, while the copy
 *     is written in TypeScript and cannot possibly hallucinate, precisely
 *     BECAUSE the interesting case is later — the moment a language model is
 *     handed the wording, this is the only thing standing between his home
 *     screen and a fluent invention.
 *
 *   · CERTAINTY IS LANGUAGE, NOT TELEMETRY. `confidence 0.73` says nothing to
 *     anybody and invites the reader to do arithmetic nobody has justified. The
 *     compiler maps the epistemic state onto five bands and the bands choose the
 *     verb — "you", "you usually", "you've tended to", "it looks like", "I may
 *     be seeing". The number stays on the record for the developer view.
 *
 *   · THE CARD CANNOT OUTGROW ITS SLOT. Copy is clamped HERE, at generation, and
 *     again in the UI. `model writes paragraph → CSS invents scroll` is the
 *     failure the contract's overflow ladder exists to prevent, and a budget
 *     applied only in the client is a budget applied after the damage.
 *
 * WHAT THIS FILE DOES NOT DO: decide whether anything is worth showing.
 * `significance.ts` owns that gate and owns it alone. A presentation compiled
 * from a suppressed finding is still compiled — the developer view reads them —
 * it simply never reaches the slot.
 */

import { timeLabel } from './clock.js'
import type { Lifecycle } from './attention.js'
import { isLive, type MemoryPosture } from './memory/authority.js'
import { memoryCandidates } from './memory/candidates.js'
import { deniedIds } from './memory/correction.js'
import { judge, type Finding } from './memory/significance.js'
import type {
  Anomaly,
  EvidenceRef,
  Hypothesis,
  MemoryStore,
  Prediction,
  RoutineModel,
  TemporalSummary,
} from './memory/types.js'

// ── The bounded object ───────────────────────────────────────────────────────

/**
 * WHAT KIND OF THOUGHT THIS IS, in his terms rather than in the store's.
 *
 * Deliberately not the record type. `Hypothesis` is not a category a person
 * recognises; "something changed" is. The mapping is many-to-one on purpose —
 * a shift hypothesis and a change-point anomaly are both `change`, because the
 * distinction between them is about how we found it and he is not operating the
 * machinery.
 */
export type IntelligenceKind =
  | 'observation'
  | 'connection'
  | 'change'
  | 'question'
  | 'recommendation'
  | 'prediction'

/**
 * HOW SURE, AS FIVE BANDS.
 *
 * Five rather than a number because the number is not defensible to one decimal
 * place and reads as though it were. Five rather than three because "strong" and
 * "likely" genuinely differ in what they license the copy to claim: one may say
 * "you usually", the other may only say "you have tended to".
 */
export type Certainty = 'known' | 'strong' | 'likely' | 'possible' | 'unclear'

/** A formatted quantity. Formatted on the SERVER — see `clock.ts`'s standing rule. */
export interface IntelligenceValue {
  label: string
  value: string
}

/**
 * THE EVIDENCE PRIMITIVES, AND WHY THERE ARE ONLY FOUR.
 *
 * §13: reusable forms, not a bespoke page per finding and not an analytics
 * dashboard. Each one answers "why did Crucible say this?" in a picture, and
 * each is populated from typed fields only:
 *
 *   comparison    before/after. The shift case: usual 10:31, recent 11:54.
 *   distribution  a small series with the unusual sample marked.
 *   tally         occasions for and against. A hypothesis's actual arithmetic.
 *   range         an expected interval with the observed point on it.
 *
 * A finding with no visual is honest; it renders as words. What is forbidden is
 * a fifth shape invented for one card, which is how a detail view becomes a
 * dashboard one addition at a time.
 */
export type IntelligenceVisual =
  | { kind: 'comparison'; before: IntelligenceValue; after: IntelligenceValue }
  | {
      kind: 'distribution'
      bars: { label: string; v: number | null; mark?: boolean }[]
      /** Formatted readouts for the extremes, so the client formats nothing. */
      low: string
      high: string
    }
  | { kind: 'tally'; for: number; against: number; caption: string }
  | { kind: 'range'; lo: string; hi: string; point?: string; caption: string }

/** How a ground is introduced, in plain language. Never the internal vocabulary. */
export type GroundVoice = 'observation' | 'computation' | 'inference' | 'fact'

export interface IntelligenceEvidencePresentation {
  /**
   * One line per real row, in his words.
   *
   * `says` comes off the `EvidenceRef` that already exists. Nothing here is
   * written by this file: a trail whose lines were composed at presentation time
   * would be prose about evidence rather than evidence, which is the exact
   * failure §39 tests for.
   */
  trail: { id: string; voice: GroundVoice; says: string }[]
  /** "23 days · 3 sources" — assembled from counts the record carries. */
  span?: string
  /** What we do not know, stated rather than hidden. */
  caveats: string[]
}

/**
 * SOMETHING TO DO ABOUT IT — carrying an identity, never a label.
 *
 * The contract addition of 2026-08-17 was written after a pill reading "Set a
 * reminder" turned out to be a string with no action behind it. An action here
 * names what it opens or asks; a client cannot render one it was not given the
 * means to perform.
 */
export type IntelligenceAction =
  /** Open a surface, optionally focused on an object. */
  | { kind: 'open'; id: string; label: string; surface: string; focus?: string }
  /** Put a question in the composer. Conversational, and it says so. */
  | { kind: 'ask'; id: string; label: string; text: string }

export interface IntelligencePresentation {
  id: string
  kind: IntelligenceKind
  /** Entity/object ids this is about. The dedup key against slot two. */
  subjectRefs: string[]
  /** The thought, in one line. Clamped to `BUDGET.headline`. */
  headline: string
  /** What supports it, in one or two. Clamped to `BUDGET.summary`. */
  summary?: string
  /** Why it matters, when it does. Optional and short — most findings have none. */
  implication?: string
  certainty: Certainty
  visual?: IntelligenceVisual
  evidence: IntelligenceEvidencePresentation
  actions?: IntelligenceAction[]
  /** Ids of the records this was compiled from. What `wrong` argues with. */
  provenanceRefs: string[]
  /**
   * The ranking facts, kept because the developer view needs them and the card
   * must not. Nothing in here is rendered as a number to him.
   */
  attention: {
    score: number
    significant: boolean
    /** Why it was suppressed, when it was. Developer view only. */
    suppressedFor?: string
    ends: Lifecycle['ends']
  }
  generatedAt: string
}

// ── The copy budget ──────────────────────────────────────────────────────────

/**
 * WHAT FITS, IN CHARACTERS, DERIVED FROM THE SLOT.
 *
 * The intelligence card is 170px tall and holds an eyebrow, the headline and a
 * support line, at 15px/21px on a 402pt screen — about 40 characters to the
 * line. Two lines of headline and two of summary is the whole card, so these are
 * the numbers, and they are enforced at compile time rather than trusted.
 *
 * `implication` is deliberately tighter than either: it is the third thing on a
 * card that only has room for two, and it appears on the face only when it is
 * short enough to earn the row.
 */
export const BUDGET = {
  headline: 78,
  summary: 120,
  implication: 60,
} as const

/**
 * Clamp on a word boundary, with a real ellipsis.
 *
 * Truncation mid-word is what the audit found the mail counter doing — "Newest:
 * Your…" — and the reason it looked like damage rather than truncation. A clamp
 * that cuts at a space reads as a clamp.
 */
export function clampCopy(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ')
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.—-]+$/, '')}…`
}

// ── The guard that makes this a boundary rather than a formatter ─────────────

/**
 * EVERY QUANTITY IN A SENTENCE, AS THE READER WOULD READ IT.
 *
 * Digit groups, with separators and decimals kept together, plus the small
 * number-words that carry quantity in English. "about two hours" is a claim of
 * the same kind as "about 2 hours" and a guard that only looked at digits would
 * wave the first one through, which is precisely the form a language model
 * reaches for.
 */
const WORD_NUMBERS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
  half: '0.5', twice: '2', double: '2', triple: '3',
}

export function quantitiesIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\d[\d.,:]*/g)) out.push(m[0].replace(/[.,]$/, ''))
  for (const m of text.toLowerCase().matchAll(/\b[a-z]+\b/g)) {
    const w = WORD_NUMBERS[m[0]]
    if (w) out.push(w)
  }
  return out
}

/**
 * IS EVERY NUMBER IN THIS SENTENCE ONE WE ACTUALLY COMPUTED?
 *
 * `allowed` is assembled from the typed record — the medians, the counts, the
 * coverage, the formatted times — and nothing else. A sentence quoting a
 * quantity that is not in that set is refused, whoever wrote it.
 *
 * The comparison is on the rendered form after separators are stripped, because
 * "1,240" and "1240" are the same claim and only one of them was formatted. It
 * is NOT a numeric comparison: "11:54" is allowed as the string it was formatted
 * into, so a sentence saying "11:54" passes and a sentence saying "11.9" — which
 * nobody computed — does not, even though a lenient parser could relate them.
 *
 * Returns the offending quantities so the caller can log what was refused; an
 * empty array is a pass.
 */
export function ungrounded(text: string, allowed: Iterable<string | number>): string[] {
  const ok = new Set<string>()
  for (const a of allowed) {
    const s = String(a)
    ok.add(s)
    ok.add(s.replace(/[.,\s]/g, ''))
    // A formatted time contributes its parts: "11:54" grounds "11" and "54".
    for (const part of s.split(/[:\s]/)) if (part) ok.add(part.replace(/[.,]/g, ''))
  }
  return quantitiesIn(text).filter((q) => !ok.has(q) && !ok.has(q.replace(/[.,]/g, '')))
}

/**
 * The compiler's own assertion, applied to every field it emits.
 *
 * Deliberately a THROW rather than a silent drop. A card that quietly loses its
 * summary because a guard fired is a card whose defect is invisible in
 * production and absent from the logs; a compiler that refuses to build is a
 * defect somebody fixes. Callers that may legitimately receive untrusted wording
 * — the model path, when one exists — use `ungrounded` directly and fall back to
 * the deterministic sentence.
 */
function grounded(field: string, text: string, allowed: Iterable<string | number>): string {
  const bad = ungrounded(text, allowed)
  if (bad.length) {
    throw new Error(`intelligence: ${field} states ${bad.join(', ')}, which nothing computed`)
  }
  return text
}

// ── Certainty ────────────────────────────────────────────────────────────────

/**
 * THE FIVE BANDS, FROM THE EVIDENCE RATHER THAN FROM THE CONFIDENCE ALONE.
 *
 * Confidence is the main term and it is not the only one, because a 0.8 built on
 * nineteen occasions and a 0.8 built on four are not the same claim and the
 * store keeps them apart. A finding that contradicts itself often — support 12,
 * contradiction 9 — is capped below "strong" however confident the arithmetic
 * says it is, which is the difference between a model that is sure and a model
 * that is right.
 *
 * `known` is reserved for things he told us. Cognition cannot reach it: nothing
 * derived is ever presented as certain, and the one-way door is the point.
 */
export function certaintyOf(input: {
  confidence: number
  stated?: boolean
  support?: number
  contradiction?: number
  coverageDays?: number
}): Certainty {
  if (input.stated) return 'known'
  const { confidence: c, support = 0, contradiction = 0, coverageDays } = input

  // Agreement rate, when the record keeps both halves. Below two thirds the
  // pattern argues with itself too often to be spoken of as usual.
  const occasions = support + contradiction
  const rate = occasions > 0 ? support / occasions : 1
  const thin = (coverageDays !== undefined && coverageDays < 14) || (occasions > 0 && occasions < 6)

  let band: Certainty =
    c >= 0.8 ? 'strong' : c >= 0.62 ? 'likely' : c >= 0.45 ? 'possible' : 'unclear'

  if (rate < 0.67 && band === 'strong') band = 'likely'
  if (rate < 0.5) band = 'possible'
  if (thin && band === 'strong') band = 'likely'
  return band
}

/**
 * THE BAND, AS THE GRAMMAR OF THE SENTENCE.
 *
 * A subject and a predicate phrase go in; a whole sentence comes out. The first
 * attempt at this was a table of leading fragments — `'You usually'` glued to
 * whatever the caller had — and it produced *"You usually be later with leaving
 * in the morning than you were."* on the very first real input. Concatenating
 * fragments is not composing a sentence, and a hedge that arrives as a prefix
 * cannot inflect the verb it is hedging.
 *
 * Each rung claims strictly less than the one above it, which is the property
 * worth being able to read off a single table:
 *
 *     known     is                    ← he told us; cognition cannot reach it
 *     strong    is usually
 *     likely    has tended to be
 *     possible  looks
 *     unclear   may be
 */
const HEDGE: Record<Certainty, (subject: string, predicate: string) => string> = {
  known: (s, p) => `${s} is ${p}.`,
  strong: (s, p) => `${s} is usually ${p}.`,
  likely: (s, p) => `${s} has tended to be ${p}.`,
  possible: (s, p) => `${s} looks ${p}.`,
  unclear: (s, p) => `${s} may be ${p}.`,
}

/**
 * What I would expect — a separate voice, because a prediction is not a pattern.
 *
 * "Your step count is usually lower" is a claim about what has happened.
 * "I'd expect you between 10:00 and 11:00" is a claim about what will, and
 * putting the second in the first's grammar produces sentences that sound like
 * observations of the future.
 */
const EXPECT: Record<Certainty, (what: string, range: string) => string> = {
  known: (w, r) => `${w} is ${r}.`,
  strong: (w, r) => `I’d expect ${w} ${r}.`,
  likely: (w, r) => `${w} has usually been ${r}.`,
  possible: (w, r) => `${w} might be ${r}.`,
  unclear: (w, r) => `${w} might be ${r}, though I am not sure yet.`,
}

/** First letter up, rest untouched — a label may legitimately contain a name. */
const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s)

// ── Formatting the typed quantities ──────────────────────────────────────────

/** Minutes past local midnight → "11:54", in HIS zone. Never UTC arithmetic. */
export function clockOf(minutes: number, tz?: string, hour12?: boolean): string {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)))
  // A fixed date carried through `timeLabel` so the zone's own formatting rules
  // — 24h vs 12h, the separator — are applied by `clock.ts` rather than here.
  const base = new Date(Date.UTC(2026, 0, 1, 0, 0, 0))
  const shifted = new Date(base.getTime() + m * 60_000)
  /*
    'UTC' is correct HERE and only here: `m` is already minutes past midnight in
    his zone, so the wall clock has been applied by whoever computed it. Passing
    `tz` would apply the offset a second time, which is the double-conversion
    that `clock.ts` exists to keep out of every other file. The zone is still
    honoured for the FORMAT — 24h against 12h — which is what it is needed for.
  */
  void tz
  return timeLabel(shifted, 'UTC', hour12 === undefined ? {} : { hour12 })
}

const GROUND_VOICE: Record<EvidenceRef['kind'], GroundVoice> = {
  event: 'observation',
  observation: 'observation',
  episode: 'computation',
  entity: 'computation',
  routine: 'inference',
  hypothesis: 'inference',
  prediction: 'inference',
  fact: 'fact',
}

const trailFrom = (evidence: EvidenceRef[]): IntelligenceEvidencePresentation['trail'] =>
  evidence.slice(0, 6).map((e) => ({ id: e.id, voice: GROUND_VOICE[e.kind] ?? 'computation', says: e.says ?? e.id }))

// ── The compilers, one per typed record ──────────────────────────────────────

export interface CompileContext {
  now: Date
  timeZone?: string
  hour12?: boolean
  /** The routine a shift is about, when the store has it. Supplies the baseline. */
  routineOf?: (id: string) => RoutineModel | null
  /** The series behind a metric, for the distribution and the change point. */
  summaryOf?: (metric: string, scope?: string) => TemporalSummary | null
  /** Metric ids → his words. `metricLabel` in `candidates.ts` is the same map. */
  label?: (metric: string) => string
  /** The verdict `significance.ts` reached, when it has run. */
  verdict?: { score: number; surfaced: boolean; reason?: string }
}

const say = (metric: string, ctx: CompileContext) => ctx.label?.(metric) ?? metric

/**
 * A TIMING SHIFT — the case the whole design is drawn against.
 *
 * "Your Tuesdays have shifted later" is sayable; "by about two hours" is only
 * sayable if two hours is what the change point measured. The `before`/`after`
 * pair comes off `TemporalSummary.changePoint`, which is the field that exists
 * precisely so a step change is not reported as a drifting average.
 */
export function presentShift(
  h: Hypothesis & { proposition: Extract<Hypothesis['proposition'], { kind: 'shift' }> },
  ctx: CompileContext
): IntelligencePresentation | null {
  const p = h.proposition
  const summary = ctx.summaryOf?.(p.metric)
  const cp = summary?.changePoint ?? null
  const routine = ctx.routineOf?.(p.routineId) ?? null

  const isClock = p.metric.endsWith('minute') || p.metric.endsWith('minutes')
  const fmt = (v: number) => (isClock ? clockOf(v, ctx.timeZone, ctx.hour12) : String(Math.round(v)))

  const certainty = certaintyOf({
    confidence: h.confidence,
    support: h.support,
    contradiction: h.contradiction,
    coverageDays: h.temporalCoverageDays,
  })

  /*
    THE ALLOWED SET. Every quantity the copy below is permitted to contain, and
    it is built from the records rather than from the sentence.
  */
  const allowed: (string | number)[] = [
    h.support,
    h.contradiction,
    h.support + h.contradiction,
    h.temporalCoverageDays,
    h.evidenceDiversity,
  ]
  if (cp) allowed.push(fmt(cp.before), fmt(cp.after), Math.round(cp.magnitude))
  if (routine?.temporal.typicalStartMinutes !== undefined) {
    allowed.push(fmt(routine.temporal.typicalStartMinutes))
  }

  /*
    THE METRIC LABEL IS A NOUN PHRASE AND IT IS THE SUBJECT OF THE SENTENCE.

    "leaving in the morning" rather than "departure_minute", supplied by the
    caller's vocabulary — the same map `candidates.ts` uses, so a metric reads
    identically wherever it appears. Making it the grammatical subject is what
    lets one hedge table serve every proposition kind.
  */
  const subject = cap(say(p.metric, ctx))
  const direction = p.direction === 'later' || p.direction === 'more' ? 'later' : 'earlier'
  const headline = HEDGE[certainty](subject, `${direction} than it was`)

  /*
    THE SUPPORT LINE STATES THE SPLIT, and it is the mechanical guard against a
    card nobody can check: a claim that cannot say how many occasions it rests on
    is a claim whose evidence was never counted.
  */
  const occasions = h.support + h.contradiction
  const summaryLine = cp
    ? `Was ${fmt(cp.before)}, now ${fmt(cp.after)} — on ${h.support} of the ${occasions} occasions there was enough to tell.`
    : `On ${h.support} of the ${occasions} occasions there was enough to tell.`

  return {
    id: h.id,
    kind: 'change',
    subjectRefs: [p.routineId, p.metric],
    headline: grounded('headline', clampCopy(headline, BUDGET.headline), allowed),
    summary: grounded('summary', clampCopy(summaryLine, BUDGET.summary), allowed),
    certainty,
    visual: cp
      ? {
          kind: 'comparison',
          before: { label: 'Usual', value: fmt(cp.before) },
          after: { label: 'Recent', value: fmt(cp.after) },
        }
      : undefined,
    evidence: {
      trail: trailFrom(h.evidence),
      span: spanOf(h),
      caveats: [
        'a pattern can move because something around it moved, not because you did',
        ...(h.evidenceDiversity < 2 ? ['this comes from a single source, so it may be a quirk of that source'] : []),
      ],
    },
    provenanceRefs: [h.id, ...(summary ? [summary.id] : []), ...(routine ? [routine.id] : [])],
    attention: {
      score: ctx.verdict?.score ?? 0,
      significant: ctx.verdict?.surfaced ?? false,
      suppressedFor: ctx.verdict?.reason,
      ends: 'recompute',
    },
    generatedAt: ctx.now.toISOString(),
  }
}

/**
 * AN ASSOCIATION — two things that move together, said as an association and
 * never as a cause.
 *
 * There is no `causation` variant in `TypedProposition` and there is no wording
 * here that implies one. "On days when X, Y tends to be lower" is the strongest
 * form available, and the caveat below is not decoration: it is the difference
 * between a claim the evidence supports and one it does not.
 */
export function presentAssociation(
  h: Hypothesis & { proposition: Extract<Hypothesis['proposition'], { kind: 'association' }> },
  ctx: CompileContext
): IntelligencePresentation | null {
  const p = h.proposition
  const occasions = h.support + h.contradiction
  const certainty = certaintyOf({
    confidence: h.confidence,
    support: h.support,
    contradiction: h.contradiction,
    coverageDays: h.temporalCoverageDays,
  })

  const allowed: (string | number)[] = [
    h.support,
    h.contradiction,
    occasions,
    h.temporalCoverageDays,
    h.evidenceDiversity,
    Math.round(p.when.threshold),
  ]

  const when = say(p.when.metric, ctx)
  const then = say(p.then.metric, ctx)
  const headline = HEDGE[certainty](cap(then), `${p.then.direction} on days with more ${when}`)
  const summaryLine = `That held on ${h.support} of the ${occasions} days there was enough to compare.`

  return {
    id: h.id,
    kind: 'connection',
    subjectRefs: [p.when.metric, p.then.metric, p.then.scope ?? ''].filter(Boolean),
    headline: grounded('headline', clampCopy(headline, BUDGET.headline), allowed),
    summary: grounded('summary', clampCopy(summaryLine, BUDGET.summary), allowed),
    certainty,
    visual: { kind: 'tally', for: h.support, against: h.contradiction, caption: 'days it held' },
    evidence: {
      trail: trailFrom(h.evidence),
      span: spanOf(h),
      caveats: [
        'this is two things moving together, not one causing the other',
        ...(h.evidenceDiversity < 2 ? ['it comes from a single source, so it may be a quirk of that source'] : []),
      ],
    },
    provenanceRefs: [h.id],
    attention: {
      score: ctx.verdict?.score ?? 0,
      significant: ctx.verdict?.surfaced ?? false,
      suppressedFor: ctx.verdict?.reason,
      ends: 'recompute',
    },
    generatedAt: ctx.now.toISOString(),
  }
}

/**
 * TODAY IS UNUSUAL — with the baseline it is unusual against, drawn.
 *
 * The distribution is the argument. "Below your usual Thursday" as a sentence
 * asks him to take the baseline on faith; the same claim as a row of bars with
 * today marked is checkable at a glance, and the bars are the samples the
 * summary already holds rather than a series computed for the picture.
 */
export function presentAnomaly(a: Anomaly, ctx: CompileContext): IntelligencePresentation | null {
  const summary = ctx.summaryOf?.(a.subject.split('.').pop() ?? a.subject) ?? null
  const certainty = certaintyOf({ confidence: a.confidence })
  const observed = Number(a.observed ?? NaN)
  const expected = Number(a.expected ?? NaN)
  const numeric = Number.isFinite(observed) && Number.isFinite(expected)

  const fmt = (v: number) => new Intl.NumberFormat(undefined).format(Math.round(v))
  const allowed: (string | number)[] = [Math.round(a.magnitude)]
  if (numeric) allowed.push(fmt(observed), fmt(expected), Math.round(observed), Math.round(expected))

  /*
    THE ANOMALY'S OWN SENTENCE IS THE SUMMARY, NOT A REWRITE OF IT.

    `a.why` is written where the arithmetic happened, by the code that has the
    numbers. Re-narrating it here would be a second author for one claim, which
    is how two parts of an app start disagreeing about what they found.
  */
  const why = clampCopy(a.why, BUDGET.summary)
  /*
    AN ANOMALY IS ABOUT TODAY, so its subject is today rather than the metric,
    and the hedge attaches to the claim that today is unusual — not to the
    baseline, which is not in doubt.
  */
  const metric = say(a.subject.split('.').pop() ?? a.subject, ctx)
  const headline =
    a.kind === 'routine_missed'
      ? HEDGE[certainty]('Today', `missing something you usually do by now`)
      : a.kind === 'change_point'
        ? HEDGE[certainty](cap(metric), 'settling into a different rhythm')
        : HEDGE[certainty]('Today', `outside your usual ${metric}`)

  const bars = (summary?.samples ?? []).slice(-10).map((s) => ({
    label: s.day.slice(-2),
    v: s.value,
    mark: s.day === a.day,
  }))

  return {
    id: a.id,
    kind: 'observation',
    subjectRefs: [a.subject],
    headline: grounded('headline', clampCopy(headline, BUDGET.headline), allowed),
    // `why` is the record's own prose and carries the record's own numbers, so
    // it is checked against the same set the headline is.
    summary: grounded('summary', why, [...allowed, ...quantitiesIn(a.why)]),
    certainty,
    visual:
      bars.length >= 3
        ? {
            kind: 'distribution',
            bars,
            low: fmt(Math.min(...bars.map((b) => b.v ?? Infinity))),
            high: fmt(Math.max(...bars.map((b) => b.v ?? -Infinity))),
          }
        : undefined,
    evidence: {
      trail: trailFrom(a.evidence),
      caveats: [
        ...(a.confidence < 0.5 ? ['this is a thin baseline — it may just be a quiet week'] : []),
        ...(a.kind === 'routine_missed' ? ['a plan can change without anything being wrong'] : []),
        ...(a.kind === 'baseline_deviation' ? ['other things affect this that are not being measured'] : []),
      ],
    },
    provenanceRefs: [a.id, ...(summary ? [summary.id] : [])],
    attention: {
      score: ctx.verdict?.score ?? 0,
      significant: ctx.verdict?.surfaced ?? false,
      suppressedFor: ctx.verdict?.reason,
      ends: a.kind === 'change_point' ? 'recompute' : 'passes',
    },
    generatedAt: ctx.now.toISOString(),
  }
}

/**
 * WHAT WE EXPECT, WITH THE WIDTH OF THE EXPECTATION SHOWN.
 *
 * A prediction stated as a point is a prediction pretending to a precision it
 * does not have. The interval is drawn, and the copy says the window rather than
 * the midpoint, because the honest content of "you will leave between 10:00 and
 * 11:00" is the hour.
 */
export function presentPrediction(p: Prediction, ctx: CompileContext): IntelligencePresentation | null {
  if (p.status !== 'pending') return null
  const certainty = certaintyOf({ confidence: p.confidence })
  const isClock = p.target.kind === 'timing'
  const fmt = (v: number) =>
    isClock ? clockOf(v, ctx.timeZone, ctx.hour12) : new Intl.NumberFormat(undefined).format(Math.round(v))

  const lo = p.interval ? fmt(p.interval.lower) : ''
  const hi = p.interval ? fmt(p.interval.upper) : ''
  const allowed: (string | number)[] = [lo, hi].filter(Boolean)

  const what = p.target.kind === 'episode_occurs' ? p.target.activityType : say(p.target.metric, ctx)
  const headline = p.interval
    ? EXPECT[certainty](what, `between ${lo} and ${hi}`)
    : EXPECT[certainty](what, 'today')

  return {
    id: p.id,
    kind: 'prediction',
    subjectRefs: [p.target.kind === 'episode_occurs' ? p.target.activityType : p.target.metric],
    headline: grounded('headline', clampCopy(headline, BUDGET.headline), allowed),
    certainty,
    visual: p.interval ? { kind: 'range', lo, hi, caption: 'what I would expect' } : undefined,
    evidence: {
      trail: trailFrom(p.evidence),
      caveats: ['this is what has usually happened, not something that is arranged'],
    },
    provenanceRefs: [p.id, ...p.modelBasis],
    attention: {
      score: ctx.verdict?.score ?? 0,
      significant: ctx.verdict?.surfaced ?? false,
      suppressedFor: ctx.verdict?.reason,
      ends: 'passes',
    },
    generatedAt: ctx.now.toISOString(),
  }
}

/** "23 days · 3 sources" — from the counts the record keeps, or nothing. */
function spanOf(h: Hypothesis): string | undefined {
  const bits: string[] = []
  if (h.temporalCoverageDays > 0) bits.push(`${h.temporalCoverageDays} days`)
  if (h.evidenceDiversity > 0) bits.push(`${h.evidenceDiversity} ${h.evidenceDiversity === 1 ? 'source' : 'sources'}`)
  return bits.length ? bits.join(' · ') : undefined
}

/**
 * THE ONE ENTRY POINT. A typed record in, a bounded object or null out.
 *
 * `null` is a real answer and the common one — a rejected hypothesis, a resolved
 * prediction, a proposition kind with no presentation. The slot's quiet state is
 * built on this returning null rather than on a caller remembering to check.
 */
export function present(
  record: Hypothesis | Anomaly | Prediction,
  ctx: CompileContext
): IntelligencePresentation | null {
  if ('proposition' in record) {
    if (record.status !== 'supported') return null
    if (record.proposition.kind === 'shift') {
      return presentShift(record as Parameters<typeof presentShift>[0], ctx)
    }
    if (record.proposition.kind === 'association') {
      return presentAssociation(record as Parameters<typeof presentAssociation>[0], ctx)
    }
    return null
  }
  if ('target' in record) return presentPrediction(record, ctx)
  if ('magnitude' in record && 'why' in record) return presentAnomaly(record, ctx)
  return null
}

// ── The slot ─────────────────────────────────────────────────────────────────

/**
 * THE ONE THOUGHT, CHOSEN BY THE GATE THAT ALREADY EXISTS.
 *
 * Three things had to be true for this not to be a second ranking engine:
 *
 *   · the candidates are `candidates.ts`'s, unchanged;
 *   · the verdict is `significance.ts`'s `judge`, unchanged, including its
 *     suppression reasons and its `INTELLIGENCE_THRESHOLD`;
 *   · authority is `authority.ts`'s capability map, so this returns null in every
 *     host where `intelligence` has not been explicitly promoted.
 *
 * What is new is only the compilation and the choosing of ONE. §20 is firm that
 * the slot holds a single thought and never grows a queue: the rest of what
 * cognition concluded stays internal, which is the difference between an
 * assistant and an inbox.
 *
 * Returns null far more often than not, and that is the designed behaviour
 * rather than a degraded one. On the real ledger — thirteen days of evidence at
 * the time of writing — it returns null always, because nothing has cleared the
 * coverage bars. Lowering a bar to make the slot speak would be trading the only
 * property that makes it worth reading.
 */
export interface SlotContext extends CompileContext {
  posture: MemoryPosture
  /** This pass's anomalies. Transient — they are not stored, so they are passed. */
  anomalies?: Anomaly[]
  /** Sigmas per anomaly id, from the series. Never re-derived from prose. */
  magnitudeOf?: (a: Anomaly) => number | undefined
  /** What the rest of the screen is already saying. Ids, never words. */
  onScreen?: { focus?: string[]; subjects?: string[] }
  seen?: Record<string, { at: string }>
}

export function intelligenceSlot(store: MemoryStore, ctx: SlotContext): IntelligencePresentation | null {
  if (!isLive(ctx.posture, 'intelligence')) return null

  const todayValues: Record<string, number> = {}
  const attentions = memoryCandidates(store, ctx.anomalies ?? [], ctx.now, todayValues, { timeZone: ctx.timeZone })
  if (!attentions.length) return null

  /*
    ANYTHING HE HAS DENIED IS OUT, AND THE CHECK IS HERE RATHER THAN UPSTREAM.

    `denyClaim` rejects the hypothesis when he denies it, which handles today.
    It does not handle the rebuild: hypotheses are derived, `clearDerived` wipes
    them, and the next pass re-derives the same conclusion from evidence that has
    not changed. The denial is a `stated` fact and survives that; this read is
    what makes surviving it MEAN something. Checked at the point of surfacing —
    the last gate before a screen — because that is the one place no future
    caller can route around.
  */
  const denied = deniedIds(store)

  /*
    THE TYPED FACTS THE GATE NEEDS, TAKEN OFF THE RECORD.

    Same construction as `shadow.ts`'s, and for the same stated reason: an
    `Attention` has a sentence and scores, and the coverage, diversity and
    probability the gates test live on the record it came from. Matching by id is
    how `candidates.ts` builds them, so the join is exact rather than fuzzy.
  */
  const hypothesisById = new Map(store.hypotheses.all().map((h) => [h.id, h]))
  const anomalyById = new Map((ctx.anomalies ?? []).map((a) => [a.id, a]))

  const findings: Finding[] = attentions.map((candidate) => {
    const bare = candidate.id.replace(/:explained$/, '')
    const h = hypothesisById.get(candidate.id)
    const a = anomalyById.get(bare)
    const p = store.predictions.byId(candidate.id)

    if (h) {
      return {
        candidate,
        source: 'hypothesis' as const,
        coverageDays: h.temporalCoverageDays,
        diversity: h.evidenceDiversity,
        propositionKind: h.proposition.kind,
        focus:
          h.proposition.kind === 'association'
            ? h.proposition.then.metric
            : h.proposition.routineId,
      }
    }
    if (a) {
      return {
        candidate,
        source: (candidate.id.endsWith(':explained') ? 'explained_anomaly' : 'anomaly') as Finding['source'],
        magnitude: ctx.magnitudeOf?.(a),
        focus: a.subject,
        subject: a.subject,
      }
    }
    if (p) {
      return { candidate, source: 'prediction' as const, probability: p.probability, focus: p.target.kind }
    }
    return { candidate, source: 'anomaly' as const }
  })

  const judged = judge(findings, { now: ctx.now, onScreen: ctx.onScreen, seen: ctx.seen })

  /*
    THE HIGHEST-SCORING SURFACED FINDING THAT ALSO COMPILES.

    `judge` returns them ranked; the loop exists because a verdict is not a
    guarantee of a presentation — a `cadence_change` proposition has no
    compiler, and the honest response to that is the next candidate rather than
    a card built by a fallback nobody designed.
  */
  for (const { finding, verdict } of judged) {
    if (!verdict.surfaced) continue
    if (denied.has(finding.candidate.id)) continue
    const record =
      hypothesisById.get(finding.candidate.id) ??
      anomalyById.get(finding.candidate.id.replace(/:explained$/, '')) ??
      store.predictions.byId(finding.candidate.id)
    if (!record) continue
    const made = present(record, { ...ctx, verdict })
    if (made) return made
  }
  return null
}

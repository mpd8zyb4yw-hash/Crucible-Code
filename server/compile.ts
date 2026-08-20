import { sourceCatalogue } from './execute.js'
import { classify, sanitisePlan, unknownOps, IR_VERSION, type Plan, type PlanClass } from './ir.js'
import { route } from './router.js'
import { parseLoose } from './think.js'
import { WIDGET_KINDS } from './widgets.js'

/**
 * His words to a plan.
 *
 * This is the piece the whole IR was designed around and the one that was
 * missing: until now a plan had to ARRIVE from somewhere, which in practice
 * meant a client hand-writing JSON, which meant the pane layer could only ever
 * be driven by a programmer. The compiler is what makes "videos I'd like
 * tonight, nothing longer than twenty minutes" a thing he can say.
 *
 * Three properties matter more than the prompt does:
 *
 *   1. It compiles ONCE. The plan is stored, and every later refresh re-executes
 *      it without a model. That is the entire economic argument for having an IR
 *      instead of asking the model afresh each time, and it only holds if this
 *      function is called on the way IN and never on the way out.
 *
 *   2. Its output is untrusted. The model is a JSON generator pointed at a
 *      schema, not an authority: everything it emits goes through
 *      `sanitisePlan`, which rebuilds every field and — crucially — has no
 *      vocabulary for a URL, a credential or an action. A compiled plan cannot
 *      send mail no matter what the instruction said, because there is no node
 *      that sends mail. Prompt injection reaching this function through, say,
 *      the text of an email can therefore only ever produce a bad QUERY.
 *
 *   3. It refuses rather than guesses. A source that is not connected is not
 *      described to it, so a plan naming one is a compiler bug rather than a
 *      user error — and when the instruction genuinely cannot be expressed, the
 *      unexpressed part comes back in `unresolved` instead of being dropped on
 *      the floor and returning something plausible.
 */

export interface Compilation {
  plan: Plan
  planClass: PlanClass
  /** Which model wrote it. Stored with the pane so a bad plan is attributable. */
  compiledBy: { providerId: string; model: string }
  /** Providers stepped over on the way. Surfaced, never hidden. */
  fellBackFrom: string[]
  /** Ops this build cannot execute — the plan keeps them, we say so. */
  unknown: string[]
  /** Parts of the instruction the model could not express. His words back. */
  unresolved: string[]
}

const SYSTEM = `You compile a person's instruction into a QUERY PLAN over typed objects.

You are a compiler, not an assistant. You return JSON and nothing else — no
prose, no explanation, no markdown fence. You never answer the instruction
yourself; you describe how the server should answer it.

THE PLAN IS EXECUTED WITHOUT YOU. It is stored and re-run on a schedule, months
from now, with no model in the loop. So it must be a description of the WORK,
not of today's answer: never bake in a result you happen to know, never write a
date you computed as a literal when a relative range is what was meant, and
never name an item you have not been told exists.

You cannot cause anything to happen. There is no node that sends, replies,
books, buys, archives or deletes, and there is no way to write one. If the
instruction asks for an action, compile the READING half of it — the pane that
would let him do it himself — and put the action part in "unresolved".

If part of the instruction cannot be expressed with the nodes below, put that
part in "unresolved" IN HIS WORDS. Never silently drop it. A plan that quietly
loses "and none of the ones you showed me yesterday" returns something that
looks right and is not, and nobody ever finds out.`

/** The IR, written for a model. Generated where it can be, so it cannot rot. */
function grammar(): string {
  return `NODES — an ordered list; each one transforms the stream of objects the
last one produced.

  {"op":"source","source":<id>,"via":<route>,"params":{…}}
      Fetch. The ONLY node that goes to the network for new things.
  {"op":"objects","sources":[…],"kinds":[…],"text":"…","where":{…},"seenWithinMs":n}
      Read what is already known, without the network. Cheaper and always
      available — prefer it when the instruction is about things he has already
      seen ("the videos you showed me", "that email from Chase").
  {"op":"filter","where":{field:value},"text":"substring","range":{"field":f,"min":…,"max":…},"freshOnly":bool,"not":bool}
      Mechanical predicates only. No judgement. "not":true inverts the whole node.
  {"op":"sort","by":<field>,"dir":"asc"|"desc"}      by a FIELD, never by an opinion
  {"op":"limit","n":<1-200>}
  {"op":"dedupe","by":<field>}                       one per channel, one per thread
  {"op":"join","right":[<nodes>],"on":{"left":f,"right":f},"how":"inner"|"left","as":<field>}
      Relate the stream to a second plan. One level deep only.
  {"op":"enrich","source":<id>,"via":<route>,"by":<field>,"params":{…}}
      Fetch MORE about objects you already have. Never replaces what is known.
  {"op":"rank","by":"<the criterion, in his words>","max":n}
      Ordering by JUDGEMENT. Costs a model call on every run — use it when the
      instruction is a matter of taste ("best", "worth my evening"), and use
      "sort" when it is a matter of fact ("newest", "shortest").
  {"op":"extract","what":"…","kind":<kind>,"as":<source id>}
      Derive NEW objects from the content of existing ones ("the restaurants
      named in these emails"). Also costs a model call every run.
  {"op":"present","widget":<one of ${WIDGET_KINDS.join('|')}>,"title":"…","columns":1|2,"empty":"…"}
      A hint about how it should look. Put it last. "media" for anything with
      pictures, "agenda" for anything on a timeline, "list" otherwise.

REFRESH — how often re-running is worth it, as a property of the QUERY:
  {"mode":"manual"}                         a question about a fixed past
  {"mode":"on-open"}                        answer changes, he wants it current
  {"mode":"interval","everyMs":n}           at least 60000; be frugal
  {"mode":"on-change","watch":{<objects node>}}   when matching things appear

FIELDS every object has: id, title, sub, body, at, kind, source. Anything else
depends on the source and is addressed by name.`
}

/** What is actually connected, right now. Never a hard-coded list. */
function catalogue(): string {
  const cat = sourceCatalogue()
  if (!cat.length) {
    return `SOURCES: none are connected. You can still compile plans over
"objects" — what is already known — but any plan naming a "source" will fail,
so do not write one.`
  }
  return [
    'SOURCES CONNECTED RIGHT NOW. A plan may name these and nothing else.',
    ...cat.map((c) => {
      const head = `- ${c.source}${c.what ? ` — ${c.what}` : ''}${c.kinds.length ? ` (yields ${c.kinds.join(', ')})` : ''}`
      const routes = c.routes.map((r) => {
        const cost = c.cost[r] ? ` [costs ${c.cost[r]}]` : ''
        return `    via "${r}"${cost}${c.notes[r] ? ` — ${c.notes[r]}` : ''}`
      })
      return [head, ...routes].join('\n')
    }),
  ].join('\n')
}

const SHAPE = `{
  "intent": "<his instruction, verbatim>",
  "nodes": [ … ],
  "refresh": { "mode": … },
  "unresolved": [ "<any part you could not express, in his words>" ]
}`

/**
 * The compiler's untrusted-input boundary, on its own so it can be exercised
 * without a provider key.
 *
 * One thing happens here that `sanitisePlan` alone does not do, and it is the
 * reason this is not just a call to it: HIS WORDS OVERRIDE THE MODEL'S. A plan
 * arriving from a client legitimately carries its own intent, so `sanitisePlan`
 * keeps what it is given; a plan arriving from a compiler does not, because the
 * intent is the thing that gets re-compiled when the plan turns out to have
 * missed the point, and it is worth nothing if it is the model's paraphrase of
 * what he said rather than what he said.
 */
export function acceptPlan(raw: unknown, words: string): Plan | null {
  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return sanitisePlan({ ...base, intent: words, irVersion: IR_VERSION }, words)
}

export interface CompileOptions {
  /**
   * The plan being revised, when this is a refinement rather than a new pane.
   *
   * Given, the model is compiling a CHANGE — "actually, three from 60 Minutes
   * instead" is meaningless without knowing what "these" were. Withheld, it is
   * compiling from nothing, which is the right reading of a fresh instruction
   * and the wrong reading of a follow-up.
   */
  from?: Plan
  /** Anything the caller knows that his words assume. Kept short on purpose. */
  context?: string
  now?: number
}

export async function compile(instruction: string, opts: CompileOptions = {}): Promise<Compilation> {
  const words = instruction.trim()
  if (!words) throw new Error('Nothing to compile.')

  const now = new Date(opts.now ?? Date.now())
  const prompt = [
    grammar(),
    catalogue(),
    opts.from
      ? `HE IS CHANGING AN EXISTING PANE. This is its current plan — return the
WHOLE new plan, not a diff, and keep everything he did not ask you to change:
${JSON.stringify({ intent: opts.from.intent, nodes: opts.from.nodes, refresh: opts.from.refresh }, null, 1)}`
      : '',
    opts.context ? `CONTEXT:\n${opts.context}` : '',
    // The clock, spelled out, because "tonight" and "this week" are the two
    // most common things in an instruction and a model with no date will
    // compile them into a literal range that is wrong by the next refresh.
    `It is currently ${now.toString().replace(/ \(.*\)$/, '')}. Relative words like
"tonight", "this week" or "recently" must compile to a RELATIVE range or a
source parameter, never to today's dates as literals — the plan outlives today.`,
    `HE SAID:\n${words}`,
    `Return JSON in exactly this shape, and nothing else:\n${SHAPE}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  const out = await route('compile', { system: SYSTEM, prompt, json: true, maxTokens: 2048 })

  let raw: unknown
  try {
    raw = parseLoose(out.text)
  } catch {
    throw new Error('I understood you, but I couldn’t turn it into something I can run.')
  }

  const plan = acceptPlan(raw, words)
  if (!plan) throw new Error('I couldn’t turn that into a plan I can run.')

  return {
    plan,
    planClass: classify(plan),
    compiledBy: { providerId: out.providerId, model: out.model },
    fellBackFrom: out.fellBackFrom,
    unknown: unknownOps(plan),
    unresolved: plan.unresolved ?? [],
  }
}

/**
 * A plan for the instruction, without a model, when a connector claims it.
 *
 * Not a parser and deliberately not clever. It matches his words against the
 * shortcuts each registered adapter declared for itself and returns the first
 * unambiguous one; everything else returns null and goes to the model. It never
 * returns an approximation — a free wrong answer is worth less than a paid
 * right one.
 *
 * There is no connector name in this function, and that is the requirement
 * rather than an aesthetic. `youtube`, `gmail` and `calendar` appear nowhere in
 * the general layer; a table of their phrases here would put them back, and the
 * next connector would arrive to find its vocabulary had to be added to the
 * compiler rather than to itself.
 *
 * A tie is refused rather than broken. If two connectors both claim an
 * instruction, neither is obviously right, and the model is exactly the thing
 * that should decide.
 */
export function compileLocally(instruction: string): Plan | null {
  const words = instruction.trim()
  const t = normalise(words)
  const hits: { nodes: ReturnType<typeof nodesOf>; refresh: Plan['refresh'] }[] = []

  for (const c of sourceCatalogue()) {
    for (const s of c.shortcuts) {
      if (!s.when.some((w) => t.includes(w))) continue
      if (s.unless?.some((w) => t.includes(w))) continue
      const nodes = nodesOf(s, words)
      if (nodes.length) hits.push({ nodes, refresh: s.refresh ?? { mode: 'on-open' } })
    }
  }

  if (hits.length !== 1) return null
  return { irVersion: IR_VERSION, intent: words, nodes: hits[0]!.nodes, refresh: hits[0]!.refresh }
}

/**
 * Lowercase, and the typographic apostrophe folded to the typed one.
 *
 * Not a nicety. Every iOS keyboard turns "what's" into "what’s" as you type,
 * which is the form nearly every instruction actually arrives in — and a
 * shortcut written with the ASCII apostrophe would silently never match it.
 * The failure mode is the expensive kind: the shortcut does not fire, the model
 * compiles the same thing correctly, and nobody notices that the free path is
 * dead until the day the free tier runs out.
 */
const normalise = (s: string): string => s.toLowerCase().replace(/[‘’ʼ]/g, "'")

/** A shortcut that throws declines, rather than taking the compiler down. */
function nodesOf(s: { nodes(words: string): unknown[] }, words: string) {
  try {
    return (s.nodes(words) ?? []) as Plan['nodes']
  } catch {
    return [] as Plan['nodes']
  }
}

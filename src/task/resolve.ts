/**
 * EXECUTE FIRST. ASK ONLY FOR WHAT GENUINELY BLOCKS EXECUTION.
 *
 * "Show me the route to lunch with Odelia" used to come back as "which
 * restaurant?" while the calendar event naming the address was on the screen
 * two inches above the question. That is not a missing capability, it is a
 * missing order of operations: the system asked before it looked.
 *
 * So a task's inputs are SLOTS, and every slot is filled by walking a fixed
 * ladder in a fixed order. Each rung is cheaper and more certain than asking:
 *
 *   1  the active task's own context     — already established in this exchange
 *   2  canonical domain objects          — the event, the message, the place
 *   3  connected accounts                — calendar, mail, activity
 *   4  saved or user-stated task context — what he told us earlier
 *   5  permitted live location           — only where he has granted it
 *   6  public retrieval                  — the server's job, one rung up from asking
 *   7  ask                               — and only for the SMALLEST blocking unknown
 *
 * Three properties the ladder has to preserve, because losing any one of them
 * turns "helpful" into "confidently wrong":
 *
 * Approximate information stays approximate. "Somewhere near Bellano" resolves
 * to a `candidate` slot, not to a coordinate. It narrows progressively; it never
 * gets promoted to certainty because a later step needed certainty.
 *
 * Several plausible candidates is a question, not a coin toss. Surfacing three
 * and asking which costs one interaction; guessing costs trust.
 *
 * Nothing resolvable is still not a demand for precision. The question asks for
 * whatever he remembers — a name, a rough area, who else was there — rather than
 * an address he has already said he does not have.
 */

export type SlotSource =
  | 'task' | 'object' | 'connector' | 'stated' | 'location' | 'retrieval' | 'user'

/**
 * WHY AN OBJECT IS AVAILABLE TO BE REFERRED TO.
 *
 * The handoff calls this the resolution order and it is the difference between
 * "there", "this" and "it" meaning something and meaning anything. An object he
 * has FOCUSED outranks one he has merely selected, which outranks one that is
 * simply on screen, which outranks something the world model knows about but he
 * cannot see. Ambiguity between two objects at the same rank is a question;
 * ambiguity across ranks is not ambiguity at all.
 *
 * Held as a number so the comparison is `<`, not a chain of ifs that can be
 * reordered by accident.
 */
export type Attention = 'focused' | 'selected' | 'expanded' | 'visible' | 'world'

export const ATTENTION: Record<Attention, number> = {
  focused: 0,
  expanded: 1,
  selected: 2,
  visible: 3,
  world: 4,
}

export type Slot =
  | { status: 'resolved'; value: string; source: SlotSource; ref?: string }
  /** Real information, deliberately not upgraded. Narrows; never guesses. */
  | { status: 'approximate'; value: string; source: SlotSource }
  /** More than one thing fits. The honest answer is to ask which. */
  | { status: 'candidates'; options: { value: string; ref?: string; why: string }[] }
  | { status: 'unresolved' }

export interface TaskSlots {
  [name: string]: Slot
}

export type TaskStatus = 'ready' | 'awaitingClarification'

/**
 * A task, suspended mid-execution because one slot could not be filled.
 *
 * Typed state rather than a sentence in a transcript, and that is the whole
 * difference: a sentence cannot be resumed. Clarification SUSPENDS the original
 * task and his answer updates the slot — it does not start a new task that
 * happens to be about the same thing, and he never has to repeat the original
 * instruction.
 */
export interface SuspendedTask {
  id: string
  /** 'route' | 'search' | 'compose' … — what work this is. */
  kind: string
  /** His words, exactly as he said them. */
  instruction: string
  slots: TaskSlots
  /** Which slot the question is about. Exactly one at a time. */
  blocking: string
  question: string
  status: TaskStatus
  at: string
  /**
   * The day the task is about, when one is known.
   *
   * Set by the caller from the object the task anchored to. It exists so that
   * "7pm", said in answer to "what time does it actually start?", becomes a
   * timestamp on the right day rather than on today. See `interpret`.
   */
  dayHint?: string
}

/**
 * ONE OBJECT THE LADDER MAY READ, with why it is reachable.
 *
 * `at`/`end`/`allDay` are here because a departure time is arithmetic on an
 * event, and an event whose start is unknown must be able to SAY so rather than
 * contributing a start of midnight. See `eventStart` in `resolveSlot`.
 */
export interface KnownObject {
  id: string
  label: string
  sub?: string
  at?: string
  end?: string
  allDay?: boolean
  kind: string
  /** Where in the attention order this sits. Absent means merely visible. */
  rank?: Attention
}

/** Objects the ladder is allowed to read at rungs 2 and 3. */
export interface KnownWorld {
  /** Canonical objects currently on screen or in the feed. */
  objects: KnownObject[]
  /** What he has told us and we kept. */
  stated: Record<string, string>
  /** Live location, only if he has permitted it. */
  location?: { lat: number; lon: number; label?: string } | null
  /**
   * The canonical object the conversation is anchored to — whatever the open
   * card is about. See the ANCHOR rung in `resolveSlot`.
   */
  focus?: string | null
}

/** Slots the anchored object can answer. A route's "where", by any name. */
const PLACE_SLOTS = new Set(['destination', 'to', 'where', 'place'])

/** Slots answered by WHEN the anchored object happens rather than by where. */
const TIME_SLOTS = new Set(['eventStart', 'when', 'start'])

/**
 * WHAT EACH TASK ACTUALLY REQUIRES, declared rather than assembled at the call
 * site.
 *
 * This is §7 of the handoff as data. Before a computation runs, its inputs are
 * named; anything high-impact that cannot be resolved BLOCKS rather than being
 * substituted. The substitutions that were available and are now impossible are
 * worth naming, because each one is a plausible answer that would have been
 * wrong: midnight for a missing start, home for a missing origin, walking for
 * an unknown mode, zero for a buffer.
 *
 * Two inputs are deliberately NOT here. `routeDuration` is computed, not asked —
 * a person cannot answer it and the server can. `buffer` has a declared product
 * default (see `server/leaveby.ts`), which is the one exemption §7 allows and
 * the reason it says "unless explicitly defined as a safe product default".
 */
export const TASK_SLOTS: Record<string, string[]> = {
  route: ['destination'],
  leaveBy: ['destination', 'eventStart', 'origin', 'transportMode'],
  search: [],
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

/** Words in the instruction that could name an object. Cheap, and deliberately so. */
function terms(instruction: string): string[] {
  return norm(instruction)
    .split(' ')
    .filter((w) => w.length > 2 && !STOP.has(w))
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'show', 'route', 'get', 'take', 'how', 'long', 'what',
  'when', 'where', 'who', 'why', 'that', 'this', 'are', 'was', 'you', 'your', 'can', 'give',
  'lunch', 'dinner', 'meeting', 'about', 'find', 'please', 'tell',
])

/**
 * Rungs 1–5, in order, for one slot.
 *
 * Stops at the first rung that answers, which is what makes the order load
 * bearing: a canonical object beats a connector guess, and both beat asking.
 * Rungs 6 and 7 are not here — retrieval belongs to the server, and asking is
 * what happens when this returns `unresolved`.
 */
export function resolveSlot(
  name: string,
  instruction: string,
  world: KnownWorld,
  active: TaskSlots = {},
): Slot {
  // 1. Already established in this exchange. A slot he has just answered must
  //    never be re-derived — that is what makes a clarification stick.
  const fromTask = active[name]
  if (fromTask && fromTask.status !== 'unresolved') return fromTask

  /*
    2. EXPLICITLY NAMED. Highest of the observable rungs, because "route to
       Avano" said in front of the Odelia card still means Avano.

       Ambiguity is resolved by ATTENTION before it is treated as ambiguity:
       two events both matching "lunch" where one is focused is not a question,
       it is the focused one. Only a tie at the same rank AND the same score is
       genuinely ambiguous.
  */
  /*
    ONLY SLOTS AN OBJECT COULD ANSWER LOOK AT OBJECTS.

    A calendar event's location is where he is GOING. Matching it against
    `origin` — which was possible when this rung ran for every slot name — would
    answer "where are you setting off from" with the destination, which is both
    wrong and self-consistent enough to look right.
  */
  const objectAnswerable = PLACE_SLOTS.has(name) || TIME_SLOTS.has(name)

  const want = objectAnswerable ? terms(instruction) : []
  if (want.length) {
    const hits = world.objects
      .map((o) => {
        const hay = norm(`${o.label} ${o.sub ?? ''}`)
        const score = want.filter((w) => hay.includes(w)).length
        return { o, score, rank: ATTENTION[rankOf(o, world)] }
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.rank - b.rank)

    if (hits.length) {
      const top = hits[0]!
      const tied = hits.filter((h) => h.score === top.score && h.rank === top.rank)
      if (tied.length === 1) {
        const answer = valueOf(top.o, name)
        if (answer) return answer
        // The object was identified but cannot answer THIS slot — an all-day
        // event named correctly and holding no start time. That is a specific
        // unresolved, not a reason to keep looking at other objects.
        return { status: 'unresolved' }
      }
      return {
        status: 'candidates',
        options: tied.slice(0, 4).map((h) => ({
          value: h.o.sub || h.o.label,
          ref: h.o.id,
          why: h.o.label,
        })),
      }
    }
  }

  /*
    3. THE ATTENTION ORDER — focused, expanded, selected, visible.

    This was one rung, "the anchor", and it read `world.focus` alone. It is the
    rung that makes "when should I leave?" answerable with no place named at
    all, and it was reachable only when something was explicitly focused: a week
    with exactly one event on it, plainly on screen, resolved to nothing.

    Walking the ranks in order fixes both halves — the focused object still wins
    outright, and a surface showing exactly one candidate object answers rather
    than asking about the thing he is looking at.
  */
  if (objectAnswerable) {
    for (const rank of ['focused', 'expanded', 'selected', 'visible'] as Attention[]) {
      const here = world.objects.filter((o) => rankOf(o, world) === rank && canAnswer(o, name))
      if (rank === 'visible' && here.length > 1) {
        // Several things on screen could be meant and none of them is where his
        // attention is. Asking which costs one tap; choosing costs trust.
        return {
          status: 'candidates',
          options: here.slice(0, 4).map((o) => ({ value: o.sub || o.label, ref: o.id, why: o.label })),
        }
      }
      const one = here[0]
      if (one) {
        const answer = valueOf(one, name)
        if (answer) return answer
      }
    }
  }

  /*
    4. LIVE LOCATION, before a stored home and only for a slot about where he
       is. A stated home is what to use when the phone has not reported a
       position; using it while it has would be answering with the wrong place
       on purpose.
  */
  if ((name === 'origin' || name === 'from') && world.location) {
    return {
      status: 'resolved',
      value: world.location.label ?? `${world.location.lat},${world.location.lon}`,
      source: 'location',
    }
  }

  // 5. Something he stated and we kept — his usual mode of travel, where to
  //    treat as home. For these slots there is no other honest source.
  const stated = world.stated[name]
  if (stated) return { status: 'resolved', value: stated, source: 'stated' }

  return { status: 'unresolved' }
}

/**
 * WHERE THIS OBJECT SITS IN THE ATTENTION ORDER.
 *
 * Two things can say an object is focused and both are legitimate: the object
 * itself, tagged by whichever surface published it, and `world.focus`, which is
 * the card's own idea of what it is about and exists before any renderer has
 * drawn a thing. Reading only the first would have silently dropped the anchor
 * rung the moment ranks arrived — the card is what carries the focus when the
 * conversation is opened from one.
 */
function rankOf(o: KnownObject, world: KnownWorld): Attention {
  if (world.focus && o.id === world.focus) return 'focused'
  return o.rank ?? 'visible'
}

/** Can this object answer this slot AT ALL? See `valueOf` for why it is asked. */
function canAnswer(o: KnownObject, name: string): boolean {
  if (TIME_SLOTS.has(name)) return !!o.at && o.allDay !== true
  if (PLACE_SLOTS.has(name)) return !!(o.sub || o.label)
  return false
}

/**
 * THE OBJECT'S ANSWER TO ONE SLOT, or nothing.
 *
 * The `nothing` case is the entire point and is what the Avano screenshot was
 * missing. An event called "Polenta in Avano with Raffaella" identifies the
 * destination perfectly and has NO usable start time, because it is marked
 * all-day. The old ladder had one notion of "the object answered", so an object
 * that answered `destination` was taken to have answered everything, and the
 * departure calculation proceeded on a start time of midnight.
 *
 * Returning null for the slot it cannot fill is what turns that into the
 * question a person would actually ask: I can see the event, is it really
 * all-day, or do you know what time it starts?
 */
function valueOf(o: KnownObject, name: string): Slot | null {
  if (TIME_SLOTS.has(name)) {
    if (!o.at || o.allDay === true) return null
    return { status: 'resolved', value: o.at, source: 'object', ref: o.id }
  }
  if (PLACE_SLOTS.has(name)) {
    const value = o.sub || o.label
    return value ? { status: 'resolved', value, source: o.kind === 'stated' ? 'stated' : 'object', ref: o.id } : null
  }
  return null
}

/** Everything a task needs, resolved as far as the ladder can take it. */
export function resolveSlots(
  names: string[],
  instruction: string,
  world: KnownWorld,
  active: TaskSlots = {},
): TaskSlots {
  const out: TaskSlots = {}
  for (const n of names) out[n] = resolveSlot(n, instruction, world, active)
  return out
}

/**
 * Can this run, and if not, what is the smallest thing standing in the way?
 *
 * "Smallest" is doing real work. A task missing a destination and an origin
 * where the origin is available from live location is missing ONE thing, and
 * asking for both would be asking him to supply something the app already knows.
 * Only genuinely unresolved and genuinely ambiguous slots block, and they are
 * asked about one at a time.
 */
export function blockingSlot(slots: TaskSlots): { name: string; slot: Slot } | null {
  for (const [name, slot] of Object.entries(slots)) {
    if (slot.status === 'unresolved' || slot.status === 'candidates') return { name, slot }
  }
  return null
}

/**
 * The question, phrased for the state it is actually in.
 *
 * Candidates get a choice; an approximate value gets a narrowing question that
 * acknowledges what is already known; nothing at all gets a question that asks
 * for whatever he remembers, because demanding an address he has already failed
 * to produce is how a clarification becomes a dead end.
 */
export function questionFor(name: string, slot: Slot, ctx: { subject?: string } = {}): string {
  if (slot.status === 'candidates') {
    return `Which one — ${slot.options.map((o) => o.why).join(', or ')}?`
  }
  if (slot.status === 'approximate') {
    return `I have ${slot.value} for the ${name} — anything more specific you remember?`
  }

  /**
   * THE QUESTION NAMES WHAT IT ALREADY FOUND.
   *
   * "I couldn't work out the eventStart" is the app describing its own field
   * names to him. What he needs to hear is that the event WAS found and exactly
   * one fact about it is missing — which is also the sentence that tells him the
   * data is malformed, since an event with a real time would not produce this.
   */
  if (name === 'eventStart') {
    return ctx.subject
      ? `I can see ${ctx.subject}, but it’s marked all day, so I don’t have a start time for it. Is it really all day, or do you know what time it starts?`
      : `I don’t have a start time for that — it’s marked all day. What time does it actually start?`
  }
  if (name === 'transportMode') {
    return 'How are you getting there — walking, cycling, driving, or public transport?'
  }
  if (name === 'origin') {
    return 'Where are you setting off from? Roughly is fine.'
  }
  const noun = name === 'destination' ? 'where you’re going' : `the ${name}`
  return `I couldn’t work out ${noun}. Whatever you remember — a name, or roughly where — is enough.`
}

/**
 * What the question should call the thing it is about.
 *
 * Read off the slots that DID resolve, so a departure question about an all-day
 * event can name the event while asking for its time.
 */
function subjectOf(slots: TaskSlots): string | undefined {
  for (const key of ['destination', 'to', 'where', 'place']) {
    const s = slots[key]
    if (s && (s.status === 'resolved' || s.status === 'approximate')) return s.value
  }
  return undefined
}

/**
 * Suspend a task rather than dropping it.
 *
 * The typed state is what makes §19 work: his next message updates the slot and
 * the SAME task resumes. Without this, a clarification is a fresh conversation
 * about a task that no longer exists, and the original instruction has to be
 * said twice.
 */
export function suspend(kind: string, instruction: string, slots: TaskSlots, id = `t-${Date.now()}`): SuspendedTask | null {
  const blocked = blockingSlot(slots)
  if (!blocked) return null
  return {
    id,
    kind,
    instruction,
    slots,
    blocking: blocked.name,
    question: questionFor(blocked.name, blocked.slot, { subject: subjectOf(slots) }),
    status: 'awaitingClarification',
    at: new Date().toISOString(),
  }
}

/**
 * His answer, applied to the slot that was blocking.
 *
 * A reply that picks one of the offered candidates resolves the slot exactly. A
 * reply that narrows without settling it ("I think it's around Bellano") is kept
 * as APPROXIMATE — real information, preserved as the uncertain thing it is, so
 * the next step can narrow further rather than proceeding on a value it invented.
 */
export function answer(task: SuspendedTask, said: string): SuspendedTask {
  const text = said.trim()
  const slot = task.slots[task.blocking]
  let filled: Slot

  const picked = slot.status === 'candidates'
    ? slot.options.find((o) => norm(text).includes(norm(o.why)) || norm(o.why).includes(norm(text)))
    : undefined

  const read = interpret(task.blocking, text, task.dayHint)

  if (picked) filled = { status: 'resolved', value: picked.value, source: 'user', ref: picked.ref }
  else if (read) filled = { status: 'resolved', value: read, source: 'user' }
  else if (/\b(around|near|somewhere|i think|maybe|roughly|about)\b/i.test(text)) {
    filled = { status: 'approximate', value: text, source: 'user' }
  } else filled = { status: 'resolved', value: text, source: 'user' }

  const slots = { ...task.slots, [task.blocking]: filled }
  const blocked = blockingSlot(slots)
  return blocked
    ? {
        ...task,
        slots,
        blocking: blocked.name,
        question: questionFor(blocked.name, blocked.slot, { subject: subjectOf(slots) }),
      }
    : { ...task, slots, status: 'ready' }
}

/**
 * A DEPARTURE ANSWER IS NOT ALWAYS A PLACE.
 *
 * `answer` treats his reply as the slot's value, which is right for "the one in
 * Bellano" and wrong for "7pm" against `eventStart` — that has to become an ISO
 * timestamp on the day the event is on, or the arithmetic downstream is done on
 * the string "7pm". Interpretation belongs beside the slot definition, not in
 * whichever caller happens to resume the task.
 */
export function interpret(name: string, said: string, on?: string): string | null {
  if (name !== 'eventStart') return null
  const t = said.trim().toLowerCase()
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t) ?? /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(t)
  if (!m) return null
  let hour = Number(m[1])
  const min = Number(m[2] ?? 0)
  const ampm = m[3]
  if (ampm === 'pm' && hour < 12) hour += 12
  if (ampm === 'am' && hour === 12) hour = 0
  if (!Number.isFinite(hour) || hour > 23) return null
  const day = on && /^\d{4}-\d{2}-\d{2}/.test(on) ? on.slice(0, 10) : null
  if (!day) return null
  const d = new Date(`${day}T00:00:00`)
  d.setHours(hour, min, 0, 0)
  return d.toISOString()
}

/**
 * WHAT THE CHIPS OFFER WHILE A TASK IS BLOCKED.
 *
 * The screenshot that made this necessary: a route request failed for want of a
 * destination, and the chips underneath the failure were "Show route" and "What
 * time should I leave?" — the action that had just failed, and one that cannot
 * be answered until it succeeds. Both are dead, and offering a dead action as
 * the way forward is worse than offering nothing, because it costs a tap to
 * find out.
 *
 * So suggestions are a function of TASK STATE, not of the feed. While something
 * is blocked they are the ways to unblock it, in order of how much they settle:
 * a named candidate settles the slot outright, a capability the app already has
 * might, and a rough area narrows it. Nothing here can restate the request.
 */
export function suggestionsFor(task: SuspendedTask, world: KnownWorld): string[] {
  const slot = task.slots[task.blocking]
  const out: string[] = []

  // The choice, where there is one. One tap, and the slot is resolved.
  if (slot?.status === 'candidates') out.push(...slot.options.map((o) => o.why))

  // Capabilities that could answer it without him knowing anything. Only ones
  // that genuinely exist right now — an offer the app cannot honour is the same
  // dead chip in a different costume.
  if (out.length < 3) {
    if (PLACE_SLOTS.has(task.blocking) && world.location) out.push('Use my current location')
    if (world.objects.some((o) => o.kind === 'message')) out.push('Look in my messages')
    if (world.objects.some((o) => o.kind === 'place')) out.push('One of my saved places')
  }

  return out.slice(0, 3)
}

/**
 * Does this suggestion just restate what already failed?
 *
 * Compared on content rather than identity, because the chip that failed and
 * the chip being offered are usually two different strings for one action —
 * "Show route" and "Show me the route" are the same dead tap.
 */
export function restates(suggestion: string, instruction: string): boolean {
  const a = norm(suggestion)
  const b = norm(instruction)
  if (!a || !b) return false
  if (a === b || b.includes(a) || a.includes(b)) return true
  const av = a.split(' ').filter((w) => !STOP.has(w))
  const bv = b.split(' ').filter((w) => !STOP.has(w))
  // Nothing left after the stop words means the suggestion IS the bare verb
  // phrase of the instruction — "show route" against "show route to lunch".
  return av.length === 0 && bv.length >= 0 && norm(suggestion) !== ''
}

/**
 * The original instruction, plus what he has since told us.
 *
 * This is what gets re-sent on resume — the task continues rather than
 * restarting, and he never repeats himself. Approximate values are carried
 * across WITH their hedge intact, so the executor knows it is working from
 * "around Bellano" rather than from Bellano.
 */
export function resumeInstruction(task: SuspendedTask): string {
  const known = Object.entries(task.slots)
    .flatMap(([name, s]) =>
      s.status === 'resolved' ? [`${name}: ${s.value}`]
        : s.status === 'approximate' ? [`${name}: approximately ${s.value}`]
          : [])
  return known.length ? `${task.instruction} (${known.join('; ')})` : task.instruction
}

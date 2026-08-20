/**
 * The typed model's write paths, as functions rather than as route handlers.
 *
 * WHY THIS FILE EXISTS AT ALL. This app has already been bitten twice by the
 * same shape: a capability typed once into `server/index.ts` for the Mac and
 * once into `worker/index.ts` for the edge, drifting apart because nothing
 * fails when you forget the second one. `calendar.update` ended up in neither.
 * `PUT /api/world/profile` exists only on the Mac to this day, so writing the
 * profile 404s on crucible.cam — the host he actually uses from his phone.
 *
 * The correction endpoint is the worst possible candidate for that treatment:
 * it is the thing he taps when the app is wrong, and a version of it that works
 * on a laptop nobody opens is indistinguishable from a button that does
 * nothing. So the logic lives here, both hosts call the same function, and the
 * only thing either host supplies is the parsed body.
 *
 * Each function goes through `mutateWorld`, which serialises it against every
 * other world mutation on the host and re-runs it if the document moved while it
 * was working. THAT IS NOT A GENERAL TIDY-UP — it is specifically required here:
 * a correction is the one write in this app that must never be lost, and the
 * thing most likely to lose it is the feed build that produced the card he just
 * corrected. The build reads the world, spends several seconds geocoding, and
 * then writes back a document that predates his tap. See `mutateWorld`.
 */

import { applyCorrection, statedGoal, type Applied } from './correct.js'
import type { Correction } from './attention.js'
import { recordAnswer, slotForReply } from './answer.js'
import {
  fact,
  getFact,
  noteEngagement,
  readPerson,
  setFact,
  SETTINGS_SLOTS,
  SLOTS,
  type Person_,
} from './person.js'
import { focusThisWeek, renderFocus } from './focus.js'
import { dataHealth, type DataHealth } from './health.js'
import { mutateWorld, readWorld, type World } from './world.js'
import { memoryStore } from './memory/host.js'
import { denyClaim } from './memory/correction.js'

/** Read the typed model, plus the slots that are currently blocked on. */
export async function getPerson(): Promise<{
  person: Person_
  /** Slots something wanted this session and could not get. */
  open: { key: string; question: string; unlocks: string; why: string; options: { value: string; label: string }[] }[]
}> {
  const w = await readWorld()
  const person = readPerson(w)
  const open = Object.entries(person.demands)
    .filter(([k]) => {
      const held = getFact(person, k)
      return !held || held.status === 'unknown'
    })
    .map(([key, d]) => {
      const slot = SLOTS[key]
      return {
        key,
        question: slot?.question ?? `I need to know your ${key}.`,
        unlocks: slot?.unlocks ?? d.why,
        why: d.why,
        options: optionsFor(person, key, slot?.options),
      }
    })
  return { person, open }
}

function optionsFor(
  p: Person_,
  key: string,
  declared?: { value: string; label: string }[]
): { value: string; label: string }[] {
  const m = /^source\.(.+)$/.exec(key)
  if (m) {
    const c = p.conflicts.find((x) => x.metric === m[1] && x.state === 'open')
    return (c?.readings ?? []).map((r) => ({ value: r.source, label: r.source }))
  }
  return declared ?? []
}

/**
 * Apply a correction he made.
 *
 * The verb is validated against the closed set rather than trusted, because
 * this is a public endpoint and `applyCorrection` writes `by: 'user'` — which
 * is permanent and outranks every later inference. An unrecognised verb is a
 * refusal, not a best-effort guess.
 */
export async function correct(raw: unknown): Promise<Applied & { status: number }> {
  const c = parseCorrection(raw)
  if (!c) return { ok: false, said: 'I did not understand that correction.', touched: [], status: 400 }

  try {
    const { result: applied } = await mutateWorld(
      (w) => {
        /**
         * The person is re-read INSIDE the mutation, which is the entire point.
         * On a retry this reads the document that actually exists — so a
         * correction landing at the same moment as a sync is applied on top of
         * the sync rather than instead of it.
         */
        const person = readPerson(w)
        const out = applyCorrection(person, c)
        w.person = person
        return out
      },
      { label: 'your correction' }
    )
    return { ...applied, status: applied.ok ? 200 : 404 }
  } catch (e) {
    /**
     * A correction that did not persist must SAY SO.
     *
     * This is the one place where reporting "ok" on a failed write would be
     * actively harmful: he would believe the app had been told, stop expecting
     * the wrong behaviour to recur, and see it recur. A visible failure he can
     * retry is far better.
     */
    return { ok: false, said: (e as Error).message, touched: [], status: 503 }
  }
}

const VERBS = new Set(['wrong', 'prefer-source', 'set-preference', 'forget', 'not-relevant', 'relationship', 'lift'])

function parseCorrection(raw: unknown): Correction | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const verb = typeof r.verb === 'string' ? r.verb : ''
  if (!VERBS.has(verb)) return null
  const label = typeof r.label === 'string' && r.label ? r.label.slice(0, 80) : verb

  switch (verb) {
    case 'set-preference': {
      const key = str(r.key, 80)
      if (!key) return null
      // The VALUE is deliberately not constrained to the slot's options: a slot
      // may declare five answers and he is entitled to a sixth in his own
      // words. What is constrained is the key, because that is what code reads.
      return { verb, label, key, value: r.value ?? null }
    }
    case 'prefer-source': {
      const metric = str(r.metric, 40)
      const source = str(r.source, 60)
      if (!metric || !source) return null
      return { verb, label, metric, source }
    }
    case 'wrong':
    case 'forget': {
      const t = r.target as Record<string, unknown> | undefined
      const id = str(t?.id, 120)
      const kind = str(t?.kind, 20)
      if (!id || !kind) return null
      return verb === 'wrong'
        ? { verb, label, target: { kind: kind as never, id }, note: str(r.note, 200) || undefined }
        : { verb, label, target: { kind: kind as never, id } }
    }
    case 'not-relevant': {
      const about = str(r.about, 40)
      if (!about) return null
      return { verb, label, about }
    }
    case 'relationship': {
      const personId = str(r.personId, 80)
      const value = str(r.value, 120)
      if (!personId || !value) return null
      return { verb, label, personId, value }
    }
    /**
     * A CLOSED VALUE SET, unlike `relationship` — and the asymmetry is deliberate.
     *
     * A relationship is his to describe in his own words: "someone I sometimes get
     * a lift from" is the answer that would actually change a plan and is on
     * nobody's dropdown. This is not a description, it is a DECISION with exactly
     * two outcomes that code branches on, so a third string would be a value
     * nothing reads — which is the shape of a control that silently does nothing.
     */
    case 'lift': {
      const personId = str(r.personId, 80)
      const value = str(r.value, 10)
      if (!personId || (value !== 'ask' && value !== 'never')) return null
      return { verb, label, personId, value }
    }
  }
  return null
}

const str = (v: unknown, max: number): string =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : ''

/**
 * Record where he is.
 *
 * The position is stored as a Fact like everything else, which is what makes
 * "updated 38 seconds ago, ±22 m, from the device" expressible at all — a bare
 * pair of coordinates has no answer to "how old is this?" and the old one was
 * being drawn as though it were current whatever its age.
 *
 * `by: 'connector'`, not `'user'`: a device fix must never lock out a place he
 * later types himself.
 */
export async function noteLocation(raw: unknown): Promise<{ ok: boolean; status: number; said: string }> {
  const r = (raw ?? {}) as Record<string, unknown>
  const lat = Number(r.lat)
  const lon = Number(r.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { ok: false, status: 400, said: 'That is not a position.' }
  }
  const accuracy = Number.isFinite(Number(r.accuracy)) ? Number(r.accuracy) : undefined
  const at = typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at)) ? r.at : new Date().toISOString()
  const label = str(r.label, 60) || undefined
  const provenance = str(r.provenance, 24) || 'live-device'

  await mutateWorld((w) => {
    const person = readPerson(w)

    setFact(
      person,
      'identity',
      fact(
        'location.last',
        { lat, lon, accuracy, label },
        {
          source: provenance,
          status: provenance === 'user-stated' ? 'user_provided' : 'verified',
          confidence: provenance === 'live-device' ? 0.95 : 0.8,
          by: provenance === 'user-stated' ? 'user' : 'connector',
          sourceAt: at,
          note: accuracy ? `Reported to ±${Math.round(accuracy)} m.` : undefined,
        }
      )
    )

    /**
     * A stated place also becomes the fallback origin.
     *
     * A live fix does not: it is where he happens to be standing, and freezing
     * that as "home" would mean a plan built next week starts from a bus stop.
     */
    if (provenance === 'user-stated') {
      setFact(
        person,
        'identity',
        fact('identity.home.coords', { lat, lon, label }, {
          source: 'user',
          status: 'user_provided',
          confidence: 1,
          by: 'user',
          sourceAt: at,
        })
      )
      delete person.demands['identity.home']
    }

    w.person = person
  }, { label: 'your position' })
  return { ok: true, status: 200, said: 'Noted.' }
}

/**
 * HE ACTED ON A CARD, OR HE SWIPED IT AWAY.
 *
 * The behavioural half of the proactivity loop. Deliberately a separate endpoint
 * from `/correct`, and the separation is the point rather than routing tidiness:
 * a correction is something he SAID and is written as a permanent `by: 'user'`
 * fact; this is something he DID, and it is evidence that nudges a ranking. The
 * two must never be able to be mistaken for one another, and an endpoint that
 * accepted both would eventually let one be written as the other.
 *
 * `about` is the subject vocabulary `not-relevant` and `fitOf` already share —
 * 'travel', 'fitness'. An unrecognised subject is not an error; it simply
 * accumulates under its own key and biases nothing until something scores
 * against it.
 */
export async function noteEngaged(raw: unknown): Promise<{ ok: boolean; status: number }> {
  const r = (raw ?? {}) as Record<string, unknown>
  const about = str(r.about, 40)
  const verdict = r.verdict === 'accepted' ? 'accepted' : r.verdict === 'dismissed' ? 'dismissed' : null
  if (!about || !verdict) return { ok: false, status: 400 }
  await mutateWorld((w) => {
    const person = readPerson(w)
    noteEngagement(person, about, verdict)
    w.person = person
  }, { label: 'what you did with that card' })
  return { ok: true, status: 200 }
}

/**
 * WHAT HE MADE OF SOMETHING CRUCIBLE WORKED OUT.
 *
 * Here, in the one dispatcher both hosts call, for the reason the capability
 * table is one table: `calendar.update` went missing from both copies of a list
 * that existed twice, and nobody noticed because there was no compiler, test or
 * type to say a second file had been forgotten. The phone talks to the edge, so
 * a correction route added only to the Mac would be a "that's wrong" button that
 * works on a laptop nobody uses.
 *
 * THE THREE VERDICTS GO TO TWO DIFFERENT SYSTEMS, which is the whole of §15:
 *
 *   useful / not-useful → engagement. Whether he wanted to be told. Moves the
 *                         fit axis; leaves the claim's truth completely alone.
 *   wrong               → epistemics. The claim is false. Reaches the hypothesis
 *                         and is written as a `stated` fact that survives a
 *                         rebuild.
 *
 * A "wrong" that merely counted as a dismissal would leave the app believing
 * something he has explicitly denied and showing it to him slightly less often,
 * which is the failure this split exists to make unrepresentable.
 */
export async function judgeIntelligence(raw: unknown): Promise<{ ok: boolean; status: number; said: string }> {
  const r = (raw ?? {}) as Record<string, unknown>
  const id = str(r.id, 120)
  const verdict = r.verdict
  if (!id || (verdict !== 'useful' && verdict !== 'not-useful' && verdict !== 'wrong')) {
    return { ok: false, status: 400, said: 'I could not tell what that was about.' }
  }

  if (verdict !== 'wrong') {
    /*
      ENGAGEMENT, THROUGH THE PATH THAT ALREADY EXISTS. `noteEngagement` keys on
      the subject vocabulary `fitOf` and `not-relevant` share, so a verdict filed
      here biases the same ranking every other card's dismissal biases. A second
      counter would be a second answer to "does he want this".
    */
    await mutateWorld((w) => {
      const person = readPerson(w)
      noteEngagement(person, 'intelligence', verdict === 'useful' ? 'accepted' : 'dismissed')
      w.person = person
    }, { label: 'what you made of that' })
    return {
      ok: true,
      status: 200,
      said: verdict === 'useful' ? 'Noted.' : 'Noted — I will raise this kind of thing less.',
    }
  }

  const store = memoryStore()
  if (!store) {
    return { ok: false, status: 503, said: 'I could not record that — my memory is not running.' }
  }
  const because = str(r.correction, 400) || undefined
  const { retired } = denyClaim(store, { claimId: id, because, at: new Date().toISOString() })
  return {
    ok: true,
    status: 200,
    said: retired
      ? 'Noted — I have dropped that and I will not work it out again from the same evidence.'
      : 'Noted — I have recorded that as wrong.',
  }
}

/** He states a goal. Kept here so both hosts get it. */
export async function setGoal(raw: unknown): Promise<{ ok: boolean; status: number; id?: string }> {
  const r = (raw ?? {}) as Record<string, unknown>
  const description = str(r.description, 160)
  if (!description) return { ok: false, status: 400 }
  const { result: id } = await mutateWorld((w) => {
    const person = readPerson(w)
    const made = statedGoal(person, description, {
      outcome: str(r.outcome, 200) || undefined,
      metric: str(r.metric, 40) || undefined,
      target: Number.isFinite(Number(r.target)) ? Number(r.target) : undefined,
      unit: str(r.unit, 20) || undefined,
      direction: r.direction === 'down' ? 'down' : r.direction === 'steady' ? 'steady' : 'up',
      source: str(r.source, 60) || undefined,
      timeframe: str(r.timeframe, 60) || undefined,
    })
    w.person = person
    return made
  }, { label: 'your goal' })
  return { ok: true, status: 200, id }
}

/**
 * THE INVERSE OF `setGoal`, AND IT PAUSES RATHER THAN DELETES.
 *
 * Undo for `activity.goal`. Paused, not removed, for the reason `retire` gives
 * at length: absence is indistinguishable from "never said", so a deleted goal
 * is one the app is free to infer again this afternoon — which is the opposite
 * of what undo means. Paused is a statement, and `goalFor` skips it.
 */
export async function pauseGoal(id: string): Promise<{ ok: boolean; status: number }> {
  if (!id) return { ok: false, status: 400 }
  const { result: found } = await mutateWorld((w) => {
    const person = readPerson(w)
    const g = person.goals.find((x) => x.id === id)
    if (!g) return false
    g.status = 'paused'
    g.by = 'user'
    g.updatedAt = new Date().toISOString()
    person.updatedAt = g.updatedAt
    w.person = person
    return true
  }, { label: 'undoing your goal' })
  return { ok: !!found, status: found ? 200 : 404 }
}

/**
 * A number he supplies himself for a metric — "my phone says 10,347 today".
 *
 * Stored as a READING rather than as a correction, and that is the important
 * distinction. A correction would overwrite what Fit said; a reading sits
 * beside it, and `detectConflicts` then does its job and asks him which source
 * to trust. Overwriting would settle the question by fiat and lose the fact
 * that two things were ever reported.
 */
export async function noteReading(raw: unknown): Promise<{ ok: boolean; status: number; said: string }> {
  const r = (raw ?? {}) as Record<string, unknown>
  const metric = str(r.metric, 40)
  const day = str(r.day, 10)
  const value = Number(r.value)
  const source = str(r.source, 60) || 'your phone'
  if (!metric || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(value)) {
    return { ok: false, status: 400, said: 'I need a metric, a date and a number.' }
  }
  await mutateWorld((w) => {
    const person = readPerson(w)
    setFact(
      person,
      'identity',
      fact(`reading.${metric}.${day}`, value, {
        source,
        status: 'user_provided',
        confidence: 1,
        by: 'user',
        sourceAt: new Date().toISOString(),
        // The note carries the source NAME, which is what `readingsFrom` reads
        // back out to label the disagreeing side of a conflict.
        note: source,
      })
    )
    w.person = person
  }, { label: 'that reading' })
  return { ok: true, status: 200, said: `Noted — ${source} says ${value.toLocaleString()} ${metric} on ${day}.` }
}

/**
 * HE ANSWERS A QUESTION, AND THE ANSWER IS A TYPED FACT BEFORE IT IS A SENTENCE.
 *
 * The endpoint behind both the freeform reply to a question card and
 * `/api/world/tell`. It exists so there is exactly ONE implementation of "record
 * what he just told us" — the tapped-chip path already wrote typed facts through
 * `correct`, and the typed path being better than the freeform path is the kind of
 * inconsistency nobody would ever notice from the outside and which meant a man who
 * typed "no" instead of tapping "No" was not heard.
 *
 * Both writes happen in ONE transaction. A fact that landed without its observation
 * would leave history disagreeing with the model, and the reverse is the bug this
 * whole change is about.
 */
export async function tell(raw: unknown): Promise<{ ok: boolean; status: number; said: string; touched: string[] }> {
  const r = (raw ?? {}) as Record<string, unknown>
  const text = str(r.text, 600)
  if (!text) return { ok: false, status: 400, said: 'Nothing said.', touched: [] }
  const question = str(r.inReplyTo, 200) || undefined
  const cardId = str(r.cardId, 120) || undefined
  const declared = str(r.slot, 80) || undefined

  try {
    const { result } = await mutateWorld((w) => {
      const person = readPerson(w)
      /**
       * The slot comes from what the app ASKED — a declared slot, the card's id, or
       * the single question outstanding — and never from what he typed. See
       * `slotForReply`: guessing a slot from his words writes a permanent
       * `by: 'user'` fact from something he did not say.
       */
      const slot = declared ?? slotForReply(person, { cardId, question }) ?? undefined
      const out = recordAnswer(person, { slot, question, text })
      w.person = person
      // The history record, folded in beside the fact rather than after it.
      const held = w.observations.findIndex((o) => o.id === out.observation.id)
      if (held >= 0) w.observations[held] = out.observation
      else w.observations.push(out.observation)
      return out
    }, { label: 'what you told me' })
    return { ok: true, status: 200, said: result.said, touched: result.touched }
  } catch (e) {
    return { ok: false, status: 503, said: (e as Error).message, touched: [] }
  }
}

/**
 * The slots he can set directly, and what each currently holds.
 *
 * Read by the settings surface. `assistant.proactivity` was a field the ranker
 * obeyed and the person it described could not reach — settable only by an API call
 * nobody but me would make. A preference that steers the product has to be reachable
 * from inside the product.
 */
export async function preferences(): Promise<{
  slots: {
    key: string
    question: string
    unlocks: string
    label: string
    section: string
    options: { value: string; label: string }[]
    value: unknown
    by?: string
  }[]
}> {
  const w = await readWorld()
  const person = readPerson(w)
  return {
    slots: SETTINGS_SLOTS.map((s) => {
      const held = getFact(person, s.key)
      return {
        key: s.key,
        question: s.question,
        unlocks: s.unlocks,
        label: s.settings!.label,
        section: s.settings!.section,
        options: s.options ?? [],
        // The stored value, or nothing. Never a default dressed up as his choice —
        // "you have not said" and "you chose the middle option" are different, and
        // only the first should still be askable.
        value: held && held.status !== 'unknown' ? held.value : null,
        by: held?.by,
      }
    }),
  }
}

/** Shared by both hosts so the route list itself cannot fork. */
export type PersonRoute =
  | { path: '/api/person'; method: 'GET' }
  | { path: '/api/person/correct'; method: 'POST' }
  | { path: '/api/person/where'; method: 'POST' }
  | { path: '/api/person/goal'; method: 'POST' }
  | { path: '/api/person/reading'; method: 'POST' }
  | { path: '/api/person/tell'; method: 'POST' }
  | { path: '/api/person/preferences'; method: 'GET' }
  | { path: '/api/intelligence/judge'; method: 'POST' }
  | { path: '/api/focus'; method: 'GET' }

/**
 * One dispatcher, called by both hosts.
 *
 * Returning `null` for an unmatched path lets each host fall through to its own
 * remaining routes, so this composes rather than taking over the router.
 */
export async function personRoute(
  path: string,
  method: string,
  body: unknown
): Promise<{ status: number; value: unknown } | null> {
  if (path === '/api/person' && method === 'GET') return { status: 200, value: await getPerson() }
  if (path === '/api/person/correct' && method === 'POST') {
    const { status, ...rest } = await correct(body)
    return { status, value: rest }
  }
  if (path === '/api/person/where' && method === 'POST') {
    const { status, ...rest } = await noteLocation(body)
    return { status, value: rest }
  }
  /**
   * WHAT THE APP BELIEVES, AND WHERE IT CAME FROM.
   *
   * Recomputed on every request rather than cached, deliberately: a stored
   * picture of what is stale is the one thing on this screen that must never
   * itself be stale. It is cheap — no network, no model — so there is nothing to
   * buy by caching it and a real correctness property to lose.
   */
  if (path === '/api/person/health' && method === 'GET') {
    const w = await readWorld()
    return { status: 200, value: dataHealth(w, readPerson(w)) }
  }
  if (path === '/api/person/engagement' && method === 'POST') {
    const out = await noteEngaged(body)
    return { status: out.status, value: out }
  }
  if (path === '/api/intelligence/judge' && method === 'POST') {
    const { status, ...rest } = await judgeIntelligence(body)
    return { status, value: rest }
  }
  if (path === '/api/person/goal' && method === 'POST') {
    const { status, ...rest } = await setGoal(body)
    return { status, value: rest }
  }
  if (path === '/api/person/reading' && method === 'POST') {
    const { status, ...rest } = await noteReading(body)
    return { status, value: rest }
  }
  if (path === '/api/person/tell' && method === 'POST') {
    const { status, ...rest } = await tell(body)
    return { status, value: rest }
  }
  if (path === '/api/person/preferences' && method === 'GET') {
    return { status: 200, value: await preferences() }
  }
  /**
   * "What should I focus on this week?" as an endpoint.
   *
   * Mounted here rather than beside the feed because it is the same kind of thing as
   * everything else in this file: a read of the typed personal model that both hosts
   * must serve identically. `/api/world/profile` exists only on the Mac to this day
   * and quietly 404s on the phone he actually uses; that is the mistake this
   * dispatcher exists to make impossible.
   */
  if (path === '/api/focus' && method === 'GET') {
    const w = await readWorld()
    const f = await focusThisWeek(w, { offline: true })
    return { status: 200, value: { ...f, prose: renderFocus(f) } }
  }
  return null
}

/** Unused today; kept exported so a host can enumerate what it must serve. */
export const PERSON_PATHS = [
  '/api/person',
  '/api/person/correct',
  '/api/person/where',
  '/api/person/goal',
  '/api/person/reading',
  '/api/person/tell',
  '/api/person/preferences',
  '/api/intelligence/judge',
  '/api/focus',
] as const

export type { World }

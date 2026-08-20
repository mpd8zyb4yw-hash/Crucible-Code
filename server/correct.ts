/**
 * BEING TOLD YOU ARE WRONG.
 *
 * A correction has to change what the system BELIEVES, not what it is currently
 * displaying. That distinction sounds pedantic and is the whole feature: a
 * "hide this card" button leaves the model holding the same wrong idea, so the
 * same conclusion returns tomorrow in different words, and he learns that
 * telling it things does nothing.
 *
 * Every verb here therefore ends in a write to the typed model, and every write
 * is made `by: 'user'` — which `mayReplace` treats as permanent. The next
 * synthesis pass will re-derive the thing he just corrected, attempt to store
 * it, and be refused. That refusal is the feature.
 *
 * ONE ENTRY POINT, BOTH HOSTS. The verb set is closed and lives in
 * `attention.ts` beside the cards that offer it, so a card cannot offer a
 * correction nothing implements — the type will not allow it. That matters
 * more than usual here: the app already shipped three controls wired to an op
 * no surface declared, and they did nothing, silently, for weeks.
 */

import type { Correction } from './attention.js'
import {
  addGoal,
  fact,
  getFact,
  setFact,
  settled,
  type Person_,
} from './person.js'
/**
 * Runtime, and safe: `people.ts` imports only TYPES from here, so the emitted
 * modules have no cycle. `liftKey` lives there because that is where the rule it
 * encodes lives — one fact per person, set by him and by nothing else.
 */
import { liftKey } from './people.js'

export interface Applied {
  ok: boolean
  /** What changed, in his words. Shown back to him so the write is visible. */
  said: string
  /** Keys or ids touched, for the caller to log. */
  touched: string[]
}

/**
 * Apply one correction to the person.
 *
 * Pure with respect to the network and the clock's zone — it mutates the person
 * it is handed and says what it did. Persisting is the caller's job, because
 * the caller is the one that knows whether it is holding a whole world it is
 * about to write back.
 */
export function applyCorrection(p: Person_, c: Correction, now = new Date()): Applied {
  switch (c.verb) {
    case 'set-preference': {
      const ok = setFact(
        p,
        'preferences',
        fact(c.key, c.value, {
          source: 'user',
          status: 'user_provided',
          confidence: 1,
          by: 'user',
          sourceAt: now.toISOString(),
          note: 'He set this directly.',
          askedAt: p.asked[c.key]?.at,
        })
      )
      settled(p, c.key)
      delete p.asked[c.key]
      return {
        ok,
        said: `Noted — ${describe(c.key, c.value)}. I will use that from now on and stop asking.`,
        touched: [c.key],
      }
    }

    case 'prefer-source': {
      const key = `source.${c.metric}`
      setFact(
        p,
        'preferences',
        fact(key, c.source, {
          source: 'user',
          status: 'user_provided',
          confidence: 1,
          by: 'user',
          sourceAt: now.toISOString(),
          note: `He chose ${c.source} as authoritative for ${c.metric}.`,
        })
      )
      settled(p, key)
      delete p.asked[key]

      /**
       * Resolving the conflict is a SEPARATE write from recording the
       * preference, and both are needed. The preference is what future
       * readings consult; marking the conflict resolved is what stops the card
       * coming back tomorrow about the same two numbers. Doing only the first
       * leaves him answering the same question every morning.
       */
      let closed = 0
      for (const conflict of p.conflicts) {
        if (conflict.metric !== c.metric || conflict.state !== 'open') continue
        conflict.state = 'resolved'
        conflict.resolvedTo = c.source
        conflict.resolvedAt = now.toISOString()
        closed++
      }
      p.updatedAt = now.toISOString()
      return {
        ok: true,
        said: `I will treat ${c.source} as the truth for ${c.metric}${closed ? ` and I have settled ${closed} open disagreement${closed === 1 ? '' : 's'}` : ''}.`,
        touched: [key],
      }
    }

    case 'wrong': {
      return retire(p, c.target, now, c.note ?? 'He said this was wrong.', 'wrong')
    }

    case 'forget': {
      return retire(p, c.target, now, 'He asked me to forget this.', 'forget')
    }

    case 'not-relevant': {
      /**
       * Stored as a DISLIKE, not as a filter.
       *
       * A filter is invisible and unaccountable — six months later nobody can
       * say why fitness never appears. A stored preference is readable, is
       * rendered into the prompt, shows up in the settings surface, and can be
       * reversed by him with the same mechanism that set it. `fitOf` reads
       * exactly this key when scoring, so the effect is a ranking penalty
       * rather than a hard suppression, which is the right strength for "I do
       * not really want this" as opposed to "never do this".
       */
      const key = `dislike.${c.about}`
      setFact(
        p,
        'preferences',
        fact(key, true, {
          source: 'user',
          status: 'user_provided',
          confidence: 1,
          by: 'user',
          sourceAt: now.toISOString(),
          note: `He said ${c.about} is not something he wants raised.`,
        })
      )
      return {
        ok: true,
        said: `I will stop bringing up ${c.about} unless something genuinely needs you.`,
        touched: [key],
      }
    }

    case 'relationship': {
      const person = p.people.find((x) => x.id === c.personId)
      if (!person) return { ok: false, said: `I do not have anyone by that name.`, touched: [] }
      const key = `person.${c.personId}.relationship`
      person.relationship = fact(key, c.value, {
        source: 'user',
        status: 'user_provided',
        confidence: 1,
        by: 'user',
        sourceAt: now.toISOString(),
        note: 'He told me who this is to him. Nothing inferred it.',
      })
      /**
       * `by: 'user'` on the PERSON as well as on the relationship fact.
       *
       * The two protect different things and both are needed. The fact's `by` stops
       * a later pass rewriting who they are to him; the person's `by` stops the next
       * calendar sync rewriting the NAME he may have corrected at the same time —
       * `liftPeople` enriches freely from connector data unless the record is his.
       */
      person.by = 'user'
      person.updatedAt = now.toISOString()
      /**
       * The question is settled, so it stops being asked. This was the gap that made
       * `demand()` accumulate: nothing cleared a want once it was satisfied, so a
       * slot he answered kept generating a question until something overwrote it.
       */
      settled(p, key)
      delete p.asked[key]
      p.updatedAt = now.toISOString()
      return {
        ok: true,
        said: `Noted — ${person.name}: ${c.value}. I will use that and stop guessing.`,
        touched: [person.id, key],
      }
    }

    /**
     * "I'D ASK PAOLO FOR A LIFT." THE LEARNED FUTURE PREFERENCE.
     *
     * Written as an ordinary preference, `by: 'user'`, so it behaves like every
     * other thing he has told us: it outranks inference permanently, it appears in
     * the data-health view with its provenance, and he can reverse it with the
     * same mechanism that set it. What it must NOT be is a side effect of the
     * relationship verb — see `people.ts`'s `LiftStance` for why knowing someone is
     * a friend says nothing about whether he would ask them for a ride.
     *
     * `'never'` is stored rather than treated as an absence. "He has not said" and
     * "he has said no" are different states, and only the second one should stop
     * the app raising the question again — an absence would be re-asked forever.
     */
    case 'lift': {
      const person = p.people.find((x) => x.id === c.personId)
      if (!person) return { ok: false, said: `I do not have anyone by that name.`, touched: [] }
      const key = liftKey(person.id)
      setFact(
        p,
        'preferences',
        fact(key, c.value, {
          source: 'user',
          status: 'user_provided',
          confidence: 1,
          by: 'user',
          sourceAt: now.toISOString(),
          note: `He said whether he would ask ${person.name} for a lift. Nothing inferred it.`,
        })
      )
      settled(p, key)
      settled(p, `person.${person.id}.relationship`)
      delete p.asked[key]
      p.updatedAt = now.toISOString()
      return {
        ok: true,
        said:
          c.value === 'ask'
            ? `Noted — ${person.name} is someone you would ask for a lift. I will remember that for next time, and I will still never message anyone for you.`
            : `Noted — I will not suggest asking ${person.name} for a lift again.`,
        touched: [key],
      }
    }
  }
}

/**
 * Retire something and record that HE retired it.
 *
 * Nothing is deleted outright. A fact he called wrong becomes a fact with
 * `status: 'unknown'`, `by: 'user'` and a note — which is a stronger statement
 * than absence, because absence is indistinguishable from "never learned" and
 * would be re-inferred within the hour. This is the same reasoning that keeps
 * a contested belief in the world model rather than dropping it.
 */
function retire(
  p: Person_,
  target: { kind: string; id: string },
  now: Date,
  note: string,
  verb: 'wrong' | 'forget'
): Applied {
  const stamp = now.toISOString()

  if (target.kind === 'goal') {
    const g = p.goals.find((x) => x.id === target.id)
    if (!g) return { ok: false, said: 'I could not find that to change.', touched: [] }
    g.status = verb === 'forget' ? 'abandoned' : 'paused'
    g.by = 'user'
    g.updatedAt = stamp
    p.updatedAt = stamp
    return {
      ok: true,
      said: verb === 'forget' ? `Dropped "${g.description}".` : `Paused "${g.description}" — tell me what it should be.`,
      touched: [g.id],
    }
  }

  const held = getFact(p, target.id)
  if (held) {
    const bag = p.identity[target.id] ? 'identity' : 'preferences'
    setFact(
      p,
      bag,
      fact(target.id, held.value, {
        source: 'user',
        status: 'unknown',
        confidence: 0,
        by: 'user',
        sourceAt: stamp,
        note,
      })
    )
    p.updatedAt = stamp
    return { ok: true, said: `Forgotten. I will not use that again, and I will ask if I need it.`, touched: [target.id] }
  }

  /**
   * A correction against something that is not in the typed model at all.
   *
   * Rather than failing, this records a standing instruction keyed by the
   * target's id. The synthesis pass reads these, and it is what makes "that's
   * wrong" work against a model-authored conclusion that was never stored as a
   * fact — the commonest case, and the one a naive implementation drops on the
   * floor with an "ok: true" that changed nothing.
   */
  const key = `retracted.${target.kind}.${target.id}`
  setFact(
    p,
    'preferences',
    fact(key, true, {
      source: 'user',
      status: 'user_provided',
      confidence: 1,
      by: 'user',
      sourceAt: stamp,
      note,
    })
  )
  return { ok: true, said: `Noted. I will not repeat that.`, touched: [key] }
}

/** A sentence for the value he just set, without leaking key names at him. */
function describe(key: string, value: unknown): string {
  /**
   * A place is an object, and `String({...})` is "[object Object]" — which is
   * what he was actually shown after picking the right restaurant off a list.
   * Objects that carry a label say the label; anything else says nothing rather
   * than something meaningless.
   */
  if (key.startsWith('place.')) {
    const label = (value as { label?: string } | null)?.label
    return label ? `that is the ${label} you mean` : 'I have noted which place you mean'
  }
  const v = Array.isArray(value)
    ? value.join(', ')
    : value && typeof value === 'object'
      ? ((value as { label?: string }).label ?? 'noted')
      : String(value)
  if (key === 'transport.default') {
    return v === 'ask' ? 'I will ask each time' : `you usually ${v === 'transit' ? 'take the bus' : v}`
  }
  if (key.startsWith('source.')) return `${v} is the one to trust for ${key.slice(7)}`
  if (key === 'video.destination') return `videos open in ${v}`
  if (key === 'fitness.objective') return `what you are after is: ${v}`
  return `${key.split('.').pop()} is ${v}`
}

/**
 * Record a goal he stated, from the ordinary answer path.
 *
 * Lives here rather than in `person.ts` because it is a CORRECTION-shaped
 * write: it is him telling us something, so it must carry the same permanence
 * as everything else in this file.
 */
export function statedGoal(
  p: Person_,
  description: string,
  detail: {
    outcome?: string
    metric?: string
    target?: number
    unit?: string
    /** Which way counts as progress. Never assumed to be 'up' — see below. */
    direction?: 'up' | 'down' | 'steady'
    /** Which source supplies the number, when he has said. */
    source?: string
    timeframe?: string
  } = {},
  now = new Date()
): string {
  const g = addGoal(p, {
    description,
    status: 'active',
    importance: 3,
    outcome: detail.outcome,
    timeframe: detail.timeframe,
    constraints: [],
    /**
     * DIRECTION IS HIS, NOT A DEFAULT.
     *
     * This hardcoded `direction: 'up'`, which is the exact mistake `think.ts`
     * has a standing rule against — "a step count is a weight-loss signal for
     * one person, a weight-GAIN signal for another". A goal of walking LESS while
     * recovering from an injury was stored as a goal of walking more, and the
     * Activity surface would then have reported his recovery as a shortfall.
     * 'up' remains the common case and is the caller's default, but it is the
     * caller's, stated at the point where he actually said something.
     */
    signals: detail.metric
      ? [{
          metric: detail.metric,
          source: detail.source ?? null,
          direction: detail.direction ?? 'up',
          target: detail.target,
          unit: detail.unit,
        }]
      : [],
    surfaces: [],
    by: 'user',
    confidence: 1,
    basis: [],
  })
  p.updatedAt = now.toISOString()
  return g.id
}

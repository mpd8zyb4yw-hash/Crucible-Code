/**
 * THE PEOPLE IN HIS LIFE, AND THE ONE THING WE REFUSE TO GUESS ABOUT THEM.
 *
 * `Person` has been in the typed model since it landed and `p.people` has been
 * empty ever since, because nothing lifted anybody out of his data. The data is
 * full of them: every calendar event carries `attendees[]` with names and email
 * addresses, every message carries `from` and `fromName`. Anna and Paolo are
 * named on the dinner on the 12th, structurally, in a field.
 *
 * THE HARD RULE, AND THE REASON THIS FILE IS SEPARATE FROM THE LIFTER.
 *
 *     A RELATIONSHIP IS NEVER INFERRED FROM AN EMAIL ADDRESS OR FROM EVENT
 *     ATTENDANCE.
 *
 * Both are extremely tempting and both are wrong in ways that do real damage.
 *
 *   · The address. `anna@gmail.com` looks personal and `anna@acme.co.uk` looks
 *     like work, so it is one line of code to write `relationship: 'colleague'`.
 *     Freelancers use personal addresses with clients. Family members work
 *     together. Someone's only address is the one their employer gave them. The
 *     domain is a fact about a mail provider and says nothing whatsoever about
 *     who two people are to each other.
 *
 *   · The attendance. Sharing a dinner does not make someone a friend, being on
 *     a recurring meeting does not make them a colleague, and appearing on a
 *     hospital appointment does not make them family. This is the specific
 *     inference that leads to "Jamie gives me lifts" — a claim the app would then
 *     act on, suggesting he ask a stranger for a ride.
 *
 * So what is lifted is IDENTITY and CONTACT — a name Google supplied, an address
 * Google supplied, and the records they came from. `relationship` stays
 * `undefined`, which is a first-class state meaning "nobody has said", and the
 * only thing that fills it is him. `demand()` records when something wanted it,
 * and the `relationship` correction verb is how it gets answered.
 *
 * The distinction is already in the type — `relationship` is a `Fact` with a
 * source and a confidence while `contact` is a plain string — and this file is
 * what makes the type's promise true.
 */

import type { Observation, World } from './world.js'
import {
  demand,
  type Fact,
  type Person,
  type Person_,
} from './person.js'

/** What one pass learned, for the build log. Never silently empty-handed. */
export interface PeopleRun {
  added: string[]
  enriched: string[]
  /** Candidates deliberately skipped, with the reason. */
  skipped: { name: string; why: string }[]
}

/**
 * Addresses that are not people.
 *
 * Matched on the LOCAL PART and on well-known no-reply shapes, because that is
 * where senders declare themselves to be machines. This is a filter on whether a
 * mailbox is a human at all — not on what kind of human, which is the thing this
 * file refuses to judge.
 */
const NOT_A_PERSON =
  /^(no-?reply|noreply|do-?not-?reply|donotreply|notifications?|alerts?|info|support|help|contact|hello|hi|team|admin|billing|invoices?|receipts?|orders?|sales|marketing|newsletter|news|updates?|mailer|postmaster|bounce|automated|system|security|account|service)([-.+]|$)/i

/**
 * A display name that is a person's name rather than a brand.
 *
 * Deliberately loose and deliberately not clever. It rejects the obvious
 * non-people — anything with a URL, anything that is one word and also the mail
 * domain, anything that reads as a company suffix — and accepts everything else.
 * A brand that slips through becomes a `Person` with no relationship and no role,
 * which is a harmless row he can correct; a real person wrongly rejected is
 * someone the app cannot talk about at all, which is worse.
 */
function looksLikeAName(name: string, email?: string): boolean {
  const n = name.trim()
  if (n.length < 2 || n.length > 60) return false
  if (/https?:|www\.|@/.test(n)) return false
  if (/\b(ltd|llc|inc|gmbh|s\.?r\.?l|spa|team|support|notifications?|newsletter|noreply)\b/i.test(n)) return false
  // "Acme" from acme.com is the company, not a person there.
  const domain = email?.split('@')[1]?.split('.')[0]
  if (domain && n.toLowerCase() === domain.toLowerCase()) return false
  return true
}

/**
 * IS THIS MAILBOX A HUMAN AT ALL?
 *
 * Exported so the memory core's entity resolver asks THIS question rather than
 * writing its own. The two systems resolve people from the same records for
 * different purposes, and the moment they disagree about what a person is, one
 * of them is holding a graph of shops and the other is not — with no way to tell
 * which is right from either side.
 *
 * Both halves are needed and they catch different things: the address filter
 * rejects `newsletter@`, and the name filter rejects a human-looking address
 * whose display name is plainly a brand. Returning the REASON rather than a
 * boolean is what lets both callers put it in a build log, which is how the
 * false rejections get found.
 */
/**
 * THE MAILBOX OUT OF AN ADDRESS FIELD. `Anthropic <no-reply@x>` → `no-reply@x`.
 *
 * This exists because of a real false positive, found by running the memory core
 * over his actual mail rather than over a fixture. Gmail's `From` header is
 * `Display Name <address>`, and both resolvers were using the WHOLE STRING as the
 * person's identity. Four things went wrong at once, all of them invisible:
 *
 *   · `personMailboxCheck` split on '@' to get the local part and got
 *     `anthropic <no-reply-ipaixkkl3evymuhaquigbg`, which `NOT_A_PERSON` is
 *     anchored at the start of and therefore cannot match. Every automated
 *     sender WITH A DISPLAY NAME sailed through — six of the seven people in his
 *     real world model were machines.
 *   · two different no-reply addresses at one domain became two entities, both
 *     called "Anthropic".
 *   · his own outbound mail was classed inbound, because `from === me` compared
 *     `serg <cruciblecode1@gmail.com>` against `cruciblecode1@gmail.com`.
 *   · and so HE was resolved as a counterparty in his own life.
 *
 * The §17 note about the Coop's newsletter says the fix for "is this mailbox a
 * human" is that both resolvers must ask ONE function, so they cannot answer
 * differently. That was right and it was not enough: they were also both
 * PARSING the address, separately and identically wrongly. So the parse lives
 * here too, beside the question it feeds.
 *
 * A list — `a@x, b@y` — yields the first address. Every caller wants a single
 * counterparty, and the alternative is each of them picking one its own way.
 */
export function mailbox(raw?: string | null): string | undefined {
  if (!raw) return undefined
  /* Angle brackets first: a quoted display name may itself contain a comma
     ("Anthropic, PBC"), so splitting on punctuation before finding the address
     is how `PBC" <invoice@…>` becomes somebody's email address. */
  const angled = /<\s*([^<>\s]+@[^<>\s]+?)\s*>/.exec(raw)
  if (angled) return angled[1]!.toLowerCase()
  const bare = /([^\s,;<>"()]+@[^\s,;<>"()]+)/.exec(raw)
  return bare ? bare[1]!.toLowerCase().replace(/[.,;]+$/, '') : undefined
}

export function personMailboxCheck(name: string, email?: string): { ok: true } | { ok: false; why: string } {
  /* Parsed again here even though every caller now passes a bare address. The
     redundancy is deliberate and cheap: this is the function that decides
     whether a machine becomes a person, and the failure above was silent for as
     long as it existed. `mailbox` is idempotent on an address. */
  const address = mailbox(email) ?? email
  const local = address?.split('@')[0] ?? ''
  if (address && NOT_A_PERSON.test(local)) return { ok: false, why: 'the address is a mailbox, not a person' }
  if (!looksLikeAName(name, address)) return { ok: false, why: "does not read as a person's name" }
  return { ok: true }
}

const idFor = (name: string, email?: string): string =>
  `person:${(email || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}`

/**
 * A name, tidied but not reinvented.
 *
 * Gmail writes `"Anna Rossi" <anna@…>` and sometimes `Rossi, Anna`. Both are
 * turned into "Anna Rossi"; anything else is left exactly as the source wrote it,
 * because a name is the one field where being clever is most likely to be rude.
 */
function tidyName(raw: string): string {
  let n = raw.trim().replace(/^["']|["']$/g, '').trim()
  const surnameFirst = /^([^,]{2,30}),\s*([^,]{2,30})$/.exec(n)
  if (surnameFirst) n = `${surnameFirst[2]!.trim()} ${surnameFirst[1]!.trim()}`
  return n
}

/** A name derived from an address, for someone whose display name we never got. */
const nameFromEmail = (email: string): string =>
  email
    .split('@')[0]!
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')

interface Candidate {
  name: string
  email?: string
  obsId: string
  /** What kind of record named them. Stored as provenance, NOT as a relationship. */
  via: 'event-attendee' | 'event-organizer' | 'email-sender' | 'email-recipient'
  at: string
}

/**
 * Everyone his structured records name.
 *
 * Reads `data` and nothing else — no regex over prose anywhere in this file. That
 * is the other half of "remove regex dependence where structured source
 * information already exists": the attendee list is a typed array of typed
 * objects, and reaching for a name in a sentence when that array is right there
 * was never defensible.
 */
function candidatesFrom(obs: Observation[], me?: string): Candidate[] {
  const out: Candidate[] = []
  /* Through `mailbox` too, so "he" is the same string shape as everybody else.
     A caller handing this `Serg <x@y>` used to make every self-comparison fail. */
  const mine = mailbox(me) ?? me?.toLowerCase()

  for (const o of obs) {
    const d = o.data
    if (d?.kind === 'event') {
      for (const a of d.attendees ?? []) {
        const email = mailbox(a.email)
        if (!email || email === mine) continue
        out.push({
          name: tidyName(a.name?.trim() || nameFromEmail(email)),
          email,
          obsId: o.id,
          via: 'event-attendee',
          at: o.at,
        })
      }
      const organizer = mailbox(d.organizer)
      if (organizer && organizer !== mine) {
        out.push({
          name: tidyName(nameFromEmail(organizer)),
          email: organizer,
          obsId: o.id,
          via: 'event-organizer',
          at: o.at,
        })
      }
    }
    if (d?.kind === 'email') {
      const email = mailbox(d.from)
      if (email && email !== mine) {
        out.push({
          name: tidyName(d.fromName?.trim() || nameFromEmail(email)),
          email,
          obsId: o.id,
          via: 'email-sender',
          at: o.at,
        })
      }
    }
  }
  return out
}

/**
 * How many independent records it takes before someone is a person in his life.
 *
 * One appearance is not enough for a MAIL sender — a single message from an
 * address is as likely to be a shop as a friend — but one appearance IS enough for
 * a named calendar attendee, because being invited to something together is a
 * deliberate act by one of them. The asymmetry is about how much intent the record
 * carries, not about what the relationship is.
 */
const MAIL_APPEARANCES = 2

export function liftPeople(p: Person_, w: Pick<World, 'observations'>, me?: string): PeopleRun {
  const run: PeopleRun = { added: [], enriched: [], skipped: [] }
  const candidates = candidatesFrom(w.observations, me)

  // Grouped by identity so the threshold counts APPEARANCES rather than records.
  const groups = new Map<string, Candidate[]>()
  for (const c of candidates) {
    const key = idFor(c.name, c.email)
    const list = groups.get(key)
    if (list) list.push(c)
    else groups.set(key, [c])
  }

  for (const [id, group] of groups) {
    const first = group[0]!
    const email = group.find((c) => c.email)?.email
    // Through the exported check, so this file and the memory core's resolver
    // cannot drift into two different answers about what a person is.
    const human = personMailboxCheck(first.name, email)
    if (!human.ok) {
      run.skipped.push({ name: first.name, why: human.why })
      continue
    }
    const calendarNamed = group.some((c) => c.via === 'event-attendee' || c.via === 'event-organizer')
    if (!calendarNamed && group.length < MAIL_APPEARANCES) {
      run.skipped.push({ name: first.name, why: `only ${group.length} appearance, and only in mail` })
      continue
    }

    const basis = [...new Set(group.map((c) => c.obsId))]
    const at = group.map((c) => c.at).sort().slice(-1)[0]!
    const held = p.people.find((x) => x.id === id)

    if (!held) {
      /**
       * NOTE WHAT IS ABSENT: there is no `relationship` here, and no `roles`.
       *
       * Everything this constructs is something a connector asserted. `via` is
       * recorded in the basis and in nothing else — it is how we came to know the
       * name, and it is not evidence of what they are to him.
       */
      const person: Person = {
        id,
        name: first.name,
        roles: [],
        contact: email ? { email } : undefined,
        basis,
        by: 'agent',
        updatedAt: at,
      }
      p.people.push(person)
      run.added.push(`${person.name}${email ? ` <${email}>` : ''}`)
      p.updatedAt = new Date().toISOString()
      continue
    }

    /**
     * ENRICH, NEVER OVERWRITE WHAT HE SET.
     *
     * The name is the field at risk: he may have corrected "A. Rossi" to "Anna",
     * and a sync that re-reads the calendar must not put it back. The same
     * ownership rule as everywhere else — `by: 'user'` is a lock.
     */
    let moved = false
    const merged = [...new Set([...held.basis, ...basis])]
    if (merged.length !== held.basis.length) {
      held.basis = merged
      moved = true
    }
    if (email && held.contact?.email !== email) {
      held.contact = { ...held.contact, email }
      moved = true
    }
    if (held.by !== 'user' && held.name !== first.name) {
      held.name = first.name
      moved = true
    }
    if (moved) {
      held.updatedAt = at
      p.updatedAt = new Date().toISOString()
      run.enriched.push(held.name)
    }
  }

  return run
}

// ── Reading people back ──────────────────────────────────────────────────────

/** Someone by id, or by the email a record named. Never by fuzzy name match. */
export function personById(p: Person_, id: string): Person | undefined {
  return p.people.find((x) => x.id === id)
}

export function personByEmail(p: Person_, email: string): Person | undefined {
  const e = email.toLowerCase()
  return p.people.find((x) => x.contact?.email?.toLowerCase() === e)
}

/**
 * Who is on an event, as people we actually hold.
 *
 * Returns the typed `Person` records rather than the raw attendee objects,
 * because the whole value is in the join: an attendee is an address on a record,
 * a `Person` is someone with a history and possibly a relationship he has stated.
 */
export function peopleOnEvent(
  p: Person_,
  attendees: { email: string; name?: string }[] | undefined
): Person[] {
  const out: Person[] = []
  for (const a of attendees ?? []) {
    const found = a.email ? personByEmail(p, a.email) : undefined
    if (found && !out.includes(found)) out.push(found)
  }
  return out
}

/** What he has said someone is to him, or null. Never a guess. */
export function relationshipOf(person: Person): Fact<string> | null {
  const held = person.relationship
  if (!held || typeof held.value !== 'string' || !held.value.trim()) return null
  return held
}

/**
 * Record that something needed to know who someone is.
 *
 * The demand key is per-person, so the question that eventually reaches him is
 * about a named human rather than about "relationships" in the abstract. Reads
 * exactly like every other demand and is answered by the `relationship`
 * correction verb.
 */
export function demandRelationship(
  p: Person_,
  person: Person,
  why: string,
  /**
   * When the answer stops being useful — the start of the event this is about.
   *
   * Passed so the question can out-rank the chronic ones. Without it a
   * relationship question is asked purely on how many things have wanted it, which
   * is once, so it loses the single Home slot to a gap that has been re-demanded on
   * every build for a month. See `demand`.
   */
  before?: string
): void {
  demand(p, `person.${person.id}.relationship`, why, { before })
}

/**
 * The chips for a relationship question about one person.
 *
 * OPEN, and the last one matters most. A closed list of five kinship terms would
 * be the same categorising mistake the rest of this codebase avoids — "someone I
 * sometimes get a lift from" is the answer that would actually change a plan, and
 * it is not on anybody's dropdown. So the options are common starting points and
 * a freeform reply is always accepted.
 *
 * Note what is NOT offered: nothing here is pre-selected or pre-filled from the
 * record. The app is asking because it does not know.
 */
export function relationshipOptions(): { value: string; label: string }[] {
  return [
    { value: 'friend', label: 'A friend' },
    { value: 'family', label: 'Family' },
    { value: 'colleague', label: 'Someone I work with' },
    { value: 'neighbour', label: 'A neighbour' },
    { value: 'not-close', label: 'Not someone I know well' },
  ]
}

// ── Would he ask this person for a lift? ─────────────────────────────────────

/**
 * A SEPARATE FACT FROM THE RELATIONSHIP, AND THE SEPARATION IS THE WHOLE POINT.
 *
 * The tempting shortcut is one step further along the road this file's header is
 * about. Having refused to infer a relationship from attendance, the next thing
 * that looks harmless is inferring the ASK from the relationship: he said Paolo
 * is a friend, friends give each other lifts, therefore offer to ask Paolo for a
 * lift. That is wrong in exactly the same way and does more damage, because the
 * output is not a label in a data structure — it is a draft message to a real
 * person, about a favour, sent in his name.
 *
 * People do not lend cars along kinship lines. A brother who does not drive, a
 * colleague who lives on the same road and always offers, a close friend it
 * would be mortifying to ask: every one of those is common and none of them is
 * derivable from the word "friend". So this is its own stored fact, set only by
 * him, with no rule anywhere that populates it from anything else.
 *
 * `'ask'` is not a promise that they will say yes. It means "this is a person I
 * would ask", which is the only thing he is in a position to tell us and the
 * only thing the app needs in order to be useful.
 */
export type LiftStance = 'ask' | 'never'

/** The preference key. Per person, because this is a fact about one person. */
export const liftKey = (personId: string): string => `transport.lift.${personId}`

/**
 * What he has said about asking this person for a lift, or null.
 *
 * Null is a first-class answer meaning nobody has said, and it is the state the
 * card has to be honest about: "I do not know whether either of them is someone
 * you would ask" is a true and useful sentence. Guessing is not.
 */
export function liftStanceOf(p: Person_, personId: string): Fact<string> | null {
  const held = p.preferences[liftKey(personId)]
  if (!held || typeof held.value !== 'string') return null
  if (held.value !== 'ask' && held.value !== 'never') return null
  return held as Fact<string>
}

/** The two chips a lift question offers, in his words rather than the model's. */
export function liftOptions(name: string): { value: LiftStance; label: string }[] {
  return [
    { value: 'ask', label: `I'd ask ${name} for a lift` },
    { value: 'never', label: `Not ${name}` },
  ]
}

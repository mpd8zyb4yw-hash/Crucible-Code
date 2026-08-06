// ── One sentence → a whole automation ──────────────────────────────────────────
// The old create flow asked for FIVE decisions before you could save anything: pick a
// template, name it, write a "brief", choose a trigger kind and configure it, then
// understand what "delivery: digest | push" meant. That is a form, not an assistant —
// and it is why the page felt clunky enough to put someone off using Crucible at all.
//
// This module is what replaces it. You write one sentence the way you'd say it out loud
// ("summarise my inbox every morning"), and everything else is DERIVED: the schedule,
// the name, and how the result reaches you. The UI shows what it understood as editable
// chips, so inference is never a black box you have to accept blind.
//
// SCHEDULE PARSING IS NOT DUPLICATED HERE. `CrucibleEngine/automations/parseTrigger.ts`
// (cont.119) already turns prose into a Trigger, it is the same code the agent's own
// scheduling tool uses, and it is bench-covered (70/70). Writing a second parser for the
// UI would mean the button and the assistant could disagree about what "every morning"
// means — so this delegates, and the two fixes this UI work surfaced (a part-of-day word
// must beat the bare-hour PM guess; a quantity in the task is not a clock time) were made
// THERE, where the agent path gets them too.
//
// What is genuinely UI-only, and so lives here: deriving a short title, reading the
// delivery cue, and rendering a Trigger back into words for the confirmation chip.

import { parseTrigger } from '../CrucibleEngine/automations/parseTrigger'

// ONE declaration, shared with the engine (triggerTypes.ts is pure types, so importing
// it pulls no Node built-ins into the browser bundle).
export type { Trigger } from '../CrucibleEngine/automations/triggerTypes'
import type { Trigger } from '../CrucibleEngine/automations/triggerTypes'

const DAY_NAME_LIST = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export interface ParsedAutomation {
  /** Short title derived from the sentence with the schedule words removed. */
  name: string
  /** The user's own sentence — handed to the planner verbatim. */
  brief: string
  trigger: Trigger
  delivery: 'digest' | 'push'
  /** The exact substring that produced the schedule, so the UI can show its work. */
  matchedSchedule: string | null
  /** False when no schedule phrase was found and the default was applied. */
  scheduleExplicit: boolean
  /** False when no push/notify cue was found. */
  deliveryExplicit: boolean
}

/** Words that describe WHEN, stripped out of the derived name. */
const SCHEDULE_WORDS = new RegExp(
  String.raw`\b(every|each|daily|weekly|hourly|nightly|morning|mornings|afternoon|afternoons|evening|evenings|night|nights|midday|noon|lunchtime|weekday|weekdays|weekend|weekends|day|days|week|weeks|hour|hours|minute|minutes|min|mins|` +
  DAY_NAME_LIST.join('s?|') + String.raw`s?|at\s+\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?|\d+)\b`,
  'gi',
)

/** Leading verbs/pronouns that make a poor title ("summarise my inbox" → "Inbox"). */
const NAME_LEAD = /^\s*(please\s+)?(can you\s+|could you\s+)?(keep an eye on|keep track of|watch out for|watch|check|monitor|summari[sz]e|summary of|tell me about|let me know about|notify me( about| when| if)?|alert me( about| when| if)?|ping me( about| when| if)?|remind me( about| to)?|send me|give me|show me|track|report on|look at|look for|scan|review|update me on)\s+/i
const NAME_POSSESSIVE = /^(my|the|a|an|our)\s+/i

/**
 * A short human title from the sentence: drop the leading command verb, drop the
 * schedule words, keep the first few meaningful words, sentence-case it.
 */
export function deriveName(sentence: string): string {
  let s = (sentence ?? '').trim()
  if (!s) return 'Untitled automation'
  s = s.replace(NAME_LEAD, '')
  s = s.replace(SCHEDULE_WORDS, ' ')
  s = s.replace(/\band\s+(then\s+)?$/i, ' ')
  s = s.replace(/[.,;:!?]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  s = s.replace(NAME_POSSESSIVE, '')
  if (!s) return (sentence ?? '').trim().slice(0, 60) || 'Untitled automation'
  const words = s.split(/\s+/).slice(0, 6)
  const out = words.join(' ')
  return (out.charAt(0).toUpperCase() + out.slice(1)).slice(0, 80)
}

/** "notify me", "push", "alert me" → a push; everything else lands in the digest. */
export function parseDelivery(sentence: string): { delivery: 'digest' | 'push'; explicit: boolean } {
  const s = (sentence ?? '').toLowerCase()
  if (/\b(notify|alert|ping|push|text me|buzz)\b/.test(s)) return { delivery: 'push', explicit: true }
  return { delivery: 'digest', explicit: false }
}

/** The default when the sentence says nothing about timing. Stated once, here. */
export const DEFAULT_TRIGGER: Trigger = { kind: 'daily', time: '09:00' }

/** Thin wrapper over the engine parser so the UI has one import surface. */
export function parseSchedule(sentence: string, now = Date.now()): { trigger: Trigger; matched: string } | null {
  const r = parseTrigger(sentence ?? '', now)
  if (!r) return null
  // The annotation is the guard: if the engine's union ever gains a kind this one lacks,
  // this assignment stops compiling instead of rendering a blank chip at runtime.
  const trigger: Trigger = r.trigger
  return { trigger, matched: r.description }
}

export function parseAutomation(sentence: string): ParsedAutomation {
  const brief = (sentence ?? '').trim()
  const sched = parseSchedule(brief)
  const del = parseDelivery(brief)
  return {
    name: deriveName(brief),
    brief,
    trigger: sched?.trigger ?? DEFAULT_TRIGGER,
    delivery: del.delivery,
    matchedSchedule: sched?.matched ?? null,
    scheduleExplicit: sched != null,
    deliveryExplicit: del.explicit,
  }
}

// ── Rendering a trigger back into words ────────────────────────────────────────
// The chip has to say what will happen in the same register the user typed it in, or
// the confirmation is not really a confirmation.

export function describeTrigger(t: Trigger): string {
  switch (t.kind) {
    case 'interval':
      if (t.minutes % 1440 === 0) { const d = t.minutes / 1440; return `every ${d} day${d === 1 ? '' : 's'}` }
      if (t.minutes % 60 === 0) { const h = t.minutes / 60; return `every ${h} hour${h === 1 ? '' : 's'}` }
      return `every ${t.minutes} min`
    case 'daily': return `every day at ${friendlyTime(t.time)}`
    case 'weekly': return `every ${cap(DAY_NAME_LIST[t.day] ?? 'monday')} at ${friendlyTime(t.time)}`
    // The engine has a 'weekdays' kind the UI must not render as blank — an existing
    // automation on disk already uses it.
    case 'weekdays': return `every weekday at ${friendlyTime(t.time)}`
    case 'once': return `once, on ${new Date(t.at).toLocaleString()}`
  }
}

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1) }

/** 24h "08:00" → "8:00 AM", matching how the rest of the app prints clock times. */
export function friendlyTime(hhmm: string): string {
  const [hs, ms] = (hhmm ?? '').split(':')
  const h = parseInt(hs, 10), m = parseInt(ms, 10)
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

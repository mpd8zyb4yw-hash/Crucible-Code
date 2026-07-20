// ── Automations store (Assistant layer, step 1 — see ASSISTANT_SPEC.md) ────────
// An automation = trigger + brief + delivery, persisted as plain JSON. Execution is
// NOT here: the scheduler in server.ts fires due automations through the exact same
// /api/chat agent loop a Mission Control launch uses — one execution path, journaled
// like any other run. This module is pure data + next-run math (deterministic,
// no Date.now() defaults so it stays trivially testable).

import fs from 'fs'
import path from 'path'

export type Trigger =
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily'; time: string }                 // 'HH:MM', server-local time
  | { kind: 'weekly'; day: number; time: string }   // day: 0=Sunday … 6=Saturday
  | { kind: 'once'; at: number }                    // epoch ms

export interface AutomationRun {
  ts: number
  status: 'ok' | 'failed'
  summary: string        // short text for digest cards (ok: answer head; failed: error text)
  /** FULL final answer, capped generously (24k). The whole value of an automation is its
   *  output — truncating it to a card blurb made every digest entry a dead end (2026-07-20
   *  user finding). Optional so pre-existing run records stay valid. */
  answer?: string
  ms: number
}

export interface Automation {
  id: string
  userId: string
  name: string
  brief: string
  trigger: Trigger
  delivery: 'digest' | 'push'   // digest = in-app feed only; push additionally notifies
  enabled: boolean
  createdAt: number
  lastRuns: AutomationRun[]     // newest first, capped
  consecutiveFailures: number
  nextRun: number | null        // epoch ms; null = never (spent 'once', or disabled)
}

// Same store root as server.ts's CRUCIBLE_DIR (cwd-relative, like selfPlay.ts).
const FILE = path.join(process.env.CRUCIBLE_DIR ?? path.resolve(process.cwd(), '.crucible'), 'automations.json')
const MAX_RUNS_KEPT = 20
export const MAX_CONSECUTIVE_FAILURES = 3   // then auto-disable — silence is never success

export function loadAutomations(): Automation[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch { return [] }
}

export function saveAutomations(list: Automation[]): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(list, null, 2))
  } catch { /* disk-full etc: next save retries; runs are also in the session arc */ }
}

function nextAtTime(from: number, time: string, dayOfWeek?: number): number {
  const [h, m] = time.split(':').map(Number)
  const d = new Date(from)
  d.setHours(h, m, 0, 0)
  if (dayOfWeek == null) {
    if (d.getTime() <= from) d.setDate(d.getDate() + 1)
  } else {
    let delta = (dayOfWeek - d.getDay() + 7) % 7
    if (delta === 0 && d.getTime() <= from) delta = 7
    d.setDate(d.getDate() + delta)
  }
  return d.getTime()
}

/** Next fire time strictly after `from`. null = never fires again. */
export function computeNextRun(trigger: Trigger, from: number): number | null {
  switch (trigger.kind) {
    case 'interval': return from + Math.max(1, trigger.minutes) * 60_000
    case 'daily':    return nextAtTime(from, trigger.time)
    case 'weekly':   return nextAtTime(from, trigger.time, ((trigger.day % 7) + 7) % 7)
    case 'once':     return trigger.at > from ? trigger.at : null
  }
}

/** Human-readable trigger, for list rows and the create-form preview. */
export function describeTrigger(t: Trigger): string {
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  switch (t.kind) {
    case 'interval': return t.minutes % 60 === 0 ? `every ${t.minutes / 60}h` : `every ${t.minutes}m`
    case 'daily':    return `daily at ${t.time}`
    case 'weekly':   return `${DAYS[((t.day % 7) + 7) % 7]}s at ${t.time}`
    case 'once':     return `once, ${new Date(t.at).toLocaleString()}`
  }
}

export function recordRun(a: Automation, run: AutomationRun, now: number): void {
  a.lastRuns.unshift(run)
  a.lastRuns.length = Math.min(a.lastRuns.length, MAX_RUNS_KEPT)
  a.consecutiveFailures = run.status === 'failed' ? a.consecutiveFailures + 1 : 0
  if (a.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    a.enabled = false            // surfaced in the digest — never silently retried forever
    a.nextRun = null
  } else {
    a.nextRun = a.enabled ? computeNextRun(a.trigger, now) : null
  }
}

/** Earliest-due enabled automation at `now`, or null. One at a time by design. */
export function pickDue(list: Automation[], now: number): Automation | null {
  const due = list.filter(a => a.enabled && a.nextRun != null && a.nextRun <= now)
  due.sort((x, y) => (x.nextRun! - y.nextRun!))
  return due[0] ?? null
}

export function validateTrigger(t: unknown): t is Trigger {
  if (!t || typeof t !== 'object') return false
  const o = t as Record<string, unknown>
  const validTime = (s: unknown) => typeof s === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(s)
  switch (o.kind) {
    case 'interval': return typeof o.minutes === 'number' && o.minutes >= 1 && o.minutes <= 7 * 24 * 60
    case 'daily':    return validTime(o.time)
    case 'weekly':   return typeof o.day === 'number' && o.day >= 0 && o.day <= 6 && validTime(o.time)
    case 'once':     return typeof o.at === 'number' && Number.isFinite(o.at)
    default:         return false
  }
}

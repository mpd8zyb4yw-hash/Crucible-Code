// ── Deferred work waiting on a human sign-in (cont.119) ───────────────────────
//
// The product requirement, in the owner's words: "if the user is prompted to sign in for
// something, the agent can pick up where it needs to afterwards IN THE BACKGROUND, so the user
// isn't forced to watch the agent work and they can do their own thing."
//
// That makes a sign-in an ASYNCHRONOUS event with an unbounded delay — minutes, or tomorrow —
// so the goal that needed it cannot live in a request that is still open, and cannot live only
// in memory either: the user may sign in after a server restart. It lives here, on disk, next
// to the automations that share its execution path.
//
// Deliberately NOT an Automation: an automation is a standing, repeating instruction the user
// authored, and it would show up in their automations list forever. This is a one-shot
// continuation of a request they already made. Same runner, different lifetime.

import fs from 'fs'
import path from 'path'

export interface PendingSignIn {
  id: string
  /** Owner — the resumed run executes as this user, and the result is delivered to them. */
  userId: string
  /** Host whose session we are waiting to appear (youtube.com), which may differ from the
   *  sign-in URL's host (accounts.google.com). */
  host: string
  /** The page the window was opened at. */
  url: string
  /** The ORIGINAL request, replayed verbatim once the session exists. */
  goal: string
  /** Project the browser profile and the resumed run belong to. */
  projectPath: string
  /** Conversation to thread the resumed answer back into, so it lands where the user asked. */
  sessionId: string
  createdAt: number
  expiresAt: number
  status: 'waiting' | 'resumed' | 'expired'
  /** Set when status flips, for the digest card. */
  resolvedAt?: number
}

const FILE = path.join(
  process.env.CRUCIBLE_DIR ?? path.resolve(process.cwd(), '.crucible'),
  'pending-signin.json',
)

/** A sign-in nobody completes must not wait forever — but a day is the right order of
 *  magnitude for "I'll do it when I get to my desk", not the 30 minutes an agent run gets. */
export const SIGN_IN_TTL_MS = 24 * 60 * 60_000

export function loadPendingSignIns(): PendingSignIn[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch { return [] }
}

export function savePendingSignIns(list: PendingSignIn[]): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(list, null, 2))
  } catch { /* disk full etc — the next save retries */ }
}

/**
 * Park a goal against a host's sign-in.
 *
 * Re-parking the same host for the same user REPLACES the previous entry rather than stacking:
 * a user who asks twice wants the newer request resumed, not both, and two resumes firing off
 * one sign-in would be the kind of surprise autonomy that erodes trust.
 */
export function parkSignIn(
  entry: Omit<PendingSignIn, 'id' | 'createdAt' | 'expiresAt' | 'status'>,
  now: number,
): PendingSignIn {
  const list = loadPendingSignIns().filter(
    p => !(p.status === 'waiting' && p.host === entry.host && p.userId === entry.userId),
  )
  const parked: PendingSignIn = {
    ...entry,
    id: `signin-${now}-${Math.abs(hash(entry.host + entry.goal))}`,
    createdAt: now,
    expiresAt: now + SIGN_IN_TTL_MS,
    status: 'waiting',
  }
  list.push(parked)
  savePendingSignIns(list)
  return parked
}

/** Deterministic id suffix — `Math.random` would make the store untestable. */
function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

export function waitingSignIns(list: PendingSignIn[], now: number): PendingSignIn[] {
  return list.filter(p => p.status === 'waiting' && p.expiresAt > now)
}

/** Flip status and persist. Returns the updated list so a caller can keep working with it. */
export function settleSignIn(id: string, status: 'resumed' | 'expired', now: number): PendingSignIn[] {
  const list = loadPendingSignIns()
  const p = list.find(x => x.id === id)
  if (p) { p.status = status; p.resolvedAt = now }
  savePendingSignIns(list)
  return list
}

/** Mark everything past its TTL, so a stale park stops being polled and is visible as expired
 *  rather than vanishing. Returns the ids that just expired. */
export function expireStale(now: number): string[] {
  const list = loadPendingSignIns()
  const expired: string[] = []
  for (const p of list) {
    if (p.status === 'waiting' && p.expiresAt <= now) { p.status = 'expired'; p.resolvedAt = now; expired.push(p.id) }
  }
  if (expired.length) savePendingSignIns(list)
  return expired
}

/**
 * Doing things, as opposed to knowing things.
 *
 * Retrieval and reasoning read. A plan cannot send, book, buy or delete — the
 * IR has no node for it, and the executor has no code path to one. Everything
 * that changes the world outside this app comes through here instead, and the
 * boundary is deliberate:
 *
 *   observe → plan → present → AUTHORISE → execute → record
 *
 * A pane may OFFER an action. Offering is presentation. Performing it requires
 * an authorisation that names who granted it and what they were looking at when
 * they did, and produces a record that survives the pane, the revision and the
 * session. That record is the only way to answer "why did it do that", and the
 * only way to know what can still be taken back.
 *
 * Nothing here knows what any particular action does. A handler is registered
 * with the connector that implements it, exactly like a source adapter.
 */

export type Authoriser =
  /** He tapped the thing, having seen it. The only authority for anything new. */
  | { by: 'user'; paneId?: string; revisionId?: string; confirmed?: boolean }
  /** A standing rule he set earlier, named so it can be found and revoked. */
  | { by: 'policy'; policyId: string; grantedAt: string }
  /** The app on its own. Only ever for reversible, invisible-to-others work. */
  | { by: 'system'; why: string }

export interface ActionRecord {
  id: string
  kind: string
  params: Record<string, unknown>
  /** What made this permissible. Never inferred, never defaulted to 'user'. */
  authorisedBy: Authoriser
  at: string
  outcome: 'ok' | 'failed' | 'refused'
  /** Provider's own id for what was created, when there is one. */
  result?: string
  error?: string
  /**
   * How to take it back, if it can be taken back at all.
   *
   * `undoable: false` is a statement, not an absence — sending an email is
   * final and the record has to say so rather than leaving it unknown.
   */
  undo?: { kind: string; params: Record<string, unknown> } | null
  undoneBy?: string
}

export interface ActionStore {
  read(): Promise<ActionRecord[] | null>
  write(records: ActionRecord[]): Promise<void>
}

let store: ActionStore | null = null

export function setActionStore(s: ActionStore): void {
  store = s
}

export function kvActionStore(kv: KVNamespace, key = 'actions'): ActionStore {
  return {
    async read() {
      const raw = await kv.get(key)
      return raw ? (JSON.parse(raw) as ActionRecord[]) : null
    },
    async write(records) {
      await kv.put(key, JSON.stringify(records))
    },
  }
}

/** Kept long enough to answer for itself. Oldest fall off first. */
const MAX_RECORDS = 2000

export interface ActionHandler {
  /**
   * True when the effect is visible to someone else or cannot be taken back.
   * Such an action requires `confirmed: true` from the user; there is no flag
   * anywhere that waives it.
   */
  irreversible?: boolean
  /** Perform it. Returns a provider id and, when possible, how to reverse it. */
  run(params: Record<string, unknown>): Promise<{ id?: string; undo?: ActionRecord['undo'] }>
}

const handlers = new Map<string, ActionHandler>()

export function registerAction(kind: string, handler: ActionHandler): void {
  handlers.set(kind, handler)
}

export function registeredActions(): string[] {
  return [...handlers.keys()]
}

export function isIrreversible(kind: string): boolean {
  return handlers.get(kind)?.irreversible === true
}

let seq = 0

/**
 * Perform an action, or refuse it, and write down which happened.
 *
 * A refusal is recorded exactly like a success. "It didn't do anything" and
 * "it declined because nobody confirmed it" are different answers, and the log
 * is worth nothing if it only contains the things that worked.
 */
export async function perform(
  kind: string,
  params: Record<string, unknown>,
  authorisedBy: Authoriser
): Promise<ActionRecord> {
  const at = new Date().toISOString()
  seq = (seq + 1) % 4096
  const base = { id: `act_${Date.parse(at).toString(36)}${seq.toString(36).padStart(3, '0')}`, kind, params, authorisedBy, at }

  const handler = handlers.get(kind)
  if (!handler) return record({ ...base, outcome: 'refused', error: `I don't know how to do "${kind}".` })

  if (handler.irreversible && !(authorisedBy.by === 'user' && authorisedBy.confirmed)) {
    return record({
      ...base,
      outcome: 'refused',
      error: 'This cannot be taken back, so it needs you to confirm it.',
    })
  }

  try {
    const out = await handler.run(params)
    return record({ ...base, outcome: 'ok', result: out.id, undo: handler.irreversible ? null : (out.undo ?? null) })
  } catch (e) {
    return record({ ...base, outcome: 'failed', error: (e as Error).message.slice(0, 300) })
  }
}

async function record(r: ActionRecord): Promise<ActionRecord> {
  if (!store) return r
  const existing = (await store.read()) ?? []
  await store.write([r, ...existing].slice(0, MAX_RECORDS))
  return r
}

/** Reverse an action that said it could be reversed. Itself an action. */
export async function undoAction(id: string, authorisedBy: Authoriser): Promise<ActionRecord | null> {
  if (!store) return null
  const records = (await store.read()) ?? []
  const target = records.find((r) => r.id === id)
  if (!target?.undo || target.outcome !== 'ok' || target.undoneBy) return null

  const done = await perform(target.undo.kind, target.undo.params, authorisedBy)
  if (done.outcome === 'ok') {
    const updated = ((await store.read()) ?? []).map((r) => (r.id === id ? { ...r, undoneBy: done.id } : r))
    await store.write(updated)
  }
  return done
}

export async function history(limit = 100): Promise<ActionRecord[]> {
  return ((await store?.read()) ?? []).slice(0, limit)
}

/**
 * Whether there is a log to read at all.
 *
 * `history()` answers [] both for "nothing has ever been done" and for "no
 * store is installed", and those mean opposite things to anything reasoning
 * about what the app has done: the first is evidence, the second is the absence
 * of evidence. Callers that would draw a conclusion from an empty log have to
 * be able to tell them apart. See `claimsUnperformedEffect`.
 */
export function historyAvailable(): boolean {
  return store !== null
}

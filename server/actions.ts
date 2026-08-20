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

/**
 * WHAT AN ACTION ACTUALLY DOES TO THE WORLD.
 *
 * The comment at the top of this file says system authority is "only ever for
 * reversible, invisible-to-others work". `perform` did not enforce that: it
 * checked `handler.irreversible` and nothing else, so every action that was not
 * literally `mail.send` — creating a calendar event, changing one, RSVPing to
 * someone else's — could be performed by the app on its own initiative with no
 * confirmation from anybody. The policy was written down and then not applied.
 *
 * "Reversible" was doing two jobs and could only express one. Sending mail and
 * creating an event on a shared calendar are both visible to other people; only
 * one of them can be taken back. Marking an event as reversible therefore made
 * it silently self-authorising, which is exactly how a Home control with no
 * start time wrote a real event into his calendar.
 *
 * So the axis is EFFECT, and it has five values:
 *
 *   read                 answers a question. Changes nothing.
 *   internal             changes only Crucible's own state — a belief, a track,
 *                        a goal. Nobody outside this app can observe it.
 *   private_reversible   makes something real, only he can see it, and it can
 *                        be undone exactly. A draft. An archived message.
 *   external_reversible  someone else can see it, and it can be undone. A
 *                        calendar event on a shared calendar.
 *   irreversible         cannot be taken back. Sending.
 */
export type ActionEffect =
  | 'read'
  | 'internal'
  | 'private_reversible'
  | 'external_reversible'
  | 'irreversible'

/**
 * WHO MAY AUTHORISE WHAT.
 *
 * The line that matters is between `private_reversible` and
 * `external_reversible`: the app may prepare things for him on its own, and it
 * may not do things other people will see. An undo does not change that. Once a
 * colleague's phone has buzzed, deleting the event does not unbuzz it, and
 * "there was an undo" is not consent.
 *
 * A standing policy CAN authorise an externally-visible reversible action —
 * that is what a standing policy is for, and it is named and revocable. Nothing
 * authorises an irreversible action except him, having seen it, saying yes.
 */
const MAY: Record<ActionEffect, ReadonlyArray<Authoriser['by']>> = {
  read: ['user', 'policy', 'system'],
  internal: ['user', 'policy', 'system'],
  private_reversible: ['user', 'policy', 'system'],
  external_reversible: ['user', 'policy'],
  irreversible: ['user'],
}

/** The refusal, in his words rather than in the vocabulary above. */
const REFUSAL: Record<ActionEffect, string> = {
  read: '',
  internal: '',
  private_reversible: '',
  external_reversible: 'Someone else would see this, so I am not doing it on my own.',
  irreversible: 'This cannot be taken back, so it needs you to confirm it.',
}

export interface ActionHandler {
  /**
   * What this does to the world. See `ActionEffect`.
   *
   * DEFAULTS TO THE STRICTEST VALUE. A handler registered without one is
   * treated as irreversible and can only be performed by him, confirmed. That
   * is deliberately annoying: the failure direction for a forgotten annotation
   * must be "it asked when it did not need to", never "it acted when it should
   * not have".
   */
  effect?: ActionEffect
  /**
   * KEPT, AND NOW DERIVED FROM `effect` RATHER THAN BESIDE IT.
   *
   * Still read by `perform` when deciding whether to record an undo. Handlers
   * should set `effect`; this remains for the one thing it was always good at,
   * which is saying "there is no way back from this".
   */
  irreversible?: boolean
  /** Perform it. Returns a provider id and, when possible, how to reverse it. */
  run(params: Record<string, unknown>): Promise<{ id?: string; undo?: ActionRecord['undo'] }>
}

/** The effect this handler declares, at its strictest reading. */
export const effectOf = (h: ActionHandler): ActionEffect =>
  h.effect ?? (h.irreversible ? 'irreversible' : 'irreversible')

const handlers = new Map<string, ActionHandler>()

/**
 * EVERY KIND THIS HOST CAN ACTUALLY PERFORM.
 *
 * Exported so a test can compare what is REGISTERED against what is
 * ADVERTISED. The two drifted — `mail.draft` and `activity.goal` were both
 * implemented, working, and absent from the vocabulary the model is handed, so
 * the assistant could not ask for the one action that is the whole point of
 * "prepare, never send". Nothing could notice, because nothing compared them.
 */
/** What one registered kind does to the world. For the same contract test. */
export const effectOfKind = (kind: string): ActionEffect | null => {
  const h = handlers.get(kind)
  return h ? effectOf(h) : null
}

export function registerAction(kind: string, handler: ActionHandler): void {
  handlers.set(kind, handler)
}

export function registeredActions(): string[] {
  return [...handlers.keys()]
}

/**
 * Read off `effect` rather than off the old flag, so there is one answer to
 * "can this be taken back" and not two that can disagree.
 */
export function isIrreversible(kind: string): boolean {
  return effectOfKind(kind) === 'irreversible'
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

  /**
   * THE POLICY, APPLIED RATHER THAN DESCRIBED.
   *
   * Two questions, in order: may this KIND of authority perform this KIND of
   * effect at all, and — for the one effect where seeing it is the whole point —
   * did he actually confirm.
   */
  const effect = effectOf(handler)
  if (!MAY[effect].includes(authorisedBy.by)) {
    return record({ ...base, outcome: 'refused', error: REFUSAL[effect] })
  }
  if (effect === 'irreversible' && !(authorisedBy.by === 'user' && authorisedBy.confirmed)) {
    return record({ ...base, outcome: 'refused', error: REFUSAL.irreversible })
  }

  try {
    const out = await handler.run(params)
    return record({ ...base, outcome: 'ok', result: out.id, undo: effect === 'irreversible' ? null : (out.undo ?? null) })
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

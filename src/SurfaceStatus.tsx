import { useState } from 'react'
import { css } from './css'
import type { Operation } from './surface/types'

/** What each kind of operation is called while it runs. Shared with kit.tsx's `Op`. */
const VERB: Record<string, string> = {
  search: 'Searching',
  route: 'Finding a route',
  leaveBy: 'Working out when to leave',
  locate: 'Getting your location',
  refresh: 'Refreshing',
  sync: 'Pulling from Google',
}

/**
 * ONE LINE, AT THE SEAM.
 *
 * Three things used to occupy three separate places at the bottom of the app:
 *
 *   · retrieval chatter ("Pulled 2 new things from Google just now.") as chat
 *     bubbles, in the same register and column as the actual conversation;
 *   · every surface operation ("Filtered to unread.") as more chat bubbles;
 *   · the stop/undo bar, as its own row BELOW the composer — which is why the
 *     composer floated 68px above the bottom of the screen whenever anything
 *     had happened.
 *
 * They are one thing: what just happened to the application, and what can be
 * done about it. So they are one line, in one place, at the boundary between
 * the application and the conversation about it — which is exactly what the
 * line is about.
 *
 * Nothing here is silenced. That is the constraint everything else was built
 * around: a change he did not make must never be invisible, and something still
 * running must always be stoppable. What changed is that saying so costs one
 * quiet line instead of a layer.
 */
export function SurfaceStatus({
  note, running, op, canUndo, lastSaid, onClear, onStop, onUndo,
}: {
  /** What the surface just did. */
  note: string | null
  /** A model-driven run still in progress, and the step it is on. */
  running: { step: string } | null
  /**
   * REAL WORK, WITH A STATE THAT HAS TO END.
   *
   * `running` is a model-driven sequence of interface commands; this is an
   * operation in the sense `surface/types.ts` means it — one that cannot sit in
   * `running` forever, because the runtime times it out whatever the caller
   * does. It is here rather than in a strip of its own for the reason this whole
   * component exists: one line, at the seam, for what the app is doing.
   */
  op?: Operation | null
  canUndo: boolean
  /** What the last undoable step said it did. */
  lastSaid: string | null
  onClear: () => void
  onStop: () => void
  onUndo: () => void
}) {
  const [dismissed, setDismissed] = useState<string | null>(null)

  /**
   * A LIVE OPERATION OUT-RANKS EVERYTHING, including a model-driven run.
   *
   * It is the only thing on this line with a provider at the other end of it and
   * a timeout attached, so it is the only one where "what is it doing" is a
   * question with a real answer and a deadline.
   */
  const live = !!op && (op.status === 'running' || op.status === 'requested' || op.status === 'partial')
  const opText = !op ? null
    : live ? `${VERB[op.kind] ?? 'Working'}${op.phase ? ` · ${op.phase}` : ''}…`
    : op.status === 'failed' || op.status === 'timedOut' ? (op.reason ?? 'That didn’t work.')
    : null

  // Something running outranks a finished note: it is the only one of the two
  // that is still changing, and the only one with a deadline on acting.
  const text = opText ?? (running ? (running.step || 'Working…') : note || (canUndo ? lastSaid : null))
  const undoable = !running && !live && canUndo && lastSaid !== null && dismissed !== lastSaid
  if (!text || (!running && !opText && !note && !undoable)) return null

  return (
    <div style={css('display:flex; align-items:center; gap:8px; padding:5px 18px 4px; animation:cruFade .2s ease;')}>
      <div style={css('width:4px; height:4px; flex:none; border-radius:999px; background:rgba(240,165,107,.75);')} />
      <div style={css('flex:1; min-width:0; font-size:11px; line-height:1.35; color:rgba(237,238,241,.44); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>
        {text}
      </div>

      {running || live ? (
        <div
          onClick={onStop}
          style={css('flex:none; padding:3px 9px; border-radius:999px; background:rgba(240,115,107,.16); font-size:10.5px; color:#F0938B; cursor:pointer;')}
        >stop</div>
      ) : (
        <>
          {undoable && (
            <div
              onClick={onUndo}
              style={css('flex:none; padding:3px 9px; border-radius:999px; background:rgba(255,255,255,.07); font-size:10.5px; color:rgba(237,238,241,.8); cursor:pointer;')}
            >undo</div>
          )}
          <div
            onClick={() => { setDismissed(lastSaid); onClear() }}
            style={css('flex:none; font-size:11px; color:rgba(237,238,241,.28); cursor:pointer; padding:0 2px;')}
          >✕</div>
        </>
      )}
    </div>
  )
}

import { css, cssv } from '../css'
import { TONE, TYPE } from '../tokens'

/**
 * THE ONE EXCEPTION TO FOREGROUND OWNERSHIP.
 *
 * "Topmost active layer owns input" is the rule the whole interaction model
 * rests on, and a genuinely critical event is the one thing that must not be
 * silenced by it — a cancelled flight does not become less urgent because the
 * chat panel happens to be open.
 *
 * The tempting fix is to let the interrupt punch through and make Home clickable
 * again underneath the glass. That breaks the rule rather than excepting it, and
 * it produces the worst possible tap target: a scrim that sometimes dismisses
 * and sometimes fires whatever was behind it.
 *
 * So the interrupt becomes its OWN topmost layer, above chat. It owns input
 * while it is up; Home stays inert underneath, chat stays inert beneath the
 * interrupt, and acknowledging it returns to whatever chat state was there
 * before. No layer below ever becomes reachable by accident.
 *
 * This is deliberately NOT a fifth Home lane. A permanent home for emergencies
 * is a permanent emergency.
 */

export interface CriticalInterrupt {
  id: string
  /** What happened, in the fewest words that are still exact. */
  title: string
  detail: string
  /** The one thing to do about it, if there is one. */
  action?: { label: string; run: () => void }
}

/**
 * What qualifies. Narrow on purpose, and enforced here rather than trusted from
 * the producer: routine notifications may never use this precedence, and a
 * threshold that lives in a comment is a threshold that erodes.
 */
export const CRITICAL_KINDS = new Set([
  'flight.cancelled',
  'travel.disrupted',
  'security.account',
  'security.breach',
])

export const isCritical = (kind: string): boolean => CRITICAL_KINDS.has(kind)

export function InterruptLayer({
  interrupt, onAcknowledge,
}: {
  interrupt: CriticalInterrupt
  onAcknowledge: () => void
}) {
  return (
    <div
      data-frame="interrupt"
      role="alertdialog"
      aria-label={interrupt.title}
      style={css('position:absolute; inset:0; z-index:40; display:flex; flex-direction:column; justify-content:flex-start; padding:14px; background:rgba(6,6,8,.5); animation:cruFade .18s ease;')}
    >
      <div
        style={cssv`flex:none; border-radius:22px; padding:15px 17px; animation:cruDrawer .28s ease;
          background:linear-gradient(160deg, rgba(58,28,26,.94), rgba(28,18,18,.94));
          backdrop-filter:blur(24px); -webkit-backdrop-filter:blur(24px);
          box-shadow:inset 0 1px 0 rgba(255,190,170,.2), inset 0 0 0 1px rgba(240,115,107,.3), 0 24px 60px rgba(0,0,0,.6);`}
      >
        <div style={cssv`display:flex; align-items:center; gap:7px; font-size:${TYPE.micro}; font-weight:600;
          letter-spacing:.08em; text-transform:uppercase; color:${TONE.urgent};`}>
          <div style={cssv`width:6px; height:6px; border-radius:999px; background:${TONE.urgent};
            box-shadow:0 0 8px ${TONE.urgent};`} />
          needs you now
        </div>
        <div style={css('margin-top:10px; font-size:19px; font-weight:600; letter-spacing:-.024em; line-height:1.2;')}>
          {interrupt.title}
        </div>
        <div style={css('margin-top:8px; font-size:12.5px; line-height:1.45; color:rgba(237,238,241,.68);')}>
          {interrupt.detail}
        </div>
        <div style={css('margin-top:14px; display:flex; align-items:center; gap:9px;')}>
          {interrupt.action && (
            <button
              type="button"
              data-role="interrupt-action"
              onClick={() => { interrupt.action?.run(); onAcknowledge() }}
              style={css('border:0; padding:9px 14px; border-radius:12px; background:rgba(237,238,241,.92); color:#0B0B0D; font-family:inherit; font-size:13px; font-weight:600; cursor:pointer;')}
            >{interrupt.action.label}</button>
          )}
          {/* Dismissing returns to the prior chat state exactly — the panel does
              not collapse as a side effect of an emergency arriving. */}
          <button
            type="button"
            data-role="interrupt-dismiss"
            onClick={onAcknowledge}
            style={css('border:0; background:transparent; color:rgba(237,238,241,.6); font-family:inherit; font-size:12.5px; cursor:pointer; padding:9px 4px;')}
          >Got it</button>
        </div>
      </div>
    </div>
  )
}

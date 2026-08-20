import { css, cssv } from '../css'
import type { Relevance } from '../api'

/**
 * SLOT TWO.
 *
 * Whatever most deserves the space under the deck, whether or not it belongs to
 * the widget above it — it answers to his situation, not to what he happened to
 * swipe to. Fixed height, and it may be absent: an absent slot leaves space
 * rather than growing its neighbour, because on a quiet day Home is mostly empty
 * and that is the correct picture of a quiet day.
 *
 * SLOT THREE MOVED OUT OF THIS FILE, and it was not a refactor. `MindCard`
 * rendered a `Mind` — a need id, a body string and two chips — which is a shape
 * that can hold literally any sentence the model produced, and what it held was
 * a mail count. Slot three is now `IntelligenceCard`, which can only be given an
 * `IntelligencePresentation`: compiled from typed cognition, with every quantity
 * checked against the record it came from. The boundary is in the TYPE, so the
 * old failure is not something to remember not to do.
 */

const TONE: Record<Relevance['tone'], string> = {
  urgent: '#F0736B',
  changed: '#A98FE0',
  active: '#7FB3D5',
  warning: '#E7B24C',
  time: '#F0A56B',
  neutral: 'rgba(237,238,241,.34)',
  resolved: '#5FC9A6',
}

export const RELEVANCE_H = 126

export function RelevanceCard({ r, onOpen }: { r: Relevance; onOpen: (needId: string) => void }) {
  const warn = r.tone === 'warning'
  return (
    <div data-deck="relevance" data-card={r.needId} style={css('flex:none; padding:0 16px;')}>
      <div
        data-role="relevance"
        onClick={() => onOpen(r.needId)}
        style={cssv`height:${RELEVANCE_H}px; box-sizing:border-box; border-radius:20px; padding:13px 15px; overflow:hidden; cursor:pointer; display:flex; flex-direction:column; background:${warn ? 'rgba(231,178,76,.075)' : 'rgba(255,255,255,.05)'};`}
      >
        {/* WHY THIS IS ON SCREEN, in the card's own words — `because.sentence`
            when the server computed one. Never generated in the client: a slot
            that writes its own justification can justify anything. */}
        <div style={cssv`flex:none; font-size:9.5px; letter-spacing:.07em; text-transform:uppercase; color:${TONE[r.tone]};`}>{r.eyebrow}</div>
        <div style={cssv`flex:none; margin-top:8px; font-size:16px; font-weight:600; letter-spacing:-.02em; line-height:1.25; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; text-wrap:pretty; color:${warn ? '#EFD8A8' : 'rgba(237,238,241,.92)'};`}>{r.head}</div>
        <div style={css('flex:1; min-height:4px;')} />
        {/*
          THE ACTION PILL IS GONE, AND IT WAS NOT A CONTROL.

          It rendered `Relevance.action` as the highest-contrast element on the
          card — white fill, dark text, the styling of a primary action — with no
          handler of its own, so the tap bubbled to the card and did whatever the
          card does. On the reference fixture that meant a pill reading "Set a
          reminder" opened the Calendar day view. It set no reminder. Nothing was
          broken in the wiring: `deck.ts` projects `action: n.action?.label ?? ''`,
          flattening the action to its LABEL and discarding the id and the `done`
          state, so the client was never given anything it could perform. The
          button was structurally incapable of keeping its promise.

          Removed rather than wired, on two of the frozen rules at once. A card
          that opens on tap must not also carry a control that opens it (§56), and
          a secondary action must not outweigh the content it sits beside (§54).
          Removing it also ADDS information: the pill was taking half the bottom
          row, so `sub` was clamped to "Tomorrow at 11:00 AM. You asked wh…" and
          now has the width to finish its sentence.

          If a relevance object should one day offer a real action, the thing to
          restore is the PROJECTION — an id the client can send to `perform` —
          and not this div.
        */}
        {/*
          THE SUBTITLE GETS THE ROW BACK, AND THE SECOND LINE THE CONTRACT ALLOWS.

          It was `white-space:nowrap` in a flex row it shared with the action
          pill, so it had half a row and one line: "Tomorrow at 11:00 AM. You
          asked wh…". The pill is gone and the row is no longer shared, so this
          is now the only thing here — and the clamp is the contract's own limit
          for a secondary preview rather than a single line inherited from a
          layout that no longer exists. Two lines of a sentence that finishes is
          strictly more information in exactly the same 126px.
        */}
        <div style={css(`flex:none; font-size:12px; line-height:1.35; color:rgba(237,238,241,.44);
          display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; text-wrap:pretty;`)}
        >{r.sub}</div>
      </div>
    </div>
  )
}

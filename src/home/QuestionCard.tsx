import { useLayoutEffect, useRef, useState } from 'react'
import { css, cssv } from '../css'
import { CLAMP, RADIUS, S, TONE, TYPE, type StateTone } from '../tokens'
import { applyCorrection, type Correction } from '../api'
import type { HomeObject } from './lanes'

/**
 * A QUESTION IS NOT AN APPLICATION SURFACE.
 *
 * What this replaces: a clarification was an ordinary attention card, so it was
 * drawn by `InsightCard` — one clamped line of title, two clamped lines of
 * reason, and a tap that NAVIGATED. It navigated to a `Report` built from a need
 * with no panes, which renders an empty workspace: a header, a blank frame, and
 * a chat composer. The screenshot in the handoff is exactly that, and the
 * question's own text was cut off in both places, so it could not be read on
 * Home and could not be read after opening either.
 *
 * Three rules follow, and this file is all three:
 *
 *   · THE WHOLE QUESTION IS LEGIBLE. It wraps. Nothing about a question may
 *     ellipsise — not the question, not the reason, not the options. Height is
 *     cheaper than ambiguity (§25).
 *   · IT IS ANSWERED WHERE IT IS ASKED. The options are the server's own
 *     correction verbs, so tapping one writes a typed fact; there is no path
 *     through a language model and nothing to navigate to.
 *   · ANSWERING IMMEDIATELY BECOMES THE THING IT UNBLOCKED. The card reports
 *     what it wrote and the feed rebuilds, so the question is replaced by the
 *     number it was asking about rather than simply vanishing (§32, §33).
 *
 * WHAT IT DOES NOT DO, AND WHY THE PREVIOUS ANSWER WAS WRONG.
 *
 * It does not grow its band, and — this is the correction — it does not scroll
 * either. The previous pass reasoned that a question longer than its band had to
 * SCROLL INSIDE THE CARD, on the grounds that a clip breaks "every word is
 * reachable" and a growing card breaks "nothing below a band moves". Both halves
 * of that are true. The conclusion was still wrong, because it treated the
 * question's LENGTH as a given and the geometry as the only variable.
 *
 * The length is not a given. It is generated, and a generator that writes 180
 * characters for a 224px card is the actual defect; a scrollbar is the UI
 * apologising for it. So the budget moved upstream — `server/homeCopy.ts` — and
 * what is left here is a reduction ladder for the cases a budget cannot cover
 * (a very long name, text at 1.5×, four choices that each wrap):
 *
 *   1  the reason line clamps to two lines, then to one, then goes
 *   2  "Why am I being asked?" goes
 *   3  choices past the fourth go
 *
 * In that order, because it is the order of what he loses least by not seeing.
 * The question and the answers are CRITICAL and are never reduced: if they did
 * not fit, the card would be lying about what it is asking. Everything dropped
 * here is still reachable — the full reason is the report's opening, and the
 * remaining choices are behind "Something else…" and the composer.
 */

/**
 * THE OVERFLOW LADDER, AS DATA.
 *
 * Each rung shows strictly less than the one above it, in the order of what he
 * loses least by not seeing. The bottom rung is the answer to "what if the
 * critical content still does not fit": SIMPLIFY THE INTERACTION. One button
 * that hands the whole question to the composer, where every option is still
 * offered and a typed answer still writes the same slot. That is a worse card
 * and a working one; a scrollbar is a broken card that looks complete.
 *
 * The question itself never appears in this table. It is not reducible.
 */
const LADDER = [
  { reason: CLAMP.secondary, why: true, chips: 4, eyebrow: true },
  { reason: CLAMP.secondary, why: false, chips: 4, eyebrow: true },
  { reason: 1, why: false, chips: 4, eyebrow: true },
  { reason: 0, why: false, chips: 4, eyebrow: true },
  { reason: 0, why: false, chips: 2, eyebrow: true },
  { reason: 0, why: false, chips: 0, eyebrow: true },
  /*
    THE LAST RUNG DROPS THE EYEBROW.

    "NEEDS YOU" is a label for a card that is already unmistakably a question —
    it is the only thing on the screen with answer buttons on it. At every other
    size it earns its twenty pixels by making the band scannable; at this one it
    is competing with the question itself for the room to be read, and a
    question that cannot be read is not a card, it is a bug. Reached only by a
    question well past its budget at the largest supported text size.
  */
  { reason: 0, why: false, chips: 0, eyebrow: false },
] as const

/**
 * DESCEND THE LADDER UNTIL IT FITS. MEASURED, NOT PREDICTED.
 *
 * The previous attempt at this picked rungs from the card's HEIGHT — "show the
 * reason above 150px" — and that is a prediction about how tall the content
 * will turn out to be, made without seeing the content. It is wrong exactly
 * when it matters: a 90-character Italian place name wraps to three lines, four
 * chips at 1.5× text wrap to three rows, and both happen inside a card whose
 * height never changed. The gate caught it immediately — the answers were 161px
 * outside a card that was correctly 224px tall.
 *
 * So this asks the browser. Render, compare `scrollHeight` against
 * `clientHeight`, and if the content is taller, drop one rung and render again.
 * It settles in at most `LADDER.length` passes and, because each rung strictly
 * removes content, it cannot oscillate.
 *
 * `deps` resets it: a new question, a longer reason or a different number of
 * options must climb back to the top rather than inherit the last card's
 * reductions.
 */
function useReduction(key: string) {
  const ref = useRef<HTMLDivElement>(null)
  /*
    THE RUNG AND THE CONTENT IT WAS CHOSEN FOR, IN ONE PIECE OF STATE.

    Resetting in a passive effect looked equivalent and was not: on mount the
    layout effect descends a rung and the passive effect then resets it to zero,
    both from the same commit, so the card settles wherever those two happen to
    land — measured, it stopped at rung 1 with four pixels still overflowing and
    never moved again. React's own answer to "derive state from props" is a
    render-phase reset, which re-renders immediately and cannot race an effect.
  */
  const [state, setState] = useState({ key, rung: 0 })
  if (state.key !== key) setState({ key, rung: 0 })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      // One rung per pass, and a pass that is already at the bottom stops:
      // there is nothing left to drop, and the card is as simple as the
      // interaction gets. Each rung strictly removes content, so this descends
      // monotonically and cannot oscillate.
      setState((s) => (
        el.scrollHeight > el.clientHeight + 1 && s.rung < LADDER.length - 1
          ? { ...s, rung: s.rung + 1 }
          : s
      ))
    }
    fit()
    /*
      And again whenever the box changes. The keyboard, a rotation and a text
      size change all resize the card without changing a single prop, and a
      ladder that only ran on mount would keep the reductions chosen for
      whichever geometry happened to exist first.
    */
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  })

  return { ref, rung: state.key === key ? state.rung : 0 }
}

export function QuestionCard({
  o, onAnswered, onElaborate,
}: {
  o: HomeObject
  /** The feed must be rebuilt: the answer changes what everything else says. */
  onAnswered: (said: string) => void
  /** "Something else" — his own words, in the composer, about THIS question. */
  onElaborate: (question: string) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [why, setWhy] = useState(false)

  const need = o.need

  /**
   * FOUR, AND THE FOURTH IS ALREADY GENEROUS.
   *
   * Five chips is a menu, and a menu on a 224px card is the thing that pushed
   * the question off the top of it. Anything past the fourth is not lost — it is
   * reached the same way a freeform answer is, through "Something else…", where
   * `slotForReply` still routes the words to the typed slot.
   */
  const all: Correction[] = need?.corrections ?? []
  const options = all.slice(0, 4)

  const { ref, rung } = useReduction(`${o.id}|${o.title}|${need?.sub ?? ''}|${options.length}`)
  const shape = LADDER[rung]!

  const answer = async (c: Correction) => {
    if (busy) return
    setBusy(c.label)
    setFailed(null)
    try {
      const out = await applyCorrection(c)
      // What the SERVER says it wrote, verbatim. A question that reports its own
      // optimistic version of the answer is a question that can lie about having
      // been recorded.
      setSaid(out.said)
      onAnswered(out.said)
    } catch (e) {
      setFailed((e as Error).message || 'That didn’t save.')
    } finally {
      setBusy(null)
    }
  }

  /**
   * ANSWERED, AND SAYING WHAT CHANGED.
   *
   * Held for the moment between the write and the rebuilt feed. Without it the
   * card simply disappears, and a question that vanishes teaches him nothing
   * about why it was asked — which is the whole of §32.
   */
  if (said) {
    return (
      <div data-role="question-answered" style={css(shell)}>
        <Eyebrow tone="resolved" text="answered" />
        <div style={cssv`margin-top:${S.snug}px; font-size:${TYPE.body}; line-height:1.45; color:rgba(143,224,174,.92);`}>
          {said}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={ref}
      data-role="question"
      /*
        NO SCROLLING. The card is its band's box exactly, it clips, and nothing
        critical is ever near the clip — see the ladder above. `overflow:hidden`
        is stated rather than inherited so that a shared primitive changing its
        mind cannot quietly reintroduce a scrollbar here.
      */
      style={css(shell + 'overflow:hidden;')}
    >
      {shape.eyebrow && <Eyebrow tone="urgent" text={o.stateLabel || 'a question'} />}

      {/*
        THE QUESTION. Wraps, never clamps, never scrolls.

        It is the one thing on this card that may not be reduced, so it is drawn
        FIRST and given whatever it needs; every optional part below yields to
        it. A question budgeted to 50 characters is two lines at 1.5× text on the
        narrowest phone, which is what the tier was sized for.
      */}
      <div
        data-role="question-text"
        data-critical="question"
        style={cssv`margin-top:${S.snug}px; flex:none; font-size:${TYPE.title}; font-weight:600;
          letter-spacing:-.02em; line-height:1.25; color:rgba(237,238,241,.96); text-wrap:pretty;`}
      >
        {o.title}
      </div>

      {/*
        WHAT I KNOW AND WHAT I DO NOT.

        Noncritical, and therefore clamped rather than given room: the answer can
        be chosen without it — the chips are typed verbs, not an interpretation of
        this sentence. The whole of it is the report's opening and is one tap
        away. First rung of the ladder.
      */}
      {need?.sub && shape.reason > 0 && (
        <div
          data-role="question-reason"
          style={cssv`margin-top:${S.tight}px; flex:none; font-size:${TYPE.small}; line-height:1.45;
            color:rgba(237,238,241,.62); overflow-wrap:anywhere;
            max-height:${(shape.reason * 1.45).toFixed(2)}em;
            display:-webkit-box; -webkit-line-clamp:${shape.reason}; -webkit-box-orient:vertical; overflow:hidden;`}
        >
          {need.sub}
        </div>
      )}

      {/* THE ANSWERS. Every one is a correction verb the server implements, so
          there is no such thing here as a button that does not write. Critical:
          the ladder above drops other things so that these always fit. */}
      {/*
        DIRECTLY UNDER THE FACT, NOT PINNED TO THE FLOOR.

        A `flex:1` spacer here anchored the chips to the bottom of the card, on
        the argument that the answers are what the hand aims at and their
        position should not depend on how much the model wrote. Correct in
        principle, wrong on the glass: a short question then drew a hundred-pixel
        hole through the middle of a card that had said everything it had to say,
        which reads as something failing to load. The unused space belongs at the
        BOTTOM of the card, where it reads as the card being calm.
      */}
      <div data-critical="answers" style={cssv`margin-top:${S.base}px; flex:none; display:flex; flex-wrap:wrap; gap:6px;`}>
        {options.slice(0, shape.chips).map((c) => (
          <button
            key={c.label}
            type="button"
            data-answer={c.label}
            disabled={!!busy}
            onClick={(e) => { e.stopPropagation(); void answer(c) }}
            style={cssv`border:0; padding:8px 13px; border-radius:999px; cursor:pointer; font-family:inherit;
              font-size:${TYPE.small}; font-weight:500; white-space:normal; text-align:left;
              background:rgba(237,238,241,${busy === c.label ? '.35' : '.9'}); color:#101012;`}
          >{busy === c.label ? 'Saving…' : c.label}</button>
        ))}

        {/*
          HIS OWN WORDS, in the one composer this screen already has.

          Not a second text field inside the card: that would be a third place to
          type on a screen that already has the composer at the bottom, and the
          composer is where an answer typed in prose is already routed to the
          right typed field (`slotForReply` reads the card's id). This puts the
          question in front of it and hands him the keyboard.
        */}
        <button
          type="button"
          data-answer="something-else"
          onClick={(e) => { e.stopPropagation(); onElaborate(o.title) }}
          /*
            At the bottom rung this is the ONLY control, and it becomes the
            primary rather than the escape hatch — the chips it replaced are all
            still offered in the composer, so nothing was taken away except the
            ability to answer in one tap.
          */
          style={cssv`border:0; padding:8px 13px; border-radius:999px; cursor:pointer; font-family:inherit;
            font-size:${TYPE.small}; white-space:nowrap;
            background:${shape.chips === 0 ? 'rgba(237,238,241,.9)' : 'rgba(255,255,255,.07)'};
            box-shadow:${shape.chips === 0 ? 'none' : 'inset 0 0 0 1px rgba(255,255,255,.12)'};
            color:${shape.chips === 0 ? '#101012' : 'rgba(237,238,241,.78)'};`}
        >{shape.chips === 0 ? 'Answer this' : shape.chips < options.length ? 'Other answers…' : 'Something else…'}</button>
      </div>

      {/* A BLOCKING ERROR IS CRITICAL. It is what he needs in order to decide
          what to do next, so it takes the space "why am I being asked" was
          using rather than being pushed under the edge of the card. */}
      {failed && (
        <div
          data-critical="error"
          style={cssv`margin-top:${S.tight}px; flex:none; font-size:${TYPE.small}; line-height:1.4; color:#F0938B;`}
        >{failed}</div>
      )}

      {/* WHY AM I BEING ASKED — the same affordance, in the same words, as every
          other computed card in the app. A control rather than a paragraph, and
          the second rung of the ladder: on a short card it goes, because the
          same explanation is the first thing the report says. */}
      {need?.status && shape.why && !failed && (
        <div style={cssv`margin-top:${S.tight}px; flex:none;`}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setWhy((v) => !v) }}
            style={cssv`border:0; background:none; padding:2px 0; cursor:pointer; font-family:inherit;
              font-size:${TYPE.micro}; color:rgba(237,238,241,.42); text-decoration:underline;
              text-underline-offset:2px;`}
          >{why ? 'Hide why' : 'Why am I being asked?'}</button>
          {/* Clamped, because this card cannot scroll and an unbounded paragraph
              opened at the foot of it would simply be cut. The whole sentence is
              the report's opening, one tap away. */}
          {why && (
            <div style={cssv`margin-top:${S.tight}px; font-size:${TYPE.micro}; line-height:1.45;
              color:rgba(237,238,241,.5); text-wrap:pretty;
              display:-webkit-box; -webkit-line-clamp:${CLAMP.secondary}; -webkit-box-orient:vertical; overflow:hidden;`}>
              {need.status}
            </div>
          )}
        </div>
      )}

      {/*
        NO TRAILING SPACER.

        This absorbed the card's unspent height "at the foot where it belongs",
        which was true while the card was obliged to be 306px tall. It is not
        obliged any more — see `shell` — and keeping the spacer would hold the
        panel open to the full slot and undo the change entirely.
      */}
    </div>
  )
}

/*
  The question card is NOT `onClick`-able as a whole. Every other card on Home
  opens something; this one has nowhere to go, and a card-wide tap target would
  put the empty surface back one gesture later.
*/
/**
 * IT TAKES WHAT IT NEEDS, NOT WHAT IT WAS GIVEN.
 *
 * `height:100%` of a slot sized for the worst case, plus the `flex:1` spacer at
 * the foot, meant a three-chip question drew a 306px bordered panel with about
 * 250px of nothing inside it — a quarter of the phone, framed, saying that
 * something belonged there. That is the same defect the deck's quiet widgets
 * had, in the one card that is always about the single most important thing on
 * the screen.
 *
 * `max-height` rather than `height` keeps the other half of the rule: content
 * still never expands the slot, so a long question with four choices is clamped
 * by exactly the geometry it always was. What changed is only that a short one
 * is allowed to be short. See the contract — "empty content does not preserve
 * populated geometry" — which this card was the last place on Home to ignore.
 */
const shell =
  `max-height:100%; width:100%; min-height:0; min-width:0; box-sizing:border-box;
   display:flex; flex-direction:column;
   padding:${S.base}px ${S.gap}px; border-radius:${RADIUS.panel}px;
   background:linear-gradient(160deg, rgba(48,38,26,.42), rgba(26,22,18,.34));
   box-shadow:inset 0 1.5px 0 rgba(255,220,170,.14), inset 0 0 0 1px rgba(240,165,107,.18);`

function Eyebrow({ text, tone }: { text: string; tone: StateTone }) {
  return (
    <div style={css('display:flex; align-items:center; gap:6px; flex:none; min-height:14px;')}>
      <div style={cssv`width:5px; height:5px; flex:none; border-radius:999px; background:${TONE[tone]};`} />
      <div style={cssv`flex:1; min-width:0; font-size:${TYPE.micro}; font-weight:600; letter-spacing:.07em;
        text-transform:uppercase; color:${TONE[tone]}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>
        {text}
      </div>
    </div>
  )
}

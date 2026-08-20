import { useLayoutEffect, useRef, useState } from 'react'
import { css, cssv } from '../css'
import { SurfaceFrame } from '../SurfaceFrame'
import type {
  IntelligenceAction,
  IntelligencePresentation,
  IntelligenceVisual,
} from '../api'

/**
 * SLOT THREE: WHAT CRUCIBLE UNDERSTOOD.
 *
 * WHAT THIS REPLACED, because the replacement is the point. The slot rendered
 * whichever synthesis need carried an `opening`, and a model's opening is a
 * summary of the loudest source — so on the reference fixture the intelligence
 * slot read *"6 in the last week from 5 senders. Newest: Your…"*: a mail count,
 * as primary content, cut mid-word, restating the Mail widget one swipe to the
 * right, with no tap target and nothing underneath it to open.
 *
 * The card below cannot do any of that, and mostly not because it is written
 * more carefully. It is handed an `IntelligencePresentation` — compiled from a
 * hypothesis, a change point or an anomaly, with every number checked against
 * the records that produced it — and there is no other input it can render. No
 * counts reach it, no model prose reaches it, and when cognition has concluded
 * nothing worth saying the card is not rendered at all.
 *
 * THE FACE CARRIES NO BUTTONS. §11 and §25: the object itself is the
 * interaction, so the card opens its own depth on tap, and a `View details`
 * pill beside it would be a second control for the thing the first one does.
 * Feedback lives in the depth view, where there is room for it to be secondary
 * — §17, against three large buttons under every insight.
 */

export const INTELLIGENCE_H = 170

/** The headline's line box, as a whole number of pixels. */
const LINE = 21
/** The support line's. */
const SUB_LINE = 17
/** Eyebrow row, the gap under it, and the comparison strip's own height. */
const EYEBROW = 14
const GAP = 10
const STRIP = 22

/**
 * WHAT ACTUALLY FITS, MEASURED — AND THE GATE IS WHY THIS EXISTS.
 *
 * The card is `flex:0 1 auto` because it is the slot that gives way: on a 375×725
 * Safari window with browser chrome showing, three slots plus the composer do not
 * fit and this one compresses to its 96px floor. Its content did not compress
 * with it. `-webkit-line-clamp:2` truncates at two lines and says NOTHING about
 * the height of the box those lines are in, so the headline, the support line and
 * the comparison strip kept their full heights inside a box that no longer had
 * room for them — six nodes stranded outside their parent and the card overflowing
 * by 22px, which the visual gate reported as escaping nodes rather than as
 * anything a screenshot would make obvious.
 *
 * So the layout is DERIVED FROM THE BOX rather than asserted over it, in the
 * overflow ladder's own order: the strip goes first (rung five, reduce inline
 * secondary content), then the support line's clamp shrinks a line at a time
 * (rung four), and the headline is the last thing standing because it is the
 * thought. A constant standing in for a measurement is how every phone-only
 * layout bug in this app has started.
 */
function useFit(): [React.RefObject<HTMLDivElement | null>, { sub: number; strip: boolean }] {
  const ref = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState({ sub: 2, strip: true })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      // The padding is the card's own; `clientHeight` is inside the border box.
      const inner = el.clientHeight - 30
      if (inner <= 0) return
      let left = inner - EYEBROW - GAP - LINE * 2
      const strip = left >= STRIP + SUB_LINE
      if (strip) left -= STRIP
      const sub = Math.max(0, Math.min(2, Math.floor((left - 7) / SUB_LINE)))
      setFit((p) => (p.sub === sub && p.strip === strip ? p : { sub, strip }))
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, fit]
}

/**
 * HOW THE BAND IS SHOWN — and it is not shown as a word.
 *
 * There is no "LIKELY" label anywhere on this card, because a badge reading
 * `possible` is confidence telemetry with a nicer font: it asks him to do the
 * arithmetic the compiler was supposed to do for him. The band is already IN the
 * sentence — "you usually" against "it looks like" — and here it only sets how
 * loudly the card presents itself. A tentative thought is quieter than a settled
 * one, which is the whole of what the band should cost the screen.
 */
const PRESENCE: Record<IntelligencePresentation['certainty'], { dot: string; ink: string }> = {
  known: { dot: '#F0A56B', ink: 'rgba(247,232,220,.95)' },
  strong: { dot: '#F0A56B', ink: 'rgba(247,232,220,.93)' },
  likely: { dot: 'rgba(240,165,107,.82)', ink: 'rgba(247,232,220,.88)' },
  possible: { dot: 'rgba(240,165,107,.6)', ink: 'rgba(247,232,220,.8)' },
  unclear: { dot: 'rgba(240,165,107,.42)', ink: 'rgba(247,232,220,.72)' },
}

export function IntelligenceCard({
  m,
  onOpen,
}: {
  m: IntelligencePresentation
  onOpen: (m: IntelligencePresentation) => void
}) {
  const tone = PRESENCE[m.certainty]
  const [box, fit] = useFit()
  const open = () => onOpen(m)

  return (
    /*
      THE SLOT THAT GIVES WAY, unchanged from the card this replaces.

      Its height was fixed at 170 with no ability to shrink, so on a viewport
      shorter than three slots plus the composer the column ran past the bottom
      and the content went UNDER the composer — drawn, tappable-looking, and not
      tappable. The deck and relevance keep their contract heights; this one may
      compress, because it is last and because its body is prose that clamps.
    */
    /*
      THE BASIS IS THE DESIGN HEIGHT, NOT THE CONTENT — AND THAT IS LOAD-BEARING.

      With `flex:0 1 auto` the slot's height came from what was inside it, and
      `useFit` measures the box to decide what to put inside it. Those two
      together are a loop, and it converges the wrong way: the first measurement
      came in short, the support line and the strip were dropped, the card got
      shorter because it now held less, the next measurement was shorter still,
      and the card settled on a headline alone with 70px of unused space beneath
      it. Every step was individually correct.

      A fixed basis breaks it. The slot asks for the design's 170 and gives way
      only when the COLUMN is short — which is the one input that has nothing to
      do with what the card is holding — so the measurement has a stable answer
      and the ladder shortens content for the reason it is supposed to.
    */
    <div data-deck="intelligence" data-card={m.id} style={cssv`flex:0 1 ${INTELLIGENCE_H}px; min-height:0; padding:0 16px;`}>
      <div
        ref={box}
        data-role="intelligence"
        role="button"
        tabIndex={0}
        aria-label={`${m.headline} — why Crucible thinks this`}
        onClick={open}
        /*
          THE NON-TOUCH PATH IS REAL, and the audit is the reason it is spelled
          out rather than assumed. `Show all domains` was a 1×1px focusable
          button — the keyboard route existed in the DOM and not on the screen,
          which is a technicality rather than an accessible fallback. A card that
          takes Enter and Space and shows a focus ring is the same affordance the
          finger has, at the same size.
        */
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() }
        }}
        style={cssv`height:100%; max-height:${INTELLIGENCE_H}px; min-height:96px; box-sizing:border-box; border-radius:20px;
          padding:15px 16px; overflow:hidden; display:flex; flex-direction:column; cursor:pointer; text-align:left;
          background:radial-gradient(130% 120% at 8% 0%, rgba(240,165,107,.13) 0%, rgba(240,165,107,.045) 46%, rgba(255,255,255,.028) 100%);`}
      >
        <div style={css('flex:none; display:flex; align-items:center; gap:7px;')}>
          <div style={cssv`width:6px; height:6px; border-radius:999px; background:${tone.dot}; box-shadow:0 0 10px rgba(240,165,107,.75); animation:cruPulse 3.6s ease-in-out infinite;`} />
          <div style={css('font-size:9.5px; letter-spacing:.14em; text-transform:uppercase; color:rgba(240,165,107,.7);')}>crucible</div>
        </div>

        {/* The thought. Two lines, clamped at BOTH ends of the boundary — the
            compiler budgets the string and this clamps the box, because a
            budget in characters cannot know what the accessibility text scale
            did to the line. */}
        <div
          style={cssv`flex:none; margin-top:10px; font-size:15px; font-weight:500; line-height:${LINE}px;
            letter-spacing:-.012em; color:${tone.ink};
            display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; text-wrap:pretty;`}
        >{m.headline}</div>

        {/* What holds it up. Gives way before the headline does, a line at a
            time, and disappears entirely on a viewport that cannot hold it. */}
        {m.summary && fit.sub > 0 && (
          <div
            style={cssv`flex:none; margin-top:7px; font-size:12.5px; line-height:${SUB_LINE}px;
              color:rgba(237,238,241,.5); display:-webkit-box; -webkit-line-clamp:${fit.sub}; -webkit-box-orient:vertical;
              overflow:hidden; text-wrap:pretty;`}
          >{m.summary}</div>
        )}

        <div style={css('flex:1; min-height:0;')} />

        {/*
          THE ONE PICTURE THAT EARNS A ROW ON THE FACE.

          Only `comparison`, and only because two formatted values with an arrow
          between them say the thing the sentence is about in less space than the
          sentence does — "was 10:31, now 11:54" is the finding. The other three
          visuals need room to be read and belong in the depth view; putting a
          ten-bar distribution in a 26px strip would be decoration standing where
          information goes.
        */}
        {fit.strip && m.visual?.kind === 'comparison' && <FaceComparison v={m.visual} />}
      </div>
    </div>
  )
}

function FaceComparison({ v }: { v: Extract<IntelligenceVisual, { kind: 'comparison' }> }) {
  return (
    <div style={css('flex:none; display:flex; align-items:baseline; gap:8px; font-variant-numeric:tabular-nums;')}>
      <Reading label={v.before.label} value={v.before.value} dim />
      <div style={css('font-size:12px; color:rgba(237,238,241,.3);')}>→</div>
      <Reading label={v.after.label} value={v.after.value} />
    </div>
  )
}

function Reading({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div style={css('display:flex; align-items:baseline; gap:5px; min-width:0;')}>
      <div style={css('font-size:9px; letter-spacing:.09em; text-transform:uppercase; color:rgba(237,238,241,.32);')}>{label}</div>
      <div style={cssv`font-size:14px; font-weight:600; letter-spacing:-.01em; color:rgba(247,232,220,${dim ? '.55' : '.93'});`}>{value}</div>
    </div>
  )
}

// ── Depth ────────────────────────────────────────────────────────────────────

/**
 * WHY CRUCIBLE SAID THIS.
 *
 * §12: the tap has to be worth taking, so this is not the same sentence at a
 * larger size. It is the four things the face cannot hold — the conclusion, what
 * actually changed as a picture, what it means for him, and the evidence trail
 * back to rows that exist — and then the one interaction the face deliberately
 * does not carry: the chance to say it is wrong.
 *
 * It is NOT an analytics page. There are four visual primitives and no fifth,
 * there are no controls for filtering or ranging over anything, and nothing here
 * exposes a confidence number, a support count as a metric, or a model version.
 * The question this screen answers is "why did you say that", and a screen that
 * answers a second question is a screen that has started being a dashboard.
 */
export function IntelligenceDepth({
  m, onClose, onFeedback, onAct,
}: {
  m: IntelligencePresentation
  onClose: () => void
  /**
   * SAY BACK WHAT ACTUALLY HAPPENED, not what was attempted.
   *
   * This returned void and the card printed its own cheerful confirmation the
   * instant it was tapped — so against a host with no memory core, where the
   * route answers 503 and records nothing, the screen still read "I will hold
   * that against this and stop saying it". A correction that silently fails
   * while claiming to have worked is worse than one that visibly fails, and it
   * is precisely the defect `applyCorrection` was documented against: "a
   * correction that silently succeeds is indistinguishable from one that did
   * nothing, and this app has already shipped three controls wired to an
   * operation nothing implemented."
   *
   * So the promise resolves with the server's own sentence and that sentence is
   * what he reads.
   */
  onFeedback: (verdict: 'useful' | 'not-useful' | 'wrong', correction?: string) => Promise<string>
  onAct: (a: IntelligenceAction) => void
}) {
  const [correcting, setCorrecting] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const judge = async (verdict: 'useful' | 'not-useful' | 'wrong', correction?: string) => {
    setSending(true)
    try { setSaid(await onFeedback(verdict, correction)) } finally { setSending(false) }
  }

  return (
    /*
      IT IS A SURFACE, AND DECLARING SO IS NOT A FORMALITY.

      This began as its own `data-frame="intelligence-depth"`, which is exactly
      the shape of mistake the visual gate exists to catch: tapping the card left
      neither Home nor `[data-frame="surface"]` on screen, so the "no blank
      navigation destination" probe reported the destination as GONE on four
      captures. It was not blank — it was undeclared, which from the gate's side
      is indistinguishable and from a user's side is one bad render away from
      being the same thing.

      Inside `SurfaceFrame` it is measured, contained and probed like every other
      destination in the app: `data-surface` marks the application region the
      painted-node count is taken over, and `data-renderer` says what drew it.
      A destination that opts out of the containment contract is a destination
      nothing is checking.
    */
    <SurfaceFrame>
    <div
      data-surface="intelligence"
      data-renderer="intelligence"
      style={css('flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden;')}
    >
      {/*
        ONE WAY OUT, AND IT IS THE ONE THE REST OF THE APP USES.

        Settings shipped with three stacked exits — a drag handle, `close`, and a
        chevron — which is the shape this had to avoid. Back is a single control
        in a single place.
      */}
      <div style={css('flex:none; display:flex; align-items:center; gap:10px; padding:6px 18px 12px;')}>
        <button
          type="button"
          data-role="intelligence-close"
          onClick={onClose}
          aria-label="Back"
          style={css(`border:0; background:rgba(255,255,255,.06); color:rgba(237,238,241,.72); cursor:pointer;
            width:30px; height:30px; border-radius:999px; font-family:inherit; font-size:14px; line-height:1;`)}
        >‹</button>
        <div style={css('font-size:9.5px; letter-spacing:.14em; text-transform:uppercase; color:rgba(240,165,107,.7);')}>
          what crucible noticed
        </div>
      </div>

      {/*
        THE ONE SCROLL OWNER ON THIS SCREEN.

        Home may not scroll and this is not Home: it is a depth view reached by a
        tap, where the contract's rule is that depth is substantially richer than
        the face. The scroll is on the section list, once, and nothing inside a
        section scrolls within it.
      */}
      <div style={css('flex:1; min-height:0; overflow-y:auto; padding:0 18px 24px;')}>
        <div style={css('font-size:19px; font-weight:600; letter-spacing:-.022em; line-height:1.28; color:rgba(247,232,220,.95); text-wrap:pretty;')}>
          {m.headline}
        </div>
        {m.summary && (
          <div style={css('margin-top:10px; font-size:13.5px; line-height:1.45; color:rgba(237,238,241,.62); text-wrap:pretty;')}>
            {m.summary}
          </div>
        )}

        {m.visual && (
          <Section title="what changed">
            <Visual v={m.visual} />
          </Section>
        )}

        {m.implication && (
          <Section title="why it matters">
            <div style={css('font-size:13.5px; line-height:1.45; color:rgba(237,238,241,.78);')}>{m.implication}</div>
          </Section>
        )}

        <Section title="why crucible thinks this">
          {/*
            THE TRAIL IS ROWS, NOT PROSE ABOUT ROWS.

            Every line is an `EvidenceRef.says` written where the arithmetic
            happened. A trail composed at presentation time would be a second
            author describing evidence rather than the evidence itself — which is
            exactly the traceability requirement failing while looking like it
            passed.
          */}
          {m.evidence.trail.map((g) => (
            <div key={g.id} style={css('display:flex; gap:9px; padding:6px 0; align-items:baseline;')}>
              <div style={css('flex:none; width:74px; font-size:9.5px; letter-spacing:.06em; text-transform:uppercase; color:rgba(237,238,241,.3);')}>
                {VOICE_LABEL[g.voice]}
              </div>
              <div style={css('flex:1; min-width:0; font-size:12.5px; line-height:1.4; color:rgba(237,238,241,.72);')}>{g.says}</div>
            </div>
          ))}
          {m.evidence.span && (
            <div style={css('margin-top:8px; font-size:11.5px; color:rgba(237,238,241,.34);')}>{m.evidence.span}</div>
          )}
        </Section>

        {m.evidence.caveats.length > 0 && (
          <Section title="what i am not sure about">
            {m.evidence.caveats.map((c, i) => (
              <div key={i} style={css('font-size:12.5px; line-height:1.45; color:rgba(237,238,241,.5); padding:3px 0;')}>{c}</div>
            ))}
          </Section>
        )}

        {m.actions && m.actions.length > 0 && (
          <div style={css('display:flex; gap:8px; margin-top:20px; flex-wrap:wrap;')}>
            {m.actions.map((a) => (
              <button
                key={a.id}
                type="button"
                data-role="intelligence-action"
                onClick={() => onAct(a)}
                style={css(`border:0; padding:9px 15px; border-radius:999px; cursor:pointer; font-family:inherit;
                  font-size:12.5px; background:rgba(237,238,241,.92); color:#0B0B0D; font-weight:600;`)}
              >{a.label}</button>
            ))}
          </div>
        )}

        {/*
          USEFUL / NOT USEFUL / WRONG — THREE WORDS, AND TWO DIFFERENT SYSTEMS.

          §15's distinction is not a matter of wording. `useful` and `not useful`
          are ENGAGEMENT: they say whether he wanted to be told, they move
          attention's fit axis, and they change nothing about whether the claim is
          true. `wrong` is EPISTEMIC: it says the claim is false, and it has to
          reach the hypothesis rather than the ranking, or the app quietly keeps
          believing something he has explicitly denied while showing it to him
          less often.

          Small, at the end, after the evidence. A thought is information first;
          three large buttons under every insight would make the card a survey.
        */}
        {said ? (
          <div data-role="intelligence-thanks" style={css('margin-top:22px; font-size:12.5px; color:rgba(237,238,241,.5);')}>{said}</div>
        ) : correcting ? (
          <Correction
            busy={sending}
            onCancel={() => setCorrecting(false)}
            onSend={(text) => void judge('wrong', text || undefined)}
          />
        ) : (
          <div style={css('display:flex; gap:7px; margin-top:22px; align-items:center;')}>
            <Quiet label="Useful" onClick={() => void judge('useful')} />
            <Quiet label="Not useful" onClick={() => void judge('not-useful')} />
            <Quiet label="Wrong" onClick={() => setCorrecting(true)} />
          </div>
        )}
      </div>
    </div>
    </SurfaceFrame>
  )
}

const VOICE_LABEL: Record<string, string> = {
  observation: 'your data',
  computation: 'worked out',
  inference: 'concluded',
  fact: 'you said',
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={css('margin-top:24px;')}>
      <div style={css('font-size:9.5px; letter-spacing:.14em; text-transform:uppercase; color:rgba(237,238,241,.34); margin-bottom:10px;')}>{title}</div>
      {children}
    </div>
  )
}

function Quiet({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      data-role={`intelligence-${label.toLowerCase().replace(/\s+/g, '-')}`}
      onClick={onClick}
      style={css(`border:0; padding:6px 12px; border-radius:999px; cursor:pointer; font-family:inherit; font-size:11.5px;
        background:rgba(255,255,255,.05); box-shadow:inset 0 0 0 1px rgba(255,255,255,.07); color:rgba(237,238,241,.55);`)}
    >{label}</button>
  )
}

/**
 * WHAT HE KNOWS THAT THE EVIDENCE DOES NOT.
 *
 * "That is because the summer bus timetable changed" is not a dismissal and it
 * is not a rating — it is a fact about the world that explains the pattern away,
 * and it is the single most valuable thing anybody can tell this system. It goes
 * into the memory core as a `stated` fact, which is the one knowledge kind
 * cognition may never overwrite and the one that survives a rebuild.
 *
 * Optional on purpose: "Wrong" on its own is a complete correction, and
 * demanding an explanation before accepting one would mean the honest answer to
 * "I do not want to type" is leaving a false claim in place.
 */
function Correction({ busy, onCancel, onSend }: { busy: boolean; onCancel: () => void; onSend: (text: string) => void }) {
  const [text, setText] = useState('')
  return (
    <div data-role="intelligence-correction" style={css('margin-top:22px;')}>
      <div style={css('font-size:12.5px; color:rgba(237,238,241,.62); margin-bottom:9px;')}>
        What am I getting wrong? (optional)
      </div>
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onSend(text.trim()) }}
        placeholder="The summer bus timetable changed"
        style={css(`width:100%; box-sizing:border-box; border:0; outline:0; border-radius:12px; padding:11px 13px;
          background:rgba(255,255,255,.06); box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);
          color:rgba(237,238,241,.9); font-family:inherit; font-size:13px;`)}
      />
      <div style={css('display:flex; gap:7px; margin-top:10px;')}>
        <button
          type="button"
          data-role="intelligence-correction-send"
          disabled={busy}
          onClick={() => onSend(text.trim())}
          style={css(`border:0; padding:8px 15px; border-radius:999px; cursor:pointer; font-family:inherit; font-size:12px;
            font-weight:600; background:rgba(237,238,241,.92); color:#0B0B0D;`)}
        >That’s wrong</button>
        <Quiet label="Cancel" onClick={onCancel} />
      </div>
    </div>
  )
}

// ── The evidence primitives ──────────────────────────────────────────────────

function Visual({ v }: { v: IntelligenceVisual }) {
  if (v.kind === 'comparison') {
    return (
      <div style={css('display:flex; align-items:flex-end; gap:18px; font-variant-numeric:tabular-nums;')}>
        <Big label={v.before.label} value={v.before.value} dim />
        <Big label={v.after.label} value={v.after.value} />
      </div>
    )
  }
  if (v.kind === 'tally') {
    const total = Math.max(1, v.for + v.against)
    return (
      <div>
        <div style={css('display:flex; height:8px; border-radius:999px; overflow:hidden; background:rgba(255,255,255,.06);')}>
          <div style={cssv`width:${(v.for / total) * 100}%; background:rgba(240,165,107,.8);`} />
        </div>
        <div style={css('margin-top:9px; font-size:12px; color:rgba(237,238,241,.6); font-variant-numeric:tabular-nums;')}>
          {v.for} of {v.for + v.against} {v.caption}
        </div>
      </div>
    )
  }
  if (v.kind === 'range') {
    return (
      <div>
        <div style={css('position:relative; height:8px; border-radius:999px; background:rgba(240,165,107,.22);')} />
        <div style={css('display:flex; justify-content:space-between; margin-top:9px; font-size:13px; font-weight:600; color:rgba(247,232,220,.9); font-variant-numeric:tabular-nums;')}>
          <div>{v.lo}</div>
          <div>{v.hi}</div>
        </div>
        <div style={css('margin-top:5px; font-size:11.5px; color:rgba(237,238,241,.4);')}>{v.caption}</div>
      </div>
    )
  }
  /*
    THE DISTRIBUTION, WITH MISSING KEPT APART FROM ZERO.

    `v: null` is "no reading that day" and it draws as an empty track rather than
    as a bar of height nothing. Activity has had this rule since its first
    version and it is the same rule here for the same reason: a day the phone was
    off is not a day he did not move, and a chart that renders them identically
    is a chart that lies about the quiet ones.
  */
  const max = Math.max(...v.bars.map((b) => b.v ?? 0), 1)
  return (
    <div>
      <div style={css('display:flex; align-items:flex-end; gap:5px; height:64px;')}>
        {v.bars.map((b, i) => (
          <div key={i} style={css('flex:1; display:flex; flex-direction:column; justify-content:flex-end; height:100%;')}>
            {b.v === null ? (
              <div style={css('height:3px; border-radius:2px; background:rgba(255,255,255,.07);')} />
            ) : (
              <div style={cssv`height:${Math.max(3, (b.v / max) * 64)}px; border-radius:3px;
                background:${b.mark ? 'rgba(240,165,107,.92)' : 'rgba(255,255,255,.14)'};`} />
            )}
          </div>
        ))}
      </div>
      <div style={css('display:flex; justify-content:space-between; margin-top:8px; font-size:11px; color:rgba(237,238,241,.34); font-variant-numeric:tabular-nums;')}>
        <div>{v.low}</div>
        <div>{v.high}</div>
      </div>
    </div>
  )
}

function Big({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div>
      <div style={css('font-size:9.5px; letter-spacing:.1em; text-transform:uppercase; color:rgba(237,238,241,.34);')}>{label}</div>
      <div style={cssv`margin-top:4px; font-size:26px; font-weight:600; letter-spacing:-.03em; color:rgba(247,232,220,${dim ? '.5' : '.95'});`}>{value}</div>
    </div>
  )
}

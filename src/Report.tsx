import { useState } from 'react'
import { css, cssv } from './css'
import { INSET, TYPE } from './tokens'
import { askSkin, skinOf } from './heat'
import Widgets from './Widgets'
import { SurfaceWorkspace } from './SurfaceWorkspace'
import { applyCorrection, noteEngaged, type Need, type WidgetAction } from './api'
import { draftingIn, useSurfaces } from './surface/store'
import { ReplyComposer } from './ReplyComposer'

export interface Msg {
  who: 'me' | 'ai'
  text: string
  /**
   * THIS TURN IS AN APOLOGY, NOT AN ANSWER.
   *
   * Marked rather than inferred from the words, because two things depend on
   * knowing: a failed turn is never written to durable storage (an apology for a
   * network blip is not something to greet him with tomorrow), and it is the
   * only kind of turn allowed to offer "Try again".
   */
  failed?: boolean
  /** Whether trying the same thing again could plausibly work. See `ApiError`. */
  retryable?: boolean
}

/**
 * The labels the composition layer guarantees, so the shared row can find them.
 *
 * Matching on the LABEL rather than the verb is deliberate and narrow: a builder
 * that wrote its own, better-worded `not-relevant` ("Not tracking activity")
 * keeps it, and it belongs with the card's own chips where its specificity
 * reads — it is about THAT card, not about the app's standard vocabulary. These
 * four strings are the standard vocabulary, written down once here and once in
 * `standardCorrections`, which is the only duplication a client/server split
 * allows for a thing the user reads.
 */
const STANDARD = new Set(['That’s wrong', 'Change source', 'Don’t use this'])

/** One affordance. Quiet, uniform, and the same on every card in the app. */
function Affordance({ label, on, onClick }: { label: string; on?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-affordance={label}
      onClick={onClick}
      style={cssv`flex:none; border:0; padding:5px 11px; border-radius:999px; cursor:pointer; font-family:inherit;
        font-size:11px; white-space:nowrap;
        background:rgba(255,255,255,${on ? '.12' : '.05'});
        box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);
        color:rgba(237,238,241,${on ? '.85' : '.55'});`}
    >{label}</button>
  )
}

/**
 * How each kind of ground is introduced.
 *
 * Deliberately plain language rather than the internal vocabulary: he needs to
 * know whether a line is something a source reported, something he said, or
 * something the app worked out — not what the type is called.
 */
const GROUND_LABEL: Record<string, string> = {
  observation: 'Your data says',
  object: 'A record says',
  fact: 'You told me',
  goal: 'Your goal',
  preference: 'Your preference',
  computation: 'I worked out',
  inference: 'I guessed',
}

interface Props {
  need: Need
  /**
   * What to offer him next.
   *
   * Passed in rather than read off `need.chips`, because when a task on this
   * surface is blocked the honest suggestions are the ones that unblock it —
   * and the card's own chips are, by definition, from before it got stuck. See
   * `chipsFor` in App.tsx.
   */
  chips: string[]
  thread: Msg[]
  /** The surface's own machinery, said at the seam rather than in the thread. */
  status: React.ReactNode
  done: boolean
  onSay: (need: Need, text: string) => Promise<void>
  onClose: () => void
  /** Perform a widget action. Throws to surface the failure inside the widget. */
  onAction: (need: Need, action: WidgetAction) => Promise<void>
}

export default function Report({ need, chips, thread, status, done, onSay, onClose, onAction }: Props) {
  /** What the server said it changed. Shown verbatim; never assumed. */
  const [corrected, setCorrected] = useState<string | null>(null)
  /**
   * "WHY THIS?" IS A CONTROL, NOT A PARAGRAPH.
   *
   * The grounds used to be printed unconditionally under every card — five or
   * six lines of provenance on a screen he opened to read one thing. Correct,
   * and skimmed past, which is the same as absent. Making it a control he can
   * press does two things at once: it gives the surface back to the content, and
   * it puts "why am I seeing this?" in the same place, with the same words, on
   * every intelligent card in the app. An affordance that appears sometimes is
   * not an affordance.
   */
  const [why, setWhy] = useState(false)

  const tap = async (label: string) => {
    const c = (need.corrections ?? []).find((x) => x.label === label)
    if (!c) return send(label)
    setCorrected('…')
    const out = await applyCorrection(c)
    setCorrected(out.said)
  }

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  /**
   * Whether this screen is composing something.
   *
   * `useSurfaces()` rather than a one-off read: the draft can arrive from the
   * MODEL, on a turn this component did not start, and a composer that only
   * re-derives its mode when he types would stay a chat box with a reply sitting
   * invisibly behind it.
   */
  useSurfaces()
  const drafting = draftingIn(need.id)

  /**
   * One way in. A chip used to paste a pre-written answer straight into the
   * thread without the model ever seeing it, so tapping "Sync it now" replied
   * with a canned line and synced nothing — three taps, three identical dead
   * replies. A chip is his words now, and goes the same way typing them does.
   */
  const send = async (what?: string) => {
    const text = (what ?? draft).trim()
    if (!text || sending) return
    if (what === undefined) setDraft('')
    setSending(true)
    try {
      await onSay(need, text)
    } finally {
      setSending(false)
    }
  }

  // The ask card is the composer opened up, not a need the model raised, so it
  // carries its own skin rather than a heat.
  const s = need.id === 'ask' ? askSkin : skinOf(done ? 'handled' : need.heat)
  const raw: Msg[] = [{ who: 'ai', text: need.opening }, ...thread]

  return (
    <SurfaceWorkspace
      scrollKey={need.id}
      messages={thread.length}
      /*
        THE HANDLE PREVIEWS THE CONVERSATION, AND ONLY THE CONVERSATION.

        It used to fall back to `need.opening` when the thread was empty — the
        model's report opening, which is a summary of the loudest source. So the
        sentence *"6 in the last week from 5 senders. Newest: Your…"* was drawn
        along the bottom of Calendar, Mail, Activity, Video and Watch: on Mail it
        restated the list two inches above it, and on Activity it was simply
        about something else. That is the same mail counter the intelligence slot
        was carrying, reaching every other surface by a second route — and
        replacing the slot alone would have left it in place, which is most of
        why it is worth writing down.

        An empty thread has no last message. `undefined` falls through to the
        handle's own invitation ("Ask about this"), which is what a conversation
        nobody has started should say.
      */
      latest={thread.length ? thread[thread.length - 1].text : undefined}
      header={
      /*
        ONE ROW, ~52px.

        It was 130px — a drag pill, an eyebrow, a 25px display title and two
        lines of status — on a 874px screen, to say what the card he tapped had
        just said in the same words. Fifteen per cent of the phone spent on a
        restatement, taken directly from the application underneath it, which is
        the thing he actually opened.

        What survives is what is not recoverable from the surface itself: which
        application this is, and the way out. Close is a REAL BUTTON now rather
        than a whole-header tap target, because a 130px header absorbing every
        stray touch is how a header becomes a way to leave by accident.
      */
      <div
        data-edge="surface-header"
        style={cssv`flex:none; display:flex; align-items:center; gap:9px;
          padding:9px ${INSET.page}px 9px; background:${s.headerBg};
          box-shadow:inset 0 -1px 0 rgba(255,255,255,.06);`}
      >
        <div style={cssv`width:6px; height:6px; flex:none; border-radius:999px; background:${s.dot};`} />
        <div style={css('flex:1; min-width:0;')}>
          <div style={css('font-size:16px; font-weight:600; letter-spacing:-.02em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>
            {need.title}
          </div>
          {need.status ? (
            <div style={cssv`margin-top:1px; font-size:${TYPE.small}; line-height:1.35; color:rgba(237,238,241,.44);
              white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>{need.status}</div>
          ) : null}
        </div>
        <div
          data-role="surface-close"
          onClick={onClose}
          style={cssv`flex:none; display:flex; align-items:center; gap:5px; padding:6px 11px; border-radius:999px;
            background:rgba(255,255,255,.06); box-shadow:inset 0 0 0 1px rgba(255,255,255,.09);
            font-size:${TYPE.small}; color:rgba(237,238,241,.7); cursor:pointer;`}
        >close</div>
      </div>
      }
      surface={
        /*
          The whole frame is the application. The generic stats tiles and the
          pane action row used to sit here, ABOVE the domain renderer, which is
          how Calendar ended up with a minority of its own frame. Both were
          domain information rendered by the workspace; both now belong to the
          surface that owns them, expressed however that domain expresses it
          best — Calendar puts its range and count in its own toolbar rather
          than as a large tile nobody asked for.
        */
        need.panes?.length ? (
          /* The card named one thing; the surface opens on that thing. */
          <Widgets
            panes={need.panes}
            heat={need.heat}
            owner={need.id}
            focus={need.focus}
            /**
             * Acting on what a card offered is the strongest evidence there is
             * that the card was worth showing — stronger than opening it, which
             * he may have done to find out what it was. It nudges the ranking
             * for this subject and touches nothing he has stated. See
             * `noteEngaged`.
             */
            onAction={(a) => { noteEngaged(need.topic, 'accepted'); return onAction(need, a) }}
          />
        ) : null
      }
      status={status}
      chat={<>
        <div style={css('display:flex; flex-direction:column; gap:10px; padding-top:2px;')}>
          {raw.map((m, i) => {
            const b = m.who === 'ai'
              ? { justify: 'flex-start', radius: '16px 16px 16px 5px', bg: 'rgba(255,255,255,.06)', fg: 'rgba(237,238,241,.92)', shadow: 'inset 0 0 0 1px rgba(255,255,255,.05)' }
              : { justify: 'flex-end', radius: '16px 16px 5px 16px', bg: 'rgba(237,238,241,.92)', fg: '#101012', shadow: 'none' }
            return (
              <div key={i} style={cssv`display:flex; justify-content:${b.justify}; animation:cruRise .3s ease;`}>
                <div style={cssv`max-width:82%; padding:11px 14px; border-radius:${b.radius}; background:${b.bg}; color:${b.fg}; font-size:13.5px; line-height:1.5; box-shadow:${b.shadow}; text-wrap:pretty;`}>{m.text}</div>
              </div>
            )
          })}
        </div>

        {/*
          WHY AM I SEEING THIS — answered by listing the grounds, each labelled
          with what KIND of thing it is.

          The labels are the point, not decoration. "Your data says" and "I
          guessed" carry completely different authority, and a reader who cannot
          tell them apart cannot know which step to argue with. This is also
          what makes the chips below meaningful: they correct a named ground,
          not a vibe.
        */}
        {/*
          THE SHARED AFFORDANCE ROW.

          Four things, in the same order, on every intelligent card: why this,
          that's wrong, change source, don't use this. The last three come from
          the server's closed correction verb set — the composition layer adds
          any that a builder did not write, so there is no such thing as a
          computed card you cannot argue with (see `standardCorrections`). The
          first is inspection and writes nothing.

          They are drawn HERE, apart from the conversational chips below, so that
          a control which changes the personal model never looks like a canned
          reply. Tapping one of these has a defined effect and says what it was.
        */}
        {need.because && (
          <div data-role="affordances" style={css('padding:6px 2px 2px; display:flex; flex-wrap:wrap; gap:6px; align-items:center;')}>
            <Affordance label={why ? 'Hide the reasons' : 'Why this?'} on={why} onClick={() => setWhy(!why)} />
            {(need.corrections ?? [])
              .filter((c) => STANDARD.has(c.label))
              .map((c) => <Affordance key={c.label} label={c.label} onClick={() => void tap(c.label)} />)}
          </div>
        )}

        {need.because && why && (
          <div data-role="because" style={css('padding:2px 2px 2px; display:flex; flex-direction:column; gap:4px;')}>
            <div style={css('font-size:11px; color:rgba(237,238,241,.42); line-height:1.5;')}>{need.because.sentence}</div>
            {need.because.grounds.map((g, i) => (
              <div key={i} style={css('font-size:11px; line-height:1.5; color:rgba(237,238,241,.34);')}>
                <span style={css('color:rgba(237,238,241,.5);')}>{GROUND_LABEL[g.kind] ?? 'From'}</span>{' '}{g.says}
              </div>
            ))}
            {(need.uncertainty ?? []).map((u, i) => (
              <div key={`u${i}`} style={css('font-size:11px; line-height:1.5; color:rgba(240,165,107,.62);')}>
                Not certain: {u}
              </div>
            ))}
          </div>
        )}

        {/* What the server said it changed, verbatim. A correction that reports
            nothing is indistinguishable from one that did nothing. */}
        {corrected && (
          <div data-role="corrected" style={css('margin-top:6px; padding:9px 12px; border-radius:12px; background:rgba(28,24,20,.9); font-size:12px; line-height:1.45; color:rgba(255,220,170,.9);')}>
            {corrected}
          </div>
        )}

        {/* What this rests on. The design shows conclusions; this makes them checkable. */}
        {need.basis.length > 0 && (
          <div style={css('padding:2px 2px 6px; font-size:11px; line-height:1.5; color:rgba(237,238,241,.26);')}>
            {need.asks ? 'asking because I don’t know yet' : `from ${need.basis.length} thing${need.basis.length > 1 ? 's' : ''} I’ve seen`}
          </div>
        )}
      </>}
      chips={
      <div data-edge="chips" style={cssv`flex:none; padding:8px ${INSET.page}px; display:flex; gap:8px; overflow-x:auto;`}>
        {chips.filter((c) => !STANDARD.has(c)).map((c, i) => (
          <div
            key={i}
            /*
              A CHIP ON A COMPUTED CARD IS A CORRECTION, NOT A SENTENCE.

              Every chip used to be typed into the composer for the model to
              interpret, which is right for "tell me more" and wrong for "use
              Apple Health": the second is a decision with a defined effect on
              the personal model, and routing it through a language model makes
              whether it takes effect depend on how the model felt about the
              phrasing. Cards that carry `corrections` name the verb outright,
              so tapping one writes to the model and says what it wrote.
            */
            onClick={() => void tap(c)}
            style={cssv`flex:none; padding:9px 14px; border-radius:999px; background:rgba(255,255,255,.06); box-shadow:inset 0 0 0 1px rgba(255,255,255,.14); font-size:12.5px; color:rgba(237,238,241,${sending ? '.36' : '.82'}); cursor:pointer; white-space:nowrap;`}
          >{c}</div>
        ))}
      </div>
      }
      composer={
      /*
        ONE REGION, TWO MODES.

        The mode is DERIVED from application state — a surface under this screen
        is holding a draft — rather than from a flag this component keeps. That
        is what makes it correct when the model puts a draft in the composer:
        `draft` is a declared capability, it writes surface state, and the
        composer changes mode because the state changed, not because something
        remembered to tell it.

        There is never both. The assistant's composer is not rendered while a
        reply is open, so there is exactly one place to type and its send button
        has exactly one meaning. See ReplyComposer.tsx.
      */
      drafting?.state.draft ? (
        <ReplyComposer
          surfaceKey={drafting.key}
          draft={drafting.state.draft}
          thinking={sending}
          onAction={(a) => onAction(need, a)}
          onAsk={(instruction, draft) => onSay(
            need,
            /*
              His instruction, with the draft it is about attached.

              Said out loud in the conversation rather than smuggled into a
              system prompt: the thread is the record of what was asked, and a
              rewrite he cannot see the request for is a rewrite he cannot
              disagree with. The model answers by using its `draft` capability,
              which lands back in the same composer.
            */
            `${instruction}\n\n(This is about the reply I am writing to ${draft.to ?? 'them'}, subject "${draft.subject ?? ''}". The current draft is:\n${draft.text || '(empty)'}\n\nUse the mail surface's draft operation to replace it.)`,
          )}
        />
      ) : (
      <>{/* A real composer. This was a placeholder div in the design mock, which
          meant the one thing the whole app is premised on — answering it in
          your own words — could not be done at all. */}
      {/* The same pill as Home's, to the pixel. It was inset 15 here and 18
          there, so the one control on every screen put its placeholder in two
          different columns depending which screen you were on. */}
      <div data-frame="composer" style={cssv`flex:none; margin:0 ${INSET.page}px 12px; padding:13px ${INSET.page}px; border-radius:22px; background:rgba(30,32,37,.55); box-shadow:inset 0 1px 0 rgba(255,255,255,.16), inset 0 0 0 1px rgba(255,255,255,.09); display:flex; align-items:center; gap:11px;`}>
        <input
          value={draft}
          disabled={sending}
          placeholder={sending ? 'Thinking…' : 'Message Crucible…'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
          style={css('flex:1; min-width:0; background:transparent; border:0; outline:0; font-family:inherit; font-size:14px; color:rgba(237,238,241,.92);')}
        />
        <div
          onClick={() => void send()}
          style={cssv`width:30px; height:30px; flex:none; border-radius:999px; background:rgba(237,238,241,${draft.trim() && !sending ? '.9' : '.35'}); display:flex; align-items:center; justify-content:center; color:#0B0B0D; font-size:15px; cursor:pointer;`}
        >↑</div>
      </div>
      </>
      )}
    />
  )
}

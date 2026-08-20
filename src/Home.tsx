import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { css, cssv } from './css'
import { INSET, LANE, LANE_ORDER, TYPE } from './tokens'
import {
  archivePane, dismissObject, pinPane, saveObject, setDeck, useHomeState,
} from './home/homeState'
import { BandCard } from './home/LaneCards'
import { DeckOverview, WidgetDeck } from './home/WidgetDeck'
import { RelevanceCard, RELEVANCE_H } from './home/Slots'
import { IntelligenceCard, INTELLIGENCE_H } from './home/Intelligence'
import { QuestionCard } from './home/QuestionCard'
import { classify } from './home/lanes'
import { failIfPoisoned } from './poison'
import type { DeckChip, Feed, IntelligencePresentation } from './api'

/**
 * HOME IS A WIDGET DECK, AND THE WIDGETS ARE THE NAVIGATION.
 *
 * Three slots, and they never move:
 *
 *   1  the widget deck   one full-width domain, swiped sideways through them all
 *   2  relevance         whatever most deserves the space underneath it
 *   3  intelligence      Crucible thinking out loud
 *
 * WHAT THIS REPLACED. Three attention bands — now, next, background — each
 * showing one card. That structure was right about the problem and wrong about
 * the picture: it made every domain compete for a slot, so an application with
 * nothing urgent to say today ceased to exist, and the only way to reach it was
 * a URL. Ranking now chooses which widget he LANDS on and never whether a domain
 * is present at all, which is the difference between a screen that ranks his
 * life and a screen that hides most of it.
 *
 * The tile strip is still gone and is still not coming back. A widget is not a
 * tile: it is full width, it says what that domain currently holds, and it is
 * the thing you act on rather than a label you press to go and find it.
 *
 * WHAT CAME OUT OF THE HEADER. The date, the day name, the clock, the town, the
 * "as of" stamp and every source label. The phone already says the time and the
 * widget already says which domain it is. Nothing on Home restates the phone.
 *
 * THERE IS STILL NO VERTICAL SCROLLING ON HOME. Not on Home itself, not in a
 * slot, not inside a card, not inside a card's text. The deck scrolls on X and
 * that is the single exemption. A slot that needs a scrollbar is a slot whose
 * content was never prioritised, and the fix is upstream every time — see the
 * overflow ladder in docs/ui-contract.md.
 */

interface Props {
  feed: Feed | null
  thinking: boolean
  cold: boolean
  needsBrain: boolean
  needsSignIn: boolean
  onOpen: (id: string) => void
  /** Open an app focused on one object he tapped inside a widget. */
  onOpenObject: (app: string, objectId: string) => void
  onOpenSettings: () => void
  /**
   * A QUESTION WAS ANSWERED ON HOME. Everything stalled on it is recomputed.
   *
   * The write has already happened — `QuestionCard` calls the correction
   * endpoint directly, because the answer is a typed verb and not a sentence for
   * a model to interpret.
   */
  onAnswer: (said: string) => void
  /** "Something else…" — put that question in front of the shared composer. */
  onElaborate: (question: string) => void
  /** A failed run, tried again. Reachable because slot two can carry the task. */
  onRetryTask: (id: string) => void
  /** A chip on a widget or on the thought. Runs a capability, or says so. */
  onChip: (c: DeckChip) => void
  /**
   * THE INTELLIGENCE CARD WAS TAPPED. Open the evidence behind it.
   *
   * The card had `cursor: auto` and no handler at all, so the one thing on Home
   * that says what Crucible worked out was the one thing that could not be
   * asked about. Depth is where the correction lives too — see
   * `IntelligenceDepth`.
   */
  onOpenIntelligence: (m: IntelligencePresentation) => void
  /** Height to leave clear at the bottom for the chat overlay's composer. */
  reserve: number
  /** The one status line — what just happened, and how to undo or stop it. */
  status: React.ReactNode
  /**
   * WHETHER THE MODEL'S CARDS PREDATE THE DAY TURNING OVER.
   *
   * A boolean, and it was a string — "yesterday" when the day had turned, a
   * clock time otherwise, rendered as `as of <x>`. So the common case put a
   * timestamp on Home, which the frozen contract forbids by name. See
   * `showingYesterday` in App.tsx for why the warning survived and the clock
   * did not.
   *
   * It lives in the status row, which is already reserved, already the place for
   * "here is something you should know about what you are looking at", and costs
   * the layout nothing.
   */
  showingYesterday: boolean
}

/** See the note beside `moved` in Home: this is deliberately not component state. */
let deckTouched = false

export default function Home({
  feed, thinking, cold, needsBrain, needsSignIn,
  onOpen, onOpenObject, onOpenSettings, onChip, onOpenIntelligence, onAnswer, onElaborate, onRetryTask,
  reserve, status, showingYesterday,
}: Props) {
  const { durable, local } = useHomeState()

  // Home is the screen everything else falls back TO, so it is the one whose
  // containment matters most and the one that had none. See poison.ts.
  failIfPoisoned('home')

  const deck = feed?.deck
  const widgets = deck?.widgets ?? []

  /**
   * Overview is a MODE, not a screen, and it is device-local and unpersisted.
   *
   * Deliberately `useState` rather than stored: it closes the moment he picks a
   * domain, and something that cannot survive a pick has no business surviving a
   * reload. Persisting it is the first step towards it becoming a home screen.
   */
  const [overview, setOverview] = useState(false)

  /**
   * HAS HE MOVED THE DECK HIMSELF THIS SESSION? See `landing` below.
   *
   * MODULE SCOPE, NOT A REF, AND THAT IS THE WHOLE FIX FOR A REPORTED BUG.
   *
   * Opening any application UNMOUNTS Home (see App.tsx — the surface replaces
   * it rather than covering it), so a `useRef` here was reset every time he
   * came back from one. The landing rule then re-fired against a fresh mount
   * and overruled the domain he had deliberately swiped to: he left from
   * Places, and Home decided on his behalf that Places was quiet and put him
   * back on Mail. From the outside that is "the cards do not stay where I left
   * them", and no amount of animation work would have touched it.
   *
   * A module-level flag has exactly the lifetime the rule was always described
   * as having — the session. It survives navigating in and out of surfaces, and
   * it resets when the app is actually relaunched, which is the one moment
   * ranking is entitled to choose where he lands.
   */

  /**
   * WHICH DOMAIN IS IN FRONT — resolved from a stored ID, never a stored index.
   *
   * A re-rank reorders the deck; an index would come back pointing at a
   * different application, which is the viewport theft the lanes solved the same
   * way. If the domain he was on is gone — he switched it off, or the connector
   * did — the deck falls back to the front rather than to a blank page.
   */
  /*
    AND WHEN HE HAS NOT PICKED ONE, IT IS THE FIRST WITH SOMETHING TO SAY.

    `findIndex` returns -1 for "no stored domain", which became 0 — the front of
    the deck. The front of the deck is his own arrangement, and on his actual
    account that is Calendar, which today has nothing on it. So opening Crucible
    put an empty domain in the largest region of the screen, and the six unread
    conversations one swipe to the right were invisible.

    His ORDER is untouched: the deck is still arranged the way he arranged it,
    and this decides only where the deck is parked before he moves it — which is
    the one thing the design does leave to ranking ("ranking chooses which one he
    lands on first, and nothing else"). If every domain is quiet it lands at the
    front, because then there is no better answer and pretending otherwise would
    just be motion.
  */
  const stored = widgets.findIndex((w) => w.id === local.deck)
  const firstLive = Math.max(0, widgets.findIndex((w) => !w.quiet))
  /*
    AND IT IS DECIDED ONCE, AT MOUNT.

    Not on every render, which was the first version and was worse than the bug:
    the deck persists whatever it is scrolled to, so a rule that reads "if the
    stored domain is quiet, go to the first live one" evaluated continuously
    would drag him back out of Calendar the instant he deliberately swiped INTO
    it. `moved` is the difference between "he has not touched this yet" and "he
    has", and only the first is the app's to decide.

    It also has to survive the cold frame: the very first render has no widgets
    at all, the scroll handler fires at position 0, and that wrote `calendar`
    back into storage before this could ever see it — which is why a stored id
    is not, on its own, evidence of a choice.
  */
  const landing = deckTouched
    ? Math.max(0, stored)
    : stored >= 0 && !widgets[stored]?.quiet ? stored : firstLive
  const index = Math.min(landing, Math.max(0, widgets.length - 1))
  const active = widgets[index] ?? null

  /**
   * SLOT TWO ANSWERS TO HIS SITUATION, NOT TO THE WIDGET ABOVE IT.
   *
   * The override exists for the case the design called out: when the deck is on
   * a domain and there IS something to say about that domain, saying it beats
   * holding the general answer. Everywhere else the card holds — which is what
   * makes it a relevance slot rather than a caption.
   */
  /*
    An override with no `needId` is the server saying "nothing to add under this
    widget" — distinct from having no opinion, which falls through to the general
    card. See `SILENT` in deck.ts.
  */
  const override = active ? deck?.relevanceFor[active.id] : undefined
  const relevance = override ? (override.needId ? override : null) : deck?.relevance ?? null

  /**
   * A QUESTION OUTRANKS BOTH LOWER SLOTS, AND TAKES THEM BOTH.
   *
   * "Questions are answered inline on Home" is frozen, and the three-slot layout
   * has to keep it true rather than quietly relocate questions into a surface.
   * So an unanswered question IS slot two — it is by definition the thing most
   * worth the space — and slot three yields to it, because a question and a
   * thought competing for attention is the "one dominant interaction" rule being
   * broken by a layout instead of by a modal.
   *
   * It gets both slots' height, and that is not generosity: the question itself
   * and its primary action are on the never-clipped list, and 126px with four
   * choices under it is exactly how they got clipped last time.
   */
  const lanes = useMemo(() => classify(feed, durable), [feed, durable])
  const ranked = useMemo(() => LANE_ORDER.flatMap((b) => lanes[b]), [lanes])
  const asking = useMemo(() => ranked.find((o) => o.need?.asks) ?? null, [ranked])

  /**
   * WHAT ELSE CAN OWN SLOT TWO — and why this is not the bands coming back.
   *
   * The deck is domains. A task he started, a pane he pinned and a run that
   * failed are none of those, and the three attention bands were where they used
   * to live. Losing the bands must not lose THEM: a failed task with no retry on
   * screen is exactly the "failures become permanent debris" state the retention
   * rules exist to prevent, and it would have been an invisible regression —
   * nothing on the new Home looks like it is missing.
   *
   * So they compete for slot two like everything else, and they win it when they
   * need him, because that is what the slot is: whatever most deserves the space,
   * whether or not it belongs to the widget above it. One object, never a list.
   */
  const claim = useMemo(
    /*
      Panes are in this list, and leaving them out was a regression that the
      gate caught: a pane he PINNED is something he chose to keep on Home, and
      the filter dropped it because it neither needs him nor is a task. "His
      arrangement outranks the assistant's" applies to what is on the screen at
      all, not only to the order of it.
    */
    () => ranked.find((o) => o.kind !== 'source' && (o.needsUser || o.kind === 'task' || o.kind === 'pane')) ?? null,
    [ranked],
  )

  /*
    AND SLOT THREE NEVER RESTATES SLOT TWO.

    Checked here because here is the only place that knows what slot two ACTUALLY
    ended up holding — a question, a failed task, or the relevance card, decided
    by the precedence below. The server can only exclude the general relevance
    card; doing more there deleted the thought entirely as soon as any widget had
    an override, because it could not know which override was live.

    BY SUBJECT AS WELL AS BY ID, which is the half the id check could not see.
    Slot two is an attention card about an object and slot three is a conclusion
    about a pattern: two different rows, two different ids, and on a bad morning
    the same appointment. The presentation carries `subjectRefs` — typed object
    ids, never words — so the collision is detectable without comparing two
    rendered sentences, which is the re-derivation this codebase refuses.
  */
  const slotTwo = asking ?? claim ?? null
  const slotTwoId = slotTwo?.id ?? relevance?.needId ?? null
  const intelligence = useMemo(() => {
    const m = deck?.intelligence
    if (!m || m.id === slotTwoId) return null
    const subjects = new Set(m.subjectRefs.filter(Boolean))
    const focus = slotTwo?.need?.focus
    if (focus && subjects.has(focus)) return null
    if (slotTwo?.need?.basis?.some((b) => subjects.has(b))) return null
    return m
  }, [deck?.intelligence, slotTwoId, slotTwo])

  const root = useRef<HTMLDivElement>(null)

  /**
   * IS THERE ROOM UNDER THE QUESTION FOR THE THOUGHT? MEASURED, NOT ASSUMED.
   *
   * The question's budget is slot two plus slot three, so whatever it does not
   * use is exactly the space slot three could have. That makes this a purely
   * local question — the question card's own height against its own budget —
   * rather than a layout calculation over the whole column, which would be
   * circular: mounting the thought changes the column it was measured against.
   *
   * A constant standing in for a measurement is how every phone-only layout bug
   * in this app has started, and "assume a question is short" would be one:
   * four choices, a long baseline and a large accessibility text scale each push
   * the card past its own budget on their own.
   */
  const askBox = useRef<HTMLDivElement>(null)
  const [askH, setAskH] = useState(0)
  useLayoutEffect(() => {
    const el = askBox.current
    if (!el) { setAskH(0); return }
    const read = () => setAskH(el.getBoundingClientRect().height)
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [asking?.id])

  /** The thought's own floor plus the gap above it. See `IntelligenceCard`. */
  const MIND_MIN = 96 + 10
  const roomForMind = askH > 0 && askH <= RELEVANCE_H + 10 + INTELLIGENCE_H - MIND_MIN

  return (
    <div
      ref={root}
      data-frame="home"
      data-home-mode={overview ? 'overview' : 'deck'}
      style={cssv`flex:1; min-height:0; overflow:hidden; display:flex; flex-direction:column;
        position:relative; gap:10px; padding:6px 0 ${reserve}px;`}
    >
      {needsSignIn || needsBrain ? (
        /*
          Onboarding replaces the deck rather than stacking above it. "Connect a
          model" and "here is your morning" are answers to the same question and
          only one of them is ever true.
        */
        <Onboarding kind={needsSignIn ? 'signin' : 'brain'} onOpenSettings={onOpenSettings} />
      ) : overview ? (
        <DeckOverview
          widgets={widgets}
          onClose={() => setOverview(false)}
          onPick={(i) => {
            const picked = widgets[i]
            // Picking one out of the grid is as deliberate as swiping to it, so
            // it has to defeat the landing rule the same way. Without this,
            // choosing a quiet domain here put him straight back on a loud one.
            if (picked) { deckTouched = true; setDeck(picked.id) }
            setOverview(false)
          }}
        />
      ) : widgets.length === 0 ? (
        /*
          NOTHING IS CONNECTED, OR NOTHING HAS ARRIVED YET, SAID ONCE.

          An empty deck is not an empty state to decorate — it is either a cold
          start, a think in progress, or an app with no sources, and those are
          three different sentences. The composer below is still there, which is
          the way out of all three.
        */
        <div
          data-role="home-quiet"
          style={cssv`flex:none; padding:${LANE.gap}px ${INSET.page}px; font-size:${TYPE.small};
            color:rgba(237,238,241,.3);`}
        >
          {cold ? 'Starting up' : thinking ? 'Thinking' : 'Nothing is connected yet'}
        </div>
      ) : (
        <>
          <WidgetDeck
            widgets={widgets}
            index={index}
            onIndex={(i) => { const w = widgets[i]; if (w) setDeck(w.id) }}
            onUserMove={() => { deckTouched = true }}
            onOverview={() => setOverview(true)}
            onOpen={onOpen}
            onOpenObject={onOpenObject}
            onChip={onChip}
          />

          {/*
            SLOTS TWO AND THREE MAY BE ABSENT, AND ABSENT MEANS ABSENT.

            No placeholder card, no "nothing to report" box. An empty slot leaves
            space rather than reserving populated geometry — the same rule the
            collapsed band had, applied to a screen with no bands.
          */}
          {asking ? (
            /*
              A QUESTION STILL OUTRANKS BOTH LOWER SLOTS. IT NO LONGER SPENDS
              BOTH OF THEM ON NOTHING.

              The rule was that a question takes slot two AND slot three, so that
              the question and its primary action — both on the never-clipped
              list — can never be squeezed. That much is unchanged and is why the
              bound is still exactly the two slots plus their gap.

              What was wrong was making it take that height whether or not it
              needed it. A three-chip question drew a 306px panel around 250px of
              void, and slot three — the one thing on Home that says what
              Crucible worked out — was suppressed to make room for the void.
              `max-height` gives the question its ceiling and hands anything it
              does not use back to the thought underneath, which is what he meant
              by three panes that are all persistently worth reading.

              This is not the two competing for attention: the question is first,
              full width, and answered in place. The thought is what fills the
              space the question declined to use.
            */
            <>
              <div
                ref={askBox}
                data-role="home-question"
                data-deck="question"
                data-card={asking.id}
                style={cssv`flex:none; padding:0 16px; max-height:${RELEVANCE_H + 10 + INTELLIGENCE_H}px; box-sizing:border-box;`}
              >
                <QuestionCard o={asking} onAnswered={onAnswer} onElaborate={onElaborate} />
              </div>
              {intelligence && roomForMind && <IntelligenceCard m={intelligence} onOpen={onOpenIntelligence} />}
            </>
          ) : claim ? (
            <>
              <div data-role="home-claim" data-deck="relevance" data-card={claim.id} style={cssv`flex:none; padding:0 16px; height:${RELEVANCE_H}px; box-sizing:border-box;`}>
                <BandCard
                  o={claim}
                  pinned={durable.pinnedPanes.includes(claim.id)}
                  onOpen={onOpen}
                  onOpenObject={onOpenObject}
                  onPin={(on) => pinPane(claim.id, on)}
                  onArchive={() => archivePane(claim.id)}
                  onRetry={() => onRetryTask(claim.id)}
                  onSave={() => saveObject(claim.id, claim.need?.topic)}
                  onDismiss={() => dismissObject(claim.id, claim.need?.topic)}
                  onAnswer={onAnswer}
                  onElaborate={onElaborate}
                />
              </div>
              {intelligence && <IntelligenceCard m={intelligence} onOpen={onOpenIntelligence} />}
            </>
          ) : (
            <>
              {relevance && <RelevanceCard r={relevance} onOpen={onOpen} />}
              {intelligence && <IntelligenceCard m={intelligence} onOpen={onOpenIntelligence} />}
            </>
          )}
        </>
      )}

      {/*
        THE STATUS ROW, IN THE LAYOUT RATHER THAN ON TOP OF IT.

        Reserved whether or not there is a status, so the screen never moves
        because something was said, and never drawn over the slot beneath it —
        which is how "undo" once printed itself across a card's content.
      */}
      {/*
        THE "as of" STAMP IS GONE; THE STALE-DAY WARNING IS NOT.

        `docs/ui-contract.md`: "Nothing on Home restates the phone. No date, no
        day name, no clock, no town, no 'as of' stamp, no source label." The
        decision log records it settled against "a context row with date, place
        and 'as of'". This band was rendering `as of 14:20` whenever there was no
        status to show, which is most of the time — the rule was not reversed by
        anybody, it came back as the else-branch of the warning beside it.

        What is left says what is WRONG rather than what time it is: these cards
        were written before the day turned over, so anything day-bound on them is
        about yesterday. That is not chrome, it is the difference between a slow
        app and an app confidently showing the wrong day.

        The BAND stays reserved either way, for the reason above it.
      */}
      <div data-role="home-status" style={cssv`flex:none; height:${LANE.status}px; overflow:hidden;`}>
        {status ?? (showingYesterday && !thinking ? (
          <div style={cssv`padding:0 ${INSET.page}px; font-size:${TYPE.micro}; color:rgba(240,165,107,.62); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>
            Still showing yesterday’s thinking.
          </div>
        ) : null)}
      </div>
    </div>
  )
}

/**
 * The two states where there is nothing true to show yet.
 *
 * Deliberately one card in the deck's place rather than a card stacked on top of
 * an empty deck: a row of "nothing here" widgets above a "connect a model"
 * prompt would be six statements of a fact the prompt already explains.
 */
function Onboarding({ kind, onOpenSettings }: { kind: 'signin' | 'brain'; onOpenSettings: () => void }) {
  const body = kind === 'signin'
    ? {
        title: 'Sign in and I’ll pick things up.',
        sub: 'One Google sign-in — it’s how I know it’s you, and how I see your calendar, mail and activity.',
        cta: 'Sign in with Google',
      }
    : {
        title: 'I need a model to think with.',
        sub: 'Connect a key from any provider — a free tier is enough to start.',
        cta: 'Connect a model',
      }

  const inner = (
    <>
      <div style={css('display:flex; align-items:center; gap:7px; font-size:11px; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:#F0A56B;')}>
        <div style={css('width:6px; height:6px; border-radius:999px; background:#F0A56B; box-shadow:0 0 7px #F0A56B;')} />
        needs you · to begin
      </div>
      <div style={css('margin-top:11px; font-size:21px; font-weight:600; letter-spacing:-.028em; line-height:1.2;')}>{body.title}</div>
      <div style={css('margin-top:11px; font-size:12.5px; line-height:1.45; color:rgba(237,238,241,.62);')}>{body.sub}</div>
      <div style={css('margin-top:15px; padding:10px 15px; border-radius:12px; background:rgba(237,238,241,.92); color:#0B0B0D; font-size:13px; font-weight:600; display:inline-block;')}>{body.cta}</div>
    </>
  )

  const skin =
    `flex:none; position:relative; margin:0 ${INSET.page}px; border-radius:26px; ` +
    `padding:17px ${INSET.card}px; cursor:pointer; overflow:hidden; display:block; color:inherit; ` +
    'background:linear-gradient(160deg, rgba(48,38,26,.5), rgba(26,22,18,.4)); ' +
    'box-shadow:inset 0 1.5px 0 rgba(255,220,170,.16), inset 0 0 0 1px rgba(240,165,107,.2);'

  return kind === 'signin'
    ? <a href="/auth/login" style={css(skin)}>{inner}</a>
    : <div onClick={onOpenSettings} style={css(skin)}>{inner}</div>
}

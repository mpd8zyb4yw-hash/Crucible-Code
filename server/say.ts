import { route } from './router.js'
import { renderWorld, mutateWorld, type World } from './world.js'
import { humanReply } from './reply.js'
import { recordAnswer, slotForReply } from './answer.js'
import { readPerson } from './person.js'
import { addTrack } from './tracks.js'
import { renderSelf } from './self.js'

/**
 * Record what he just said: typed field first, sentence second, one transaction.
 *
 * Kept local rather than calling the `/api/person/tell` handler, because that one
 * parses an HTTP body and this already has the values — and both end up in
 * `recordAnswer`, which is the single implementation of the rule.
 */
async function recordSaid(input: {
  text: string
  card?: { id?: string; title: string; status: string; asks?: boolean } | null
  at: Date
}): Promise<void> {
  await mutateWorld((w) => {
    const person = readPerson(w)
    /**
     * ONLY when the card actually ASKED something. A reply typed under a card that
     * was telling him something is not an answer to a question, and treating it as
     * one would write a permanent `by: 'user'` fact from a remark.
     */
    const slot = input.card?.asks
      ? slotForReply(person, { cardId: input.card.id, question: input.card.title })
      : null
    const out = recordAnswer(person, {
      slot: slot ?? undefined,
      question: input.card?.asks ? input.card.title : undefined,
      text: input.text,
      at: input.at,
    })
    w.person = person
    // The history record. Keeping the card title in it is what makes a bare "yes"
    // interpretable later; `recordAnswer` puts the question in the text.
    const observation = slot
      ? out.observation
      : {
          ...out.observation,
          text: input.card
            ? `While looking at "${input.card.title}", he said: ${input.text}`
            : `He said: ${input.text}`,
        }
    const held = w.observations.findIndex((o) => o.id === observation.id)
    if (held >= 0) w.observations[held] = observation
    else w.observations.push(observation)
  }, { label: 'what you said' }).catch(() => undefined)
}

/**
 * Talking to it.
 *
 * The composer was decorative until now — a placeholder inherited from the
 * design mock, with no input behind it. This is the other half of the loop the
 * app is built around: it can ask him things, so he has to be able to answer
 * in his own words, not only by tapping a chip.
 *
 * Two things happen per message. It replies in context — it is shown the same
 * world model the synthesis pass sees, plus whichever card is open — and what
 * he said is written back as an observation, because a thing he tells it is
 * evidence exactly like a calendar entry is. That is why replying here can
 * change the feed.
 */

const SYSTEM = `You are Crucible, a personal assistant, replying inside a conversation the person opened from a card.

You are shown everything you know about them. Answer in their language, in one or two short paragraphs at most — this renders in a narrow phone bubble, so length costs them.

- Ground what you say in the evidence you were given. If you do not know something, say so and ask.
- Never invent a number, a date or a price.
- If what they just said is a fact about their life, acknowledge it plainly; it is being remembered, so do not promise to remember it.
- No greeting, no sign-off, no "as an AI". Talk like a sharp friend who already has the context.
- You may be asked about YOURSELF — which models you are using, why one stopped working, how much budget is left, what is connected. You are given that state below when there is any. Answer it as plainly as you answer anything else, from the facts given; never speculate about your own internals.

YOU CAN ACT. You are not only talking — you may take exactly one action per reply by returning it alongside your words:
- {"kind":"sync"} — pull his calendar, mail, activity and steps from Google right now.
- {"kind":"track","question":"...","why":"..."} — start watching something on an ongoing basis, so it is checked without him asking again.
- {"kind":"research","question":"..."} — look something up on the open web right now.
- {"kind":"pane","intent":"..."} — build him a PANE on his home screen showing something, from his connected accounts. Use this whenever he asks to see, show, list, find or keep an eye on things — "what's on this week", "videos for tonight", "unread mail from the school". Put his request in "intent" IN HIS OWN WORDS, not your paraphrase of it: the words are compiled into a stored query and kept beside it, and they are what gets re-read if the query turns out to have missed his point. A pane is the right answer to "show me…" and the wrong answer to a question with a one-line factual answer — reply with the fact instead.

NEVER SAY YOU WILL DO SOMETHING WITHOUT RETURNING THE ACTION THAT DOES IT. "I'll check", "let me look", "I'll set that up" and "give me a moment" are forbidden unless the matching action is in the same reply — there is no later, and no background you can hand work to. If you cannot act, say plainly what you need from him instead. Do not ask a question you already have the answer to, and do not re-ask something earlier in this conversation; if he has told you what he wants tracked, ACT rather than confirming again.

Your reply must NOT claim an action succeeded. You do not know whether it will — it runs after you speak, and its real outcome is shown to him on its own line directly beneath your words. So say what you are doing, never what you have done: "Pulling your steps and calendar from Google now" — not "I've started tracking your steps". If it fails, he will see that, and a reply that already declared victory is how he stops believing you.

WHAT HE IS TALKING ABOUT. When he says "there", "this", "that", "it", "tomorrow", "that event", "this email" or names a place that is on screen, resolve it against the context below IN THIS ORDER, and stop at the first rung that answers:

  1. an object he named explicitly
  2. the FOCUSED object of a surface
  3. the EXPANDED object
  4. the SELECTED objects
  5. anything else listed under "showing"
  6. what this conversation has already established
  7. what you know about his life
  8. ask him — and only here

NEVER answer a question about a specific object with a general fact about the application. If he asks when to leave for a place that appears in "showing", the answer is about THAT object; "your events tomorrow are all marked all day" is a fact about a list, not an answer about the thing he asked about. If the object is there but the fact you need is missing from it, say exactly that and ask for the missing fact.

DEPARTURE AND ROUTE QUESTIONS ARE NOT YOURS. "When should I leave", "what time should I set off", "how do I get there" are computed by the app itself, with real geocoding and routing, before you are ever called. If one reaches you anyway, do not estimate a travel time, a distance or a departure time — say you could not work it out and what is missing.

YOU CAN OPERATE THE INTERFACE. When surfaces are listed below, you are looking at the same live application he is. Each one tells you its current state, what is on screen, and exactly which operations it accepts. Return them in "ui" and he will watch them happen.

- Prefer operating the interface over describing it. If he asks to see Tuesday, NAVIGATE to Tuesday; do not write a paragraph about Tuesday. If the application can express the answer better than a sentence can, let it.
- Use ONLY operations the surface lists under "can". Anything else is refused and he is told, which makes you look like you did something you did not.
- Name objects with "match" — a few words from what is on screen, or "number three". You may use an "id" only if it appears in "showing". NEVER invent an id.
- Several steps are fine and are applied in order, so "only unread, then open the one from the bank" is two operations.
- "surface" is the key of the surface you mean. Omit it only when exactly one is open.
- Operating the interface is not an external action and needs no permission — it changes what he is looking at, nothing more. Archiving mail, sending mail and RSVPing are NOT ui operations; they stay on their own path where he authorises them.
- Say what you did in one short line. Do not narrate every step.

Return ONLY JSON: {"reply":"what you say to him","action":null or one of the objects above,"ui":[] or [{"surface":"key","op":"...","args":{...}}]}`

/**
 * A surface as the client described it. Opaque here on purpose.
 *
 * This file renders it into the prompt and validates the shape of what comes
 * back; it has no opinion about what a calendar is. The reducer that actually
 * runs these lives in the client, next to the thing being operated, which is
 * what stops the conversation layer from growing a copy of every renderer's
 * semantics.
 */
export interface SurfaceBrief {
  key: string
  title: string
  kind: string
  state: Record<string, unknown>
  can: string[]
  showing: { id: string; label: string; sub?: string; at?: string; unread?: boolean; minutes?: number }[]
  total: number
}

export interface UiCommand {
  surface?: string
  op: string
  args?: Record<string, unknown>
}

export interface SaidResult {
  reply: string
  /** Whether this exchange plausibly changed what the feed should show. */
  learned: boolean
  /** What it actually did, in his words — reported so a promise is visible as kept. */
  did: string | null
  /**
   * Whether `did` is conversation or machinery.
   *
   * Both are reported; they are reported in different PLACES. "Looked that up —
   * the venue hasn't changed" answers him, and belongs in the thread. "Pulled 2
   * new things from Google just now" is the app describing its own plumbing,
   * and belongs in the surface's status line where it can be seen without
   * being read. Chat had filled up with the second kind.
   */
  didKind: 'telemetry' | 'result'
  /** Operations for the client to run against the surfaces he is looking at. */
  ui: UiCommand[]
}

/** What the model is shown about the screen. Trimmed: this goes into a prompt. */
function renderSurfaces(surfaces: SurfaceBrief[]): string {
  if (!surfaces.length) return ''
  return [
    'WHAT IS ON HIS SCREEN. This is the live application, the same one he is looking at.',
    ...surfaces.map((s) => {
      const showing = s.showing
        .map((o, i) => `    ${i + 1}. [${o.id}] ${o.label}${o.sub ? ` — ${o.sub}` : ''}${o.at ? ` (${o.at})` : ''}${o.unread ? ' · unread' : ''}${o.minutes ? ` · ${o.minutes} min` : ''}`)
        .join('\n')
      return [
        `  "${s.key}" — ${s.title} (${s.kind})`,
        `    state: ${JSON.stringify(s.state)}`,
        /*
          A CONTEXT ROW IS NOT AN OPERABLE SURFACE.

          Home publishes what he can see and declares no operations, so it is
          said in those words rather than as `can: ` with nothing after it —
          which reads as a surface whose capabilities were forgotten, and
          invites the model to try one.
        */
        s.can.length
          ? `    can: ${s.can.join(' | ')}`
          : '    read-only context — there are no operations for this one',
        `    showing ${s.showing.length} of ${s.total}:`,
        showing,
      ].join('\n')
    }),
  ].join('\n')
}

/** Keep only what is structurally a command. Validation proper happens client-side. */
function parseUi(raw: unknown): UiCommand[] {
  if (!Array.isArray(raw)) return []
  return raw
    .slice(0, 8)
    .flatMap((x) => {
      const o = (x ?? {}) as Record<string, unknown>
      const op = typeof o.op === 'string' ? o.op.trim() : ''
      if (!op) return []
      return [{
        surface: typeof o.surface === 'string' ? o.surface : undefined,
        op,
        args: o.args && typeof o.args === 'object' ? (o.args as Record<string, unknown>) : {},
      }]
    })
}

export async function say(
  world: World,
  text: string,
  /**
   * The card he is talking inside, if any — 'ask' is the bare composer.
   *
   * `id` matters as much as `title` now. A clarification card's id IS the slot it
   * asked about (`insight.ts` mints them as `ask:<key>`), so a freeform reply to a
   * question card can be written to the right typed field without guessing anything
   * from his words. See `slotForReply`.
   */
  card?: { id?: string; title: string; status: string; asks?: boolean } | null,
  thread: { who: 'me' | 'ai'; text: string }[] = [],
  deps: SayDeps = {},
  surfaces: SurfaceBrief[] = []
): Promise<SaidResult> {
  const history = thread
    .slice(-8)
    .map((m) => `${m.who === 'me' ? 'HIM' : 'YOU'}: ${m.text}`)
    .join('\n')

  const out = await route('chat', {
    system: SYSTEM,
    prompt: [
      renderWorld(world),
      // Always present, never triggered by a keyword. Asking the app about
      // itself is an ordinary question, so it gets ordinary context rather
      // than a special path that only fires on phrases someone predicted.
      await renderSelf().catch(() => ''),
      card
        ? `THE CARD HE HAS OPEN:\n${card.title}\n${card.status}${
            card.asks ? '\n(This card is a question YOU put to him. What he just said is the answer to it — take it as a fact about his life, do not ask it again.)' : ''
          }`
        : '',
      renderSurfaces(surfaces),
      history ? `THE CONVERSATION SO FAR:\n${history}` : '',
      `Right now it is ${new Date().toString().replace(/ \(.*\)$/, '')}.`,
      `HE JUST SAID:\n${text}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    json: true,
    // Operating the interface costs tokens the prose used not to need: a
    // multi-step change plus its explanation does not fit in the old budget.
    maxTokens: surfaces.length ? 900 : 700,
  })

  /*
    THE ONE PLACE THE PROVIDER'S BYTES BECOME WORDS.

    This used to be `parsed?.reply ?? out.text`, and that `??` is what put

        { "reply": "I don't have the address or restaurant name for your ev

    into his chat as an ordinary message: the envelope was truncated
    mid-string, `parseLoose` could not repair it, and the fallback for "the
    contract broke" was to show him the contract. `humanReply` salvages the
    sentence when there is one and refuses in a line when there is not — it
    never returns protocol. See reply.ts.
  */
  const said = humanReply(out.text)
  const parsed: any = said.envelope
  const reply = said.text || 'I didn’t catch that — say it again?'
  const action = parsed?.action ?? null

  /**
   * WHAT HE SAID, WRITTEN AS A FACT FIRST AND A SENTENCE SECOND.
   *
   * This used to be an `addObservations` call and nothing else. The prose is still
   * written — it is genuinely what the synthesis pass reads, and a bare "yes" is only
   * interpretable months later with the question beside it — but it is no longer the
   * ONLY copy. `tell` writes the typed field first when the app can tell which
   * question this answers, from the card's own id rather than from his wording.
   *
   * The concrete difference: answering the "Do you drive?" card with typed "no" now
   * produces `identity.drives = false, by: 'user'` before this function returns, so
   * the very next travel plan reads it. Previously the fact did not exist at all, and
   * the closest thing to it appeared a build later as `by: 'agent'` — overwritable —
   * only because someone had written a regex for that exact sentence.
   */
  const now = new Date()
  await recordSaid({ text, card, at: now })

  // A question back to it is not new evidence; a statement about his life is.
  // Answering a card that ASKED is always evidence, however short: "No" to a
  // question it chose to spend a card on is exactly the fact it was missing.
  let learned =
    card?.asks === true ||
    (!/^\s*(what|when|where|who|why|how|is|are|do|does|can|could|should|would)\b/i.test(text) && text.trim().length > 12)

  const outcome = await perform(action, deps)
  if (outcome) learned = true

  /**
   * NO ACKNOWLEDGMENT WITHOUT COMPLETION — enforced, not requested.
   *
   * The prompt has forbidden "I'll check" without a matching action since this
   * file was written, and the screenshot in the handoff shows exactly that
   * sentence with nothing behind it: "Pulling your latest step data from Google
   * now to check the sync", then silence. A rule a model can violate silently is
   * not a rule, it is a preference.
   *
   * So the claim is checked against what actually ran. A reply that promises
   * work with no action attached has a line appended saying so — which is worse
   * to read than a correct reply and far better than a lie, and it makes the
   * failure visible in testing instead of looking like a slow network.
   */
  const stranded = !action && !outcome && claimsWork(reply)

  return {
    reply: stranded ? `${reply}\n\n(I said that and then did nothing — nothing was actually started. Ask me again and I will run it.)` : reply,
    learned,
    did: outcome?.text ?? null,
    didKind: outcome?.telemetry ? 'telemetry' : 'result',
    ui: parseUi(parsed?.ui),
  }
}

/**
 * Does this reply CLAIM that work is under way?
 *
 * Present tense and future tense both count — "pulling your steps now" and
 * "I'll check that" make the same promise. Deliberately narrow: it must be a
 * first-person claim about the app doing something, so "you'll need to check
 * your phone" and "checking that is worth doing" do not trip it.
 *
 * Exported for `scripts/contract.mjs`, which asserts both directions — that the
 * stranded sentences are caught, and that ordinary answers are not.
 */
export function claimsWork(reply: string): boolean {
  // Typographic apostrophes first: the model writes "I’ll", the pattern is
  // written "i'll", and a curly quote is exactly the kind of near-miss that
  // makes a guard look present and do nothing.
  const t = reply.toLowerCase().replace(/[’‘]/g, "'")
  if (/\b(i (?:have|'ve) (?:pulled|checked|looked|refreshed|synced))\b/.test(t)) return false
  return /\b(i'?ll |i will |let me |give me a moment|one moment|hold on|checking|pulling|fetching|looking (?:this|that|it) up|syncing|refreshing|working on|getting that)\b/.test(t)
}

/** What `say` needs from its host to actually do things rather than describe them. */
export interface SayDeps {
  /** Pull from Google now. Absent when Google is not connected. */
  sync?: () => Promise<{ added: number }>
  /** Look something up on the open web now. */
  research?: (question: string) => Promise<string | null>
  /**
   * Compile his words into a plan and put the resulting pane on his splash.
   *
   * Injected like the others rather than imported, and for a sharper reason
   * here: `ask` reaches the executor, which reaches the network with his
   * credentials. Keeping it a dependency means the conversation layer can be
   * run — and reasoned about — with no way to fetch anything at all, and it is
   * the host that decides whether talking is allowed to build.
   */
  build?: (intent: string) => Promise<{ title: string; count: number; unresolved: string[] }>
}

/**
 * Carry out the one action the reply asked for. Every failure is reported back
 * in his words rather than thrown: an assistant that says "done" when nothing
 * happened is the exact failure this whole mechanism exists to remove.
 */
async function perform(action: any, deps: SayDeps): Promise<Outcome | null> {
  const kind = String(action?.kind ?? '')
  if (!kind) return null

  /**
   * A sync is machinery. It is genuinely worth reporting — a silent fetch that
   * changes what he is looking at is the thing nobody should have to guess at —
   * but "I pulled two things" is not an answer to anything he said, and putting
   * it in the thread pushed the actual exchange off the screen.
   *
   * A FAILED sync is the exception, and it is not a stylistic one: "I couldn't
   * reach Google" changes what he should believe about everything else on
   * screen, so it is said out loud, in the conversation.
   */
  if (kind === 'sync') {
    if (!deps.sync) return result('I can’t reach Google yet — it isn’t connected.')
    try {
      const { added } = await deps.sync()
      return telemetry(added
        ? `Pulled ${added} new thing${added === 1 ? '' : 's'} from Google.`
        : 'Checked Google — nothing new.')
    } catch (e) {
      return result(`Tried to pull from Google and couldn’t: ${(e as Error).message}`)
    }
  }

  if (kind === 'track') {
    const question = String(action?.question ?? '').trim()
    if (!question) return null
    const t = await addTrack({ question, why: String(action?.why ?? '').trim() }, 'agent')
    return t ? result(`Now watching that — I’ll check it on my own from here.`) : null
  }

  if (kind === 'pane') {
    const intent = String(action?.intent ?? '').trim()
    if (!intent) return null
    if (!deps.build) return result('I can’t build panes here yet.')
    try {
      const { title, count, unresolved } = await deps.build(intent)
      // What it could NOT express is reported in the same breath as what it
      // could. A pane that quietly dropped half the instruction looks like a
      // success from here, and he finds out weeks later or never.
      const missed = unresolved.length ? ` I couldn’t do the “${unresolved.join('”, “')}” part.` : ''
      return result(count
        ? `Put “${title}” on your home screen — ${count} thing${count === 1 ? '' : 's'} in it.${missed}`
        : `Put “${title}” on your home screen, though there’s nothing in it right now.${missed}`)
    } catch (e) {
      return result(`Tried to build that and couldn’t: ${(e as Error).message}`)
    }
  }

  if (kind === 'research') {
    const question = String(action?.question ?? '').trim()
    if (!question || !deps.research) return null
    try {
      const found = await deps.research(question)
      // `found` already reads "Looked up \"…\" — …", so do not prefix it again.
      return result(found ?? 'Looked, and couldn’t find a reliable answer.')
    } catch {
      return result('Tried to look that up and the search failed.')
    }
  }
  return null
}

/** What `perform` produced, and where it should be said. */
interface Outcome { text: string; telemetry: boolean }
const result = (text: string): Outcome => ({ text, telemetry: false })
const telemetry = (text: string): Outcome => ({ text, telemetry: true })

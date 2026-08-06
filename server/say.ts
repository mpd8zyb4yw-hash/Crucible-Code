import { route } from './router.js'
import { renderWorld, addObservations, type World } from './world.js'
import { parseLoose } from './think.js'
import { addTrack } from './tracks.js'

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

YOU CAN ACT. You are not only talking — you may take exactly one action per reply by returning it alongside your words:
- {"kind":"sync"} — pull his calendar, mail, activity and steps from Google right now.
- {"kind":"track","question":"...","why":"..."} — start watching something on an ongoing basis, so it is checked without him asking again.
- {"kind":"research","question":"..."} — look something up on the open web right now.

NEVER SAY YOU WILL DO SOMETHING WITHOUT RETURNING THE ACTION THAT DOES IT. "I'll check", "let me look", "I'll set that up" and "give me a moment" are forbidden unless the matching action is in the same reply — there is no later, and no background you can hand work to. If you cannot act, say plainly what you need from him instead. Do not ask a question you already have the answer to, and do not re-ask something earlier in this conversation; if he has told you what he wants tracked, ACT rather than confirming again.

Your reply must NOT claim an action succeeded. You do not know whether it will — it runs after you speak, and its real outcome is shown to him on its own line directly beneath your words. So say what you are doing, never what you have done: "Pulling your steps and calendar from Google now" — not "I've started tracking your steps". If it fails, he will see that, and a reply that already declared victory is how he stops believing you.

Return ONLY JSON: {"reply":"what you say to him","action":null or one of the objects above}`

export interface SaidResult {
  reply: string
  /** Whether this exchange plausibly changed what the feed should show. */
  learned: boolean
  /** What it actually did, in his words — appended so a promise is visible as kept. */
  did: string | null
}

export async function say(
  world: World,
  text: string,
  /** The card he is talking inside, if any — 'ask' is the bare composer. */
  card?: { title: string; status: string; asks?: boolean } | null,
  thread: { who: 'me' | 'ai'; text: string }[] = [],
  deps: SayDeps = {}
): Promise<SaidResult> {
  const history = thread
    .slice(-8)
    .map((m) => `${m.who === 'me' ? 'HIM' : 'YOU'}: ${m.text}`)
    .join('\n')

  const out = await route('chat', {
    system: SYSTEM,
    prompt: [
      renderWorld(world),
      card
        ? `THE CARD HE HAS OPEN:\n${card.title}\n${card.status}${
            card.asks ? '\n(This card is a question YOU put to him. What he just said is the answer to it — take it as a fact about his life, do not ask it again.)' : ''
          }`
        : '',
      history ? `THE CONVERSATION SO FAR:\n${history}` : '',
      `Right now it is ${new Date().toString().replace(/ \(.*\)$/, '')}.`,
      `HE JUST SAID:\n${text}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    json: true,
    maxTokens: 700,
  })

  let parsed: any = null
  try {
    parsed = parseLoose(out.text)
  } catch {
    /* a model that ignored the shape still said something useful */
  }
  const reply = String(parsed?.reply ?? out.text ?? '').trim() || 'I didn’t catch that — say it again?'
  const action = parsed?.action ?? null

  // Everything he types is evidence. Keeping the card title with it means a
  // bare "yes" is still interpretable months later.
  const now = new Date()
  await addObservations([
    {
      id: `said-${now.getTime().toString(36)}`,
      source: 'user',
      at: now.toISOString().slice(0, 10),
      text: card ? `While looking at "${card.title}", he said: ${text}` : `He said: ${text}`,
    },
  ])

  // A question back to it is not new evidence; a statement about his life is.
  // Answering a card that ASKED is always evidence, however short: "No" to a
  // question it chose to spend a card on is exactly the fact it was missing.
  let learned =
    card?.asks === true ||
    (!/^\s*(what|when|where|who|why|how|is|are|do|does|can|could|should|would)\b/i.test(text) && text.trim().length > 12)

  const did = await perform(action, deps)
  if (did) learned = true

  return { reply, learned, did }
}

/** What `say` needs from its host to actually do things rather than describe them. */
export interface SayDeps {
  /** Pull from Google now. Absent when Google is not connected. */
  sync?: () => Promise<{ added: number }>
  /** Look something up on the open web now. */
  research?: (question: string) => Promise<string | null>
}

/**
 * Carry out the one action the reply asked for. Every failure is reported back
 * in his words rather than thrown: an assistant that says "done" when nothing
 * happened is the exact failure this whole mechanism exists to remove.
 */
async function perform(action: any, deps: SayDeps): Promise<string | null> {
  const kind = String(action?.kind ?? '')
  if (!kind) return null

  if (kind === 'sync') {
    if (!deps.sync) return 'I can’t reach Google yet — it isn’t connected.'
    try {
      const { added } = await deps.sync()
      return added ? `Pulled ${added} new thing${added === 1 ? '' : 's'} from Google just now.` : 'Checked Google — nothing new since last time.'
    } catch (e) {
      return `Tried to pull from Google and couldn’t: ${(e as Error).message}`
    }
  }

  if (kind === 'track') {
    const question = String(action?.question ?? '').trim()
    if (!question) return null
    const t = await addTrack({ question, why: String(action?.why ?? '').trim() }, 'agent')
    return t ? `Now watching that — I’ll check it on my own from here.` : null
  }

  if (kind === 'research') {
    const question = String(action?.question ?? '').trim()
    if (!question || !deps.research) return null
    try {
      const found = await deps.research(question)
      // `found` already reads "Looked up \"…\" — …", so do not prefix it again.
      return found ?? 'Looked, and couldn’t find a reliable answer.'
    } catch {
      return 'Tried to look that up and the search failed.'
    }
  }
  return null
}

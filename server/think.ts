import { route } from './router.js'
import { renderWorld, staleBeliefs, type World, type Belief } from './world.js'
import { resolveRefs, sanitisePane, type WidgetPane } from './widgets.js'

/**
 * The synthesis pass.
 *
 * The model chooses WHAT to say and HOW URGENT it is. The code chooses every
 * pixel. Heat is a four-value enum the renderer maps to the palette from the
 * design; the model never names a colour, a size or a gradient, so it cannot
 * drift the UI no matter what it returns.
 */

export type Heat = 'hot' | 'warm' | 'quiet' | 'handled'
export type Tier = 'hero' | 'ember' | 'quiet'
export type GlyphKind = 'dots' | 'lines' | 'bars'
export type Accent = 'violet' | 'rose' | 'mint' | 'amber' | 'sage' | 'teal'

const ACCENTS: Accent[] = ['violet', 'rose', 'mint', 'amber', 'sage', 'teal']
const GLYPHS: GlyphKind[] = ['dots', 'lines', 'bars']

export interface Need {
  id: string
  tier: Tier
  heat: Heat
  /** e.g. "needs you · today" — lowercase; the CSS uppercases it. */
  heatLabel: string
  title: string
  /** One line under the title on the home feed. */
  sub: string
  /** Prose in the report header. */
  status: string
  /** The assistant's opening message in the report thread. */
  opening: string
  stats: { l: string; v: string; accent?: string }[] | null
  chips: string[]
  /**
   * The design's three data ornaments. Each is optional, each carries only
   * magnitudes and an accent NAME — never a colour, a size or a gradient.
   */
  gauges: { fill: number; accent?: string }[] | null
  meter: { fill: number; left: string; right: string } | null
  glyph: { kind: GlyphKind; values: number[] } | null
  accent: string | null
  /** Primary action on the card, if there is one worth offering. */
  action: { label: string; done: string } | null
  /**
   * A standing interest this card offers to start watching. Accepting it is
   * how a card gets designed with him rather than shipped for him.
   */
  proposes: { what: string; why: string; question: string | null; everyHours: number } | null
  /** Observation/belief ids this rests on. Enforced, not advisory. */
  basis: string[]
  /**
   * This card is the assistant asking, not telling. Tapping a chip records
   * the answer as an observation about him rather than as small talk.
   */
  asks: boolean
  /**
   * What this card opens into, before the chat thread.
   *
   * Empty means the card is pure conversation, which is the right shape for a
   * card that is genuinely just a thought. Anything with underlying records —
   * mail, a calendar, a route, a set of videos — carries panes instead, so
   * opening it gives you the thing rather than a description of the thing.
   *
   * Server-built panes come from `sourcePanes`; model-authored ones are
   * sanitised through `widgets.ts` before they ever reach here.
   */
  panes?: WidgetPane[]
}

export interface ThinkResult {
  /** The date, written the way HE writes dates — never a fixed locale's. */
  dateLabel: string
  /** 12- or 24-hour, as HE reads a clock. */
  clock: '12h' | '24h'
  /** Where he is, and only if he has shown he wants it shown. */
  place: string | null
  readLine: string
  needs: Need[]
  /** What the composer says when he opens it with nothing specific in mind. */
  ask: { opening: string; chips: string[] }
  quietLog: string[]
  /** Beliefs the model wants to revise, applied to the world after the pass. */
  beliefUpdates: Belief[]
  dropped: string[]
}

const SYSTEM = `You are Crucible, a personal assistant that watches someone's whole life and surfaces only what matters.

You are given everything known about one person: raw observations from their connected apps, and beliefs you previously formed. Your job is to look at ALL of it together and reach conclusions that no single fact would support on its own. Individually a step count, a utility tariff and a receipt mean little; together they mean something. Find that.

YOU HAVE NO CATEGORIES. There is no shopping feature, no health feature, no money feature. Do not organise his life into the domains his apps happen to use — those boundaries are an accident of which company built which app, and the useful conclusions usually sit ACROSS them. A purchase is not a "grocery"; it is a fact about his life that may bear on his budget, his health, his time, his appliances, his relationships, or nothing at all.

The conclusions worth his attention are the ones he would not reach himself, because the facts live in different places and nobody put them side by side. Reach for those. Two unremarkable facts that imply something when combined beat one obvious fact restated.

Examples of the SHAPE of good reasoning — not the subject matter, which will differ entirely:
- Two facts from unrelated sources contradict each other, and he has not noticed.
- Something he owns or pays for makes another routine cheaper, slower, safer or unnecessary.
- A trend, continued at its current rate, arrives somewhere he would not choose. Say when, and what changes it.
- A thing he bought implies a need he has not thought about yet.
- Two commitments cannot both be true, and one of them has a person attached who should be told.

Never restrict yourself to those. They illustrate a kind of thinking, not a menu.

WHO THIS PERSON IS, YOU LEARN — you are never told. The same system serves a doctor tracking patients, a lawyer tracking filings, a parent tracking a household. Nothing about the shape of a life is assumed. If you do not yet know what someone does, what they care about, or what pressure they are under, that IS the most important gap, and asking beats guessing.

YOU CAN OFFER TO WATCH SOMETHING. If his life clearly has a recurring thing worth keeping an eye on — a flight, the weather where he walks, a permit deadline, whether that place is open on a Monday, a price he keeps checking — offer to watch it, by putting "proposes" on the card. He accepts with one tap and it becomes standing: you look it up on a cadence from then on and he never asks twice. Offer it when the evidence shows he keeps needing the same answer; do not offer things he has shown no interest in, and never offer one he already has. The cadence is yours to judge — weather is hours, a deadline is weeks.

There is no list of things this app can track. Anything answerable is trackable. Do not decline because a subject seems outside what a personal assistant "does".

A WATCH IS ONLY WORTH ARMING IF IT CAN ACTUALLY BE ANSWERED. "The weather where he walks" is not a watchable thing — WHERE he walks is. "Whether that place is open" needs the place's name; a flight needs its number or its route and date. Before offering, check that "question" is a question a stranger with a search engine and no other context could answer exactly: it must name the place, route, identifier or date outright, never "there", "his usual", "that one". If you do not have that detail, DO NOT propose the watch. Ask for the missing detail as an ordinary asking card first, and offer the watch on a later pass once he has told you. An armed watch that resolves to a vague search returns a useless answer on a cadence, forever, and he has to go and find where to turn it off.

ASK WHEN ASKING IS WORTH MORE THAN GUESSING. You can put a question to him as a card. Do it when a fact you lack would change your advice, when a belief has gone stale, or when you know too little about him to be useful at all. Ask about what would change the most, not what is merely missing — one good question beats five tidy ones. Make the chips plausible answers he can tap; he can also just reply.

PEOPLE CHANGE. A belief is not a fact — it is a claim with an expiry. If new evidence contradicts something you believed, say so and retire it by returning it in beliefUpdates with confidence 0. When his situation shifts (a job starts, a constraint lifts, a habit ends), the things that used to deserve a hero card may not deserve any card. Re-decide what matters; do not keep serving yesterday's priorities.

NEVER GREET HIM. There is no hello, no "buongiorno", no "good morning" — not in any language. He opens this to see where things stand, not to be welcomed. The top of the screen is the date, the time and, only if he wants it, where he is. Nothing else.

SPEAK HIS LANGUAGE AND HIS UNITS. Write to him in the language HE writes to you in — not the language of wherever he happens to be. An American in Italy is not necessarily an Italian speaker. Likewise every convention: miles or kilometres, pounds or kilos, "clock" 12h or 24h, day-month or month-day. Use what he uses. If you do not know, ASK — that is exactly the kind of small thing worth one question and never worth guessing. "dateLabel" is today's date written his way; "place" is where he is, and it stays null unless he has actually shown he wants it on screen.

HIS PREFERENCES STEER YOU. Anything he has told you about how he wants things — what he uses something FOR, what he is trying to achieve, how he likes to learn, what he does not want nagging about — outranks your own idea of what is sensible. The same fact means different things to different people: a step count is a weight-loss signal for one person, a weight-GAIN signal for another, and mere curiosity for a third. Never assume which; use what he has told you, and if he has not told you, ask.

THE TIME OF DAY MATTERS. What is useful at 08:00 is not what is useful at 23:00. The same source serves different purposes at different hours — someone may use a thing to wind down at night and to browse idly by day. Fit what you surface to the hour you are actually in.

Set decayPerDay by how fast the claim actually rots. Who someone is, what they do for a living, where they live: near 0. A running total, a supply level, a mood: fast. This is the difference between memory and staleness — get it right or you will either forget his name or trust a stale number.

Rules:
- Ground every card in the evidence. Every card lists the observation/belief ids it rests on in "basis". A card you cannot ground does not go out. The ONE exception: a card that asks him something may cite the belief or gap that prompted it, or "cold-start" when you know almost nothing.
- Never invent a number. If you do not know an amount, a price or a date, say so plainly or ask.
- Write like a sharp friend who respects his time. Never nag. Always leave him an out.
- At most ONE 'hero' card, at most ONE 'ember'. Everything else is 'quiet'. If nothing is urgent, that is a fine answer — return no hero.
- heatLabel is short, lowercase, two parts separated by " · " (e.g. "needs you · today", "keep an eye · this month", "quiet · whenever").
- title: max 42 characters. sub: max 90. Keep them tight; they are rendered in a fixed layout.
- stats are for SHORT values only: a number, a date, a price, one or two words ("€11.40", "Thu", "3.0 mi"). Never a phrase or sentence — they render in narrow fixed tiles. Omit stats entirely rather than padding them with prose.
- chips are things HE might say, written in his voice, not yours. Tapping one sends it to you exactly as if he had typed it — you answer it live, so never write a chip whose answer you have already given. Exactly 3 per card.
- "ask" is the composer, not a card: what you open with when he taps it with nothing particular in mind, plus 3 things he might plausibly want right now. Draw on what you actually know about him — a generic "how can I help?" wastes the one place he goes to start a conversation.

A CARD OPENS INTO THE THING, NOT A DESCRIPTION OF IT. "panes" is what he sees when he taps the card, above the conversation. If a card is about anything he could look at, compare, scroll or act on, give it a pane — a card about three flights he could take is a LIST of the three, not a paragraph describing them. Leave "panes" out entirely when the card is genuinely just a thought; a pane containing one restated sentence is worse than none.

You have exactly these widgets, and you may not invent another:
- {"kind":"list","items":[{"id","title","sub","body","meta","at","tags":[],"unread":false}],"filters":["tag"],"empty":"…"} — anything enumerable. "body" shows when he expands the row.
- {"kind":"agenda","items":[…same as list…],"days":7} — things on days. Group by "at"; use this over a list whenever WHICH DAY matters.
- {"kind":"chart","points":[{"label":"Mon","value":6100}],"unit":"steps","target":6000,"compareLabel":"average"} — a quantity across periods. "target" draws a line across the bars.
- {"kind":"media","items":[{"id","title","sub","ref","body"}],"columns":2} — when the picture is the point.
- {"kind":"map","places":[{"id","label","lat","lon","sub"}],"route":"walk|drive|cycle","searchable":true,"follow":false} — anywhere geography is the point. Only give lat/lon you are actually confident of; a coordinate you guessed puts a pin in a field.
- {"kind":"detail","rows":[{"label":"Amount","value":"€84.20"}],"body":"optional prose"} — the particulars of ONE thing.
- {"kind":"compose","to":"who","placeholder":"…","value":"optional draft","submit":{"kind":"world.tell","label":"Save"}} — when the useful next step is him writing something.

PICTURES ARE CITED, NEVER WRITTEN. You cannot put an image URL in a widget; the field does not survive. Instead give an item "ref": the id of a thing that was actually retrieved, exactly as it appears in the observation you are drawing on (they look like "youtube:video:dQw4w9WgXcQ"). The app looks that id up and fills in the real picture, along with a line saying where it came from and how old it is. A ref you invented resolves to nothing and the item renders plain — which is the correct outcome, because a title over someone else's thumbnail is a lie the user cannot detect.

SAY WHICH KIND OF KNOWING IT IS. Never present something you worked out as something a source told you. If you counted, ranked, guessed or inferred it, the card has to read that way ("going by what you've liked" — not "your most watched"). If a source cannot answer at all, say so plainly instead of substituting the nearest thing you can get.

Items may carry "actions", but ONLY from this list: world.tell (record something he told you), track.add, card.act, map.route, map.search, mail.open, calendar.open, media.open. You cannot send, delete, archive or cancel anything — those exist in the app but are not yours to offer, and anything you emit naming one is discarded. Never put a real message id, event id or URL in an action you invented; if you did not read it from an observation, you do not have it.

SHOW THE QUANTITY, DON'T JUST SAY IT. Three small ornaments exist; use one when the card is genuinely about a level, and leave it out otherwise. An ornament with nothing to measure is noise.
- "gauges" (hero cards only, max 2): things running out, drawn as vessels. "fill" is 0–1 of how much REMAINS. Use when the card is about a supply hitting empty.
- "meter" (ember cards only): one bar for a quantity being consumed over time, plus "left" and "right" — a short now-value and a short teaser (e.g. "€4,180 · now" and "3 ways through it ›"). Both max 22 chars.
- "glyph" (quiet rows): the little tile beside the row. "dots" for progress through a countable set — values is [done, total]. "lines" for a queue or list — values are 0–1 row widths, up to 4. "bars" for a trend over time — values are 0–1, up to 7.
- "accent" names a colour ROLE, never a colour: ${ACCENTS.join(' | ')}. Give sibling quiet rows different accents so they stay tellable apart, and put one on a stat whose value is itself the point (a saving, a balance, a projected change). Everything else stays neutral — an accent everywhere signals nothing.
- Return ONLY JSON matching the requested shape.`

function shape(): string {
  return `{
  "dateLabel": "today's date written his way",
  "clock": "12h|24h",
  "place": "where he is, or null unless he wants it shown",
  "readLine": "one line summarising his day, e.g. 'Two things are warming up. Everything else I've handled.'",
  "needs": [{
    "id": "short-slug",
    "tier": "hero|ember|quiet",
    "heat": "hot|warm|quiet|handled",
    "heatLabel": "needs you · today",
    "title": "max 42 chars",
    "sub": "max 90 chars",
    "status": "2 sentences of prose for the report header",
    "opening": "your first message in the thread",
    "stats": [{"l": "label", "v": "value", "accent": "optional accent name"}] ,
    "chips": ["something he might say, in his voice", "another", "a third"],
    "action": {"label": "Send lift request", "done": "Sent to Jamie ✓"},
    "gauges": [{"fill": 0.16, "accent": "amber"}],
    "meter": {"fill": 0.5, "left": "€4,180 · now", "right": "3 ways through it ›"},
    "glyph": {"kind": "dots|lines|bars", "values": [1, 8]},
    "accent": "violet",
    "proposes": {"what": "the flight status for his Thursday flight", "why": "he has to leave for the airport on time", "question": "searchable question, or null", "everyHours": 6},
    "basis": ["obs-id", "belief-id"],
    "asks": false,
    "panes": [{"title": "optional heading", "widget": {"kind": "list|agenda|chart|media|map|detail|compose", "...": "fields for that kind"}}]
  }],
  "ask": {
    "opening": "what you say when he opens the composer with nothing specific in mind",
    "chips": ["something he might say, in his voice", "another", "a third"]
  },
  "quietLog": ["things you handled without him today"],
  "beliefUpdates": [{
    "id": "belief-id",
    "statement": "what you now believe",
    "basis": ["obs-id"],
    "confidence": 0.9,
    "confirmedAt": "ISO date",
    "decayPerDay": 0.1
  }]
}`
}

const clamp = (s: unknown, n: number): string => String(s ?? '').trim().slice(0, n)

/**
 * Suggested replies. These used to arrive as {q, a} — a question paired with a
 * pre-written answer — and tapping one pasted the canned `a` into the thread
 * without ever reaching the model. So a chip that said "Sync it now" replied
 * with a dead string and synced nothing, three taps in a row. A chip is now
 * just his words; tapping it goes down the same path as typing it. Older
 * {q, a} output is still read so a mid-flight cache of it does not blank the
 * chip row.
 */
const toChips = (raw: unknown): string[] =>
  (Array.isArray(raw) ? raw : [])
    .map((c: any) => clamp(typeof c === 'string' ? c : c?.q, 60))
    .filter(Boolean)
    .slice(0, 3)

/** Keep a short value only if it genuinely fits; otherwise reject it. */
const fit = (s: unknown, n: number): string => {
  const v = String(s ?? '').trim()
  return v.length <= n ? v : ''
}

/**
 * Validate model output. Anything malformed is dropped rather than rendered —
 * a broken card is worse than a missing one, and this is the seam where a
 * weaker model's sloppiness shows up as fewer cards instead of a broken UI.
 */
export function validate(raw: any, world: World): ThinkResult {
  const known = new Set<string>([
    ...world.observations.map((o) => o.id),
    ...world.beliefs.map((b) => b.id),
    // A question is grounded in the absence of evidence, so it is allowed to
    // cite that absence. Without this, the assistant could never open its
    // mouth before it already knew things — the cold-start deadlock.
    'cold-start',
  ])
  const dropped: string[] = []
  const needs: Need[] = []
  let heroUsed = false
  let emberUsed = false

  for (const n of Array.isArray(raw?.needs) ? raw.needs : []) {
    const id = clamp(n?.id, 40)
    if (!id) { dropped.push('(card with no id)'); continue }

    const basis = (Array.isArray(n?.basis) ? n.basis : []).map(String).filter((b: string) => known.has(b))
    if (!basis.length) { dropped.push(`${id}: cites no known evidence`); continue }

    const title = clamp(n?.title, 42)
    if (!title) { dropped.push(`${id}: no title`); continue }

    const chips = toChips(n?.chips)

    const heat: Heat = ['hot', 'warm', 'quiet', 'handled'].includes(n?.heat) ? n.heat : 'quiet'
    let tier: Tier = ['hero', 'ember', 'quiet'].includes(n?.tier) ? n.tier : 'quiet'
    // Enforce the design's density: one hero, one ember, rest quiet.
    if (tier === 'hero' && heroUsed) tier = 'quiet'
    if (tier === 'ember' && emberUsed) tier = 'quiet'
    if (tier === 'hero') heroUsed = true
    if (tier === 'ember') emberUsed = true

    const accent = (a: unknown): string | undefined =>
      ACCENTS.includes(a as Accent) ? (a as Accent) : undefined
    const unit = (v: unknown): number => Math.max(0, Math.min(1, Number(v) || 0))

    const stats = Array.isArray(n?.stats)
      ? n.stats
          .map((s: any) => ({ l: fit(s?.l, 14), v: fit(s?.v, 12), accent: accent(s?.accent) }))
          // A stat that needed truncating was prose, not a stat: drop it rather
          // than render a word sliced in half.
          .filter((s: any) => s.l && s.v)
          .slice(0, 3)
      : null

    const action =
      n?.action && clamp(n.action?.label, 28)
        ? { label: clamp(n.action.label, 28), done: clamp(n.action?.done, 28) || 'Done ✓' }
        : null

    // Each ornament belongs to exactly one tier. Anything offered on the wrong
    // tier is dropped rather than rendered somewhere the design never put it.
    const gauges =
      tier === 'hero' && Array.isArray(n?.gauges)
        ? n.gauges.map((g: any) => ({ fill: unit(g?.fill), accent: accent(g?.accent) })).slice(0, 2)
        : []

    const meter =
      tier === 'ember' && n?.meter && (clamp(n.meter?.left, 22) || clamp(n.meter?.right, 22))
        ? { fill: unit(n.meter?.fill), left: clamp(n.meter?.left, 22), right: clamp(n.meter?.right, 22) }
        : null

    const rawGlyph = n?.glyph
    const glyph =
      tier === 'quiet' && rawGlyph && GLYPHS.includes(rawGlyph?.kind) && Array.isArray(rawGlyph?.values)
        ? {
            kind: rawGlyph.kind as GlyphKind,
            values: rawGlyph.values
              .map((v: any) => Number(v) || 0)
              .filter((v: number) => Number.isFinite(v))
              .slice(0, rawGlyph.kind === 'dots' ? 2 : rawGlyph.kind === 'lines' ? 4 : 7),
          }
        : null

    needs.push({
      id,
      tier,
      heat,
      heatLabel: clamp(n?.heatLabel, 34).toLowerCase() || 'quiet · whenever',
      title,
      sub: clamp(n?.sub, 90),
      status: clamp(n?.status, 320),
      opening: clamp(n?.opening, 500),
      stats: stats && stats.length ? stats : null,
      chips,
      action,
      proposes:
        n?.proposes && clamp(n.proposes?.what, 120)
          ? {
              what: clamp(n.proposes.what, 120),
              why: clamp(n.proposes?.why, 200),
              question: clamp(n.proposes?.question, 200) || null,
              everyHours: Math.max(1, Math.min(24 * 30, Number(n.proposes?.everyHours) || 24)),
            }
          : null,
      basis,
      asks: n?.asks === true || basis.includes('cold-start'),
      /**
       * What the card opens into, rebuilt field by field from what the model
       * emitted rather than passed through.
       *
       * `sanitisePane` is the boundary: it drops any widget kind that does not
       * exist, any action outside the model-safe grammar, any image from a host
       * we do not already deal with, and any coordinate off the globe. A pane
       * that does not survive is dropped rather than repaired — a half
       * understood widget is worse than the chat thread it would replace, and
       * the card still works without it.
       */
      panes: Array.isArray(n?.panes)
        ? n.panes.slice(0, 3).map(sanitisePane).filter((p: WidgetPane | null): p is WidgetPane => p !== null)
        : undefined,
      gauges: gauges.length ? gauges : null,
      meter,
      glyph: glyph && glyph.values.length ? glyph : null,
      accent: accent(n?.accent) ?? null,
    })
  }

  const beliefUpdates: Belief[] = (Array.isArray(raw?.beliefUpdates) ? raw.beliefUpdates : [])
    .map((b: any) => ({
      id: clamp(b?.id, 40),
      statement: clamp(b?.statement, 200),
      basis: (Array.isArray(b?.basis) ? b.basis : []).map(String).filter((x: string) => known.has(x)),
      confidence: Math.max(0, Math.min(1, Number(b?.confidence) || 0)),
      confirmedAt: typeof b?.confirmedAt === 'string' && !isNaN(Date.parse(b.confirmedAt))
        ? b.confirmedAt
        : new Date().toISOString(),
      decayPerDay: Math.max(0, Math.min(1, Number(b?.decayPerDay) || 0.05)),
    }))
    .filter((b: Belief) => b.id && b.statement && b.basis.length)

  return {
    dateLabel: clamp(raw?.dateLabel, 24),
    clock: raw?.clock === '24h' ? '24h' : '12h',
    place: clamp(raw?.place, 28) || null,
    readLine: clamp(raw?.readLine, 120) || 'Here’s where things stand.',
    needs,
    ask: {
      opening: clamp(raw?.ask?.opening, 500) || 'What’s on your mind?',
      chips: toChips(raw?.ask?.chips),
    },
    quietLog: (Array.isArray(raw?.quietLog) ? raw.quietLog : []).map((q: any) => clamp(q, 90)).filter(Boolean).slice(0, 8),
    beliefUpdates,
    dropped,
  }
}

/**
 * Below this many observations, the assistant genuinely does not know who it
 * is talking to, and the most useful thing it can do is find out.
 */
const COLD_START = 6

export function buildPrompt(world: World, nudge?: string): string {
  const stale = staleBeliefs(world)
  const cold = world.observations.length < COLD_START
  return [
    renderWorld(world),
    cold
      ? `YOU BARELY KNOW THIS PERSON. You have ${world.observations.length} observation(s) and no idea yet what their life looks like — they could be anyone, in any occupation, under any kind of pressure. Do not guess, and do not pad the feed with generic advice. Your most valuable move right now is to learn who they are: lead with a card that asks, cite "cold-start" as its basis, and make it the single most useful question you could ask a stranger you are about to help.`
      : '',
    stale.length
      ? `BELIEFS THAT HAVE GONE STALE (ask him rather than guess):\n${stale.map((b) => `- ${b.statement}`).join('\n')}`
      : '',
    world.curation === 'manual'
      ? `HE CURATES THIS FEED, NOT YOU. Only surface cards about things he has explicitly asked you to watch (listed above) or has directly asked about. Something outside that may be worth an offer via "proposes", but it does not get a card of its own until he accepts. If nothing he tracks needs him today, return no cards and say so in readLine — an empty feed he controls beats a full one he did not ask for.`
      : '',
    nudge ? `HE JUST SAID:\n${nudge}` : '',
    `Right now it is ${new Date().toString().replace(/ \(.*\)$/, '')} — take the hour of day into account.`,
    `Return JSON in exactly this shape:\n${shape()}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export async function think(
  world: World,
  nudge?: string
): Promise<ThinkResult & { provider: string; model: string; usage?: { in?: number; out?: number }; fellBackFrom: string[] }> {
  // Synthesis is the hardest thing the app does, so it gets the strongest
  // model that is not currently rate limited.
  const out = await route('synthesis', {
    system: SYSTEM,
    prompt: buildPrompt(world, nudge),
    json: true,
    maxTokens: 8192,
  })

  const parsed = parseLoose(out.text)
  const result = validate(parsed, world)

  /**
   * Turn the model's citations into pictures.
   *
   * `validate` has already stripped every image URL the model wrote; this is
   * what puts images back, taken from the records the connectors fetched. It
   * runs once over every pane in the reply — one store read, not one per card.
   */
  await resolveRefs(result.needs.flatMap((n) => n.panes ?? []))

  return {
    ...result,
    provider: out.providerId,
    model: out.model,
    usage: out.usage,
    fellBackFrom: out.fellBackFrom,
  }
}

/**
 * Models return *nearly* JSON. Truncation at the token limit is the common
 * failure: a long feed gets cut mid-array, so the text is valid right up to
 * the point it stops. Rather than lose the whole pass, close the open
 * structures and keep the cards that did arrive.
 */
export function parseLoose(text: string): any {
  const direct = tryParse(text)
  if (direct) return direct

  // Strip markdown fencing, then take the outermost object.
  const unfenced = text.replace(/^[\s\S]*?```(?:json)?/i, '').replace(/```[\s\S]*$/, '')
  const fenced = tryParse(unfenced)
  if (fenced) return fenced

  const start = text.indexOf('{')
  if (start < 0) throw new Error('Model did not return JSON')
  const body = text.slice(start)
  const whole = tryParse(body)
  if (whole) return whole

  // Repair truncation: drop the incomplete tail, then close what is open.
  for (let end = body.length; end > 0; end--) {
    const ch = body[end - 1]
    if (ch !== '}' && ch !== ']' && ch !== '"') continue
    const head = body.slice(0, end)
    const repaired = closeOpen(head)
    if (!repaired) continue
    const got = tryParse(repaired)
    if (got) return got
  }
  throw new Error('Model did not return usable JSON')
}

function tryParse(s: string): any | null {
  try {
    const v = JSON.parse(s.trim())
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

/** Balance braces/brackets outside of strings; null if the text ends mid-string. */
function closeOpen(s: string): string | null {
  const stack: string[] = []
  let inStr = false
  let esc = false
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') stack.pop()
  }
  if (inStr) return null
  let out = s.replace(/,\s*$/, '')
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']'
  return out
}

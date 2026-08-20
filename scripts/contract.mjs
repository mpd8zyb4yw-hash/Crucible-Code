#!/usr/bin/env node
/**
 * The product contract, asserted.
 *
 * Every standing application surface — Calendar, Mail, YouTube, Fitness, Keep
 * an eye, Places — must keep its OWN renderer in every data state. Emptiness,
 * unparseable payloads and a completely cold world model are states OF that
 * surface; none of them may change which surface it is.
 *
 * This exists because the opposite was true for months and was invisible from
 * the screen. Each domain branch ended in `if (!things.length) return
 * fallbackList(…)`, so a calendar whose events failed to parse silently became
 * a bulleted list of sentences — which looks like a design decision, not a
 * degraded renderer. Nobody could tell from a screenshot, so the bug survived
 * several rounds of "the rich widget still isn't there".
 *
 * A comment asking future edits not to reintroduce that would not have held.
 * This fails the deploy instead.
 *
 * Run: npm test
 */
import { sourcePanes } from '../server/panes.ts'
import { normaliseEvent } from '../server/widgets.ts'
import { humanReply, looksLikeProtocol } from '../server/reply.ts'
import { presentationFor } from '../server/execute.ts'
import { CAPABILITIES as ACTION_VOCABULARY, NOT_OFFERED, installCapabilities } from '../server/capabilities.ts'
import { registeredActions, effectOfKind, perform } from '../server/actions.ts'
import { OPERATIONS, reconcileOperation, TERMINAL } from '../src/surface/types.ts'
import { MUTATES } from '../src/surface/store.ts'
import { classify, resolveVisible, RETENTION, blankDurable, SYSTEM_APPS } from '../src/home/lanes.ts'
import { resolve, systemNeed } from '../src/nav.ts'
import {
  resolveSlots, blockingSlot, suspend, answer, resumeInstruction, suggestionsFor, restates,
  TASK_SLOTS,
} from '../src/task/resolve.ts'
import { classify as classifyIntent, DEPARTURE_PHRASINGS, ROUTE_PHRASINGS } from '../src/task/intent.ts'
import { claimsWork } from '../server/say.ts'

/** Which renderer each application must always resolve to. */
const MUST_RENDER = {
  Calendar: 'calendar',
  Mail: 'mail',
  Activity: 'fitness',
  YouTube: 'video',
  'Keep an eye': 'watch',
  Places: 'map',
}

const world = (observations, tracks = []) => ({
  profile: '', observations, beliefs: [], tracks, sources: {}, curation: 'auto',
})

/**
 * The data states a surface has to survive. "Unstructured" is the important
 * one and the one that actually broke: observations that exist and are about
 * the right thing, but carry no parseable `data` — exactly what a connector
 * that synced before structured payloads existed leaves behind.
 */
const STATES = {
  'no data at all': world([]),
  'unstructured text only': world(
    ['calendar', 'email', 'health', 'youtube'].map((source, i) => ({
      id: `o${i}`, source, at: '2026-08-08', text: 'prose with no structured payload',
    })),
  ),
}

let failures = 0
for (const [stateName, w] of Object.entries(STATES)) {
  const got = Object.fromEntries(
    sourcePanes(w).map((n) => [n.title, (n.panes ?? []).map((p) => p.widget?.kind).join(',')]),
  )
  for (const [app, kind] of Object.entries(MUST_RENDER)) {
    const actual = got[app]
    if (actual === kind) continue
    failures++
    console.error(
      actual === undefined
        ? `FAIL  ${stateName}: ${app} produced no card at all (expected a '${kind}' surface)`
        : `FAIL  ${stateName}: ${app} rendered as '${actual}', expected '${kind}'`,
    )
  }
}

/**
 * CONTRACT 2 — Home may not know about an object its application does not have.
 *
 * The observed failure: the Home card said "lunch with Odelia", Calendar opened
 * on that day and truthfully reported no events. Both read the same rows; only
 * the readers differed. Home's line fell back to the observation's PROSE when
 * no structured event parsed, so it announced an event recovered from a
 * sentence — which is also how one event came to be both "at 11 AM" and "all
 * day". Time re-derived from a display string is not time.
 *
 * The assertion is deliberately behavioural rather than structural: for a
 * source whose canonical object list is EMPTY, the Home line may not name
 * anything. If it does, some second reading has come back.
 */
const PROSE_BAIT = 'Restaurant with Odelia at 11 AM'
const baited = world(
  ['calendar', 'email', 'health', 'youtube'].map((source, i) => ({
    id: `b${i}`, source, at: '2026-08-08', text: `${PROSE_BAIT} — 2026-08-08 (all day)`,
  })),
)

for (const n of sourcePanes(baited)) {
  const objects = (n.panes ?? []).flatMap((p) => {
    const w = p.widget ?? {}
    return w.events ?? w.messages ?? w.videos ?? w.series ?? []
  })
  if (objects.length) continue // has canonical objects; naming one is correct
  if (typeof n.sub === 'string' && n.sub.includes('Odelia')) {
    failures++
    console.error(
      `FAIL  agreement: ${n.title} Home line names "Odelia" but its surface has ` +
      `zero canonical objects — the line was read out of prose, not data.`,
    )
  }
}

/**
 * CONTRACT 3 — no operation survives a restart as a spinner.
 *
 * The observed shape: "Searching for scary stories." with nothing obliged to
 * ever end it. A reload used to bring the same non-terminal status straight
 * back out of localStorage, so the spinner outlived the request that justified
 * it. Terminal states must be preserved exactly — a completed search must not
 * regress to loading, and a failure must stay a failure that can be retried.
 */
const LIVE = ['requested', 'running', 'partial']
const KEPT = ['completed', 'failed', 'cancelled', 'timedOut']
const op = (status, extra = {}) => ({
  id: 'o', surfaceId: 's', kind: 'search', status,
  startedAt: '2026-08-08T00:00:00Z', updatedAt: '2026-08-08T00:00:00Z', ...extra,
})

for (const status of LIVE) {
  const out = reconcileOperation(op(status))
  if (TERMINAL.has(out.status) && out.retryable) continue
  failures++
  console.error(`FAIL  lifecycle: a '${status}' operation survived a restart as '${out.status}' — that is the spinner that never ends.`)
}

for (const status of KEPT) {
  const before = op(status, { resultCount: 3 })
  const out = reconcileOperation(before)
  if (out === before || (out.status === status && out.resultCount === 3)) continue
  failures++
  console.error(`FAIL  lifecycle: a terminal '${status}' operation was rewritten to '${out.status}' on restart.`)
}

/**
 * CONTRACT 4 — the Home lifecycle actually ends things.
 *
 * "Home is curated, not accumulated" is a claim about what LEAVES, and every
 * way it can be broken is silent: a completed task that never goes, a terminal
 * failure that becomes furniture, an insight that is permanent because the model
 * produced it once. None of those look wrong in a screenshot on the day they
 * happen — they look wrong three weeks later, on a screen nobody can face.
 */
const HOUR = 3_600_000
const NOW = Date.parse('2026-08-08T12:00:00Z')
const ago = (ms) => new Date(NOW - ms).toISOString()

const pane = (id, over = {}) => ({
  paneId: id, title: id, panes: [{ title: id, widget: { kind: 'list', items: [{ id: 'x', title: 'x' }] } }],
  revisionId: 'r', intent: id, planClass: 'search', summary: 's', pinned: null,
  canUndo: false, canRedo: false, refresh: 'manual', updatedAt: ago(HOUR), ...over,
})

const barren = (id, over = {}) => pane(id, { panes: [{ title: id, widget: { kind: 'list', items: [] } }], ...over })

const feedOf = (items) => ({ items, needs: [], dateLabel: '', clock: '24h', place: null, readLine: '', ask: { opening: '', chips: [] }, quietLog: [], shelf: { items: [], updatedAt: '' }, at: ago(0) })

const durableWith = (over) => ({ ...blankDurable(), ...over })

/** Every card on Home, across all three bands. The strip is not cards. */
const cards = (l) => [...l.now, ...l.next, ...l.background]

/** A feed `Need`, at the minimum every reader of one actually requires. */
const need = (id, over) => ({
  id, tier: 'quiet', heat: 'quiet', heatLabel: '', title: id, sub: '', status: '', opening: '',
  stats: null, chips: [], gauges: null, meter: null, glyph: null, accent: null, action: null,
  proposes: null, basis: [], asks: false, standing: true, ...over,
})

const lifecycle = [
  {
    what: 'a completed task leaves Home once its window has passed',
    lanes: () => classify(
      feedOf([{ id: 'done', kind: 'pane', pane: pane('done') }]),
      durableWith({ seenAt: { done: ago(RETENTION.completed + HOUR) } }),
      NOW,
    ),
    holds: (l) => cards(l).length === 0,
  },
  {
    what: 'a completed task he has not seen long enough is still there',
    lanes: () => classify(
      feedOf([{ id: 'done', kind: 'pane', pane: pane('done') }]),
      durableWith({ seenAt: { done: ago(60_000) } }),
      NOW,
    ),
    holds: (l) => cards(l).length === 1 && cards(l)[0].task.state === 'completed',
  },
  {
    what: 'a retryable failure stays actionable with no expiry at all',
    lanes: () => classify(
      feedOf([{ id: 'fail', kind: 'pane', pane: barren('fail') }]),
      durableWith({ seenAt: { fail: ago(30 * 24 * HOUR) } }),
      NOW,
    ),
    holds: (l) => cards(l).length === 1 && cards(l)[0].needsUser === true,
  },
  /**
   * THE BAND IS THE PRODUCT CLAIM, not an implementation detail. "Needs you"
   * has to mean it: a task that will not progress without him belongs in `now`,
   * and one that is merely running does not.
   */
  {
    what: 'a task waiting on him is in "now" and nowhere else',
    lanes: () => classify(
      feedOf([{ id: 'fail', kind: 'pane', pane: barren('fail') }]),
      durableWith({}),
      NOW,
    ),
    holds: (l) => l.now.length === 1 && l.next.length === 0 && l.background.length === 0,
  },
  {
    what: 'a completed task is background, not an interruption',
    lanes: () => classify(feedOf([{ id: 'done', kind: 'pane', pane: pane('done') }]), durableWith({}), NOW),
    holds: (l) => l.background.length === 1 && l.now.length === 0,
  },
  /**
   * A computed card's band is the SERVER'S, used verbatim. A client that
   * re-derived it would be a second opinion about the most consequential thing
   * on the screen — see the header of lanes.ts.
   */
  {
    what: "a computed card lands in the band the server gave it",
    lanes: () => classify(
      feedOf([
        { id: 'a', kind: 'synthesis', need: need('lift:dinner', { band: 'now' }) },
        { id: 'b', kind: 'synthesis', need: need('trend:steps', { band: 'background' }) },
      ]),
      durableWith({}),
      NOW,
    ),
    holds: (l) => l.now.length === 1 && l.now[0].id === 'lift:dinner'
      && l.background.length === 1 && l.background[0].id === 'trend:steps',
  },
  {
    what: 'a card with no band is background — model prose may not claim the top of the screen',
    lanes: () => classify(
      feedOf([{ id: 'a', kind: 'synthesis', need: need('prose', {}) }]),
      durableWith({}),
      NOW,
    ),
    holds: (l) => l.background.length === 1 && l.now.length === 0,
  },
  {
    what: 'saving a task result promotes it out of tasks and keeps it forever',
    lanes: () => classify(
      feedOf([{ id: 'done', kind: 'pane', pane: pane('done') }]),
      durableWith({ saved: ['done'] }),
      NOW,
    ),
    holds: (l) => cards(l).length === 1 && cards(l)[0].kind === 'pane',
  },
  {
    what: 'a saved pane never expires, however long ago it was seen',
    lanes: () => classify(
      feedOf([{ id: 'kept', kind: 'pane', pane: pane('kept', { pinned: 'content' }) }]),
      durableWith({ seenAt: { kept: ago(365 * 24 * HOUR) } }),
      NOW,
    ),
    holds: (l) => cards(l).length === 1 && cards(l)[0].kind === 'pane',
  },
  /**
   * THE APPLICATIONS ARE A STRIP, NOT A BAND. The demotion is the change that
   * makes the rest of Home legible, and the two ways to undo it by accident are
   * to let a tile become a card and to let a quiet source become one.
   */
  {
    what: 'a hidden system app leaves the strip but is never deleted',
    lanes: () => classify(feedOf([]), durableWith({ hiddenApps: ['mail'] }), NOW),
    holds: (l) => l.apps.length === 5 && !l.apps.some((a) => a.id === 'mail'),
  },
  {
    what: 'system apps hold his order rather than any ranking',
    lanes: () => classify(feedOf([]), durableWith({ systemOrder: ['watch', 'mail'] }), NOW),
    holds: (l) => l.apps[0].id === 'watch' && l.apps[1].id === 'mail',
  },
  {
    what: 'an application never becomes a card in a band',
    lanes: () => classify(feedOf([]), durableWith({}), NOW),
    holds: (l) => l.apps.length === 6 && cards(l).length === 0,
  },
  {
    what: 'a quiet source stays a tile and does not fill the background band',
    lanes: () => classify(
      feedOf([{ id: 'src-email', kind: 'source', need: need('src-email', { heat: 'quiet' }) }]),
      durableWith({}),
      NOW,
    ),
    holds: (l) => cards(l).length === 0 && l.apps.some((a) => a.id === 'mail' && a.connected),
  },
  {
    what: 'a source with something to say does reach a band',
    lanes: () => classify(
      feedOf([{ id: 'src-email', kind: 'source', need: need('src-email', { heat: 'hot' }) }]),
      durableWith({}),
      NOW,
    ),
    holds: (l) => l.now.length === 1 && l.now[0].kind === 'source' && l.now[0].opens === 'mail',
  },
]

for (const c of lifecycle) {
  let ok = false
  try { ok = c.holds(c.lanes()) } catch (e) { ok = false }
  if (ok) continue
  failures++
  console.error(`FAIL  lifecycle: ${c.what}`)
}

/**
 * CONTRACT 5 — ranking never steals the viewport.
 *
 * The single most damaging thing Home can do is move what he is reading. A
 * re-rank must leave `visibleItemId` alone; the ONE exception is that the object
 * genuinely stopped existing, and then it falls through calmly to the next
 * eligible card rather than to a blank lane.
 */
const ranked = (ids) => ids.map((id) => ({ id }))

const viewport = [
  {
    what: 'a re-rank leaves the visible card exactly where it was',
    got: resolveVisible(ranked(['c', 'a', 'b']), 'b'),
    holds: (r) => r.id === 'b' && r.replaced === false,
  },
  {
    what: 'the visible object disappearing falls through to the top-ranked one',
    got: resolveVisible(ranked(['a', 'b']), 'gone'),
    holds: (r) => r.id === 'a' && r.replaced === true,
  },
  {
    what: 'an emptied lane shows its quiet empty state rather than a dead id',
    got: resolveVisible([], 'gone'),
    holds: (r) => r.id === null,
  },
]

for (const c of viewport) {
  if (c.holds(c.got)) continue
  failures++
  console.error(`FAIL  viewport: ${c.what} (got ${JSON.stringify(c.got)})`)
}

/**
 * CONTRACT 6 — it executes before it asks.
 *
 * "Show me the route to lunch with Odelia" came back as "which restaurant?"
 * while the calendar event naming the address was on screen. The ladder is the
 * fix and these are the four ways it can regress: not looking, guessing between
 * candidates, upgrading an approximate answer to a certain one, and losing the
 * original instruction across a clarification.
 */
const WORLD = {
  objects: [
    { id: 'e1', label: 'Restaurant with Odelia', sub: 'Via Roma 4', kind: 'event' },
    { id: 'p9', label: 'Avano', sub: 'Piazza Avano', kind: 'place' },
  ],
  stated: {},
  location: { lat: 44.49, lon: 11.34, label: 'here' },
}

const ladder = [
  {
    what: 'a destination already on screen is resolved, not asked about',
    run: () => resolveSlots(['destination'], 'show route to lunch with Odelia', WORLD),
    holds: (s) => s.destination.status === 'resolved' && s.destination.value === 'Via Roma 4',
  },
  {
    what: 'origin comes from permitted live location rather than a question',
    run: () => resolveSlots(['origin'], 'show route to Avano', WORLD),
    holds: (s) => s.origin.status === 'resolved' && s.origin.source === 'location',
  },
  {
    what: 'nothing resolvable blocks on exactly one slot',
    run: () => resolveSlots(['destination'], 'route to the place Sandro mentioned', { objects: [], stated: {}, location: null }),
    holds: (s) => blockingSlot(s)?.name === 'destination',
  },
  {
    what: 'two equally good matches are a question, not a coin toss',
    run: () => resolveSlots(['destination'], 'route to Avano', {
      objects: [
        { id: 'a', label: 'Avano', sub: 'north', kind: 'place' },
        { id: 'b', label: 'Avano', sub: 'south', kind: 'place' },
      ],
      stated: {}, location: null,
    }),
    holds: (s) => s.destination.status === 'candidates' && s.destination.options.length === 2,
  },
]

for (const c of ladder) {
  let ok = false
  try { ok = c.holds(c.run()) } catch { ok = false }
  if (ok) continue
  failures++
  console.error(`FAIL  ladder: ${c.what}`)
}

/**
 * CONTRACT 7 — a clarification suspends and RESUMES the same task.
 *
 * Without typed task state a clarification is a fresh conversation about a task
 * that no longer exists, and the original instruction has to be said twice.
 */
const blocked = suspend('route', 'show route to the harbour place', {
  destination: { status: 'unresolved' },
})

if (!blocked || blocked.status !== 'awaitingClarification' || blocked.blocking !== 'destination') {
  failures++
  console.error('FAIL  resume: a task with an unfillable slot did not suspend')
} else {
  const vague = answer(blocked, 'I think it’s around Bellano')
  if (vague.slots.destination.status !== 'approximate') {
    failures++
    console.error('FAIL  resume: "around Bellano" was promoted to a certain destination')
  }
  if (vague.status !== 'ready') {
    failures++
    console.error('FAIL  resume: an approximate answer left the task blocked instead of narrowing')
  }
  const resumed = resumeInstruction(vague)
  if (!resumed.startsWith('show route to the harbour place') || !resumed.includes('approximately')) {
    failures++
    console.error(`FAIL  resume: the original instruction was lost or its hedge dropped ("${resumed}")`)
  }
}

/**
 * CONTRACT 8 — NAVIGATION IS TOTAL.
 *
 * The blank screen. `App` rendered Home for `null`, Settings for `'settings'`,
 * a surface when the feed happened to hold a `Need` with that id, and NOTHING
 * for everything else — so a system app card with no connected source tore Home
 * down and painted a background gradient. It was not a crash, so no boundary
 * caught it; every store assertion passed, because the store was right.
 *
 * The property that makes it unreachable is that `resolve` is TOTAL: no input
 * produces "nothing". Either a screen, or a refusal the caller must handle by
 * keeping the screen it has. So this asserts it over every id Home can emit,
 * against a feed that knows about none of them.
 */
const EMPTY_FEED = { needs: [], panes: [] }
const HOME_IDS = [
  ...SYSTEM_APPS.map((a) => a.id),
  'settings', 'notice-brain', 'pane-route', 'w1', 'insight-42', '', 'nonsense',
]

for (const id of HOME_IDS) {
  const t = resolve(id, EMPTY_FEED.needs, EMPTY_FEED.panes)
  if (!t || !t.kind) {
    failures++
    console.error(`FAIL  navigation: resolving '${id}' produced nothing at all`)
    continue
  }
  // A permanent application must open its OWN renderer even with no data —
  // "not connected" is a state of Calendar, not a reason to have no Calendar.
  if (SYSTEM_APPS.some((a) => a.id === id)) {
    if (t.kind !== 'surface') {
      failures++
      console.error(`FAIL  navigation: system app '${id}' resolved to '${t.kind}' instead of its own surface`)
    } else if (t.renderer === 'none') {
      failures++
      console.error(`FAIL  navigation: system app '${id}' opened a surface with no renderer in it`)
    }
  }
  // Anything else that cannot be built must REFUSE, so the caller keeps the
  // screen he has. Silently resolving to a blank surface is the bug.
  if (t.kind === 'surface' && (!t.need.panes || t.need.panes.length === 0)) {
    failures++
    console.error(`FAIL  navigation: '${id}' opened a workspace with no panes — that is the blank screen`)
  }
}

/** A system app WITH a feed need still uses the feed's, not a synthetic one. */
{
  const real = { ...systemNeed('calendar'), sub: 'from the feed' }
  const t = resolve('calendar', [real], [])
  if (t.kind !== 'surface' || t.source !== 'feed') {
    failures++
    console.error('FAIL  navigation: a connected Calendar was replaced by its empty stand-in')
  }
}

/**
 * CONTRACT 9 — THE PROVIDER'S BYTES NEVER REACH HIM.
 *
 * The screenshot: `{ "reply": "I don't have the address or restaurant name`
 * rendered in chat as an ordinary assistant message. The envelope was truncated
 * mid-string, the repair failed, and the fallback for "the contract broke" was
 * to show him the contract.
 *
 * Every one of these is a real thing a provider has returned. None may produce
 * output containing protocol syntax; the ones carrying a readable sentence must
 * produce that sentence rather than a generic apology.
 */
const REPLIES = [
  { what: 'valid JSON', raw: '{"reply":"Tomorrow at 11.","action":null,"ui":[]}', says: 'Tomorrow at 11.' },
  { what: 'JSON with prose around it', raw: 'Sure!\n{"reply":"Tomorrow at 11.","action":null}', says: 'Tomorrow at 11.' },
  { what: 'a markdown fence', raw: '```json\n{"reply":"Tomorrow at 11.","action":null}\n```', says: 'Tomorrow at 11.' },
  {
    what: 'truncated mid-sentence — the case from the screenshot',
    raw: '{ "reply": "I don\'t have the address or restaurant name for your event with Odel',
    says: "I don't have the address or restaurant name",
  },
  { what: 'truncated between values', raw: '{"reply":"Tomorrow at 11.","action":', says: 'Tomorrow at 11.' },
  { what: 'the wrong key', raw: '{"message":"Tomorrow at 11."}' },
  { what: 'a nested envelope', raw: '{"output":{"reply":"Tomorrow at 11."}}' },
  { what: 'tool-call syntax', raw: '{"type":"tool_use","name":"search","input":{"q":"odelia"}}' },
  { what: 'a bare array', raw: '[{"reply":"Tomorrow at 11."}]' },
  { what: 'plain text when JSON was asked for', raw: 'Tomorrow at 11.', says: 'Tomorrow at 11.' },
  { what: 'nothing at all', raw: '' },
]

for (const c of REPLIES) {
  const got = humanReply(c.raw)
  if (looksLikeProtocol(got.text)) {
    failures++
    console.error(`FAIL  protocol: ${c.what} leaked machine syntax into chat → ${JSON.stringify(got.text.slice(0, 60))}`)
    continue
  }
  // Belt and braces: the shape of the leak, checked directly.
  if (/"reply"\s*:|^[[{]/.test(got.text.trim())) {
    failures++
    console.error(`FAIL  protocol: ${c.what} rendered an envelope → ${JSON.stringify(got.text.slice(0, 60))}`)
    continue
  }
  if (c.says && !got.text.includes(c.says)) {
    failures++
    console.error(`FAIL  protocol: ${c.what} lost the answer it was carrying (got ${JSON.stringify(got.text.slice(0, 60))})`)
  }
}

/**
 * CONTRACT 10 — a blocked task's suggestions unblock it.
 *
 * Under "I don't have the address or restaurant name" the chips were "Show
 * route" and "What time should I leave?" — the action that had just failed for
 * want of the address, and one that cannot be answered until it succeeds. A
 * dead chip is worse than no chip: it costs a tap to discover.
 */
{
  const stuck = suspend('route', 'Show route', { destination: { status: 'unresolved' } })
  const chips = suggestionsFor(stuck, WORLD).filter((c) => !restates(c, stuck.instruction))

  if (chips.some((c) => restates(c, stuck.instruction))) {
    failures++
    console.error('FAIL  suggestions: the action that just failed was offered again')
  }
  if (!chips.length) {
    failures++
    console.error('FAIL  suggestions: a blocked task offered nothing that could unblock it')
  }
  if (!restates('Show route', 'Show route to lunch with Odelia')) {
    failures++
    console.error('FAIL  suggestions: a restatement of the failed action was not recognised as one')
  }

  // A candidate list is the shortest path through a clarification and must win.
  const ambiguous = suspend('route', 'route to Avano', {
    destination: { status: 'candidates', options: [{ value: 'north', why: 'Avano north' }, { value: 'south', why: 'Avano south' }] },
  })
  const picks = suggestionsFor(ambiguous, WORLD)
  if (!picks.includes('Avano north') || !picks.includes('Avano south')) {
    failures++
    console.error('FAIL  suggestions: the candidates were not offered as the answer to their own question')
  }
}

/**
 * CONTRACT 11 — "Show route" reaches the ladder from the card he is looking at.
 *
 * Two stop words is the whole instruction, so no rung above the anchor can see
 * anything: the app asked "where are you going?" directly beneath the address.
 */
{
  const anchored = resolveSlots(['destination'], 'Show route', { ...WORLD, focus: 'e1' })
  if (anchored.destination.status !== 'resolved' || anchored.destination.value !== 'Via Roma 4') {
    failures++
    console.error(`FAIL  anchor: "Show route" on the Odelia card did not resolve to its address (got ${JSON.stringify(anchored.destination)})`)
  }
  // And an explicit destination still outranks whatever is on screen.
  const explicit = resolveSlots(['destination'], 'route to Avano', { ...WORLD, focus: 'e1' })
  if (explicit.destination.value !== 'Piazza Avano') {
    failures++
    console.error('FAIL  anchor: the open card overrode a destination he named outright')
  }
  // With nothing on screen and nothing named, it must still SUSPEND rather than
  // dead-end — that is what makes his next message an answer.
  const stuck = suspend('route', 'Show route', resolveSlots(['destination'], 'Show route', { objects: [], stated: {}, location: null }))
  if (!stuck || stuck.status !== 'awaitingClarification') {
    failures++
    console.error('FAIL  anchor: an unresolvable route dead-ended instead of asking one question')
  }
}

/**
 * CONTRACT 12 — an event is timed or all-day, never both.
 *
 * "Time: 11:00 AM" and "All-day event marker set for 11 AM" in one card. The
 * shape of `start` is the authority; a flag beside it is one boolean that can
 * be wrong.
 */
const TEMPORAL = [
  {
    what: 'a timed event stays timed',
    e: { start: '2026-08-08T11:00:00Z', end: '2026-08-08T13:00:00Z' },
    holds: (o) => o.allDay === false && o.end === '2026-08-08T13:00:00Z',
  },
  {
    what: 'a date-only start is all-day whatever the flag claimed',
    e: { start: '2026-08-08', allDay: false },
    holds: (o) => o.allDay === true,
  },
  {
    what: 'an all-day flag over a real timestamp does not invent a clock time',
    e: { start: '2026-08-08T11:00:00Z', allDay: true },
    holds: (o) => o.allDay === false && o.start === '2026-08-08T11:00:00Z',
  },
  {
    what: 'a multi-day all-day event keeps both dates and no clock',
    e: { start: '2026-08-08', end: '2026-08-10', allDay: true },
    holds: (o) => o.allDay === true && o.end === '2026-08-10',
  },
  {
    what: 'an end before its start is dropped rather than rendered backwards',
    e: { start: '2026-08-08T11:00:00Z', end: '2026-08-08T09:00:00Z' },
    holds: (o) => o.end === undefined,
  },
  {
    what: 'a missing end is left missing',
    e: { start: '2026-08-08T11:00:00Z' },
    holds: (o) => o.end === undefined && o.allDay === false,
  },
  {
    what: 'a timezone-offset start is an instant, not a date',
    e: { start: '2026-08-08T11:00:00+02:00' },
    holds: (o) => o.allDay === false,
  },
]

for (const c of TEMPORAL) {
  let ok = false
  let got
  try { got = normaliseEvent(c.e); ok = c.holds(got) } catch { ok = false }
  if (ok) continue
  failures++
  console.error(`FAIL  temporal: ${c.what} (got ${JSON.stringify(got)})`)
}

/**
 * CONTRACT 13 — a route opens a map, not a generic list.
 *
 * "Show route to Avano" opened a full-height list card containing the sentence
 * "No route found". The list was not wrong about the data; it was wrong about
 * what had been asked for. An unresolved route is a state a map can show.
 */
const PRESENTATION = [
  { what: 'a route request', intent: 'show route to Avano', objects: [], want: 'map' },
  { what: 'a route that resolved nothing', intent: 'drive to Avano', objects: [], want: 'map' },
  { what: 'places, whatever was asked', intent: 'where is Avano', objects: [{ kind: 'place' }], want: 'map' },
  { what: 'videos', intent: 'something for tonight', objects: [{ kind: 'video' }], want: 'media' },
  { what: 'an ordinary search', intent: 'cheap flights to Palermo', objects: [{ kind: 'flight' }], want: 'list' },
  {
    what: 'an explicit non-list choice by the compiler',
    intent: 'show route to Avano', objects: [], present: { widget: 'detail' }, want: 'detail',
  },
]

for (const c of PRESENTATION) {
  const got = presentationFor(c.intent, c.objects, c.present)
  if (got === c.want) continue
  failures++
  console.error(`FAIL  presentation: ${c.what} presented as '${got}', expected '${c.want}'`)
}

/**
 * CONTRACT 14 — EVERY CONTROL'S COMMAND IS ONE A SURFACE WILL ACTUALLY ACCEPT.
 *
 * `apply` refuses any op the surface's kind has not declared, which is right:
 * it is what stops the model inventing verbs. But it made the capability table
 * and the reducer two lists that had to agree by memory, and they did not.
 * `clear` was implemented in the reducer, declared for no kind at all, and
 * dispatched by three real controls — the ✕ on Calendar's opened event, the ✕
 * on a focused place, and "back to mine". All three did nothing when tapped,
 * silently, because a refusal only writes a note that no surface renders.
 *
 * From the screen this is indistinguishable from a broken button. So it is
 * asserted instead, in both directions:
 *
 *   · every op the reducer implements is declared by at least one kind —
 *     otherwise it is dead code that a control can still reach;
 *   · every op the SOURCE dispatches is declared for the kind of the surface
 *     it is dispatched on — otherwise it is a dead control.
 *
 * The second one reads the renderers themselves rather than a list kept by
 * hand, because a list kept by hand is the thing that just failed.
 */
{
  const { readFileSync, readdirSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

  const { CAPABILITIES } = await import('../src/surface/types.ts')
  const declared = new Set(Object.values(CAPABILITIES).flat().map((c) => c.op))

  const reducerSrc = readFileSync(join(SRC, 'surface', 'reducer.ts'), 'utf8')
  const implemented = [...reducerSrc.matchAll(/^\s{4}case '([a-zA-Z]+)'/gm)].map((m) => m[1])
  for (const op of new Set(implemented)) {
    if (declared.has(op)) continue
    failures++
    console.error(`FAIL  capability: the reducer implements '${op}' but no surface kind declares it — every control that sends it is dead`)
  }

  /** Which surface kind each renderer drives, read off its own `useSurface` call. */
  const surfaceDir = join(SRC, 'surfaces')
  let controls = 0
  for (const file of readdirSync(surfaceDir).filter((f) => f.endsWith('.tsx'))) {
    const src = readFileSync(join(surfaceDir, file), 'utf8')
    const kind = /useSurface(?:State)?\(\s*surfaceKey,\s*'([a-z]+)'/.exec(src)?.[1]
    if (!kind) continue
    const allowed = new Set((CAPABILITIES[kind] ?? []).map((c) => c.op))
    for (const m of src.matchAll(/\{\s*op:\s*'([a-zA-Z]+)'/g)) {
      controls++
      if (allowed.has(m[1])) continue
      failures++
      console.error(`FAIL  capability: ${file} dispatches '${m[1]}' on a '${kind}' surface, which does not declare it — that control does nothing`)
    }
  }
  globalThis.__capabilityChecks = { implemented: new Set(implemented).size, controls }
}

/**
 * CONTRACT 15 — a departure question reaches the departure task.
 *
 * The acceptance criterion the handoff states is SEMANTIC: every ordinary way of
 * asking must route the same way. That cannot be asserted by reading the
 * classifier, so the phrasings are data next to it and every one is run.
 *
 * The screenshot this exists for: "What time should I leave for Avano?" matched
 * nothing, went to the chat model, and came back with "your events tomorrow are
 * all marked as all day" — a true fact about a list, offered as an answer about
 * a place.
 */
{
  for (const said of DEPARTURE_PHRASINGS) {
    const i = classifyIntent(said)
    if (i.kind !== 'leaveBy') {
      failures++
      console.error(`FAIL  intent: "${said}" routed to ${i.kind ?? 'the chat model'} rather than the departure task`)
    }
  }
  for (const said of ROUTE_PHRASINGS) {
    const i = classifyIntent(said)
    if (i.kind !== 'route') {
      failures++
      console.error(`FAIL  intent: "${said}" should be a route, not ${i.kind ?? 'chat'}`)
    }
  }
  // A remark that happens to contain the verb is not a request.
  for (const said of ['I left my keys at the restaurant', 'leave it with me', 'she is leaving on Tuesday']) {
    if (classifyIntent(said).kind) {
      failures++
      console.error(`FAIL  intent: "${said}" was read as a task`)
    }
  }
}

/**
 * CONTRACT 16 — the departure task refuses rather than substitutes.
 *
 * §7: every required input is named before the computation runs, and a missing
 * one BLOCKS. The four substitutions that were available and must now be
 * impossible are midnight for a start, home for an origin, walking for an
 * unknown mode, and zero for a buffer.
 */
{
  const AVANO = {
    objects: [
      // Exactly the shape of the screenshot: the event names the place and is
      // marked all day, so it can answer `destination` and cannot answer `when`.
      { id: 'e7', label: 'Polenta in Avano with Raffaella', sub: 'Avano', at: '2026-08-15', allDay: true, kind: 'event', rank: 'visible' },
    ],
    stated: { transportMode: 'drive', origin: 'Bologna' },
    location: null,
    focus: null,
  }

  const slots = resolveSlots(TASK_SLOTS.leaveBy, 'what time should I leave for Avano?', AVANO)
  if (slots.destination.status !== 'resolved' || slots.destination.value !== 'Avano') {
    failures++
    console.error('FAIL  leaveBy: the visible event did not answer the destination')
  }
  if (slots.eventStart.status !== 'unresolved') {
    failures++
    console.error(`FAIL  leaveBy: an all-day event supplied a start time (${JSON.stringify(slots.eventStart)}) — that is the midnight substitution`)
  }
  if (slots.transportMode.status !== 'resolved' || slots.origin.status !== 'resolved') {
    failures++
    console.error('FAIL  leaveBy: stated facts were not read, so it would ask for something it already knows')
  }

  const asked = suspend('leaveBy', 'what time should I leave for Avano?', slots)
  if (!asked || asked.blocking !== 'eventStart') {
    failures++
    console.error('FAIL  leaveBy: it did not block on the one missing input')
  } else {
    if (!/Avano/.test(asked.question) || !/all day/i.test(asked.question)) {
      failures++
      console.error(`FAIL  leaveBy: the question did not name what it found — "${asked.question}"`)
    }
    // His answer becomes a timestamp ON THE EVENT'S DAY, not on today.
    const resumed = answer({ ...asked, dayHint: '2026-08-15' }, '7pm')
    const start = resumed.slots.eventStart
    if (resumed.status !== 'ready' || start.status !== 'resolved' || !start.value.startsWith('2026-08-15')) {
      failures++
      console.error(`FAIL  leaveBy: "7pm" did not become a time on the event's own day (${JSON.stringify(start)})`)
    }
  }

  // Nothing on screen, nothing stated: it must still block on ONE thing.
  const cold = resolveSlots(TASK_SLOTS.leaveBy, 'when should I leave?', { objects: [], stated: {}, location: null })
  const stuck = suspend('leaveBy', 'when should I leave?', cold)
  if (!stuck || stuck.blocking !== 'destination') {
    failures++
    console.error('FAIL  leaveBy: with nothing known it did not ask the first question first')
  }

  // A focused event with a real time answers everything the screen can answer.
  const READY = {
    objects: [
      { id: 'e8', label: 'Lunch with Raffaella', sub: 'Avano', at: '2026-08-15T12:00:00.000Z', allDay: false, kind: 'event', rank: 'focused' },
      { id: 'e9', label: 'Dentist', sub: 'Bologna', at: '2026-08-15T16:00:00.000Z', allDay: false, kind: 'event', rank: 'visible' },
    ],
    stated: { transportMode: 'drive', origin: 'Bologna' },
    location: null,
    focus: null,
  }
  const ready = resolveSlots(TASK_SLOTS.leaveBy, 'when should I leave?', READY)
  if (suspend('leaveBy', 'when should I leave?', ready)) {
    failures++
    console.error('FAIL  leaveBy: it asked a question about the event he was already looking at')
  }
  if (ready.eventStart.value !== '2026-08-15T12:00:00.000Z') {
    failures++
    console.error('FAIL  leaveBy: the FOCUSED event lost to one that was merely visible')
  }
}

/**
 * CONTRACT 17 — a claim that work is under way is checked against what ran.
 *
 * Screenshot 3: "Pulling your latest step data from Google now to check the
 * sync", and then nothing at all. The prompt has always forbidden it; this is
 * the part that notices.
 */
{
  const PROMISES = [
    'Pulling your latest step data from Google now to check the sync.',
    'I’ll check that and get back to you.',
    'Let me look that up.',
    'One moment — checking your calendar.',
  ]
  const ANSWERS = [
    'You did 2,310 steps yesterday and nothing has arrived for today.',
    'Google Fit last reported on Friday.',
    'You’ll need to check that on your phone.',
  ]
  for (const p of PROMISES) {
    if (!claimsWork(p)) {
      failures++
      console.error(`FAIL  completion: "${p}" was not recognised as a promise of work`)
    }
  }
  for (const a of ANSWERS) {
    if (claimsWork(a)) {
      failures++
      console.error(`FAIL  completion: "${a}" was wrongly read as a promise of work`)
    }
  }
}

/**
 * CONTRACT 18 — EVERY CARD'S COPY FITS THE CARD IT IS AIMED AT.
 *
 * The UI cannot permanently clean up unconstrained prose. `homeCopy.ts` applies
 * the budget at `needFrom`, which is the seam every Home card passes through;
 * this asserts that the budget is actually being applied, on the copy the real
 * builders produce rather than on a fixture written to fit.
 *
 * The inputs are deliberately over budget — a 190-character baseline and five
 * choices, which is exactly what `fitness.objective` shipped and exactly what
 * grew the scrollbar. What is asserted is not that the strings are short but
 * that NOTHING WAS LOST: everything trimmed off the card has to be present in
 * `status`, which is what "Why am I being asked?" and the focused detail show.
 */
{
  const { budgetForHome, overBudget, MAX_CHOICES } = await import('../server/homeCopy.ts')

  const LONG_FACT =
    'You have averaged about 2,761 steps a day over the last 7 days. I do not know whether that is you ' +
    'walking more, getting fitter, or simply keeping an eye on your normal level — and until I do I will ' +
    'not call the number good or bad.'
  const FIVE = ['Walk more', 'Cardio fitness', 'Keep it steady', 'Training for something', 'Just watching']
    .map((label) => ({ verb: 'set-preference', label, key: 'fitness.objective', value: label }))

  const out = budgetForHome({
    title: 'What do you want from activity tracking?',
    sub: LONG_FACT,
    status: 'I am asking because activity reporting needed this and I do not have it.',
    corrections: FIVE,
  })

  for (const problem of overBudget({ ...out })) {
    failures++
    console.error(`FAIL  copy budget: ${problem}`)
  }
  if (out.corrections.length !== MAX_CHOICES) {
    failures++
    console.error(`FAIL  copy budget: ${out.corrections.length} choices survived, expected ${MAX_CHOICES}`)
  }
  // Nothing discarded: the dropped clause and the dropped choice are both in
  // the deeper text. A budget that deletes is a budget that lies.
  if (!out.status.includes('walking more, getting fitter')) {
    failures++
    console.error('FAIL  copy budget: the trimmed reasoning was DELETED rather than moved deeper')
  }
  if (!out.status.includes('Just watching')) {
    failures++
    console.error('FAIL  copy budget: the fifth choice vanished instead of being offered deeper')
  }
  // The question is critical content and is never touched, at any length.
  const longQ = 'Who is Maria Annunziata Bevilacqua-Sforza to you, and should I treat her as family?'
  if (budgetForHome({ title: longQ, sub: '', status: '', corrections: [] }).title !== longQ) {
    failures++
    console.error('FAIL  copy budget: an over-budget QUESTION was truncated — questions are never cut')
  }

  /*
    ── THE EYEBROW AND THE SUB DO NOT BOTH SAY THE WHEN ──  (audit #12)

    Asserted AT THE GENERATION BOUNDARY and nowhere else, which is the whole
    point of the fix. The card shipped as

        TOMORROW · 11:00
        Restaurant with Odelia
        Tomorrow at 11:00 AM. You asked when to leave earlier today.

    and the tempting repair — have the card compare its own two strings — is the
    prose re-derivation this codebase refuses everywhere. It also does not work:
    those two are not the same string. What the generator is given instead is the
    INSTANT, and it decides from that.

    The three cases below are the three that matter: the restatement goes, what
    it was attached to stays, and a sentence that merely BEGINS with the same day
    word is not touched. The last one is the regression that a looser rule would
    cause, and it would be invisible — a true sentence quietly deleted.
  */
  const NOW_AT = new Date('2026-08-07T09:00:00Z')
  const TOMORROW_11 = new Date('2026-08-08T09:00:00Z').toISOString()
  const eyebrow = { at: TOMORROW_11, now: NOW_AT, timeZone: 'Europe/Rome' }

  const restated = budgetForHome({
    title: 'Restaurant with Odelia',
    sub: 'Tomorrow at 11:00 AM. You asked when to leave earlier today.',
    status: '', corrections: [], eyebrow,
  })
  if (restated.sub !== 'You asked when to leave earlier today.') {
    failures++
    console.error(`FAIL  eyebrow: the sub still restates the eyebrow — ${JSON.stringify(restated.sub)}`)
  }
  if (!restated.status.includes('Tomorrow at 11:00')) {
    failures++
    console.error('FAIL  eyebrow: the restated clause was DELETED rather than moved deeper')
  }

  const meaningful = budgetForHome({
    title: 'Restaurant with Odelia',
    sub: 'Tomorrow it will be closed. Ring them first.',
    status: '', corrections: [], eyebrow,
  })
  if (meaningful.sub !== 'Tomorrow it will be closed. Ring them first.') {
    failures++
    console.error(`FAIL  eyebrow: a sentence that only MENTIONS the day was cut — ${JSON.stringify(meaningful.sub)}`)
  }

  /*
    AND THE EYEBROW ITSELF CANNOT BE THE SUB.

    The other half of #12, and the one that was live in production rather than in
    the fixture: `relevanceFrom` used to fall back to `because.sentence`, and the
    travel-plan builder sets `detail` FROM `because.sentence` — so the eyebrow was
    a 47-character prefix of the sentence printed under it. Asserted on the
    projection, because the defect was in which field it reached for.
  */
  const { buildDeck } = await import('../server/deck.ts')
  const same = 'Via Roma 4 is 12 min by car from home; you drive, so leaving around then gets you there on time.'
  let card = null
  card = buildDeck(
    [],
    [need('plan:e1', {
      heat: 'warm', heatLabel: 'upcoming', title: 'Restaurant with Odelia',
      sub: same, status: same, because: { sentence: same, grounds: [] },
    })],
    [], { systemOrder: [], hiddenApps: [] }, new Date(NOW_AT), 'Europe/Rome',
  ).relevance
  if (!card) {
    failures++
    console.error('FAIL  eyebrow: the relevance card was not projected — the assertion below is vacuous')
  } else if (same.startsWith(card.eyebrow.replace(/…$/, '')) || card.eyebrow === card.sub) {
    failures++
    console.error(`FAIL  eyebrow: it is the sub again — ${JSON.stringify(card.eyebrow)}`)
  }

  /*
    ── EVERY OPERATION IS CLASSIFIED, AND ONLY A MAKER IS UNDOABLE ──

    `undo` appeared beside "Opened Re: Odelia — Saturday." because `mode` and
    `focus` were missing from a hand-maintained view-only list. The list is
    derived now, so the way to break it again is to name an operation in
    `MUTATES` that does not exist — which would silently put a real op back in
    the history under a typo.
  */
  for (const op of MUTATES) {
    if (OPERATIONS.includes(op)) continue
    failures++
    console.error(`FAIL  undo: MUTATES names '${op}', which no surface declares`)
  }
  if (!OPERATIONS.length) {
    failures++
    console.error('FAIL  undo: no operations were found — the classification above is vacuous')
  }

  /*
    ── A SURFACE HEADER DOES NOT COUNT WHAT THE SURFACE LISTS ──  (audit #4)

    "4 this week." sat above six visible message rows: two windows, both true,
    adjacent, reading as a contradiction. `Report`'s header already states the
    rule it was breaking — "what survives is what is not recoverable from the
    surface itself" — and a count of the things listed underneath is the most
    recoverable fact on the screen.

    `panes.ts#row` gives every source need `status: ''`, so production has never
    produced one. This asserts that, over the real projection, so a builder or a
    fixture cannot put one back.
  */
  let headersChecked = 0
  for (const w of Object.values(STATES)) {
    for (const n of sourcePanes(w, new Date(NOW_AT))) {
      headersChecked++
      if (!n.status) continue
      failures++
      console.error(`FAIL  header: source ${n.id} carries a subtitle — ${JSON.stringify(n.status)}`)
    }
  }
  // An absence assertion over an empty list proves nothing. See ux-audit.md.
  if (headersChecked < 6) {
    failures++
    console.error(`FAIL  header: only ${headersChecked} source panes were checked — the assertion is vacuous`)
  }
}


/* ─────────────────────────────────────────────────────────────────────────────
   THE TWO ACTION REGISTRIES AGREE.

   They did not. `mail.draft` and `activity.goal` were registered, implemented
   and working, and were missing from the vocabulary the model is handed — so
   asked to write to someone, the best verb the assistant could reach for was
   `mail.send`. A working feature nothing could ask for, and nothing compared
   the two lists, so nothing noticed.
   ───────────────────────────────────────────────────────────────────────────── */
{
  // This file counts failures inline rather than through a helper; these are
  // local to the section so the style of the rest is left alone.
  const check = (what, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) return
    failures++
    console.error(`FAIL  actions: ${what} — got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)
  }
  const ok = (what, cond, detail = '') => {
    if (cond) return
    failures++
    console.error(`FAIL  actions: ${what}${detail ? ` — ${detail}` : ''}`)
  }

  // The handlers only exist once a host installs them. The stubs are never
  // called — this section asks what is REGISTERED, not what it does.
  installCapabilities({
    google: async () => { throw new Error('no provider in the contract test') },
    searchKeys: async () => ({}),
  })

  const registered = new Set(registeredActions())
  const advertised = new Set(ACTION_VOCABULARY)

  const unimplemented = [...advertised].filter((k) => !registered.has(k)).sort()
  check('every advertised capability has a handler', unimplemented, [])

  const unadvertised = [...registered].filter((k) => !advertised.has(k) && !(k in NOT_OFFERED)).sort()
  check('every registered action is advertised, or says why it is not', unadvertised, [])

  // The escape hatch must stay honest: an entry naming a kind nobody registers
  // is a stale excuse, and reads as a deliberate omission that is not one.
  const staleExcuses = Object.keys(NOT_OFFERED).filter((k) => !registered.has(k)).sort()
  check('nothing is excused from a vocabulary it was never in', staleExcuses, [])

  /* ── AUTHORITY IS ENFORCED, NOT DESCRIBED ──────────────────────────────────
     `perform` used to check `handler.irreversible` and nothing else, so every
     action that was not literally `mail.send` — creating a calendar event,
     changing one, RSVPing to someone else's — could be performed by the app on
     its own initiative, unconfirmed. The policy was in a comment. */
  const unclassified = [...registered].filter((k) => !effectOfKind(k)).sort()
  check('every registered action declares what it does to the world', unclassified, [])

  ok('an event on a shared calendar is not private work',
     effectOfKind('calendar.create') === 'external_reversible')
  ok('a draft is', effectOfKind('mail.draft') === 'private_reversible')
  ok('sending is final', effectOfKind('mail.send') === 'irreversible')

  // THE REFUSALS, PERFORMED. Assertions about the table would pass with the
  // enforcement deleted; these go through `perform` itself.
  const system = { by: 'system', why: 'contract test' }
  const bare = { by: 'user' }

  const a = await perform('calendar.create', { summary: 'x', start: '2026-08-20T10:00:00Z' }, system)
  check('the app may not put an event on a shared calendar by itself', a.outcome, 'refused')

  const b = await perform('mail.send', { messageId: 'm', text: 'hi' }, bare)
  check('and may not send unconfirmed, even for him', b.outcome, 'refused')

  // …while the work it IS allowed to do on his behalf is not blocked. This one
  // reaches its handler and fails there, on a provider the test does not have —
  // which is the proof that authorisation let it through.
  const c = await perform('mail.draft', { to: 'a@b.test', subject: 's', text: 't' }, system)
  ok('but it may prepare a draft on its own', c.outcome === 'failed' && !/on my own|confirm/i.test(c.error ?? ''))

  /* ── A MISSING START TIME IS NOT "NOW" ────────────────────────────────────
     `calendar.create` defaulted `start` to `new Date().toISOString()`, so a
     caller with no time produced a real event beginning whenever the request
     happened to arrive. That is how a Home control with nothing filled in wrote
     a meaningless event into his calendar. */
  const noTime = await perform('calendar.create', { summary: 'Dinner' }, { by: 'user', confirmed: true })
  check('an event with no start time is refused', noTime.outcome, 'failed')
  ok('and says which field is missing', /when it starts/i.test(noTime.error ?? ''), noTime.error)

  const noName = await perform('calendar.create', { start: '2026-08-20T10:00:00Z' }, { by: 'user', confirmed: true })
  ok('an event with no name is refused too', /called/i.test(noName.error ?? ''), noName.error)

  const badTime = await perform('calendar.create', { summary: 'x', start: 'tomorrow-ish' }, { by: 'user', confirmed: true })
  ok('and an unreadable time is not guessed at', /could not read/i.test(badTime.error ?? ''), badTime.error)
}

if (failures) {
  console.error(
    `\n${failures} contract violation(s): a surface changed type with its data, ` +
    `Home disagreed with its application, or an operation could not terminate.`,
  )
  process.exit(1)
}
console.log(
  `contract ok — ${Object.keys(MUST_RENDER).length} surfaces held across ${Object.keys(STATES).length} data states; ` +
  `Home agreed with every application; ${LIVE.length + KEPT.length} operation states survived a restart correctly; ` +
  `${lifecycle.length} lifecycle rules ended what they had to end; ${viewport.length} viewport rules held; ` +
  `${ladder.length} resolution rungs ran before asking, and a clarification resumed its own task; ` +
  `${HOME_IDS.length} Home ids all resolved to a mountable screen; ${REPLIES.length} provider responses ` +
  `reached chat with no protocol in them; ${TEMPORAL.length} temporal states stayed unambiguous; ` +
  `${PRESENTATION.length} requests opened the surface their semantics call for; ` +
  `${globalThis.__capabilityChecks.implemented} reducer operations are all declared and ` +
  `${globalThis.__capabilityChecks.controls} surface controls all dispatch something their surface accepts; ` +
  `Home-bound copy was held to its card budget with nothing discarded; and no card said the same thing twice — ` +
  `the eyebrow and the sub carry different facts, no surface header counts what its surface lists; ` +
  `and every registered action is advertised, declares its effect, and is refused when the authority is wrong`,
)

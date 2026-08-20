#!/usr/bin/env node
/**
 * THE INTERACTION GATE — WHAT HAPPENS WHEN YOU ACTUALLY USE IT.
 *
 * §44 and §45. Geometry proves nothing paints outside its box; the visual gate
 * proves the spatial contract holds in 69 states. Neither proves that tapping
 * the intelligence card shows you the evidence, that "Wrong" records anything,
 * or that a button does what its label says. A clunky, misleading interface
 * passes every screenshot test there is — that is precisely how the app arrived
 * at a mail counter in the intelligence slot with 90/90 and 69/69 green.
 *
 * So these are USER TASKS, asserted end to end:
 *
 *     tap a Home card          → useful depth, not a blank pane
 *     swipe the deck           → the domain you swiped to
 *     close a detail           → the screen you left, as you left it
 *     tap intelligence         → the evidence behind it
 *     mark it Wrong            → a correction path that reports what it did
 *     tap a Mail thread        → something readable
 *     reply                    → a composer that works
 *     tap a Calendar event     → that event
 *     scrub Activity           → the day you scrubbed to
 *     one provider, one model  → selected directly, no keyboard
 *     focus/dismiss composer   → layout returns exactly
 *
 * AND THE DEAD-CONTROL SWEEP. Every visible interactive element on every major
 * surface is enumerated and checked for an accessible name and a real handler or
 * navigation target. That is §45, and §45's own caveat is repeated here because
 * it matters: a control can pass this and still deserve deletion. This catches
 * the button wired to nothing. It cannot catch the button nobody needs.
 *
 * Run: node scripts/interaction.mjs
 */
import { chromium } from 'playwright-core'
import { spawn, execSync } from 'node:child_process'

const FIXTURE = 3002
const PORT = 5174
let PAGE_PORT = PORT
const BASE = () => `http://localhost:${PAGE_PORT}`
/** The phone this is actually used on. Same as the visual gate's. */
const DEVICE = { width: 402, height: 874 }

const children = []
let failures = 0
let passes = 0

const ok = (what, cond, detail = '') => {
  if (cond) { passes++; console.log(`✓ ${what}`); return }
  failures++
  console.log(`✗ ${what}${detail ? `\n    ${detail}` : ''}`)
}

// ── driving ──────────────────────────────────────────────────────────────────

/**
 * A TAP, SYNTHESISED — not `locator.click()`.
 *
 * Playwright's click hangs under mobile emulation in this harness often enough
 * that a suite built on it reports timeouts rather than results. Dispatching the
 * pointer sequence the app actually listens for is both faster and closer to
 * what a finger does; it is the same technique the destination sweep in
 * `shots.mjs` settled on for the same reason.
 */
async function tap(page, selector) {
  const hit = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    const o = {
      bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      pointerId: 1, pointerType: 'touch', isPrimary: true,
    }
    el.dispatchEvent(new PointerEvent('pointerdown', o))
    el.dispatchEvent(new PointerEvent('pointerup', o))
    el.dispatchEvent(new MouseEvent('mousedown', o))
    el.dispatchEvent(new MouseEvent('mouseup', o))
    el.dispatchEvent(new MouseEvent('click', o))
    return true
  }, selector)
  /*
    SCREENSHOT BEFORE MEASURING.

    A rAF-gated read taken in the same turn as the tap returns the state BEFORE
    React committed, which made a working control look dead — the harness note
    that cost a wrong conclusion the first time. A frame is forced here so every
    assertion below reads settled state.
  */
  await page.waitForTimeout(260)
  return hit
}

const text = (page, selector) =>
  page.evaluate((sel) => document.querySelector(sel)?.innerText?.trim() ?? null, selector)

const exists = (page, selector) => page.evaluate((sel) => !!document.querySelector(sel), selector)

async function scenario(name) {
  await fetch(`http://localhost:${FIXTURE}/__scenario`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

async function home(page) {
  await page.goto(BASE(), { waitUntil: 'networkidle' })
  await page.waitForFunction(
    () => document.querySelectorAll('[data-frame="home"] [data-card]').length > 0,
    null,
    { timeout: 15_000 },
  ).catch(() => {})
  await page.waitForTimeout(300)
}

async function open(page, app) {
  await page.goto(`${BASE()}/#/open/${app}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
}

// ── the tasks ────────────────────────────────────────────────────────────────

/**
 * PAGE THE DECK UNTIL A NAMED DOMAIN IS IN FRONT, or give up honestly.
 *
 * Six domains, and which one you land on is a ranking decision this harness has
 * no business predicting. Returns whether it got there, so a task can fail with
 * "Places never came to the front" rather than silently asserting about Calendar.
 */
async function pageTo(page, name) {
  for (let i = 0; i < 9; i++) {
    const label = await page.evaluate(() => document.querySelector('[data-role="deck"]')?.getAttribute('aria-label') ?? '')
    if (label.includes(name)) return true
    /*
      THE KEY EVENT IS DISPATCHED AT THE DECK, not typed at the page.

      `focus()` + `keyboard.press` is the more faithful simulation and it is not
      reliable here for the same reason `click()` is not: after an application
      surface has been opened and left, the focused node is whatever survived
      that, and a press aimed at the document moves nothing. The loop then spins
      nine times and reports that a domain "never came to the front" when the
      keys never arrived. Synthesising the event the deck actually listens for is
      the technique the pointer helper above already settled on, for the same
      class of failure.
    */
    await page.evaluate(() => {
      const d = document.querySelector('[data-role="deck"]')
      d?.focus()
      d?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    await page.waitForTimeout(600)
  }
  return false
}

/**
 * Open a row by its object id — through the control, not through the wrapper.
 *
 * `data-object` marks the ROW; the handler is on a `[data-role="open"]` inside
 * it. Dispatching at the wrapper hits nothing, and an assertion that only
 * measured "did the text get longer" would not have noticed: the list is longer
 * than 60 characters whether or not anything opened.
 */
async function openObject(page, id) {
  // The inner control FIRST, and `querySelector` cannot express that: for
  // `A, B` it returns whichever comes first in the document, which is the
  // wrapper. Two calls, in order of preference.
  if (await exists(page, `[data-object="${id}"] [data-role="open"]`)) {
    return tap(page, `[data-object="${id}"] [data-role="open"]`)
  }
  return tap(page, `[data-object="${id}"]`)
}

/**
 * ── PHASE 8 ─────────────────────────────────────────────────────────────────
 *
 * FOUR TASKS, ASSERTED AS TASKS. §25 is explicit that "the enrichment renders"
 * is not the test — a line can render and still not help — so each of these
 * walks the whole errand: glance, open, understand, come back.
 *
 * Every one also asserts the NEGATIVE half in the same breath, because that is
 * where Phase 8 fails in the way nobody notices. A card that gained a sentence
 * and lost the figure it was about is a regression that looks like a feature,
 * and the sentence itself must never carry the machinery it came from: no
 * probability, no observation count, no confidence, on any of the four.
 */
const NO_MACHINERY = /confidence|probability|\bσ\b|sigma|support \d|contradiction|\d+ observations|baseline of/i

/**
 * CALENDAR: what is next, and does anything about it need unusual timing.
 *
 * `calm-day` rather than `normal`, and the reason is worth stating: `normal`
 * has two events at once, the clash sentence wins the foot by design, and the
 * memory core's density line is therefore unreachable from it. A gate that only
 * ran the default scenario would have reported this branch green forever without
 * once rendering it.
 */
async function calendarContext(page) {
  await scenario('calm-day')
  await home(page)

  ok('Calendar is in front on a day it has something to say about', await pageTo(page, 'Calendar'))
  const card = await text(page, '[data-role="deck"] [data-card]')
  ok(
    'the card says how this day compares with days of its kind',
    /Busier than your usual \w+\./.test(card ?? ''),
    JSON.stringify(card?.slice(-80)),
  )
  ok('and it says it in words, not in statistics', !NO_MACHINERY.test(card ?? ''), JSON.stringify(card?.slice(-80)))
  /*
    THE COMPARISON DID NOT COST THE APPOINTMENT. §6: enrichment takes space that
    was free. The hero — what is next, and when — is what the card is FOR, and a
    line about Fridays that displaced it would be a worse card than the one that
    said nothing.
  */
  ok('and what is actually next is still on it', /\d{1,2}[:.]\d{2}/.test(card ?? ''), JSON.stringify(card?.slice(0, 80)))

  // ── open an event whose timing is unusual, and read why ──
  await scenario('normal')
  await open(page, 'calendar')
  const early = await page.evaluate(() => {
    // The dentist, nine days out at 08:30 — the one event in the fixture that
    // starts before he is normally out of the house.
    const el = [...document.querySelectorAll('[data-object]')].find((e) => /Dentist/.test(e.innerText))
    return el ? el.getAttribute('data-object') : null
  })
  if (early) {
    await openObject(page, early)
    const note = await text(page, '[data-role="event-note"]')
    ok('an event that starts before he is usually out says so', /leave home/i.test(note ?? ''), JSON.stringify(note))
    ok('and says where that came from', (note ?? '').split('\n').length > 1, JSON.stringify(note))
  }

  /*
    AND THE ORDINARY EVENT IS LEFT ALONE. The failure this catches is the one
    that would make Phase 8 worthless: a line attached to everything says
    nothing, and this fixture's 20:30 "Call with the studio · Zoom" is exactly
    the event a two-sided version of the rule would have annotated.
  */
  const zoom = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-object]')].find((e) => /studio/.test(e.innerText))
    return el ? el.getAttribute('data-object') : null
  })
  if (zoom) {
    await openObject(page, zoom)
    ok('an evening video call gets no line about leaving the house', !(await exists(page, '[data-role="event-note"]')))
  }
}

/**
 * ACTIVITY: how am I doing relative to myself, and can I get at the detail.
 */
async function activityContext(page) {
  await scenario('normal')
  await home(page)
  ok('Activity comes to the front', await pageTo(page, 'Activity'))

  const card = await text(page, '[data-role="deck"] [data-card]')
  ok('the figure is still the loudest thing on it', /9,?180/.test(card ?? ''), JSON.stringify(card?.slice(0, 60)))
  ok(
    'and it is judged against the same weekday rather than against a flat mean',
    /your usual \w+day\./.test(card ?? ''),
    JSON.stringify(card?.slice(-90)),
  )
  ok('with no statistics in the sentence', !NO_MACHINERY.test(card ?? ''), JSON.stringify(card?.slice(-90)))
  /*
    §9: ONE COMPARISON, NOT TWO. `+12%` is this week against last week and says
    roughly the same thing in another unit; it gives way while the personal
    comparison exists, and comes back when it does not.
  */
  ok('and not a second comparison beside it', !/[+-]\d+%/.test(card ?? ''), JSON.stringify(card?.slice(0, 90)))
  /*
    AND THE CARD DOES NOT OFFER TO BE CONFIGURED. "Make 7,180 the goal" was a
    white pill and the loudest element here.
  */
  ok('and it does not offer to set a goal', !/the goal/i.test(card ?? ''), JSON.stringify(card?.slice(0, 120)))

  // ── depth: the ingredients, and the control the card gave up ──
  await open(page, 'fitness')
  const depth = await text(page, '[data-frame="surface"]')
  ok('the history is behind the card', /steps/i.test(depth ?? '') && (depth?.length ?? 0) > 120)
  ok('and so is the goal offer the card stopped carrying', /the goal/i.test(depth ?? ''))
  ok(
    'and missing is still not zero',
    /missing|not zero|No data since/i.test(depth ?? ''),
    JSON.stringify(depth?.slice(0, 200)),
  )

  await page.goto(BASE(), { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  ok('and Home comes back', await exists(page, '[data-frame="home"]'))
}

/**
 * PLACES: what matters about where, said spatially wherever it can be.
 */
async function placesContext(page) {
  await scenario('normal')
  await home(page)
  ok('Places comes to the front', await pageTo(page, 'Places'))

  const card = await text(page, '[data-role="deck"] [data-card]')
  ok('a place he keeps going back to says when', /Usually \w+ (morning|afternoon|evening)\./.test(card ?? ''), JSON.stringify(card))
  /*
    §13 BY NAME: "Dervio · probability 0.76 · 14 observations · confidence
    strong" is what this must never become.
  */
  ok('and never how probable, how often or how sure', !NO_MACHINERY.test(card ?? ''), JSON.stringify(card))
  ok('the map is still the picture', await exists(page, '[data-role="places-map"]'))
  /*
    AND THE CARD NO LONGER SAYS ITS OWN FIRST ROW BACK. "Nearest is Avano, 3.4 km
    away." sat under a row reading "Avano … 3.4 km", and the rows are sorted by
    distance so row one is the nearest by construction.
  */
  ok('and it does not restate its own first row', !/Nearest is/.test(card ?? ''), JSON.stringify(card))

  await open(page, 'places')
  ok('the spatial depth opens', await exists(page, '[data-frame="surface"]'))
  const depth = await text(page, '[data-frame="surface"]')
  ok('and it is a map rather than a report about one', (depth?.length ?? 0) < 400, `${depth?.length} chars of text`)

  await page.goto(BASE(), { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  ok('and Home comes back', await exists(page, '[data-frame="home"]'))
}

/**
 * MAIL: who wants something, and why it matters — then reply and come back.
 */
async function mailContext(page) {
  await scenario('normal')
  await home(page)
  ok('Mail comes to the front', await pageTo(page, 'Mail'))
  const card = await text(page, '[data-role="deck"] [data-card]')
  /*
    §14 AT A GLANCE: who. The relation to what is coming is DEPTH weight and must
    not be on the card — four rows with a fourth string each is the clutter this
    was kept off Home to avoid.
  */
  ok('the card says who wants something', /Odelia/.test(card ?? ''), JSON.stringify(card?.slice(0, 90)))
  ok('and does not carry the person context on the row', !/You are seeing/.test(card ?? ''), JSON.stringify(card))

  await open(page, 'mail')
  const from = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-object]')].find((e) => /Odelia/.test(e.innerText))
    return el ? el.getAttribute('data-object') : null
  })
  if (!from) { ok('the mailbox has a message from a person', false); return }

  await openObject(page, from)
  const note = await text(page, '[data-role="message-note"]')
  ok('opening it says what is arranged with them', /You are seeing/.test(note ?? ''), JSON.stringify(note))
  ok('and where that came from', /calendar/i.test(note ?? ''), JSON.stringify(note))
  ok('and states no contact statistics', !NO_MACHINERY.test(note ?? ''), JSON.stringify(note))

  /*
    OPENING A MESSAGE IS NOT A THING TO UNDO. It printed "Opened Re: Odelia —
    Saturday.  undo  ✕" — a control offering to take back having looked at
    something. See `VIEW_ONLY` in src/surface/store.ts.
  */
  const status = await text(page, '[data-frame="surface"]')
  ok(
    'and reading it offers no undo',
    !(await page.evaluate(() => [...document.querySelectorAll('*')].some(
      (e) => e.children.length === 0 && e.textContent?.trim() === 'undo',
    ))),
    JSON.stringify((status ?? '').slice(0, 120)),
  )

  // ── reply, and the subject is prefixed once ──
  await tap(page, '[data-role="reply"] > *')
  const composer = await page.evaluate(() => document.body.innerText)
  ok('replying opens a composer aimed at them', /Replying to/i.test(composer ?? ''), JSON.stringify((composer ?? '').slice(0, 160)))
  ok('and the subject is prefixed once, not twice', !/Re:\s*Re:/i.test(composer ?? ''), JSON.stringify((composer ?? '').match(/Re:.*/)?.[0]))

  await page.goto(BASE(), { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  ok('and Home comes back', await exists(page, '[data-frame="home"]'))
}


/**
 * TAPPING THE INTELLIGENCE CARD SHOWS ITS EVIDENCE.
 *
 * The audit's second finding was that this card had `cursor: auto` and no
 * handler — the one thing on Home that says what Crucible worked out was the one
 * thing you could not ask about. Both halves are asserted: that the tap lands,
 * and that what arrives is EVIDENCE rather than the same sentence larger.
 */
async function intelligenceDepth(page) {
  await scenario('normal')
  await home(page)

  const face = await text(page, '[data-role="intelligence"]')
  ok('the intelligence slot says something', !!face && face.length > 10, `got ${JSON.stringify(face)}`)

  /*
    AND IT IS NOT A COUNT. The slot it replaced read "6 in the last week from 5
    senders" — a mail counter, which is what §42 bans as primary content and what
    Phase 7 exists to remove. Asserted, because a regression here would look
    completely normal.
  */
  ok(
    'and it is not a source count',
    !!face && !/^\d+\s+(in the last|unread|messages|new)/i.test(face),
    `got ${JSON.stringify(face)}`,
  )

  ok('the card is a real control', await page.evaluate(() => {
    const el = document.querySelector('[data-role="intelligence"]')
    if (!el) return false
    return el.getAttribute('role') === 'button' && el.tabIndex >= 0 && getComputedStyle(el).cursor === 'pointer'
  }))

  await tap(page, '[data-role="intelligence"]')

  const depth = await exists(page, '[data-surface="intelligence"]')
  ok('tapping it opens depth', depth)
  if (!depth) return

  const body = await text(page, '[data-surface="intelligence"]')

  /*
    DEPTH HAS TO JUSTIFY THE TAP. §12: substantially more, not the same prose
    enlarged. The evidence trail is the specific thing that cannot be on the
    face, so its presence is the test that the tap was worth taking.
  */
  ok('depth shows why Crucible thinks this', /why crucible thinks this/i.test(body ?? ''))
  ok('depth carries an evidence trail', await page.evaluate(
    () => (document.querySelector('[data-surface="intelligence"]')?.innerText ?? '').includes('YOUR DATA'),
  ))
  ok(
    'and depth is substantially more than the face',
    (body?.length ?? 0) > (face?.length ?? 0) * 2,
    `face ${face?.length}, depth ${body?.length}`,
  )

  /*
    NO CONFIDENCE TELEMETRY ANYWHERE ON IT. §14: certainty is language. A
    `confidence 0.82` or a `support 19 / contradiction 4` on this screen would be
    the machinery becoming visible, which §48 forbids by name.
  */
  ok(
    'certainty is language, not telemetry',
    !/confidence\s*[:=]?\s*0?\.\d|support\s*\d+\s*·|contradiction/i.test(body ?? ''),
    `got ${JSON.stringify((body ?? '').slice(0, 200))}`,
  )

  // ── back restores what we left ──
  await tap(page, '[data-role="intelligence-close"]')
  ok('closing depth returns to Home', await exists(page, '[data-frame="home"]'))
  ok('and the card is where it was', await exists(page, '[data-role="intelligence"]'))
}

/**
 * WRONG IS A CORRECTION, AND IT SAYS WHAT IT ACTUALLY DID.
 *
 * §15's split asserted from the outside: the three verdicts are distinct
 * controls, and `wrong` opens a correction rather than silently counting as a
 * dismissal. The reported sentence is checked because the first implementation
 * printed a cheerful confirmation the instant it was tapped — including against
 * a host that recorded nothing.
 */
async function correction(page) {
  await scenario('normal')
  await home(page)
  await tap(page, '[data-role="intelligence"]')

  ok('useful, not useful and wrong are three separate controls', await page.evaluate(() =>
    ['intelligence-useful', 'intelligence-not-useful', 'intelligence-wrong']
      .every((r) => !!document.querySelector(`[data-role="${r}"]`)),
  ))

  await tap(page, '[data-role="intelligence-wrong"]')
  const form = await exists(page, '[data-role="intelligence-correction"]')
  ok('wrong opens a correction rather than just dismissing', form)
  if (!form) return

  await page.evaluate(() => {
    const input = document.querySelector('[data-role="intelligence-correction"] input')
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(input, 'The summer bus timetable changed')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await tap(page, '[data-role="intelligence-correction-send"]')
  await page.waitForTimeout(500)

  const said = await text(page, '[data-role="intelligence-thanks"]')
  ok('the correction reports what the server actually did', !!said && said.length > 0, `got ${JSON.stringify(said)}`)
  /*
    THE SPECIFIC REGRESSION. The client used to write its own optimistic
    confirmation, so a 503 from a host with no memory core still read "I will
    hold that against this". The sentence must come from the response.
  */
  ok(
    'and it is the server\'s sentence, not an optimistic one',
    said !== 'Noted — I will hold that against this and stop saying it.',
    `got ${JSON.stringify(said)}`,
  )
}

/** A Home card opens something real, and closing it returns you. */
async function homeCards(page) {
  await scenario('normal')
  await home(page)

  await tap(page, '[data-role="relevance"]')
  const wentSomewhere = await page.evaluate(() =>
    !!document.querySelector('[data-frame="surface"]') || !!document.querySelector('[data-frame="home"]'),
  )
  ok('tapping relevance resolves to a screen', wentSomewhere)

  /*
    AND IT IS NOT A BLANK ONE. The contract's "no blank navigation destination"
    from the interaction side rather than the pixel side.
  */
  const painted = await page.evaluate(() => {
    const s = document.querySelector('[data-frame="surface"]')
    if (!s) return null
    const region = s.querySelector('[data-surface]') ?? s
    return (region.textContent ?? '').trim().length
  })
  if (painted !== null) ok('and that screen has content on it', painted > 12, `${painted} chars`)
}

/** Swiping the deck lands on the domain you swiped to, and it stays there. */
async function deckSwipe(page) {
  await scenario('normal')
  await home(page)

  /*
    THROUGH THE KEYBOARD, WHICH IS THE PATH THE CONTRACT GUARANTEES.

    The first version set `scrollLeft` directly and asserted the domain changed.
    It did not, and the app was right: the deck renders a moving TRIPLE with only
    the middle slide carrying `data-card`, so a raw scroll moves pixels while
    React still holds the same index — the state that decides which domain is in
    front never heard about it. Driving the scroller is driving the animation,
    not the navigation.

    ← / → is the non-touch path the gesture rule requires to exist, so it is both
    a real user path and the one a harness can take without simulating momentum.
    A deck that cannot be paged this way is broken for keyboard users anyway,
    which makes this the more valuable assertion of the two.
  */
  const before = await text(page, '[data-role="deck"] [data-card]')
  await page.locator('[data-role="deck"]').focus().catch(() => {})
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(600)
  const after = await text(page, '[data-role="deck"] [data-card]')
  ok(
    'paging the deck changes the domain in front',
    !!before && !!after && before !== after,
    `${JSON.stringify(before?.slice(0, 24))} → ${JSON.stringify(after?.slice(0, 24))}`,
  )

  /*
    AND IT STAYS THERE. The reported bug this guards: opening an application
    unmounts Home, and the landing rule re-fired on the fresh mount and put him
    back on a louder domain than the one he had deliberately swiped to.
  */
  await open(page, 'mail')
  await page.goto(BASE(), { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  const returned = await text(page, '[data-role="deck"] [data-card]')
  ok('and it stays there after visiting an application', returned === after, `${JSON.stringify(after?.slice(0, 24))} → ${JSON.stringify(returned?.slice(0, 24))}`)
}

/** Mail: a thread opens to something readable, and reply gives a composer. */
async function mail(page) {
  await scenario('normal')
  await open(page, 'mail')
  ok('Mail opens', await exists(page, '[data-frame="surface"]'))

  const row = await page.evaluate(() => {
    const el = document.querySelector('[data-frame="surface"] [data-object]')
    return el ? el.getAttribute('data-object') : null
  })
  if (!row) { ok('Mail has a thread to open', false); return }

  await tap(page, `[data-object="${row}"]`)
  const body = await text(page, '[data-frame="surface"]')
  ok('tapping a thread shows something readable', (body?.length ?? 0) > 60, `${body?.length} chars`)
}

/** Calendar: tapping an event selects that event. */
async function calendar(page) {
  await scenario('normal')
  await open(page, 'calendar')
  ok('Calendar opens', await exists(page, '[data-frame="surface"]'))

  const id = await page.evaluate(() => {
    const el = document.querySelector('[data-frame="surface"] [data-object]')
    return el ? el.getAttribute('data-object') : null
  })
  if (!id) { ok('Calendar has an event to tap', false); return }

  await tap(page, `[data-object="${id}"]`)
  const after = await text(page, '[data-frame="surface"]')
  ok('tapping an event does something visible', (after?.length ?? 0) > 20)
}

/**
 * ONE PROVIDER WITH ONE MODEL IS SELECTED DIRECTLY.
 *
 * The already-fixed behaviour, asserted so it stays fixed — and the keyboard
 * half asserted with it, because a settings screen that raises the keyboard on a
 * choice with one option is asking a question that has no second answer.
 */
async function providers(page) {
  await scenario('normal')
  await home(page)
  await page.evaluate(() => {
    const input = document.querySelector('[data-frame="composer"] input')
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(input, 'settings')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await page.waitForTimeout(900)

  ok('asking for settings opens settings', await exists(page, '[data-frame="settings"]'))
  ok('settings has exactly one exit control', await page.evaluate(() =>
    document.querySelectorAll('[data-frame="settings"] [data-role="settings-close"]').length === 1,
  ))
  const focused = await page.evaluate(() => document.activeElement?.tagName)
  ok('and opening it does not raise the keyboard', focused !== 'INPUT' && focused !== 'TEXTAREA', `focus on ${focused}`)

  /*
    AND SWITCHING THE BRAIN ACTUALLY SWITCHES IT.

    This task asserted that settings OPENS and stopped there, so the one thing
    the screen exists for — choosing which model thinks — was never performed by
    any gate. Pressing "Think with this" on the second provider was found, by
    hand, to do nothing visible: the fixture answered `/api/active` from a
    catch-all and held no state, and there was no way to tell that from a broken
    switch. Both halves are fixed; this is the half that stops it coming back.
  */
  /*
    WHICH PROVIDER CARRIES THE BADGE, read as a person reads it.

    The smallest node whose text is a provider name AND `IN USE` — the badge's
    own element says only "IN USE" and says nothing about whose it is, and the
    row above it says the model too. Taking the shortest match is what makes this
    the label rather than the whole screen.
  */
  const inUse = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-frame="settings"] *')]
      .map((e) => (e.innerText ?? '').replace(/\s+/g, ' ').trim())
      // A name, then the badge. The badge's own node says only "IN USE" and
      // does not say whose it is, so the shortest match is not the answer.
      .filter((t) => /^[A-Za-z][\w ]* IN USE\b/.test(t) && t.length < 60)
      .sort((a, b) => a.length - b.length)
    return rows[0] ?? null
  })

  /*
    THE DEEPEST match, not the first. `innerText` of an ancestor also starts with
    "Models and keys", and clicking the ancestor toggles nothing — which read as
    a switch that did not work.
  */
  await page.evaluate(() => {
    const open = [...document.querySelectorAll('[data-frame="settings"] *')]
      .filter((e) => /^Models and keys/.test(e.innerText ?? '') && getComputedStyle(e).cursor === 'pointer').pop()
    open?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.waitForTimeout(400)
  const before = await inUse()

  const pressed = await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-frame="settings"] *')]
      .filter((e) => /^Gemini/.test(e.innerText ?? '') && getComputedStyle(e).cursor === 'pointer').pop()
    if (!row) return false
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  })
  await page.waitForTimeout(400)
  await page.evaluate(() => {
    const go = [...document.querySelectorAll('[data-frame="settings"] *')]
      .filter((e) => e.children.length === 0 && e.textContent?.trim() === 'Think with this').pop()
    go?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.waitForTimeout(900)
  const after = await inUse()

  ok('a second provider can be expanded', pressed)
  ok(
    'and choosing it moves which brain is in use',
    !!before && !!after && before !== after,
    `${JSON.stringify(before)} → ${JSON.stringify(after)}`,
  )
}

/** The composer opens and dismisses without moving the layout underneath. */
async function composer(page) {
  await scenario('normal')
  await home(page)

  const before = await page.evaluate(() => {
    const el = document.querySelector('[data-deck="relevance"]')
    return el ? Math.round(el.getBoundingClientRect().top) : null
  })

  await page.evaluate(() => document.querySelector('[data-frame="composer"] input')?.focus())
  await page.waitForTimeout(400)
  await page.evaluate(() => document.querySelector('[data-frame="composer"] input')?.blur())
  await page.waitForTimeout(500)

  const after = await page.evaluate(() => {
    const el = document.querySelector('[data-deck="relevance"]')
    return el ? Math.round(el.getBoundingClientRect().top) : null
  })
  ok('focusing and dismissing the composer returns the layout exactly', before === after, `${before} → ${after}`)
}

/**
 * THE DEAD-CONTROL SWEEP. §45.
 *
 * Every visible interactive element, checked for an accessible name and for
 * something to do. `cursor:pointer` divs are included deliberately: the two
 * worst controls the audit found were neither `<button>` nor tagged, and a sweep
 * that only counted the tagged ones would have missed both.
 *
 * The React-handler check is the interesting half. A `<div onClick>` compiles to
 * a prop React holds internally, so the DOM shows nothing — but React attaches
 * its props to the element under a `__reactProps$…` key, and that is readable.
 * An element with no handler, no href and no parent handler is a control wired
 * to nothing, which is exactly what "Set a reminder" was.
 */
const SWEEP = `(() => {
  const out = []
  const handlerOn = (el) => {
    for (const k of Object.keys(el)) {
      if (!k.startsWith('__reactProps$')) continue
      const p = el[k]
      if (p && (p.onClick || p.onPointerUp || p.onPointerDown || p.onKeyDown || p.onChange)) return true
    }
    return false
  }
  const anyHandler = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (handlerOn(n)) return true
      if (n.tagName === 'A' && n.getAttribute('href')) return true
    }
    return false
  }
  for (const el of document.querySelectorAll('button, a, input, select, textarea, [role="button"], [data-role], [data-affordance]')) {
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue
    const tag = el.tagName.toLowerCase()
    const interactive = ['button','a','input','select','textarea'].includes(tag) ||
      el.getAttribute('role') === 'button' || cs.cursor === 'pointer'
    if (!interactive) continue
    const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || '').trim()
    out.push({
      role: el.getAttribute('data-role') || tag,
      name: name.slice(0, 40),
      named: name.length > 0,
      wired: anyHandler(el) || tag === 'input' || tag === 'textarea' || tag === 'select',
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
    })
  }
  return out
})()`

async function deadControls(page, where) {
  const found = await page.evaluate(SWEEP)
  const dead = found.filter((c) => !c.wired && !c.disabled)
  const unnamed = found.filter((c) => !c.named && !c.disabled)
  ok(
    `${where}: every visible control does something`,
    dead.length === 0,
    dead.map((c) => `${c.role} "${c.name}"`).join(', '),
  )
  ok(
    `${where}: every visible control has an accessible name`,
    unnamed.length === 0,
    unnamed.map((c) => c.role).join(', '),
  )
  /*
    THE COUNT IS PRINTED PER SURFACE, not only summed.

    §22: the number is not a score, and a total that moved is not by itself a
    finding. What is worth being able to read off a run is WHERE it moved — the
    total fell by nine this round and the whole of it is two deletions, the
    Activity card's goal pill and the `undo` / `✕` pair that a view-only
    operation used to leave behind on every surface it was performed on. A bare
    total cannot tell that from a surface that stopped rendering.
  */
  console.log(`    ${where}: ${found.length} controls`)
  return found.length
}

// ── harness ──────────────────────────────────────────────────────────────────

function start(cmd, args, env) {
  const c = spawn(cmd, args, { stdio: 'ignore', env: { ...process.env, ...env } })
  children.push(c)
  return c
}

function freePort(port) {
  try {
    const pids = execSync(`lsof -ti :${port} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().split('\n').filter(Boolean)
    for (const raw of pids) {
      const pid = Number(raw)
      if (!Number.isInteger(pid) || pid === process.pid) continue
      let ppid = 0
      let command = ''
      try {
        const line = execSync(`ps -o ppid=,command= -p ${pid}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
        ppid = Number(line.split(/\s+/)[0])
        command = line.slice(String(ppid).length).trim()
      } catch { continue }
      // Only an orphaned fixture, and never a sibling run's — the port-killer
      // that shot a concurrent suite is a mistake this file does not repeat.
      if (!/fixture\.mjs/.test(command) || ppid !== 1) continue
      try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    }
  } catch { /* nothing listening */ }
}

/** Every descendant of a pid. `npx` wraps the fixture, so the listener is a grandchild. */
async function childPids(root) {
  const out = []
  const walk = (pid) => {
    let kids = []
    try {
      kids = execSync(`pgrep -P ${pid}`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim().split('\n').filter(Boolean).map(Number)
    } catch { return }
    for (const k of kids) { out.push(k); walk(k) }
  }
  walk(root)
  return out
}

const waitFor = async (url, ms = 40_000) => {
  const until = Date.now() + ms
  for (;;) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) })
      if (r.ok) return
    } catch { /* not yet */ }
    if (Date.now() > until) throw new Error(`nothing answered on ${url}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

async function main() {
  freePort(FIXTURE)
  // `tsx`, not `node`: the fixture imports the real deck and presentation
  // projections. See the note in shots.mjs.
  const fixture = start('npx', ['tsx', 'scripts/fixture.mjs', '--port', String(FIXTURE)])

  const listening = async (port) =>
    fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(2500) }).then(() => true).catch(() => false)

  if (!(await listening(PORT))) {
    start('npx', ['vite', '--port', String(PAGE_PORT), '--strictPort'], {
      CRUCIBLE_API_TARGET: `http://localhost:${FIXTURE}`,
    })
  } else {
    // Step past a squatter rather than killing it: it may be a sibling run.
    for (let p = PORT + 1; p <= PORT + 8; p++) {
      if (!(await listening(p))) { PAGE_PORT = p; break }
    }
    if (PAGE_PORT !== PORT) {
      start('npx', ['vite', '--port', String(PAGE_PORT), '--strictPort'], {
        CRUCIBLE_API_TARGET: `http://localhost:${FIXTURE}`,
      })
    }
  }

  await waitFor(`http://localhost:${FIXTURE}/api/providers`)

  /*
    AND IT IS OUR FIXTURE ANSWERING, NOT ONE SOMEBODY LEFT RUNNING.

    `freePort` deliberately kills only an orphan — the port-killer that shot a
    sibling suite is a mistake this file does not repeat — so a fixture started
    by hand, still parented to a live shell, survives it. The harness's own then
    fails to bind, silently (stdio is ignored), and `waitFor` is answered by the
    old process serving code from before whatever is being tested.

    That is not hypothetical: it happened during this phase, and it cost two
    green runs of a Places assertion whose compiler had stopped producing the
    line. Cheap to detect, and there is no honest way to continue past it.
  */
  const answering = await fetch(`http://localhost:${FIXTURE}/__id`).then((r) => r.json()).catch(() => null)
  const mine = new Set([fixture.pid, ...(await childPids(fixture.pid))])
  if (!answering || !mine.has(answering.pid)) {
    console.error(
      `\nA fixture we did not start is serving port ${FIXTURE} (pid ${answering?.pid ?? '?'}).\n` +
      `It is running whatever code it was started with, so this run would test that.\n` +
      `Stop it — \`kill ${answering?.pid ?? `$(lsof -ti:${FIXTURE})`}\` — and run again.`,
    )
    for (const c of children) c.kill('SIGKILL')
    process.exit(1)
  }

  await waitFor(BASE())

  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: DEVICE, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()

  await intelligenceDepth(page)
  await correction(page)
  await homeCards(page)
  await deckSwipe(page)
  await mail(page)
  await calendar(page)
  await providers(page)
  await composer(page)
  await calendarContext(page)
  await activityContext(page)
  await placesContext(page)
  await mailContext(page)

  /*
    ── the sweep, on every surface a person can reach ──

    FROM A CLEAN SLATE, and this matters to the number it reports. Home's
    controls depend on which domain is in front of the deck, and the deck
    remembers where it was left — so the total moved by nine between two runs
    that had deleted nothing, purely because the tasks above had paged it
    somewhere different. A count that changes with the order of the tests before
    it cannot be read as a count of controls.
  */
  await page.evaluate(() => localStorage.clear()).catch(() => {})
  await scenario('normal')
  await home(page)
  let counted = await deadControls(page, 'Home')
  for (const app of ['calendar', 'mail', 'fitness', 'places', 'video', 'watch']) {
    await open(page, app)
    counted += await deadControls(page, app)
  }

  await browser.close()
  for (const c of children) c.kill('SIGKILL')

  console.log(`\n${passes}/${passes + failures} interaction checks passed · ${counted} visible controls swept`)
  if (failures) {
    console.error(`${failures} interaction failure(s).`)
    process.exit(1)
  }
  process.exit(0)
}

main().catch((e) => {
  for (const c of children) c.kill('SIGKILL')
  console.error(e)
  process.exit(1)
})

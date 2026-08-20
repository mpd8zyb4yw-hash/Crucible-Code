#!/usr/bin/env node
/**
 * THE VISUAL GATE.
 *
 * Real bugs in this app — Mail's reply composer growing past its frame, the
 * standalone viewport leaving a black band under the composer — were invisible
 * to every check that existed and obvious in a screenshot. Reading a screenshot
 * is not something a test can do, but the specific things that were wrong in
 * those screenshots are all geometry, and geometry is measurable.
 *
 * So this does two jobs at once:
 *
 *   1. It captures the state matrix to `shots/`, for a human to look at.
 *   2. It ASSERTS the spatial contract on every capture, and exits non-zero
 *      when one is broken. The assertions are the gate; the images are the
 *      evidence.
 *
 * The contract, in one place:
 *
 *   · nothing paints outside `SurfaceFrame` — including the largest editor
 *     state each renderer supports (this is the Mail-reply regression);
 *   · no surface content overlaps the chat region;
 *   · the document itself never scrolls vertically;
 *   · the composer sits at the bottom of the usable window, not floating
 *     hundreds of pixels above it (this is the standalone-viewport regression);
 *   · Home holds four lanes at FIXED Y positions, one visible card each, and
 *     those positions are identical whatever the feed contains;
 *   · a lane with twenty objects gets a numeric pager, not twenty dots;
 *   · chat is the foreground layer: a tap behind the glass only collapses it,
 *     and never activates what it was covering;
 *   · a critical interrupt sits above chat, with Home still inert.
 *
 * Run: npm run shots            (needs the fixture + a dev server; see below)
 *      npm run shots -- --only home
 */
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { spawn, execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'shots')
const FIXTURE = 3002
const PORT = 5174
let PAGE_PORT = PORT
/* Resolved at startup — see the port check in main(). */
const BASE_OF = () => `http://localhost:${PAGE_PORT}`

/** iPhone 12/13/14 logical size — the phone this is designed against. */
const PHONE = { width: 375, height: 812 }

/**
 * iPhone 17 logical size — the phone this is actually USED on.
 *
 * It is here because the dead centre was only ever visible at this size: the
 * lane heights were constants that happened to add up on a 812pt window and
 * left ~250px of nothing on an 874pt one. A gate that only ever measured the
 * design size could not see the screen he was looking at.
 */
const DEVICE = { width: 402, height: 874 }

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null
const keep = process.argv.includes('--keep')

// ── the matrix ───────────────────────────────────────────────────────────────

/**
 * Each capture names a scenario for the fixture and, optionally, a `drive`
 * function that puts the app into a deeper state — a thread open, a message
 * expanded, a reply composer with a long draft in it.
 *
 * `expects.surface` marks the captures where a domain surface is on screen and
 * the containment assertions therefore apply.
 */
const SHOTS = [
  { name: 'home-normal', scenario: 'normal' },
  { name: 'home-many', scenario: 'many' },
  { name: 'home-failed-task', scenario: 'failed-task' },
  { name: 'home-long-title', scenario: 'long-title' },
  { name: 'home-empty', scenario: 'empty' },

  { name: 'mail-thread', scenario: 'normal', open: 'mail', surface: true },
  {
    name: 'mail-selected', scenario: 'normal', open: 'mail', surface: true,
    drive: async (p) => { await tap(p, '[data-object="m1"] [data-role="pick"]') },
  },
  {
    name: 'mail-expanded', scenario: 'normal', open: 'mail', surface: true,
    drive: async (p) => { await openMessage(p, 'm1') },
  },
  {
    name: 'mail-reply-open', scenario: 'normal', open: 'mail', surface: true,
    drive: async (p) => {
      await openMessage(p, 'm1')
      await tap(p, '[data-role="reply"]')
    },
  },
  {
    // THE regression. A long draft must scroll inside the drawer, not grow it.
    name: 'mail-reply-long-draft', scenario: 'normal', open: 'mail', surface: true,
    drive: async (p) => {
      await openMessage(p, 'm1')
      await tap(p, '[data-role="reply"]')
      const box = p.locator('[data-role="draft"]')
      await box.fill(Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a very long reply that goes on well past the height of the frame.`).join('\n'))
    },
  },
  { name: 'mail-empty', scenario: 'mail-empty', open: 'mail', surface: true },

  { name: 'calendar-month', scenario: 'normal', open: 'calendar', surface: true },
  {
    name: 'calendar-event', scenario: 'normal', open: 'calendar', surface: true,
    drive: async (p) => { await tap(p, '[data-object="e1"]') },
  },

  { name: 'video-results', scenario: 'normal', open: 'video', surface: true },
  {
    name: 'video-expanded', scenario: 'normal', open: 'video', surface: true,
    /*
      THE THING THAT EXPANDS, not the middle of the card.

      This tapped `[data-object="v1"]` — the whole card — and got an expansion
      for as long as the card had exactly one tap target. It now has two: the
      picture plays the video and the words open it up, which is §25's direct
      manipulation rule and the reason three "Watch ↗" pills could be deleted.
      The card's CENTRE is the picture, so this capture silently started
      exercising "play" and captured the destination picker sitting over the
      list — a correct modal, drawn over controls, reported as a covered-control
      failure.

      A capture that taps a card's midpoint is asserting that the card has one
      meaning. Naming the affordance says which of the two this capture is about.
    */
    drive: async (p) => { await tap(p, '[data-object="v1"] [data-role="expand"]') },
  },

  { name: 'map-place', scenario: 'normal', open: 'places', surface: true },
  { name: 'fitness-day', scenario: 'normal', open: 'fitness', surface: true },
  {
    name: 'watch-detail', scenario: 'normal', open: 'watch', surface: true,
    drive: async (p) => { await tap(p, '[data-object="w1"]') },
  },

  /*
    THE FOUR-LANE HOME.

    `lanes` and `lane-overflow` are a pair and are compared against each other
    after the run: eight objects and twenty-six must produce identical lane
    geometry, or "fixed" is a claim rather than a property.
  */
  { name: 'home-deck', scenario: 'lanes', lanes: true, projects: 3 },
  { name: 'home-deck-many', scenario: 'lane-overflow', lanes: true },
  { name: 'home-deck-empty', scenario: 'empty', quiet: true },

  {
    /*
      ONE SWIPE MOVES EXACTLY ONE DOMAIN, and nothing below the deck moves.

      Driven by the KEYBOARD, which is not a convenience here: swipe is the
      primary interaction and may never be the only one (§14), and the arrow
      keys are the whole of the non-touch path now that the dots are a readout
      rather than a control. If this capture cannot page the deck, the deck is
      swipe-only and the gesture rule is broken.
    */
    name: 'home-deck-paged', scenario: 'lanes', lanes: true,
    drive: async (p) => {
      await p.locator('[data-role="deck"]').focus()
      await p.keyboard.press('ArrowRight')
      await p.waitForTimeout(420)
    },
  },
  {
    /*
      THE ZOOM-OUT, AND THE PROOF THAT IT IS NOT A HOME SCREEN.

      Reached through the visually-hidden control, which is also the assertion
      that the non-pinch path exists — someone who cannot make a two-finger
      gesture must still be able to see all their domains.
    */
    name: 'home-overview', scenario: 'lanes',
    drive: async (p) => {
      // Focus + Enter, not a click: it is a visually-hidden control, so the
      // keyboard IS its interaction. Driving it with a mouse would be testing
      // a path no one has.
      await p.locator('[data-role="deck-overview"]').focus()
      await p.keyboard.press('Enter')
      await p.waitForTimeout(320)
    },
  },
  {
    // And that picking one closes it. A grid you can stay on IS a launcher.
    name: 'home-overview-closes', scenario: 'lanes',
    drive: async (p) => {
      await p.locator('[data-role="deck-overview"]').focus()
      await p.keyboard.press('Enter')
      await p.waitForTimeout(280)
      await p.locator('[data-role="overview-mini"]').first().click()
      await p.waitForTimeout(340)
    },
  },

  /*
    ═══ THE REGRESSION CAPTURES ═══

    One per binary rule in docs/ui-contract.md, each running the Home contract
    assertions in `check` — no card scrolls, no card exceeds its tier, no
    critical content is clipped, no launcher exists, an empty band collapses.

    `question` is the capture that did not exist. The scrollable card shipped
    through a suite of fifty-six green captures because not one of them rendered
    a question, and the fixture could not produce one if it had wanted to.
  */
  { name: 'home-question', scenario: 'question', lanes: true, question: true },
  { name: 'home-question-iphone17', scenario: 'question', viewport: DEVICE, standalone: true, question: true },
  {
    // THE SCREENSHOT THE CONTRACT ASKS FOR: hostile content at the largest
    // supported text size. Both at once, because either one alone has passed
    // before while the pair fails.
    name: 'home-hostile-large-text', scenario: 'hostile', viewport: DEVICE, standalone: true,
    textScale: 1.5, question: true,
  },
  { name: 'home-hostile', scenario: 'hostile', viewport: DEVICE, standalone: true, question: true },
  { name: 'home-large-text', scenario: 'lanes', viewport: DEVICE, standalone: true, textScale: 1.5, lanes: true },
  {
    // A genuinely quiet morning. One line, no bordered rectangles, no launcher.
    name: 'home-quiet', scenario: 'empty', viewport: DEVICE, standalone: true, quiet: true,
  },

  /*
    THE PHONE THIS IS ACTUALLY USED ON.

    375×812 is the design size and 402×874 is the device in his hand, and the
    dead centre only ever appeared on the second one — lane heights were
    constants that happened to add up on the smaller window. Both sizes are now
    captured, and each is compared against its OWN reference, because "fixed
    geometry" means fixed for a given device, not identical across devices.
  */
  { name: 'home-deck-iphone17', scenario: 'lanes', lanes: true, viewport: DEVICE, standalone: true, projects: 3 },
  /*
    An empty feed no longer produces three empty bands, so this is no longer a
    `lanes` capture — it is the quiet-morning capture, and it asserts the
    opposite of what it used to: NOT that the bands hold their geometry, but
    that they collapse out of the way.
  */
  { name: 'home-deck-iphone17-empty', scenario: 'empty', quiet: true, viewport: DEVICE, standalone: true },
  { name: 'home-deck-iphone17-many', scenario: 'lane-overflow', lanes: true, viewport: DEVICE, standalone: true },

  /*
    CARD TAP → OBSERVABLE TRANSITION.

    The complaint this exists for is "I tapped Calendar and nothing happened",
    and nothing in the gate could have caught it: every check asked about Home's
    geometry, none asked whether a tap left Home at all. So these assert the
    whole path — the card body (not a nested control) opens the domain
    workspace, Home is gone, and the object the card NAMED is the focused one.
  */
  {
    name: 'tap-calendar', scenario: 'lanes', viewport: DEVICE,
    navigates: { from: 'calendar', focus: 'e1' },
    drive: async (p) => { await tapApp(p, 'calendar') },
  },
  {
    name: 'tap-mail', scenario: 'lanes', viewport: DEVICE,
    navigates: { from: 'mail', focus: 'm1' },
    drive: async (p) => { await tapApp(p, 'mail') },
  },
  {
    /*
      A saved pane is the same contract: the card body is the target.

      It is in the RELEVANCE slot now, not a `background` band. Panes are not
      domains, so they are not in the deck; they compete for slot two like
      everything else and win it when they are what most deserves the space.
      This capture is what caught them being dropped from that competition
      altogether when the bands were removed.
    */
    name: 'tap-pane', scenario: 'lanes', viewport: DEVICE,
    navigates: {},
    drive: async (p) => { await tapVisibleCard(p, 'relevance') },
  },

  /*
    THE BLANK SCREEN.

    Home draws all six system apps; the feed carries a `need` for only some of
    them. Every id in that gap rendered NOTHING — Home unmounted, no surface
    mounted, a background gradient and no way back. It was not a crash, so no
    boundary saw it, and every store assertion passed because the store was
    right; the gate asked about Home's geometry and about taps that happened to
    work, and never about this.

    Each of these taps a card whose object the feed knows nothing about, and
    asserts the renderer that application IS. `renders` is the whole point:
    "a surface opened" was already true for cases that were broken.
  */
  ...['calendar', 'mail', 'places', 'video', 'fitness', 'watch'].map((app) => ({
    name: `tap-unbacked-${app}`, scenario: 'apps-unbacked', viewport: DEVICE, surface: true,
    navigates: { renders: app === 'places' ? 'map' : app },
    drive: async (p) => { await tapApp(p, app) },
  })),

  /*
    SETTINGS. Its own bounded application surface, and the keyboard belongs to
    the person who taps a text field.
  */
  { name: 'settings', scenario: 'lanes', openSettings: true, settings: { noKeyboard: true } },
  {
    /**
     * THE SCREEN THAT MAKES THE TRACEABILITY RULE CHECKABLE.
     *
     * Every card claims to trace back to a typed fact, a computation or a marked
     * inference; this is where that claim can be audited for the whole model at
     * once. It is captured open, because a section that only renders when tapped
     * is a section a harness will happily never render.
     */
    name: 'settings-what-i-know', scenario: 'lanes', openSettings: true, settings: { noKeyboard: true },
    drive: async (p) => {
      await tap(p, 'text=What I know')
      /**
       * Scrolled INTO the section, or the capture is a picture of the row that
       * opens it rather than of the thing that opened. Settings has its OWN
       * scroll container — `scrollIntoViewIfNeeded` moves the window, which on
       * a `position:fixed` shell moves nothing at all.
       */
      await p.evaluate(() => {
        const box = document.querySelector('[data-role="settings-scroll"]')
        const head = [...document.querySelectorAll('div')].find((d) => d.textContent?.trim() === 'What I know')
        if (box && head) box.scrollTop += head.getBoundingClientRect().top - box.getBoundingClientRect().top - 8
      })
      await p.waitForTimeout(500)
    },
  },
  {
    name: 'settings-provider-connected', scenario: 'lanes', openSettings: true,
    settings: { noKeyboard: true },
    drive: async (p) => { await tap(p, '[data-provider="anthropic"]') },
  },
  {
    // A provider with exactly one model uses the SAME hierarchy. Consistency
    // beats saving a tap, and the shortcut is what tempted the auto-select.
    name: 'settings-provider-single-model', scenario: 'lanes', openSettings: true,
    settings: { noKeyboard: true },
    drive: async (p) => { await tap(p, '[data-provider="gemini"]') },
  },
  {
    // THE regression: expanding an UNCONNECTED provider autofocused a password
    // field, iOS shrank the viewport ~340px, and the app relaid out around a
    // keyboard he never asked for.
    name: 'settings-provider-unconnected', scenario: 'lanes', openSettings: true,
    settings: { noKeyboard: true },
    drive: async (p) => { await tap(p, '[data-provider="openai"]') },
  },
  {
    // Provider → model → detail, all inline, and still no keyboard.
    name: 'settings-model-detail', scenario: 'lanes', openSettings: true,
    settings: { noKeyboard: true },
    drive: async (p) => {
      await tap(p, '[data-provider="anthropic"]')
      await tap(p, '[data-role="models"]')
      await tap(p, '[data-model="claude-sonnet-5"]')
    },
  },

  /*
    CHAT OVER HOME. Three snap states, and strict foreground ownership.
  */
  {
    name: 'chat-expanded', scenario: 'lanes', chat: 'expanded',
    drive: async (p) => { await tap(p, '[data-frame="composer"]') },
  },
  {
    name: 'chat-max', scenario: 'lanes', chat: 'max',
    drive: async (p) => {
      await tap(p, '[data-frame="composer"]')
      await tap(p, '[data-role="expand-chat"]')
    },
  },
  {
    // THE regression this rule exists for: a tap behind the glass collapses
    // chat and must NOT also open whatever was under the finger.
    name: 'chat-scrim-collapses', scenario: 'lanes', chat: 'collapsed', stillHome: true,
    drive: async (p) => {
      await tap(p, '[data-frame="composer"]')
      await p.locator('[data-role="chat-scrim"]').click({ position: { x: 180, y: 120 } }).catch(() => {})
      await p.waitForTimeout(320)
    },
  },
  {
    // A critical interrupt reaches him above chat; Home stays inert underneath,
    // and the interrupt — not the composer — owns the tap.
    name: 'chat-interrupt', scenario: 'critical', interrupt: true,
    drive: async (p) => { await tap(p, '[data-frame="composer"]') },
  },
  {
    // Acknowledging it hands input back, and nothing below was disturbed.
    name: 'chat-interrupt-dismissed', scenario: 'critical', reachable: true,
    drive: async (p) => { await tap(p, '[data-role="interrupt-dismiss"]') },
  },

  { name: 'ask', scenario: 'normal', open: 'ask' },

  /*
    ═══ NO BLANK DESTINATION, SWEPT RATHER THAN SAMPLED ═══

    The blank pane keeps coming back, and every previous fix was aimed at the
    one path that produced it that week — a system app with no backing need, a
    question with no panes. `noBlank` does not name a path: it enumerates every
    tappable card on Home at capture time, taps each one with real hit-testing,
    and demands that the result be one of the three legal outcomes.

    `panes.length` is deliberately not the test. A need can carry a pane whose
    widget renders nothing, which produces a header over a black rectangle and
    satisfies every structural check ever written for this. What is asserted is
    the RENDERED result: content, or a declared empty state.
  */
  { name: 'no-blank-lanes', scenario: 'lanes', viewport: DEVICE, noBlank: true },
  { name: 'no-blank-question', scenario: 'question', viewport: DEVICE, noBlank: true },
  { name: 'no-blank-hostile', scenario: 'hostile', viewport: DEVICE, noBlank: true },
  { name: 'no-blank-overflow', scenario: 'lane-overflow', viewport: DEVICE, noBlank: true },
  { name: 'no-blank-failed-task', scenario: 'failed-task', viewport: DEVICE, noBlank: true },
  /*
    `apps-unbacked` and `mail-empty` are NOT swept, and the reason is a real
    consequence of removing the launcher rather than an omission. Both are
    scenarios whose only Home representation was the app strip: every need in
    them is `quiet`, so `classify` produces no card, and there is nothing on
    Home to tap. Their contract — that a system app with no backing need still
    mounts its own renderer rather than nothing — is asserted by the
    `tap-unbacked-*` captures, which now drive the deep link.
  */

  /*
    DELIBERATE FAILURE AT EVERY SEAM THAT CAN LOSE THE SCREEN.

    There was already one injection point and it covered a domain widget's
    render — the seam that was ALREADY protected. So what it proved was that
    the protection it was testing worked, while every failure actually seen on
    the phone happened somewhere else: Home's own render, the deck, navigation,
    settings, hydration. None of those could be made to fail on purpose, so
    none was ever shown to survive failing.

    Every capture here asserts the same thing, which is the only thing that
    matters to someone holding the phone: THERE IS STILL A SCREEN. That check
    runs on all captures (rule 0) — these are the ones that earn it.
  */
  ...[
    ['home', 'Home’s own render'],
    ['deck', 'the paged lane'],
    ['nav', 'resolving what a card opens'],
    ['hydrate', 'reading persisted state on boot'],
  ].map(([point]) => ({
    name: `poison-${point}`, scenario: 'lanes', viewport: DEVICE, poison: [point],
  })),

  {
    // Settings blanking is the worst case of all: it is the screen someone
    // opens BECAUSE something is wrong.
    name: 'poison-settings', scenario: 'lanes', openSettings: true, poison: ['settings'],
  },
  {
    name: 'poison-provider', scenario: 'lanes', openSettings: true, poison: ['provider'],
    drive: async (p) => { await tap(p, '[data-provider="anthropic"]') },
  },
  {
    // A poisoned target surface must leave the previous screen recoverable
    // rather than taking the app with it.
    name: 'poison-target-surface', scenario: 'lanes', viewport: DEVICE, poison: ['calendar'],
    drive: async (p) => { await tapApp(p, 'calendar') },
  },

  /*
    THE VIEWPORT ENVIRONMENTS.

    Safari-with-chrome and Home-Screen-standalone are genuinely different
    windows, not the same window styled differently, and the bug was that the
    app treated them as one: sized for the smaller and left the reclaimed band
    black in the larger. Chromium cannot BE iOS, but it can present the two
    window sizes and the standalone display mode, and the assertion that
    matters — the shell fills the window it was given, and the composer sits at
    its bottom — is exactly the one that was failing.
  */
  { name: 'viewport-safari', scenario: 'normal', viewport: { width: 375, height: 725 } },
  { name: 'viewport-standalone', scenario: 'normal', viewport: { width: 375, height: 812 }, standalone: true },
  {
    // The keyboard is a third window. The composer must stay above it, and the
    // home-indicator inset must NOT also be applied — that was the double
    // padding that pushed the composer up for nothing.
    name: 'viewport-keyboard', scenario: 'normal', open: 'ask',
    viewport: { width: 375, height: 812 }, keyboard: 336,
  },
]

/**
 * Tap the BODY of a named card in a lane, paging to it first if it is not the
 * one showing.
 *
 * The body, not a nested control: "the card itself is the navigation target" is
 * the rule being tested, so clicking an `open` chip would prove the wrong thing.
 * The click lands on the title area, clear of the state row's controls.
 */
async function tapCard(page, band, openId) {
  /*
    THE DECK PAGES WITH THE KEYBOARD, not with a pager button.

    The pager is gone: the dots are a readout and the arrows never came back.
    ← / → on the focused deck is the operable non-touch path, so paging with it
    here is also the assertion that it works — the same double duty the pager
    dots used to do.
  */
  const target = `[data-deck="${band}"] [data-card="${openId}"], [data-deck="${band}"] [data-card] [data-open="${openId}"]`
  for (let i = 0; i < 10; i++) {
    if (await onScreen(page, target)) break
    await page.locator(`[data-deck="${band}"]`).focus().catch(() => {})
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(300)
  }
  const el = page.locator(target).first()
  if (await el.count() === 0) return false
  await el.click({ position: { x: 70, y: 44 }, timeout: 4000 }).catch(() => {})
  await page.waitForTimeout(400)
  return true
}

/** Is it rendered AND in the deck's viewport? A slide off to the right is not. */
async function onScreen(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const deck = el.closest('[data-role="deck"]')
    if (!deck) return true
    const a = el.getBoundingClientRect()
    const b = deck.getBoundingClientRect()
    return a.left >= b.left - 1 && a.right <= b.right + 1
  }, selector)
}

/** Same, for a slot whose visible card has no fixed id. */
async function tapVisibleCard(page, band) {
  /*
    `[data-deck=x][data-card]` — same element, not a descendant.

    Slots two and three carry both attributes on one node: they hold exactly one
    object, so there is no deck of cards inside them to select. The descendant
    form silently matched nothing and reported the tap as a navigation failure.
  */
  const el = page.locator(
    `[data-deck="${band}"] [data-card] [data-open], [data-deck="${band}"][data-card], [data-deck="${band}"] [data-card]`,
  ).first()
  if (await el.count() === 0) return false
  await el.click({ position: { x: 70, y: 44 }, timeout: 4000 }).catch(() => {})
  await page.waitForTimeout(400)
  return true
}

/**
 * OPEN AN APPLICATION.
 *
 * Three implementations so far, and the sequence is the design argument. The
 * six applications were a LANE, so reaching Fitness meant paging a deck five
 * times and captures that failed to page silently measured Home instead. Then
 * they were a STRIP of tiles — one tap, no gesture. Now they are not on Home at
 * all, because a launcher is permanent screen spent on integrations that have
 * nothing to say today, and this drives the URL.
 */
async function tapApp(page, appId) {
  /*
    THE LAUNCHER IS GONE, SO THIS DRIVES THE DEEP LINK INSTEAD.

    `#/open/<id>` is the same `openView` a card tap calls — same resolution,
    same refusal on an unmountable target — so every assertion these captures
    make about "tapping Calendar mounts the calendar renderer" still tests the
    real path. What it no longer tests is a tile, because there is no tile: see
    docs/ui-contract.md §8.
  */
  await page.evaluate((id) => {
    window.location.hash = `#/open/${encodeURIComponent(id)}`
  }, appId)
  await page.waitForTimeout(300)
  /*
    DID IT ACTUALLY OPEN? The deep link resolves through `openView`, which
    REFUSES a target it cannot mount and says so at the seam rather than
    opening a blank frame. That is correct behaviour and it is not a tap: `ask`
    is a card, not an application, so it has no deep link and this must report
    failure so the caller falls back to the card selector.

    Returning `true` unconditionally cost two captures — `ask` opened nothing,
    the refusal printed in the status row, and the gate reported the status row
    overflowing rather than the navigation not happening.
  */
  return page.evaluate(() => !!document.querySelector('[data-frame="surface"]'))
}

/**
 * Make sure a message is expanded, whoever expanded it.
 *
 * Mail arrives focused on the message the Home card named, and a focused
 * message is already open — so blindly tapping `open` here would CLOSE it. The
 * captures want the expanded state, not a particular number of taps.
 */
async function openMessage(page, id) {
  const body = `[data-object="${id}"] [data-role="reply"], [data-role="reply"]`
  if (await page.locator(body).count()) return true
  return tap(page, `[data-object="${id}"] [data-role="open"]`)
}

/**
 * Settings, the way he opens it: a long press on the composer.
 *
 * There is no settings CARD — it is deliberately a gesture rather than a lane
 * position — so the gate has to perform the gesture rather than tap a selector.
 */
async function openSettings(page) {
  // The send control, NOT the composer box — pressing the box lands on its
  // text input and focuses it, which is the very thing these captures assert
  // does not happen by accident.
  const el = page.locator('[data-role="composer-send"]').first()
  if (await el.count() === 0) return false
  const b = await el.boundingBox()
  if (!b) return false
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(700)
  await page.mouse.up()
  await page.waitForTimeout(350)
  return true
}

/**
 * TAP EVERY TAPPABLE CARD ON HOME AND SAY WHAT ARRIVED.
 *
 * The blank-pane sweep. For each card and each app in the strip's replacement
 * (the deep link), this returns one of:
 *
 *   inline    the tap completed without navigating, and Home is still there —
 *             which is correct for a question card, whose answers write
 *             directly and which has nowhere to go.
 *   content   a surface mounted with a renderer and real painted area.
 *   empty     a surface mounted and DECLARED its empty state.
 *   blank     a surface mounted and neither — this is the failure.
 *   refused   navigation was refused and the previous screen was kept, with a
 *             reason said at the seam. Also correct: the contract forbids
 *             opening nothing, not refusing to open.
 *
 * Each card is tapped from a fresh reload rather than by navigating back,
 * because "back" is its own path and a failure inside it would be attributed to
 * whichever card happened to follow.
 */
async function sweepDestinations(page, base) {
  const out = []
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('[data-frame="home"] [data-card]')]
      .map((el) => el.getAttribute('data-card'))
      .filter(Boolean),
  )

  for (const id of ids) {
    await page.goto(base, { waitUntil: 'networkidle' })
    /*
      WAIT FOR HOME TO HAVE CARDS, RATHER THAN FOR A NUMBER OF MILLISECONDS.

      A fixed 400ms here was the sweep's own flakiness: under load the feed had
      not arrived, Home was cold, and every card was reported "could not be
      hit-tested" — a harness failure that reads exactly like the product defect
      it is looking for, which is the worst possible way for a gate to be wrong.
      Two consecutive runs of identical code disagreed because of it.
    */
    await page.waitForFunction(
      () => document.querySelectorAll('[data-frame="home"] [data-card]').length > 0,
      null,
      { timeout: 10_000 },
    ).catch(() => { /* a legitimately empty Home; the id loop will report it */ })

    /*
      PAGE TO IT FIRST.

      A deck marks only the CURRENT slot with `data-card`, so after the reload
      every card that was not showing simply does not exist under that selector —
      and the sweep reported "could not be hit-tested" for cards that were
      perfectly reachable one swipe away. Paged through the deck's own dots,
      which is the same control a person uses, so a card that cannot be reached
      this way genuinely cannot be reached.
    */
    /*
      "SHOWING" NOW MEANS ON SCREEN, NOT MERELY IN THE DOM.

      The old predicate — does this `data-card` exist — was true of whichever
      single card a band deck had mounted, so existence and visibility were the
      same question. In the widget deck they are not: EVERY domain is mounted all
      the time (that is the point of the design), so the predicate was satisfied
      instantly, the paging loop exited without doing anything, and the hit test
      ran against a slide still parked off to the side or still settling after
      the reload.

      That is why three consecutive runs of identical code reported different
      cards unreachable — a harness failure that reads exactly like the product
      defect it is looking for, which is the one shape of wrongness a gate must
      not have. Asking whether the card is inside its scroller's viewport makes
      it a question about the app again.
    */
    const showing = () => page.waitForFunction(
      (cardId) => {
        const el = document.querySelector(`[data-card="${CSS.escape(cardId)}"]`)
        if (!el) return false
        const deck = el.closest('[data-role="deck"]')
        if (!deck) return true
        const a = el.getBoundingClientRect()
        const b = deck.getBoundingClientRect()
        return a.width > 0 && a.left >= b.left - 2 && a.right <= b.right + 2
      },
      id,
      /*
        A POLL, NOT A GLANCE.

        A single `evaluate` here asks once, at whatever instant the reload
        happened to reach, and the answer flipped between runs of identical
        code: Home paints its bands before the card's own reduction ladder has
        settled, so the slot can be a frame away from existing. Polling for the
        card makes the sweep a question about the app instead of a question
        about timing.
      */
      /*
        THE SAME BUDGET THE OUTER WAIT ALREADY USES, and 2000 was the harness
        measuring its own load rather than the app.

        The wait above gives Home 10s to have ANY card, and that is satisfied by
        the deck widget — which paints instantly from the cached feed, before the
        network. A card in slot two arrives with the FEED, so on a laptop running
        the whole 69-capture sweep it can legitimately be three seconds behind the
        thing that unblocked the outer wait. The result was `unreachable` reported
        against a card that was merely late, on a different card each run, which
        is the one shape of wrongness this gate must not have: a harness failure
        that reads exactly like the product defect it is looking for.

        Raising it costs nothing when the card is present — this is a poll and it
        returns on the first tick — and it does not weaken the assertion. A card
        that is genuinely unreachable is still unreachable after ten seconds.
      */
      { timeout: 10_000 },
    ).then(() => true).catch(() => false)

    for (let hop = 0; hop < 24; hop++) {
      if (await showing()) break
      /*
        Which band is it in? Unknown after a reload, so step whichever deck has
        more than one card, using the KEYBOARD path — the one §14 requires now
        that the arrows are gone. A deck past `dotsMax` draws a numeric position
        rather than dots, so a dot-clicking sweep could not reach card seven of
        twenty at all; ← / → works on every deck at every size, which is the
        whole reason it exists.
      */
      /*
        Page the deck with the keyboard until the card appears. There is one
        pageable region on Home now — the widget deck — so this no longer has to
        work out WHICH band a card is in, which is the whole reason the old
        version swept every track it could find.
      */
      const pageable = await page.evaluate(
        () => !!document.querySelector('[data-role="deck"]'),
      )
      if (!pageable) break
      await page.locator('[data-role="deck"]').focus().catch(() => {})
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(300)
    }

    // Real hit-testing on the card BODY — its title area, clear of the state
    // row's own controls, which are a different contract.
    const tapped = await page.evaluate((cardId) => {
      const slot = document.querySelector(`[data-card="${CSS.escape(cardId)}"]`)
      /*
        BRING IT ON SCREEN BEFORE HIT-TESTING IT.

        Every domain is in the deck's DOM — that is the point of the design, and
        it is what makes ranking unable to hide an application — but only one is
        within the deck's viewport at a time. `elementFromPoint` at the centre of
        an off-screen slide hits whatever is actually there, so without this the
        sweep reported five of six domains 'unreachable' when what it had really
        found was a horizontal scroller it was not driving.
      */
      const deck = slot?.closest('[data-role="deck"]')
      if (deck) {
        const i = [...deck.children].indexOf(slot)
        if (i >= 0) {
          deck.style.scrollBehavior = 'auto'
          deck.scrollLeft = i * deck.clientWidth
        }
      }
      const title = slot?.querySelector('[data-role="card-title"], [data-role="question-text"]')
      const target = title ?? slot
      if (!target) return false
      const r = target.getBoundingClientRect()
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
      if (!hit) return false
      hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 4, clientY: r.top + 4 }))
      hit.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.left + 4, clientY: r.top + 4 }))
      hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      return true
    }, id)
    if (!tapped) { out.push({ id, verdict: 'unreachable' }); continue }

    await page.waitForTimeout(450)

    out.push({ id, ...await page.evaluate(() => {
      const surface = document.querySelector('[data-frame="surface"]')
      if (!surface) {
        // Still on Home. Either the card completed inline, or the navigation
        // was refused and said so — both legal, and distinguished by whether a
        // reason is on screen.
        const said = (document.querySelector('[data-role="home-status"]')?.textContent ?? '').trim()
        return { verdict: document.querySelector('[data-frame="home"]') ? (said ? 'refused' : 'inline') : 'gone', said }
      }
      const declared = [...surface.querySelectorAll('[data-empty-state]')]
        .map((el) => el.getAttribute('data-empty-state')).filter(Boolean)
      const renderers = [...surface.querySelectorAll('[data-renderer]')]
        .map((el) => el.getAttribute('data-renderer')).filter(Boolean)
      /*
        PAINTED AREA INSIDE THE APPLICATION REGION, not inside the surface.

        The surface's own header and the chat handle paint whatever the
        application does, so counting them made a header-over-a-void look
        populated — which is the exact screenshot being guarded against.
      */
      const region = surface.querySelector('[data-surface]') ?? surface
      const painted = [...region.querySelectorAll('*')].filter((el) => {
        const r = el.getBoundingClientRect()
        if (r.width < 30 || r.height < 12) return false
        const s = getComputedStyle(el)
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'
      }).length
      const text = (region.textContent ?? '').trim().length
      if (declared.length) return { verdict: 'empty', declared, renderers, painted, text }
      if (renderers.length && painted >= 6 && text >= 12) return { verdict: 'content', renderers, painted, text }
      return { verdict: 'blank', renderers, painted, text }
    }) })
  }
  return out
}

/** Tap if present. A surface that legitimately has no such control is not a failure here. */
async function tap(page, selector) {
  const el = page.locator(selector).first()
  if (await el.count() === 0) return false
  await el.click({ timeout: 4000 }).catch(() => {})
  await page.waitForTimeout(180)
  return true
}

// ── the contract ─────────────────────────────────────────────────────────────

/**
 * Measure the invariants in the page. Everything here is a fact about boxes,
 * deliberately — an assertion that needed to know what a surface MEANS would be
 * a test of the fixture rather than of the layout.
 */
const MEASURE = () => {
  const box = (el) => {
    const r = el.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height }
  }
  const frame = document.querySelector('[data-frame="surface"]')
  const chat = document.querySelector('[data-frame="chat"]')
  const composer = document.querySelector('[data-frame="composer"]')
  const shell = document.querySelector('[data-frame="shell"]')

  /**
   * STRANDED CONTENT — the assertion that actually catches the bug.
   *
   * The naive check ("is any box outside the frame") is worthless here, and
   * worse than worthless: `SurfaceFrame` sets `overflow:hidden`, so NOTHING can
   * paint outside it, and every list row below the fold of a scrolling mailbox
   * trips it. The first version of this file failed fourteen captures, all of
   * them correct behaviour.
   *
   * What went wrong in the screenshot was not paint, it was REACH. The reply
   * composer was appended inside a container that could not scroll, so the
   * frame cut it in half and the send button was on the far side of the cut —
   * on screen in the DOM's opinion, and unreachable by any gesture.
   *
   * So an element is stranded when both are true:
   *
   *   · the frame's edge cuts it off, and
   *   · nothing between it and the frame can scroll far enough to reveal it.
   *
   * Content in a scroller is fine, however far down it is. Content in a fixed
   * column that overflows the frame is the regression.
   */
  /**
   * THE UNIVERSAL FIT RULE, MEASURED.
   *
   * The stranded-content check below is right, and it ran against ONE box —
   * `[data-frame="surface"]` — on the handful of captures someone remembered to
   * flag `surface: true`. So a Home card whose text ran under its controls, a
   * settings row past the fold of a container that could not scroll, a chat
   * bubble wider than its panel: none of them were ever asked about.
   *
   * It runs against EVERY box that declares itself bounded now — every
   * `[data-fit]`, plus the device shell itself, on every capture.
   *
   * The naive version of this ("is any box outside the device rect") was
   * written first and thrown away: it failed twenty-two captures, all of them
   * correct behaviour. A deck renders its previous and next cards a full screen
   * to either side and clips them; a scroller holds its content below the fold
   * on purpose; map tiles extend past the viewport because you drag them. Being
   * outside the box is normal. Being outside the box with NO WAY TO REACH IT is
   * the bug, and that is what is measured.
   */
  /**
   * Can this scroller reveal a cut of `by` pixels?
   *
   * Asked against the ACTUAL cut rather than a flat "does it scroll at all"
   * threshold. A grid five pixels taller than its scroller, in a scroller with
   * five pixels of travel, is reachable — and a fixed 4px floor called that a
   * stranded node while calling a genuinely stranded one reachable whenever
   * something else in the same box happened to overflow.
   */
  const scrollable = (el, axis, by) => {
    const s = getComputedStyle(el)
    const flow = axis === 'y' ? s.overflowY : s.overflowX
    if (flow !== 'auto' && flow !== 'scroll') return false
    const travel = axis === 'y'
      ? el.scrollHeight - el.clientHeight
      : el.scrollWidth - el.clientWidth
    return travel >= by - 1
  }
  /** A region that has DECLARED it is bigger than its box and moves by gesture. */
  const declared = (el) => el.hasAttribute('data-pannable') || el.hasAttribute('data-track')

  /**
   * Nearest named ancestor, so a failure names a place in the app.
   *
   * Hoisted out of the escapes loop: the width and reachability assertions
   * below report against the same vocabulary, and a failure that says
   * `role=surface-close` is actionable where one that says `div` is not.
   */
  const where = (node) => {
    for (let p = node; p; p = p.parentElement) {
      for (const a of ['data-fit', 'data-frame', 'data-deck', 'data-card', 'data-open', 'data-role', 'data-object', 'data-surface']) {
        const v = p.getAttribute?.(a)
        if (v) return `${a.replace('data-', '')}=${v}`
      }
    }
    return node.tagName?.toLowerCase() ?? '?'
  }

  const escapes = []
  for (const el of document.querySelectorAll('#root *')) {
    const b = box(el)
    if (b.w < 1 || b.h < 1) continue
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue
    // A deck draws its previous and next cards a full screen to either side and
    // clips them. They are `aria-hidden` precisely because they are not part of
    // the reachable view — the same fact this check needs.
    if (el.closest('[aria-hidden="true"]')) continue

    /*
      THE BOX THAT ACTUALLY GOVERNS THIS ELEMENT.

      Its nearest clipping ancestor — which is the only one whose edge can
      strand it. Checking against a list of DECLARED boxes was the mistake the
      first version made: a Home card clips its own contents and was never on
      that list, so a probe deliberately sticking 600px out of a card passed the
      whole gate. Every clipping box is checked now, declared or not, which is
      what makes the rule universal rather than a list someone maintains.
    */
    let clip = null
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (declared(p)) { clip = 'gesture'; break }
      if (getComputedStyle(p).overflow !== 'visible') { clip = p; break }
    }
    if (!clip || clip === 'gesture') continue

    const f = box(clip)
    const cutY = Math.max(b.bottom - f.bottom, f.top - b.top)
    const cutX = Math.max(b.right - f.right, f.left - b.left)
    if (cutY <= 1 && cutX <= 1) continue

    // Can anything between the element and that box bring it into view?
    let reachable = false
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (declared(p)) { reachable = true; break }
      if ((cutY > 1 && scrollable(p, 'y', cutY)) || (cutX > 1 && scrollable(p, 'x', cutX))) { reachable = true; break }
      if (p === clip) break
    }
    if (reachable) continue

    escapes.push({
      box: where(clip),
      at: where(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('data-role') ?? el.getAttribute('data-object') ?? '',
      over: Math.round(Math.max(cutY, cutX)),
      text: (el.textContent ?? '').trim().slice(0, 40),
    })
  }

  /**
   * NOTHING IS WIDER THAN THE PHONE.
   *
   * The stranded check above is sound and it still missed the worst defect this
   * app has had, because it is a check about REACH and this is a check about
   * WIDTH, and the two only coincide when the data happens to be long enough.
   *
   * What happened: `SurfaceWorkspace`'s grid constrained its rows with
   * `minmax(0, …)` and left the single implicit COLUMN at `auto`, so the track
   * took its minimum from the widest row's min-content. The chat handle carries
   * the surface's opening sentence, which in production is "6 in the last week
   * from 5 senders. Newest: …" — 71 characters. The track resolved to 464px
   * inside a 402px phone, every row was laid out 62px too wide, and `close` —
   * the only way back to Home — rendered from x=397 to x=446. Not hard to hit:
   * `elementFromPoint` at its centre returned null. Every opened application
   * was a one-way trip.
   *
   * The gate passed. It passed because the FIXTURE's opening is "What would you
   * like to do?" — 26 characters, which fits — so the one assertion that could
   * have caught it was never handed an input that triggered it. A gate whose
   * verdict depends on the test data being as hard as the real data is not a
   * gate, so this asserts the invariant structurally instead: the app is
   * `position:fixed; inset:0`, its width is the phone's, and no laid-out box
   * inside it may be wider than that. It is true of every capture, in every
   * data state, whether or not anyone wrote a long enough string.
   *
   * The exemptions are the same two the reach check uses, for the same reasons:
   * a declared pannable extends past its box by design, and the contents of a
   * horizontal scroller are reached by scrolling.
   */
  const shellW = shell ? box(shell).w : 0
  const wide = []
  if (shellW) {
    for (const el of document.querySelectorAll('#root *')) {
      const b = box(el)
      if (b.w <= shellW + 1) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue
      if (el.closest('[data-pannable]') || el.closest('[data-track]')) continue
      // Inside something that scrolls sideways on purpose — a chip bar, a rail.
      let scrolls = false
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX
        if (o === 'auto' || o === 'scroll') { scrolls = true; break }
      }
      if (scrolls) continue
      wide.push({ at: where(el), tag: el.tagName.toLowerCase(), w: Math.round(b.w), over: Math.round(b.w - shellW) })
    }
  }

  /**
   * EVERY CONTROL CAN BE TAPPED WHERE IT IS DRAWN.
   *
   * The other half of the same lesson. "Is it inside the frame" is geometry;
   * "does a finger on it reach it" is the product. So each control is hit-tested
   * at its own centre against `elementFromPoint` — the same function the browser
   * uses to route a real touch — and has to get itself back.
   *
   * This catches three different failures with one question: a control pushed
   * off the screen, a control under an invisible overlay that forgot to clear
   * its pointer events, and a control behind a scrim that should not have been
   * there. None of those are visible in a screenshot, and the first one is what
   * made the whole app unusable.
   *
   * The exemptions are all cases where the app has SAID the control is not
   * reachable, rather than cases where it merely turns out not to be:
   *
   *   inert          the app's own declaration that a region is context only —
   *                  Home behind an expanded chat panel or a critical interrupt.
   *                  This is the right test rather than a list of overlay names,
   *                  because `inert` is what the app already sets to mean
   *                  exactly this, and it is what assistive technology obeys. A
   *                  scrim that covered Home WITHOUT `inert` would still fail
   *                  here, which is the bug worth catching.
   *   aria-hidden    a deck's off-screen previous and next cards.
   *   under a drawer a bounded drawer covering the surface is doing its job.
   *   scrolled away  content below the fold of its own scroller.
   */
  const unreachable = []
  for (const el of document.querySelectorAll('#root button, #root [data-role], #root [data-open], #root [data-preview-row]')) {
    const style = getComputedStyle(el)
    if (el.tagName !== 'BUTTON' && style.cursor !== 'pointer') continue
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue
    if (el.closest('[aria-hidden="true"]')) continue
    if (el.closest('[inert]')) continue
    const b = box(el)
    if (b.w < 2 || b.h < 2) continue
    const cx = Math.round(b.left + b.w / 2)
    const cy = Math.round(b.top + b.h / 2)
    const hit = document.elementFromPoint(cx, cy)
    if (hit && (el.contains(hit) || hit.contains(el))) continue
    // Under an open drawer, which is the drawer doing its job.
    if (hit?.closest('[data-role="drawer"]') && !el.closest('[data-role="drawer"]')) continue
    /*
      Scrolled out of its own scroller — reachable by scrolling, like any list.

      BOTH AXES, and the second one is not a generalisation for its own sake:
      Home's widget deck is a horizontal pager carrying every domain, so five of
      six domains' controls are legitimately off to the side at any moment. Only
      checking Y reported all of them as untappable, which is the same false
      positive the vertical exemption was written to stop, ninety degrees round.

      A control off the side of a horizontal scroller is reached by swiping to
      it — which is the deck's entire interaction, and is asserted separately by
      the paging captures.
    */
    let inScroller = false
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p)
      const pb = box(p)
      if (o.overflowY === 'auto' || o.overflowY === 'scroll') {
        if (b.bottom > pb.bottom || b.top < pb.top) inScroller = true
        break
      }
      if (o.overflowX === 'auto' || o.overflowX === 'scroll') {
        if (b.right > pb.right + 1 || b.left < pb.left - 1) inScroller = true
        break
      }
    }
    if (inScroller) continue
    unreachable.push({
      at: where(el),
      label: (el.textContent ?? '').trim().slice(0, 24) || el.getAttribute('data-role') || el.tagName.toLowerCase(),
      why: (cx < 0 || cy < 0 || cx > shellW || cy > box(shell).bottom) ? 'off-screen' : `covered by ${hit ? where(hit) : 'nothing'}`,
    })
  }

  /**
   * HOME'S OWN GEOMETRY.
   *
   * Four lanes, their exact Y positions, how many cards each is showing, and
   * what shape its pager took. Every acceptance criterion in the four-lane
   * contract is a statement about one of these numbers.
   */
  const decks = [...document.querySelectorAll('[data-deck]')].map((el) => ({
    label: el.getAttribute('data-deck'),
    top: Math.round(box(el).top),
    h: Math.round(box(el).h),
    // Exactly one card may be in the slot. The deck renders three (prev,
    // current, next) and marks only the current one.
    cards: el.querySelectorAll('[data-card]').length,
    empty: el.getAttribute('data-empty') === 'yes',
  }))

  /*
    THE DECK'S OWN READOUT, MEASURED RATHER THAN ASSUMED.

    `deckSnapped` counts widgets whose box is fully inside the deck's viewport,
    which is the rendered answer to "is exactly one domain on screen" — a
    question a scroll offset cannot answer once the slide width is measured
    rather than constant.

    `deckDotsInteractive` is the inertness assertion: a handler or a pointer
    cursor on a dot is the launcher arriving by increments.
  */
  const deckEl = document.querySelector('[data-role="deck"]')
  const dotsEl = document.querySelector('[data-role="deck-dots"]')
  const deckDots = dotsEl ? dotsEl.children.length : 0
  const deckDotsInteractive = !!dotsEl && [...dotsEl.children].some(
    (d) => getComputedStyle(d).cursor === 'pointer' || d.onclick || d.hasAttribute('role'),
  )
  /*
    MEASURED AGAINST THE SLIDES, NOT THE DECK'S DIRECT CHILDREN.

    This counted `deckEl.children`, which was the slide list while the deck was
    a native scroll-snap scroller with every domain laid out in a row. It is now
    a transform-driven pager — one child, the track, carrying prev/current/next —
    so the old form counted the track, found it translated a full slide left, and
    reported zero domains on screen for a deck that was displaying one correctly.

    A measurement that names the thing it is about survives the layout changing
    under it, which is the whole reason this harness measures the DOM rather than
    reading source: `[data-card]` is the marker for "the domain in the slot", and
    that has not changed.
  */
  let deckSnapped = 0
  if (deckEl) {
    const vp = deckEl.getBoundingClientRect()
    for (const slide of deckEl.querySelectorAll('[data-card]')) {
      const r = slide.getBoundingClientRect()
      if (r.left >= vp.left - 1 && r.right <= vp.right + 1) deckSnapped++
    }
  }

  /**
   * HOW MANY DOMAINS THE DECK SAYS IT HOLDS.
   *
   * Read off the deck's own accessible name ("Domains. Mail, 2 of 6."), because
   * a paging deck no longer mounts them all and the count therefore cannot be
   * taken from the DOM by counting cards. This is the same number a screen
   * reader is told, so asserting the dots against it is asserting that the two
   * readouts of the deck's size agree — which is what the dots-vs-cards check
   * was really for.
   */
  const deckTotal = (() => {
    const m = /(\d+)\s+of\s+(\d+)/.exec(deckEl?.getAttribute('aria-label') ?? '')
    return m ? Number(m[2]) : null
  })()

  const pagers = [...document.querySelectorAll('[data-pager]')].map((el) => ({
    label: el.getAttribute('data-pager'),
    dots: el.querySelectorAll('[aria-current]').length,
    text: (el.textContent ?? '').trim(),
  }))

  /**
   * ═══ THE HOME CONTRACT, MEASURED IN THE BROWSER ═══
   *
   * Everything below was previously either unasserted or asserted by reading
   * source files, and a source grep cannot answer any of these questions. The
   * scrollbar in the regression screenshot came from `overflow-y:auto` on ONE
   * component; the next one could equally come from a shared card primitive, an
   * inherited style, or a `-webkit-line-clamp` box that grew. Only the rendered
   * DOM knows.
   */

  /**
   * EVERY VERTICALLY SCROLLABLE NODE INSIDE HOME.
   *
   * The expected count is ZERO, including the Home root — Home does not scroll
   * at all, its bands are fixed and its cards clip. Descendants as well as card
   * roots, because the whole point is that the offender might be inherited from
   * somewhere nobody thought to look.
   *
   * A node counts when it BOTH declares a scrolling overflow AND has somewhere
   * to scroll to. Declaring `auto` on a box whose content fits is harmless
   * today and is a scrollbar the moment the content grows, so it is reported
   * either way — `travel` distinguishes them in the message.
   */
  const homeEl = document.querySelector('[data-frame="home"]')
  const homeScrollers = []
  if (homeEl) {
    for (const el of [homeEl, ...homeEl.querySelectorAll('*')]) {
      const s = getComputedStyle(el)
      if (s.display === 'none' || s.visibility === 'hidden') continue
      const flow = s.overflowY
      const travel = el.scrollHeight - el.clientHeight
      if (flow !== 'auto' && flow !== 'scroll') continue
      homeScrollers.push({ at: where(el), overflowY: flow, travel: Math.round(travel) })
    }
  }

  /**
   * EVERY HOME CARD'S REAL BOX, AND WHETHER ITS CONTENT FITS IT.
   *
   * `scrollHeight <= clientHeight + 1` is the actual rule the contract states.
   * Measured on the card root AND on every descendant, because a card that
   * clips cleanly at its own edge can still contain an inner box whose content
   * overflows — which is what a shared primitive quietly turning on `auto`
   * would look like from the outside.
   */
  const homeCards = [...document.querySelectorAll('[data-frame="home"] [data-card]')].map((slot) => {
    const card = slot.firstElementChild ?? slot
    const b = box(card)
    let worst = 0
    let worstAt = null
    for (const el of [card, ...card.querySelectorAll('*')]) {
      /*
        A DECLARED CLAMP IS NOT AN OVERFLOW.

        `-webkit-line-clamp` and `text-overflow:ellipsis` are the SANCTIONED
        response to long content — rungs 4 and 5 of the overflow ladder — and
        both work by leaving `scrollHeight` past `clientHeight` on purpose. A
        naive comparison therefore reports the fix as the bug: it flagged a
        two-line reason that was clamping exactly as designed.

        What is still asserted, and is the thing that matters, is the CARD's own
        box: a card whose content does not fit is a card that would have needed
        a scrollbar, whatever its children declared.
      */
      const s = getComputedStyle(el)
      if (el !== card && (s.webkitLineClamp !== 'none' || s.textOverflow === 'ellipsis')) continue
      const over = el.scrollHeight - el.clientHeight
      if (over > worst) { worst = over; worstAt = where(el) }
    }
    return {
      id: slot.getAttribute('data-card'),
      deck: slot.closest('[data-deck]')?.getAttribute('data-deck') ?? null,
      h: Math.round(b.h),
      overflowY: getComputedStyle(card).overflowY,
      overBy: Math.round(worst),
      overAt: worstAt,
    }
  })

  /**
   * CRITICAL CONTENT IS FULLY INSIDE ITS CARD.
   *
   * The rule the reduction ladder exists to keep, and the one a height
   * assertion cannot see: a card can be exactly its tier and still have the
   * question's last line under the clip. Anything marked `data-critical` is
   * measured against its own card's box directly.
   */
  const clipped = []
  for (const el of document.querySelectorAll('[data-frame="home"] [data-critical]')) {
    let clipBox = null
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (getComputedStyle(p).overflow !== 'visible') { clipBox = p; break }
    }
    if (!clipBox) continue
    const b = box(el)
    const f = box(clipBox)
    const over = Math.max(b.bottom - f.bottom, f.top - b.top)
    if (over > 1) {
      clipped.push({
        what: el.getAttribute('data-critical'),
        by: Math.round(over),
        text: (el.textContent ?? '').trim().slice(0, 40),
      })
    }
  }

  /**
   * A PERMANENT APPLICATION LAUNCHER, IF ONE HAS COME BACK.
   *
   * Looked for by SHAPE rather than by the selector the deleted component used,
   * because the failure mode the rule guards against is precisely someone
   * rebuilding it under another name. A row of three or more same-height
   * sibling controls, each naming a system application, sitting inside Home
   * outside any card, is a launcher whatever its markup says.
   */
  const APPS = ['calendar', 'mail', 'places', 'map', 'video', 'fitness', 'steps', 'watch']
  const launchers = []
  if (homeEl) {
    for (const row of homeEl.querySelectorAll('div, nav, ul')) {
      if (row.closest('[data-card]')) continue
      const kids = [...row.children].filter((c) => box(c).w > 8 && box(c).h > 8)
      if (kids.length < 3) continue
      const named = kids.filter((c) => {
        const t = (c.textContent ?? '').trim().toLowerCase()
        return t.length > 0 && t.length < 12 && APPS.some((a) => a.startsWith(t) || t.startsWith(a.slice(0, 3)))
      })
      if (named.length >= 3) {
        launchers.push({ at: where(row), tiles: named.length, labels: named.map((c) => (c.textContent ?? '').trim()).slice(0, 8) })
      }
    }
  }

  /**
   * THE QUESTION CARD, since it is the one the regression was in.
   *
   * Answers are hit-tested rather than counted, because "the button is in the
   * DOM" was true in the screenshot too — it was below the fold of a scrolling
   * card, which is the same class of failure as being off the right edge of the
   * phone. See the `unreachable` check above; this is the same question asked
   * of the one control set that matters most.
   */
  /*
    THE VISIBLE ONE. A deck renders three slots — previous, current and next —
    and marks the off-screen pair `aria-hidden`, so the first match in document
    order is the card a full screen to the LEFT. Measuring that one reported
    five unhittable answers on a card that was completely correct: the harness
    was hit-testing a card nobody can see. Scoped to the marked slot, which is
    the same definition every other check in this file uses.
  */
  const qEl = document.querySelector('[data-card] [data-role="question"]')
  const questionCard = qEl
    ? (() => {
        const answers = [...qEl.querySelectorAll('[data-answer]')]
        const unreachableAnswers = answers.filter((el) => {
          const b = box(el)
          if (b.w < 2 || b.h < 2) return true
          const hit = document.elementFromPoint(Math.round(b.left + b.w / 2), Math.round(b.top + b.h / 2))
          return !(hit && (el.contains(hit) || hit.contains(el)))
        }).length
        return {
          h: Math.round(box(qEl).h),
          overflowY: getComputedStyle(qEl).overflowY,
          questionText: (qEl.querySelector('[data-role="question-text"]')?.textContent ?? '').trim().slice(0, 90),
          answers: answers.length,
          unreachableAnswers,
        }
      })()
    : null

  /** The one line an entirely quiet Home draws instead of three empty bands. */
  const quietLine = (document.querySelector('[data-role="home-quiet"]')?.textContent ?? '').trim() || null

  const chatPanel = document.querySelector('[data-frame="chat"]')
  const scrim = document.querySelector('[data-role="chat-scrim"]')
  /** Any part of Home, for the `inert` check when chat takes the foreground. */
  const homeLane = document.querySelector('[data-frame="home"] [data-deck]')

  /**
   * WHAT THE LANES LEAVE UNUSED.
   *
   * The dead centre was invisible to every assertion here because each one asked
   * about a lane on its own, and every lane was individually correct. The bug
   * lived in the SUM: four lanes adding up to less than Home, and a `flex:1`
   * spacer holding the difference. So this measures the difference directly —
   * from the top of Home to the bottom of the last lane's pager, against the
   * content box the composer's reserve leaves behind.
   */
  const home = document.querySelector('[data-frame="home"]')
  /*
    THE BANDS AND THE STRIP TOGETHER.

    The strip sits BELOW the last band, so measuring slack from the last
    `[data-deck]` would report the strip's own height as unallocated space and
    fail a screen that is exactly right. What fills Home is every band plus the
    launcher.
  */
  const laneEls = [...document.querySelectorAll('[data-deck]')]
  const last = laneEls[laneEls.length - 1]
  const lastPager = last?.parentElement === home ? last : null
  let fill = null
  if (home && laneEls.length) {
    const hb = box(home)
    const cs = getComputedStyle(home)
    const reserve = Math.round(parseFloat(cs.paddingBottom) || 0)
    /*
      The status row is ALLOCATED SPACE, not slack.

      It used to be `position:absolute` over the bottom of the last lane, which
      is why dismissing a card printed "undo" across the card underneath it. It
      is a real row now, and a real row is part of what Home spends its height
      on — measuring against the bottom of the content box instead would report
      its 20px as unallocated and fail a screen that is correct.
    */
    const statusRow = document.querySelector('[data-role="home-status"]')
    const statusH = statusRow ? Math.round(statusRow.getBoundingClientRect().height) : 0
    const contentBottom = hb.bottom - reserve - statusH
    // The deck element already includes its pager row, so its own bottom is the
    // bottom of the lane.
    const laneBottom = box(lastPager ?? laneEls[laneEls.length - 1]).bottom
    fill = { slack: Math.round(contentBottom - laneBottom), reserve }
  }

  // Vertical gap between consecutive lanes. Anything beyond the design token is
  // a lane that stopped short of its allocation.
  const gaps = laneEls.slice(1).map((el, i) => Math.round(box(el).top - box(laneEls[i]).bottom))

  // The Home this replaced, in selector form. None of it may coexist with the
  // lanes — "the taxonomy became the renderer" is only true if the old renderer
  // is gone rather than layered under it.
  const legacy = ['[data-rail]', '[data-role="briefing"]', '[data-role="priority"]', '[data-role="quiet"]', '[data-role="pane-strip"]']
    .filter((sel) => document.querySelector(sel))

  /**
   * IS THERE A SCREEN AT ALL?
   *
   * The assertion that would have caught the blank viewport, and the one thing
   * nothing here asked. Every other check is conditional on something being
   * mounted — no Home means no lane checks, no surface means no containment
   * checks — so an app that rendered NOTHING passed every one of them
   * vacuously. `painted` counts nodes with real area inside the root, which on
   * the blank capture was 4: two background gradients and their containers.
   */
  const painted = [...document.querySelectorAll('#root *')].filter((el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 40 || r.height < 20) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'
  }).length

  /**
   * THE LEFT EDGE, MEASURED.
   *
   * Five components each inset their content by a slightly different amount —
   * 16, 18, 20, 18+4 — which is the worst possible spread: too small to read as
   * deliberate, too large to look like a straight line. It showed up in the
   * screenshots as text drifting horizontally between Home, an opened app and
   * Settings, and no component was wrong on its own. So the edges are measured
   * as a SET, and what is asserted is that they agree.
   */
  const edges = [...document.querySelectorAll(
    '[data-edge], [data-deck] [data-card], [data-frame="composer"], [data-role="settings-scroll"]',
  )].flatMap((el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 120 || r.height < 8) return []
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none') return []
    // The CONTENT edge, not the box edge — a padded container and a flush one
    // are supposed to put their text in the same column.
    return [Math.round(r.left + (parseFloat(s.paddingLeft) || 0))]
  })

  /**
   * DEAD SPACE, measured region by region.
   *
   * The complaint was "interfacing with chat reveals several inches of black
   * unusable space", and it was structural: the workspace gave the surface a
   * fixed 55% and chat a fixed 35% whatever either contained, so a two-message
   * thread left 168–203px of nothing between the last bubble and the composer.
   * Every existing assertion passed, because each region was individually the
   * size it had been told to be.
   *
   * So: for each region, how far down does it actually paint?
   */
  const unused = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const top = el.getBoundingClientRect().top
    let painted = 0
    for (const child of el.querySelectorAll('*')) {
      const r = child.getBoundingClientRect()
      if (r.width > 20 && r.height > 6) painted = Math.max(painted, r.bottom - top)
    }
    return Math.round(el.getBoundingClientRect().height - painted)
  }

  /** Cards that project real content vs. cards that are a title and a sentence. */
  const previews = document.querySelectorAll('[data-preview]').length
  const previewRows = document.querySelectorAll('[data-preview] [data-preview-row]').length

  const settings = document.querySelector('[data-frame="settings"]')
  const active = document.activeElement
  const editable = !!active && (
    active.tagName === 'INPUT' ||
    active.tagName === 'TEXTAREA' ||
    active.isContentEditable === true
  )

  return {
    window: { w: window.innerWidth, h: window.innerHeight },
    decks,
    deckDots,
    deckDotsInteractive,
    deckSnapped,
    deckTotal,
    homeScrollers,
    homeCards,
    clipped,
    launchers,
    questionCard,
    quietLine,
    /** The declared empty states currently mounted — see `emptyStateOf`. */
    emptyStates: [...document.querySelectorAll('[data-empty-state]')]
      .map((el) => el.getAttribute('data-empty-state')).filter(Boolean),
    /** Set by the harness when a text scale is being emulated. */
    rootFontPx: Math.round(parseFloat(getComputedStyle(document.documentElement).fontSize) || 16),
    fill,
    gaps,
    legacy,
    painted,
    unusedSurface: unused('[data-frame="surface"]'),
    unusedChat: unused('[data-frame="chat"]'),
    previews,
    previewRows,
    edges: [...new Set(edges)].sort((a, b) => a - b),
    text: (document.body.innerText ?? '').trim().length,
    homeOpen: !!home,
    settingsOpen: !!settings,
    settingsRect: settings ? box(settings) : null,
    settingsScroller: !!document.querySelector('[data-role="settings-scroll"]'),
    /** What the focus is actually ON — the keyboard's cause, not its symptom. */
    activeElement: active ? active.tagName.toLowerCase() : null,
    editableFocused: editable,
    /** Which domain renderer mounted. Published by the widget dispatcher. */
    renderers: [...document.querySelectorAll('[data-renderer]')]
      .map((el) => el.getAttribute('data-renderer'))
      .filter(Boolean),
    focus: [...document.querySelectorAll('[data-surface]')]
      .map((el) => el.getAttribute('data-focus'))
      .find(Boolean) ?? null,
    surfaceTitle: (document.querySelector('[data-role="surface-title"]')?.textContent ?? '').trim(),
    pagers,
    snap: chatPanel?.getAttribute('data-snap') ?? null,
    scrim: !!scrim,
    interrupt: !!document.querySelector('[data-frame="interrupt"]'),
    // `inert` is the accessibility half of foreground ownership. An ancestor
    // carrying it makes everything below unreachable, which is the point.
    homeInert: !!homeLane?.closest('[inert]'),
    surfaceOpen: !!document.querySelector('[data-frame="surface"]'),
    /** A bounded recovery screen still counts as having a screen. */
    recovered: !!document.querySelector('[data-frame="recovered"]'),
    doc: { scrollH: document.documentElement.scrollHeight, clientH: document.documentElement.clientHeight },
    shell: shell ? box(shell) : null,
    frame: frame ? box(frame) : null,
    chat: chat ? box(chat) : null,
    composer: composer ? box(composer) : null,
    // Only the deepest escaping nodes matter; a parent escapes because a child does.
    escapes: escapes.slice(0, 6),
    wide: wide.slice(0, 6),
    unreachable: unreachable.slice(0, 6),
  }
}

function check(name, m, wants) {
  const bad = []

  /*
    0. THERE IS ALWAYS A SCREEN.

    Asserted before anything else and on EVERY capture, because it is the one
    the whole gate was missing: with nothing mounted, every other check below
    passes vacuously — no Home to measure, no surface to contain, no lanes to
    compare. 37/37 was true of an app that could render an empty document.

    Home, a domain workspace, Settings, or a bounded recovery screen. Never
    none of them.
  */
  if (m.painted < 8 || m.text < 2) {
    bad.push(`the app rendered nothing (${m.painted} painted nodes, ${m.text} chars of text) — this is the blank screen`)
  }
  if (!m.homeOpen && !m.surfaceOpen && !m.settingsOpen && !m.recovered) {
    bad.push('no workspace is mounted: Home is gone and nothing replaced it')
  }

  // 1. The document never scrolls. Every scroller is a region inside the app.
  if (m.doc.scrollH > m.doc.clientH + 1) {
    bad.push(`page scrolls vertically (${m.doc.scrollH} > ${m.doc.clientH})`)
  }

  /*
    1b. ONE LEFT EDGE.

    Content edges are compared as a set rather than against a constant: what
    was wrong was never a particular number, it was five numbers within four
    pixels of each other. Two distinct edges are allowed — a page inset and a
    card's inner inset are genuinely different things — and anything beyond
    that is components inventing their own margins again.
  */
  {
    /*
      Negative edges are DECK SLIDES PARKED OFF TO THE LEFT, not a component
      inventing a margin. The deck is a horizontal scroller carrying every
      domain, so at any moment five of six slides are outside the viewport and
      their left edges are meaningless as insets — measuring them made "one left
      edge" report three edges on a screen with two.
    */
    const near = m.edges.filter((x) => x >= 0 && x < 60)
    if (near.length > 2) {
      bad.push(`content starts at ${near.length} different left edges (${near.join(', ')}px) — no shared inset`)
    }
  }

  /*
    2. THE APP IS THE WINDOW — with a keyboard up or down, identically.

    This used to read `shell.h === window.h - keyboard`, i.e. the shell was
    expected to shrink for the keyboard. It does not any more, and the change is
    the point rather than an accommodation: a shell that resizes for the
    keyboard makes every resting number a function of what has focus, which is
    how a reserve came to outlive its keyboard. The keyboard raises the composer
    (rule 3) and touches nothing else.

    `scripts/geometry.mjs` carries the full version of this contract across five
    simulated iOS environments, including the notch and the home indicator that
    Chromium does not have. This is the one-window version of it.
  */
  if (m.shell && Math.abs(m.shell.h - m.doc.clientH) > 1) {
    bad.push(`shell is ${Math.round(m.shell.h)}px in a ${m.doc.clientH}px window`)
  }

  // 3. The composer sits at the bottom. With a keyboard up it sits at the top
  //    of the keyboard, not behind it and not floating above it.
  if (m.composer) {
    const floor = m.doc.clientH - wants.keyboard
    const gap = floor - m.composer.bottom
    if (gap > 40) bad.push(`composer floats ${Math.round(gap)}px above ${wants.keyboard ? 'the keyboard' : 'the bottom'}`)
    if (gap < -1) bad.push(`composer is ${Math.round(-gap)}px below ${wants.keyboard ? 'the top of the keyboard' : 'the usable window'}`)
  }

  /*
    4. THE UNIVERSAL FIT RULE.

    Both halves run on EVERY capture, which is the change that matters: these
    were gated behind `surface: true`, so Home, Settings and the chat overlay
    were never asked whether their contents fitted. Nothing outside the device;
    nothing stranded inside any box that declared itself bounded.
  */
  /*
    NOTHING WIDER THAN THE PHONE, AND EVERY CONTROL TAPPABLE.

    The two assertions that were missing when the app became impossible to
    leave. See MEASURE for what each one is about and why the existing
    stranded-content check could not stand in for them.
  */
  if (m.wide?.length) {
    bad.push(`${m.wide.length} node(s) wider than the phone: ` +
      m.wide.map((e) => `${e.at} is ${e.w}px, ${e.over}px past the shell`).join(', '))
  }
  if (m.unreachable?.length) {
    bad.push(`${m.unreachable.length} control(s) cannot be tapped where they are drawn: ` +
      m.unreachable.map((e) => `${e.at} "${e.label}" ${e.why}`).join(', '))
  }

  if (m.escapes.length) {
    bad.push(`${m.escapes.length} node(s) stranded outside their box: ` +
      m.escapes.map((e) => `${e.tag}${e.role ? `[${e.role}]` : ''} escapes ${e.box} by ${e.over}px`).join(', '))
  }

  // 5. Surface content never overlaps the chat region.
  if (wants.surface && m.frame && m.chat && m.frame.bottom > m.chat.top + 1) {
    bad.push(`surface overlaps chat by ${Math.round(m.frame.bottom - m.chat.top)}px`)
  }

  // 6. A surface must actually get the majority of its own frame.
  if (wants.surface && m.frame && m.frame.h < 140) {
    bad.push(`surface frame collapsed to ${Math.round(m.frame.h)}px`)
  }

  /*
    6b. NO DEAD BAND ABOVE THE COMPOSER.

    "Interfacing with chat reveals several inches of black unusable space" —
    and it did: the workspace handed chat a fixed 35% whatever it held, so a
    two-message thread left 168–203px of nothing between the last bubble and
    the composer. Every check here passed, because the region was exactly the
    size it had been told to be. So the question is no longer "is the region
    the right size" but "is any of it doing nothing".
  */
  if (wants.surface && m.unusedChat !== null && m.unusedChat > 48) {
    bad.push(`${m.unusedChat}px of the chat region is empty — dead space above the composer`)
  }

  /*
    ═══ THE HOME CONTRACT ═══

    These run on EVERY capture that has a Home on screen, not only on the ones
    someone flagged `lanes: true`. That distinction is how the scrollable
    question card shipped: it was a property of one card kind, and the captures
    that would have shown it were the ones nobody had written.

    Each is one of the binary rules in docs/ui-contract.md.
  */
  if (m.homeOpen) {
    // H1. NO CARD, AND NO PART OF HOME, SCROLLS VERTICALLY.
    for (const s of m.homeScrollers) {
      bad.push(
        `${s.at} declares overflow-y:${s.overflowY} inside Home` +
        (s.travel > 0 ? ` and has ${s.travel}px of travel — this is the scrollbar` : ' — a scrollbar waiting for longer content'),
      )
    }

    // H2. NO CARD OVERFLOWS ITS OWN BOX, AT ANY DEPTH.
    for (const c of m.homeCards) {
      if (c.overBy > 1) {
        bad.push(`card '${c.id}' in '${c.deck}': ${c.overAt} overflows its box by ${c.overBy}px`)
      }
      // H3. NO SLOT EXCEEDS ITS HEIGHT. Content adapts to geometry, never back.
      const want = SLOT_H[c.deck]
      if (want && c.h > want + 1) {
        bad.push(`the '${c.deck}' slot is ${c.h}px, past its ${want}px`)
      }
    }

    // H4. NO CRITICAL CONTENT IS CLIPPED — at any text size.
    for (const c of m.clipped) {
      bad.push(`the ${c.what} is cut off by ${c.by}px ("${c.text}…") — critical content may not be clipped`)
    }

    // H5. NO PERMANENT APPLICATION LAUNCHER, IN ANY SHAPE.
    for (const l of m.launchers) {
      bad.push(`a permanent app launcher is on Home at ${l.at}: [${l.labels.join(', ')}]`)
    }

    /*
      H6. THE TEXT SIZE WAS ACTUALLY APPLIED.

      Without this the accessibility captures are the default captures with a
      different name — which is the failure mode of every "we tested at large
      text" claim. If the root size did not move, the emulation did not happen
      and everything H1–H5 just asserted was asserted at 16px.
    */
    if (wants.textScale > 1) {
      const want = Math.round(16 * wants.textScale)
      if (Math.abs(m.rootFontPx - want) > 1) {
        bad.push(`text scale ${wants.textScale} was requested but the root font is ${m.rootFontPx}px — this capture is not testing large text`)
      }
    }
  }

  /*
    H7. A QUESTION IS FULLY LEGIBLE AND FULLY ANSWERABLE, WHERE IT IS ASKED.

    The rule the regression screenshot broke in three separate ways at once: the
    question was cut off, the answers were below the fold, and the card had
    grown a scrollbar to cope. The clipping half is covered by H4 above; this is
    the half about the card existing and carrying its controls at all.
  */
  if (wants.question) {
    if (!m.questionCard) bad.push('no question card rendered — this capture is not testing the question')
    else {
      const q = m.questionCard
      if (!q.questionText) bad.push('the question card drew no question text')
      if (q.answers < 1) bad.push('the question card offered no answers — a question that cannot be answered where it is asked')
      if (q.answers > 5) bad.push(`the question card offered ${q.answers} answers (4 typed + "Something else…" is the maximum)`)
      if (q.unreachableAnswers) bad.push(`${q.unreachableAnswers} answer(s) on the question card cannot be hit-tested`)
    }
  }

  /*
    H8. A QUIET MORNING IS ONE LINE.

    Not three bordered rectangles saying "Nothing needs you", "Nothing coming
    up" and "Nothing to note", which is the app filing its own taxonomy on his
    home screen and is what the screenshot showed.
  */
  if (wants.quiet) {
    if (!m.quietLine) bad.push('an entirely quiet Home drew no status line at all')
    /*
      Restated for the deck. "Three bordered rectangles saying Nothing needs
      you" was the failure; the deck's version of it would be six widgets each
      saying their domain is quiet. With nothing connected there is nothing to
      put in the deck, so there is no deck — one line, and glass.
    */
    for (const d of m.decks) {
      if (d.h > 1) bad.push(`an entirely quiet Home still drew the '${d.label}' slot at ${d.h}px — it collapses to one line`)
    }
    if (m.launchers.length) bad.push('an entirely quiet Home still drew a launcher')
  }

  /*
    H9. NO BLANK DESTINATION, FOR ANY CARD ON THE SCREEN.
  */
  if (wants.destinations) {
    for (const d of wants.destinations) {
      if (d.verdict === 'blank') {
        bad.push(`tapping '${d.id}' opened a surface with ${d.painted} painted nodes and ${d.text} chars and NO declared empty state — this is the blank pane`)
      }
      if (d.verdict === 'gone') bad.push(`tapping '${d.id}' left neither Home nor a surface on screen`)
      if (d.verdict === 'unreachable') bad.push(`card '${d.id}' could not be hit-tested on Home`)
    }
    if (!wants.destinations.length) bad.push('the blank-destination sweep found no cards to tap')
  }

  // ── the three-band Home contract ──────────────────────────────────────────

  if (wants.lanes) {
    const labels = m.decks.map((d) => d.label).join(',')
    /*
      7. ALL THREE BANDS, ALWAYS, IN ORDER.

      A band does not disappear because it is empty — that is what makes the Y
      positions facts, and it is also the thing that makes an empty `now` read
      as good news rather than as a missing rail.

      The names changed with the redesign and the change is the point: the lanes
      used to be `apps,saved,tasks,insights`, which is where things CAME FROM.
      These are how much of his attention something deserves.
    */
    /*
      7. THE THREE SLOTS, IN ORDER, AND THE DECK IS ALWAYS ONE OF THEM.

      The old rule here was `bands are [now,next,background]`. The bands are
      gone; the slots that replaced them are fixed in the same way and for the
      same reason — the Y positions are facts, so nothing below a slot moves
      when that slot's content changes.

      Slot two is whichever of `question` / `relevance` won it, and slot three is
      `intelligence`. Both lower slots may be ABSENT, which is the one thing the
      band rule did not allow and this one must: an empty slot is a quiet day,
      and drawing a placeholder there is what "empty attention collapses" exists
      to forbid.
    */
    const order = m.decks.map((d) => d.label)
    if (order[0] !== 'widgets') {
      bad.push(`the first slot is '${order[0] ?? 'nothing'}', expected the widget deck`)
    }
    for (const label of order) {
      if (!SLOT_H[label]) bad.push(`unknown Home slot '${label}' — the three slots are fixed`)
    }
    if (order.filter((l) => l === 'intelligence').length > 1) {
      bad.push('more than one intelligence slot is on Home')
    }

    /*
      8. THE DECK CARRIES EVERY DOMAIN, AND SHOWS EXACTLY ONE.

      Both halves matter and they pull in opposite directions, which is why they
      are asserted together. Ranking must not remove a domain — that was the
      whole complaint against the bands, where an app with nothing urgent to say
      ceased to exist — so every widget is in the DOM. And only one may be
      readable at a time, or the deck is a scrolling list of cards rather than a
      page you are on.
    */
    /*
      RESTATED FOR A PAGING DECK, WITH BOTH HALVES INTACT.

      The deck used to mount every domain side by side, so "carries every domain"
      could be counted directly and compared with the dots. It pages now — three
      slides, wrapping — so the count lives in the deck's own accessible name and
      the comparison is between the app's TWO readouts of its size: the dots he
      sees and the "n" a screen reader is told. A deck that disagreed with its own
      readout is exactly what this always existed to catch, and it still does.

      "Ranking must not remove a domain" is not weakened by the change: what
      enforces it is that `buildDeck` takes every enabled source, and what proves
      it at runtime is the id sweep below, which opens every domain by paging the
      deck to it — a domain that had been dropped could not be reached at all.
    */
    const deck = m.decks.find((d) => d.label === 'widgets')
    if (deck) {
      if (deck.cards < 1) bad.push('the widget deck is empty')
      if (deck.cards > 1) {
        bad.push(`${deck.cards} domains are marked current in the deck, expected exactly 1`)
      }
      if (m.deckTotal === null) {
        bad.push('the deck does not say how many domains it holds')
      } else if (m.deckDots !== m.deckTotal) {
        bad.push(`the deck says it holds ${m.deckTotal} domains and draws ${m.deckDots} position dots — the readout disagrees with the deck`)
      }
      if (m.deckSnapped !== 1) {
        bad.push(`${m.deckSnapped} widgets are fully on screen, expected exactly 1`)
      }
    }

    /*
      8b. THE DOTS ARE A READOUT AND NOT A CONTROL.

      An explicit rule because it is the one that will be broken by accident:
      the obvious "improvement" to a row of position dots is to make them
      tappable, and that is a permanent six-target launcher arriving one commit
      at a time. Authorised as inert; asserted as inert.
    */
    if (m.deckDotsInteractive) {
      bad.push('the deck position dots are interactive — they are a readout, not a launcher')
    }

    /*
      9. A SLOT IS ITS HEIGHT, OR IT IS NOT THERE.

      The empty-band rule, restated for a layout with no bands: absent means
      absent. There is no collapsed-but-present state to be got wrong, so this
      only has to catch a slot that has GROWN.
    */
    for (const d of m.decks) {
      const want = SLOT_H[d.label]
      if (want && d.h > want + 1) bad.push(`the '${d.label}' slot is ${d.h}px, past its ${want}px`)
    }
    /*
      9b. CONTENT MAY NOT OVERRUN HOME. IT MAY LEAVE SPACE.

      Unchanged, and it matters more now: with two slots allowed to be absent, a
      quiet Home is mostly empty glass, and that is the product working rather
      than a layout to fill.
    */
    if (m.fill && m.fill.slack < -1) {
      bad.push(`the slots overrun Home's content area by ${-m.fill.slack}px`)
    }
    // 9c. No unexplained gap between slots either.
    for (const [i, g] of m.gaps.entries()) {
      if (g > LANE_GAP + 1) bad.push(`gap of ${g}px between slot ${i + 1} and ${i + 2}, token is ${LANE_GAP}px`)
    }
    // 9d. No legacy Home composition alongside the lanes.
    if (m.legacy.length) bad.push(`old Home blocks still render: ${m.legacy.join(', ')}`)

    /*
      9e. THE CARDS SHOW SOMETHING.

      Home was four titles and four sentences on a black field — every fact
      correct, none of it usable, and two thirds of every card empty. A card is
      a projection of a canonical object, so with real objects behind it there
      have to be real rows on it. Geometry assertions cannot see this: an empty
      card and a full one are exactly the same rectangle.
    */
    if (wants.projects) {
      if (m.previews < wants.projects) {
        bad.push(`only ${m.previews} card(s) project their contents, expected ${wants.projects} — Home is titles on a black field`)
      }
      /*
        `projects + 2` RATHER THAN `projects * 2`.

        Not a weakened assertion — a corrected one. The bands are tiers now
        (224/168/112) instead of whatever the device allowed (274/201/171), so
        the `background` card genuinely has room for fewer preview rows than it
        used to. What this check is FOR is "Home is not titles on a black
        field", and that is answered by every card projecting something and the
        total being more than one row apiece. Holding the old number would have
        been asserting a card size rather than the property.
      */
      if (m.previewRows < wants.projects + 2) {
        bad.push(`cards drew ${m.previewRows} content rows between them — the previews are empty`)
      }
    }
  }

  // 10. Twenty cards may not become twenty dots.
  if (wants.pager === 'numeric') {
    const big = m.pagers.find((p) => p.dots > 0 && /\d+ \/ \d+/.test(p.text) === false && p.dots > 5)
    if (big) bad.push(`pager '${big.label}' drew ${big.dots} dots instead of a numeric position`)
    if (!m.pagers.some((p) => /\d+ \/ \d+/.test(p.text))) {
      bad.push('no lane fell back to a numeric pager despite twenty objects')
    }
  }

  // ── chat overlay ──────────────────────────────────────────────────────────

  if (wants.chat) {
    if (m.snap !== wants.chat) bad.push(`chat is '${m.snap}', expected '${wants.chat}'`)
    // Foreground ownership, both halves: the scrim for the finger, `inert` for
    // assistive technology. Neither alone is the rule.
    if (wants.chat !== 'collapsed') {
      if (!m.scrim) bad.push('chat is open with no scrim over Home')
      if (!m.homeInert) bad.push('chat is open but Home is still reachable (not inert)')
    }
  }

  // 11. A tap behind the glass collapses chat and does NOTHING else. If it had
  //     also activated the card underneath, a surface would be open here.
  if (wants.stillHome && m.surfaceOpen) {
    bad.push('a tap on the chat scrim also activated the card underneath')
  }

  // 12. A critical interrupt reaches him above chat, and Home stays inert.
  if (wants.interrupt) {
    if (!m.interrupt) bad.push('a critical event produced no interrupt layer')
    if (!m.homeInert) bad.push('Home became reachable underneath a critical interrupt')
  }

  // ── card tap → observable transition ──────────────────────────────────────

  /**
   * The acceptance contract for a Home card, in full.
   *
   * Focus, `arriveAt`, routing metadata and reducer state are all explicitly
   * NOT evidence here — the complaint was that every one of those was correct
   * and the screen did not change. So this asks the three questions a person
   * asks: did Home go away, did the application arrive, and is it looking at
   * the thing the card was about.
   */
  if (wants.navigates) {
    if (!m.surfaceOpen) bad.push('tapping the card opened no domain workspace')
    if (m.homeOpen) bad.push('the workspace opened but Home never transitioned out')
    if (wants.navigates.focus && m.focus !== wants.navigates.focus) {
      bad.push(`the card named object '${wants.navigates.focus}' but the surface focused '${m.focus ?? 'nothing'}'`)
    }
    /*
      WHICH RENDERER, not merely "a" renderer.

      "A surface opened" is satisfied by a generic list, which is how a route
      request came to fill a workspace with a bulleted "No route found" and how
      a Calendar card could have opened anything at all. The application is the
      contract: tapping Places mounts the map.
    */
    if (wants.navigates.renders && !m.renderers.includes(wants.navigates.renders)) {
      bad.push(
        `expected the '${wants.navigates.renders}' renderer to be mounted, ` +
        `found [${m.renderers.join(', ') || 'none'}]`,
      )
    }
  }

  // ── settings ──────────────────────────────────────────────────────────────

  if (wants.settings) {
    if (!m.settingsOpen) bad.push('settings did not open')
    if (!m.settingsScroller) bad.push('settings has no bounded internal scroller')
    /*
      THE KEYBOARD BELONGS TO WHOEVER TAPPED A TEXT FIELD.

      Expanding a provider row autofocused a password input, iOS shrank the
      visual viewport by ~340px, and the whole app relaid out around a keyboard
      he never asked for — from a tap on what is, to the hand, a disclosure
      triangle. The cause is observable directly: what has focus.
    */
    if (wants.settings.noKeyboard && m.editableFocused) {
      bad.push(`a provider/model tap focused <${m.activeElement}> — that is what summons the keyboard`)
    }
    // Settings is an application surface and obeys the same rule as the rest:
    // it fills its frame rather than floating in it.
    if (m.settingsRect && m.shell) {
      const slack = m.shell.bottom - m.settingsRect.bottom
      if (slack > 40) bad.push(`settings stops ${Math.round(slack)}px short of the shell`)
    }
  }

  // 13. Acknowledging it gives input back rather than leaving a dead screen.
  if (wants.reachable) {
    if (m.interrupt) bad.push('the interrupt survived being acknowledged')
    if (m.homeInert) bad.push('Home was still inert after the interrupt was dismissed')
  }

  return bad
}

/**
 * Mirrored from src/tokens.ts.
 *
 * THERE IS A TABLE AGAIN, and the reversal is deliberate. The previous comment
 * here argued that pinning heights to constants is what produced the dead
 * centre, and that lane height should therefore be derived from the device. The
 * first half was true; the conclusion was wrong. Filling the phone is not the
 * goal — deciding what deserves pixels is — and device-derived heights meant
 * `now` was 274px on a 6.3" screen, past any tier, with an empty band beside it
 * holding a bordered rectangle of the same order.
 *
 * So: three approved card heights, one hard maximum, and whatever is left over
 * is left over. `SLACK_MAX` is generous on purpose — Home is ALLOWED to be
 * mostly empty, and the only thing worth failing over is content overrunning
 * the box, which is asserted as a negative slack.
 */
/**
 * THE SLOT GEOMETRY, from the Phase 1 design.
 *
 * This replaced `CARD_TIER = { compact: 112, standard: 168, tall: 224 }` when
 * the three attention bands became three fixed slots. The tiers are retired for
 * Home (see docs/ui-contract.md); these four numbers are what Home is now, and
 * they are asserted for the same reason the tiers were: geometry never adapts
 * to content, so a slot that has grown is a slot whose content was not reduced.
 *
 * `question` is deliberately the height of the other two plus their gap — an
 * unanswered question takes both lower slots, because the question and its
 * primary action are on the never-clipped list.
 */
const SLOT_H = { widgets: 340, relevance: 126, intelligence: 170, question: 306 }
const CARD_TIER = { compact: 112, standard: 168, tall: 224 }
const LANE_TIER = { now: 'tall', next: 'standard', background: 'compact' }
const MAX_CARD = CARD_TIER.tall
const LANE_PAGER = 20
const LANE_EMPTY = 22
const LANE_GAP = 10


// ── running it ───────────────────────────────────────────────────────────────

const wait = async (url, ms = 30_000) => {
  const until = Date.now() + ms
  for (;;) {
    try { await fetch(url); return } catch { /* not up yet */ }
    if (Date.now() > until) throw new Error(`nothing answered on ${url}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

const children = []

/**
 * STOP EVERYTHING THIS RUN STARTED — THE WHOLE GROUP, NOT THE WRAPPER.
 *
 * `start` spawns `npx`, which execs `tsx`, which forks `node`. `child.kill()`
 * signals only the FIRST of those, so the actual fixture — the `node` process
 * holding port 3002 — survived every cleanup path this harness had. The next
 * stage of the same `npm test` then found a fixture it did not start, refused
 * to test a ghost, and failed the run. That is not hypothetical: it is what
 * blocked the deploy reconciler, and it cost this session a red suite whose
 * only fault was a leftover socket.
 *
 * `detached: true` makes each child a process-group leader, so a negative pid
 * signals the leader and everything it went on to exec. Both are attempted:
 * the group for the real work, the handle in case the group is already gone.
 *
 * The consequence of `detached` is that these no longer die with the terminal,
 * so this MUST run on every exit path — hence the handlers below rather than a
 * `finally` in one function.
 */
function stopAll(signal = 'SIGKILL') {
  for (const c of children) {
    try { process.kill(-c.pid, signal) } catch { /* group already gone */ }
    try { c.kill(signal) } catch { /* handle already reaped */ }
  }
  children.length = 0
}

process.on('exit', () => stopAll())
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { stopAll(); process.exit(1) })
}

function start(cmd, args, env) {
  const c = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'ignore', detached: true })
  children.push(c)
  return c
}

/**
 * Free a port an ORPHANED fixture server is still holding.
 *
 * Every word of that is load-bearing, and the first version of this function
 * had none of them. It killed everything `lsof` reported on the port, which
 * went wrong in two ways within an hour of being written:
 *
 *   · A socket is INHERITED BY CHILDREN, so `lsof -ti :3002` lists the harness
 *     that spawned the fixture as well as the fixture itself. "Kill everything
 *     on the port" therefore killed the other run's `shots.mjs` outright — the
 *     deploy log recorded `node scripts/shots.mjs  Killed: 9` and blocked the
 *     deploy over it.
 *   · It could not tell a LEFTOVER fixture from one a concurrent run is
 *     legitimately using, so two runs would destroy each other's servers.
 *
 * The orphan test is what makes it safe: a fixture whose parent is gone
 * (reparented to pid 1) is by definition left over from a killed run and owned
 * by nobody. One that still has a living parent belongs to a run in progress
 * and is left completely alone — that run will finish, or fail on its own
 * terms, without this one reaching into it.
 *
 * Best-effort throughout: no `lsof`, nothing listening, or a process that dies
 * between listing and killing are all fine and all mean "carry on".
 */
function freePort(port) {
  let killed = false
  let listeners = []
  try {
    listeners = execSync(`lsof -ti :${port} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().split('\n').filter(Boolean)
  } catch { return }   // nothing listening, or no lsof

  for (const raw of listeners) {
    const pid = Number(raw)
    if (!Number.isInteger(pid) || pid === process.pid) continue
    let ppid = 0
    let command = ''
    try {
      const line = execSync(`ps -o ppid=,command= -p ${pid}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
      ppid = Number(line.split(/\s+/)[0])
      command = line.slice(String(ppid).length).trim()
    } catch { continue }   // gone already

    // Only a fixture server, and only one nobody owns.
    if (!/fixture\.mjs/.test(command)) continue
    if (ppid !== 1) continue

    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    killed = true
  }

  /**
   * AND WAIT FOR THE PORT TO ACTUALLY BE FREE.
   *
   * `kill -9` returns immediately; the socket is released a moment later, by
   * the kernel, on its own schedule. Starting the replacement fixture in that
   * gap means it dies of EADDRINUSE at once — and nothing notices until the
   * harness later fails with ECONNREFUSED and blames the app. That is exactly
   * how this cost a deploy: `'fitness' never opened — the capture fell back to
   * Home`, which is a true statement about a screen with no server behind it.
   *
   * Before this function existed the code simply REUSED the leftover server, so
   * the race did not exist; killing without waiting swapped a stale-data bug for
   * a dead-server one. Both halves are needed.
   */
  if (!killed) return
  const until = Date.now() + 3000
  while (Date.now() < until) {
    try {
      const still = execSync(`lsof -ti :${port} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
      if (!still) return
    } catch { return }   // lsof exits non-zero when nothing is listening
    execSync('sleep 0.1')
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true })

  /**
   * THE FIXTURE SERVER IS ALWAYS OURS. IT IS NEVER REUSED.
   *
   * This used to reuse whatever was already listening, which is a sensible
   * optimisation for a server that reloads its own source and a trap for one
   * that does not. `fixture.mjs` builds its scenarios ONCE at import: a copy
   * left running by an earlier run keeps serving the OLD scenarios, so the
   * suite asserts against data that no longer matches the fixture file. It cost
   * two debugging detours in one evening — both times the code was right and
   * the harness was measuring a ghost.
   *
   * The failure is silent and it lies in the worst direction: it reports a bug
   * in the app that does not exist, and it can equally hide one that does.
   * Killing first is a second of startup against that.
   */
  freePort(FIXTURE)
  // `tsx`, not `node`: the fixture imports the real deck projection so the
  // gate cannot pass against a second copy of it. See scripts/fixture.mjs.
  start('npx', ['tsx', 'scripts/fixture.mjs', '--port', String(FIXTURE)])
  /*
    THE SAME CHECK GEOMETRY MAKES, AND FOR THE SAME REASON.

    A server answering on this port is not evidence that it proxies to this
    suite's fixture. One left behind by an earlier session, aimed at a backend
    that has since died, serves the page and then hangs forever on the API — and
    both harnesses wait for `networkidle`. That is what blocked the deploy
    reconciler, so the fix belongs in both places rather than in the one that
    happened to be caught.
  */
  const serves = async (port) => {
    try {
      const r = await fetch(`http://localhost:${port}/api/providers`, {
        signal: AbortSignal.timeout(2500),
      })
      return r.ok
    } catch { return false }
  }
  const listening = async (port) => fetch(`http://localhost:${port}`, {
    signal: AbortSignal.timeout(2500),
  }).then(() => true).catch(() => false)

  if (!(await serves(PORT))) {
    // Step past a squatter rather than killing it: it may be a sibling run.
    if (await listening(PORT)) {
      for (let p = PORT + 1; p <= PORT + 8; p++) {
        if (!(await listening(p))) { PAGE_PORT = p; break }
      }
      if (PAGE_PORT === PORT) throw new Error(`no free port near ${PORT}`)
      console.log(`port ${PORT} is serving something else — using ${PAGE_PORT}`)
    }
    start('npx', ['vite', '--port', String(PAGE_PORT), '--strictPort'], {
      CRUCIBLE_API_TARGET: `http://localhost:${FIXTURE}`,
    })
  }
  await wait(`http://localhost:${FIXTURE}/api/providers`)
  await wait(BASE_OF())

  const browser = await chromium.launch()
  const results = []

  for (const shot of SHOTS) {
    if (only && !shot.name.includes(only)) continue

    await fetch(`http://localhost:${FIXTURE}/__scenario`, {
      method: 'POST', body: JSON.stringify({ name: shot.scenario }),
    })

    const ctx = await browser.newContext({
      viewport: shot.viewport ?? PHONE,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    })
    const page = await ctx.newPage()
    // A previous capture's cached feed would otherwise decide this one's first paint.
    await page.addInitScript(() => { try { localStorage.clear() } catch { /* private mode */ } })

    // Claim to be an installed app, the way iOS does. `ViewportShell` reads
    // both signals, so the legacy one is the honest thing to fake here.
    if (shot.standalone) {
      await page.addInitScript(() => {
        Object.defineProperty(window.navigator, 'standalone', { get: () => true })
      })
    }

    /**
     * A keyboard, as the browser reports one: `visualViewport` shrinks while
     * `window.innerHeight` does not.
     *
     * It is installed as a MUTABLE amount, applied after a field is focused,
     * rather than baked in before the first paint. That is not tidiness — a
     * shrink present at boot with nothing focused is not a keyboard, it is what
     * iOS reports at rest in a Home Screen launch, and the app is now required
     * to tell those apart. Faking it the old way would have measured the app
     * correctly ignoring it.
     */
    if (shot.keyboard) {
      await page.addInitScript(() => {
        window.__cruKeyboard = 0
        const vv = window.visualViewport
        if (!vv) return
        const real = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(vv), 'height').get
        Object.defineProperty(vv, 'height', { get: () => real.call(vv) - window.__cruKeyboard })
      })
    }
    /*
      Poison is installed BEFORE the first paint, because two of the seams
      (`hydrate`, `home`) only run once and would otherwise already be past by
      the time a capture could reach them.
    */
    if (shot.poison) {
      await page.addInitScript((points) => {
        const install = () => {
          const fn = window.__cruPoison
          if (typeof fn !== 'function') return false
          fn(...points)
          return true
        }
        if (!install()) {
          // The module registers it during evaluation; poll briefly rather than
          // guessing at bundle order.
          const t = setInterval(() => { if (install()) clearInterval(t) }, 1)
          setTimeout(() => clearInterval(t), 3000)
        }
      }, shot.poison)
    }

    /**
     * THE TEXT SIZE, AS THE BROWSER'S OWN CONTROL SETS IT.
     *
     * The root font size is what a browser's "default font size" preference
     * moves, and `TYPE` is in `rem` precisely so that it responds. Set before
     * the first paint, so the app lays out at this size rather than reflowing
     * into it — a card that is correct after a resize and broken on arrival is
     * still broken on his phone.
     *
     * This is a real accessibility setting, not a zoom: layout stays in px, so
     * the cards keep their tiers and the reduction ladder has to absorb the
     * difference. That is exactly the pressure §4 asks for.
     */
    if (shot.textScale) {
      await page.addInitScript((scale) => {
        const apply = () => {
          if (document.documentElement) document.documentElement.style.fontSize = `${16 * scale}px`
        }
        apply()
        document.addEventListener('DOMContentLoaded', apply)
      }, shot.textScale)
    }

    await page.goto(BASE_OF(), { waitUntil: 'networkidle' })
    await page.waitForTimeout(400)

    if (shot.open) {
      // An application is a tile in the strip; anything else is a card in a band.
      if (!await tapApp(page, shot.open)) await tap(page, `[data-open="${shot.open}"]`)
      await page.waitForTimeout(350)
    }
    if (shot.openSettings) await openSettings(page)
    if (shot.drive) await shot.drive(page)
    await page.waitForTimeout(250)

    /*
      RAISE THE KEYBOARD THE WAY ONE ACTUALLY GETS RAISED: by focusing a field.

      The app gates its keyboard reserve on something editable having focus, so
      the shrink alone must be ignored. Doing this here — after the surface is
      open and driven — is what makes the capture a keyboard rather than a
      resize event nobody asked for.
    */
    if (shot.keyboard) {
      const focused = await page.evaluate(() => {
        const el = document.querySelector('[data-frame="composer"] input, input, textarea')
        if (!el) return false
        el.focus()
        return document.activeElement === el
      })
      if (!focused) throw new Error(`${shot.name}: no field to focus, so no keyboard to raise`)
      await page.evaluate((px) => {
        window.__cruKeyboard = px
        window.visualViewport?.dispatchEvent(new Event('resize'))
      }, shot.keyboard)
      await page.waitForTimeout(320)
    }

    /*
      The screenshot is taken BEFORE the destination sweep, because the sweep
      navigates and reloads. What is on the PNG has to be what was measured.
    */
    const m = await page.evaluate(MEASURE)
    await page.screenshot({ path: join(OUT, `${shot.name}.png`) })

    const destinations = shot.noBlank ? await sweepDestinations(page, BASE_OF()) : null

    const bad = check(shot.name, m, {
      textScale: shot.textScale ?? 1,
      question: !!shot.question,
      quiet: !!shot.quiet,
      destinations,
      surface: !!shot.surface,
      keyboard: shot.keyboard ?? 0,
      lanes: !!shot.lanes,
      pager: shot.pager,
      chat: shot.chat,
      stillHome: !!shot.stillHome,
      interrupt: !!shot.interrupt,
      reachable: !!shot.reachable,
      navigates: shot.navigates,
      settings: shot.settings,
      projects: shot.projects,
    })
    results.push({ name: shot.name, bad, m, destinations })
    await ctx.close()
  }

  await browser.close()
  if (!keep) stopAll()

  writeFileSync(join(OUT, 'report.json'), JSON.stringify(results, null, 2))

  /**
   * THE CROSS-CAPTURE ASSERTION.
   *
   * "Fixed lane geometry" is not a property of any single screenshot — it is a
   * property of the RELATIONSHIP between screenshots. Eight objects, twenty-six
   * objects and none at all must put every lane at the same Y. This is the one
   * check that can actually catch content deciding the layout, and it is why
   * those three captures exist as a set.
   */
  /*
    WHAT "FIXED GEOMETRY" MEANS NOW, AND WHY THE EMPTY CAPTURES LEFT THIS SET.

    The rule being defended is, and always was: HOW MUCH a band contains must
    not change the layout. Three objects and three hundred, a long title and a
    short one, an error and a success — identical Y, identical height.

    What the set used to ALSO assert is that a band with NOTHING in it occupies
    the same box as a full one, and that is a different claim which the contract
    now rejects: it is what made an empty morning cost a quarter of the screen.
    So the comparison groups are populated-against-populated, and the collapse
    is asserted directly, per-capture, in `check` (rule 9).

    This is the one place where relaxing a test is the correct response to a
    failing assertion, and it is worth being explicit about why: the assertion
    was not wrong about the code, it was encoding a product rule that has been
    deliberately reversed. Every other assertion in this file stays.
  */
  const SETS = [
    // Each set is one window size AND one population. Geometry is fixed for a
    // DEVICE, so comparing a 375pt capture against an 874pt one would assert the
    // opposite of the rule.
    ['home-lanes', ['home-lane-overflow', 'home-paged']],
    ['home-lanes-iphone17', ['home-lanes-iphone17-many']],
  ]
  for (const [ref, others] of SETS) for (const name of others) {
    const reference = results.find((r) => r.name === ref)
    const other = results.find((r) => r.name === name)
    if (!reference || !other) continue
    for (const lane of reference.m.decks) {
      const mine = other.m.decks.find((d) => d.label === lane.label)
      if (!mine) { other.bad.push(`lane '${lane.label}' is missing`); continue }
      if (Math.abs(mine.top - lane.top) > 1) {
        other.bad.push(`lane '${lane.label}' sits at y=${mine.top}, but at y=${lane.top} in ${ref} — content moved the layout`)
      }
      // Height too, and for the same reason. A lane that kept its Y and grew
      // downward has still let content decide the layout.
      if (Math.abs(mine.h - lane.h) > 1) {
        other.bad.push(`lane '${lane.label}' is ${mine.h}px, but ${lane.h}px in ${ref} — content sized the lane`)
      }
    }
  }

  let failed = 0
  for (const r of results) {
    if (r.bad.length) {
      failed++
      console.log(`✗ ${r.name}`)
      for (const b of r.bad) console.log(`    ${b}`)
    } else {
      console.log(`✓ ${r.name}`)
    }
  }
  console.log(`\n${results.length - failed}/${results.length} captures hold the spatial contract → shots/`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  stopAll()
  console.error(e)
  process.exit(1)
})

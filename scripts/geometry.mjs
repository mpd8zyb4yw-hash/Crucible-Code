#!/usr/bin/env node
/**
 * THE MOBILE GEOMETRY GATE.
 *
 * `shots.mjs` asserts the spatial contract INSIDE the app — nothing stranded
 * outside its frame, four lanes at fixed positions, chat capped. It runs in one
 * window, with no notch, no home indicator, no status bar and no Home Screen
 * launch, because Chromium has none of those. So the one defect that has been
 * reported over and over — an inch of black under the composer on his phone —
 * was invisible to it, and stayed invisible through several rounds of fixing.
 *
 * This gate is the missing half: the same app, measured in SIMULATED iOS
 * ENVIRONMENTS, asserting the contract BETWEEN the app and the window.
 *
 * WHAT MAKES THE SIMULATION REAL RATHER THAN A GUESS.
 *
 * Three things vary between a desktop browser and a Home Screen launch, all
 * three are observable in JS, and all three are set here:
 *
 *   safe-area insets   `env()` cannot be faked, so `viewport.ts` reads each one
 *                      through `var(--cru-safe-*, env(…))`. Setting those four
 *                      variables gives Chromium a notch and a home indicator.
 *   layout viewport    the Playwright viewport size.
 *   visual viewport    iOS reports this as the UNOBSCURED region, which in a
 *                      standalone launch is ~62px shorter than the layout
 *                      viewport with no keyboard anywhere near the screen.
 *                      `vvShrink` reproduces that divergence.
 *
 * That third one is the actual bug. Before the fix this gate reported:
 *
 *   standalone-vv-divergent / home
 *     the app leaves 96px of dead space below it (intended 34px)
 *
 * which is the inch of black, measured, off a laptop.
 *
 * THE CONTRACT, in one place:
 *
 *   1  the shell IS the layout viewport — same top, same bottom, same height;
 *   2  the usable rectangle ends exactly one home-indicator inset above it;
 *   3  the composer sits at the bottom of the usable rectangle, within the
 *      design margin and nothing more;
 *   4  the document never scrolls, in either axis;
 *   5  with the keyboard up the composer sits on top of the keyboard, and the
 *      home-indicator reserve is NOT also applied;
 *   6  when the keyboard closes every number returns to what it was — no
 *      stale reserve, no drift.
 *
 * Run: npm run geometry
 *      npm run geometry -- --only standalone
 *      npm run geometry -- --shots     (also write PNGs to shots/geometry/)
 */
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { spawn, execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'shots', 'geometry')
const FIXTURE = 3002
const PORT = 5174
/*
  BASE IS RESOLVED AT STARTUP, NOT ASSUMED.

  This was a constant, and the startup below reused whatever was already
  listening on 5174 — without ever asking what that server was proxying to. A
  vite left behind by an earlier session, still pointed at a fixture that had
  since been killed, answers the page request fine and then never settles:
  the app retries its API calls forever, `networkidle` never fires, and
  `page.goto` times out after 30s.

  That is not a hypothetical. It blocked the deploy reconciler for hours, twice,
  and because the reconciler refuses to ship a failing suite, crucible.cam
  silently sat a build behind while every run reported "blocked-tests".

  So: verify the server on the port actually serves OUR fixture, and if it does
  not, move to a free port rather than killing it. Moving is the safe half of
  the choice — the alternative is a port-killer that shoots a sibling run, which
  is a mistake this repo has already made once.
*/
let PAGE_PORT = PORT
const base = () => `http://localhost:${PAGE_PORT}`

/** Mirrored from src/tokens.ts — BOTTOM. */
const MARGIN = 12
const SLACK = 6

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null
const wantShots = process.argv.includes('--shots')

// ── the environments ─────────────────────────────────────────────────────────

/**
 * `insets` are what `env(safe-area-inset-*)` reports. `vvShrink` is how much
 * smaller iOS reports the visual viewport than the layout viewport AT REST,
 * with no keyboard — the divergence the old shell mistook for its own height.
 */
const ENVIRONMENTS = [
  {
    id: 'safari-portrait',
    note: 'iPhone Safari, both toolbars visible',
    viewport: { width: 402, height: 724 }, screenH: 874,
    standalone: false, insets: { top: 0, bottom: 0 },
  },
  {
    id: 'safari-toolbar-collapsed',
    note: 'iPhone Safari after the toolbar collapses — the indicator inset appears',
    viewport: { width: 402, height: 810 }, screenH: 874,
    standalone: false, insets: { top: 0, bottom: 34 },
  },
  {
    id: 'standalone-portrait',
    note: 'Home Screen launch, layout viewport covers the whole screen',
    viewport: { width: 402, height: 874 }, screenH: 874,
    standalone: true, insets: { top: 62, bottom: 34 },
  },
  {
    /*
      THE ONE THAT WAS BROKEN, and the reason this file exists.

      iOS hands a standalone app the full screen to lay out in and reports the
      visual viewport as the unobscured region. Any shell sized from the second
      and placed in the first is short by the difference, and the difference is
      black, and it is at the bottom because the shell is anchored at the top.
    */
    id: 'standalone-vv-divergent',
    note: 'Home Screen launch where visualViewport.height is 62px under the layout viewport',
    viewport: { width: 402, height: 874 }, screenH: 874,
    standalone: true, insets: { top: 62, bottom: 34 }, vvShrink: 62,
  },
  {
    id: 'standalone-small',
    note: 'a smaller notched phone, standalone',
    viewport: { width: 375, height: 812 }, screenH: 812,
    standalone: true, insets: { top: 44, bottom: 34 }, vvShrink: 44,
  },
]

// ── the screens ──────────────────────────────────────────────────────────────

/**
 * Every mode the app has a bottom edge in. The bug was never specific to one
 * screen — the shell is shared — but a regression could be, and the composer
 * belongs to three different components across these six.
 */
const SCREENS = [
  { id: 'home', scenario: 'lanes' },
  {
    id: 'home-chat-expanded', scenario: 'lanes',
    drive: async (p) => { await tap(p, '[data-frame="composer"]'); await p.waitForTimeout(360) },
  },
  { id: 'calendar', scenario: 'normal', open: 'calendar' },
  { id: 'fitness', scenario: 'normal', open: 'fitness' },
  {
    id: 'mail-reply', scenario: 'normal', open: 'mail',
    drive: async (p) => {
      if (!await p.locator('[data-role="reply"]').count()) await tap(p, '[data-object="m1"] [data-role="open"]')
      await tap(p, '[data-role="reply"]')
    },
  },
  { id: 'settings', scenario: 'lanes', openSettings: true },
]

/** Keyboard states. `open` focuses a real field first — see `editableFocused`. */
const KEYBOARDS = [
  { id: 'closed', px: 0 },
  { id: 'open', px: 336 },
]

async function tap(page, selector) {
  const el = page.locator(selector).first()
  if (await el.count() === 0) return false
  await el.click({ timeout: 4000 }).catch(() => {})
  await page.waitForTimeout(200)
  return true
}

/**
 * Open a system application from Home.
 *
 * A URL NOW, AND THAT IS THE POINT. Three shapes so far. The six applications
 * were a LANE, so Calendar was on page one and Fitness on page five, and for a
 * while the Fitness, Mail and Calendar captures were quietly measuring Home
 * instead — passing while holding nothing. Then they were a STRIP of tiles, all
 * six reachable without a gesture. They are now not on Home at all: a permanent
 * launcher is screen spent on integrations with nothing to say, so reaching a
 * quiet application is `#/open/<id>`, which costs no pixels.
 *
 * What this gate measures is unchanged — an application surface inside a
 * simulated iOS window — and the caller still asserts that the surface actually
 * mounted. That assertion is what turned the silent version of this into a
 * failing one, and it is what catches this helper going stale again.
 */
async function openApp(page, openId) {
  await page.evaluate((id) => { window.location.hash = `#/open/${encodeURIComponent(id)}` }, openId)
  await page.waitForTimeout(400)
  return page.evaluate(() => !!document.querySelector('[data-frame="surface"]'))
}

/** Settings, the way he opens it: a long press on the send control. */
async function openSettings(page) {
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

// ── the measurement ──────────────────────────────────────────────────────────

/**
 * Everything the contract talks about, read out of the live page.
 *
 * Deliberately raw: this returns numbers and the assertions are made in Node,
 * so a failure can print the whole picture rather than one boolean. The list is
 * the one he asked for — window, document, visual viewport, safe areas,
 * standalone, and the rect of every layout landmark.
 */
const MEASURE = () => {
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      left: Math.round(r.left), right: Math.round(r.right),
      w: Math.round(r.width), h: Math.round(r.height),
    }
  }
  const at = (sel) => box(document.querySelector(sel))

  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;' +
    'padding-top:var(--cru-safe-top, env(safe-area-inset-top, 0px));' +
    'padding-bottom:var(--cru-safe-bottom, env(safe-area-inset-bottom, 0px));' +
    'padding-left:var(--cru-safe-left, env(safe-area-inset-left, 0px));' +
    'padding-right:var(--cru-safe-right, env(safe-area-inset-right, 0px));'
  document.body.appendChild(probe)
  const cs = getComputedStyle(probe)
  const px = (v) => Math.round(parseFloat(v) || 0)
  const safe = {
    top: px(cs.paddingTop), bottom: px(cs.paddingBottom),
    left: px(cs.paddingLeft), right: px(cs.paddingRight),
  }
  probe.remove()

  const vv = window.visualViewport
  const doc = document.documentElement

  /*
    WHAT ESCAPES THE USABLE RECTANGLE, AND IS NOT REACHABLE.

    The naive version of this — "the lowest bottom edge of anything" — was
    written first and was wrong in the noisiest possible way: it failed Settings
    by 404px on every single environment, because a scroller's content is TALLER
    THAN THE SCROLLER, which is what a scroller is. It flagged the calendar
    grid, the chat thread and every mailbox below the fold too.

    Being outside the box is normal. Being outside the box with no way to reach
    it is the bug, and it is the same rule `shots.mjs` settled on. An element
    counts here when its own clipping ancestor cuts it off AND nothing between
    the two can scroll far enough to bring it back — and, additionally, when
    that cut happens at or below the usable rectangle, which is this gate's
    business rather than the general fit rule's.
  */
  const scrollable = (el, by) => {
    const s = getComputedStyle(el)
    if (s.overflowY !== 'auto' && s.overflowY !== 'scroll') return false
    return el.scrollHeight - el.clientHeight >= by - 1
  }
  const usableEl = document.querySelector('[data-frame="usable"]')
  const usableBottom = usableEl ? usableEl.getBoundingClientRect().bottom : Infinity

  const escapes = []
  let content = 0
  for (const el of document.querySelectorAll('[data-frame="usable"] *')) {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    if (r.width < 8 || r.height < 4) continue
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') continue
    if (el.closest('[aria-hidden="true"]')) continue

    // The nearest box that clips it — the only edge that can strand it.
    let clip = null
    let gesture = false
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.hasAttribute('data-pannable') || p.hasAttribute('data-track')) { gesture = true; break }
      if (getComputedStyle(p).overflow !== 'visible') { clip = p; break }
    }
    if (gesture || !clip) continue

    const cut = Math.round(r.bottom - clip.getBoundingClientRect().bottom)
    if (cut <= 1) { content = Math.max(content, r.bottom); continue }

    let reachable = false
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (scrollable(p, cut)) { reachable = true; break }
      if (p === clip) break
    }
    if (reachable) continue
    if (r.bottom <= usableBottom + 1) continue

    const name = (n) => {
      for (let p = n; p; p = p.parentElement) {
        for (const a of ['data-frame', 'data-fit', 'data-role', 'data-deck', 'data-object']) {
          const v = p.getAttribute?.(a)
          if (v) return `${a.replace('data-', '')}=${v}`
        }
      }
      return n.tagName?.toLowerCase() ?? '?'
    }
    escapes.push({
      at: name(el), box: name(clip), tag: el.tagName.toLowerCase(), over: cut,
      text: (el.textContent ?? '').trim().slice(0, 36),
    })
    content = Math.max(content, r.bottom)
  }

  return {
    window: { innerW: window.innerWidth, innerH: window.innerHeight },
    doc: {
      clientW: doc.clientWidth, clientH: doc.clientHeight,
      scrollW: doc.scrollWidth, scrollH: doc.scrollHeight,
    },
    body: { scrollH: document.body.scrollHeight, rect: box(document.body) },
    visual: vv
      ? { h: Math.round(vv.height), w: Math.round(vv.width), offsetTop: Math.round(vv.offsetTop), scale: vv.scale }
      : null,
    safe,
    standalone: window.navigator.standalone === true ||
      ['standalone', 'fullscreen', 'minimal-ui'].some((m) => window.matchMedia(`(display-mode: ${m})`).matches),
    scroll: { x: window.scrollX, y: window.scrollY },
    /** What the shell believes, published for exactly this reason. */
    flags: {
      standalone: doc.dataset.standalone, keyboard: doc.dataset.keyboard, bezel: doc.dataset.bezel,
    },
    shell: at('[data-frame="shell"]'),
    usable: at('[data-frame="usable"]'),
    home: at('[data-frame="home"]'),
    surface: at('[data-frame="surface"]'),
    chat: at('[data-frame="chat"]'),
    settings: at('[data-frame="settings"]'),
    composer: at('[data-frame="composer"]'),
    contentBottom: Math.round(content),
    escapes: escapes.slice(0, 6),
    /** Every bottom offset an ancestor of the composer contributes. */
    ancestry: (() => {
      const out = []
      let el = document.querySelector('[data-frame="composer"]')
      for (; el && el !== document.documentElement; el = el.parentElement) {
        const s = getComputedStyle(el)
        const b = px(s.paddingBottom) + px(s.marginBottom) + px(s.borderBottomWidth)
        if (b > 0 || s.position === 'fixed' || s.position === 'absolute') {
          out.push({
            tag: el.tagName.toLowerCase(),
            name: el.getAttribute('data-frame') ?? el.getAttribute('data-role') ?? el.id ?? '',
            position: s.position,
            bottomPad: px(s.paddingBottom), bottomMargin: px(s.marginBottom),
            bottomOffset: s.bottom,
          })
        }
      }
      return out.slice(0, 8)
    })(),
    activeElement: document.activeElement ? document.activeElement.tagName.toLowerCase() : null,
  }
}

// ── the assertions ───────────────────────────────────────────────────────────

function check(m, env, kbd) {
  const bad = []
  const say = (s) => bad.push(s)
  const kb = kbd.px

  if (!m.shell) return ['no shell rendered — the app did not mount']
  if (!m.usable) return ['no usable rectangle rendered']

  const viewH = m.doc.clientH
  const viewW = m.doc.clientW

  // 1. THE SHELL IS THE LAYOUT VIEWPORT. Not "close to", not "sized from".
  if (m.shell.top !== 0) say(`shell starts ${m.shell.top}px below the top of the window`)
  if (Math.abs(m.shell.h - viewH) > 1) {
    say(`shell is ${m.shell.h}px tall in a ${viewH}px viewport — ${viewH - m.shell.h}px unaccounted for`)
  }
  if (Math.abs(m.shell.bottom - viewH) > 1) {
    say(`shell ends ${viewH - m.shell.bottom}px above the bottom of the window`)
  }
  if (Math.abs(m.shell.w - viewW) > 1) say(`shell is ${m.shell.w}px wide in a ${viewW}px viewport`)

  /*
    2. THE USABLE RECTANGLE ENDS ONE HOME-INDICATOR INSET ABOVE THE WINDOW —
       WITH THE KEYBOARD UP OR DOWN, IDENTICALLY.

    This is the assertion the whole rewrite is for. The reserve is a constant of
    the device, not a function of what is on screen or what is focused, so there
    is no state in which "how far above the bottom does the app stop" has a
    second answer. A keyboard raises the composer (checked below); it does not
    resize the app, so it cannot leave anything behind when it goes.
  */
  const reserve = env.insets.bottom
  const actual = viewH - m.usable.bottom
  if (Math.abs(actual - reserve) > 1) {
    say(`the app stops ${actual}px above the bottom of the window; the home-indicator reserve is ` +
        `${reserve}px — ${actual - reserve}px of that is dead space`)
  }
  if (m.usable.top !== env.insets.top) {
    say(`the app's content starts ${m.usable.top}px down, the status-bar inset is ${env.insets.top}px`)
  }

  /*
    3. THE COMPOSER TOUCHES THE TRUE BOTTOM. The rule with its own number.

    With no keyboard that bottom is the usable rectangle's. With one it is the
    top of the keys — and the lift is `keyboard - safeBottom`, not `keyboard`,
    because the rectangle is already held off the bottom by the indicator inset
    and the keyboard covers the indicator. Lifting by the whole keyboard leaves
    exactly one home-indicator's worth of black between the composer and the
    keys, which is the same double-payment in miniature.
  */
  if (m.composer) {
    const floor = kb > 0 ? viewH - kb : m.usable.bottom
    const gap = floor - m.composer.bottom
    if (gap > MARGIN + SLACK) {
      say(`composer floats ${gap}px above ${kb > 0 ? 'the keyboard' : 'the usable bottom'}, ` +
          `the design margin is ${MARGIN}px`)
    }
    if (gap < -1) {
      say(`composer hangs ${-gap}px below ${kb > 0 ? 'the top of the keyboard' : 'the usable rectangle'}`)
    }
  }

  // 4. THE DOCUMENT NEVER SCROLLS. Not a pixel, in either axis.
  if (m.doc.scrollH > viewH + 1) say(`document scrolls vertically (${m.doc.scrollH} > ${viewH})`)
  if (m.doc.scrollW > viewW + 1) say(`document scrolls horizontally (${m.doc.scrollW} > ${viewW})`)
  if (m.scroll.y !== 0 || m.scroll.x !== 0) say(`the window is scrolled to ${m.scroll.x},${m.scroll.y}`)

  // 5. THE KEYBOARD FLAG FOLLOWS THE KEYBOARD, in both directions.
  const flagged = m.flags.keyboard === 'yes'
  if (kb > 0 && !flagged) say('the keyboard is up and the app does not know it')
  if (kb === 0 && flagged) say('the app still believes a keyboard is up — a stale reserve')

  // 6. Nothing is stranded below the usable rectangle — cut off by a box with
  //    no scroller anywhere between it and the cut. Content inside a scroller
  //    is not stranded however far down it is; that is what a scroller is for.
  if (m.escapes.length) {
    say(`${m.escapes.length} node(s) stranded past the usable rectangle: ` +
      m.escapes.map((e) => `${e.tag}(${e.at}) escapes ${e.box} by ${e.over}px`).join(', '))
  }

  // 7. Something is on screen at all — every check above passes vacuously on a
  //    blank document, which is precisely how a blank screen ships.
  if (!m.home && !m.surface && !m.settings) {
    say('no workspace is mounted: neither Home, a surface, nor Settings')
  }

  return bad
}

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
  if (wantShots) mkdirSync(OUT, { recursive: true })

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
  /*
    `tsx`, NOT `node`, and this is the same reason `shots.mjs` already says.

    The fixture imports the real server projections so the gate cannot pass
    against a second copy of them. Plain `node` survived that for as long as the
    imports were `import type` — erased before resolution — and stopped the
    moment one of them was a value import: Node's type stripping does not rewrite
    a `.js` specifier onto the `.ts` file beside it, so `intelligence.ts`'s
    `./clock.js` resolved to nothing. The two harnesses spawn the same fixture
    and must spawn it the same way.
  */
  start('npx', ['tsx', 'scripts/fixture.mjs', '--port', String(FIXTURE)])
  /*
    Reuse a server on the port ONLY if it is serving this suite's fixture.

    `fetch(base())` succeeding proves a web server is there; it proves nothing
    about what its /api goes to, and a vite proxying at a backend that is gone
    is strictly worse than no server at all — the page loads and then hangs.
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
    // Take the port if it is free; step past it if somebody else's server is
    // squatting on it. Never kill it — it may belong to a run that is not ours.
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
  await wait(base())

  const browser = await chromium.launch()
  const failures = []
  let ran = 0

  for (const env of ENVIRONMENTS) {
    if (only && !env.id.includes(only) && !SCREENS.some((s) => s.id.includes(only))) continue

    for (const screen of SCREENS) {
      if (only && !env.id.includes(only) && !screen.id.includes(only)) continue

      const ctx = await browser.newContext({
        viewport: env.viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      })
      const page = await ctx.newPage()

      await page.addInitScript(({ standalone, screenH, insets, vvShrink }) => {
        try { localStorage.clear() } catch { /* private mode */ }
        if (standalone) {
          Object.defineProperty(window.navigator, 'standalone', { get: () => true })
        }
        Object.defineProperty(window.screen, 'height', { get: () => screenH })

        /*
          THE KEYBOARD, and the resting divergence it has to be told apart from.

          `__cruKeyboard` is what a real keyboard would take. `vvShrink` is the
          divergence iOS reports with no keyboard at all. Both come off
          `visualViewport.height`, which is exactly how they arrive on a phone —
          indistinguishable in a single reading, which is why the app calibrates
          the resting value rather than trusting one.
        */
        window.__cruKeyboard = 0
        const vv = window.visualViewport
        if (vv) {
          const proto = Object.getPrototypeOf(vv)
          const real = Object.getOwnPropertyDescriptor(proto, 'height').get
          Object.defineProperty(vv, 'height', {
            get: () => real.call(vv) - (vvShrink ?? 0) - window.__cruKeyboard,
          })
        }

        const style = document.createElement('style')
        style.textContent = `:root{
          --cru-safe-top:${insets.top ?? 0}px; --cru-safe-bottom:${insets.bottom ?? 0}px;
          --cru-safe-left:${insets.left ?? 0}px; --cru-safe-right:${insets.right ?? 0}px;}`
        const put = () => document.documentElement.appendChild(style)
        if (document.documentElement) put()
        else document.addEventListener('DOMContentLoaded', put)
      }, env)

      await fetch(`http://localhost:${FIXTURE}/__scenario`, {
        method: 'POST', body: JSON.stringify({ name: screen.scenario }),
      })

      await page.goto(base(), { waitUntil: 'networkidle' })
      await page.waitForTimeout(400)

      if (screen.openSettings) await openSettings(page)
      if (screen.open) await openApp(page, screen.open)
      if (screen.drive) await screen.drive(page).catch(() => {})
      await page.waitForTimeout(250)

      /*
        THE CAPTURE IS OF THE SCREEN IT CLAIMS TO BE.

        Checked before anything is measured, because a capture that fell back to
        Home measures a perfectly good Home and reports it as Fitness. Every
        assertion below would pass and the surface would never have been looked
        at once.
      */
      const mounted = await page.evaluate(() => ({
        surface: !!document.querySelector('[data-frame="surface"]'),
        settings: !!document.querySelector('[data-frame="settings"]'),
        renderers: [...document.querySelectorAll('[data-renderer]')]
          .map((el) => el.getAttribute('data-renderer')),
      }))
      if (screen.open && !mounted.surface) {
        failures.push({ name: `${env.id}/${screen.id}`, bad: [`'${screen.open}' never opened — the capture fell back to Home`], m: mounted })
        console.log(`✗ ${env.id}/${screen.id}\n    '${screen.open}' never opened — the capture fell back to Home`)
        ran++
        await ctx.close()
        continue
      }
      if (screen.openSettings && !mounted.settings) {
        failures.push({ name: `${env.id}/${screen.id}`, bad: ['Settings never opened'], m: mounted })
        console.log(`✗ ${env.id}/${screen.id}\n    Settings never opened`)
        ran++
        await ctx.close()
        continue
      }

      /** The geometry before any keyboard, to compare the restored state against. */
      const rest = await page.evaluate(MEASURE)

      for (const kbd of KEYBOARDS) {
        const name = `${env.id}/${screen.id}/kbd-${kbd.id}`
        if (kbd.px > 0) {
          /*
            A keyboard appears BECAUSE something editable was focused. Focusing
            first is not set dressing — the app gates the reserve on exactly
            that, so a shrink with nothing focused must (correctly) be ignored.
          */
          /*
            FOCUS AND THE KEYBOARD IN ONE TURN.

            These were two `evaluate` calls, and between them React was free to
            re-render — a feed landing, a durable write echoing back — which
            blurs the field. The app then correctly ignores a shrink with nothing
            focused, and the run fails with "the keyboard is up and the app does
            not know it": a true statement about a state the harness itself
            created. One turn, no render in the gap, and the flake becomes either
            a pass or a real failure worth reading.
          */
          const focused = await page.evaluate((px) => {
            const el = document.querySelector('[data-frame="composer"] input, [data-role="draft"], input, textarea')
            if (!el) return false
            el.focus()
            if (document.activeElement !== el) return false
            window.__cruKeyboard = px
            window.visualViewport?.dispatchEvent(new Event('resize'))
            return true
          }, kbd.px)
          if (!focused) continue

          /*
            WAIT FOR THE FLAG, THEN STILL WAIT FOR THE LAYOUT.

            The reverted attempt replaced the sleep below with "flag plus two
            stable frames" and took geometry from 90/90 to 51/90, because the
            flag flips before the layout finishes. The lesson taken from that was
            "use a sleep", and the lesson available was narrower: the flag is the
            right condition for the FLAG assertion and the wrong one for the
            layout assertions. So do both — this waits for exactly the thing
            `check()` tests, and the generous sleep afterwards is untouched.

            What it fixes is a real race rather than slowness: React can
            re-render between the focus and the resize — a feed landing, a
            durable write echoing back — which blurs the field, so the app
            correctly ignores a shrink with nothing focused and the run fails
            with "the keyboard is up and the app does not know it", a true
            statement about a state the harness created. One retry of the focus
            is enough, and if the flag never comes the failure is real and is
            reported as before.
          */
          const flagUp = () => page
            .waitForFunction(() => document.documentElement.dataset.keyboard === 'yes', null, { timeout: 3000 })
            .then(() => true).catch(() => false)
          if (!(await flagUp())) {
            await page.evaluate((px) => {
              const el = document.querySelector('[data-frame="composer"] input, [data-role="draft"], input, textarea')
              if (!el) return
              el.focus()
              window.__cruKeyboard = px
              window.visualViewport?.dispatchEvent(new Event('resize'))
            }, kbd.px)
            await flagUp()
          }
          /*
            LONGER THAN IT LOOKS LIKE IT NEEDS, ON PURPOSE.

            This was 300ms, which is enough on an idle laptop and not enough
            under the deploy watchdog — that runs the suite at `Nice 5` with
            low-priority IO, so React had not re-rendered when the measurement
            was taken and the run reported "composer hangs 290px below the top
            of the keyboard" about a screen that was fine. A gate that fails
            only on a loaded machine fails exactly when nobody is watching.

            A cleverer version was tried and reverted: waiting on the shell's
            own keyboard flag plus two stable animation frames. It can resolve
            SOONER than this sleep — the flag flips before the layout finishes —
            and it took geometry from 90/90 to 51/90. Waiting for the right
            condition is the correct instinct and this was the wrong condition;
            until there is one worth trusting, a generous sleep is honest and
            it is the configuration that is actually green.
          */
          await page.waitForTimeout(700)
        }

        const m = await page.evaluate(MEASURE)
        const bad = check(m, env, kbd)
        ran++

        if (wantShots) {
          await page.screenshot({ path: join(OUT, `${name.replace(/\//g, '_')}.png`) })
        }

        if (bad.length) {
          failures.push({ name, bad, m })
          console.log(`✗ ${name}`)
          for (const b of bad) console.log(`    ${b}`)
        } else {
          const floor = kbd.px > 0 ? m.doc.clientH - kbd.px : m.usable.bottom
          console.log(`✓ ${name}  shell ${m.shell.h}px = viewport ${m.doc.clientH}px · ` +
            `reserve ${m.doc.clientH - m.usable.bottom}px · ` +
            `composer ${m.composer ? floor - m.composer.bottom : '—'}px above ` +
            `${kbd.px > 0 ? 'the keys' : 'the bottom'}`)
        }

        if (kbd.px > 0) {
          // Put it away, and assert the app came all the way back. A reserve
          // that survives its keyboard is the other half of the dead band.
          await page.evaluate(() => {
            window.__cruKeyboard = 0
            document.activeElement?.blur?.()
            window.visualViewport?.dispatchEvent(new Event('resize'))
          })
          // Same reasoning as the wait above, and the same history: the
          // restore is what surfaced the regression, as "the keyboard flag is
          // still set" on capture after capture.
          await page.waitForTimeout(700)
          /*
            A MEASUREMENT THAT FOUND NOTHING IS A RETRY, NOT A CRASH.

            `usable` is null when the shell is mid-render — React had committed a
            frame in which `[data-frame="usable"]` was not mounted — and the code
            below then read `.bottom` off it and took the WHOLE STAGE down with a
            TypeError, from the last check of the last screen. That is the worst
            available failure: not a reported defect, not a reported flake, but a
            stack trace that stops every capture after it and reproduces on
            neither of the next two runs.

            One more frame, then say so plainly. A shell that is genuinely absent
            is still absent a second later, and that is a real failure worth
            reporting as one.
          */
          let back = await page.evaluate(MEASURE)
          if (!back?.usable) {
            await page.waitForTimeout(700)
            back = await page.evaluate(MEASURE)
          }
          const drift = []
          /*
            A missing shell is a REPORTED failure, and it still counts toward
            `ran` — a check that quietly leaves the denominator is a check that
            has stopped being counted.
          */
          if (!back?.usable) {
            drift.push('the shell was not mounted when the keyboard was put away')
          } else {
            if (back.usable.bottom !== rest.usable.bottom) {
              drift.push(`usable bottom ${rest.usable.bottom} → ${back.usable.bottom}`)
            }
            if (back.usable.h !== rest.usable.h) drift.push(`usable height ${rest.usable.h} → ${back.usable.h}`)
            if (back.flags.keyboard === 'yes') drift.push('the keyboard flag is still set')
          }
          if (drift.length) {
            const n = `${env.id}/${screen.id}/kbd-restored`
            failures.push({ name: n, bad: drift, m: back })
            console.log(`✗ ${n}`)
            for (const d of drift) console.log(`    ${d}`)
          } else {
            console.log(`✓ ${env.id}/${screen.id}/kbd-restored  geometry returned exactly`)
          }
          ran++
        }
      }

      await ctx.close()
    }
  }

  await browser.close()
  stopAll()

  console.log(`\n${ran - failures.length}/${ran} geometry checks passed`)
  if (failures.length) {
    writeFileSync(join(ROOT, 'shots', 'geometry-failures.json'), JSON.stringify(failures, null, 2))
    console.log(`\n${failures.length} FAILED. Full measurements in shots/geometry-failures.json`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  stopAll()
  process.exit(1)
})

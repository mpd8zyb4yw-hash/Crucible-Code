/**
 * THE BROWSER SIDE OF THE EVALUATOR.
 *
 * One Chromium, one persistent profile, driving the REAL deployed Crucible.
 * Nothing in here calls a server action; every operation below ends in a
 * pointer or key event dispatched inside the page, because the whole point is
 * to find the failures that only exist between React and a finger.
 *
 * The techniques are lifted from scripts/interaction.mjs deliberately — its
 * two hard-won lessons apply verbatim:
 *
 *   · Playwright's own click() hangs under mobile emulation here, so taps are
 *     synthesised pointer sequences.
 *   · A state read in the same turn as the tap returns pre-commit React state,
 *     so every action settles a frame before anything is measured.
 */
import { chromium } from 'playwright-core'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The phone this is actually used on — same device as the visual gate. */
export const DEVICE = { width: 402, height: 874 }

/**
 * EXTERNAL WRITES ARE REFUSED AT THE SOCKET, not by disabling controls.
 *
 * `/api/act` is the only path in the application that reaches Google with a
 * mutation — every send, every calendar create/delete, every archive goes
 * through `perform()` behind it (server/actions.ts). The composer's own action
 * table (server/say.ts) can only sync, track, build a pane, or research, none
 * of which leave the account.
 *
 * So refusing this short list is sufficient AND it is honest: the control stays
 * live, the UI takes the real path, and the evaluator sees exactly what the app
 * does when a write fails — which is itself worth knowing. The attempt is
 * recorded so ChatGPT can assert "it tried to send" without anything being sent.
 */
const BLOCKED = [
  { method: /^(POST|PUT|PATCH|DELETE)$/, path: /^\/api\/act$/ },
  { method: /^POST$/, path: /^\/api\/actions\/[^/]+\/undo$/ },
  { method: /^POST$/, path: /^\/api\/google\/disconnect$/ },
  { method: /^PUT$/, path: /^\/api\/sources$/ },
]

export class Evaluator {
  constructor({ target, headless = true }) {
    this.target = target.replace(/\/$/, '')
    this.headless = headless
    this.ctx = null
    this.page = null
    this.consoleErrors = []
    this.networkFailures = []
    this.blockedWrites = []
    this.externalAttempts = []
    this.apiCalls = []
    this.startedAt = null
  }

  get profileDir() {
    return path.join(HERE, '.profile')
  }

  async ensure() {
    if (this.page && !this.page.isClosed()) return this.page
    return this.launch()
  }

  /**
   * A PERSISTENT PROFILE, so the Google sign-in survives a restart.
   *
   * `cold_start` clears the app's own storage without touching this directory,
   * which is what makes "fresh client state, preserved account state" testable
   * as two different things rather than one.
   */
  async launch() {
    if (this.ctx) await this.ctx.close().catch(() => {})
    this.ctx = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
      viewport: DEVICE,
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      // Google's sign-in refuses a browser advertising automation. Dropping the
      // flag is what makes the one interactive approval possible in this
      // profile at all.
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--disable-blink-features=AutomationControlled',
        /*
          A HEADED WINDOW HAS TO BE BIG ENOUGH TO SIGN INTO.

          The mobile viewport is the right size for the PAGE and the wrong size
          for the WINDOW: Chromium sized the frame from it and produced a 271×58
          sliver that was technically on screen and effectively invisible. The
          viewport option still governs what the page believes it has, so the
          emulated device is unchanged — this only makes the frame usable by a
          person during the one interactive sign-in.
        */
        ...(this.headless ? [] : ['--window-size=520,1000', '--window-position=120,60']),
      ],
    })
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage())
    this.wire(this.page)
    await this.guard(this.page)
    this.startedAt = Date.now()
    return this.page
  }

  wire(page) {
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      this.consoleErrors.push({ text: m.text().slice(0, 400), at: new Date().toISOString() })
      if (this.consoleErrors.length > 100) this.consoleErrors.shift()
    })
    page.on('requestfailed', (r) => {
      this.networkFailures.push({
        url: r.url().slice(0, 300),
        method: r.method(),
        error: r.failure()?.errorText ?? 'failed',
        at: new Date().toISOString(),
      })
      if (this.networkFailures.length > 100) this.networkFailures.shift()
    })
    /*
      WHAT THE APP ASKED THE SERVER, AND HOW LONG IT TOOK.

      Failures alone cannot answer the question that matters about the brain:
      a composer that returns nothing looks identical whether it never called
      /api/say or called it and got an empty answer back. One is a UI bug and
      the other is a model bug, and without this they are indistinguishable.
    */
    const started = new WeakMap()
    /*
      RECORDED AT REQUEST START, COMPLETED LATER.

      `requestfinished` alone was not enough and was actively misleading: a
      streaming or slow answer has not finished while it is being read, so a
      composer request genuinely in flight showed up as no request at all, and
      "the app never called the brain" was indistinguishable from "the brain is
      still thinking". A pending row is the honest report.
    */
    page.on('request', (req) => {
      let p = ''
      try { p = new URL(req.url()).pathname } catch { return }
      if (!p.startsWith('/api/')) return
      const row = { method: req.method(), path: p, status: 'pending', ms: null, at: new Date().toISOString() }
      started.set(req, row)
      this.apiCalls.push(row)
      if (this.apiCalls.length > 120) this.apiCalls.shift()
    })
    page.on('response', async (res) => {
      const row = started.get(res.request())
      if (!row) return
      row.status = res.status()
      const t = res.request().timing()
      row.ms = t?.responseEnd > 0 ? Math.round(t.responseEnd) : null
    })
    page.on('response', (r) => {
      if (r.status() < 400) return
      this.networkFailures.push({
        url: r.url().slice(0, 300),
        method: r.request().method(),
        status: r.status(),
        at: new Date().toISOString(),
      })
      if (this.networkFailures.length > 100) this.networkFailures.shift()
    })
    /*
      EXTERNAL DESTINATIONS ARE RECORDED RATHER THAN FOLLOWED.

      Automated Chromium cannot hand a brave:// or youtube:// URL to the OS, and
      a popup to youtube.com proves nothing about the app. What matters for the
      Brave question is which destination Crucible CHOSE, so the attempt — the
      scheme and the full URL — is captured and the navigation dropped.
    */
    this.ctx.on('page', async (p) => {
      const url = p.url()
      this.externalAttempts.push({ via: 'popup', url: url.slice(0, 400), at: new Date().toISOString() })
      await p.close().catch(() => {})
    })
  }

  async guard(page) {
    await page.route('**/*', async (route) => {
      const req = route.request()
      let p = ''
      try { p = new URL(req.url()).pathname } catch { p = '' }
      const hit = BLOCKED.find((b) => b.method.test(req.method()) && b.path.test(p))
      if (hit) {
        this.blockedWrites.push({
          method: req.method(),
          path: p,
          body: (req.postData() ?? '').slice(0, 500),
          at: new Date().toISOString(),
        })
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Refused: evaluator is running read-only.' }),
        })
      }
      // A non-http scheme cannot be fetched; record and drop it.
      const scheme = req.url().split(':')[0]
      if (!/^(https?|data|blob|about)$/.test(scheme)) {
        this.externalAttempts.push({ via: 'navigation', scheme, url: req.url().slice(0, 400), at: new Date().toISOString() })
        return route.abort()
      }
      return route.continue()
    })
  }

  // ── navigation ────────────────────────────────────────────────────────────

  /**
   * A GENUINE COLD LAUNCH: everything the client persists is destroyed, the
   * durable account session is not. That distinction is the whole reason this
   * operation exists — restored chat transcripts and stale bootstrap state only
   * show up when the client starts empty and the account does not.
   */
  async coldStart({ keepSession = true } = {}) {
    await this.ensure()
    this.consoleErrors = []
    this.networkFailures = []
    this.externalAttempts = []
    this.apiCalls = []
    // Storage is origin-scoped, so it can only be cleared from a page on it.
    await this.page.goto(this.target, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await this.page.evaluate(async () => {
      try { localStorage.clear() } catch {}
      try { sessionStorage.clear() } catch {}
      try {
        const dbs = (await indexedDB.databases?.()) ?? []
        await Promise.all(dbs.map((d) => d.name && indexedDB.deleteDatabase(d.name)))
      } catch {}
      try {
        const ks = await caches.keys()
        await Promise.all(ks.map((k) => caches.delete(k)))
      } catch {}
    }).catch(() => {})
    if (!keepSession) await this.ctx.clearCookies()
    this.consoleErrors = []
    this.networkFailures = []
    return this.goto(this.target)
  }

  async goto(url) {
    await this.ensure()
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await this.settle()
    return this.observe()
  }

  async reload() {
    await this.ensure()
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 })
    await this.settle()
    return this.observe()
  }

  /**
   * BACK, BUT NOT OUT OF THE APPLICATION.
   *
   * The profile's history begins at Google's sign-in screen, so a plain
   * goBack() from Home left Crucible entirely and every later observation
   * reported an empty surface — the evaluator looked broken and the app looked
   * blank, and neither was true. Back is a within-app operation here: if the
   * step lands off-origin it is undone and the app's own root is restored.
   */
  async back() {
    await this.ensure()
    const before = this.page.url()
    await this.page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await this.settle()
    if (!this.page.url().startsWith(this.target)) {
      await this.page.goto(before.startsWith(this.target) ? before : this.target, { waitUntil: 'domcontentloaded' })
      await this.settle()
      return { ...(await this.observe()), note: 'Back would have left Crucible; stayed in the app.' }
    }
    return this.observe()
  }

  /** Let React commit and the first paint land before anything is measured. */
  async settle(ms = 450) {
    await this.page.waitForTimeout(ms)
  }

  // ── targeting ─────────────────────────────────────────────────────────────

  /**
   * RESOLVE A HUMAN TARGET TO ONE ELEMENT, and say how it was found.
   *
   * Deliberately no new test ids: the app already carries data-role, data-card,
   * data-object, data-frame and real accessible names, and an evaluator that
   * needs an id planted for every control teaches us nothing about whether a
   * user could have found it. Strategies run most-specific first.
   */
  async resolve(target) {
    return this.page.evaluate((t) => {
      const vis = (el) => {
        const r = el.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) return false
        const s = getComputedStyle(el)
        if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false
        return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
      }
      /*
        THE PLACEHOLDER IS A NAME HERE.

        It is what the control SAYS on screen, and for the composer it is the
        only thing it says — leaving it out meant "Ask Crucible anything" could
        not be tapped by the words visibly printed inside it.
      */
      const name = (el) =>
        (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText ||
         el.getAttribute('placeholder') || el.value || '').trim()

      const mark = (el, how) => {
        if (!el) return null
        el.setAttribute('data-eval-hit', '1')
        const r = el.getBoundingClientRect()
        return { how, tag: el.tagName.toLowerCase(), name: name(el).slice(0, 120), box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
      }
      document.querySelectorAll('[data-eval-hit]').forEach((e) => e.removeAttribute('data-eval-hit'))

      // 1. an explicit attribute selector, passed straight through
      if (/^[\[.#]/.test(t)) {
        const el = [...document.querySelectorAll(t)].find(vis)
        if (el) return mark(el, 'selector')
      }
      /*
        2. the app's own attributes, by value, CASE-INSENSITIVELY.

        An exact match meant "Calendar" never matched data-card="calendar" and
        fell through to the name strategies, where it hit the deck's aria-label
        ("Domains. Calendar, 1 of 6.") instead of the card — a tap that resolved,
        reported success, and opened nothing. The obvious spelling of a target
        has to reach the obvious element.
      */
      const want = t.toLowerCase()
      for (const a of ['data-role', 'data-card', 'data-object', 'data-frame', 'data-open', 'data-deck']) {
        const el = [...document.querySelectorAll(`[${a}]`)].find((e) => e.getAttribute(a)?.toLowerCase() === want && vis(e))
        if (el) return mark(el, a)
      }
      // 3. accessible name, exact then partial, preferring real controls
      const controls = [...document.querySelectorAll('button,a,[role="button"],[role="link"],[role="tab"],input,textarea,select,[data-role],[data-card],[data-object],[tabindex]')].filter(vis)
      const lc = t.toLowerCase()
      let el = controls.find((e) => name(e).toLowerCase() === lc)
      if (el) return mark(el, 'name-exact')
      el = controls.find((e) => name(e).toLowerCase().includes(lc))
      if (el) return mark(el, 'name-partial')
      // 4. any visible element whose text matches — last resort, deepest match
      const all = [...document.querySelectorAll('*')].filter(vis).filter((e) => (e.innerText || '').trim().toLowerCase().includes(lc))
      el = all.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0]
      if (el) return mark(el, 'text')
      return null
    }, target)
  }

  // ── the operations ────────────────────────────────────────────────────────

  /**
   * A TAP, SYNTHESISED. See the note at the top of the file — locator.click()
   * is not reliable under mobile emulation in this stack, and a finger does not
   * produce a trusted event either. Dispatched at the resolved element, then
   * bubbled, which is what every handler in the app listens for.
   */
  async tap(target) {
    await this.ensure()
    const found = await this.resolve(target)
    if (!found) return { ok: false, error: `No visible element matched "${target}"` }
    const hit = await this.page.evaluate(() => {
      const el = document.querySelector('[data-eval-hit]')
      if (!el) return null
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      /*
        DISPATCH WHERE A FINGER WOULD LAND, NOT AT THE ELEMENT THAT MATCHED.

        `data-card` marks a WRAPPER; the onClick sits on a child inside it
        (src/home/DeckWidget.tsx). An event dispatched at the wrapper bubbles
        upward and so never reaches a handler below it — the tap resolved, this
        method reported success, and Calendar did not open. It read exactly like
        a dead control in the product.

        `elementFromPoint` is both the fix and the more faithful simulation: the
        browser hands a real touch to the topmost element at the coordinate, and
        React's synthetic event then bubbles up from there through every handler
        in between — wrapper included.
      */
      const at = document.elementFromPoint(x, y) ?? el
      const o = {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y,
        pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0,
      }
      at.dispatchEvent(new PointerEvent('pointerdown', o))
      at.dispatchEvent(new PointerEvent('pointerup', o))
      at.dispatchEvent(new MouseEvent('mousedown', o))
      at.dispatchEvent(new MouseEvent('mouseup', o))
      at.dispatchEvent(new MouseEvent('click', o))
      if (typeof at.focus === 'function') at.focus()
      return { dispatchedTo: at.tagName.toLowerCase(), sameAsMatched: at === el }
    })
    await this.settle(600)
    return { ok: true, matched: found, hit }
  }

  /**
   * Typing goes through the keyboard, not through value assignment — a React
   * controlled input ignores a value set behind its back, and that difference is
   * exactly the sort of thing this evaluator exists to catch.
   */
  async type(target, text, { submit = false } = {}) {
    await this.ensure()
    if (target) {
      const found = await this.resolve(target)
      if (!found) return { ok: false, error: `No visible element matched "${target}"` }
      await this.page.evaluate(() => {
        const el = document.querySelector('[data-eval-hit]')
        const f = el?.matches('input,textarea,[contenteditable]') ? el : el?.querySelector('input,textarea,[contenteditable]')
        ;(f ?? el)?.focus?.()
      })
      await this.settle(150)
    }
    await this.page.keyboard.type(text, { delay: 18 })
    if (submit) await this.page.keyboard.press('Enter')
    await this.settle(submit ? 900 : 300)
    return { ok: true, typed: text, submitted: submit }
  }

  async press(key) {
    await this.ensure()
    await this.page.keyboard.press(key)
    await this.settle(400)
    return { ok: true, key }
  }

  /**
   * A SWIPE THE DECK ACTUALLY RECEIVES.
   *
   * The deck pages on key events as well as touch, and interaction.mjs settled
   * on dispatching the key at the deck after finding that a press aimed at the
   * document goes nowhere once a surface has been opened and left. Touch is
   * tried first because it is what a user does; the key is the fallback that
   * makes the operation dependable.
   */
  async swipe(direction) {
    await this.ensure()
    const dir = String(direction).toLowerCase()
    const before = await this.deckLabel()
    const done = await this.page.evaluate((d) => {
      const deck = document.querySelector('[data-role="deck"]') || document.querySelector('[data-deck]')
      const el = deck ?? document.body
      const r = el.getBoundingClientRect()
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2
      const dx = d === 'left' ? -r.width * 0.4 : d === 'right' ? r.width * 0.4 : 0
      const dy = d === 'up' ? -r.height * 0.35 : d === 'down' ? r.height * 0.35 : 0
      const pt = (x, y) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true })
      el.dispatchEvent(new PointerEvent('pointerdown', pt(cx, cy)))
      for (let i = 1; i <= 5; i++) el.dispatchEvent(new PointerEvent('pointermove', pt(cx + (dx * i) / 5, cy + (dy * i) / 5)))
      el.dispatchEvent(new PointerEvent('pointerup', pt(cx + dx, cy + dy)))
      if (deck) {
        deck.focus?.()
        const key = d === 'left' ? 'ArrowRight' : d === 'right' ? 'ArrowLeft' : d === 'up' ? 'ArrowDown' : 'ArrowUp'
        deck.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      }
      return !!deck
    }, dir)
    await this.settle(700)
    return { ok: true, direction: dir, deck: done, from: before, to: await this.deckLabel() }
  }

  deckLabel() {
    return this.page.evaluate(() => {
      const d = document.querySelector('[data-role="deck"]') || document.querySelector('[data-deck]')
      return d?.getAttribute('aria-label') ?? d?.getAttribute('data-deck') ?? null
    }).catch(() => null)
  }

  // ── observation ───────────────────────────────────────────────────────────

  /**
   * COMPACT ON PURPOSE. A full DOM serialisation is both expensive and useless
   * to an agent — what is needed is what a person could see and what they could
   * press, plus the runtime facts that explain a wrong screen.
   */
  async observe({ maxText = 2500, maxControls = 60 } = {}) {
    await this.ensure()
    const seen = await this.page.evaluate((limits) => {
      const vis = (el) => {
        const r = el.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) return false
        const s = getComputedStyle(el)
        if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false
        return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
      }
      const nameOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || (el.innerText || '').trim() || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim()

      const controls = []
      const nodes = document.querySelectorAll('button,a,[role="button"],[role="link"],[role="tab"],input,textarea,select,[data-role],[data-card],[data-object],[data-open]')
      for (const el of nodes) {
        if (!vis(el)) continue
        const n = nameOf(el).slice(0, 80)
        const attrs = {}
        for (const a of ['data-role', 'data-card', 'data-object', 'data-open', 'data-frame', 'data-state', 'data-mode']) {
          const v = el.getAttribute(a)
          if (v) attrs[a] = v
        }
        if (!n && !Object.keys(attrs).length) continue
        /*
          A FIELD'S PLACEHOLDER AND ITS CONTENTS ARE DIFFERENT FACTS. Reporting
          only the name made a composer holding typed text indistinguishable
          from an empty one, so "did the typing land?" was unanswerable.
        */
        const typed = (el.value ?? (el.isContentEditable ? el.innerText : '') ?? '').trim()
        controls.push({
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          name: n,
          ...(typed ? { value: typed.slice(0, 120) } : {}),
          ...(Object.keys(attrs).length ? { attrs } : {}),
          ...(el.hasAttribute('disabled') ? { disabled: true } : {}),
        })
        if (controls.length >= limits.maxControls) break
      }

      /*
        THE SURFACE IS THE DEEPEST FRAME, NOT THE FIRST ONE.

        Crucible opens a domain without changing the URL, and `[data-frame]`
        nests — the shell stays mounted around whatever is open. Reading the
        first match reported "shell" from Home and "shell" again from inside an
        opened Calendar, which is the one question an agent most needs answered
        and the one this field was silently getting wrong.

        `openApp` is the corroborating fact: the app renders a close control only
        when something is open over Home.
      */
      const frames = [...document.querySelectorAll('[data-frame]')]
        .filter(vis)
        .map((el) => {
          let d = 0
          for (let p = el; p; p = p.parentElement) d++
          return { name: el.getAttribute('data-frame'), depth: d }
        })
        .sort((a, b) => b.depth - a.depth)
      const frame = frames[0]?.name ?? null
      const closer = document.querySelector('[data-role="surface-close"]')
      const deck = document.querySelector('[data-role="deck"]') || document.querySelector('[data-deck]')
      const loading = !!document.querySelector('[data-state="loading"],[aria-busy="true"],[data-loading="true"]')

      return {
        title: document.title,
        surface: frame,
        frames: frames.map((f) => f.name),
        openApp: closer ? ((document.body.innerText || '').trim().split('\n')[0] || '').slice(0, 40) : null,
        deck: deck?.getAttribute('aria-label') ?? deck?.getAttribute('data-deck') ?? null,
        loading,
        visibleText: (document.body.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, limits.maxText),
        controls,
      }
    }, { maxText, maxControls })

    return {
      url: this.page.url(),
      ...seen,
      consoleErrors: this.consoleErrors.slice(-8),
      networkFailures: this.networkFailures.slice(-8),
      apiCalls: this.apiCalls.slice(-10),
      blockedWrites: this.blockedWrites.slice(-5),
      externalAttempts: this.externalAttempts.slice(-5),
    }
  }

  async screenshot({ fullPage = false } = {}) {
    await this.ensure()
    return this.page.screenshot({ fullPage, type: 'png' })
  }

  /** Which build is actually being looked at — source freshness, unauthenticated. */
  async version() {
    try {
      const r = await fetch(`${this.target}/api/version`)
      return r.ok ? await r.json() : { error: `HTTP ${r.status}` }
    } catch (e) {
      return { error: String(e.message) }
    }
  }

  /**
   * SIGNED IN OR NOT — asked of Crucible, at an absolute URL.
   *
   * This was a relative fetch evaluated in the page, which is correct exactly
   * while the page is on the target and silently wrong the moment it is not:
   * parked on the Google sign-in screen it resolved against accounts.google.com,
   * got that origin's 404 instead of Crucible's 401, and reported `true` for a
   * browser that had never signed in. An evaluator that lies about its own
   * session state is worse than one that has none.
   *
   * The context's request client carries the same cookie jar as the page, so
   * this is the real session being asked, whatever the page happens to show.
   */
  async signedIn() {
    if (!this.ctx) return null
    try {
      const r = await this.ctx.request.get(`${this.target}/api/home`, { failOnStatusCode: false })
      return r.status() !== 401
    } catch { return null }
  }

  async close() {
    await this.ctx?.close().catch(() => {})
    this.ctx = null
    this.page = null
  }
}

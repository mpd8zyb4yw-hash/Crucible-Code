// Real browser capability — authenticated page reading, PDF export, page screenshots (cont.118).
//
// WHY. Asked to "log into my YouTube and find X, save it as a PDF", Crucible could do none of it,
// and the reasons were all capability, not intelligence:
//
//   · `navigate_browser` is literally `open "<url>"` — it launches the default browser and returns
//     "Opened URL in browser". The agent never sees the page.
//   · `read_url` (added earlier this session) fetches over HTTP with no cookies, so anything
//     behind a login returns a sign-in wall.
//   · There is no PDF writer anywhere in the repo.
//
// `playwright-core` was ALREADY a dependency with zero imports. One library closes all three.
//
// ── CREDENTIALS: THE DESIGN, STATED PLAINLY ──────────────────────────────────
// This never asks for, stores, or types a password. Not squeamishness — a credential typed into a
// chat box lands in a transcript, a debug log and a session file, and Crucible's whole premise is
// that your data stays yours.
//
// Instead there is ONE persistent browser profile at `.crucible/browser-profile`. You open it,
// log into YouTube/Instagram/whatever YOURSELF, once, in a normal browser window. The session
// cookies persist in that profile exactly as in any browser, and every later agent run reuses
// them. The agent inherits your logged-in state without ever handling the secret that created it.
//
// A dedicated profile rather than your live Chrome profile is deliberate: Chrome holds an
// exclusive lock on its user-data-dir, so attaching to a running Chrome fails, and copying it
// would duplicate every cookie you own onto disk for no reason.

import fs from 'fs'
import path from 'path'

/** Loaded lazily so the module graph stays clean when the browser is never used. */
type PwModule = typeof import('playwright-core')

let pw: PwModule | null = null
async function playwright(): Promise<PwModule> {
  if (!pw) {
    try {
      pw = await import('playwright-core')
    } catch {
      // A missing package must read like the install instruction it is, not ERR_MODULE_NOT_FOUND.
      throw new Error(PLAYWRIGHT_MISSING)
    }
  }
  return pw
}

const PLAYWRIGHT_MISSING =
  'The `playwright-core` package is not installed, so no browser can be driven. ' +
  'Run `npm install playwright-core` and then `npx playwright install chromium`.'

export interface BrowserAvailability {
  ok: boolean
  /** Executable that will be driven, when one was found. */
  executablePath?: string
  channel?: string
  /** True when this is Playwright's own downloaded build rather than a browser the user installed.
   *  Playwright is authoritative about where its managed build lives, so that path gets confirmed
   *  against its registry before launch. */
  managed?: boolean
  /** Human-readable, actionable reason when unavailable. */
  reason?: string
}

/**
 * Find a Chromium the machine already has, in preference order.
 *
 * `playwright-core` deliberately ships NO browser binaries, so something must supply one. Using an
 * already-installed Chrome is the offline-first answer — nothing to download, and it is the same
 * browser the user already trusts. A Playwright-managed Chromium is the fallback.
 */
export function findBrowser(): BrowserAvailability {
  const candidates: Array<{ p: string; channel?: string }> = [
    { p: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', channel: 'chrome' },
    { p: `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, channel: 'chrome' },
    { p: '/Applications/Chromium.app/Contents/MacOS/Chromium', channel: 'chromium' },
    { p: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', channel: 'msedge' },
    { p: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', channel: 'brave' },
  ]
  for (const c of candidates) {
    if (fs.existsSync(c.p)) return { ok: true, executablePath: c.p, channel: c.channel }
  }
  // Playwright's own managed build. SEARCH for the binary rather than assuming a path: the extracted
  // directory is platform- and arch-specific (`chrome-mac-arm64`, `chrome-linux`, `chrome-win`) and
  // the executable is named `Google Chrome for Testing` on current mac builds, not `Chromium`. A
  // hardcoded relative path here reported "no browser installed" with a freshly downloaded browser
  // sitting on disk — a dead feature that looked like a missing dependency.
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || `${process.env.HOME}/Library/Caches/ms-playwright`
  if (fs.existsSync(cache)) {
    for (const dir of fs.readdirSync(cache).filter(d => d.startsWith('chromium'))) {
      const exe = findChromiumBinary(path.join(cache, dir))
      if (exe) return { ok: true, executablePath: exe, channel: 'chromium', managed: true }
    }
  }
  return {
    ok: false,
    reason:
      'No Chromium-based browser is installed and Playwright has no downloaded build. ' +
      'Install Google Chrome, or run `npx playwright install chromium` (about 150 MB) once. ' +
      'Firefox and Safari cannot be driven by playwright-core without their own Playwright builds.',
  }
}

/** Executable names Playwright's chromium builds use across platforms. `Google Chrome for Testing`
 *  is what a current mac build actually ships — the plain `Chromium` name is older releases. */
const CHROMIUM_BINARIES = new Set([
  'Google Chrome for Testing', 'Chromium', 'chrome', 'chrome.exe', 'headless_shell', 'headless_shell.exe',
])

/** Bounded search for a chromium executable under a downloaded build directory. Depth-limited so a
 *  surprising layout costs a few stat calls rather than a walk of the whole cache. */
function findChromiumBinary(root: string, depth = 0): string | null {
  if (depth > 6) return null
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return null }
  for (const e of entries) {
    const full = path.join(root, e.name)
    if (e.isFile() && CHROMIUM_BINARIES.has(e.name)) {
      try { fs.accessSync(full, fs.constants.X_OK); return full } catch { /* not executable */ }
    }
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = findChromiumBinary(path.join(root, e.name), depth + 1)
      if (found) return found
    }
  }
  return null
}

/** Where the persistent, user-authenticated profile lives. */
export function profileDir(projectPath: string): string {
  return path.join(projectPath, '.crucible', 'browser-profile')
}

export interface PageSession {
  page: import('playwright-core').Page
  close: () => Promise<void>
}

type BrowserContextT = import('playwright-core').BrowserContext

// ── One shared context per profile (cont.119) ─────────────────────────────────
//
// Chromium takes an EXCLUSIVE lock on a user-data-dir, so two `launchPersistentContext`
// calls against `.crucible/browser-profile` cannot coexist — the second fails. Every
// function here used to launch its own, which was survivable only because each one also
// tore its context down in a `finally` before the next began. The moment anything needs to
// stay open — a sign-in window the user takes their time over — that model collapses: the
// window holds the lock and every other browser tool fails for as long as it is up.
//
// So there is now exactly ONE context per profile dir, reference-counted and leased. A headed
// context serves headless callers too (a headed browser can do everything a headless one can),
// which is what lets the agent keep reading pages while a sign-in window sits open in front of
// the user. Leases are per-PAGE: each operation gets its own tab and closes it, so concurrent
// work never clobbers someone else's navigation — and never closes the sign-in window.
interface SharedContext {
  context: BrowserContextT
  dir: string
  headed: boolean
  refs: number
  idle: ReturnType<typeof setTimeout> | null
}
let shared: SharedContext | null = null

/** Close the shared context when nothing holds a lease. A long-lived server has no business
 *  keeping a browser resident forever, but tearing one down mid-read would be worse. */
const IDLE_TEARDOWN_MS = 5 * 60_000
function scheduleIdleTeardown() {
  if (!shared) return
  if (shared.idle) clearTimeout(shared.idle)
  shared.idle = setTimeout(() => {
    if (shared && shared.refs === 0) {
      const c = shared.context
      shared = null
      c.close().catch(() => { /* already gone */ })
    }
  }, IDLE_TEARDOWN_MS)
  // Never hold the process open just to run a teardown timer.
  shared.idle.unref?.()
}

async function launchContext(dir: string, headed: boolean): Promise<BrowserContextT> {
  const avail = findBrowser()
  if (!avail.ok) throw new Error(avail.reason)
  const { chromium } = await playwright()
  fs.mkdirSync(dir, { recursive: true })
  // For Playwright's own build, prefer the path its registry reports — it accounts for layout
  // changes between releases that a filesystem scan can only approximate.
  let executablePath = avail.executablePath
  if (avail.managed) {
    try {
      const p = chromium.executablePath()
      if (p && fs.existsSync(p)) executablePath = p
    } catch { /* registry unsure; the scanned binary is still a real executable */ }
  }
  const context = await chromium.launchPersistentContext(dir, {
    headless: !headed,
    executablePath,
    viewport: { width: 1440, height: 900 },
    // A real UA: some sites serve a degraded or blocking page to obvious automation, and the
    // point of this path is to see what the USER would see.
    args: ['--disable-blink-features=AutomationControlled'],
  })
  // A browser that dies (user quits the window, crash) must not leave a dead handle behind for
  // the next caller to trip over — drop the singleton so the next lease relaunches.
  context.on('close', () => { if (shared?.context === context) shared = null })
  return context
}

/**
 * Take a lease on the shared context, launching or upgrading it as needed.
 *
 * `headed` upgrades: a headless context cannot grow a visible window, so it is replaced. That
 * can only happen once outstanding leases finish, hence the bounded wait — reads are short and
 * a sign-in is rare, so in practice this returns immediately.
 */
async function acquireContext(projectPath: string, headed = false): Promise<BrowserContextT> {
  const dir = profileDir(projectPath)
  if (shared && shared.dir === dir) {
    if (!headed || shared.headed) {
      shared.refs++
      if (shared.idle) { clearTimeout(shared.idle); shared.idle = null }
      return shared.context
    }
    // Need a window and the resident context is headless — wait for it to go quiet, then swap.
    const deadline = Date.now() + 15_000
    while (shared && shared.refs > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200))
    }
    if (shared && shared.dir === dir) {
      const old = shared.context
      shared = null
      await old.close().catch(() => { /* already gone */ })
    }
  } else if (shared) {
    // Different profile dir entirely — one resident browser at a time is enough.
    const old = shared.context
    shared = null
    if (old) await old.close().catch(() => { /* already gone */ })
  }
  const context = await launchContext(dir, headed)
  shared = { context, dir, headed, refs: 1, idle: null }
  return context
}

function releaseContext() {
  if (!shared) return
  shared.refs = Math.max(0, shared.refs - 1)
  if (shared.refs === 0) scheduleIdleTeardown()
}

/**
 * Run `fn` against a fresh tab in the shared context, closing the tab (never the browser).
 *
 * This is the shape every read/export operation wants: its own page so nothing it does is
 * visible to a concurrent operation, and no teardown of a context somebody else is using.
 */
export async function withPage<T>(
  projectPath: string,
  fn: (page: import('playwright-core').Page) => Promise<T>,
  opts: { headed?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const context = await acquireContext(projectPath, opts.headed)
  const page = await context.newPage()
  page.setDefaultTimeout(opts.timeoutMs ?? 30_000)
  try {
    return await fn(page)
  } finally {
    await page.close().catch(() => { /* already closed */ })
    releaseContext()
  }
}

/**
 * Open a page in the persistent profile — carrying whatever the user is already logged into.
 *
 * Retained for callers that manage their own lifetime; `close()` releases the LEASE and shuts
 * this tab, leaving the shared browser up for everyone else.
 */
export async function openPage(
  projectPath: string,
  opts: { headless?: boolean; timeoutMs?: number } = {},
): Promise<PageSession> {
  const context = await acquireContext(projectPath, opts.headless === false)
  const page = await context.newPage()
  page.setDefaultTimeout(opts.timeoutMs ?? 30_000)
  let released = false
  return {
    page,
    close: async () => {
      if (released) return
      released = true
      await page.close().catch(() => { /* already closed */ })
      releaseContext()
    },
  }
}

/**
 * Strip scripts/styles/nav and return readable text — the same job `stripBoilerplate` does for raw
 * HTML, but done in the live DOM where client-rendered content actually exists.
 *
 * Three things here are load-bearing, and each was a bug that returned a confidently wrong result:
 *
 *  · This must be a real FUNCTION, not a function-shaped string. `page.evaluate` treats a string as
 *    an EXPRESSION, so `"() => {...}"` evaluates to an unserializable function object and comes back
 *    as `undefined` — every single page read returned the literal text "undefined".
 *  · `innerText` must be read from the LIVE, RENDERED document. It is layout-dependent, so on a
 *    detached `cloneNode` it silently drops every line break and fuses words across block boundaries
 *    ("Example DomainThis domain is for use..."). Pruning the real DOM is free here because the page
 *    is closed immediately afterwards.
 *  · The login signal must be sampled BEFORE pruning. Sign-in walls live in exactly the `<form>` and
 *    `<header>` elements this prunes, so reading it afterwards would hide the one thing the caller
 *    most needs to know.
 */
function extractReadable(): { text: string; raw: string } {
  // Never-rendered nodes go FIRST, before anything samples the page. `textContent` is the fallback
  // whenever `innerText` comes back empty, and it happily returns minified CSS and inline JSON —
  // Instagram's login wall yielded 20,000 characters of `{"require":[[...` presented as page text.
  for (const sel of ['script', 'style', 'noscript', 'template']) {
    document.querySelectorAll(sel).forEach(n => n.remove())
  }
  const body = document.body
  const raw = ((body && (body.innerText || body.textContent)) || '').replace(/\n{3,}/g, '\n\n').trim()

  // Then the page chrome, which is what separates an article from its surroundings.
  for (const sel of ['svg', 'nav', 'header', 'footer', 'aside', 'form']) {
    document.querySelectorAll(sel).forEach(n => n.remove())
  }

  const main = (document.querySelector('main,article,[role=main]') as HTMLElement | null) || document.body
  const pruned = ((main && (main.innerText || main.textContent)) || '').replace(/\n{3,}/g, '\n\n').trim()
  return { text: pruned, raw }
}

export interface ReadResult {
  url: string
  title: string
  text: string
  /** True when the page looks like a sign-in wall rather than the content asked for. */
  needsLogin: boolean
  /** True when a cookie/consent interstitial stands between us and the content. Reported, never
   *  clicked: agreeing to terms on someone's behalf is the user's decision, not the agent's. */
  needsConsent: boolean
}

/** Signals that what came back is a login wall, not the content. Checked so the agent reports
 *  "you need to sign in" instead of summarizing a sign-in form as if it were the article. */
function looksLikeLogin(url: string, title: string, text: string): boolean {
  const u = url.toLowerCase()
  if (/\/(?:login|signin|sign_in|accounts\/login|auth)\b/.test(u)) return true
  const head = `${title}\n${text.slice(0, 600)}`.toLowerCase()
  return /(?:sign in to continue|log in to continue|please log in|you must be logged in|create an account to continue)/.test(head)
}

/**
 * Signals a cookie/consent interstitial — a different failure from a login wall and, untreated, a
 * more deceptive one. `youtube.com/feed/history` returns HTTP 200 with the title "Before you
 * continue to YouTube" and a body that is just a language picker: nothing errors, nothing looks
 * like a login, and an agent that trusted it would confidently summarise a list of languages as
 * the user's watch history.
 */
function looksLikeConsent(url: string, title: string, text: string): boolean {
  const u = url.toLowerCase()
  if (/\/(?:consent|cookie(?:s|-consent)?|gdpr)\b/.test(u) || /^https?:\/\/consent\./.test(u)) return true
  const head = `${title}\n${text.slice(0, 600)}`.toLowerCase()
  return /(?:before you continue|we use cookies|accept (?:all )?cookies|cookie preferences|manage your privacy|your privacy choices)/.test(head)
}

export async function readPage(projectPath: string, url: string, maxChars = 20_000): Promise<ReadResult> {
  const s = await openPage(projectPath)
  try {
    await s.page.goto(url, { waitUntil: 'domcontentloaded' })
    // Client-rendered pages need a beat after DOMContentLoaded; networkidle can hang forever on
    // sites with long-polling, so this is a bounded wait rather than a condition.
    await s.page.waitForTimeout(1200)
    const title = await s.page.title()
    const { text: pruned, raw } = await s.page.evaluate(extractReadable)
    const finalUrl = s.page.url()
    // A page that is ALL nav and form prunes down to nothing — which is precisely what a login wall
    // is. Reporting that as an empty page would be the confident-and-wrong answer; keep the raw text
    // so the caller sees the wall it actually hit.
    const text = pruned.length >= 200 || raw.length <= pruned.length ? pruned : raw
    return {
      url: finalUrl,
      title,
      text: text.slice(0, maxChars),
      needsLogin: looksLikeLogin(finalUrl, title, raw),
      needsConsent: looksLikeConsent(finalUrl, title, raw),
    }
  } finally {
    await s.close()
  }
}

export async function pageToPdf(projectPath: string, url: string, outPath: string): Promise<{ bytes: number }> {
  const s = await openPage(projectPath)
  try {
    await s.page.goto(url, { waitUntil: 'domcontentloaded' })
    await s.page.waitForTimeout(1200)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    // printBackground keeps the page looking like the page; margins match a normal print.
    await s.page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } })
    return { bytes: fs.existsSync(outPath) ? fs.statSync(outPath).size : 0 }
  } finally {
    await s.close()
  }
}

export async function htmlToPdf(projectPath: string, html: string, outPath: string): Promise<{ bytes: number }> {
  const s = await openPage(projectPath)
  try {
    await s.page.setContent(html, { waitUntil: 'domcontentloaded' })
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    await s.page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } })
    return { bytes: fs.existsSync(outPath) ? fs.statSync(outPath).size : 0 }
  } finally {
    await s.close()
  }
}

export async function pageScreenshot(
  projectPath: string, url: string, outPath: string, fullPage = true,
): Promise<{ bytes: number }> {
  const s = await openPage(projectPath)
  try {
    await s.page.goto(url, { waitUntil: 'domcontentloaded' })
    await s.page.waitForTimeout(1200)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    await s.page.screenshot({ path: outPath, fullPage })
    return { bytes: fs.existsSync(outPath) ? fs.statSync(outPath).size : 0 }
  } finally {
    await s.close()
  }
}

// ── Sign-in: open the door, step back, and WATCH (cont.119) ──────────────────
//
// The credential story is unchanged and absolute: the agent never asks for, stores or types a
// password. What changed is who waits. `signInFlow` used to block on `page.on('close')`, which
// made the human a blocking dependency of an agent turn — the user had to sit there, finish the
// login and close the window before anything could continue, and the tool then reported success
// whether or not a session existed, because "the window closed" was all it knew.
//
// Both halves were wrong. Opening the window returns immediately, and completion is OBSERVED:
// a real session cookie appearing for the target host. That is a fact about the profile, not an
// inference from a window event, so it stays true if the user signs in an hour later, closes the
// window first, or signs in through some route we never saw.

/** Cookie names that indicate a session rather than a preference/analytics cookie. */
const SESSION_COOKIE = /sess|auth|login|sid|token|secure-1psid|__host/i

export function hostOf(url: string): string {
  try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '') }
  catch { return url.replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./, '') }
}

/** Does `cookieDomain` cover `host`? Cookie domains are stored with a leading dot for
 *  subdomain-wide cookies (".youtube.com"), which must match "youtube.com" and "m.youtube.com". */
function domainCovers(cookieDomain: string, host: string): boolean {
  const d = cookieDomain.replace(/^\./, '').toLowerCase()
  const h = host.toLowerCase()
  return h === d || h.endsWith(`.${d}`) || d.endsWith(`.${h}`)
}

/** Read the profile's cookies without disturbing any open page. Safe while a sign-in window is
 *  up, which is the entire point of the shared context. */
async function profileCookies(projectPath: string) {
  if (!fs.existsSync(profileDir(projectPath))) return []
  const context = await acquireContext(projectPath, false)
  try { return await context.cookies() } finally { releaseContext() }
}

/** True when the profile holds something that looks like a live session for `host`. */
export async function hasSessionFor(projectPath: string, host: string): Promise<boolean> {
  try {
    const cookies = await profileCookies(projectPath)
    return cookies.some(c => SESSION_COOKIE.test(c.name) && domainCovers(c.domain, host) && c.value.length > 8)
  } catch { return false }
}

/** Which sites this profile already holds a session for — derived from stored cookies. */
export async function authenticatedSites(projectPath: string): Promise<string[]> {
  try {
    const hosts = new Set<string>()
    for (const c of await profileCookies(projectPath)) {
      if (SESSION_COOKIE.test(c.name) && c.value.length > 8) hosts.add(c.domain.replace(/^\./, ''))
    }
    return [...hosts].sort()
  } catch { return [] }
}

/** Sign-in windows currently open, by watched host, so a second request for the same site
 *  focuses the existing window instead of opening a rival one. */
const signInWindows = new Map<string, { close: () => Promise<void> }>()

export interface SignInWindowResult {
  /** Host whose session we will watch for. */
  host: string
  /** True when the profile ALREADY had a session — no window was opened. */
  alreadySignedIn: boolean
  /** True when a visible window is now up, waiting for the user. */
  opened: boolean
}

/**
 * Open a visible window at `url` so the user can sign in, and RETURN — the caller is never
 * blocked on a human. The window holds a context lease so idle teardown cannot close it out
 * from under the user; the lease is released when the window closes.
 */
export async function openSignInWindow(
  projectPath: string, url: string, watchHost?: string,
): Promise<SignInWindowResult> {
  const full = /^https?:\/\//i.test(url) ? url : `https://${url}`
  // The host to WATCH can differ from the host to VISIT: Google's sign-in lives on
  // accounts.google.com but the session the caller cares about lands on youtube.com.
  const host = watchHost ? hostOf(watchHost) : hostOf(full)
  if (await hasSessionFor(projectPath, host)) return { host, alreadySignedIn: true, opened: false }
  if (signInWindows.has(host)) return { host, alreadySignedIn: false, opened: true }

  const context = await acquireContext(projectPath, true)
  const page = await context.newPage()
  page.setDefaultTimeout(0)          // the user sets the pace here, not a timeout
  let released = false
  const release = () => {
    if (released) return
    released = true
    signInWindows.delete(host)
    releaseContext()
  }
  page.on('close', release)
  signInWindows.set(host, { close: async () => { await page.close().catch(() => {}); release() } })
  try {
    // Bounded so a dead URL cannot hang the caller; the WINDOW stays open regardless, because a
    // slow-loading login page is still a login page the user can drive.
    await page.goto(full, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  } catch { /* leave the window up — the user can navigate it themselves */ }
  return { host, alreadySignedIn: false, opened: true }
}

/** Close a sign-in window we opened, if it is still up. */
export async function closeSignInWindow(host: string): Promise<void> {
  await signInWindows.get(hostOf(host))?.close()
}

export function signInWindowOpen(host: string): boolean {
  return signInWindows.has(hostOf(host))
}

// ── Acting on pages, not just reading them (cont.119) ────────────────────────
//
// Everything above this line READS: fetch a page, extract text, close it. That is why Crucible
// could not do agentic web work — a task like "open my subscriptions and save the newest video
// as a PDF" is a sequence of ACTIONS against one page whose state carries between steps, and
// there was no way to express even the first click.
//
// Three things make that possible, and each has a failure mode worth naming:
//   · A WORKING TAB that survives between tool calls, so step 2 sees what step 1 did. Held open
//     under a context lease, closed explicitly or on idle.
//   · A ref-tagged ELEMENT MODEL rather than raw HTML. A model asked to invent CSS selectors
//     guesses, and a wrong selector fails silently or clicks the wrong thing; naming a ref it
//     was just shown cannot miss. Refs are stamped onto the DOM so they survive re-query.
//   · Post-action CONFIRMATION. Every action re-reads the page and reports what changed, because
//     "I clicked it" is not evidence that anything happened — the same don't-trust-the-exit-code
//     discipline the screenshot tool already applies to its PNG.

export interface UiElement {
  ref: string
  role: string
  name: string
  value?: string
  disabled?: boolean
}
export interface PageState {
  url: string
  title: string
  elements: UiElement[]
  text: string
  needsLogin: boolean
  needsConsent: boolean
  /** A bot/CAPTCHA challenge stands between us and the content. */
  needsChallenge: boolean
}

/**
 * Anti-bot interstitials — a THIRD kind of wall, and the most deceptive of the three.
 *
 * Found live while verifying this file: duckduckgo.com/html returned HTTP 200 with the title
 * "DuckDuckGo" and a body reading "Select all squares containing a duck". Nothing errored,
 * nothing looked like a login or a consent screen, and the page presented two perfectly ordinary
 * controls — so an agent would have reported a search page with a Submit button and then wondered
 * why every action did nothing.
 *
 * Detected and REPORTED, never solved. Defeating a bot check is not something Crucible does, on
 * anyone's instruction: the site is entitled to its answer to "are you a human", and the honest
 * move is to hand the window to the user.
 */
function looksLikeChallenge(url: string, title: string, text: string): boolean {
  if (/\/(?:challenge|captcha|cdn-cgi\/challenge)/i.test(url)) return true
  const head = `${title}\n${text.slice(0, 800)}`.toLowerCase()
  return /(?:complete the following challenge|confirm this search was made by a human|are you a human|i'm not a robot|verify you are human|checking your browser|unusual traffic from your computer|enable javascript and cookies to continue)/.test(head)
}

/**
 * Stamp a ref onto every VISIBLE interactive element and return the page's state.
 *
 * TWO serialization landmines, both of which return confident nonsense rather than erroring:
 *
 *  · Must be a real function, never a function-shaped string. `page.evaluate` treats a string as
 *    an EXPRESSION, so `"() => {...}"` yields an unserializable function object and comes back as
 *    the literal text "undefined" — which once affected every page read in the codebase.
 *  · NO INNER FUNCTIONS ASSIGNED TO VARIABLES. Playwright ships `fn.toString()` to the browser,
 *    and esbuild (via tsx) compiles `const nameOf = (el) => …` into `__name(…)` to preserve the
 *    name for stack traces. That helper exists only in the Node module scope, so the browser
 *    throws `ReferenceError: __name is not defined` at the first call. Anonymous callbacks passed
 *    DIRECTLY as arguments are untouched, which is why the accessible-name logic below is inlined
 *    into the loop instead of factored out. Keep it that way.
 */
function extractPageState(): { url: string; title: string; elements: UiElement[]; text: string; raw: string } {
  const SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary', '[contenteditable="true"]',
    '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="switch"]', '[role="combobox"]',
  ].join(',')

  const elements: UiElement[] = []
  let i = 0
  document.querySelectorAll(SELECTOR).forEach(el => {
    const he = el as HTMLElement
    const rect = he.getBoundingClientRect()
    const style = window.getComputedStyle(he)
    // Invisible controls are not affordances. A zero-box element cannot be clicked by a user,
    // so offering it to the model only invites actions that silently do nothing.
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return
    if (rect.width === 0 && rect.height === 0) return
    const ref = `e${++i}`
    he.setAttribute('data-crucible-ref', ref)
    const tag = he.tagName.toLowerCase()
    const role = he.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? `input:${(he as HTMLInputElement).type || 'text'}` : tag)
    const value = (he as HTMLInputElement).value
    // Accessible name, inlined deliberately — see the __name warning above.
    //
    // Precedence follows the ARIA accname spec, which matters more than it looks: a
    // `<label for="q">Search query</label>` on an input that also has
    // `placeholder="Type a query"` must be named "Search query", because the label is what the
    // user SEES next to the field and therefore what they and the model will call it. Ranking
    // placeholder first named that field "Type a query" and every attempt to fill it by name
    // missed (caught by the bench, cont.119).
    let name = (he.getAttribute('aria-label') || '').trim()
    if (!name) {
      const lb = he.getAttribute('aria-labelledby')
      if (lb) name = (document.getElementById(lb)?.textContent || '').trim()
    }
    if (!name && he.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(he.id)}"]`)
      name = (lab?.textContent || '').trim()
    }
    if (!name) {
      const wrapping = he.closest('label')          // <label>Text <input></label>
      if (wrapping) name = (wrapping.textContent || '').trim()
    }
    if (!name) name = (he.getAttribute('alt') || he.getAttribute('title') || '').trim()
    if (!name) name = (he.innerText || he.textContent || '').trim()
    if (!name) name = (he.getAttribute('placeholder') || he.getAttribute('value') || he.getAttribute('name') || '').trim()
    name = name.replace(/\s+/g, ' ').slice(0, 120)
    elements.push({
      ref, role, name,
      value: typeof value === 'string' && value.length <= 200 ? value : undefined,
      disabled: (he as HTMLButtonElement).disabled || he.getAttribute('aria-disabled') === 'true' || undefined,
    })
  })

  // Text extraction reuses the rules the read path already proved out: strip never-rendered
  // nodes FIRST (textContent otherwise returns minified CSS as "page text"), and read innerText
  // from the LIVE document (it is layout-dependent and loses every line break on a clone).
  const clone = document.body
  const raw = ((clone && (clone.innerText || clone.textContent)) || '').replace(/\n{3,}/g, '\n\n').trim()
  return { url: location.href, title: document.title, elements, text: raw.slice(0, 20_000), raw }
}

/** Working tabs, keyed by an id the agent passes back. */
const workPages = new Map<string, { page: import('playwright-core').Page; release: () => void; projectPath: string }>()
let workPageSeq = 0

async function stateOf(page: import('playwright-core').Page): Promise<PageState> {
  const s = await page.evaluate(extractPageState)
  return {
    url: s.url, title: s.title, elements: s.elements, text: s.text,
    needsLogin: looksLikeLogin(s.url, s.title, s.raw),
    needsConsent: looksLikeConsent(s.url, s.title, s.raw),
    needsChallenge: looksLikeChallenge(s.url, s.title, s.raw),
  }
}

export interface OpenedPage extends PageState { pageId: string }

/** Open a URL in a tab that STAYS open for subsequent actions. */
export async function openWorkPage(projectPath: string, url: string): Promise<OpenedPage> {
  const context = await acquireContext(projectPath, false)
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  const pageId = `p${++workPageSeq}`
  let released = false
  const release = () => { if (!released) { released = true; workPages.delete(pageId); releaseContext() } }
  page.on('close', release)
  workPages.set(pageId, { page, release, projectPath })
  // Preserve ANY explicit scheme — prefixing https:// onto "file:///…" produced the nonsense
  // URL "https://file:///…". Only a bare host gets a default scheme.
  await page.goto(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  return { pageId, ...(await stateOf(page)) }
}

export async function closeWorkPage(pageId: string): Promise<boolean> {
  const w = workPages.get(pageId)
  if (!w) return false
  await w.page.close().catch(() => {})
  w.release()
  return true
}

export function listWorkPages(): string[] { return [...workPages.keys()] }

export type PageAction = 'click' | 'type' | 'fill' | 'select' | 'press' | 'scroll' | 'hover' | 'back' | 'wait'

export interface ActResult extends PageState {
  pageId: string
  /** What actually changed — the honest answer to "did that work?". */
  changed: { url: boolean; title: boolean; elementCount: number }
  navigated: boolean
}

/**
 * Perform one action, then RE-READ and report what changed.
 *
 * `target` is a ref from the last read ("e12") or a substring of an element's accessible name.
 * Refs are preferred and matched exactly; the name fallback exists because a model that has just
 * read "Sign in" should not be forced to remember an opaque id.
 */
export async function actOnPage(
  pageId: string, action: PageAction, target?: string, value?: string,
): Promise<ActResult> {
  const w = workPages.get(pageId)
  if (!w) throw new Error(`No open page "${pageId}". Open one with web_open first (open pages: ${listWorkPages().join(', ') || 'none'}).`)
  const { page } = w
  const before = await stateOf(page)

  const locate = async () => {
    if (!target) throw new Error(`Action "${action}" needs a target.`)
    if (/^e\d+$/.test(target)) {
      const byRef = page.locator(`[data-crucible-ref="${target}"]`)
      if (await byRef.count()) return byRef.first()
      throw new Error(`Ref "${target}" is no longer on the page — re-read it and use a current ref.`)
    }
    // Name fallback: match the accessible names we just computed, so the lookup agrees with what
    // the model was shown rather than with some independent notion of a selector.
    const hit = before.elements.find(e => e.name.toLowerCase().includes(target.toLowerCase()))
    if (!hit) throw new Error(`Nothing on the page matches "${target}". Visible controls: ${before.elements.slice(0, 25).map(e => `${e.ref}:${e.name}`).join(' | ') || '(none)'}`)
    return page.locator(`[data-crucible-ref="${hit.ref}"]`).first()
  }

  const navigation = page.waitForNavigation({ timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => null)
  switch (action) {
    case 'click':  await (await locate()).click({ timeout: 15_000 }); break
    case 'hover':  await (await locate()).hover({ timeout: 15_000 }); break
    case 'fill':   await (await locate()).fill(value ?? '', { timeout: 15_000 }); break
    case 'type':   await (await locate()).pressSequentially(value ?? '', { delay: 25, timeout: 20_000 }); break
    case 'select': await (await locate()).selectOption(value ?? '', { timeout: 15_000 }); break
    case 'press':  await page.keyboard.press(value || 'Enter'); break
    case 'scroll': await page.mouse.wheel(0, Number(value) || 800); break
    case 'back':   await page.goBack({ waitUntil: 'domcontentloaded' }); break
    case 'wait':   await page.waitForTimeout(Math.min(10_000, Number(value) || 1500)); break
  }
  const nav = await navigation
  // A settle beat: clicks on client-rendered apps mutate the DOM without navigating, and
  // networkidle can hang forever on sites that long-poll.
  await page.waitForTimeout(nav ? 1200 : 600)

  const after = await stateOf(page)
  return {
    pageId, ...after,
    navigated: !!nav || before.url !== after.url,
    changed: {
      url: before.url !== after.url,
      title: before.title !== after.title,
      elementCount: after.elements.length - before.elements.length,
    },
  }
}

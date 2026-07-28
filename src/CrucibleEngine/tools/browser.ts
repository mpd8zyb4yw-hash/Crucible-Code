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

/**
 * Open a page in the persistent profile — carrying whatever the user is already logged into.
 *
 * `headless` defaults to true for agent work. It must be FALSE when the user is signing in, which
 * is the only time a window should appear: they need to see and drive the login themselves.
 */
export async function openPage(
  projectPath: string,
  opts: { headless?: boolean; timeoutMs?: number } = {},
): Promise<PageSession> {
  const avail = findBrowser()
  if (!avail.ok) throw new Error(avail.reason)
  const { chromium } = await playwright()
  const dir = profileDir(projectPath)
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
    headless: opts.headless !== false,
    executablePath,
    viewport: { width: 1440, height: 900 },
    // A real UA: some sites serve a degraded or blocking page to obvious automation, and the
    // point of this path is to see what the USER would see.
    args: ['--disable-blink-features=AutomationControlled'],
  })
  const page = context.pages()[0] ?? await context.newPage()
  page.setDefaultTimeout(opts.timeoutMs ?? 30_000)
  return { page, close: () => context.close() }
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

/**
 * Open a visible window at a URL so the USER can sign in themselves.
 *
 * The whole credential story: the agent opens the door and steps back. Whatever session is
 * established here persists in the profile and every later headless run inherits it. Resolves
 * when the window closes, so "I have finished logging in" is the user closing the window.
 */
export async function signInFlow(projectPath: string, url: string): Promise<void> {
  const s = await openPage(projectPath, { headless: false, timeoutMs: 0 })
  await s.page.goto(url, { waitUntil: 'domcontentloaded' })
  await new Promise<void>(resolve => {
    s.page.on('close', () => resolve())
    s.page.context().on('close', () => resolve())
  })
}

/** Which sites this profile already holds a session for — derived from stored cookies. */
export async function authenticatedSites(projectPath: string): Promise<string[]> {
  const dir = profileDir(projectPath)
  if (!fs.existsSync(dir)) return []
  try {
    const s = await openPage(projectPath)
    try {
      const cookies = await s.page.context().cookies()
      const hosts = new Set<string>()
      for (const c of cookies) {
        // A session cookie on a domain is the honest signal that a login exists there.
        if (/sess|auth|login|sid|token/i.test(c.name)) hosts.add(c.domain.replace(/^\./, ''))
      }
      return [...hosts].sort()
    } finally { await s.close() }
  } catch { return [] }
}

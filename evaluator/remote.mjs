/**
 * THE CAPABILITY BRIDGE — the evaluator, operable by following ordinary links.
 *
 * ChatGPT's retrieval channel cannot attach an Authorization header or issue
 * arbitrary POSTs, and its shell cannot resolve this hostname at all. So the
 * same evaluator is exposed a second way: one unguessable path, plain GET
 * navigation, HTML with links.
 *
 * THE CAPABILITY IS THE CREDENTIAL. 256 bits, generated separately from the
 * bearer token, and whoever holds the path holds the browser — so the path is
 * never logged, never referred, never indexed, never cached, and can be rotated
 * by deleting one file.
 *
 * It is an ADAPTER, not a second evaluator: every operation below calls the
 * same Evaluator instance the bearer API calls, which is what keeps the
 * read-only guard in force on this route rather than beside it.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CAP_FILE = path.join(HERE, '.capability')

/** Stable across restarts so a pasted URL keeps working; delete the file to revoke. */
export function capability() {
  if (fs.existsSync(CAP_FILE)) return fs.readFileSync(CAP_FILE, 'utf8').trim()
  const cap = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(CAP_FILE, cap, { mode: 0o600 })
  return cap
}

const CAP = capability()

/** Length-checked, constant-time: a wrong path must not be probeable byte by byte. */
const holds = (given) => {
  if (typeof given !== 'string' || given.length !== CAP.length) return false
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(CAP))
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'referrer-policy': 'no-referrer',
}

/** What the last operation did — shown once, at the top of the next state page. */
let last = null

/**
 * The controls as the state page last listed them, so a link can say `?i=3`
 * instead of asking the caller to build a selector. Rebuilt on every render.
 */
let listed = []

const targetOf = (c) => {
  for (const a of ['data-card', 'data-open', 'data-object', 'data-role']) {
    if (c.attrs?.[a]) return c.attrs[a]
  }
  return c.name || ''
}

export async function handle(req, res, url, evaluator) {
  const m = url.pathname.match(/^\/remote\/([a-f0-9]{64})(\/.*)?$/)
  if (!m || !holds(m[1])) return false          // not ours, or wrong capability → caller 404s
  const base = `/remote/${m[1]}`
  const op = (m[2] ?? '/').replace(/^\/+/, '')
  const q = url.searchParams

  const seeOther = (note) => {
    if (note) last = note
    res.writeHead(303, { location: `${base}/`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    res.end()
  }

  const timed = async (label, fn) => {
    const t0 = Date.now()
    try {
      const r = await fn()
      const failed = r && r.ok === false
      last = { action: label, result: failed ? 'failed' : 'success', reason: failed ? r.error : null, ms: Date.now() - t0 }
    } catch (e) {
      last = { action: label, result: 'failed', reason: String(e.message), ms: Date.now() - t0 }
    }
  }

  // ── the PNG, under the same capability and nowhere else ──────────────────
  if (op.startsWith('screenshot')) {
    const png = await evaluator.screenshot({ fullPage: q.get('fullPage') === '1' })
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': png.length,
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
    })
    return res.end(png), true
  }

  // ── operations, each one landing back on the state page ──────────────────
  switch (op) {
    case 'tap': {
      const i = q.get('i')
      const t = i !== null ? (listed[Number(i)]?.target ?? '') : (q.get('t') ?? '')
      await timed(`tap ${t || `#${i}`}`, () => evaluator.tap(t))
      return seeOther(), true
    }
    case 'input': {
      const text = q.get('text') ?? ''
      const target = q.get('target') || null
      await timed(`type “${text.slice(0, 40)}”`, () => evaluator.type(target, text, { submit: q.get('submit') === '1' }))
      return seeOther(), true
    }
    case 'press':
      await timed(`press ${q.get('key') || 'Enter'}`, () => evaluator.press(q.get('key') || 'Enter'))
      return seeOther(), true
    case 'swipe':
      await timed(`swipe ${q.get('direction') || 'left'}`, () => evaluator.swipe(q.get('direction') || 'left'))
      return seeOther(), true
    case 'back':
      await timed('back', () => evaluator.back())
      return seeOther(), true
    case 'reload':
      await timed('reload', () => evaluator.reload())
      return seeOther(), true
    case 'cold_start':
      await timed('cold start', () => evaluator.coldStart({ keepSession: q.get('keepSession') !== '0' }))
      return seeOther(), true
    case 'wait':
      await timed(`wait ${Math.min(Number(q.get('ms')) || 5000, 30_000)}ms`, () =>
        evaluator.settle(Math.min(Number(q.get('ms')) || 5000, 30_000)))
      return seeOther(), true
    case 'probe_write': {
      await timed('probe_write (POST /api/act)', async () => {
        await evaluator.ensure()
        if (!evaluator.page.url().startsWith(evaluator.target)) await evaluator.goto(evaluator.target)
        const status = await evaluator.page.evaluate(async () => {
          const r = await fetch('/api/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: '', params: {} }) })
          return r.status
        })
        return status === 403 ? { ok: true } : { ok: false, error: `expected 403, got ${status}` }
      })
      return seeOther(), true
    }
    case 'clear':
      evaluator.consoleErrors = []
      evaluator.networkFailures = []
      evaluator.apiCalls = []
      evaluator.externalAttempts = []
      last = { action: 'clear logs', result: 'success', ms: 0 }
      return seeOther(), true
  }

  // ── the state page ────────────────────────────────────────────────────────
  const o = await evaluator.observe({ maxText: 1800, maxControls: 50 })
  listed = (o.controls ?? []).map((c) => ({ ...c, target: targetOf(c) })).filter((c) => c.target)

  const A = (href, label) => `<a href="${base}/${href}">${esc(label)}</a>`
  const say = evaluator.apiCalls.filter((c) => c.path === '/api/say')
  const pending = evaluator.apiCalls.filter((c) => c.status === 'pending')
  const inputs = listed.filter((c) => c.role === 'input' || c.role === 'textarea')

  const html = `<!doctype html><meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer"><title>Crucible evaluator</title>
<style>body{font:13px/1.5 ui-monospace,Menlo,monospace;margin:16px;max-width:900px}
h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#888;margin:18px 0 6px;border-bottom:1px solid #ddd;padding-bottom:3px}
a{color:#0645ad}pre{white-space:pre-wrap;background:#f6f6f6;padding:8px;margin:0}
li{margin:2px 0}img{max-width:100%;border:1px solid #ccc}.f{color:#b00}.s{color:#070}</style>
<b>CRUCIBLE EVALUATOR</b> — read-only. Target ${esc(evaluator.target)}.

${last ? `<h2>Last action</h2><pre>${esc(last.action)}
RESULT    <span class="${last.result === 'success' ? 's' : 'f'}">${esc(last.result)}</span>${last.reason ? `
REASON    ${esc(last.reason)}` : ''}
DURATION  ${last.ms} ms</pre>` : ''}

<h2>State</h2><pre>URL       ${esc(o.url)}
SURFACE   ${esc(o.surface ?? '—')}${o.openApp ? `   (open: ${esc(o.openApp)})` : ''}
LOADING   ${o.loading}
DECK      ${esc(o.deck ?? '—')}</pre>

<h2>Operations</h2>
${A('cold_start', 'cold start')} ·
${A('reload', 'reload')} ·
${A('back', 'back')} ·
${A('swipe?direction=left', 'swipe left')} ·
${A('swipe?direction=right', 'swipe right')} ·
${A('wait?ms=5000', 'wait 5s')} ·
${A('wait?ms=15000', 'wait 15s')} ·
${A('press?key=Enter', 'press Enter')} ·
${A('press?key=Escape', 'press Escape')} ·
${A('probe_write', 'probe write-block')} ·
${A('clear', 'clear logs')}

<h2>Screenshot</h2>
${A(`screenshot.png?v=${Date.now()}`, 'open PNG')}
<div><img src="${base}/screenshot.png?v=${Date.now()}" alt="current screen"></div>

<h2>Visible controls (${listed.length})</h2>
<ol>${listed.map((c, i) =>
  `<li>${A(`tap?i=${i}`, c.name || c.target)} <span style="color:#999">${esc(c.role)}${c.value ? ` · value: “${esc(c.value)}”` : ''}${c.attrs ? ` · ${esc(Object.entries(c.attrs).map(([k, v]) => `${k}=${v}`).join(' '))}` : ''}</span></li>`).join('')}</ol>

<h2>Text entry</h2>
${inputs.length
    ? inputs.map((c) => `<div>into <b>${esc(c.name || c.target)}</b>:
  ${A(`input?target=${encodeURIComponent(c.target)}&text=What%20do%20you%20know%20about%20my%20schedule%3F&submit=1`, 'ask about my schedule')} ·
  ${A(`input?target=${encodeURIComponent(c.target)}&text=What%20should%20I%20be%20thinking%20about%20today%3F&submit=1`, 'what should I think about today')}</div>`).join('')
    : '<div style="color:#999">no text field visible</div>'}
<pre>Construct your own:
${esc(base)}/input?target=&lt;control&gt;&amp;text=&lt;urlencoded&gt;&amp;submit=1
${esc(base)}/press?key=Enter
${esc(base)}/tap?t=&lt;control&gt;</pre>

<h2>Requests to Crucible</h2>
<pre>${esc(say.length ? say.slice(-6).map((c) => `POST /api/say   ${c.status}${c.ms ? `   ${c.ms} ms` : ''}   ${c.at}`).join('\n') : 'no /api/say yet')}

PENDING NOW  ${pending.length ? esc(pending.map((c) => c.method + ' ' + c.path).join(', ')) : 'none'}</pre>
<pre>${esc(evaluator.apiCalls.slice(-12).map((c) => `${c.method} ${c.path} ${c.status}${c.ms ? ` ${c.ms}ms` : ''}`).join('\n') || '—')}</pre>

<h2>Visible text</h2><pre>${esc(o.visibleText || '—')}</pre>

<h2>Console errors (${evaluator.consoleErrors.length})</h2>
<pre>${esc(evaluator.consoleErrors.slice(-6).map((e) => e.text).join('\n') || 'none')}</pre>

<h2>Network failures (${evaluator.networkFailures.length})</h2>
<pre>${esc(evaluator.networkFailures.slice(-6).map((n) => `${n.status ?? n.error} ${n.url}`).join('\n') || 'none')}</pre>

<h2>External navigation attempts</h2>
<pre>${esc(evaluator.externalAttempts.length
    ? evaluator.externalAttempts.slice(-6).map((e) => `SCHEME  ${e.scheme ?? '(popup)'}\nURL     ${e.url}\nVIA     ${e.via}`).join('\n\n')
    : 'none — Crucible has not tried to leave the browser yet')}</pre>

<h2>Write blocking</h2>
<pre>read-only. refused: POST /api/act · actions undo · google/disconnect · sources PUT
blocked so far: ${evaluator.blockedWrites.length}
${esc(evaluator.blockedWrites.slice(-4).map((b) => `${b.method} ${b.path}  ${b.at}`).join('\n'))}</pre>
`
  res.writeHead(200, HEADERS)
  return res.end(html), true
}

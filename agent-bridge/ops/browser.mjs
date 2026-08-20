/**
 * Browser operations.
 *
 * A thin pass-through to the evaluator that already exists in evaluator/.
 * No second automation stack: this maps bridge ops onto that HTTP surface and
 * inherits its read-only write guard unchanged.
 */
import { EVAL_BASE, evalToken } from '../config.mjs'
import { Refusal, redact } from '../security.mjs'
import { journal } from '../util.mjs'

async function call(method, path, body) {
  const token = evalToken()
  if (!token) throw new Refusal('EVALUATOR_UNAVAILABLE', 'evaluator/.token not found; start the evaluator service first')
  let r
  try {
    r = await fetch(EVAL_BASE + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    })
  } catch (e) {
    throw new Refusal('EVALUATOR_UNREACHABLE', `evaluator not reachable at ${EVAL_BASE}: ${e.message}`)
  }
  const type = r.headers.get('content-type') ?? ''
  if (type.startsWith('image/')) {
    return { __binary: Buffer.from(await r.arrayBuffer()), mimeType: type }
  }
  const text = await r.text()
  let parsed
  try { parsed = text ? JSON.parse(text) : {} } catch { parsed = { raw: text.slice(0, 4000) } }
  if (!r.ok) throw new Refusal('EVALUATOR_ERROR', `evaluator ${r.status}: ${JSON.stringify(parsed).slice(0, 400)}`)
  return redact(parsed)
}

export async function reachable() {
  try {
    const s = await call('GET', '/status')
    return { ok: true, status: s }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

export const coldStart = (a = {}) => call('POST', '/cold_start', { keepSession: a.keepSession ?? true })
export const observe = () => call('GET', '/observe')
export const tap = (a = {}) => { if (!a.target) throw new Refusal('BAD_ARGS', 'target required'); return call('POST', '/tap', { target: a.target }) }
export const type = (a = {}) => { if (typeof a.text !== 'string') throw new Refusal('BAD_ARGS', 'text required'); return call('POST', '/type', { target: a.target, text: a.text, submit: a.submit ?? false }) }
export const press = (a = {}) => { if (!a.key) throw new Refusal('BAD_ARGS', 'key required'); return call('POST', '/press', { key: a.key }) }
export const swipe = (a = {}) => call('POST', '/swipe', { direction: a.direction ?? 'left' })
export const back = () => call('POST', '/back')
export const reload = () => call('POST', '/reload')
export const wait = (a = {}) => call('POST', '/wait', { ms: Math.min(Number(a.ms) || 1500, 60_000) })
export const inspect = () => call('GET', '/inspect')
export const visibleElements = () => call('GET', '/visible_elements')
export const consoleErrors = () => call('GET', '/console_errors')
export const networkFailures = () => call('GET', '/network_failures')
export const currentUrl = () => call('GET', '/current_url')

export async function probeWrite() {
  const out = await call('POST', '/probe_write')
  journal({ type: 'browser_finding', summary: 'probe_write executed', blocked: out?.blocked ?? out })
  return out
}

export async function screenshot(a = {}) {
  const q = a.fullPage ? '?fullPage=1' : ''
  const out = await call('GET', '/screenshot' + q)
  if (!out.__binary) return out
  return {
    __attachment: { filename: `screenshot-${Date.now()}.png`, data: out.__binary, mimeType: 'image/png' },
    bytes: out.__binary.length,
    full_page: !!a.fullPage,
  }
}

/**
 * One round trip instead of six: everything an agent normally asks for after
 * an interaction, merged into a single compact record.
 */
export async function appInspect() {
  const [obs, ins, errs, fails] = await Promise.all([
    observe().catch((e) => ({ error: e.message })),
    inspect().catch((e) => ({ error: e.message })),
    consoleErrors().catch(() => null),
    networkFailures().catch(() => null),
  ])
  const trim = (v, n) => (typeof v === 'string' ? v.slice(0, n) : v)
  return {
    url: obs?.url ?? ins?.url ?? null,
    surface: obs?.surface ?? null,
    open_app: obs?.openApp ?? null,
    signed_in: ins?.signedIn ?? ins?.signed_in ?? null,
    build: ins?.build ?? null,
    loading: ins?.loading ?? null,
    visible_text: trim(obs?.text ?? obs?.visibleText, 4000),
    controls: obs?.controls ?? obs?.elements ?? null,
    api_calls: ins?.apiCalls ?? ins?.api_calls ?? null,
    console_errors: errs ?? obs?.errors ?? null,
    network_failures: fails ?? null,
    blocked_writes: ins?.blockedWrites ?? ins?.blocked_writes ?? null,
    external_attempts: ins?.externalAttempts ?? ins?.external_attempts ?? null,
  }
}

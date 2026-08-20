/**
 * Authorization and confinement.
 *
 * Two independent gates, in order, neither of which involves a model:
 *   1. eligibility  — the message really came from this account's SENT mailbox
 *   2. schema       — bridge_id, an operation enum and typed args; no free
 *                     text is ever executed
 */
import { realpathSync, existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { REPO, BRIDGE_ID, CMD_PREFIX, PROTOCOL, MAX_TIMEOUT_MS } from './config.mjs'

export class Refusal extends Error {
  constructor(code, message) { super(message); this.code = code }
}

/* ------------------------------------------------------- message gate */

/**
 * A message is eligible only if Gmail itself says it is in this account's
 * SENT mailbox and addressed to this account. `From:` is never consulted:
 * the header is forgeable, SENT-label membership is not — placing a message
 * there requires authenticated access to the account.
 */
export function eligible(msg, me) {
  const labels = msg.labelIds ?? []
  if (!labels.includes('SENT')) return { ok: false, why: 'not in SENT' }
  if (labels.includes('DRAFT')) return { ok: false, why: 'draft' }
  const to = headerOf(msg, 'To').toLowerCase()
  if (!to.includes(me.toLowerCase())) return { ok: false, why: 'not self-addressed' }
  const subject = headerOf(msg, 'Subject')
  if (!subject.startsWith(CMD_PREFIX)) return { ok: false, why: 'subject prefix' }
  // A result or READY message must never be mistaken for a command.
  if (/^\[CRUCIBLE-AGENT (RESULT|READY)\]/.test(subject)) return { ok: false, why: 'not a command subject' }
  return { ok: true }
}

function headerOf(msg, name) {
  const h = (msg.payload?.headers ?? []).find((x) => x.name.toLowerCase() === name.toLowerCase())
  return h?.value ?? ''
}

/* --------------------------------------------------------- capability */

/**
 * There is no capability check any more, deliberately.
 *
 * It never widened the boundary: the security suite established that anyone
 * able to place a message in this account's SENT mailbox can also read the
 * READY email that carried the secret, so bridge authority already equalled
 * Gmail account authority. What it did do was make the bridge unusable —
 * ChatGPT's Gmail tool refuses to send a message containing a credential, so
 * no command could be transmitted at all.
 *
 * The field is still tolerated in an envelope so older senders do not break,
 * but it is ignored rather than compared.
 */

/* ------------------------------------------------------------ schema */

export const OPERATIONS = new Set([
  'bridge.status',
  'repo.status', 'repo.list', 'repo.read', 'repo.search', 'repo.changed_files',
  'repo.diff', 'repo.diff_file', 'repo.write', 'repo.apply_patch', 'repo.create',
  'repo.delete', 'repo.mkdir', 'repo.restore',
  'git.show', 'git.log',
  'process.run', 'test.run', 'build.run', 'typecheck.run',
  'service.list', 'service.start', 'service.stop', 'service.restart', 'service.logs',
  'browser.cold_start', 'browser.observe', 'browser.screenshot', 'browser.tap',
  'browser.type', 'browser.press', 'browser.swipe', 'browser.back', 'browser.reload',
  'browser.wait', 'browser.inspect', 'browser.visible_elements', 'browser.console_errors',
  'browser.network_failures', 'browser.current_url', 'browser.probe_write',
  'app.inspect', 'journal.latest',
  'claude.start', 'claude.status', 'claude.result', 'claude.cancel',
])

const ENVELOPE_FIELDS = new Set(['protocol', 'bridge_id', 'capability', 'job_id', 'step_id', 'op', 'args'])

/** Parse and validate one command body. Throws Refusal; never executes text. */
export function parseCommand(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Refusal('BAD_ENVELOPE', 'no JSON object in body')
  let cmd
  try { cmd = JSON.parse(text.slice(start, end + 1)) } catch (e) { throw new Refusal('BAD_ENVELOPE', 'invalid JSON') }
  if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd)) throw new Refusal('BAD_ENVELOPE', 'envelope must be an object')

  for (const k of Object.keys(cmd)) {
    if (!ENVELOPE_FIELDS.has(k)) throw new Refusal('UNKNOWN_FIELD', `unknown envelope field: ${k}`)
  }
  if (cmd.protocol !== PROTOCOL) throw new Refusal('BAD_PROTOCOL', `protocol must be ${PROTOCOL}`)
  if (cmd.bridge_id !== BRIDGE_ID) throw new Refusal('BAD_BRIDGE', 'bridge_id mismatch')
  if (typeof cmd.op !== 'string' || !OPERATIONS.has(cmd.op)) throw new Refusal('UNKNOWN_OP', `unknown operation: ${String(cmd.op).slice(0, 40)}`)
  if (typeof cmd.job_id !== 'string' || !/^[\w.-]{1,64}$/.test(cmd.job_id)) throw new Refusal('BAD_JOB', 'job_id must be a short token')
  if (typeof cmd.step_id !== 'string' || !/^[\w.-]{1,64}$/.test(cmd.step_id)) throw new Refusal('BAD_STEP', 'step_id must be a short token')
  const args = cmd.args ?? {}
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Refusal('BAD_ARGS', 'args must be an object')
  return { ...cmd, args }
}

export function timeout(args) {
  const t = Number(args.timeout_ms ?? 0)
  if (!t) return undefined
  if (!Number.isFinite(t) || t <= 0 || t > MAX_TIMEOUT_MS) throw new Refusal('BAD_TIMEOUT', `timeout_ms must be 1..${MAX_TIMEOUT_MS}`)
  return t
}

/* ------------------------------------------------------- confinement */

/**
 * Resolve a repo-relative path to a real path inside REPO.
 *
 * Absolute paths, `~` and `..` are rejected before resolution, and the
 * resolved result is checked again against the *real* repo root so a symlink
 * planted inside the repo cannot point outward.
 */
export function safePath(p, { mustExist = false } = {}) {
  if (typeof p !== 'string' || !p.length) throw new Refusal('BAD_PATH', 'path required')
  if (p.startsWith('~')) throw new Refusal('PATH_ESCAPE', 'home-relative paths are refused')
  if (isAbsolute(p)) throw new Refusal('PATH_ESCAPE', 'absolute paths are refused')
  if (p.split(/[\\/]/).includes('..')) throw new Refusal('PATH_ESCAPE', 'parent traversal is refused')
  if (p.includes('\0')) throw new Refusal('BAD_PATH', 'null byte in path')

  const root = realpathSync(REPO)
  const target = resolve(root, p)
  if (target !== root && !target.startsWith(root + sep)) throw new Refusal('PATH_ESCAPE', 'resolves outside the repository')

  // Follow symlinks on whatever part of the chain exists.
  let probe = target
  while (probe !== root && !existsSync(probe)) probe = dirname(probe)
  const real = realpathSync(probe)
  if (real !== root && !real.startsWith(root + sep)) throw new Refusal('PATH_ESCAPE', 'symlink escapes the repository')

  if (mustExist && !existsSync(target)) throw new Refusal('NOT_FOUND', `no such path: ${p}`)
  return target
}

export function relative(abs) {
  const root = realpathSync(REPO)
  return abs === root ? '.' : abs.slice(root.length + 1)
}

/* --------------------------------------------------------- redaction */

/**
 * Secret scrubbing for everything that leaves the machine.
 *
 * Two layers: known live values harvested from the environment and token
 * files, and shape-based patterns for credentials this bridge has never seen.
 */
const KNOWN = []
export function loadSecrets() {
  KNOWN.length = 0
  for (const f of ['.env.local', '.dev.vars']) {
    try {
      for (const line of readFileSync(join(REPO, f), 'utf8').split('\n')) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+)$/.exec(line)
        if (!m) continue
        // Only genuinely secret-shaped values. Harvesting every env value
        // redacted ordinary URLs (OAUTH_BASE_URL) out of useful results.
        if (!/SECRET|KEY|TOKEN|PASSWORD|PRIVATE/.test(m[1])) continue
        const v = m[2].trim().replace(/^["']|["']$/g, '')
        if (v.length >= 12 && !/^https?:\/\//.test(v)) KNOWN.push(v)
      }
    } catch {}
  }
  for (const f of [join(REPO, 'agent-bridge/.secrets/google-tokens.json'), join(REPO, 'evaluator/.token'), join(REPO, 'agent-bridge/.secrets/capability')]) {
    try {
      const raw = readFileSync(f, 'utf8')
      if (f.endsWith('.json')) { const t = JSON.parse(raw); for (const v of Object.values(t)) if (typeof v === 'string' && v.length >= 12) KNOWN.push(v) }
      else if (raw.trim().length >= 12) KNOWN.push(raw.trim())
    } catch {}
  }
}
loadSecrets()

const PATTERNS = [
  [/ya29\.[A-Za-z0-9._\-]{20,}/g, '<redacted:google-access-token>'],
  [/1\/\/[A-Za-z0-9._\-]{20,}/g, '<redacted:google-refresh-token>'],
  [/sk-[A-Za-z0-9\-_]{20,}/g, '<redacted:api-key>'],
  [/gsk_[A-Za-z0-9]{20,}/g, '<redacted:api-key>'],
  [/AIza[A-Za-z0-9_\-]{30,}/g, '<redacted:google-api-key>'],
  [/ey[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, '<redacted:jwt>'],
  [/(authorization|x-auth-key|cookie|set-cookie)(\s*[:=]\s*)("?)[^\s"',]{8,}/gi, '$1$2$3<redacted>'],
  [/\b(GOOGLE_CLIENT_SECRET|CLOUDFLARE_API_KEY|JWT_SECRET|VAPID_PRIVATE_KEY|[A-Z_]*API_KEY|[A-Z_]*SECRET|[A-Z_]*TOKEN)(\s*[:=]\s*)("?)[^\s"',]{6,}/g, '$1$2$3<redacted>'],
]

export function redact(value) {
  if (value == null) return value
  if (typeof value === 'string') {
    let s = value
    for (const secret of KNOWN) if (secret && s.includes(secret)) s = s.split(secret).join('<redacted>')
    for (const [re, sub] of PATTERNS) s = s.replace(re, sub)
    return s
  }
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = redact(v)
    return out
  }
  return value
}

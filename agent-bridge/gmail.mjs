/**
 * Gmail transport.
 *
 * Read side is deliberately narrow: the poller only ever issues a query
 * scoped to the account's own SENT mailbox with the command subject prefix.
 * It has no code path that reads the Inbox, so an inbound message cannot
 * reach the executor even if it copies the subject and forges a From header.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SECRETS, REPO } from './config.mjs'

const TOKENS = join(SECRETS, 'google-tokens.json')
const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

function clientCreds() {
  // Read from the repo's own env file; never echoed anywhere.
  let id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET
  if (!id || !secret) {
    const env = readFileSync(join(REPO, '.env.local'), 'utf8')
    for (const line of env.split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
      if (!m) continue
      if (m[1] === 'GOOGLE_CLIENT_ID') id ??= m[2]
      if (m[1] === 'GOOGLE_CLIENT_SECRET') secret ??= m[2]
    }
  }
  if (!id || !secret) throw new Error('Google client credentials unavailable')
  return { id, secret }
}

let cached = null
export async function accessToken() {
  const t = cached ?? JSON.parse(readFileSync(TOKENS, 'utf8'))
  if (t.access_token && Date.now() < t.expiry - 60_000) { cached = t; return t.access_token }
  const { id, secret } = clientCreds()
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: t.refresh_token, client_id: id, client_secret: secret, grant_type: 'refresh_token' }),
  })
  const b = await r.json()
  if (!r.ok) throw new Error(`token refresh failed: ${b?.error ?? r.status}`)
  const next = {
    access_token: b.access_token,
    // Google omits refresh_token on refresh; keep the original.
    refresh_token: b.refresh_token ?? t.refresh_token,
    expiry: Date.now() + (Number(b.expires_in) || 3600) * 1000,
    scope: b.scope ?? t.scope,
  }
  writeFileSync(TOKENS, JSON.stringify(next), { mode: 0o600 })
  cached = next
  return next.access_token
}

/**
 * One Gmail call, with a short retry on transient failures.
 *
 * Without this a single ETIMEDOUT while sending a result loses that result
 * permanently: the command is already marked executed, so it never replays,
 * and the sender waits for an answer that will never arrive.
 */
async function api(path, init = {}, attempt = 0) {
  const token = await accessToken()
  let r
  try {
    r = await fetch(path.startsWith('http') ? path : API + path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(60_000),
    })
  } catch (e) {
    if (attempt < 3) {
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt))
      return api(path, init, attempt + 1)
    }
    throw new Error(`gmail unreachable: ${e.message}`)
  }
  const text = await r.text()
  const body = text ? JSON.parse(text) : {}
  if (!r.ok) {
    // 429 and 5xx are worth another try; 4xx is not.
    if ((r.status === 429 || r.status >= 500) && attempt < 3) {
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt))
      return api(path, init, attempt + 1)
    }
    throw new Error(`gmail ${r.status}: ${body?.error?.message ?? 'error'}`)
  }
  return body
}

/** The authenticated account, from Gmail itself — never from config. */
export async function profile() {
  const p = await api('/profile')
  return p.emailAddress
}

export async function listIds(q, max = 20) {
  const b = await api(`/messages?maxResults=${max}&q=${encodeURIComponent(q)}`)
  return (b.messages ?? []).map((m) => m.id)
}

export async function getMessage(id) {
  return api(`/messages/${encodeURIComponent(id)}?format=full`)
}

export function header(msg, name) {
  const h = (msg.payload?.headers ?? []).find((x) => x.name.toLowerCase() === name.toLowerCase())
  return h?.value ?? ''
}

/** Concatenate every text/plain part; commands are plain-text JSON. */
export function plainBody(msg) {
  const out = []
  const walk = (p) => {
    if (!p) return
    if (p.mimeType === 'text/plain' && p.body?.data) out.push(Buffer.from(p.body.data, 'base64url').toString('utf8'))
    ;(p.parts ?? []).forEach(walk)
  }
  walk(msg.payload)
  if (!out.length && msg.payload?.body?.data) out.push(Buffer.from(msg.payload.body.data, 'base64url').toString('utf8'))
  return out.join('\n')
}

/* ---------------------------------------------------------------- labels */

export async function ensureLabel(name) {
  const b = await api('/labels')
  const found = (b.labels ?? []).find((l) => l.name === name)
  if (found) return found.id
  const made = await api('/labels', {
    method: 'POST',
    body: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
  })
  return made.id
}

export async function modify(id, addLabelIds = [], removeLabelIds = []) {
  return api(`/messages/${encodeURIComponent(id)}/modify`, {
    method: 'POST',
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  })
}

/* ------------------------------------------------------------------ send */

function mime({ to, subject, text, attachments = [], inReplyTo, references }) {
  const b = `b_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  const head = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
  ].filter(Boolean)

  if (!attachments.length) {
    return [...head, 'Content-Type: text/plain; charset="UTF-8"', '', text].join('\r\n')
  }
  const parts = [
    ...head,
    `Content-Type: multipart/mixed; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    text,
  ]
  for (const a of attachments) {
    const data = Buffer.isBuffer(a.data) ? a.data : Buffer.from(String(a.data), 'utf8')
    parts.push(
      `--${b}`,
      `Content-Type: ${a.mimeType ?? 'application/octet-stream'}; name="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`,
      '',
      data.toString('base64').replace(/(.{76})/g, '$1\r\n')
    )
  }
  parts.push(`--${b}--`, '')
  return parts.join('\r\n')
}

export async function send(opts) {
  const raw = Buffer.from(mime(opts), 'utf8').toString('base64url')
  const body = { raw }
  if (opts.threadId) body.threadId = opts.threadId
  return api('/messages/send', { method: 'POST', body: JSON.stringify(body) })
}

/* --------------------------------------------------------------- test */

/**
 * Insert a message into the mailbox without sending it.
 *
 * Used only by the security self-test, to plant a genuinely forged inbound
 * message — real From header, real Inbox delivery, no SENT label — so the
 * eligibility gate is tested against the actual attack rather than a mock.
 */
export async function importMessage({ from, to, subject, text, labelIds = ['INBOX'] }) {
  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    text,
  ].join('\r\n')
  return api(`/messages/import?internalDateSource=dateHeader&neverMarkSpam=true&processForCalendar=false`, {
    method: 'POST',
    body: JSON.stringify({ raw: Buffer.from(raw, 'utf8').toString('base64url'), labelIds }),
  })
}

export async function deleteMessage(id) {
  const token = await accessToken()
  await fetch(`${API}/messages/${encodeURIComponent(id)}/trash`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
}

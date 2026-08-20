/**
 * The command daemon.
 *
 * Loop: query the account's own SENT mailbox for command-prefixed messages,
 * verify eligibility and schema, execute one at a time, reply in
 * the same thread. It never reads the Inbox, so no received message — however
 * its From header is forged — can reach the executor.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BRIDGE_ID, CMD_PREFIX, INLINE_LIMIT, LABEL_COMMANDS, LABEL_RESULTS, LABEL_ROOT,
  POLL_ACTIVE_MS, POLL_IDLE_MS, PROTOCOL, READY_PREFIX, RESULT_PREFIX, SECRETS, STATE, VERSION,
} from './config.mjs'
import * as gmail from './gmail.mjs'
import { Refusal, eligible, parseCommand, redact } from './security.mjs'
import { execute, state, OPERATION_NAMES } from './executor.mjs'
import { journal } from './util.mjs'

const SEEN = join(STATE, 'processed.json')

function loadSeen() {
  try { return JSON.parse(readFileSync(SEEN, 'utf8')) } catch { return {} }
}
function saveSeen(seen) {
  mkdirSync(STATE, { recursive: true })
  const keys = Object.keys(seen)
  // Bound the ledger; ids are only useful while Gmail still returns them.
  if (keys.length > 5000) for (const k of keys.slice(0, keys.length - 5000)) delete seen[k]
  writeFileSync(SEEN, JSON.stringify(seen, null, 1))
}

const owner = () => readFileSync(join(SECRETS, 'owner'), 'utf8').trim()

let labels = {}
export async function ensureLabels() {
  labels = {
    root: await gmail.ensureLabel(LABEL_ROOT),
    commands: await gmail.ensureLabel(LABEL_COMMANDS),
    results: await gmail.ensureLabel(LABEL_RESULTS),
  }
  return labels
}

/* ------------------------------------------------------------- results */

/**
 * Split a result into a compact body and, when it is large, an attachment.
 * Giant payloads in the body are what make an agent loop expensive to read.
 */
function shape(envelope, result) {
  const attachments = []
  let payload = result

  // A handler may hand back a binary attachment directly (screenshots).
  if (payload?.result?.__attachment) {
    const a = payload.result.__attachment
    attachments.push(a)
    payload = { ...payload, result: { ...payload.result, __attachment: undefined, attachment: a.filename } }
    delete payload.result.__attachment
  }

  let body = JSON.stringify({ ...envelope, ...payload }, null, 1)
  if (body.length > INLINE_LIMIT) {
    const full = JSON.stringify({ ...envelope, ...payload }, null, 1)
    const name = `${envelope.job_id}-${envelope.step_id}.json`
    attachments.push({ filename: name, data: full, mimeType: 'application/json' })
    const summary = {
      ...envelope,
      status: payload.status,
      op: envelope.op,
      duration_ms: payload.duration_ms,
      truncated: true,
      attachment: name,
      note: `Full result is ${full.length} bytes; see the attached ${name}.`,
      preview: JSON.stringify(payload.result ?? payload.error).slice(0, 4000),
    }
    body = JSON.stringify(summary, null, 1)
  }
  return { body, attachments }
}

async function reply(msg, envelope, payload) {
  const { body, attachments } = shape(envelope, payload)
  const me = state.account
  const subject = `${RESULT_PREFIX} ${BRIDGE_ID} ${envelope.job_id} #${envelope.step_id}`
  const sent = await gmail.send({
    to: me,
    subject,
    text: redact(body),
    attachments,
    threadId: msg.threadId,
    inReplyTo: gmail.header(msg, 'Message-ID'),
    references: gmail.header(msg, 'Message-ID'),
  })
  // Keep machine traffic out of the Inbox.
  await gmail.modify(sent.id, [labels.results, labels.root], ['INBOX']).catch(() => {})
  return sent.id
}

/**
 * Pull job/step out of a body that failed validation.
 *
 * A rejected command still needs a correlatable reply — without this the
 * sender gets an error it cannot match to anything it sent.
 */
function correlation(text) {
  try {
    const raw = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    const ok = (v) => (typeof v === 'string' && /^[\w.-]{1,64}$/.test(v) ? v : 'unknown')
    return { job_id: ok(raw?.job_id), step_id: ok(raw?.step_id), op: ok(raw?.op) }
  } catch { return { job_id: 'unknown', step_id: 'unknown', op: 'unknown' } }
}

/* ------------------------------------------------------------ one pass */

/**
 * Commands are processed strictly one at a time.
 *
 * Two overlapping passes would each load the ledger before either wrote it,
 * and both would execute the same message — observed doing exactly that, so
 * the guard is a mutex rather than a check.
 */
let inFlight = null
export function pollOnce(opts = {}) {
  if (inFlight) return inFlight
  inFlight = pollPass(opts).finally(() => { inFlight = null })
  return inFlight
}

async function pollPass({ verbose = false } = {}) {
  const me = state.account
  const seen = loadSeen()
  state.lastPoll = new Date().toISOString()

  const q = `in:sent to:${me} subject:"${CMD_PREFIX}" newer_than:2d`
  let ids
  try { ids = await gmail.listIds(q, 20) } catch (e) { console.error('poll failed:', e.message); return 0 }

  let executed = 0
  for (const id of ids.reverse()) {
    if (seen[id]) continue

    let msg
    try { msg = await gmail.getMessage(id) } catch { continue }

    // Gate 1 — the message really is in this account's SENT mailbox.
    const gate = eligible(msg, me)
    if (!gate.ok) {
      if (verbose) console.log(`skip ${id}: ${gate.why}`)
      seen[id] = { rejected: gate.why, at: Date.now() }
      saveSeen(seen)
      continue
    }

    const subject = gmail.header(msg, 'Subject')
    let cmd
    try {
      // Gate 2 — bridge_id, strict schema and the operation enum.
      cmd = parseCommand(gmail.plainBody(msg))
    } catch (e) {
      const code = e instanceof Refusal ? e.code : 'BAD_ENVELOPE'
      console.log(`reject ${id}: ${code} ${e.message}`)
      journal({ type: 'rejected', code, message: e.message, subject })
      seen[id] = { rejected: code, at: Date.now() }
      saveSeen(seen)
      // A malformed or unauthorized envelope still gets one reply so the
      // sender is not left waiting — but nothing was executed.
      // A wrong bridge_id gets no reply: it is not addressed to this bridge.
      if (code !== 'BAD_BRIDGE') {
        await reply(msg, { protocol: PROTOCOL, bridge_id: BRIDGE_ID, ...correlation(gmail.plainBody(msg)) },
          { status: 'error', error: { code, message: e.message } }).catch(() => {})
      }
      continue
    }

    // Gate 4 — this exact message id has never executed.
    console.log(`exec ${cmd.op} (${cmd.job_id}#${cmd.step_id})`)
    journal({ type: 'command', op: cmd.op, job_id: cmd.job_id, step_id: cmd.step_id, message_id: id })

    // Record before executing: a crash mid-mutation must not replay it.
    seen[id] = { job_id: cmd.job_id, step_id: cmd.step_id, op: cmd.op, started: Date.now(), thread_id: msg.threadId }
    saveSeen(seen)

    const payload = await execute(cmd)
    state.processed += 1
    executed += 1

    const envelope = {
      protocol: PROTOCOL, bridge_id: BRIDGE_ID, job_id: cmd.job_id, step_id: cmd.step_id, op: cmd.op,
    }
    let resultId = null
    try { resultId = await reply(msg, envelope, payload) } catch (e) { console.error('reply failed:', e.message) }

    seen[id] = { ...seen[id], finished: Date.now(), status: payload.status, result_message_id: resultId }
    saveSeen(seen)
    await gmail.modify(id, [labels.commands, labels.root], ['INBOX']).catch(() => {})
  }
  return executed
}

/* -------------------------------------------------------------- ready */

export async function sendReady(extra = {}) {
  const me = state.account
  const st = await execute({ op: 'bridge.status', args: {} })
  const body = {
    protocol: PROTOCOL,
    status: 'ready',
    bridge_id: BRIDGE_ID,
    bridge_version: VERSION,
    account_email: me,
    repo: 'crucible',
    repo_root: st.result?.repo_root,
    git_branch: st.result?.git_branch,
    command_subject_prefix: CMD_PREFIX,
    result_subject_prefix: RESULT_PREFIX,
    envelope: {
      protocol: PROTOCOL, bridge_id: BRIDGE_ID,
      job_id: 'example-001', step_id: '001', op: 'repo.read', args: { path: 'server/world.ts', start_line: 1, end_line: 60 },
    },
    operations: OPERATION_NAMES,
    claude_available: st.result?.claude_available ?? false,
    evaluator_available: st.result?.evaluator_available ?? false,
    notes: [
      'Send commands as plain-text JSON to yourself with the command subject prefix. Only messages in this account SENT mailbox execute.',
      'No secret is required in a command. Authentication is the SENT mailbox plus the bridge_id, so nothing you send contains a credential.',
      'Repo writes are allowed and checkpointed. External account writes (Gmail send, Calendar) remain refused by the browser evaluator.',
      'Pass expected_sha256 from repo.read on any write to avoid clobbering concurrent edits.',
    ],
    ...extra,
  }
  const sent = await gmail.send({
    to: me,
    subject: `${READY_PREFIX} ${BRIDGE_ID}`,
    // Nothing secret travels in this message.
    text: JSON.stringify(body, null, 1),
  })
  await gmail.modify(sent.id, [labels.root, labels.results], ['INBOX']).catch(() => {})
  journal({ type: 'ready', bridge_id: BRIDGE_ID })
  return sent.id
}

/* --------------------------------------------------------------- main */

/**
 * Refuse to run a second daemon.
 *
 * The poll mutex only serializes within one process; two daemons would each
 * read the ledger before the other wrote it and execute the same command
 * twice. The lock makes a second instance impossible rather than unlikely.
 */
function claimLock() {
  mkdirSync(STATE, { recursive: true })
  const lock = join(STATE, 'bridge.lock')
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8').trim())
    let alive = false
    try { process.kill(pid, 0); alive = true } catch {}
    if (alive && pid !== process.pid) {
      throw new Error(`another bridge daemon is already running (pid ${pid}); stop it first`)
    }
  }
  writeFileSync(lock, String(process.pid))
  const release = () => { try { if (Number(readFileSync(lock, 'utf8')) === process.pid) rmSync(lock, { force: true }) } catch {} }
  process.on('exit', release)
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(0) })
}

export async function bootstrap({ lock = false } = {}) {
  if (lock) claimLock()
  const account = await gmail.profile()
  const expected = owner()
  // Identity comes from Gmail, not from config; a mismatch stops the bridge.
  if (account.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`authenticated account ${account} is not the configured bridge owner ${expected}; refusing to run`)
  }
  state.account = account
  await ensureLabels()
  return account
}

export async function loop() {
  await bootstrap({ lock: true })
  console.log(`bridge ${BRIDGE_ID} v${VERSION} up as ${state.account}; polling SENT for ${CMD_PREFIX}`)
  let idle = 0
  for (;;) {
    let n = 0
    try { n = await pollOnce() } catch (e) { console.error('poll error:', e.message) }
    idle = n > 0 ? 0 : idle + 1
    await new Promise((r) => setTimeout(r, idle > 20 ? POLL_IDLE_MS : POLL_ACTIVE_MS))
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  loop().catch((e) => { console.error('fatal:', e.message); process.exit(1) })
}

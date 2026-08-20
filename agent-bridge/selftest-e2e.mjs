/**
 * End-to-end self-test.
 *
 * Drives the complete loop the way ChatGPT will: a real command email sent
 * from the account to itself, consumed by the real poller, executed by the
 * real handlers, answered by a real result email. Nothing here calls the
 * executor directly.
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO } from './config.mjs'
import { bootstrap, pollOnce } from './daemon.mjs'
import { sendCommand, awaitResult } from './client.mjs'
import * as gmail from './gmail.mjs'

const results = []
let pump = null
/** Unique per run: a stale result from an earlier run must never match. */
const JOB = `e2e${Date.now().toString(36)}`
const gitState = () => execSync('git status --porcelain', { cwd: REPO }).toString()

function check(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + String(detail).slice(0, 160) : ''}`)
  return pass
}

/** Send one command and wait for its result, with the poller running. */
async function step(step_id, op, args = {}, { job_id = JOB, timeout_ms = 180_000 } = {}) {
  const sent = await sendCommand({ job_id, step_id, op, args })
  const got = await awaitResult({ job_id, step_id, timeout_ms })
  return { sent, ...(got ?? {}) }
}

export async function run() {
  const me = await bootstrap()
  console.log(`e2e as ${me}\n`)
  const before = gitState()

  // Drive the poller only if no daemon is already running. Two pollers in
  // two processes would each read the ledger before the other wrote it and
  // execute the same command twice — the cross-process lock guards the
  // daemon, not an ad-hoc pump in the test.
  const lock = join(REPO, '.agent-bridge', 'bridge.lock')
  let live = false
  if (existsSync(lock)) {
    try { process.kill(Number(readFileSync(lock, 'utf8').trim()), 0); live = true } catch {}
  }
  console.log(live ? 'a daemon is running; exercising the deployed poller\n' : 'no daemon; driving the poller from the test\n')
  if (!live) pump = setInterval(() => { pollOnce().catch(() => {}) }, 2500)

  /* --- inspection ------------------------------------------------- */
  const status = await step('001', 'bridge.status')
  check('bridge.status', status?.result?.status === 'ok', status?.result?.result?.git_branch)

  const repoStatus = await step('002', 'repo.status')
  check('repo.status', repoStatus?.result?.result?.repo_root === REPO, repoStatus?.result?.result?.branch)

  const search = await step('003', 'repo.search', { query: 'mutateWorld', max: 5 })
  check('repo.search finds a known symbol', (search?.result?.result?.total ?? 0) > 0, `${search?.result?.result?.total} hits`)

  const read = await step('004', 'repo.read', { path: 'server/world.ts', start_line: 1, end_line: 20 })
  check('repo.read returns a line range with a hash',
    !!read?.result?.result?.sha256 && read?.result?.result?.end_line === 20)

  /* --- reversible code path ---------------------------------------- */
  const probe = '.agent-bridge/tests/probe.txt'
  const created = await step('005', 'repo.create', { path: probe, content: 'alpha\nbeta\n' })
  check('repo.create writes a temporary file', created?.result?.status === 'ok', created?.result?.error?.message)

  const readBack = await step('006', 'repo.read', { path: probe })
  const sha = readBack?.result?.result?.sha256
  check('repo.read reads it back', readBack?.result?.result?.content === 'alpha\nbeta\n')

  const stale = await step('007', 'repo.write', { path: probe, content: 'nope', expected_sha256: 'deadbeef' })
  check('stale write is refused', stale?.result?.error?.code === 'STALE_FILE', stale?.result?.error?.code)

  const fresh = await step('008', 'repo.write', { path: probe, content: 'alpha\nbeta\ngamma\n', expected_sha256: sha })
  check('write with the correct hash succeeds', fresh?.result?.status === 'ok', fresh?.result?.error?.message)

  const patch = [
    `--- a/${probe}`,
    `+++ b/${probe}`,
    '@@ -1,3 +1,3 @@',
    ' alpha',
    '-beta',
    '+BETA',
    ' gamma',
    '',
  ].join('\n')
  const patched = await step('009', 'repo.apply_patch', { patch })
  check('repo.apply_patch applies a unified diff', patched?.result?.status === 'ok', patched?.result?.error?.message)

  const verify = await step('010', 'repo.read', { path: probe })
  check('patched content is correct', verify?.result?.result?.content === 'alpha\nBETA\ngamma\n', verify?.result?.result?.content)

  const deleted = await step('011', 'repo.delete', { path: probe })
  const ck = deleted?.result?.result?.checkpoint_id
  check('repo.delete removes it and returns a checkpoint', !!ck && !existsSync(join(REPO, probe)))

  const restored = await step('012', 'repo.restore', { checkpoint_id: ck })
  check('repo.restore brings it back', restored?.result?.status === 'ok' && existsSync(join(REPO, probe)),
    restored?.result?.error?.message)

  await step('013', 'repo.delete', { path: probe })
  check('temporary file cleaned up', !existsSync(join(REPO, probe)))
  check('repository source files were untouched', gitState() === before)

  /* --- idempotency -------------------------------------------------- */
  // Re-poll the very message that already ran: it must not execute again.
  const seenPath = join(REPO, '.agent-bridge', 'processed.json')
  const seenBefore = JSON.parse(readFileSync(seenPath, 'utf8'))
  const key = Object.keys(seenBefore).find((k) => seenBefore[k]?.step_id === '009')
  // Re-poll only when this process owns polling; otherwise just re-read the
  // ledger, which the live daemon has been maintaining.
  if (!live) await pollOnce()
  else await new Promise((r) => setTimeout(r, 4000))
  const seenAfter = JSON.parse(readFileSync(seenPath, 'utf8'))
  check('replayed command does not execute twice',
    key && seenAfter[key]?.finished === seenBefore[key]?.finished, `ledger entry ${key ? 'stable' : 'missing'}`)

  /* --- project test -------------------------------------------------- */
  const test = await step('014', 'test.run', { suite: 'edge', timeout_ms: 300_000 }, { timeout_ms: 360_000 })
  check('test.run runs a real project suite', test?.result?.result?.exit === 0,
    `exit ${test?.result?.result?.exit} in ${test?.result?.result?.duration_ms}ms`)

  /* --- browser -------------------------------------------------------- */
  const cold = await step('015', 'browser.cold_start', {}, { timeout_ms: 240_000 })
  check('browser.cold_start', cold?.result?.status === 'ok', cold?.result?.error?.message)

  const observe = await step('016', 'browser.observe')
  check('browser.observe returns the live surface', !!observe?.result?.result,
    observe?.result?.result?.url ?? observe?.result?.error?.message)

  const tap = await step('017', 'browser.tap', { target: 'calendar' })
  check('browser.tap a harmless domain', tap?.result?.status === 'ok', tap?.result?.error?.message)

  const back = await step('018', 'browser.back')
  check('browser.back', back?.result?.status === 'ok', back?.result?.error?.message)

  const shot = await step('019', 'browser.screenshot')
  const shotMsg = shot?.message
  const hasPng = !!shotMsg && JSON.stringify(shotMsg.payload ?? {}).includes('image/png')
  check('browser.screenshot returns a PNG attachment', hasPng, `${shot?.result?.result?.bytes ?? '?'} bytes`)

  const probeWrite = await step('020', 'browser.probe_write')
  const pw = JSON.stringify(probeWrite?.result?.result ?? probeWrite?.result?.error ?? {})
  check('browser.probe_write: external write still refused', /403|blocked|refus/i.test(pw), pw.slice(0, 120))

  const app = await step('021', 'app.inspect')
  check('app.inspect returns a combined record', !!app?.result?.result, app?.result?.result?.url)

  const journal = await step('022', 'journal.latest', { limit: 10 })
  check('journal.latest', (journal?.result?.result?.events?.length ?? 0) > 0)

  /* --- rejection over the real transport ------------------------------ */
  const badOp = await sendCommand({ job_id: JOB, step_id: '023', op: 'repo.status', args: {} })
  // A genuinely unknown op cannot be sent through the typed client, so send raw.
  const rawBad = await gmail.send({
    to: me,
    subject: `[CRUCIBLE-AGENT] ${(await import('./config.mjs')).BRIDGE_ID} ${JOB}`,
    text: JSON.stringify({ protocol: 1, bridge_id: (await import('./config.mjs')).BRIDGE_ID,
      job_id: JOB, step_id: '024', op: 'repo.exfiltrate', args: {} }),
  })
  const badResult = await awaitResult({ job_id: JOB, step_id: '024', timeout_ms: 120_000 })
  check('unknown op over the real transport is refused',
    badResult?.result?.error?.code === 'UNKNOWN_OP', badResult?.result?.error?.code)

  const traversal = await step('025', 'repo.read', { path: '../../etc/passwd' })
  check('path traversal over the real transport is refused',
    traversal?.result?.error?.code === 'PATH_ESCAPE', traversal?.result?.error?.code)

  const shell = await step('026', 'process.run', { program: 'bash', args: ['-c', 'echo pwned'] })
  check('bash -c over the real transport is refused',
    shell?.result?.error?.code === 'PROGRAM_NOT_ALLOWED', shell?.result?.error?.code)

  clearInterval(pump)
  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} end-to-end assertions passed`)
  return { results, failed }
}

if (import.meta.url.endsWith(process.argv[1]?.split('/').pop() ?? '')) {
  try {
    const { failed } = await run()
    process.exit(failed.length ? 1 : 0)
  } finally { if (pump) clearInterval(pump) }
}

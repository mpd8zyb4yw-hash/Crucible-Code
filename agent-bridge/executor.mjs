/**
 * The deterministic executor.
 *
 * A table from operation name to function. No model sits between an incoming
 * envelope and this table: `parseCommand` has already proved the op is one of
 * the enumerated names, and each handler validates its own arguments.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { BRIDGE_ID, EVAL_BASE, REPO, STATE, VERSION, ALLOWED_PROGRAMS } from './config.mjs'
import { Refusal } from './security.mjs'
import { journalLatest, listCheckpoints } from './util.mjs'
import * as repo from './ops/repo.mjs'
import * as exec from './ops/exec.mjs'
import * as service from './ops/service.mjs'
import * as browser from './ops/browser.mjs'
import * as claude from './ops/claude.mjs'

const started = Date.now()
export const state = { lastPoll: null, processed: 0, account: null }

async function bridgeStatus() {
  const st = await repo.status()
  const [evaluator, claudeVersion] = await Promise.all([browser.reachable(), claude.available().catch(() => null)])
  return {
    bridge_version: VERSION,
    bridge_id: BRIDGE_ID,
    account_email: state.account,
    repo_root: REPO,
    git_branch: st.branch,
    dirty: st.dirty,
    changed_count: st.changed_count,
    head: st.head,
    uptime_sec: Math.round((Date.now() - started) / 1000),
    last_gmail_poll: state.lastPoll,
    processed_commands: state.processed,
    evaluator_available: evaluator.ok,
    browser_alive: evaluator.ok ? (evaluator.status?.browser ?? null) : null,
    evaluator_base: EVAL_BASE,
    claude_available: !!claudeVersion,
    claude_version: claudeVersion,
    services: (await service.list()).services,
    allowed_programs: ALLOWED_PROGRAMS,
    npm_scripts: Object.keys(exec.scripts()),
    recent_checkpoints: listCheckpoints(5),
  }
}

export const HANDLERS = {
  'bridge.status': bridgeStatus,

  'repo.status': repo.status,
  'repo.list': repo.list,
  'repo.read': repo.read,
  'repo.search': repo.search,
  'repo.changed_files': repo.changedFiles,
  'repo.diff': repo.diff,
  'repo.diff_file': repo.diffFile,
  'repo.write': repo.write,
  'repo.apply_patch': repo.applyPatch,
  'repo.create': repo.create,
  'repo.delete': repo.remove,
  'repo.mkdir': repo.mkdir,
  'repo.restore': repo.restore,
  'git.show': repo.show,
  'git.log': repo.log,

  'process.run': exec.processRun,
  'test.run': exec.testRun,
  'build.run': exec.buildRun,
  'typecheck.run': exec.typecheckRun,

  'service.list': service.list,
  'service.start': service.start,
  'service.stop': service.stop,
  'service.restart': service.restart,
  'service.logs': service.logs,

  'browser.cold_start': browser.coldStart,
  'browser.observe': browser.observe,
  'browser.screenshot': browser.screenshot,
  'browser.tap': browser.tap,
  'browser.type': browser.type,
  'browser.press': browser.press,
  'browser.swipe': browser.swipe,
  'browser.back': browser.back,
  'browser.reload': browser.reload,
  'browser.wait': browser.wait,
  'browser.inspect': browser.inspect,
  'browser.visible_elements': browser.visibleElements,
  'browser.console_errors': browser.consoleErrors,
  'browser.network_failures': browser.networkFailures,
  'browser.current_url': browser.currentUrl,
  'browser.probe_write': browser.probeWrite,

  'app.inspect': browser.appInspect,
  'journal.latest': async (a = {}) => ({ events: journalLatest(Number(a.limit) || 40) }),

  'claude.start': claude.start,
  'claude.status': claude.status,
  'claude.result': claude.result,
  'claude.cancel': claude.cancel,
}

export const OPERATION_NAMES = Object.keys(HANDLERS)

/** Execute one validated command. Never throws; failures become error results. */
export async function execute(cmd) {
  const handler = HANDLERS[cmd.op]
  if (!handler) return { status: 'error', error: { code: 'UNKNOWN_OP', message: `no handler for ${cmd.op}` } }
  const t0 = Date.now()
  try {
    const result = await handler(cmd.args ?? {})
    return { status: 'ok', duration_ms: Date.now() - t0, result }
  } catch (e) {
    const code = e instanceof Refusal ? e.code : 'ERROR'
    return { status: 'error', duration_ms: Date.now() - t0, error: { code, message: String(e?.message ?? e).slice(0, 1200) } }
  }
}

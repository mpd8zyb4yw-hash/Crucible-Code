/**
 * Agent bridge configuration.
 *
 * One place for every root, prefix and limit. Nothing here is a secret; the
 * secrets live in agent-bridge/.secrets/ at mode 600 and are read at startup.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BRIDGE_DIR = dirname(fileURLToPath(import.meta.url))
/** The Crucible repo. Every filesystem operation is confined to this root. */
export const REPO = dirname(BRIDGE_DIR)
export const STATE = join(REPO, '.agent-bridge')
export const SECRETS = join(BRIDGE_DIR, '.secrets')

export const VERSION = '1.0.0'
export const PROTOCOL = 1

/** Subject prefixes. Commands and results must never match each other. */
export const CMD_PREFIX = '[CRUCIBLE-AGENT]'
export const RESULT_PREFIX = '[CRUCIBLE-AGENT RESULT]'
export const READY_PREFIX = '[CRUCIBLE-AGENT READY]'

export const LABEL_ROOT = 'Crucible-Agent'
export const LABEL_COMMANDS = 'Crucible-Agent/Commands'
export const LABEL_RESULTS = 'Crucible-Agent/Results'

/** Bodies stay small; anything larger becomes an attachment. */
export const INLINE_LIMIT = 24_000
export const SEARCH_MAX = 200
export const POLL_ACTIVE_MS = 2_500
export const POLL_IDLE_MS = 15_000
export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 900_000

/**
 * Executables `process.run` may invoke, resolved to real paths at call time.
 * There is no shell in this list on purpose: no sh, bash, zsh, env, perl,
 * python -c, xargs or anything else that takes a program as a string argument.
 */
export const ALLOWED_PROGRAMS = ['git', 'npm', 'npx', 'node', 'rg', 'tsx', 'tsc', 'vite', 'wrangler', 'cloudflared', 'claude']

const read = (name) => { try { return readFileSync(join(SECRETS, name), 'utf8').trim() } catch { return null } }
export const BRIDGE_ID = read('bridge_id')

export const EVAL_PORT = Number(process.env.EVAL_PORT || 8899)
export const EVAL_BASE = `http://127.0.0.1:${EVAL_PORT}`
export function evalToken() { try { return readFileSync(join(REPO, 'evaluator', '.token'), 'utf8').trim() } catch { return null } }

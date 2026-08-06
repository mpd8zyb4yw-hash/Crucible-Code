// Agent-facing tools for enabled integrations (Integrations drawer).
//
// Every integration tool executes the binary DIRECTLY via execFile (argv array,
// no shell) with cwd = the project — there is no quoting/injection surface.
// Visibility contract (three layers, all required):
//   1. loop.ts hides tools whose integration is disabled (model never sees them),
//   2. run() re-checks enablement (drawer toggle mid-task must take effect),
//   3. GitHub WRITES additionally need per-action human approval (HITL) — the
//      model must set approved_by_user only after the user okayed that action
//      in conversation. Read-only gh queries and read-only analyzers run freely
//      (AFK-safe); everything that touches the outside world stays HITL.

import { execFile } from 'child_process'
import type { ToolDef, ToolCtx, ToolResult } from '../tools/protocol'
import { capOutput } from '../tools/registry'
import { isIntegrationEnabled, listIntegrations, type IntegrationStatus } from './registry'

const EXEC_TIMEOUT_MS = 60_000
const MAX_ARGS = 64

function runBinary(command: string, args: string[], ctx: ToolCtx): Promise<ToolResult> {
  return new Promise(resolve => {
    execFile(command, args, {
      cwd: ctx.projectPath,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', CLICOLOR: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    }, (err, stdout, stderr) => {
      const both = [stdout?.toString() ?? '', stderr?.toString() ?? ''].filter(Boolean).join('\n')
      if (err) {
        const why = (err as any).killed ? `timed out after ${EXEC_TIMEOUT_MS / 1000}s` : (err.message ?? 'failed')
        resolve({ ok: false, output: capOutput(`${command} ${why}\n${both}`.trim()).output })
      } else {
        const capped = capOutput(both || '(no output)')
        resolve({ ok: true, output: capped.output, truncated: capped.truncated })
      }
    })
  })
}

function validateArgs(raw: unknown): { ok: true; args: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'args must be an array of strings (argv, not a shell string).' }
  if (raw.length > MAX_ARGS) return { ok: false, error: `Too many arguments (max ${MAX_ARGS}).` }
  const args = raw.map(a => String(a))
  if (args.some(a => a.includes('\0'))) return { ok: false, error: 'Null bytes are not allowed in arguments.' }
  return { ok: true, args }
}

// ── GitHub (gh) — read-only allowlist + HITL for writes ──────────────────────
// A gh invocation is AFK-safe iff its subcommand path is on this list. Everything
// else (pr create/merge/close, issue comment, repo delete, api, workflow run, …)
// writes to GitHub and needs the user's explicit per-action approval. `gh api`
// is ALWAYS treated as a write: it can hit any REST/GraphQL mutation and
// classifying its flags reliably is exactly the kind of cleverness that fails.

const GH_READONLY_PREFIXES = [
  'auth status', 'status',
  'pr list', 'pr view', 'pr diff', 'pr checks', 'pr status',
  'issue list', 'issue view', 'issue status',
  'repo view', 'repo list',
  'run list', 'run view', 'run watch',
  'release list', 'release view',
  'workflow list', 'workflow view',
  'gist list', 'gist view',
  'label list', 'search',
]

export function ghIsReadOnly(args: string[]): boolean {
  // Match on the leading non-flag tokens so `pr view 12 --json state` classifies
  // by "pr view", and a flag smuggled first (`--repo x pr merge`) can't shift it.
  const words = args.filter(a => !a.startsWith('-')).slice(0, 2).join(' ')
  return GH_READONLY_PREFIXES.some(p => words === p || words.startsWith(p + ' ') || (p.split(' ').length === 1 && words.split(' ')[0] === p))
}

function githubTool(): ToolDef {
  return {
    name: 'github',
    integrationId: 'github',
    mutates: true,   // can write to GitHub — read-only paths are exempted inside run()
    description: [
      'Run the GitHub CLI (gh) in the project repo. Pass argv as an array, e.g. ["pr","list","--state","open"].',
      'Read-only queries (pr/issue/repo/run/release list/view/diff/checks, search, status) run immediately.',
      'ANY action that writes to GitHub (create/merge/close/comment/edit/delete, workflow run, gh api, …) is refused unless approved_by_user is true.',
      'Set approved_by_user ONLY after the user has explicitly approved that exact action in this conversation — never preemptively.',
    ].join(' '),
    params: {
      type: 'object',
      properties: {
        args: { type: 'array', items: { type: 'string' }, description: 'gh argv, e.g. ["issue","view","42"]' },
        approved_by_user: { type: 'boolean', description: 'true ONLY if the user explicitly approved this exact write action.' },
      },
      required: ['args'],
    },
    async run(args, ctx) {
      if (!isIntegrationEnabled('github')) {
        return { ok: false, output: 'GitHub integration is disabled. Ask the user to enable it in the Integrations drawer.' }
      }
      const v = validateArgs(args.args)
      if (!v.ok) return { ok: false, output: v.error }
      const readOnly = ghIsReadOnly(v.args)
      if (!readOnly) {
        if (ctx.allowMutation === false) {
          return { ok: false, output: 'This gh command writes to GitHub and mutation is not permitted in this context.' }
        }
        if (args.approved_by_user !== true) {
          return {
            ok: false,
            output: `HITL: "gh ${v.args.join(' ')}" would write to GitHub. Describe the action to the user, ask for approval, and retry with approved_by_user:true only after they say yes.`,
          }
        }
      }
      return runBinary('gh', v.args, ctx)
    },
  }
}

// ── Generic CLI integrations (ripgrep, jq, semgrep, user-added) ──────────────
// Known-read-only builtin analyzers are AFK-safe; unknown user-added CLIs are
// conservatively marked mutating so verify-style contexts (allowMutation:false)
// exclude them.

const READONLY_BUILTIN_IDS = new Set(['ripgrep', 'jq', 'semgrep'])

export function toolNameForIntegration(e: { id: string }): string {
  return e.id.replace(/-/g, '_')
}

export function cliToolForEntry(e: IntegrationStatus): ToolDef {
  const readOnly = READONLY_BUILTIN_IDS.has(e.id)
  return {
    name: toolNameForIntegration(e),
    integrationId: e.id,
    mutates: !readOnly,
    description: `${e.description} Runs the locally-installed \`${e.command}\` binary with argv args (array of strings, no shell) in the project directory.`,
    params: {
      type: 'object',
      properties: {
        args: { type: 'array', items: { type: 'string' }, description: `argv for ${e.command}` },
      },
      required: ['args'],
    },
    async run(args, ctx) {
      if (!isIntegrationEnabled(e.id)) {
        return { ok: false, output: `${e.name} is disabled. Ask the user to enable it in the Integrations drawer.` }
      }
      const v = validateArgs(args.args)
      if (!v.ok) return { ok: false, output: v.error }
      return runBinary(e.command, v.args, ctx)
    },
  }
}

/** Register every known integration's tool. Called once at server start; the add
 *  endpoint registers newly-added custom integrations immediately via the same
 *  register callback, so no restart is needed. Enable/disable needs NO
 *  registration change — visibility is enforced at list time (loop.ts) and call
 *  time (run() re-check). */
export async function registerIntegrationTools(register: (def: ToolDef) => void, existing: (name: string) => boolean): Promise<number> {
  let n = 0
  for (const e of await listIntegrations()) {
    const def = e.id === 'github' ? githubTool() : cliToolForEntry(e)
    if (existing(def.name)) continue   // never shadow a built-in agent tool
    register(def)
    n++
  }
  return n
}

// The agent loop — sustained plan→act→observe on the main request path.
// Provider-agnostic: the server supplies driveTurn (one model turn with tools).
// Lightweight by design: observation compression, hard caps, AbortSignal everywhere.

import fs from 'fs'
import path from 'path'
import { registry } from '../tools/registry'
import { isIntegrationEnabled } from '../integrations/registry'
import { debugBus } from '../debug/bus'
import { recordGate } from '../debug/gateTelemetry'
import { buildWorldContext, buildReflectionPrompt, appendWorldFact, appendReflection, touchNode, loadGraph, saveGraph } from '../state/world'
import type { ToolCall, ToolCtx, ToolDef } from '../tools/protocol'
import { maybeCompressMessages } from '../contextManager'
import { createAnchor, validateCompression, deleteAnchor } from '../contextAnchor'
import { renderPlaybook } from './macCapabilities'
import { runLocalHardenCheck, splitSources } from './localHardenCheck'
import { runLocalHardenFuzz } from './localHardenFuzz'
import { resolveAmbiguity } from '../ambiguity'
import { assessStakes } from './stakesRouter'
import { ensureSemanticIndex } from '../state/semanticIndex'

export interface DriveTurnResult {
  text: string
  toolCalls: ToolCall[]
}

export type DriveTurn = (
  messages: Array<Record<string, unknown>>,
  tools: ToolDef[],
  signal?: AbortSignal,
  /** 'hard' = quality-first (top coder); 'glue' = speed-first (fast judge/plan/read turns);
   *  'critic' = final correctness audit (grounding/harden) — routes to the strong online free
   *  pool with FULL reasoning, bypassing the on-device FM. Measured: the tiny FM is at chance
   *  on distinguishing subtle-but-real bugs from correct code (2/4 on the critic bench, both
   *  prompt extremes), while gpt-oss-120b scores 4/4. Correctness-judging is exactly the
   *  rare, high-value, once-per-task call where escalating to a stronger $0 model is worth it.
   *  Optional + defaulted by the driver, so existing callers are unaffected. */
  turnClass?: 'glue' | 'hard' | 'critic',
) => Promise<DriveTurnResult>

export interface VerifyResult {
  passed: boolean
  signal: 'compile' | 'test' | 'runtime' | 'lint' | 'none'
  report: string
  hints?: string[]
  /** Set by the verifier when healing should stop (heal cap hit or repeated failure fingerprint). */
  escalate?: boolean
  /** True only when signal === 'none': nothing was actually run to produce `passed`.
   *  `passed` stays true so the loop doesn't thrash retrying a check that doesn't exist —
   *  but callers/consumers (debug history, audits) must not read `passed: true` here as
   *  "verification succeeded." It means "nothing was verified." */
  unverified?: boolean
}

export interface AgentLoopOpts {
  goal: string
  projectPath: string
  userId?: string
  driveTurn: DriveTurn
  emit: (event: Record<string, unknown>) => void
  signal?: AbortSignal
  maxIters?: number
  budgetTokens?: number
  /** Section 4 plugs in execution-driven verification; default accepts the final answer. */
  verify?: (finalText: string, ctx: ToolCtx) => Promise<VerifyResult>
  systemPreamble?: string
  allowMutation?: boolean
  /** Resume from a saved checkpoint — used instead of the default [system, user] start. */
  initialMessages?: Array<Record<string, unknown>>
  /** Called after every iteration with current messages — for checkpoint persistence. */
  onCheckpoint?: (messages: Array<Record<string, unknown>>, iter: number) => void
  /** Step context forwarded into iter_progress events. */
  stepIndex?: number
  stepTotal?: number
  stepIntent?: string
  /** Called when a file-mutating tool writes; used to keep the codebase index fresh. */
  onFileMutated?: (absPaths: string[]) => void
  /** I4 — lets the consult_specialist tool ask another archetype a focused question. */
  consultSpecialist?: ToolCtx['consultSpecialist']
  /** Optional text-only model call for model-assisted context compression.
   *  When provided, compression summaries are model-generated for higher fidelity.
   *  Falls back to structural summarisation when absent. */
  compressCallModel?: (messages: Array<{ role: string; content: string }>) => Promise<string>
  /** Grounding gate — before accepting a final answer on an action task (one that
   *  used tools), audit the claimed outcome against the actual tool evidence and
   *  force a correction when they contradict. Default ON; pass false for inner/
   *  subtask loops that already have a downstream critic (e.g. meta-router). */
  groundFinal?: boolean
  /** Adversarial harden pass — after the code verifies, run ONE senior-reviewer critic
   *  that hunts for correctness bugs / missing edge cases the agent's own tests didn't
   *  cover, and bounce the findings back for a fix. Only fires when a real execution check
   *  passed (a coding task). Default OFF; the server enables it for coding loops. */
  hardenFinal?: boolean
}

export interface AgentLoopResult {
  ok: boolean
  finalText: string
  iters: number
  toolCallCount: number
  stopped: 'final' | 'max_iters' | 'budget' | 'cancelled' | 'error' | 'verify_failed' | 'stalled' | 'clarification'
  /** The execution check that passed for this run, if any ('test'/'runtime'/'compile').
   *  'none' or undefined means no runnable check existed. Lets the planner trust real
   *  execution evidence and skip a redundant (and over-strict) LLM done-check. */
  verifiedSignal?: VerifyResult['signal']
  /** Set only when stopped === 'clarification' AND the ambiguity had a genuinely
   *  enumerable answer set (ambiguity.ts's unresolved-reference-with-candidates case).
   *  Absent for open-ended clarifications (ask_user, or vague-scope/no-target/
   *  underspecified-behavior) — consumers must fall back to free-text on absence. */
  clarificationOptions?: string[]
  /** Which clarificationOptions entry to show as the recommended default. Always
   *  present when clarificationOptions is. */
  recommendedOption?: string
}

const APPROX_CHARS_PER_TOKEN = 4
/** Cap each observation fed back to the driver — keeps small models fast and cheap. */
const OBSERVATION_CAP_CHARS = 6000
/** Older observations get squashed to this once the transcript outgrows the budget. */
const SQUASHED_CAP_CHARS = 400

/** Returns true when the project directory has no user-authored files (only .crucible/ meta). */
function isFreshWorkspace(projectPath: string): boolean {
  try {
    const entries = fs.readdirSync(projectPath)
    return entries.every(e => e === '.crucible' || e === '.git')
  } catch { return true }
}

export function defaultSystemPreamble(projectPath: string): string {
  const fresh = isFreshWorkspace(projectPath)
  const workspaceNote = fresh
    ? `\nFRESH WORKSPACE: No source files exist here yet. Do NOT try to list_dir or read_file before creating files — the directory is empty. Use write_file to create your first files; it creates parent directories automatically. Start by planning what files you need, then write them.`
    : `\nExisting project — use list_dir and read_file to understand the current structure before making changes.`

  const worldCtx = buildWorldContext()
  return `You are Crucible, an autonomous Mac control and coding agent.
${worldCtx}

RULE 1 — NEVER ask for a specific confirmation phrase or script. If the user asks you to do something, DO IT with your tools. If they say yes/proceed/go ahead/do it/confirm, EXECUTE IMMEDIATELY.
RULE 2 — NEVER output a Python or shell script for the user to run. You have tools. Use them.
RULE 3 — Work step by step: inspect with tools, make changes, verify, then give a final answer. When done, reply with your summary and no tool calls.

AUTONOMY & CLARIFICATION: Default to understanding the request and implementing it to completion with sensible, well-reasoned defaults — you should handle the large majority of tasks end-to-end without asking anything. Only call the ask_user tool when you genuinely cannot proceed correctly: a required fact that only the user has, a real fork in intent where guessing wrong would waste significant work, or confirmation before a destructive/irreversible action. Ask ONE focused question, then continue once answered. Never ask about things you can reasonably infer, look up with web_search, or decide yourself — and never ask merely to confirm permission to act (you already have it). Asking when you could have proceeded is as much a failure as guessing wrong on something you should have asked about.
${workspaceNote}
IMPORTANT — delegation: for the single hardest algorithmic core of a task (a tricky function, non-obvious algorithm, or subtle edge-case logic), you MUST call ensemble_solve with a self-contained subprompt instead of writing it yourself. The ensemble runs several models in parallel and returns the highest-scored implementation, which is more reliable than your first draft. Then write that candidate to a file and verify it. Use ensemble_solve at most once or twice per task, only for the genuinely hard part — routine glue code you write directly.

CODING DISCIPLINE — you are a senior engineer; ship complete, correct code:
1. IMPLEMENT THE REAL LOGIC FIRST. Write the actual working implementation before tests or extra config. Do NOT spend your iteration budget on scaffolding/tooling — minimal setup, then the substance. A file left as a placeholder, stub, \`export {}\`, "// TODO", or "implementation goes here" is a FAILED task, not a step.
2. NO GAMING THE CHECK. Tests must genuinely exercise the behavior — real inputs, expected outputs, edge cases (empty/zero, boundaries, overflow, expiry, errors), and failure paths. A trivial test that asserts \`true === true\` or only the happy path to make the check go green is a serious failure; the real correctness bar is hidden from you and WILL catch it.
3. MATCH THE SPEC EXACTLY. If the task names specific file paths, exported names, or function signatures, create them verbatim — they may be imported by an external audit. Your self-test file MUST import the actual function from the module you just wrote and call THAT import — never declare a second, same-named function inline in the test file "for convenience." A self-test that exercises its own local re-declaration instead of the real export can pass while the actual deliverable is broken or has the wrong signature, and an external audit imports the real file, not your test's copy.
4. PROVE IT RUNS. Before your final answer, actually execute the code (run the entry/tests) and confirm real output. If a requirement isn't met, fix it and re-run — never report done on unverified or partial work.

TOOL SELECTION DISCIPLINE: Before calling any tool, ask: "Does this tool plausibly help answer the user's actual question?" Personal data tools (drive_search, drive_read, fitness_activity, contacts_search, gmail_search, gmail_read, calendar_events, youtube_search_api, analytics_report) exist for queries explicitly about the user's own data. NEVER call them for general research, factual questions, coding tasks, or world knowledge — even if you think there might be a tangential connection. If a query is about fusion energy, geopolitics, code, science, or anything external — do not touch personal data tools. Use web_search, consult_specialist, and ensemble_solve instead. If mid-task you genuinely discover personal data is needed (e.g. "compare this news to my own calendar"), call only the specific tool you need, once. STRATEGY SWITCH ON REPEATED FAILURE: if any tool fails twice in a row with the same error, STOP calling it — move on and complete the task with what you have.

AUTONOMOUS RESEARCH: When you encounter something you don't know, can't find in the project, or are unsure about — use web_search immediately. Do not guess. Do not say "I don't have access to real-time information." Search for it, read the results, and use what you find. For coding problems: search for the error message, the library docs, or the approach. For factual questions: search and answer from results. For tasks involving files or images: use download_file to fetch what you need directly.

FILE SYSTEM: You can write files to the project folder, ~/Desktop, ~/Downloads, and ~/Documents. Use absolute paths with ~ expanded (e.g. /Users/justin/Desktop/myfile.txt). For everything else, ask the user first.

MAC CONTROL — PREFER NATIVE COMMANDS OVER CLICKING: The Mac is controlled through reliable native interfaces, NOT by driving the UI. Order of preference, always:
1. control_mac — for system settings/actions (brightness, volume, mute, dark mode, wifi, sleep, lock, battery, …). It runs the correct native command and reads the state back to confirm. Use it for ANYTHING in the playbook below.
2. run (shell/osascript) — for anything else the OS exposes via command line: \`osascript -e '…'\` (AppleScript/JXA for scriptable apps + System Events), \`defaults\`, \`networksetup\`, \`pmset\`, \`mdfind\`, \`open -a AppName\`, \`open -a Safari https://url\`, \`mkdir -p ~/Desktop/Folder\`. Almost every macOS capability is reachable this way.
3. get_ui_tree / click_element / type_text — LAST RESORT, ONLY for apps that have no scriptable or command-line interface. NEVER use UI automation to change a system setting (dragging the System Settings sliders fails with -10006 and loops). If you catch yourself about to open System Settings to change something, stop and use control_mac or osascript instead.

SYSTEM CONTROL PLAYBOOK (call via control_mac with {intent, …args}):
${renderPlaybook()}

EXTENDING YOURSELF: If a system task is NOT in the playbook and no tool covers it, do this — (1) find the native command (you likely know the osascript/defaults/CLI incantation; if unsure, web_search it), (2) run it via the run tool and verify it worked by reading the state back, (3) once it works, call create_tool to persist a small recipe so it is instant next time. This is how your capabilities grow — by solving a task once natively, then keeping it. Do NOT fall back to clicking the UI just because there's no pre-made tool.

GLOBAL MEMORY: Use write_global_memory to save durable facts about the USER that should persist across ALL future sessions — preferences, timezone, recurring tools, communication style. Call it whenever you learn something genuinely reusable, not just task-specific. Examples: "User prefers concise responses", "User works in TypeScript", "User is based in Italy". Project-specific facts go in the per-project memory automatically; global memory is only for things true across all projects.

TOOL ACQUISITION: If you need to do something that no existing tool supports, use create_tool to write a new one on the spot. The tool body is a JS async function (receives args, ctx) that returns { ok: boolean, output: string }. It is registered immediately and persisted so future sessions have it too. Only create a tool when the built-in set genuinely cannot do the job — don't duplicate existing tools.

EXECUTION OVER SCRIPTING: When the user asks you to delete, move, download, organize, or manipulate files — USE YOUR TOOLS to do it directly. NEVER output a Python script, shell script, or code block for the user to run themselves. NEVER use rm -rf in the run tool — it is blocked. Instead use: delete_file for single files, delete_folder for folders/directories, empty_trash to empty the Trash, move_file to move or rename, download_file to fetch images. Outputting a script instead of acting is a failure.

CONFIRMATION POLICY: You already have permission to act. Do NOT ask the user to confirm with a specific phrase or repeat themselves. If a user says "proceed", "yes", "do it", "go ahead", or similar — that IS confirmation. Execute immediately using your tools.

VERIFY BEFORE REPORTING: After ANY file operation (delete, download, move, rename), you MUST use list_dir or run "ls -la <path>" to confirm the actual state of the folder before reporting results to the user. Never report success based on assumption — only report what you can confirm with a tool call. If the result does not match what was requested, fix it before responding. For a state change (a setting, a config value), read the value BACK after writing it and confirm it actually changed — if the read-back shows the old value, the change did NOT take effect and you must not report success.

EXECUTION ENVIRONMENT — choose an approach that can actually work and be observed:
- You run commands in a CAPTURED, NON-INTERACTIVE shell (no real TTY). Terminal-UI programs that need a live terminal — Python curses, ncurses, anything calling initscr() / addstr, vim, top, less — will crash (e.g. "setupterm: could not find terminal", "addwstr() returned ERR") or hang. Do NOT use them.
- When you launch something in a SEPARATE window (e.g. \`osascript -e 'tell application "Terminal" to do script ...'\` or \`open -a\`), you CANNOT see its output, so you cannot know it succeeded. Never claim it worked from a do-script launch alone. To verify, run the program in your own captured shell (headless), or have it write to a log file and then read that file back.
- For VISUAL / animation / graphics / "show me" requests: prefer a self-contained HTML file (canvas/SVG/CSS/JS) opened in the browser with \`open -a "Google Chrome" file:///abs/path.html\` (or Safari) — it is reliable, observable, and needs no extra runtime. Use a real GUI toolkit (pygame, tkinter) only if the user asked for a native window; never a terminal TUI for an animation.
- STRATEGY SWITCH ON REPEATED FAILURE: if the same approach fails about twice, STOP retrying cosmetic variations of it (different flags, env vars, quoting). The approach itself is wrong for this environment — step back and use a fundamentally different method (e.g. switch from curses-in-terminal to an HTML canvas in the browser). Repeating a doomed approach wastes the whole task.

Paths may be relative to the project root. Keep outputs concise.

TYPESCRIPT PROJECTS: When creating a new TypeScript project, always follow these rules:
1. Never set "type": "module" in package.json unless the user explicitly asks for ESM.
2. Always use tsx to run TypeScript files — never ts-node. Command: npx tsx src/index.ts
3. Use CommonJS-style imports (no .js extensions on relative imports).
4. Always verify the project runs after scaffolding: use the run tool with npx tsx <entrypoint>.
5. tsconfig.json must have "module": "commonjs" and "esModuleInterop": true.
6. DO NOT run a build: never call \`tsc\`, \`tsc --init\`, or \`tsc --build\`, and do not emit .js/.d.ts. tsx runs TypeScript directly — verify by running \`npx tsx src/index.ts\` and reading its output, not by compiling. If \`tsc\` reports errors, do NOT spiral on tsconfig edits; just make the code run under tsx.
7. Keep tsconfig MINIMAL (module commonjs, esModuleInterop, target es2020, skipLibCheck). Don't enable strict/declaration/composite — they create build friction without changing whether the program runs. Spend your effort on the implementation, not on the compiler config.`
}

export async function runAgentLoop(opts: AgentLoopOpts): Promise<AgentLoopResult> {
  const {
    goal, projectPath, driveTurn, emit, signal,
    maxIters = 32, budgetTokens = 120_000, verify,
  } = opts

  const ctx: ToolCtx = {
    projectPath,
    userId: opts.userId,
    emit,
    signal,
    allowMutation: opts.allowMutation ?? true,
    budget: { remainingTokens: budgetTokens },
    onFileMutated: opts.onFileMutated,
    consultSpecialist: opts.consultSpecialist,
  }

  // Stakes-router confirmation retry (see stakesRouter.ts) — a short affirmative reply on
  // a resumed turn is treated as "go ahead" for whatever destructive action this run
  // attempts. Found in passing: the `run` tool's own destructive-command guard
  // (registry.ts's ctx.allowDestructive) had NO caller anywhere that ever set it true —
  // a destructive command was permanently unrunnable even with genuine explicit user
  // confirmation, since nothing closed the loop back from "user said yes" to the flag.
  // This is intentionally coarse (goal-text only, not conversation-state introspection):
  // proper multi-turn state (which specific action was confirmed) would need the
  // clarification exchange itself persisted into session messages, which the ask_user
  // path this reuses doesn't currently do either — a real, pre-existing gap, not
  // something to silently paper over here.
  if (opts.initialMessages && /^\s*(yes|yeah|yep|yup|sure|go ahead|do it|confirm(ed)?|proceed|ok|okay)\b/i.test(goal) && goal.trim().length < 40) {
    ctx.allowDestructive = true
  }

  // Integration tools (Integrations drawer) are only VISIBLE while their
  // integration is enabled — a disabled drawer entry must not tempt the model.
  // (run() re-checks enablement too, covering a mid-task toggle-off.)
  const tools = registry.list().filter(t => !t.integrationId || isIntegrationEnabled(t.integrationId))
  // Resume from checkpoint if initialMessages provided; otherwise start fresh.
  const messages: Array<Record<string, unknown>> = opts.initialMessages
    ? [...opts.initialMessages]
    : [
        { role: 'system', content: opts.systemPreamble ?? defaultSystemPreamble(projectPath) },
        { role: 'user', content: goal },
      ]

  let spentTokens = 0
  let toolCallCount = 0
  let verifiedSignal: VerifyResult['signal'] | undefined
  const start = Date.now()

  // Context anchor — immutable record of the original goal for compression validation
  const anchorId = `loop_${start}`
  createAnchor(anchorId, goal)

  const spend = (chars: number) => { spentTokens += Math.ceil(chars / APPROX_CHARS_PER_TOKEN) }

  // Tier 2.4 — ambiguity resolution, before the first turn is spent. Only a fresh
  // (non-resumed) goal is checked; a resumed checkpoint has already cleared this gate
  // once and the resumed messages are the user's actual answer, not a fresh goal.
  if (!opts.initialMessages) {
    let semIdx
    try { semIdx = ensureSemanticIndex(projectPath) } catch { /* index build failed — resolve without it */ }
    const resolution = resolveAmbiguity(goal, { index: semIdx })
    if (resolution.ambiguous && resolution.clarification) {
      emit({
        type: 'clarification_request',
        question: resolution.clarification,
        options: resolution.clarificationOptions,
        recommended: resolution.recommendedOption,
      })
      debugBus.emit('agent', 'ambiguity_gate', {
        confidence: resolution.confidence,
        signals: resolution.signals.map(s => s.type),
      }, { severity: 'info' })
      return done('clarification', resolution.clarification, 0, resolution.clarificationOptions, resolution.recommendedOption)
    }
  }

  // Error-pattern tracker — detects the agent spinning on the same failure.
  let lastErrorFingerprint = ''
  let consecutiveErrorCount = 0

  // Stall detector (B2) — detects the agent repeating the EXACT same tool-call
  // signature (same tool names + same args). One corrective hint on the 2nd repeat,
  // hard stop on the 3rd so a thrashing model cannot burn the whole iteration budget.
  let lastTurnSig = ''
  let repeatTurnCount = 0

  // All-failures detector — catches a loop that THRASHES with varying args (so the
  // exact-signature stall check above never trips) but every call fails anyway, e.g.
  // repeatedly poking a System Settings slider it can't set (-10006). Counts turns
  // where every tool call failed; hard-stops after MAX_CONSECUTIVE_FAILED_TURNS.
  let consecutiveFailedTurns = 0
  const MAX_CONSECUTIVE_FAILED_TURNS = 4

  // Grounding gate state — bounds how many times a rejected final answer can be
  // bounced back for correction, so a stubborn checker can never loop forever.
  const groundFinal = opts.groundFinal ?? true
  let groundingRetries = 0
  const MAX_GROUNDING_RETRIES = 2

  // Adversarial harden pass state — one round of senior-reviewer critique after the code
  // verifies, to catch edge-case bugs the agent's own happy-path tests missed.
  const hardenFinal = opts.hardenFinal ?? false
  let hardenRounds = 0
  // Live case (2026-07-05, leaderboardModule): a deterministic fuzz-confirmed mutation
  // bug (see localHardenFuzz.ts's sort-no-mutate) survived 2 rounds — the free-tier model's
  // fix attempt kept re-emitting `scores.sort(...)` even after a plain-English "don't
  // mutate the input" instruction, and other gates (grounding) were consuming iteration
  // turns in between. One extra round costs little (fuzz checks are static, no model call
  // to CHECK, only to fix) and the fuzz layer's zero-false-positive design (see its own
  // header doc) means a 3rd round can't be spent re-flagging correct code.
  const MAX_HARDEN_ROUNDS = 3

  /** Inject a corrective hint when the model is looping on the same failure. */
  function maybePushErrorHint(toolResults: Array<{ ok: boolean; output: string; tool: string }>) {
    const errors = toolResults.filter(r => !r.ok)
    if (!errors.length) { lastErrorFingerprint = ''; consecutiveErrorCount = 0; return }

    // Build a fingerprint: tool name + first 60 chars of error message
    const fp = errors.map(e => `${e.tool}:${e.output.slice(0, 60)}`).join('|')
    if (fp === lastErrorFingerprint) {
      consecutiveErrorCount++
    } else {
      lastErrorFingerprint = fp
      consecutiveErrorCount = 1
    }

    if (consecutiveErrorCount < 2) return

    // Classify the error and inject a targeted hint
    const allOutput = errors.map(e => e.output).join(' ')
    let hint: string

    if (/not found|no such file|ENOENT|does not exist/i.test(allOutput)) {
      hint = `SYSTEM HINT: You have tried this path twice and it does not exist. If this is a file you intend to create, use write_file — it creates parent directories automatically. If it is a file you expect to already exist, re-examine the project structure with list_dir before trying again. Do not repeat the same failing path.`
    } else if (/permission denied|EACCES/i.test(allOutput)) {
      hint = `SYSTEM HINT: Permission denied. Try a different path inside the project root, or use the run tool with an appropriate command.`
    } else if (/outside the project root|path.*escape/i.test(allOutput)) {
      hint = `SYSTEM HINT: The path escapes the project root. All file operations must stay within ${projectPath}. Use relative paths or absolute paths inside that directory.`
    } else if (/exit [^0]|command not found|spawn/i.test(allOutput)) {
      hint = `SYSTEM HINT: The shell command is failing repeatedly. Check whether the required tool/runtime is installed, or try a different approach to accomplish the same goal.`
    } else {
      hint = `SYSTEM HINT: The same error has occurred twice in a row (${errors[0].tool}). Stop repeating this approach. Reason about why it is failing and try a fundamentally different method.`
    }

    messages.push({ role: 'user', content: hint })
    consecutiveErrorCount = 0 // reset so we don't spam hints
  }

  for (let iter = 1; iter <= maxIters; iter++) {
    if (signal?.aborted) return done('cancelled', '', iter)
    if (iter === 1) debugBus.emit('agent', 'loop_start', { goal: goal.slice(0, 120), projectPath })
    if (spentTokens >= budgetTokens) return done('budget', '', iter)
    ctx.budget!.remainingTokens = budgetTokens - spentTokens

    // Emit live progress so the UI can show step/iter/elapsed
    emit({
      type: 'iter_progress',
      iter, maxIters,
      stepIndex: opts.stepIndex ?? 0,
      stepTotal: opts.stepTotal ?? 1,
      stepIntent: opts.stepIntent ?? goal.slice(0, 80),
      elapsed: Date.now() - start,
    })

    let turn: DriveTurnResult
    try {
      turn = await driveTurn(messages, tools, signal)
    } catch (e: any) {
      if (signal?.aborted) return done('cancelled', '', iter)
      // All driver candidates failed — attempt emergency compression before giving up.
      // Token-size 413s mean the context is too large; compressing may unlock smaller models.
      const errMsg = String(e?.message ?? e)
      let recovered = false
      if (/413|too.?large|token.*limit|context.?length/i.test(errMsg)) {
        try {
          debugBus.emit('agent', 'emergency_compress', { iter, reason: errMsg.slice(0, 80) }, { severity: 'warn' })
          const comprResult = await maybeCompressMessages(messages, goal, opts.compressCallModel ?? null, true /* force */)
          if (comprResult.compressed) {
            messages.splice(0, messages.length, ...comprResult.messages)
            const discrepancy = validateCompression(anchorId, comprResult.anchorBlock)
            if (discrepancy.patch) messages.push({ role: 'user', content: discrepancy.patch })
            emit({ type: 'thought', text: '[Context compressed — retrying turn]', iter })
            turn = await driveTurn(messages, tools, signal)
            recovered = true
          }
        } catch { /* compression or retry also failed — fall through to error */ }
      }
      if (!recovered) {
        emit({ type: 'agent_error', error: errMsg, iter })
        debugBus.emit('agent', 'agent_error', { error: errMsg, iter }, { severity: 'error' })
        return done('error', errMsg, iter)
      }
    }
    // Defend against a driver returning a partial turn.
    turn = { text: turn?.text ?? '', toolCalls: Array.isArray(turn?.toolCalls) ? turn.toolCalls : [] }
    spend(turn.text.length + JSON.stringify(turn.toolCalls).length)

    if (turn.text.trim()) emit({ type: 'thought', text: turn.text, iter })

    if (turn.toolCalls.length > 0) {
      // ask_user — genuine clarification. The agent asks ONLY when it cannot proceed
      // correctly without information the user alone has (or before a costly/irreversible
      // action). Surface the question and end the turn with a DISTINCT 'clarification'
      // status (ok=false) so multi-step consumers (planner) pause for the answer instead
      // of treating the question as a completed step. The user's reply continues the task
      // since session context is preserved across turns.
      const askCall = turn.toolCalls.find(c => c.name === 'ask_user')
      if (askCall) {
        if (turn.toolCalls.length === 1) {
          const question = String((askCall.args as Record<string, unknown>)?.question ?? turn.text ?? 'Could you clarify how you would like me to proceed?').trim()
          emit({ type: 'clarification_request', question })
          debugBus.emit('agent', 'ask_user', { question: question.slice(0, 160) }, { severity: 'info' })
          return done('clarification', question, iter)
        }
        // ask_user was co-emitted with real tool calls — complete the actual work this
        // turn and drop the premature question; the model can re-ask next turn if still
        // blocked. (Never silently discard the other calls.)
        emit({ type: 'thought', text: '[Deferring ask_user — finishing the other actions in this turn first]', iter })
        turn.toolCalls = turn.toolCalls.filter(c => c.name !== 'ask_user')
      }

      // HITL_PLANNING_TRACK.md §3 — stakes-aware router, first real slice (2026-07-05).
      // Deterministic, no model call: scores EVERY tool call about to run this turn on
      // reversibility + blast radius (2026-07-06: widened from the sole-call case — a
      // destructive call co-emitted alongside benign ones was a documented scope gap, not
      // silently assumed safe; a batch of calls is exactly where a model is most likely to
      // slip an unreviewed delete in alongside routine work). Gates on the FIRST high-stakes
      // call found; the rest of the turn (including any other destructive calls) is held
      // until the user answers — never partially executed around the gate. Reuses the exact
      // clarification wiring ask_user already has (down to the frontend's MC card) rather
      // than building a parallel confirmation mechanism.
      if (!ctx.allowDestructive) {
        const flagged = turn.toolCalls
          .map(c => ({ call: c, stakes: assessStakes(c.name, (c.args ?? {}) as Record<string, unknown>, goal) }))
          .find(x => x.stakes.stakes === 'high')
        if (flagged) {
          const { call, stakes } = flagged
          const question = `${stakes.reason} Should I go ahead?`
          const options = ['Yes, go ahead', "No, don't do that", 'Something else / not sure']
          const recommended = "No, don't do that"
          emit({ type: 'clarification_request', question, options, recommended })
          debugBus.emit('agent', 'stakes_gate', { tool: call.name, blastRadius: stakes.blastRadius, batchSize: turn.toolCalls.length }, { severity: 'info' })
          return done('clarification', question, iter, options, recommended)
        }
      }

      // Stall detection — compare this turn's tool-call signature to the previous one.
      const turnSig = turn.toolCalls.map(c => `${c.name}:${JSON.stringify(c.args)}`).sort().join('|')
      if (turnSig && turnSig === lastTurnSig) repeatTurnCount++
      else { repeatTurnCount = 0; lastTurnSig = turnSig }
      if (repeatTurnCount >= 2) {
        // Third identical action in a row — it will keep producing the same result.
        emit({ type: 'thought', text: '[Stalled — repeated the same action 3× without progress; stopping]', iter })
        debugBus.emit('agent', 'loop_stalled', { iter, sig: turnSig.slice(0, 120) }, { severity: 'warn' })
        return done('stalled', turn.text || 'Stopped: the same action repeated without making progress.', iter)
      }

      messages.push({
        role: 'assistant',
        content: turn.text || null,
        tool_calls: turn.toolCalls.map(c => ({
          id: c.id, type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      })
      const results = await Promise.all(turn.toolCalls.map(c => registry.exec(c, ctx)))
      toolCallCount += results.length
      turn.toolCalls.forEach((c, i) => {
        debugBus.emit('tool', c.name, { args: c.args, ok: results[i].ok, output: results[i].output.slice(0, 300) }, { severity: results[i].ok ? 'info' : 'error' })
        const compressed = compressObservation(results[i].output)
        spend(compressed.length)
        messages.push({ role: 'tool', tool_call_id: c.id, content: `(${results[i].ok ? 'ok' : 'error'}) ${compressed}` })
      })
      // All-failures hard stop — if every tool call in this turn failed, count it.
      // A run of fully-failed turns means the agent is stuck on a dead-end approach
      // (even if it varies the args each time); stop rather than burn the budget.
      if (results.length > 0 && results.every(r => !r.ok)) {
        consecutiveFailedTurns++
        if (consecutiveFailedTurns >= MAX_CONSECUTIVE_FAILED_TURNS) {
          const lastErr = results[0].output.slice(0, 160)
          emit({ type: 'thought', text: `[Stopped — ${MAX_CONSECUTIVE_FAILED_TURNS} turns of repeated failures; this approach isn't working]`, iter })
          debugBus.emit('agent', 'loop_all_failed', { iter, turns: consecutiveFailedTurns, lastErr }, { severity: 'warn' })
          return done('stalled', turn.text || `Stopped: this action kept failing (${lastErr}). It may not be possible this way.`, iter)
        }
      } else {
        consecutiveFailedTurns = 0
      }
      // Detect repetitive failures and inject a corrective hint before the next turn
      maybePushErrorHint(turn.toolCalls.map((c, i) => ({ ok: results[i].ok, output: results[i].output, tool: c.name })))
      // Anti-repeat nudge on the 2nd identical action (the 3rd hard-stops above).
      if (repeatTurnCount === 1) {
        messages.push({ role: 'user', content: 'SYSTEM HINT: You just repeated the exact same tool call as the previous step — it produces the same result. Use the result you already have and move on, or take a fundamentally different action. Do not repeat it again.' })
      }
      squashOldObservations(messages, spentTokens, budgetTokens)

      // Context compression — fires when raw transcript exceeds ~15k tokens.
      // Model-assisted when compressCallModel is provided; structural fallback otherwise.
      try {
        const comprResult = await maybeCompressMessages(messages, goal, opts.compressCallModel ?? null)
        if (comprResult.compressed) {
          // Replace message array in-place so checkpoint/tool refs stay valid
          messages.splice(0, messages.length, ...comprResult.messages)
          // Validate compressed summary against original anchor
          const discrepancy = validateCompression(anchorId, comprResult.anchorBlock)
          if (discrepancy.patch) {
            messages.push({ role: 'user', content: discrepancy.patch })
          }
          debugBus.emit('agent', 'context_compressed', {
            tokensReclaimed: comprResult.tokensReclaimed,
            discrepancyAction: discrepancy.action,
            missingEntities: discrepancy.missingEntities.length,
            missingRequirements: discrepancy.missingRequirements.length,
          }, { severity: 'info' })
        }
      } catch { /* compression is best-effort — never block the loop */ }

      // Checkpoint after each tool-call round so a drop can resume here
      opts.onCheckpoint?.(messages, iter)
      continue
    }

    // No tool calls — model thinks it's done. Verify before accepting.
    if (verify) {
      const v = await verify(turn.text, ctx)
      emit({ type: 'verify', passed: v.passed, signal: v.signal, report: v.report.slice(0, 1500), escalate: v.escalate ?? false, unverified: v.unverified ?? false })
      if (!v.passed && v.escalate) {
        // Heal cap hit or same failure repeating — stop honestly instead of thrashing.
        const honest = `Verification is still failing after repeated fix attempts (${v.signal}).\n\nLast report:\n${v.report.slice(0, 2000)}\n\nModel's last summary:\n${turn.text}`
        return { ...done('verify_failed', honest, iter), finalText: honest }
      }
      if (!v.passed) {
        messages.push({ role: 'assistant', content: turn.text })
        messages.push({
          role: 'user',
          content: `Verification failed (${v.signal}):\n${compressObservation(v.report)}` +
            (v.hints?.length ? `\nHints:\n- ${v.hints.join('\n- ')}` : '') +
            '\nFix the problem and verify again.',
        })
        continue
      }
      // A real execution check passed — record it so the planner can trust the running
      // code over a redundant LLM done-check (which judges only the prose summary).
      if (v.signal !== 'none') verifiedSignal = v.signal
    }

    // Grounding gate — for ACTION tasks (the agent actually used tools), audit the
    // final claim against the real tool evidence before accepting it. This catches
    // false "success" reports — e.g. "language set to Spanish" when the read-back
    // showed en-US, or "file written" after a write that errored. Fail-OPEN: any
    // checker error or unparseable verdict accepts the answer, so it can never wedge
    // a task. Bounded by MAX_GROUNDING_RETRIES so a stubborn checker can't loop.
    if (groundFinal && toolCallCount > 0 && turn.text.trim() && groundingRetries < MAX_GROUNDING_RETRIES) {
      const verdict = await checkGrounding(goal, turn.text, messages, driveTurn, signal)
      if (verdict && !verdict.grounded) {
        groundingRetries++
        debugBus.emit('agent', 'grounding_rejected', { iter, issue: verdict.issue.slice(0, 160) }, { severity: 'warn' })
        emit({ type: 'thought', text: `[Self-check: ${verdict.issue || 'the result is not yet confirmed by the evidence'}]`, iter })
        messages.push({ role: 'assistant', content: turn.text })
        messages.push({
          role: 'user',
          content: `SELF-CHECK FAILED — do not claim success yet. ${verdict.fix_directive || 'The tool evidence does not confirm the outcome you described.'} ` +
            `Re-check the actual tool output (read state back if needed), take any corrective action, and only then give your final answer. If the action genuinely cannot be completed, say so honestly instead of claiming it worked.`,
        })
        continue
      }
    }

    // Adversarial harden pass — once, after the code has actually verified (compiled/ran/
    // tested), a senior-reviewer critic hunts for correctness bugs and missing edge cases
    // the agent's OWN happy-path tests didn't cover (e.g. a KV store whose overwrite or
    // WAL-replay path is subtly wrong but its smoke test passes). Findings are bounced back
    // for a fix + added coverage. Bounded to one round and fail-OPEN (any critic/parse
    // error accepts the answer) so it can never wedge a task.
    // Gate on having source to review (NOT on a prior clean verify): the review is static
    // (reads the code, runs nothing), so it is safe — and a run interrupted before a clean
    // verify (e.g. a turn timeout) is EXACTLY when buggy code ships, so harden must still
    // fire. readProjectSources null-guards the no-code case.
    if (hardenFinal && hardenRounds < MAX_HARDEN_ROUNDS) {
      const sources = readProjectSources(projectPath)
      if (sources) {
        const review = await runHardenReview(goal, sources, driveTurn, signal)
        if (review && !review.solid && review.findings.trim()) {
          hardenRounds++
          // Deterministic auto-repair (2026-07-06) for the one finding shape that's
          // mechanically fixable with zero ambiguity: a bare `x.sort(...)` mutating its
          // argument (localHardenFuzz's sort-no-mutate property). Confirmed live
          // (leaderboardModule) that the natural-language retry below is not reliably
          // enough — the FM can re-ship the identical bug after being told about it in
          // prose. Patch the file directly on disk before the retry message goes out, so
          // the model's next turn either confirms an already-fixed file (cheap, high
          // success rate) or overwrites it again (no worse than today). Reuses
          // repairProposers.ts's repairMutatingSort via the same detail-string gate it
          // already uses — not a new pattern, just applied a layer earlier than its
          // current only caller (universal.ts's synth/oracle path).
          if (/mutates its input argument in place/.test(review.findings)) {
            try {
              const { proposeRepairs } = await import('../synth/repairProposers')
              for (const f of splitSources(sources)) {
                const repairs = proposeRepairs(f.content, review.findings, goal)
                if (repairs.length) {
                  fs.writeFileSync(path.join(projectPath, f.path), repairs[0], 'utf8')
                  debugBus.emit('agent', 'auto_repair', { iter, path: f.path, kind: 'mutating-sort' }, { severity: 'info' })
                  emit({ type: 'thought', text: `[Auto-repaired ${f.path}: rewrote a mutating array method to a non-mutating form]`, iter })
                  break // one mechanical fix per round — same discipline as the FM-facing message below
                }
              }
            } catch { /* best-effort — falls through to the normal retry message either way */ }
          }
          debugBus.emit('agent', 'harden_findings', { iter, findings: review.findings.slice(0, 200) }, { severity: 'info' })
          emit({ type: 'thought', text: '[Hardening review — found likely correctness gaps; fixing before finalizing]', iter })
          messages.push({ role: 'assistant', content: turn.text })
          messages.push({
            role: 'user',
            content: `FINAL CODE REVIEW — a senior reviewer found likely correctness bugs or unhandled edge cases. ` +
              `Fix EACH one in the implementation, add a test that exercises it, and re-run your tests to confirm everything passes. ` +
              `Only give your final answer once the code handles all of these correctly:\n\n${review.findings}`,
          })
          continue
        }
      }
    }
    return done('final', turn.text, iter)
  }
  return done('max_iters', '', maxIters)

  function done(
    stopped: AgentLoopResult['stopped'], finalText: string, iters: number,
    clarificationOptions?: string[], recommendedOption?: string,
  ): AgentLoopResult {
    const ok = stopped === 'final'
    deleteAnchor(anchorId)
    emit({ type: 'agent_done', ok, stopped, iters, toolCallCount, spentTokens, ms: Date.now() - start })
    // Self-reflection — runs async, never blocks the response
    if (ok && finalText) {
      setImmediate(async () => {
        try {
          const reflectionPrompt = buildReflectionPrompt(goal, finalText)
          const reflectionResult = await driveTurn(
            [{ role: 'user', content: reflectionPrompt }], [], signal, 'glue'
          )
          const raw = reflectionResult.text.replace(/```json|```/g, '').trim()
          const parsed = JSON.parse(raw)
          if (parsed.observation) {
            appendReflection({
              ts: Date.now(), task: goal.slice(0, 200),
              observation: parsed.observation,
              principleScores: parsed.principleScores ?? {},
              graphUpdates: (parsed.graphNodes ?? []).map((n: any) => n.id),
            })
          }
          if (Array.isArray(parsed.newFacts)) {
            for (const fact of parsed.newFacts) appendWorldFact(String(fact))
          }
          if (Array.isArray(parsed.graphNodes)) {
            const graph = loadGraph()
            for (const n of parsed.graphNodes) touchNode(graph, n.id, n)
            saveGraph(graph)
          }
          debugBus.emit('agent', 'reflection_complete', { observation: parsed.observation }, { severity: 'info' })
        } catch (e) {
          debugBus.emit('agent', 'reflection_failed', { error: String(e) }, { severity: 'warn' })
        }
      })
    }
    return { ok, finalText, iters, toolCallCount, stopped, verifiedSignal, clarificationOptions, recommendedOption }
  }
}

/** Compact "calls + results" digest of the transcript for the grounding auditor. */
function buildEvidenceDigest(messages: Array<Record<string, unknown>>): string {
  const ev: string[] = []
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray((m as any).tool_calls)) {
      for (const tc of (m as any).tool_calls) {
        const fn = tc?.function ?? {}
        ev.push(`CALL ${fn.name}(${String(fn.arguments ?? '').slice(0, 200)})`)
      }
    } else if (m.role === 'tool') {
      ev.push(`RESULT ${String(m.content ?? '').slice(0, 400)}`)
    }
  }
  return ev.slice(-30).join('\n')   // most recent ~30 lines of evidence
}

export interface GroundingVerdict { grounded: boolean; issue: string; fix_directive: string }

/**
 * Strict outcome auditor — judges ONLY whether the agent's final answer is truthful
 * and supported by the actual tool evidence. Returns null (→ fail-open accept) on any
 * checker/transport/parse error so it can never block a task.
 */
export async function checkGrounding(
  goal: string,
  finalText: string,
  messages: Array<Record<string, unknown>>,
  driveTurn: DriveTurn,
  signal?: AbortSignal,
): Promise<GroundingVerdict | null> {
  const digest = buildEvidenceDigest(messages)
  if (!digest) {
    // Not a fail-open failure — there is genuinely nothing to audit. Still recorded
    // (ran:false) so the ledger distinguishes "never had evidence" from "errored".
    recordGate({ gate: 'grounding', ran: false, reason: 'no tool evidence to audit' })
    return null
  }
  const prompt = `You are a strict verification auditor for an automation/coding agent. Judge ONLY whether the agent's FINAL ANSWER is truthful and actually supported by the TOOL EVIDENCE below. Look hard for:
- success claimed but a command exited non-zero / errored
- a state change claimed but the read-back shows the OLD value (e.g. claims "language is Spanish" but a read shows en-US)
- a file/edit claimed but the write or patch errored, or the file was never confirmed
- "I opened/ran it" when the output was never actually observed and could have failed

USER GOAL:
${goal}

AGENT FINAL ANSWER:
${finalText.slice(0, 1500)}

TOOL EVIDENCE (calls and their results, most recent last):
${digest}

Be conservative: mark grounded=false ONLY when the evidence clearly contradicts or fails to support a success claim. If evidence is merely incomplete but nothing contradicts the claim, mark grounded=true. An EMPTY command result with no error text means the command SUCCEEDED (a clean build/compile/test run often prints nothing) — treat empty output as supporting a success claim, never as contradicting it. Reply with ONLY a JSON object, no prose:
{"grounded": true|false, "issue": "<one sentence; empty if grounded>", "fix_directive": "<one imperative sentence telling the agent what to verify or fix; empty if grounded>"}`
  try {
    // Grounding stays on the LOCAL FM ('glue'): measured 5/6 on the on-device model — good
    // enough, and it can fire repeatedly (retry loop) on action tasks, so keeping it local
    // avoids adding online-pool pressure (which, degraded, starves demanding tasks like
    // sortModule of the writes they need). Only HARDEN — where the FM is at chance (2/4) —
    // escalates to the strong online pool via 'critic'. Escalate only what needs it.
    const r = await driveTurn([{ role: 'user', content: prompt }], [], signal, 'glue')
    const raw = r.text.replace(/```json|```/g, '').trim()
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}')
    if (s === -1 || e <= s) {
      recordGate({ gate: 'grounding', ran: false, reason: 'unparseable verdict (no JSON object in reply)' })
      return null
    }
    const j = JSON.parse(raw.slice(s, e + 1))
    if (typeof j.grounded !== 'boolean') {
      recordGate({ gate: 'grounding', ran: false, reason: 'unparseable verdict (grounded not boolean)' })
      return null
    }
    recordGate({ gate: 'grounding', ran: true, reason: j.grounded ? 'grounded' : 'rejected' })
    return { grounded: j.grounded, issue: String(j.issue ?? ''), fix_directive: String(j.fix_directive ?? '') }
  } catch (e: any) {
    recordGate({ gate: 'grounding', ran: false, reason: `checker error: ${String(e?.message ?? e).slice(0, 120)}` })
    return null
  }
}

/** Collect the agent-authored source (implementation, not tests) for the harden review. */
function readProjectSources(projectPath: string): string {
  const exts = /\.(ts|tsx|js|mjs|cjs|py|go|rs)$/
  const skip = new Set(['node_modules', '.git', '.crucible', '__audit__', 'dist', 'build', 'coverage'])
  const out: string[] = []
  let total = 0
  const CAP = 12000
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || total > CAP) return
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (total > CAP) break
      if (e.name.startsWith('.') || skip.has(e.name)) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (exts.test(e.name) && !/\.(test|spec|d)\./.test(e.name)) {
        try {
          const c = fs.readFileSync(p, 'utf8')
          out.push(`// ===== ${path.relative(projectPath, p)} =====\n${c}`)
          total += c.length
        } catch { /* unreadable — skip */ }
      }
    }
  }
  walk(projectPath, 0)
  return out.join('\n\n').slice(0, CAP)
}

export interface HardenReview { solid: boolean; findings: string }

/**
 * Senior-reviewer correctness pass. Returns {solid:true} when the code looks correct &
 * complete, {solid:false, findings} with concrete bugs otherwise, or null on any error
 * (→ fail-open accept). Focuses ONLY on correctness/edge cases, never style.
 */
export async function runHardenReview(
  goal: string,
  sources: string,
  driveTurn: DriveTurn,
  signal?: AbortSignal,
): Promise<HardenReview | null> {
  const prompt = `You are a senior software engineer doing a FINAL correctness review before merge. Your DEFAULT is PASS — correct code is common and you must not invent problems to look thorough. A false alarm on correct code is as bad as missing a real bug.

TASK:
${goal.slice(0, 900)}

IMPLEMENTATION:
${sources}

Flag a problem ONLY if you can name a SPECIFIC input for which the code returns a demonstrably WRONG result or crashes, given what the TASK actually asked for. Examples of real bugs: an off-by-one that returns the wrong element, a division that yields NaN on empty input when the task implied non-empty is not guaranteed, a persistence/replay path that loses data, a boundary the task named but the code mishandles.

DO NOT flag any of these — they are NOT bugs for this review:
- missing input validation, type checks, null/undefined guards, or handling of inputs the task never mentioned
- integer overflow, non-numeric/wrong-type inputs, or other defensive hardening the task did not ask for
- "could be more robust", "does not handle X" where X is out of scope, style, naming, or formatting

ALWAYS flag a bug that makes the NORMAL, intended use return the wrong value — a happy-path bug is the most important kind to catch.

Example A — TASK "write add(a,b) returning a+b", CODE "function add(a,b){return a+b}": correct review is exactly PASS (do not flag missing type checks or overflow).
Example B — TASK "write last(arr) returning the last element", CODE "function last(arr){return arr[arr.length]}": this is a REAL bug — last([1,2,3]) returns undefined instead of 3 (should be arr[arr.length-1]). Flag it.

If the code is correct and complete for what the task asked, reply with EXACTLY the single word: PASS
Otherwise list at most 3 REAL bugs, most severe first, each with its specific failing input.`
  try {
    const r = await driveTurn([{ role: 'user', content: prompt }], [], signal, 'critic')
    const text = (r.text || '').trim()
    if (!text) {
      return localHardenFallback('empty reviewer reply')
    }
    if (/^pass\b/i.test(text) || /\bno (significant|real|correctness|actual) (issues|problems|bugs)\b/i.test(text)) {
      // Online PASS is necessary but not sufficient — natural-language review can miss
      // structural correctness properties a deterministic check catches for free. Live
      // case (2026-07-05, leaderboardModule): `sortScoresAscending` returned
      // `scores.sort(...)`, mutating the caller's array despite the task spec saying
      // "does not mutate the input". The online critic PASSed it, and the model's own
      // self-test read `scores === scores` — a tautology comparing a reference to
      // itself, always true — so nothing caught the bug until the held-out suite did.
      // The fuzz layer's `sort-no-mutate` property (localHardenFuzz.ts) already exists
      // and detects exactly this shape; it just wasn't consulted on the PASS path
      // (only wired into the offline-reviewer-unreachable fallback below). Run it here
      // too — pure static/property check, no model call, so it's nearly free.
      const fuzzFindings = await runLocalHardenFuzz(sources).catch(() => [])
      if (fuzzFindings.length === 0) {
        recordGate({ gate: 'harden', ran: true, reason: 'pass' })
        return { solid: true, findings: '' }
      }
      recordGate({ gate: 'harden', ran: true, reason: 'pass-online-fuzz-caught' })
      return { solid: false, findings: fuzzFindings.map(f => f.message).slice(0, 3).join('\n') }
    }
    recordGate({ gate: 'harden', ran: true, reason: 'findings' })
    return { solid: false, findings: text.slice(0, 1400) }
  } catch (e: any) {
    return localHardenFallback(`reviewer error: ${String(e?.message ?? e).slice(0, 120)}`)
  }

  // The online critic pool (turnClass 'critic') is unreachable — priority-ladder item 1
  // (ROADMAP.md, 2026-07-04): rather than fail-open ACCEPT (silently disabling the
  // agent's strongest correctness gate, exactly when the offline/strict mission needs it
  // most), run the local deterministic substitute so strict mode always gets a real,
  // if narrower, verdict. Still recorded distinctly in telemetry so the ledger can tell
  // "online judged it" apart from "local heuristics judged it" apart from true dark gates.
  // Combines two complementary local layers: the AST scanner (always-wrong SHAPES, e.g.
  // arr[arr.length]) and the fuzz layer (behavioral properties on named families, e.g. a
  // sort that returns the wrong permutation) — neither subsumes the other.
  async function localHardenFallback(onlineFailureReason: string): Promise<HardenReview> {
    const local = runLocalHardenCheck(sources)
    const fuzzFindings = await runLocalHardenFuzz(sources).catch(() => [])
    const combinedFindings = [
      ...(local.solid ? [] : local.findings.split('\n')),
      ...fuzzFindings.map(f => f.message),
    ].slice(0, 3)
    const solid = combinedFindings.length === 0
    recordGate({
      gate: 'harden',
      ran: true,
      reason: `local-fallback (${onlineFailureReason}): ${solid ? 'clean' : 'findings'}` +
        (fuzzFindings.length ? ` [+${fuzzFindings.length} fuzz]` : ''),
    })
    return { solid, findings: combinedFindings.join('\n') }
  }
}

/** Never feed raw tool output back verbatim — cap it, keeping head and tail. */
export function compressObservation(output: string, cap = OBSERVATION_CAP_CHARS): string {
  if (output.length <= cap) return output
  const head = output.slice(0, Math.floor(cap * 0.7))
  const tail = output.slice(-Math.floor(cap * 0.25))
  return `${head}\n…[${output.length - cap} chars omitted]…\n${tail}`
}

/** When past 60% of budget, squash all but the 4 most recent tool observations. */
function squashOldObservations(messages: Array<Record<string, unknown>>, spent: number, budget: number) {
  if (spent < budget * 0.6) return
  const toolIdxs = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter(i => i >= 0)
  for (const i of toolIdxs.slice(0, -4)) {
    const content = String(messages[i].content ?? '')
    if (content.length > SQUASHED_CAP_CHARS) {
      messages[i] = { ...messages[i], content: content.slice(0, SQUASHED_CAP_CHARS) + '…[squashed]' }
    }
  }
}

// ============================================================================
// Phase E — Offline agentic driver.
//
// Architecture: keep the Node orchestration loop DETERMINISTIC; use the FM
// for code emission (oracle-gated) AND for all non-code reasoning via the
// FM ReAct loop (fmReact.ts). The FM now drives the full offline experience.
//
// Contract:
//   offlineDriveTurn is a DriveTurn. When the current step can be solved fully
//   offline, it returns a DriveTurnResult as normal. When it can't pass the
//   oracle after MAX_FM_ROUNDS on a code task, it throws OfflineEscalateError
//   so the server can fall through to the external pool for that turn only.
//   Non-code turns (research, reasoning, planning) NEVER escalate — the FM
//   handles them directly via the ReAct loop or a direct call.
//
// State machine (each turn emits ONE tool call):
//
//   S-RESEARCH  No TS/JS file in goal — route through research DAG first,
//               then FM ReAct (with web search), then FM direct answer.
//   S0  Edit intent + primary target not yet read → read_file
//   S1  Next unwritten file in plan → synthesize → write_file
//   S2  All files written, not yet tsc'd → run tsc --noEmit
//   S3  tsc errors + retry budget → re-synthesize primary → write_file
//   S4  tsc clean + self-test cmd in goal + not yet run → run self-test
//   S5  self-test failed + retry budget → re-synthesize primary → write_file
//   S6  all clean → done
//   S7  budget exhausted → escalate to online driver (code path only)
//
// Multi-file support: all TS/JS paths mentioned in the goal are written in
// order (primary/impl first, secondary/test files after). The tsc check covers
// the whole project. Self-test is run if the goal specifies a run command.
// ============================================================================

import path from 'path'
import { synthesizeUniversal } from '../synth/universal'
import { buildEditSpec, parseSectionPatches, applyPatch, isSectionPatchOutput } from '../synth/editExtract'
import { ensureIndex } from '../state/codebaseIndex'
import { debugBus } from '../debug/bus'
import type { DriveTurn, DriveTurnResult } from './loop'
import { retrieveForTask } from '../retrieval/retrievalLayer'
import { runResearchDag } from '../research/researchDag'
import { fmReact, fmDirectAnswer, checkFmAvailable, fmComplete } from './fmReact'

// ── Local FM helper (research turns only) ───────────────────────────────────
// Mirrors callLocalModel in server.ts but lives here so synthDriver stays
// self-contained and never imports from server.ts (circular dep risk).
const _LOCAL_FM_URL = process.env.LOCAL_INFERENCE_URL ?? 'http://127.0.0.1:11435'
const _RESEARCH_FM_TIMEOUT = Number(process.env.CRUCIBLE_RESEARCH_FM_TIMEOUT ?? 20000)

async function _callLocalFm(system: string, user: string, ms = _RESEARCH_FM_TIMEOUT): Promise<string> {
  try {
    const res = await fetch(`${_LOCAL_FM_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'apple-fm',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: 1024,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(ms),
    })
    if (!res.ok) return ''
    const data = await res.json() as any
    return (data.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  } catch { return '' }
}

/**
 * Handle a non-code research/factual turn offline via the Gen-2 research DAG.
 * Uses the provenance oracle cascade (verbatim-provenance → cross-derived →
 * corroborated) — no external model, no unbounded generation.
 * Never throws OfflineEscalateError — the FM handles all non-code turns
 * (research DAG → FM ReAct → FM direct answer, in order).
 * Throws only if the Apple FM daemon is completely unavailable.
 */
export async function solveNonCodeTurn(goal: string, projectPath?: string): Promise<string> {
  // Check FM availability first
  const fmUp = await checkFmAvailable()
  if (!fmUp) throw new OfflineEscalateError('Apple FM daemon unavailable (port 11435) — escalating')

  // ── Tier 1: Research DAG (for factual / research questions) ──────────────
  // Only attempt if the goal looks research-shaped (asking for facts, docs, etc.)
  const isResearchShaped = /\b(what is|how does|explain|describe|tell me|find|search|look up|latest|documentation|docs?|api|tutorial|example|compare|difference between|vs\.?|why is|why are|why was|why did|why does|when did|when was|when is|when will|who is|who was|where is|where was)\b/i.test(goal)

  if (isResearchShaped) {
    let dagAnswer = ''
    let dagConfidence = 0
    try {
      for await (const ev of runResearchDag(goal, {
        projectDir: process.cwd(),
        maxLeafNodes: 4,
        maxWebPages: 6,
        maxMs: 40_000,
        skipReadReliability: true,
      })) {
        if (ev.type === 'research_done') {
          dagAnswer = ev.text ?? ''
          dagConfidence = ev.confidence ?? 0
        }
      }
      if (dagAnswer && dagConfidence > 0) {
        debugBus.emit('agent', 'offline_research_hit', {
          goal: goal.slice(0, 80), confidence: dagConfidence, answerLen: dagAnswer.length,
        }, { severity: 'info' })
        return dagAnswer
      }
      // Confident abstention: the DAG ran, retrieved sources, and concluded it
      // could NOT verify a confident answer (confidence 0 + a non-empty
      // [Abstained] message from buildAbstainedAnswer). This is a CORRECT
      // result, not a failure — preserve it. Falling through to bare Tier-3
      // fmDirectAnswer here makes the FM parrot the (possibly false) premise
      // with no awareness that retrieval already came back empty. A genuine DAG
      // error/failure instead emits `research_error` (or throws), leaving
      // dagAnswer === '', so it still falls through to the FM tiers below.
      if (dagAnswer && dagConfidence === 0) {
        debugBus.emit('agent', 'offline_research_abstain', {
          goal: goal.slice(0, 80), answerLen: dagAnswer.length,
        }, { severity: 'info' })
        return dagAnswer
      }
    } catch (e: any) {
      debugBus.emit('agent', 'offline_research_dag_fail', {
        reason: String(e?.message ?? e).slice(0, 80),
      }, { severity: 'warn' })
      // Fall through to FM ReAct
    }
  }

  // ── Tier 2: FM ReAct loop (tool-using, handles research + reasoning + planning) ──
  // For complex multi-step goals, let FM search/fetch/reason with tools.
  const isComplex = goal.length > 120 || /\b(plan|design|build|create|implement|research|analyze|compare|summarize|review|audit|strategy|approach|steps to|how to|architect)\b/i.test(goal)

  if (isComplex) {
    try {
      const result = await fmReact({
        goal,
        projectPath,
        maxRounds: 6,
      })
      if (result.answer) {
        debugBus.emit('agent', 'fm_react_hit', {
          goal: goal.slice(0, 80),
          rounds: result.rounds,
          toolsUsed: result.toolsUsed,
        }, { severity: 'info' })
        return result.answer
      }
    } catch (e: any) {
      debugBus.emit('agent', 'fm_react_fail', {
        reason: String(e?.message ?? e).slice(0, 80),
      }, { severity: 'warn' })
      // Fall through to direct answer
    }
  }

  // ── Tier 3: FM direct answer (single call, no tools) ──────────────────────
  // Handles explanation, reasoning, planning, analysis — anything the FM knows.
  const directAnswer = await fmDirectAnswer(goal)
  if (directAnswer) {
    debugBus.emit('agent', 'fm_direct_hit', { goal: goal.slice(0, 80) }, { severity: 'info' })
    return directAnswer
  }

  throw new OfflineEscalateError('FM returned empty response — escalating')
}

const MAX_FM_ROUNDS = Number(process.env.CRUCIBLE_OFFLINE_FM_ROUNDS ?? 3)
const MAX_WRITE_CYCLES = Number(process.env.CRUCIBLE_OFFLINE_WRITE_CYCLES ?? 2)

/** Thrown when the FM can't pass the oracle; caller falls through to online driver. */
export class OfflineEscalateError extends Error {
  constructor(reason: string) {
    super(`[offline-escalate] ${reason}`)
    this.name = 'OfflineEscalateError'
  }
}

// ── Decide if a tool call is a code-write ────────────────────────────────────

function isCodeWrite(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName !== 'write_file' && toolName !== 'create_file') return false
  const p = String(args.path ?? args.file_path ?? '')
  return /\.(ts|tsx|js|mjs|jsx)$/.test(p)
}

// ── Intent helpers ────────────────────────────────────────────────────────────

/** True when the goal text signals an edit/fix/refactor rather than new-file. */
function isEditIntent(goal: string): boolean {
  return /\b(fix|refactor|edit|update|change|modify|rename|move|delete|remove|add.*to|improve|bug|broken|wrong)\b/i.test(goal)
}

/**
 * Paths named inside a "do not modify" / "don't edit" clause of the goal text — these are
 * existing, protected files mentioned for context only and must never be picked as a write
 * target. Mirrors the tool-layer PROTECTED_MARKER_RE convention in tools/registry.ts, but
 * matches the natural-language goal phrasing ("Do NOT modify X and Y") rather than a file's
 * first-line comment.
 */
function extractProtectedGoalPaths(goal: string): Set<string> {
  const protectedPaths = new Set<string>()
  // Capture lazily up to an em-dash or a sentence-ending period (period + space + capital
  // letter, or end of string) rather than the next literal '.' — a bare [^.]* boundary would
  // truncate at the first '.' inside a file extension like "src/types.ts" itself.
  const clauseRe = /\b(?:do\s*not|don'?t)\s*(?:modify|edit)\s+([\s\S]*?)(?=—|\.\s+[A-Z]|\.\s*$|$)/gi
  let m: RegExpExecArray | null
  while ((m = clauseRe.exec(goal))) {
    for (const p of m[1].matchAll(/\b((?:src\/|test\/|tests\/)?[\w./\-]+\.(?:ts|tsx|js|mjs))\b/g)) {
      protectedPaths.add(p[1])
    }
  }
  return protectedPaths
}

/**
 * Extract all TS/JS file paths mentioned in the goal, in order of appearance, EXCLUDING
 * paths the goal explicitly marks as protected ("do not modify"). Primary (implementation)
 * file is first; test/index files come after. Without the exclusion, a prompt that lists
 * existing protected files before the actual new target (a natural way to phrase "don't
 * touch X, only add Y") would wrongly select the protected file as goalPaths[0] — the write
 * target the whole S0-S6 state machine keys off of.
 */
function extractGoalPaths(goal: string): string[] {
  const protectedPaths = extractProtectedGoalPaths(goal)
  const all = Array.from(
    goal.matchAll(/\b((?:src\/|test\/|tests\/)?[\w./\-]+\.(?:ts|tsx|js|mjs))\b/g),
    m => m[1],
  )
  // Dedupe preserving order, skip obvious doc references like tsconfig.json, skip protected.
  const seen = new Set<string>()
  return all.filter(p => {
    if (protectedPaths.has(p)) return false
    if (seen.has(p)) return false
    seen.add(p)
    return true
  })
}

/**
 * Extract a shell command the goal asks us to run to validate output.
 * E.g. "runnable with `npx tsx src/index.ts`" → "npx tsx src/index.ts"
 */
function extractSelfTestCmd(goal: string): string | null {
  const m = goal.match(/`((?:npx\s+tsx|node|npm\s+(?:test|run\s+\S+)|ts-node)\s+\S[^`]*)`/)
  return m ? m[1].trim() : null
}

// ── Parsed conversation state ─────────────────────────────────────────────────

interface CurrentState {
  goal: string
  /** Ordered list of all TS/JS file paths from goal (primary first). */
  goalPaths: string[]
  /** Paths already written in this session. */
  writtenPaths: string[]
  /** tsc errors and runtime test failures accumulated so far. */
  recentErrors: string[]
  /** Content of the primary file if a read_file call already returned it. */
  existingFileContent: string | null
  /** Number of completed write cycles (each write_file increments this). */
  writeCycles: number
  /** Self-test command from the goal, if any. */
  selfTestCmd: string | null
  /** Output of the most recent run_command (for checking tsc / self-test results). */
  lastRunOutput: string | null
  /** Whether the self-test has been run at least once. */
  selfTestRan: boolean
}

function parseCurrentState(messages: Array<Record<string, unknown>>): CurrentState {
  const goal = (messages.find(m => m.role === 'user')?.content as string | undefined) ?? ''
  const goalPaths = extractGoalPaths(goal)
  const selfTestCmd = extractSelfTestCmd(goal)

  const writtenPaths: string[] = []
  const recentErrors: string[] = []
  let existingFileContent: string | null = null
  let writeCycles = 0
  let lastRunOutput: string | null = null
  let selfTestRan = false
  let lastReadPath: string | null = null
  let lastWritePath: string | null = null

  for (const msg of messages) {
    const content = String(msg.content ?? '')

    if (msg.role === 'tool') {
      // Capture output of every run_command (last one wins for retry logic)
      if (lastWritePath === null) {
        // Likely a run_command result
        lastRunOutput = content
      }
      // Accumulate tsc and runtime errors
      if (/error TS\d+|FAIL\s*—|FAILURE|AssertionError|TypeError|ReferenceError|SyntaxError/i.test(content)) {
        const firstError = content.split('\n').find(l =>
          /error TS|FAIL|Error|FAILURE/i.test(l)
        )?.trim() ?? content.slice(0, 200)
        recentErrors.push(firstError)
      }
      // Detect if a self-test ran (any run_command after files were written)
      if (selfTestCmd && writtenPaths.length > 0) {
        selfTestRan = true
        lastRunOutput = content
      }
      // Capture read_file content
      if (lastReadPath && !content.startsWith('Error') && content.length > 10) {
        existingFileContent = content
      }
      lastReadPath = null
      lastWritePath = null
    }

    if (msg.role === 'assistant') {
      const tcs: any[] = (msg as any).tool_calls ?? []
      for (const tc of tcs) {
        const name = String(tc.function?.name ?? '')
        const args = typeof tc.function?.arguments === 'string'
          ? JSON.parse(tc.function.arguments || '{}')
          : (tc.function?.arguments ?? {})
        const p = String(args.path ?? args.file_path ?? '')
        if (p && /\.(ts|tsx|js|mjs)$/.test(p)) {
          if (name === 'read_file') lastReadPath = p
          if (name === 'write_file' || name === 'create_file') {
            if (!writtenPaths.includes(p)) writtenPaths.push(p)
            writeCycles++
            lastWritePath = p
          }
        }
        if (name === 'run_command') {
          lastWritePath = null  // next tool result is from run_command
        }
      }
    }
  }

  return {
    goal,
    goalPaths,
    writtenPaths,
    recentErrors,
    existingFileContent,
    writeCycles,
    selfTestCmd,
    lastRunOutput,
    selfTestRan,
  }
}

// ── Synthesize code for a target file ────────────────────────────────────────

/**
 * Strip "Exact public API (<path>):" contract blocks that describe a file OTHER than
 * targetPath. deriveTests/derivePropertyTests (synth/derive.ts) scan the full spec text
 * for `export function/class/const Name` regardless of which file is being synthesized —
 * so a secondary file's spec (e.g. a self-test) that still contains the primary file's
 * full API block gets held to the PRIMARY file's export contract (e.g. src/index.ts
 * expected to itself export filterUsers). Keeps only the block matching targetPath, if any.
 */
function stripForeignApiBlocks(goal: string, targetPath: string): string {
  return goal.replace(
    /Exact public API \(([^)]+)\):\n(?:[ \t]+.*\n?)*/g,
    (block, path) => (path.trim() === targetPath ? block : ''),
  )
}

async function solveCodeWrite(
  targetPath: string,
  state: CurrentState,
  projectPath: string,
): Promise<string> {
  try { ensureIndex(projectPath) } catch { /* best-effort */ }

  const errors = state.recentErrors.slice(-3).join('\n')

  // For secondary files (tests), build a spec that references the already-written
  // primary file so the FM knows what API it's writing against.
  const isSecondary = state.goalPaths.indexOf(targetPath) > 0
  const primaryNote = isSecondary && state.goalPaths[0]
    ? `\n\nNote: the implementation file ${state.goalPaths[0]} has already been written. Write ${targetPath} to test/exercise it per the original goal.`
    : ''

  const goalForSpec = isSecondary ? stripForeignApiBlocks(state.goal, targetPath) : state.goal

  const spec = state.existingFileContent && !isSecondary
    ? buildEditSpec(state.goal, targetPath, state.existingFileContent, errors)
    : [
        goalForSpec,
        errors ? `\nPrevious errors to fix:\n${errors}` : '',
        primaryNote,
        `\n\nTarget file: ${targetPath}`,
      ].filter(Boolean).join('\n')

  let result
  try {
    result = await synthesizeUniversal(spec, {
      projectPath,
      distill: true,
      maxFmRounds: MAX_FM_ROUNDS,
      modulePath: targetPath,
      acceptGateAOnly: true,
    })
  } catch (e: any) {
    throw new OfflineEscalateError(`synthesizeUniversal threw: ${String(e?.message ?? e).slice(0, 200)}`)
  }

  if (result.verified && result.files.length) {
    const hit = result.files.find(f => f.path === targetPath) ?? result.files[0]
    let finalContent = hit.content

    // Gate #2: if the FM emitted section patches (large-file edit mode),
    // splice them back into the original instead of replacing the whole file.
    if (state.existingFileContent && !isSecondary && isSectionPatchOutput(finalContent)) {
      const patches = parseSectionPatches(finalContent)
      if (patches.length > 0) {
        finalContent = applyPatch(state.existingFileContent, patches)
        debugBus.emit('agent', 'offline_patch_applied', {
          path: targetPath,
          sections: patches.map(p => p.name),
        }, { severity: 'info' })
      }
    }

    debugBus.emit('agent', 'offline_synth', {
      source: result.source,
      path: targetPath,
      fmCalls: result.fmCalls,
      cycle: state.writeCycles,
    }, { severity: 'info' })
    return finalContent
  }

  throw new OfflineEscalateError(`no oracle-passing code for ${targetPath}: ${result.detail}`)
}

// ── The offline drive turn ────────────────────────────────────────────────────

/**
 * Offline DriveTurn: deterministic orchestration, FM only for code emission.
 * Emits ONE tool call per invocation; the loop calls us again after execution.
 *
 * Multi-file: writes all TS/JS paths from the goal in order, then verifies.
 * Self-test: runs the goal's specified run command after tsc clean.
 * Retry: replays primary file synthesis with error feedback up to MAX_WRITE_CYCLES.
 */
export function makeOfflineDriveTurn(projectPath: string): DriveTurn {
  return async function offlineDriveTurn(
    messages,
    _tools,
    signal,
    turnClass,
  ): Promise<DriveTurnResult> {
    if (signal?.aborted) throw new Error('Aborted')

    // ── Glue turns are one-shot completions (planner / summary / critic gates), NOT
    // agentic coding-loop steps. Feeding one through the code state machine below
    // misparses the prompt — a harden/grounding prompt embeds source code and tool
    // evidence, so parseCurrentState finds a "file path" and the machine returns empty
    // text plus a spurious write_file/read_file call. That empty text is exactly what
    // silently neutered the fail-open critics (grounding "no JSON", harden "empty reply")
    // on the live path. Route glue straight to a direct FM completion of the actual
    // prompt; escalate to the online glue tier only if the FM is down or returns nothing.
    if (turnClass === 'glue') {
      const fmUp = await checkFmAvailable()
      if (!fmUp) throw new OfflineEscalateError('Apple FM daemon unavailable (port 11435) — glue escalating')
      const text = await fmComplete(messages as Array<{ role: string; content: string }>)
      if (!text.trim()) throw new OfflineEscalateError('FM returned empty glue completion — escalating')
      debugBus.emit('agent', 'offline_glue_hit', { len: text.length }, { severity: 'info' })
      return { text, toolCalls: [] }
    }

    const state = parseCurrentState(messages)
    const { goal, goalPaths, writtenPaths, selfTestCmd } = state

    // Derive the primary path (first mentioned) and what's still unwritten.
    const primaryPath = goalPaths[0] ?? null
    const unwrittenPaths = goalPaths.filter(p => !writtenPaths.includes(p))
    const allWritten = goalPaths.length > 0 && unwrittenPaths.length === 0

    if (!primaryPath) {
      // No TS/JS file in goal — route through the offline intelligence stack:
      // research DAG → FM ReAct (tool-using) → FM direct answer.
      // Only escalates if Apple FM daemon is down entirely.
      debugBus.emit('agent', 'offline_noncode_attempt', { goal: goal.slice(0, 80) }, { severity: 'info' })
      const answer = await solveNonCodeTurn(goal, projectPath)
      return { text: answer, toolCalls: [] }
    }

    // ── S0: Read existing file before editing (edit intent only, primary file only) ──
    const calledTools = messages
      .filter(m => m.role === 'assistant')
      .flatMap(m => ((m as any).tool_calls ?? []) as Array<{ function: { name: string } }>)
      .map(tc => tc.function?.name)

    const hasReadFile = calledTools.includes('read_file')
    if (isEditIntent(goal) && !hasReadFile && !writtenPaths.includes(primaryPath)) {
      return {
        text: '',
        toolCalls: [{
          id: `offline_read_${Date.now()}`,
          name: 'read_file',
          args: { path: primaryPath },
        }],
      }
    }

    // ── S1: Write the next unwritten file ────────────────────────────────────
    if (unwrittenPaths.length > 0) {
      const nextPath = unwrittenPaths[0]
      let content: string
      try {
        content = await solveCodeWrite(nextPath, state, projectPath)
      } catch (e) {
        if (e instanceof OfflineEscalateError) throw e
        throw new OfflineEscalateError(`solveCodeWrite threw: ${String((e as any)?.message ?? e).slice(0, 120)}`)
      }
      return {
        text: '',
        toolCalls: [{
          id: `offline_write_${Date.now()}`,
          name: 'write_file',
          args: { path: nextPath, content },
        }],
      }
    }

    // ── S2: Run tsc after all files written ──────────────────────────────────
    const tscRuns = calledTools.filter(t => t === 'run_command').length
    const needsTsc = allWritten && tscRuns < 1 + Math.max(0, state.writeCycles - goalPaths.length)
    if (needsTsc) {
      return {
        text: '',
        toolCalls: [{
          id: `offline_tsc_${Date.now()}`,
          name: 'run_command',
          args: { command: 'npx tsc --noEmit 2>&1 | head -20 || true' },
        }],
      }
    }

    // Examine the last run output to decide next step.
    const lastOut = state.lastRunOutput ?? ''
    const hasTscErrors = /error TS/.test(lastOut)
    const hasTestFailures = /FAIL\s*—|FAILURE|\d+\s+FAILURE|AssertionError/i.test(lastOut)

    // ── S3: tsc errors + retry budget → re-synthesize primary ────────────────
    if (hasTscErrors && state.writeCycles < goalPaths.length + MAX_WRITE_CYCLES) {
      let content: string
      try {
        content = await solveCodeWrite(primaryPath, state, projectPath)
      } catch (e) {
        if (e instanceof OfflineEscalateError) throw e
        throw new OfflineEscalateError(`retry threw: ${String((e as any)?.message ?? e).slice(0, 120)}`)
      }
      return {
        text: '',
        toolCalls: [{
          id: `offline_retry_${Date.now()}`,
          name: 'write_file',
          args: { path: primaryPath, content },
        }],
      }
    }

    if (hasTscErrors) {
      throw new OfflineEscalateError(
        `tsc errors after ${state.writeCycles} cycle(s) — escalating`
      )
    }

    // ── S4: tsc clean + self-test not yet run → run self-test ────────────────
    if (selfTestCmd && !state.selfTestRan) {
      return {
        text: '',
        toolCalls: [{
          id: `offline_selftest_${Date.now()}`,
          name: 'run_command',
          args: { command: `${selfTestCmd} 2>&1 | tail -30` },
        }],
      }
    }

    // ── S5: self-test failed + retry budget → re-synthesize primary ──────────
    if (state.selfTestRan && hasTestFailures && state.writeCycles < goalPaths.length + MAX_WRITE_CYCLES) {
      let content: string
      try {
        content = await solveCodeWrite(primaryPath, state, projectPath)
      } catch (e) {
        if (e instanceof OfflineEscalateError) throw e
        throw new OfflineEscalateError(`self-test retry threw: ${String((e as any)?.message ?? e).slice(0, 120)}`)
      }
      debugBus.emit('agent', 'offline_synth', { source: 'self-test-retry', path: primaryPath }, { severity: 'info' })
      return {
        text: '',
        toolCalls: [{
          id: `offline_selftest_retry_${Date.now()}`,
          name: 'write_file',
          args: { path: primaryPath, content },
        }],
      }
    }

    if (state.selfTestRan && hasTestFailures) {
      throw new OfflineEscalateError(
        `self-test failures after ${state.writeCycles} cycle(s) — escalating`
      )
    }

    // ── S6: all clean → done ─────────────────────────────────────────────────
    const testNote = selfTestCmd ? ` + self-test passed` : ''
    debugBus.emit('agent', 'offline_turn_hit', { cycles: state.writeCycles, files: writtenPaths.length }, { severity: 'info' })
    return {
      text: `Wrote ${writtenPaths.join(', ')} — tsc clean${testNote} (${state.writeCycles} offline cycle(s)).`,
      toolCalls: [],
    }
  }
}

/**
 * Wraps an online driveTurn with model-cost-independent behaviour.
 * On OfflineEscalateError, silently falls back to the online driver.
 */
export function withOfflineFallback(
  offlineTurn: DriveTurn,
  onlineTurn: DriveTurn,
): DriveTurn {
  return async (messages, tools, signal, turnClass) => {
    // Critic turns (final grounding/harden correctness audit) go straight to the strong
    // online free pool — the on-device FM is at chance on distinguishing subtle-but-real
    // bugs from correct code (measured 2/4 vs gpt-oss-120b's 4/4). This is the one
    // rare, high-value judgment where escalating to a stronger $0 model is worth it.
    if (turnClass === 'critic') return onlineTurn(messages, tools, signal, turnClass)
    try {
      const result = await offlineTurn(messages, tools, signal, turnClass)
      debugBus.emit('agent', 'offline_turn_hit', {}, { severity: 'info' })
      return result
    } catch (e) {
      if (e instanceof OfflineEscalateError) {
        debugBus.emit('agent', 'offline_turn_escalate', {
          reason: String((e as any)?.message ?? e).slice(0, 120),
        }, { severity: 'info' })
        return onlineTurn(messages, tools, signal, turnClass)
      }
      throw e
    }
  }
}

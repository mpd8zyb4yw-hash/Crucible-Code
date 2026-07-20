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

import fs from 'fs'
import path from 'path'
import vm from 'vm'
import { synthesizeUniversal } from '../synth/universal'
import { enqueueFm } from './fmQueue'
import { buildEditSpec, parseSectionPatches, applyPatch, isSectionPatchOutput } from '../synth/editExtract'
import { ensureIndex } from '../state/codebaseIndex'
import { debugBus } from '../debug/bus'
import type { DriveTurn, DriveTurnResult } from './loop'
import { retrieveForTask, namesExternalLibrary } from '../retrieval/retrievalLayer'
import { runResearchDag } from '../research/researchDag'
import { fmReact, fmDirectAnswer, checkFmAvailable, fmComplete, type ConvTurn } from './fmReact'
import { matchMeta } from '../answer/conversational'
import { answerWithWebGrounding } from '../answer/groundedAnswer'
import { runtimeVerifyHtml, runtimeVerifyApp, type AppSpecJudge } from './htmlRuntimeVerify'
import { classifyHtmlGoal, type HtmlGoalKind } from './htmlGoalKind'
// (MiniCPM/GGUF proposer removed from the game hot path — see solveHtmlWrite; h2h cont.70.)

// ── UNIVERSAL synthesis grounding (cont.71) ───────────────────────────────────
// NORTH-STAR: the FM is the planner/synthesizer; the WEB is the knowledge. Every
// generation path — answer, code, game — must retrieve reference material FIRST and
// synthesize against it, never propose from the ~3B model's parametric memory. The
// answer path already grounds by default (solveNonCodeTurn isResearchShaped=true).
// This is the SAME spine for the SYNTHESIS paths: one helper, wired into BOTH
// solveCodeWrite (via synthesizeUniversal.retrievalBlock) and solveHtmlWrite (via
// the proposer prompt prefix). retrieveForTask was imported-but-never-called before
// this — the plumbing existed, nothing fed it, so builds memorized. Best-effort:
// never throws, returns '' on empty/failure so a grounding miss degrades to the
// prior parametric behavior rather than failing the build.
const _GROUND_CACHE = new Map<string, string>()
async function synthesisGroundingBlock(goal: string): Promise<string> {
  const key = goal.trim().slice(0, 200)
  const cached = _GROUND_CACHE.get(key)
  if (cached !== undefined) return cached
  let block = ''
  try {
    const bundle = await retrieveForTask({ goal }, { budget: 2600, maxPages: 3 })
    block = bundle.block ?? ''
    debugBus.emit('agent', block ? 'synth_grounding_hit' : 'synth_grounding_empty',
      { goal: goal.slice(0, 80), sources: bundle.sources.length, bytes: block.length },
      { severity: block ? 'info' : 'warn' })
  } catch (e: any) {
    debugBus.emit('agent', 'synth_grounding_fail',
      { goal: goal.slice(0, 80), reason: String(e?.message ?? e).slice(0, 80) }, { severity: 'warn' })
  }
  _GROUND_CACHE.set(key, block)
  return block
}

// ── Local FM helper (research turns only) ───────────────────────────────────
// Mirrors callLocalModel in server.ts but lives here so synthDriver stays
// self-contained and never imports from server.ts (circular dep risk).
const _LOCAL_FM_URL = process.env.LOCAL_INFERENCE_URL ?? 'http://127.0.0.1:11435'
const _RESEARCH_FM_TIMEOUT = Number(process.env.CRUCIBLE_RESEARCH_FM_TIMEOUT ?? 20000)

async function _callLocalFm(system: string, user: string, ms = _RESEARCH_FM_TIMEOUT): Promise<string> {
  try {
    const res = await enqueueFm(() => fetch(`${_LOCAL_FM_URL}/v1/chat/completions`, {
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
    }), { priority: 'high', label: 'synthDriver' })
    if (!res.ok) return ''
    const data = await res.json() as any
    return (data.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  } catch { return '' }
}

/** Conservative spec-conformance judge for the app path (cont.106). Sees ONLY the app's rendered
 *  surface — never its source — and is told to default to a PASS: it may flag a mismatch only when
 *  the rendered app is clearly a DIFFERENT KIND of thing than the request asked for. Fails open
 *  (returns null) on any model, empty-output or parse error, so it can never turn a working
 *  pipeline red on infrastructure trouble. */
const _appSpecJudge: AppSpecJudge = async ({ goal, surface }) => {
  const sys = 'You check whether a web app matches its build request. You are shown the REQUEST and ' +
    'the TEXT THE APP RENDERED (visible labels and content only — not its code). Decide whether the ' +
    'rendered app is the KIND of app the request asked for. Be lenient: different styling, wording, ' +
    'layout and extra features are all fine, and partial/simple implementations still MATCH. Flag a ' +
    'mismatch ONLY when the rendered app is clearly a DIFFERENT KIND of application than requested — ' +
    'e.g. the request asks for a tip calculator but the app is a to-do list. When in any doubt, it ' +
    'MATCHES. Reply with ONE line of strict JSON and nothing else: {"mismatch": false} if it matches, ' +
    'or {"mismatch": true, "missing": "<what the app should be doing but clearly is not>"} if not.'
  const usr = `REQUEST:\n${goal}\n\nRENDERED APP TEXT:\n${surface}`
  const raw = await _callLocalFm(sys, usr, 12000)
  if (!raw) return null
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const v = JSON.parse(m[0])
    if (typeof v.mismatch !== 'boolean') return null
    return { mismatch: v.mismatch, missing: typeof v.missing === 'string' ? v.missing : undefined }
  } catch { return null }
}

/**
 * Handle a non-code research/factual turn offline via the Gen-2 research DAG.
 * Uses the provenance oracle cascade (verbatim-provenance → cross-derived →
 * corroborated) — no external model, no unbounded generation.
 * Never throws OfflineEscalateError — the FM handles all non-code turns
 * (research DAG → FM ReAct → FM direct answer, in order).
 * Throws only if the Apple FM daemon is completely unavailable.
 */
/** Grounding provenance for a solveNonCodeTurn answer — which tier produced it and, for the
 * research DAG, at what oracle confidence. Lets the caller (answerEngine) distinguish a
 * provenance-grounded retrieval answer from an FM-parametric fallthrough that still needs
 * its own verification lanes. */
export interface NonCodeMeta {
  via: 'dag' | 'dag-abstain' | 'react' | 'direct'
  confidence?: number
  sources?: number
}

export async function solveNonCodeTurn(goal: string, projectPath?: string, history?: ConvTurn[], meta?: (m: NonCodeMeta) => void, opts?: { forceResearch?: boolean }): Promise<string> {
  // ── Identity / greeting / capability are FIXED FACTS the system owns ──────────
  // Whatever routed us here (agent loop, offline driver), a bare "who made you?",
  // "who are you?", etc. must NEVER reach the raw FM — the weak on-device model
  // answers with its own TRAINED identity ("…created by a team of engineers at
  // OpenAI"), which is both wrong and a north-star violation. matchMeta only guarded
  // the non-agent answer path; guarding it here closes the leak for the agent path
  // too, for any phrasing. (This is the backstop; the primary fix is that build
  // requests no longer misroute a stale identity turn into this function at all.)
  const metaMatch = matchMeta(goal)
  if (metaMatch) {
    meta?.({ via: 'direct' })
    return metaMatch.text
  }

  // Check FM availability first
  const fmUp = await checkFmAvailable()
  if (!fmUp) throw new OfflineEscalateError('Apple FM daemon unavailable (port 11435) — escalating')

  // ── Tier 1: Research DAG (for factual / research questions) ──────────────
  // Only attempt if the goal looks research-shaped (asking for facts, docs, etc.).
  // opts.forceResearch: the CALLER already classified this as needing external facts
  // (answerEngine's EXTERNAL_FACT gate) — this local shape-regex must not get a second
  // veto. Split-brain bug this fixes: "who won the 2018 World Cup" fired EXTERNAL_FACT
  // upstream but "who won" was missing from the regex below, so the DAG was skipped and
  // a wrong parametric answer ("Brazil") shipped through the react/direct fallthrough.
  // NORTH-STAR (cont.69): grounding is the DEFAULT, not an opt-in shape. The old regex made the
  // research DAG opt-IN — anything it didn't recognize fell through to the raw FM (parametric
  // memory), which is exactly the "dumb model as the brain" failure. Ground every non-code,
  // non-back-reference goal; the FM only PLANS the decomposition and SYNTHESIZES the retrieved
  // evidence. forceResearch is now redundant (kept for callers) — the default is already research.
  const isResearchShaped = true
  void opts?.forceResearch

  // Context-dependent follow-up detection: a research-shaped query that leans on
  // prior turns ("what is ITS population?", "and THAT one?") must NOT go to the
  // history-blind research DAG — it retrieves against the bare pronoun and either
  // abstains or answers the wrong entity. When we have history and the query
  // carries an unresolved back-reference, skip the DAG and let the FM tiers
  // (which now receive history) resolve the referent.
  const hasHistory = Array.isArray(history) && history.length > 0
  const isBackReference = /\b(it|its|it's|that|this|those|these|they|them|their|there|he|she|his|her|him|the one|the former|the latter|same)\b/i.test(goal) || /^\s*(and|but|what about|how about|ok|okay|so)\b/i.test(goal)
  const contextDependent = hasHistory && isBackReference

  // Code-generation / reasoning tasks must NOT enter the research DAG. A prompt like
  // "…write a function to sort it by age, then tell me the time complexity, and give me a
  // one-line version" trips isResearchShaped on the bare phrase "tell me", but there is no
  // external fact to retrieve — the web DAG finds nothing verifiable, abstains at confidence
  // 0, and (per the abstain-preservation branch below) returns that abstain as the FINAL
  // answer, never reaching the FM tiers that answer it trivially. Detect generation/coding
  // shape and skip the DAG entirely so these route straight to FM ReAct / FM direct.
  // (Over-matching here only means "answer directly instead of web-retrieving" — the safe
  // failure direction; the tight risk is a false-premise factoid that also mentions code,
  // so the code signal requires a generation verb near a code noun, a code fence, or an
  // explicit language + code-construct pairing rather than a bare keyword.)
  const codeGenVerbNoun = /\b(write|create|build|implement|generate|refactor|debug|optimi[sz]e|fix|convert|rewrite|complete|port|translate)\b[^.?!]{0,60}\b(function|method|class|program|script|code|regex|query|algorithm|component|endpoint|api|module|snippet|loop|version|one-?liner)\b/i.test(goal)
  const hasCodeFence = /```|\bdef\s+\w+\s*\(|\bclass\s+\w+|=>|\bfunction\s+\w+\s*\(|\bimport\s+\w+|\bconst\s+\w+\s*=/.test(goal)
  const langMention = /\b(python|javascript|typescript|java|c\+\+|c#|rust|go(?:lang)?|ruby|php|swift|kotlin|bash|shell|sql|html|css|react|node)\b/i.test(goal)
  const codeConstruct = /\b(function|method|class|code|script|program|lambda|closure|list|dict|array|tuple|regex|query|loop|sort|filter|parse|complexity|recursion|iterate)\b/i.test(goal)
  const isCodeShaped = codeGenVerbNoun || hasCodeFence || (langMention && codeConstruct)

  // Premise-bearing questions presuppose a contestable state of affairs — "why is X
  // <surprising property>", "why did X <happen>", "when did X <event>". For THESE, a DAG
  // abstain (confidence 0) is a meaningful result: retrieval could not verify the embedded
  // claim, and falling through to a bare FM call would parrot the (possibly false) premise.
  // Non-premise research-shaped prompts ("compare X and Y", "explain the difference between
  // A and B", "describe when to use each") assert no contestable premise — a DAG abstain
  // there is just a retrieval gap, and the FM tiers below answer them fine. Only the
  // premise-bearing subset should PRESERVE the abstain; everything else falls through.
  const isPremiseBearing = /^\s*(why (is|are|was|were|do|does|did|can|could|would|will)|when (did|was|were|do|does|will|had|has)|how (did|does|do) [^?]*\b(only|never|always|impossible|fail|failed|cause[ds]?)\b)\b/i.test(goal)

  // ── PRIMARY grounding: the SAME web-grounding engine the chat path uses ───────
  // NORTH-STAR (cont.69): the agent path was wired to the legacy runResearchDag, which
  // yields empty on this box and fell SILENTLY through to fmDirectAnswer (parametric memory)
  // — the exact "dumb model as the brain" failure. answerWithWebGrounding is the reliable
  // engine (search → read → synthesize → cite) that already grounds the chat path. Try it
  // FIRST; it returns a cited answer or null (web genuinely empty → a research-quality gap to
  // fix, per north-star, not a license to memorize). Non-code, non-back-reference goals only.
  // NOTE (audit cont.81): `isCodeShaped` was written for the research DAG below, whose abstain
  // is PRESERVED as the final answer (cont.53) — there, over-matching really is "the safe failure
  // direction" as the comment above says. That reasoning does NOT transfer to grounding, which
  // returns null and falls through harmlessly. Reusing the guard here meant a library-shaped code
  // ask skipped the lookup and shipped parametric memory — the exact "dumb model as the brain"
  // failure cont.69 exists to kill. So: keep the guard on the DAG, drop it for grounding when the
  // ask names an external library whose API can only be looked up (never derived or verified).
  if (!contextDependent && (!isCodeShaped || namesExternalLibrary(goal))) {
    try {
      const g = await answerWithWebGrounding(goal, { history })
      if (g && g.text.trim()) {
        debugBus.emit('agent', 'offline_webground_hit', { goal: goal.slice(0, 80), sources: g.sources.length }, { severity: 'info' })
        meta?.({ via: 'dag', confidence: 0.85, sources: g.sources.length })
        return g.text
      }
      debugBus.emit('agent', 'offline_webground_empty', { goal: goal.slice(0, 80) }, { severity: 'warn' })
    } catch (e: any) {
      debugBus.emit('agent', 'offline_webground_fail', { reason: String(e?.message ?? e).slice(0, 80) }, { severity: 'warn' })
    }
  }

  if (isResearchShaped && !contextDependent && !isCodeShaped) {
    let dagAnswer = ''
    let dagConfidence = 0
    let dagSources = 0
    // Conversational answers stay plain-sentence; only surface the
    // confidence/sources scaffold when the user explicitly asks for it.
    const wantsSources = /\b(sources?|cite|citations?|references?|provenance|evidence|confidence|how do you know|according to)\b/i.test(goal)
    try {
      for await (const ev of runResearchDag(goal, {
        projectDir: process.cwd(),
        maxLeafNodes: 4,
        maxWebPages: 6,
        maxMs: 40_000,
        skipReadReliability: true,
        verbose: wantsSources,
      })) {
        if (ev.type === 'research_done') {
          dagAnswer = ev.text ?? ''
          dagConfidence = ev.confidence ?? 0
          dagSources = ev.sources ?? 0
        }
      }
      if (dagAnswer && dagConfidence > 0) {
        debugBus.emit('agent', 'offline_research_hit', {
          goal: goal.slice(0, 80), confidence: dagConfidence, answerLen: dagAnswer.length,
        }, { severity: 'info' })
        meta?.({ via: 'dag', confidence: dagConfidence, sources: dagSources })
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
      if (dagAnswer && dagConfidence === 0 && isPremiseBearing) {
        debugBus.emit('agent', 'offline_research_abstain', {
          goal: goal.slice(0, 80), answerLen: dagAnswer.length,
        }, { severity: 'info' })
        meta?.({ via: 'dag-abstain', confidence: 0 })
        return dagAnswer
      }
      // Non-premise research-shaped prompt whose DAG came back empty/abstained: this is a
      // retrieval gap, not a verified refusal — fall through to the FM tiers rather than
      // shipping "[Abstained] the research DAG could not verify..." for a question the FM
      // can answer from parametric knowledge (e.g. "compare a linked list vs an array").
      if (dagAnswer && dagConfidence === 0) {
        debugBus.emit('agent', 'offline_research_abstain_fallthrough', {
          goal: goal.slice(0, 80),
        }, { severity: 'info' })
        // fall through (do not return)
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
        history,
      })
      if (result.answer) {
        debugBus.emit('agent', 'fm_react_hit', {
          goal: goal.slice(0, 80),
          rounds: result.rounds,
          toolsUsed: result.toolsUsed,
        }, { severity: 'info' })
        meta?.({ via: 'react' })
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
  const directAnswer = await fmDirectAnswer(goal, undefined, history)
  if (directAnswer) {
    debugBus.emit('agent', 'fm_direct_hit', { goal: goal.slice(0, 80) }, { severity: 'info' })
    meta?.({ via: 'direct' })
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
  const pathRe = /\b((?:src\/|test\/|tests\/)?[\w./\-]+\.(?:ts|tsx|js|mjs))\b/g
  // Capture lazily up to an em-dash or a sentence-ending period (period + space + capital
  // letter, or end of string) rather than the next literal '.' — a bare [^.]* boundary would
  // truncate at the first '.' inside a file extension like "src/types.ts" itself.
  const clauseRe = /\b(?:do\s*not|don'?t)\s*(?:modify|edit)\s+([\s\S]*?)(?=—|\.\s+[A-Z]|\.\s*$|$)/gi
  let m: RegExpExecArray | null
  while ((m = clauseRe.exec(goal))) {
    let found = false
    for (const p of m[1].matchAll(pathRe)) { protectedPaths.add(p[1]); found = true }
    // Pronoun back-reference: "The project has src/types.ts (…). Do NOT modify it." names no
    // path inside the clause itself — the object is a pronoun (it/them/these/…) referring to
    // the file(s) introduced in the immediately preceding sentence. Without resolving this, the
    // protected file leaks into goalPaths[0] and the state machine wastes its whole iteration
    // budget writing a file the tool layer blocks (PROTECTED_MARKER_RE), never reaching the
    // real new-file targets. Resolve by protecting every path in the preceding sentence.
    if (!found && /^(?:it|them|this|these|those|that)\b/i.test(m[1].trim())) {
      const before = goal.slice(0, m.index)
      // Anchor to the sentence that CONTAINS the nearest preceding path (the pronoun's
      // referent), not the boundary that ends it — take the last path match, then walk back to
      // the sentence boundary before it so a "src/a.ts and src/b.ts. Do NOT modify them" phrasing
      // protects both files.
      const paths = [...before.matchAll(pathRe)]
      if (paths.length) {
        const lastIdx = paths[paths.length - 1].index ?? 0
        const sentStart = Math.max(before.lastIndexOf('. ', lastIdx), before.lastIndexOf('\n', lastIdx)) + 1
        for (const p of before.slice(sentStart).matchAll(pathRe)) protectedPaths.add(p[1])
      }
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
    goal.matchAll(/\b((?:src\/|test\/|tests\/)?[\w./\-]+\.(?:ts|tsx|js|mjs|html))\b/g),
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
// ── Game / interactive web-artifact goals ─────────────────────────────────────
// "build a playable game" / "build me a snake game" name no file path, so the S0-S6
// TS state machine never engaged and the goal fell through to solveNonCodeTurn, which
// answers in PROSE — the user asked for a game and got a text tutorial. Detect the
// shape and drive it through a dedicated single-file HTML/canvas write instead.
// Games are ALWAYS emitted as self-contained HTML (never pygame): the sandbox is
// stdlib-only and the in-app Preview button is the only runtime we can guarantee.
const DEFAULT_GAME_PATH = 'game.html'
const DEFAULT_APP_PATH = 'app.html'

/** Where a pathless web-artifact goal gets written. Kind-aware: a todo app landing at `game.html`
 *  is merely confusing, and the name is what the user sees in their project. */
export function defaultWebArtifactPath(goal: string): string {
  return classifyHtmlGoal(goal) === 'game' ? DEFAULT_GAME_PATH : DEFAULT_APP_PATH
}

// ── What counts as a single-file web artifact ────────────────────────────────
// This predicate is the ENTRANCE to the whole verified build path (write → static gate → runtime
// gate → repair). A goal it rejects and that names no file falls through to solveNonCodeTurn and
// comes back as PROSE — the user asks for an app and gets a tutorial about writing one.
//
// Until cont.79h the artifact list was mostly NAMED ARCADE TITLES (snake|tetris|pong|flappy…), so
// only games could reach the gate. "build a todo list app", "build an expense tracker", "build a
// unit converter" — every non-game app — silently returned prose unless the user happened to name a
// .html file. That is the same bug the comment above describes for games, still live for apps, and
// it made the app gate's invariants unreachable for the requests they were written for.
//
// The fix is to gate on the SHAPE of the request rather than on an enumeration of instances: a
// creation verb + a word naming a browser-shaped artifact. ARTIFACT_RX is a category vocabulary
// ("app", "tracker", "dashboard"), not an answer key — it encodes what KIND of thing is being asked
// for, never how to build any of it, so it stays inside the no-templates doctrine (cont.79f).
// Correctness still comes only from retrieval + synthesis + the runtime gate.
const CREATION_RX = /\b(build|create|make|write|code|program|implement|generate)\b/

// Generic artifact categories. Deliberately EXCLUDES ambiguous nouns that routinely mean non-UI
// things: "tool" ("a tool to parse logs" is a script), "graph"/"board" (data structure, chess
// board), "interface" (a TypeScript interface). Those must keep falling through to the code path.
const ARTIFACT_RX = /\b(games?|arcade|playable|interactive|apps?|application|tracker|dashboard|widget|calculator|timer|stopwatch|clock|converter|editor|quiz|to-?do list|landing page|web ?page|webpage|website|visuali[sz]ation|animation|simulation|simulator)\b/

// An explicit browser signal routes here regardless of the noun ("write me a single HTML file that…").
const WEB_RX = /\b(html|browser|single[- ]file|front[- ]?end|canvas)\b/

// A named non-browser runtime disqualifies, and wins over both signals above: "build a CLI tool in
// python", "implement a REST API", "make a react dashboard" are all real requests that must NOT be
// answered with a single vanilla-JS file. Framework names count as non-browser here because this
// path emits ONE self-contained file with no build step and no imports.
const NON_BROWSER_RX = /\b(cli|command[- ]line|terminal|python|node(?:\.?js)?|deno|express|server|backend|api|rest|graphql|cron|daemon|bash|shell|library|package|npm|module|sdk|react|vue|angular|svelte|next\.?js|django|flask|rails|swift|kotlin|java|rust|go(?:lang)?)\b/

export function isWebArtifactGoal(goal: string): boolean {
  const m = (goal || '').toLowerCase()
  if (!CREATION_RX.test(m)) return false
  if (NON_BROWSER_RX.test(m)) return false
  return ARTIFACT_RX.test(m) || WEB_RX.test(m)
}

function extractHtmlDoc(raw: string): string {
  const fence = raw.match(/```(?:html)?\s*([\s\S]*?)```/i)
  let s = (fence ? fence[1] : raw).trim()
  const start = s.search(/<!doctype html|<html[\s>]/i)
  if (start > 0) s = s.slice(start)
  return s
}

/** Returns null if the document passes, else a human-readable rejection reason.
 *  The inline-script vm.Script compile is the run-to-verify gate that keeps
 *  syntactically broken code from shipping as "done".
 *  Every check here is kind-agnostic EXCEPT the interactivity one — an app has no canvas, so
 *  requiring one is the static half of the same false-reject the app runtime gate exists to fix. */
function validateHtmlDoc(html: string, kind: HtmlGoalKind = 'game'): string | null {
  if (!/<!doctype html|<html[\s>]/i.test(html)) return 'output is not a complete HTML document'
  if (!/<\/html>/i.test(html)) return 'HTML document is truncated (missing </html>)'
  if (!/<script[\s>]/i.test(html)) return 'no inline <script> found'
  if (kind === 'game' && !/<canvas[\s>]/i.test(html) && !/addEventListener/i.test(html)) return 'no canvas element or event handling — not interactive'
  if (/\b(?:src|href)=["']https?:/i.test(html)) return 'references external network resources — must be fully self-contained'
  for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { new vm.Script(m[1]) } catch (e: any) {
      return `JavaScript syntax error in inline script: ${String(e?.message ?? e).slice(0, 140)}`
    }
  }
  return null
}

// The FM only writes the GAME LOGIC — Crucible owns the HTML shell. Measured on-device
// (2026-07-07): asking the A-series FM for a full HTML document fails constantly on
// output truncation (missing </html>) and const-reassignment TypeErrors. A fixed shell
// + JS-only completion + deterministic sanitizer turns those failure classes off.
function buildGameShell(js: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  html, body { margin: 0; height: 100%; background: #101016; color: #e4e4ee;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex;
    flex-direction: column; align-items: center; justify-content: center; gap: 12px; }
  canvas { background: #16161e; border: 1px solid rgba(255,255,255,0.14); border-radius: 8px;
    max-width: 92vw; max-height: 70vh; }
  #hud { font-size: 15px; letter-spacing: 0.04em; min-height: 20px; }
  #touch { display: flex; gap: 10px; }
  #touch button { width: 52px; height: 52px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.18);
    background: rgba(255,255,255,0.06); color: #e4e4ee; font-size: 20px; cursor: pointer; }
</style>
</head>
<body>
<div id="hud"></div>
<canvas id="game" width="480" height="480"></canvas>
<div id="touch">
  <button data-k="ArrowLeft">◀</button>
  <button data-k="ArrowUp">▲</button>
  <button data-k="ArrowDown">▼</button>
  <button data-k="ArrowRight">▶</button>
</div>
<script>
// Shell-provided plumbing: touch buttons synthesize the same keydown events the game listens for.
document.querySelectorAll('#touch button').forEach(function (b) {
  b.addEventListener('click', function () {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: b.dataset.k }));
  });
});
</script>
<script>
${js}
</script>
</body>
</html>`
}

// Deterministic sanitizers for the FM's most common, mechanically-fixable bugs — each is
// semantics-preserving on generated game code and removes a whole failure class before the
// runtime gate even runs (cheaper than a repair round-trip). NOT prebaked logic: these fix
// how the model expresses an intent it already has, they don't supply the game.
function sanitizeGameJs(js: string): string {
  let out = js.replace(/\bconst\b/g, 'let')
  // Dead fire control: the model writes `e.key === 'Space'`, but the space bar's KeyboardEvent
  // .key value is ' ' (a space) — 'Space' is the .code, not the .key. So the shoot handler never
  // fires and the game is unplayable while still passing an aliveness-only gate. Rewrite ONLY the
  // .key comparison (e.code === 'Space' is correct and left untouched). Covers == and ===.
  out = out.replace(/(\.key\s*===?\s*)(['"])Space\2/g, "$1$2 $2")
  out = out.replace(/(\bkey\s*===?\s*)(['"])Spacebar\2/gi, "$1$2 $2")
  return out
}

// A concrete worked example is worth more than rules to a small model — it anchors the
// loop shape (reschedule every frame, clear every frame, velocity not teleport) that the
// runtime gate enforces. Deliberately a DIFFERENT genre from the games users ask for so
// it's a pattern to copy, not an answer to paste.
const HTML_GAME_EXAMPLE = `Worked example — a "dodge the falling blocks" game, showing the required loop shape:

let cv = document.getElementById('game'), ctx = cv.getContext('2d');
let W = cv.width, H = cv.height;
let player, blocks, score, dead, left, right;
function reset() { player = { x: W/2 - 15, y: H - 40, w: 30, h: 20 }; blocks = []; score = 0; dead = false; left = right = false; }
window.addEventListener('keydown', e => {
  if (dead) { reset(); return; }              // any key restarts after game over
  if (e.key === 'ArrowLeft' || e.key === 'a') left = true;
  if (e.key === 'ArrowRight' || e.key === 'd') right = true;
});
window.addEventListener('keyup', e => {
  if (e.key === 'ArrowLeft' || e.key === 'a') left = false;
  if (e.key === 'ArrowRight' || e.key === 'd') right = false;
});
function step() {
  if (left) player.x -= 6;                     // continuous movement while held
  if (right) player.x += 6;
  player.x = Math.max(0, Math.min(W - player.w, player.x));
  if (Math.random() < 0.04) blocks.push({ x: Math.random() * (W - 20), y: -20, w: 20, h: 20 });
  for (let b of blocks) b.y += 4;              // gravity/motion advances state over time
  blocks = blocks.filter(b => b.y < H);
  for (let b of blocks) if (b.x < player.x + player.w && b.x + b.w > player.x && b.y < player.y + player.h && b.y + b.h > player.y) dead = true;
  score++;
}
function draw() {
  ctx.fillStyle = '#101016'; ctx.fillRect(0, 0, W, H);   // CLEAR the whole canvas EVERY frame
  ctx.fillStyle = '#7cf8a8'; ctx.fillRect(player.x, player.y, player.w, player.h);
  ctx.fillStyle = '#e05555'; for (let b of blocks) ctx.fillRect(b.x, b.y, b.w, b.h);
  document.getElementById('hud').textContent = 'Score: ' + score;
  if (dead) { ctx.fillStyle = '#fff'; ctx.font = '20px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Game over — any key', W/2, H/2); }
}
function loop() { if (!dead) step(); draw(); requestAnimationFrame(loop); }   // reschedule EVERY frame
reset(); requestAnimationFrame(loop);`

const HTML_GAME_SYSTEM = `You write the JavaScript game logic that runs inside a prepared HTML page.
The page already provides:
- <canvas id="game" width="480" height="480"> — draw everything here via its 2d context
- a <div id="hud"> for score/status text
- on-screen touch buttons that dispatch normal keydown events (ArrowUp/Down/Left/Right)

THE GAME LOOP — get this exactly right, it is the most common failure:
- Define ONE loop function. Its LAST line must be requestAnimationFrame(loop) so it runs
  EVERY frame forever. Calling requestAnimationFrame ONCE (outside the loop) freezes the
  game on frame 1 — this is an automatic failure.
- The FIRST thing every frame's draw does is fill the WHOLE canvas with a background color.
  Never-clearing smears the screen.
- Advance the game state over time: things fall, move, spawn, or accelerate on their own
  (gravity, scrolling obstacles, an auto-dropping piece). A game where nothing moves unless
  a key is pressed is not a game.

MOVEMENT & INPUT:
- Model motion as velocity/position updated each frame — NOT an instant teleport in the
  keydown handler. For "flap"/"jump" games: gravity pulls down every frame; a key sets an
  upward velocity. For steering: keydown sets a flag, the loop moves while the flag is set.
- Listen for keydown (and keyup for held movement) on window. Support arrow keys, WASD, and
  Space. After game over, any key restarts.

OUTPUT & CONSTRAINTS:
- Output ONLY JavaScript — no HTML, no markdown fences, no commentary.
- Declare all game state with let (never const). Define helpers and listeners once at top
  level, never inside the loop. Plain ES6, no frameworks, no external resources, no fetch.
- Show the score/status in #hud and draw a game-over state on the canvas.

${HTML_GAME_EXAMPLE}

Copy that LOOP SHAPE exactly (reschedule every frame, clear then draw, state advances over
time) but implement the requested game's OWN mechanics — the example is a different game, so
do not reuse its controls. Keep it simple and correct: a smaller game that runs beats an
ambitious one that freezes or throws.`

// ── Non-game interactive HTML ("app" kind) ───────────────────────────────────
// Same architecture as the game path and for the same measured reason: Crucible owns the HTML
// shell, the FM writes ONLY JS. Asking the on-device FM for a whole document fails on truncation
// (missing </html>) regardless of what the document contains. The app shell differs from the game
// shell in exactly the ways the KIND differs: a plain #app mount instead of a canvas, no HUD, and
// no touch D-pad (there are no arrow keys to fake).
export function buildAppShell(js: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; min-height: 100%; background: #101016; color: #e4e4ee;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.5; }
  #app { max-width: 640px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 22px; letter-spacing: -0.01em; margin: 0 0 20px; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; cursor: pointer;
    border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.08); color: inherit; }
  button:hover { background: rgba(255,255,255,0.14); }
  input, select, textarea { font: inherit; padding: 8px 10px; border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.05); color: inherit; }
  ul, ol { padding-left: 0; list-style: none; }
  li { display: flex; align-items: center; gap: 10px; padding: 9px 0;
    border-bottom: 1px solid rgba(255,255,255,0.09); }
</style>
</head>
<body>
<div id="app"></div>
<script>
${js}
</script>
</body>
</html>`
}

// Worked example for the app path. Deliberately NOT a todo list or a calculator — the two things
// users actually ask for — so it reads as a PATTERN to copy rather than an answer to paste. It
// exists to anchor the one shape the runtime gate enforces: state → render() → listeners attached
// to freshly rendered nodes → every handler ends by calling render().
const HTML_APP_EXAMPLE = `Worked example — a small "vote tally" app, showing the required render shape:

let app = document.getElementById('app');
let options = ['Cats', 'Dogs'];
let votes = { Cats: 0, Dogs: 0 };     // every counter initialized to 0 BEFORE any arithmetic
let entered = '';
function render() {
  app.innerHTML = '';                  // rebuild from state every time — never patch by hand
  let h = document.createElement('h1'); h.textContent = 'Vote tally'; app.appendChild(h);
  let ul = document.createElement('ul');
  options.forEach(function (name) {
    let li = document.createElement('li');
    let label = document.createElement('span');
    label.textContent = name + ' — ' + votes[name];
    let b = document.createElement('button');
    b.textContent = 'Vote';
    b.addEventListener('click', function () { votes[name] += 1; render(); });  // mutate, then RE-RENDER
    li.appendChild(label); li.appendChild(b); ul.appendChild(li);
  });
  app.appendChild(ul);
  let row = document.createElement('form');
  let input = document.createElement('input');
  input.placeholder = 'add an option';
  input.value = entered;
  input.addEventListener('input', function (e) { entered = e.target.value; });
  let add = document.createElement('button');
  add.type = 'submit'; add.textContent = 'Add';
  row.addEventListener('submit', function (e) {
    e.preventDefault();                // a form submit RELOADS the page unless you prevent it
    let v = entered.trim(); if (!v) return;
    if (!votes[v]) { options.push(v); votes[v] = 0; }
    entered = ''; render();
  });
  row.appendChild(input); row.appendChild(add); app.appendChild(row);
}
render();                              // render once on load so the page is never blank`

const HTML_APP_SYSTEM = `You write the JavaScript for a small self-contained web app that runs inside a prepared HTML page.
The page already provides:
- <div id="app"> — build the ENTIRE user interface inside this element from JavaScript
- sensible base styling for headings, buttons, inputs and lists — do not write CSS

THE RENDER SHAPE — get this exactly right, it is the most common failure:
- Keep the app's data in top-level state variables. Define ONE render() function that rebuilds the
  UI inside #app from that state, and call render() once at the end so the page is never blank.
- render() must build the ENTIRE interface — the input fields, the buttons AND the list/output.
  Because render() starts by clearing its container, anything you create OUTSIDE render() is
  DESTROYED the first time you re-render, and the app becomes unusable. Everything lives inside
  render(). Never append controls to #app outside of it.
- Attach every listener to the elements you just created inside render(). A listener attached to an
  element that does not exist yet silently does nothing.
- Commit changes on the BUTTON click or the form submit — never in an 'input' listener. An 'input'
  listener fires on EVERY KEYSTROKE, so adding an item there turns typing "milk" into four separate
  items ("m", "mi", "mil", "milk"). If you track the field's value as the user types, only ASSIGN
  it to a state variable there; do the add/commit in the click or submit handler.
- EVERY event handler must end by calling render(). Updating a state variable alone changes nothing
  on screen — the page is verified by clicking your controls and checking that the page actually
  changes, and a button that does not change anything is an automatic failure.
- For a <form>, always call e.preventDefault() in the submit handler — otherwise the page reloads
  and the app resets.

CORRECTNESS:
- Initialize every counter/total to 0 BEFORE any arithmetic. Convert text input with Number(...)
  and ignore empty or invalid input. Never divide by zero. A value displayed as "NaN" or
  "undefined" is an automatic failure.
- Guard empty input: if the field is blank, return without changing state.

OUTPUT & CONSTRAINTS:
- Output ONLY JavaScript — no HTML, no markdown fences, no commentary.
- Declare all state with let (never const). Plain ES6, no frameworks, no external resources,
  no fetch, no network, no localStorage.

${HTML_APP_EXAMPLE}

Copy that RENDER SHAPE exactly (state → render() rebuilds #app → handlers mutate then re-render)
but implement the requested app's OWN features — the example is a different app, so do not reuse
its data or controls. Keep it simple and correct: a smaller app that works beats an ambitious one
that throws or does nothing when clicked.`


// ── Repair-move selection (shared by the game and app write loops) ────────────────────────────
// Handed its own previous code and told to "fix it", the weak on-device FM frequently returns that
// code VERBATIM. Echoing is not repair: an unchanged candidate is re-run, fails the SAME check, and
// produces the same feedback — a fixpoint that spends the entire remaining attempt budget on one
// proposal. Measured (cont.79i, live): 3 of 3 escalating todo builds emitted exactly ONE unique
// candidate across 5-6 attempts, so ~83% of the repair budget bought literally nothing. This was
// invisible for two sessions because a rejection records what the GATE saw, never what the model
// wrote — the identical-candidate pattern only showed up once CRUCIBLE_DUMP_REJECTS existed.
//
// Detecting it needs no model call and cannot false-fire: byte-identical code provably re-earns the
// same verdict, so repeating it is useless by construction. When it happens the local repair
// trajectory is exhausted, so change the MOVE rather than repeat it — drop the previous-code echo
// that anchors the model to its own text, restore the web reference (the highest-signal input we
// have), and resample hotter to break the tie. This is the north-star search step: when a move stops
// producing new candidates, take a different one.
export interface RepairMove {
  /** Appended to the next proposer prompt. */
  feedback: string
  /** Re-attach the web reference next attempt — the model's own trajectory is spent. */
  reground: boolean
  /** Sampling temperature for the next attempt (0.2 = the daemon's default). */
  temperature: number
}

const PRIOR_FAULTS_HEAD =
  '\n\nEVERY fault below has already caused a rejection in this session — do NOT reintroduce any of them while fixing the current one:\n'

export function nextRepairMove(problem: string, seenProblems: string[], prevJs: string, echoed: boolean): RepairMove {
  const priorFaults = seenProblems.length > 1
    ? PRIOR_FAULTS_HEAD + seenProblems.map(p => `  • ${p}`).join('\n')
    : ''
  const head = `\n\nYour previous attempt was RUN in a real browser and rejected: ${problem}${priorFaults}\n\n`
  if (echoed) {
    // Quoting the model's own text back is what anchors it, so withhold the previous code entirely
    // and ask for a materially different implementation.
    return {
      feedback: head +
        'You have now submitted that SAME code more than once and it fails identically every time. ' +
        'Do NOT output it again. Discard that approach and write a DIFFERENT implementation from ' +
        'scratch that avoids the fault above.',
      reground: true,
      temperature: 0.8,
    }
  }
  return {
    feedback: head +
      'Here is your previous code — FIX the specific problem above, keep what works, and output the ' +
      `FULL corrected JavaScript (nothing else):\n\n${prevJs.slice(0, 1800)}`,
    reground: false,
    temperature: 0.2,
  }
}

// ── Web grounding for the game path ("Crucible IS the model" — but not from memory). ──
// The on-device FM writes classics it has never seen well (Space Invaders failed 6× straight,
// pure parametric recall) because it is guessing the mechanics rather than adapting a real,
// working implementation. So for any named game NOT covered by a deterministic template, fetch
// a reference JS implementation from the open web ONCE and fold it into the first proposer prompt.
//
// DOCTRINE-SOUND, exactly like codeResearch channel 3: the retrieved code is an UNTRUSTED hint.
// Every candidate — grounded or not — still passes through the same static + RUNTIME gate
// (validateHtmlGame → runtimeVerifyHtml, which loads it in a real browser and drives input). A
// wrong or irrelevant snippet can only waste a proposal; it can never ship a broken game. Best-
// effort and bounded: any failure returns null and the loop proceeds ungrounded as before.
const WEB_GAME_MARK = 'WORKING REFERENCE IMPLEMENTATION (fetched live from the open web — this game already runs). PORT IT FAITHFULLY: keep its exact mechanics, constants, and loop structure; change ONLY the canvas lookup to document.getElementById(\'game\') and delete any HTML/DOM/canvas-creation it does. Do NOT simplify or reinvent — reproduce its logic. Your output is run in a real browser and verified:'

function buildGameSearchQuery(goal: string): string {
  // Extract the game's name ("build me a space invaders game" → "space invaders") and pin the
  // retrieval to a self-contained canvas implementation, which ranks real playable code first.
  const name = (goal.match(/\b([\w][\w '-]{2,40}?)\s+game\b/i)?.[1] ?? goal)
    // Strip request filler from either branch so only the game's own name reaches retrieval
    // ("build me a space invaders game" → "space invaders").
    .replace(/\b(build|make|create|write|me|a|an|the|please|can|could|you|would|like|want|game|in|using|with|js|javascript|html5?|canvas)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim()
  return `${name} javascript canvas game implementation`.slice(0, 120)
}

async function retrieveGameReference(goal: string): Promise<string | null> {
  try {
    const bundle = await retrieveForTask(
      { goal: buildGameSearchQuery(goal) },
      { maxPages: 2, budget: 2200 },
    )
    // Prefer the LARGEST retrieved block — a complete game to port beats a ranked snippet
    // that may be a fragment. The weak FM compresses anyway; give it the whole thing to anchor on.
    const snippet = bundle.codeBlocks
      .map(c => c.code?.trim() ?? '')
      .sort((a, b) => b.length - a.length)[0]
    // Require a substantive block — a one-liner is noise, not a reference to adapt.
    if (!snippet || snippet.length < 120) return null
    return `${WEB_GAME_MARK}\n${snippet.slice(0, 6000)}`
  } catch {
    return null
  }
}

async function solveHtmlWrite(targetPath: string, state: CurrentState): Promise<string> {
  // WHICH KIND of artifact is this? Before cont.79e every .html goal took the game path — canvas
  // shell, game prompt, game gate — so a correct todo app was rejected with "no <canvas> element
  // present at runtime" and that string was fed back as repair feedback for 6 attempts, pushing
  // the model to bolt a canvas onto a todo list. Each kind now carries invariants true for it.
  const kind = classifyHtmlGoal(state.goal)
  debugBus.emit('agent', 'offline_html_kind', { path: targetPath, kind, goal: state.goal.slice(0, 80) }, { severity: 'info' })
  if (kind === 'app') return solveAppHtmlWrite(targetPath, state)
  // NO memorized templates (doctrine, user-forced cont.79f): correctness comes from web-retrieved
  // reference impls + FM synthesis + the runtime behavioral gate, never a baked-in answer. The
  // game path grounds its first attempt on retrieveGameReference below.
  const fmUp = await checkFmAvailable()
  if (!fmUp) throw new OfflineEscalateError('Apple FM daemon unavailable (port 11435) — html write escalating')
  const title = (state.goal.match(/\b(\w[\w\s-]{2,30}?)\s+game\b/i)?.[1] ?? 'Crucible').trim() + ' — Crucible'
  const MAX_ATTEMPTS = 6
  // Feedback is now DIAGNOSTIC (the runtime gate names the exact fault: frozen loop, blank
  // canvas, dead input), so repairing the model's OWN previous code beats asking it to
  // rewrite from scratch — a small model regresses less when editing than when regenerating.
  // That holds only while it actually edits: see nextRepairMove for the echo fixpoint.
  let prevJs = ''
  let move: RepairMove = { feedback: '', reground: false, temperature: 0.2 }
  // Distinct faults seen across attempts. Small models oscillate — they fix the newly
  // reported bug while silently reintroducing one they already fixed. Carrying the full
  // history and telling the model "these were ALL already rejected, don't bring any back"
  // measurably reduces that thrash without changing the gate.
  const seenProblems: string[] = []
  // Web reference fetched ONCE up front (see retrieveGameReference): grounds the FIRST attempt so
  // it adapts a real implementation instead of guessing mechanics from memory. Dropped on later
  // attempts — by then the model is repairing its OWN prevJs, which already reflects the reference,
  // and the diagnostic feedback is the higher-signal context. null when the web returned nothing.
  const webReference = await retrieveGameReference(state.goal)
  if (webReference) debugBus.emit('agent', 'offline_html_web_ground', { path: targetPath, bytes: webReference.length }, { severity: 'info' })
  // MiniCPM5 was previously seated as an even-attempt "diverse proposer" here on the theory that
  // ≥2 distinct impls beat one model iterated N times. A head-to-head on the fault-injection
  // harness (cont.70) DISPROVED that for this workload: MiniCPM recovered 8% (2/25) vs Apple FM's
  // 52% (13/25) and ran ~14× slower (3036s vs 226s across the sweep) — on 8GB the GGUF load also
  // pressures the whole machine. So MiniCPM is OUT of the game hot path: Apple FM is the sole
  // proposer, seeing its own diagnostic rejection feedback each attempt. (Diversity that measurably
  // helps is re-added only if a future h2h proves a peer wins — not on the ≥2-impls prior alone.)
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const grounding = ((attempt === 1 || move.reground) && webReference) ? `\n\n${webReference}` : ''
    const userMsg = `Build this game: ${state.goal}${grounding}${move.feedback}\n\nOutput the JavaScript game logic now.`
    let raw = ''
    const proposer = 'apple-fm'
    raw = await fmComplete([
      { role: 'system', content: HTML_GAME_SYSTEM },
      { role: 'user', content: userMsg },
    ], { maxTokens: 4096, temperature: move.temperature })
    debugBus.emit('agent', 'offline_html_proposer', { path: targetPath, attempt, model: proposer }, { severity: 'info' })
    const fence = raw.match(/```(?:javascript|js)?\s*([\s\S]*?)```/i)
    const js = sanitizeGameJs((fence ? fence[1] : raw).trim())
    const html = js ? buildGameShell(js, title) : ''
    // Two gates: static (syntax/self-containment), then RUNTIME — load in the bundled
    // Electron offscreen, drive keys, and require a canvas that draws at load, stays
    // ALIVE (self-animates or responds to input), and throws no errors. The static gate
    // alone shipped parse-clean games that were dead on frame 1.
    const problem = html
      ? (validateHtmlDoc(html, 'game') ?? await runtimeVerifyHtml(html, state.goal))
      : 'empty completion'
    if (!problem) {
      debugBus.emit('agent', 'offline_html_synth', { path: targetPath, attempt, model: proposer, bytes: html.length }, { severity: 'info' })
      return html
    }
    debugBus.emit('agent', 'offline_html_retry', { path: targetPath, attempt, model: proposer, problem }, { severity: 'info' })
    // See nextRepairMove: an unchanged candidate is a fixpoint, not a repair.
    const echoed = attempt > 1 && js !== '' && js === prevJs
    if (echoed) debugBus.emit('agent', 'offline_html_echo_stall', { path: targetPath, attempt, kind: 'game' }, { severity: 'warn' })
    prevJs = js
    if (!seenProblems.includes(problem)) seenProblems.push(problem)
    move = nextRepairMove(problem, seenProblems, prevJs, echoed)
  }
  throw new OfflineEscalateError(
    `FM could not produce a working game after ${MAX_ATTEMPTS} run-verified attempts`)
}

// ── Web grounding for the app path (mirrors retrieveGameReference) ──
// NO memorized templates (doctrine, user-forced cont.79f): the weak on-device FM can't one-shot a
// correct app from parametric memory, so — exactly as the game path does — fetch a REAL working
// vanilla-JS implementation from the open web ONCE and fold it into the first proposer prompt. The
// retrieved code is an UNTRUSTED hint: every candidate, grounded or not, still passes the static +
// RUNTIME app gate (dead-control / self-erasing / blank-render / NaN), so a wrong snippet can only
// waste a proposal, never ship a broken app. Best-effort and bounded — any failure returns null and
// the loop proceeds ungrounded.
// The porting instruction is load-bearing and was actively CAUSING a failure (cont.79i). Real
// vanilla-JS apps on the web keep their controls in an HTML file and only WIRE them in script
// (`document.querySelector('#task-form')`). This mark used to say "delete its own HTML shell/markup"
// and stop there — so the model dutifully deleted the markup, kept the wiring, and shipped a form
// with no input and no button inside it (the exact live empty-<form> shape). Deleting the markup is
// only half the port: every element the reference LOOKS UP has to be CREATED here, because in the
// reference it came from the HTML the model was just told to throw away. Say that explicitly.
const WEB_APP_MARK = 'WORKING REFERENCE IMPLEMENTATION (fetched live from the open web — this app already works). PORT ITS LOGIC FAITHFULLY into a single render() that rebuilds everything inside document.getElementById(\'app\'): keep its state model and event handling, but drop any framework imports and external resources.\n' +
  'CRITICAL — this reference came with an HTML file that YOU DO NOT HAVE. Every element it looks up with querySelector/getElementById (its inputs, its buttons, its list container) lived in that HTML. You are deleting that markup, so you must CREATE each of those elements yourself with document.createElement inside render() and append it, BEFORE you attach the reference\'s listener to it. Porting the reference\'s wiring without creating the elements it wires leaves an empty, unusable page — that is an automatic failure. Do NOT simplify or reinvent the logic. Your output is run in a real browser and verified:'

function buildAppSearchQuery(goal: string): string {
  // Distil the app's name from the request ("build me a markdown notes app" → "markdown notes")
  // and pin retrieval to a self-contained vanilla-JS implementation, which ranks real usable code
  // above framework tutorials the FM can't port offline.
  const name = (goal.match(/\b([\w][\w '-]{2,40}?)\s+(?:app|tool|tracker|dashboard|page|widget)\b/i)?.[1] ?? goal)
    .replace(/\b(build|make|create|write|me|a|an|the|please|can|could|you|would|like|want|app|tool|in|using|with|js|javascript|html5?|vanilla|simple)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim()
  return `${name} vanilla javascript app implementation no framework`.slice(0, 120)
}

/**
 * How usable a retrieved snippet is AS A REFERENCE FOR OUR SHELL — higher is better.
 *
 * The shell hands the model an empty `<div id="app">` and requires the whole UI to be built from
 * JavaScript. Most real vanilla-JS apps on the web do the OPPOSITE: their HTML file declares the
 * markup and the script merely wires it (`document.querySelector('#task-form')`). Ported into our
 * shell, every one of those selectors returns null, so such a snippet can only teach the model to
 * query elements that do not exist. That is very likely the live empty-`<form>` failure (cont.79h):
 * the model reproduced the reference's `form.addEventListener(...)` but not the children the
 * reference never had to create, because in the reference they were markup.
 *
 * So rank by CONSTRUCTION. The old selector took the LONGEST block, which is uncorrelated with
 * portability — measured live, it picked a snippet carrying 6 queries against markup we never ship.
 * A snippet that builds its own DOM ports cleanly; one that only queries pre-existing markup cannot,
 * and grounding on it is worse than not grounding at all.
 */
export function scoreAppReference(code: string): number {
  const n = (re: RegExp) => (code.match(re) ?? []).length
  const constructs = n(/createElement\s*\(/g) * 2 + n(/innerHTML\s*=/g) + n(/insertAdjacentHTML\s*\(/g)
  // Queries against markup we do not ship. `#app` is the one element the shell actually provides.
  const queriesMarkup = n(/(?:querySelector(?:All)?|getElementById)\s*\(\s*['"`](?!#?app['"`])/g)
  return constructs - queriesMarkup
}

async function retrieveAppReference(goal: string): Promise<string | null> {
  try {
    const bundle = await retrieveForTask({ goal: buildAppSearchQuery(goal) }, { maxPages: 2, budget: 2200 })
    const snippet = bundle.codeBlocks
      .map(c => c.code?.trim() ?? '')
      // Prefer real DOM/interaction code (addEventListener/createElement) over inert config blobs.
      .filter(c => /addEventListener|createElement|querySelector|innerHTML|onclick/.test(c))
      .map(code => ({ code, score: scoreAppReference(code) }))
      // A net markup-querying snippet teaches the model to wire elements our shell never renders —
      // strictly worse than proposing ungrounded, so drop it rather than ship a misleading prior.
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score || b.code.length - a.code.length)[0]?.code
    if (!snippet || snippet.length < 120) return null
    return `${WEB_APP_MARK}\n${snippet.slice(0, 6000)}`
  } catch {
    return null
  }
}

// Non-game interactive HTML. Same loop shape as the game path — retrieve a web reference → propose
// JS → build a shell → static gate → RUNTIME gate → feed the diagnostic back and repair the model's
// OWN code. Deliberately NOT merged with the game loop: the two share a skeleton but differ in every
// payload, and a single flag-threaded function would make both harder to read than the duplicate.
async function solveAppHtmlWrite(targetPath: string, state: CurrentState): Promise<string> {
  const fmUp = await checkFmAvailable()
  if (!fmUp) throw new OfflineEscalateError('Apple FM daemon unavailable (port 11435) — html app write escalating')
  const title = (state.goal.match(/\b(\w[\w\s-]{2,30}?)\s+(?:app|page|tool|tracker|dashboard)\b/i)?.[1] ?? 'Crucible').trim() + ' — Crucible'
  const MAX_ATTEMPTS = 6
  let prevJs = ''
  let move: RepairMove = { feedback: '', reground: false, temperature: 0.2 }
  const seenProblems: string[] = []
  // Web reference fetched ONCE up front — grounds the FIRST attempt so the FM adapts a real working
  // app instead of guessing from memory. Dropped on later attempts (by then it repairs its own code
  // against the higher-signal runtime diagnostic), and restored by nextRepairMove if the model
  // stalls on its own text. null when the web returned nothing usable.
  const webReference = await retrieveAppReference(state.goal)
  if (webReference) debugBus.emit('agent', 'offline_html_web_ground', { path: targetPath, kind: 'app', bytes: webReference.length }, { severity: 'info' })
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const grounding = ((attempt === 1 || move.reground) && webReference) ? `\n\n${webReference}` : ''
    const userMsg = `Build this app: ${state.goal}${grounding}${move.feedback}\n\nOutput the JavaScript now.`
    const raw = await fmComplete([
      { role: 'system', content: HTML_APP_SYSTEM },
      { role: 'user', content: userMsg },
    ], { maxTokens: 4096, temperature: move.temperature })
    debugBus.emit('agent', 'offline_html_proposer', { path: targetPath, attempt, model: 'apple-fm', kind: 'app' }, { severity: 'info' })
    const fence = raw.match(/```(?:javascript|js)?\s*([\s\S]*?)```/i)
    // const→let only: the app path has no fire-control key bug to rewrite, and the rest of
    // sanitizeGameJs is game-specific. Reassigning a const is the same crash here as there.
    const js = (fence ? fence[1] : raw).trim().replace(/\bconst\b/g, 'let')
    const html = js ? buildAppShell(js, title) : ''
    const problem = html
      ? (validateHtmlDoc(html, 'app') ?? await runtimeVerifyApp(html, state.goal, _appSpecJudge))
      : 'empty completion'
    if (!problem) {
      debugBus.emit('agent', 'offline_html_synth', { path: targetPath, attempt, model: 'apple-fm', kind: 'app', bytes: html.length }, { severity: 'info' })
      return html
    }
    debugBus.emit('agent', 'offline_html_retry', { path: targetPath, attempt, model: 'apple-fm', kind: 'app', problem }, { severity: 'info' })
    // Opt-in forensics (CRUCIBLE_DUMP_REJECTS=<dir>). A rejection tells you WHAT the gate saw but
    // not what the model wrote, and without the candidate you cannot tell a real FM bug from a gate
    // false-reject — cont.79h burned a whole 5-run measurement on exactly that ambiguity. Off by
    // default, never on a hot path.
    if (process.env.CRUCIBLE_DUMP_REJECTS) {
      try {
        const dir = process.env.CRUCIBLE_DUMP_REJECTS
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(`${dir}/reject-${Date.now()}-a${attempt}.html`, `<!-- ${problem} -->\n${html}`)
      } catch { /* forensics must never break a build */ }
    }
    // Compare BEFORE prevJs is overwritten: an unchanged candidate means the model echoed its own
    // previous answer rather than repairing it, so the next attempt must change strategy.
    const echoed = attempt > 1 && js !== '' && js === prevJs
    if (echoed) debugBus.emit('agent', 'offline_html_echo_stall', { path: targetPath, attempt, kind: 'app' }, { severity: 'warn' })
    prevJs = js
    if (!seenProblems.includes(problem)) seenProblems.push(problem)
    move = nextRepairMove(problem, seenProblems, prevJs, echoed)
  }
  throw new OfflineEscalateError(
    `FM could not produce a working app after ${MAX_ATTEMPTS} run-verified attempts`)
}

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

function parseCurrentState(messages: Array<Record<string, unknown>>, explicitGoal?: string): CurrentState {
  // The goal MUST be the current turn's request. Deriving it from the FIRST user message
  // in the array is only correct when the array starts with the goal — but the server
  // prepends prior conversation history (user/assistant pairs) ahead of the goal for
  // multi-turn continuity. In that case `find(first user)` returns a STALE earlier turn
  // (e.g. a previous "who made you?"), so the state machine ends up building/answering the
  // wrong request — the FM then free-associates its trained identity ("…OpenAI") instead
  // of the actual task. When the caller knows the real goal (single-loop path), it passes
  // it explicitly; only fall back to message-sniffing when it doesn't.
  const goal = (explicitGoal && explicitGoal.trim())
    ? explicitGoal
    : ((messages.find(m => m.role === 'user')?.content as string | undefined) ?? '')
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
        if (p && /\.(ts|tsx|js|mjs|html)$/.test(p)) {
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

/**
 * Multi-file goals often sketch each new file as a numbered section:
 *   "1. src/ledger.ts:\n     export class Ledger {...}\n2. src/report.ts:\n     export function categoryTotals(...)"
 * derive.ts's extractFeatures scans the WHOLE spec for `export …` names with no file-awareness,
 * so synthesizing src/ledger.ts against the full goal makes the oracle expect ledger.ts to ALSO
 * export categoryTotals (report.ts's API) — the generated spec.test.ts imports a member that
 * doesn't exist and fails tsc on every candidate, tripwiring the file that never had a chance.
 * Drop every numbered file-sketch section whose path ISN'T targetPath, keeping the preamble, the
 * target's own section, and the trailing shared prose (Rules/self-test). No-op unless the goal has
 * ≥2 such numbered file sections, so single-file greenfield specs are untouched. The dropped file
 * is still available to the FM from disk (it is written first and indexed) — this only narrows the
 * oracle's export contract, not the FM's context.
 */
function scopeNumberedFileSections(goal: string, targetPath: string): string {
  const lines = goal.split('\n')
  const headerRe = /^\s*\d+\.\s+.*?((?:src\/|test\/|tests\/)?[\w./\-]+\.(?:ts|tsx|js|mjs))\b/
  if (lines.filter(l => headerRe.test(l)).length < 2) return goal
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const m = headerRe.exec(lines[i])
    if (m && m[1] !== targetPath) {
      // Skip this foreign section: its header plus following blank/indented body lines,
      // stopping at (but keeping) the next column-0 non-blank line (next header or Rules:).
      i++
      while (i < lines.length && (lines[i].trim() === '' || /^\s/.test(lines[i]))) i++
      continue
    }
    out.push(lines[i])
    i++
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
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

  // Narrow the oracle's export contract to targetPath's own API. stripForeignApiBlocks handles
  // the "Exact public API (<path>):" format; scopeNumberedFileSections handles the multi-file
  // "1. src/a.ts: … 2. src/b.ts: …" format. Both are no-ops on a single-file greenfield goal, so
  // apply to primary files too — a multi-file goal leaks a sibling's exports into the PRIMARY
  // file's contract just as readily as into a secondary self-test's.
  const goalForSpec = scopeNumberedFileSections(stripForeignApiBlocks(state.goal, targetPath), targetPath)

  const spec = state.existingFileContent && !isSecondary
    ? buildEditSpec(goalForSpec, targetPath, state.existingFileContent, errors)
    : [
        goalForSpec,
        errors ? `\nPrevious errors to fix:\n${errors}` : '',
        primaryNote,
        `\n\nTarget file: ${targetPath}`,
      ].filter(Boolean).join('\n')

  // UNIVERSAL grounding (cont.71): retrieve reference material and synthesize against it —
  // the SAME spine as the answer path and the game path, now for general code. synthesizeUniversal
  // already accepts retrievalBlock but nothing fed it, so code was written from parametric memory.
  // Only the primary implementation file is grounded: secondary/test files write against the
  // already-written primary API, where a web reference is noise, not signal.
  const retrievalBlock = isSecondary ? '' : await synthesisGroundingBlock(state.goal)

  let result
  try {
    result = await synthesizeUniversal(spec, {
      projectPath,
      distill: true,
      maxFmRounds: MAX_FM_ROUNDS,
      modulePath: targetPath,
      acceptGateAOnly: true,
      retrievalBlock: retrievalBlock || undefined,
      // Change-set scope (cont.99): the goal's OTHER declared files are pending edits, so a
      // type error located in one of them is a consequence of this edit being incomplete, not
      // of this edit being wrong. Deferring them makes the transiently-broken intermediate
      // states of a coupled multi-file refactor reachable. Whole-project green is still
      // required once every goalPath has been written.
      // Only files NOT yet written are deferred: once a change-set file has been written, an
      // error in it is a real defect this gate must still catch (cont.85 — a verifier fails in
      // two directions; widening scope past the pending set would false-CERTIFY).
      changeSetScope: state.goalPaths.filter(p => p !== targetPath && !state.writtenPaths.includes(p)),
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
export function makeOfflineDriveTurn(projectPath: string, explicitGoal?: string): DriveTurn {
  return async function offlineDriveTurn(
    messages,
    _tools,
    signal,
    turnClass,
  ): Promise<DriveTurnResult> {
    if (signal?.aborted) throw new Error('Aborted')

    // ── Critic turns (final grounding/harden correctness audit) have no offline
    // equivalent — __critic_bench.ts measured the on-device FM at chance (2/4) on this
    // judgment, which is why withOfflineFallback routes 'critic' straight to the online
    // pool before it ever reaches this function. But in CRUCIBLE_OFFLINE=strict mode
    // (server.ts), this function IS the driveTurn directly, with no wrapper in front of
    // it — so a critic prompt used to fall through to the S0-S6 code state machine below,
    // which misparses the embedded source-file headers as goalPaths and happens to bottom
    // out at an empty `text: ''` return. runHardenReview (loop.ts) treats empty text as
    // "reviewer failed" and calls localHardenFallback — so the right thing occurred, but
    // only as a side effect of a parse that was never meant to see this prompt shape.
    // Escalate explicitly instead: same landing spot (localHardenFallback), reached on
    // purpose rather than by accident.
    if (turnClass === 'critic') {
      throw new OfflineEscalateError('critic turn class has no offline equivalent — routing to local harden fallback')
    }

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

    const state = parseCurrentState(messages, explicitGoal)
    const { goal, writtenPaths, selfTestCmd } = state
    // Pathless game/interactive builds get a default HTML target so they run through
    // the code state machine (write → verify → done) instead of the prose Q&A path.
    if (state.goalPaths.length === 0 && isWebArtifactGoal(goal)) {
      state.goalPaths = [defaultWebArtifactPath(goal)]
      debugBus.emit('agent', 'offline_game_goal', { goal: goal.slice(0, 80), path: state.goalPaths[0] }, { severity: 'info' })
    }
    const goalPaths = state.goalPaths

    // Derive the primary path (first mentioned) and what's still unwritten.
    const primaryPath = goalPaths[0] ?? null
    const unwrittenPaths = goalPaths.filter(p => !writtenPaths.includes(p))
    const allWritten = goalPaths.length > 0 && unwrittenPaths.length === 0

    if (!primaryPath) {
      // No TS/JS file in goal — route through the offline intelligence stack:
      // research DAG → FM ReAct (tool-using) → FM direct answer.
      // Only escalates if Apple FM daemon is down entirely.
      //
      // THREAD THE HISTORY (2026-07-21): solveNonCodeTurn has full history plumbing —
      // back-reference detection, history-aware grounding/ReAct/direct — but this call
      // site dropped it, so a Mission Control follow-up like a bare "why?" reached the
      // research DAG as a context-free keyword and retrieved garbage (the live repro:
      // a Wikipedia disambiguation dump of songs titled "Why"). The prior turns are
      // sitting right here in `messages`; pair them up and pass them through.
      const priorTurns: ConvTurn[] = []
      let pendingUser: string | null = null
      for (const m of messages) {
        const role = (m as { role?: string }).role
        const content = String((m as { content?: unknown }).content ?? '')
        if (role === 'user') pendingUser = content
        else if (role === 'assistant' && pendingUser !== null && content.trim()) {
          priorTurns.push({ user: pendingUser, assistant: content })
          pendingUser = null
        }
      }
      debugBus.emit('agent', 'offline_noncode_attempt', { goal: goal.slice(0, 80), priorTurns: priorTurns.length }, { severity: 'info' })
      const answer = await solveNonCodeTurn(goal, projectPath, priorTurns.slice(-6))
      return { text: answer, toolCalls: [] }
    }

    // ── S0: Read existing file before editing (edit intent only, primary file only) ──
    const calledTools = messages
      .filter(m => m.role === 'assistant')
      .flatMap(m => ((m as any).tool_calls ?? []) as Array<{ function: { name: string } }>)
      .map(tc => tc.function?.name)

    const hasReadFile = calledTools.includes('read_file')
    // Injected default targets (game.html for pathless game goals) are greenfield by
    // definition — the vibe-code template's boilerplate "fix anything that breaks"
    // otherwise trips isEditIntent and burns an iteration reading a file that can't exist.
    const isInjectedTarget = !goal.includes(primaryPath)
    if (isEditIntent(goal) && !isInjectedTarget && !hasReadFile && !writtenPaths.includes(primaryPath)) {
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
        content = nextPath.endsWith('.html')
          ? await solveHtmlWrite(nextPath, state)
          : await solveCodeWrite(nextPath, state, projectPath)
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
    const hasTsTargets = goalPaths.some(p => /\.(ts|tsx|js|mjs)$/.test(p))
    // HTML-only goals are verified at write time (validateHtmlGame) — tsc has nothing to check.
    const needsTsc = allWritten && hasTsTargets && tscRuns < 1 + Math.max(0, state.writeCycles - goalPaths.length)
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
    const htmlDone = writtenPaths.filter(p => p.endsWith('.html'))
    if (htmlDone.length && !hasTsTargets) {
      return {
        text: `Wrote ${writtenPaths.join(', ')} — self-contained single-file HTML, inline scripts syntax-verified. Open it with the Preview button to play.`,
        toolCalls: [],
      }
    }
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
  onEscalate?: (reason: string) => void,
): DriveTurn {
  return async (messages, tools, signal, turnClass) => {
    // Critic turns (final grounding/harden correctness audit) go straight to the strong
    // online free pool — the on-device FM is at chance on distinguishing subtle-but-real
    // bugs from correct code (measured 2/4 vs gpt-oss-120b's 4/4). This is the one
    // rare, high-value judgment where escalating to a stronger $0 model is worth it.
    if (turnClass === 'critic') {
      onEscalate?.('critic turn — external pool judges correctness')
      return onlineTurn(messages, tools, signal, turnClass)
    }
    try {
      const result = await offlineTurn(messages, tools, signal, turnClass)
      debugBus.emit('agent', 'offline_turn_hit', {}, { severity: 'info' })
      return result
    } catch (e) {
      if (e instanceof OfflineEscalateError) {
        debugBus.emit('agent', 'offline_turn_escalate', {
          reason: String((e as any)?.message ?? e).slice(0, 120),
        }, { severity: 'info' })
        // Provenance-honest UI: the run just left the device — let the caller flip the
        // badge/pill so "ON-DEVICE" is never shown for a pool-driven turn.
        onEscalate?.(String((e as any)?.message ?? e).slice(0, 120))
        return onlineTurn(messages, tools, signal, turnClass)
      }
      throw e
    }
  }
}

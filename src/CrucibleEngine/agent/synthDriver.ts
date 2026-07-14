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
import vm from 'vm'
import { synthesizeUniversal } from '../synth/universal'
import { enqueueFm } from './fmQueue'
import { buildEditSpec, parseSectionPatches, applyPatch, isSectionPatchOutput } from '../synth/editExtract'
import { ensureIndex } from '../state/codebaseIndex'
import { debugBus } from '../debug/bus'
import type { DriveTurn, DriveTurnResult } from './loop'
import { retrieveForTask } from '../retrieval/retrievalLayer'
import { runResearchDag } from '../research/researchDag'
import { fmReact, fmDirectAnswer, checkFmAvailable, fmComplete, type ConvTurn } from './fmReact'
import { matchMeta } from '../answer/conversational'
import { answerWithWebGrounding } from '../answer/groundedAnswer'
import { runtimeVerifyHtml } from './htmlRuntimeVerify'
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
  if (!contextDependent && !isCodeShaped) {
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

export function isWebArtifactGoal(goal: string): boolean {
  const m = goal.toLowerCase()
  const creation = /\b(build|create|make|write|code|program|implement|generate)\b/.test(m)
  const artifact = /\b(game|arcade|snake|tetris|pong|breakout|asteroids|platformer|flappy|minesweeper|sudoku|maze|clicker|interactive (?:app|demo|toy|visuali[sz]ation)|animation|simulation|simulator)\b/.test(m)
  const playable = /\b(playable|interactive)\b/.test(m)
  return creation && (artifact || playable)
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
 *  syntactically broken code from shipping as "done". */
function validateHtmlGame(html: string): string | null {
  if (!/<!doctype html|<html[\s>]/i.test(html)) return 'output is not a complete HTML document'
  if (!/<\/html>/i.test(html)) return 'HTML document is truncated (missing </html>)'
  if (!/<script[\s>]/i.test(html)) return 'no inline <script> found'
  if (!/<canvas[\s>]/i.test(html) && !/addEventListener/i.test(html)) return 'no canvas element or event handling — not interactive'
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

// Deterministic sanitizer for the FM's most common runtime bug: game state declared
// with const then reassigned every frame. Rewriting declaration-position const to let
// is semantics-preserving for generated game code and removes the whole failure class.
function sanitizeGameJs(js: string): string {
  return js.replace(/\bconst\b/g, 'let')
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

// ── Verified game templates — ZERO model inference ("Crucible IS the model") ──
// The on-device FM writes passable novel game logic but botches classics (snake with
// instant game-over, draw-only-on-keypress). For the games users actually ask for by
// name — including the splash-screen demo — ship a deterministic, reviewed
// implementation instead. Still run through the same runtime gate before writing.
const GAME_TEMPLATES: Array<{ match: RegExp; title: string; js: string }> = [{
  match: /\bsnake\b/i,
  title: 'Snake',
  js: `
let CELL = 20, GRID = 24, W = CELL * GRID;
let cv = document.getElementById('game'); cv.width = W; cv.height = W;
let ctx = cv.getContext('2d');
let snake, dir, nextDir, food, score, dead, tickMs, last = 0;

function reset() {
  snake = [{ x: 12, y: 12 }, { x: 11, y: 12 }, { x: 10, y: 12 }];
  dir = { x: 1, y: 0 }; nextDir = dir;
  score = 0; dead = false; tickMs = 140;
  placeFood();
  document.getElementById('hud').textContent = 'Score: 0';
}
function placeFood() {
  do {
    food = { x: Math.floor(Math.random() * GRID), y: Math.floor(Math.random() * GRID) };
  } while (snake.some(s => s.x === food.x && s.y === food.y));
}
window.addEventListener('keydown', e => {
  let k = e.key.toLowerCase();
  let d = k === 'arrowup' || k === 'w' ? { x: 0, y: -1 }
        : k === 'arrowdown' || k === 's' ? { x: 0, y: 1 }
        : k === 'arrowleft' || k === 'a' ? { x: -1, y: 0 }
        : k === 'arrowright' || k === 'd' ? { x: 1, y: 0 } : null;
  if (dead) { reset(); return; }
  if (d && !(d.x === -dir.x && d.y === -dir.y)) nextDir = d;
});
function step() {
  dir = nextDir;
  let head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
  if (head.x < 0 || head.y < 0 || head.x >= GRID || head.y >= GRID ||
      snake.some(s => s.x === head.x && s.y === head.y)) { dead = true; return; }
  snake.unshift(head);
  if (head.x === food.x && head.y === food.y) {
    score++; tickMs = Math.max(70, tickMs - 3); placeFood();
    document.getElementById('hud').textContent = 'Score: ' + score;
  } else snake.pop();
}
function draw() {
  ctx.fillStyle = '#16161e'; ctx.fillRect(0, 0, W, W);
  ctx.fillStyle = '#e05555';
  ctx.fillRect(food.x * CELL + 2, food.y * CELL + 2, CELL - 4, CELL - 4);
  snake.forEach((s, i) => {
    ctx.fillStyle = i === 0 ? '#7cf8a8' : '#4db89e';
    ctx.fillRect(s.x * CELL + 1, s.y * CELL + 1, CELL - 2, CELL - 2);
  });
  if (dead) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, W);
    ctx.fillStyle = '#fff'; ctx.font = '26px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Game over — score ' + score, W / 2, W / 2 - 10);
    ctx.font = '15px sans-serif';
    ctx.fillText('Press any key to restart', W / 2, W / 2 + 20);
  }
}
function loop(t) {
  if (!dead && t - last >= tickMs) { last = t; step(); }
  draw();
  requestAnimationFrame(loop);
}
reset();
requestAnimationFrame(loop);
`,
}, {
  match: /\bpong\b/i,
  title: 'Pong',
  js: `
let W = 480, H = 480, PW = 10, PH = 80, BS = 10;
let cv = document.getElementById('game'); cv.width = W; cv.height = H;
let ctx = cv.getContext('2d');
let hud = document.getElementById('hud');
let player, ai, ball, scoreP, scoreA, dead, up = false, down = false;

function resetBall(towardPlayer) {
  ball = { x: W / 2, y: H / 2, vx: (towardPlayer ? -1 : 1) * 4, vy: (Math.random() * 4 - 2) || 1.2 };
}
function reset() {
  player = { y: H / 2 - PH / 2 }; ai = { y: H / 2 - PH / 2 };
  scoreP = 0; scoreA = 0; dead = false;
  resetBall(Math.random() < 0.5);
  hud.textContent = 'You 0 — 0 CPU';
}
window.addEventListener('keydown', e => {
  let k = e.key.toLowerCase();
  if (dead) { reset(); return; }
  if (k === 'arrowup' || k === 'w') up = true;
  if (k === 'arrowdown' || k === 's') down = true;
  // Left/right also steer, so the shell's four touch buttons all do something.
  if (k === 'arrowleft' || k === 'a') { up = true; down = false; }
  if (k === 'arrowright' || k === 'd') { down = true; up = false; }
});
window.addEventListener('keyup', e => {
  let k = e.key.toLowerCase();
  if (k === 'arrowup' || k === 'w' || k === 'arrowleft' || k === 'a') up = false;
  if (k === 'arrowdown' || k === 's' || k === 'arrowright' || k === 'd') down = false;
});
function step() {
  if (up) player.y -= 6;
  if (down) player.y += 6;
  player.y = Math.max(0, Math.min(H - PH, player.y));
  let target = ball.y - PH / 2;
  ai.y += Math.max(-4.2, Math.min(4.2, target - ai.y));
  ai.y = Math.max(0, Math.min(H - PH, ai.y));
  ball.x += ball.vx; ball.y += ball.vy;
  if (ball.y <= 0 || ball.y >= H - BS) ball.vy = -ball.vy;
  if (ball.vx < 0 && ball.x <= PW + 6 && ball.x >= 6 && ball.y + BS >= player.y && ball.y <= player.y + PH) {
    ball.vx = -ball.vx * 1.04;
    ball.vy += ((ball.y + BS / 2) - (player.y + PH / 2)) * 0.12;
    ball.x = PW + 6;
  }
  if (ball.vx > 0 && ball.x + BS >= W - PW - 6 && ball.x + BS <= W - 6 && ball.y + BS >= ai.y && ball.y <= ai.y + PH) {
    ball.vx = -ball.vx * 1.04;
    ball.vy += ((ball.y + BS / 2) - (ai.y + PH / 2)) * 0.12;
    ball.x = W - PW - 6 - BS;
  }
  ball.vy = Math.max(-8, Math.min(8, ball.vy));
  if (ball.x < -BS) { scoreA++; resetBall(true); }
  if (ball.x > W) { scoreP++; resetBall(false); }
  hud.textContent = 'You ' + scoreP + ' — ' + scoreA + ' CPU';
  if (scoreP >= 7 || scoreA >= 7) dead = true;
}
function draw() {
  ctx.fillStyle = '#16161e'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.setLineDash([6, 8]);
  ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#7cf8a8'; ctx.fillRect(6, player.y, PW, PH);
  ctx.fillStyle = '#e05555'; ctx.fillRect(W - PW - 6, ai.y, PW, PH);
  ctx.fillStyle = '#e4e4ee'; ctx.fillRect(ball.x, ball.y, BS, BS);
  if (dead) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff'; ctx.font = '26px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(scoreP > scoreA ? 'You win ' + scoreP + '–' + scoreA : 'CPU wins ' + scoreA + '–' + scoreP, W / 2, H / 2 - 10);
    ctx.font = '15px sans-serif';
    ctx.fillText('Press any key to restart', W / 2, H / 2 + 20);
  }
}
function loop() {
  if (!dead) step();
  draw();
  requestAnimationFrame(loop);
}
reset();
requestAnimationFrame(loop);
`,
}, {
  match: /\b(breakout|brick[\s-]?breaker|arkanoid)\b/i,
  title: 'Breakout',
  js: `
let W = 480, H = 480, PW = 84, PH = 12, BS = 9;
let COLS = 10, ROWS = 6, BW = 44, BH = 16, TOP = 50;
let cv = document.getElementById('game'); cv.width = W; cv.height = H;
let ctx = cv.getContext('2d');
let hud = document.getElementById('hud');
let px, ball, bricks, score, lives, dead, won, left = false, right = false;
let COLORS = ['#e05555', '#e0a955', '#e0d855', '#7cf8a8', '#55b9e0', '#9b7ce0'];

function resetBall() {
  ball = { x: W / 2 - BS / 2, y: H - 90, vx: 3 * (Math.random() < 0.5 ? 1 : -1), vy: -4.4 };
}
function reset() {
  px = W / 2 - PW / 2; score = 0; lives = 3; dead = false; won = false;
  bricks = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    bricks.push({ x: 6 + c * (BW + 3), y: TOP + r * (BH + 3), alive: true, color: COLORS[r % COLORS.length] });
  }
  resetBall();
  updateHud();
}
function updateHud() { hud.textContent = 'Score: ' + score + '   Lives: ' + lives; }
window.addEventListener('keydown', e => {
  let k = e.key.toLowerCase();
  if (dead || won) { reset(); return; }
  if (k === 'arrowleft' || k === 'a' || k === 'arrowup' || k === 'w') left = true;
  if (k === 'arrowright' || k === 'd' || k === 'arrowdown' || k === 's') right = true;
});
window.addEventListener('keyup', e => {
  let k = e.key.toLowerCase();
  if (k === 'arrowleft' || k === 'a' || k === 'arrowup' || k === 'w') left = false;
  if (k === 'arrowright' || k === 'd' || k === 'arrowdown' || k === 's') right = false;
});
function step() {
  if (left) px -= 7;
  if (right) px += 7;
  px = Math.max(0, Math.min(W - PW, px));
  ball.x += ball.vx; ball.y += ball.vy;
  if (ball.x <= 0 || ball.x >= W - BS) ball.vx = -ball.vx;
  if (ball.y <= 0) ball.vy = -ball.vy;
  if (ball.vy > 0 && ball.y + BS >= H - 24 && ball.y + BS <= H - 24 + PH && ball.x + BS >= px && ball.x <= px + PW) {
    ball.vy = -Math.abs(ball.vy);
    ball.vx += ((ball.x + BS / 2) - (px + PW / 2)) * 0.08;
    ball.vx = Math.max(-6, Math.min(6, ball.vx));
  }
  for (let b of bricks) {
    if (!b.alive) continue;
    if (ball.x + BS >= b.x && ball.x <= b.x + BW && ball.y + BS >= b.y && ball.y <= b.y + BH) {
      b.alive = false; score += 10; updateHud();
      let fromSide = ball.x + BS - ball.vx <= b.x || ball.x - ball.vx >= b.x + BW;
      if (fromSide) ball.vx = -ball.vx; else ball.vy = -ball.vy;
      break;
    }
  }
  if (bricks.every(b => !b.alive)) { won = true; return; }
  if (ball.y > H) {
    lives--; updateHud();
    if (lives <= 0) { dead = true; return; }
    resetBall();
  }
}
function draw() {
  ctx.fillStyle = '#16161e'; ctx.fillRect(0, 0, W, H);
  for (let b of bricks) {
    if (!b.alive) continue;
    ctx.fillStyle = b.color; ctx.fillRect(b.x, b.y, BW, BH);
  }
  ctx.fillStyle = '#7cf8a8'; ctx.fillRect(px, H - 24, PW, PH);
  ctx.fillStyle = '#e4e4ee'; ctx.fillRect(ball.x, ball.y, BS, BS);
  if (dead || won) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff'; ctx.font = '26px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(won ? 'You cleared it — score ' + score : 'Game over — score ' + score, W / 2, H / 2 - 10);
    ctx.font = '15px sans-serif';
    ctx.fillText('Press any key to restart', W / 2, H / 2 + 20);
  }
}
function loop() {
  if (!dead && !won) step();
  draw();
  requestAnimationFrame(loop);
}
reset();
requestAnimationFrame(loop);
`,
}]

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
const WEB_GAME_MARK = 'REFERENCE IMPLEMENTATION (fetched from the web — adapt its mechanics to the prepared page; do NOT copy its HTML/canvas setup, and your code is still run and verified):'

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
    const snippet = bundle.codeBlocks[0]?.code?.trim()
    // Require a substantive block — a one-liner is noise, not a reference to adapt.
    if (!snippet || snippet.length < 120) return null
    return `${WEB_GAME_MARK}\n${snippet.slice(0, 2000)}`
  } catch {
    return null
  }
}

async function solveHtmlWrite(targetPath: string, state: CurrentState): Promise<string> {
  // Template hit → deterministic, verified game. Still runtime-gated below like FM output.
  const tpl = GAME_TEMPLATES.find(t => t.match.test(state.goal))
  if (tpl) {
    const html = buildGameShell(tpl.js, `${tpl.title} — Crucible`)
    const problem = validateHtmlGame(html) ?? await runtimeVerifyHtml(html)
    if (!problem) {
      debugBus.emit('agent', 'offline_html_synth', { path: targetPath, attempt: 0, template: tpl.title, bytes: html.length }, { severity: 'info' })
      return html
    }
    debugBus.emit('agent', 'offline_html_retry', { path: targetPath, attempt: 0, problem: `template ${tpl.title}: ${problem}` }, { severity: 'warn' })
    // fall through to FM generation
  }
  const fmUp = await checkFmAvailable()
  if (!fmUp) throw new OfflineEscalateError('Apple FM daemon unavailable (port 11435) — html write escalating')
  const title = (state.goal.match(/\b(\w[\w\s-]{2,30}?)\s+game\b/i)?.[1] ?? 'Crucible').trim() + ' — Crucible'
  const MAX_ATTEMPTS = 6
  // Feedback is now DIAGNOSTIC (the runtime gate names the exact fault: frozen loop, blank
  // canvas, dead input), so repairing the model's OWN previous code beats asking it to
  // rewrite from scratch — a small model regresses less when editing than when regenerating.
  let prevJs = ''
  let feedback = ''
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
    const grounding = (attempt === 1 && webReference) ? `\n\n${webReference}` : ''
    const userMsg = `Build this game: ${state.goal}${grounding}${feedback}\n\nOutput the JavaScript game logic now.`
    let raw = ''
    const proposer = 'apple-fm'
    raw = await fmComplete([
      { role: 'system', content: HTML_GAME_SYSTEM },
      { role: 'user', content: userMsg },
    ])
    debugBus.emit('agent', 'offline_html_proposer', { path: targetPath, attempt, model: proposer }, { severity: 'info' })
    const fence = raw.match(/```(?:javascript|js)?\s*([\s\S]*?)```/i)
    const js = sanitizeGameJs((fence ? fence[1] : raw).trim())
    const html = js ? buildGameShell(js, title) : ''
    // Two gates: static (syntax/self-containment), then RUNTIME — load in the bundled
    // Electron offscreen, drive keys, and require a canvas that draws at load, stays
    // ALIVE (self-animates or responds to input), and throws no errors. The static gate
    // alone shipped parse-clean games that were dead on frame 1.
    const problem = html
      ? (validateHtmlGame(html) ?? await runtimeVerifyHtml(html))
      : 'empty completion'
    if (!problem) {
      debugBus.emit('agent', 'offline_html_synth', { path: targetPath, attempt, model: proposer, bytes: html.length }, { severity: 'info' })
      return html
    }
    debugBus.emit('agent', 'offline_html_retry', { path: targetPath, attempt, model: proposer, problem }, { severity: 'info' })
    prevJs = js
    if (!seenProblems.includes(problem)) seenProblems.push(problem)
    const priorFaults = seenProblems.length > 1
      ? `\n\nEVERY fault below has already caused a rejection in this session — do NOT reintroduce any of them while fixing the current one:\n` +
        seenProblems.map(p => `  • ${p}`).join('\n')
      : ''
    feedback = `\n\nYour previous attempt was RUN in a real browser and rejected: ${problem}${priorFaults}\n\n` +
      `Here is your previous code — FIX the specific problem above, keep what works, and output the FULL corrected JavaScript (nothing else):\n\n${prevJs.slice(0, 1800)}`
  }
  throw new OfflineEscalateError(
    `FM could not produce a working game after ${MAX_ATTEMPTS} run-verified attempts`)
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
      state.goalPaths = [DEFAULT_GAME_PATH]
      debugBus.emit('agent', 'offline_game_goal', { goal: goal.slice(0, 80) }, { severity: 'info' })
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

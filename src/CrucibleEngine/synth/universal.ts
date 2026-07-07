// ============================================================================
// synthesizeUniversal — the full cascade that lets Crucible reason about code it has NO
// primitive for, while never shipping anything unverified.
//
//   L0  exact primitive match            (pure code, instant)        — synthesize()
//   L1  enumerative program search       (pure code, no model)       — synthesizeEnumerative()
//   L3  on-device FM proposer            (offline :11435, last resort, oracle-gated)
//   → DISTILL every verified win into a new pure-code primitive (RSI) so the SECOND time
//     the same task is solved with ZERO model — coverage compounds, the floor never lowers.
//
// L0 and L1 are the pure-code cascade (see pureCode.ts) — fully model-free. L1 is bottom-up
// PBE synthesis that genuinely REASONS about a novel task from its worked examples, with no
// prior knowledge of the problem. Only when both miss do we reach for the on-device FM.
//
// The invariant: a PROPOSER emits candidates; the execution ORACLE (oracle.ts: tsc + the
// spec-derived test from derive.ts) is the sole authority. A wrong proposal from any source
// — including the model — is rejected, never shipped. If nothing passes, return a null-ish
// result so the caller escalates HONESTLY rather than emitting plausible-wrong code.
//
// Honest boundary: universality is bounded by what the spec PINS DOWN. No derivable tests
// (no examples/properties) ⇒ we cannot verify novel code ⇒ we do not bless it (return
// unverified:true only for a pre-verified primitive, else escalate). Truly arbitrary novel
// logic with no checkable spec is undecidable — there the engine escalates, by design.
// ============================================================================
import fs from 'fs'
import path from 'path'
import { extractFeatures, type SynthFile } from './index'
import { deriveTests, derivePropertyTests } from './derive'
import { deriveInvariantTests, deriveOptsTransformSmokeTest } from './deriveInvariant'
import { distillHint } from './errorHints'
import { proposeRepairs } from './repairProposers'
import { verifyCandidateAsync } from './oracle'
import { synthesizePureCode, distillToSkill } from './pureCode'
import { buildRepoContext, withRetrieval, type OracleContextFile } from './repoContext'
import { ensureIndex } from '../state/codebaseIndex'

const LOCAL_FM_URL = process.env.LOCAL_INFERENCE_URL ?? 'http://127.0.0.1:11435'

export type LocalSynth = (system: string, user: string) => Promise<string>

export interface UniversalResult {
  files: SynthFile[]
  source: 'primitive' | 'enumerative' | 'fm-distilled' | null
  verified: boolean        // oracle-accepted against spec-derived tests
  testsDerived: number     // how many behavioral assertions the spec pinned down
  fmCalls: number          // model calls used (0 = fully pure-code)
  detail: string
}

/** Strip markdown fences / leading prose; return the code body. */
function stripFences(raw: string): string {
  let t = raw.trim()
  const fence = t.match(/```(?:[a-zA-Z]+)?\n([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  return t.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim()
}

/**
 * Per-round FM debug ledger (.crucible/fm-rounds.jsonl). Diagnosis instrument for the
 * "why doesn't the FM self-correct across rounds?" class of question — records what each
 * round was actually asked, what it produced, and why the oracle rejected it. Append-only,
 * best-effort, content truncated; never allowed to break synthesis.
 */
function logFmRound(entry: Record<string, unknown>) {
  try {
    const dir = path.join(process.cwd(), '.crucible')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'fm-rounds.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch { /* debug-only */ }
}

/**
 * Out-of-depth tripwire (Frontier-SWE-gap Workstream 3, first concrete signal).
 * Normalizes an oracle rejection into a structural fingerprint so the round loop can
 * detect "the FM is producing the SAME wrong shape again" — sortModule's signature
 * failure mode (2026-07-04: unconditional in-stock grouping recurring across fresh
 * rounds while the retry prompt clearly said not to). Two consecutive identical
 * fingerprints ⇒ the model is not converging; abstain honestly instead of grinding
 * the remaining rounds. Numbers/paths are masked so line-number drift between rounds
 * doesn't defeat the comparison.
 */
function failureFingerprint(detail: string): string {
  return detail
    .toLowerCase()
    .replace(/\/[^\s|]+/g, '<path>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

// Item-9 fix (2026-07-07): mirror fmReact's strict-mode ceiling. In CRUCIBLE_OFFLINE=strict the
// code-gen FM proposer has no external fallback, so a slow round must be allowed to grind rather
// than aborting the whole synth empty-handed; hybrid keeps the short ceiling for fast escalation.
// cont.47: !== '0' (not === 'strict') — the server forces strict per-request for all
// non-quorum chats regardless of env, so the short hybrid ceiling was killing strict
// code-gen rounds that had no fallback. Mirrors fmReact.ts.
const LOCAL_SYNTH_STRICT = (process.env.CRUCIBLE_OFFLINE ?? '1') !== '0'
const LOCAL_SYNTH_TIMEOUT_MS = Number(
  process.env.CRUCIBLE_FM_TIMEOUT_MS ?? (LOCAL_SYNTH_STRICT ? 600_000 : 40_000),
)

/** Default proposer: the on-device Apple FM (offline). Injectable for tests / other backends. */
async function defaultLocalSynth(system: string, user: string): Promise<string> {
  const res = await fetch(`${LOCAL_FM_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 1200, temperature: 0.2,
    }),
    signal: AbortSignal.timeout(LOCAL_SYNTH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`local FM ${res.status}`)
  const data: any = await res.json()
  return String(data.choices?.[0]?.message?.content ?? '')
}

export async function synthesizeUniversal(
  spec: string,
  opts: {
    localSynth?: LocalSynth
    maxFmRounds?: number
    minConfidence?: number
    distill?: boolean
    projectPath?: string
    /**
     * When true and no behavioral test can be derived, accept a candidate that passes
     * tsc (gate A) even without a behavioral gate. Only use this when a downstream
     * verification layer (e.g. the agent loop's own run_command verify step) acts as
     * the behavioral backstop. Never distills — compilation-only wins are not promoted
     * to primitives. Tagged `source: 'fm-compile-gated'` so callers can distinguish.
     */
    acceptGateAOnly?: boolean
    /** Override the module path extracted from the spec. Use when the spec text contains
     *  other .ts file references that confuse the extractor (e.g. "existing file: src/types.ts"). */
    modulePath?: string
    /** Pre-processed internet-retrieval block (Tier 1.3) to inject into the FM spec.
     *  Caller fetches via retrieval/retrievalLayer.retrieveForTask when the router routes
     *  the task to `retrieve`; passed here it is woven into the FM prompt prefix only. */
    retrievalBlock?: string
  } = {},
): Promise<UniversalResult> {
  const feats = extractFeatures(spec)
  const modulePath = opts.modulePath ?? feats.modulePath ?? 'src/module.ts'
  const derived = deriveTests(spec, modulePath)
  const testsDerived = derived?.count ?? 0

  // ── Build repo context (cheap — one cached readFileSync) when projectPath is set. ────────
  // contextFiles are used by the oracle to place project source files at their correct
  // relative locations in scratch (e.g. src/types.ts → scratch/src/types.ts) so that
  // generated imports like `'./types'` resolve correctly during tsc.
  //
  // specPrefix is prepended to the FM prompt only (not to L0/L1/deriveTests) so the FM
  // sees local type definitions, field names, and related code when generating.
  let contextFiles: OracleContextFile[] = []
  let fmSpecPrefix = ''
  if (opts.projectPath) {
    try {
      const idx = ensureIndex(opts.projectPath)
      const ctx = buildRepoContext(opts.projectPath, spec, modulePath)
      contextFiles = ctx.oracleFiles
      fmSpecPrefix = ctx.specPrefix  // enriches FM prompt; not used for L0/L1
      // If the index is empty, fall back to all non-target entries from the index.
      if (!contextFiles.length && idx.entries.length) {
        const { default: path } = await import('path')
        contextFiles = idx.entries
          .filter(e => e.rel !== modulePath)
          .map(e => ({ src: path.join(path.resolve(opts.projectPath!), e.rel), rel: e.rel }))
      }
    } catch { /* repo context is best-effort */ }
  }

  // ── Tier 1.3: fold pre-fetched, pre-processed retrieval grounding into the FM prefix. ──
  // Applies whether or not a project context exists (pure external-API tasks have no
  // projectPath but still need grounding). Block is already ranked + budget-fit upstream.
  if (opts.retrievalBlock) {
    fmSpecPrefix = withRetrieval(
      { specPrefix: fmSpecPrefix, oracleFiles: contextFiles, targetContent: null },
      opts.retrievalBlock,
    ).specPrefix
  }

  // ── L0 + L1: the pure-code cascade (zero model). Ships oracle-verified code or escalates. ──
  const pc = await synthesizePureCode(spec, { minConfidence: opts.minConfidence, distill: opts.distill, verify: 'sync', projectPath: opts.projectPath })
  if (pc.verified && pc.files.length && pc.source) {
    return { files: pc.files, source: pc.source, verified: true, testsDerived: pc.testsDerived, fmCalls: 0, detail: pc.detail }
  }

  const localSynth = opts.localSynth ?? defaultLocalSynth
  const rounds = opts.maxFmRounds ?? 3
  // FM sees the repo-enriched spec (local types, field names, related files) but L0/L1
  // and deriveTests see only the raw spec — keeps the pure-code path unaffected.
  const sigBlock = fmSpecPrefix ? fmSpecPrefix + spec : spec
  let priorError = ''
  let priorFingerprint = ''
  // Consecutive-identical-fingerprint streak. Fires at 3, not 2: replaying the
  // 2026-07-04 fm-rounds.jsonl ledger (18 attempts), a 2-round threshold would have
  // killed 2 of the 8 eventual wins (both recovered on round 3 after two identical
  // failures) to save at most one round each in the 7 genuine non-converging runs.
  let fpStreak = 1
  const TRIPWIRE_STREAK = 3
  let fmCalls = 0

  const oracleOpts = contextFiles.length ? { contextFiles, spec } : { spec }

  // ── Property tests: weaker but still oracle-gated fallback when no behavioral examples. ──
  // derivePropertyTests recognises structural families (codec, filter-opts, sort, validator…)
  // and generates inline assertions from the function signature. These are better than compile-
  // gate-only: they catch logic bugs like `opts.active && !user.active` for active=false.
  const propertyDerived = derived ? null : derivePropertyTests(spec, modulePath)
  // ── Context-invariant tests: repo-getter-fed runtime checks for grouped-aggregation specs
  // property/behavioral derivation can't reach (e.g. "balance = credits - debits" summarized
  // by account). Needs contextFiles, so only tried when a project context is present.
  const invariantDerived = (derived || propertyDerived || !contextFiles.length)
    ? null
    : deriveInvariantTests(spec, modulePath, contextFiles)
  // ── Opts-transform smoke test: repo-getter-fed "does it even run" check for fn(items, opts)
  // shapes the arity-gated 'sort' family had to stop covering (see derive.ts). Weaker than a
  // behavioral test (no correctness assertion) but still catches compile-clean-but-throws bugs
  // that a gate-A-only path can't.
  const smokeDerived = (derived || propertyDerived || invariantDerived || !contextFiles.length)
    ? null
    : deriveOptsTransformSmokeTest(spec, modulePath, contextFiles)
  const effectiveDerived = derived ?? propertyDerived ?? invariantDerived ?? smokeDerived

  // ── L3: reason a candidate with the on-device FM, GATED by the oracle. ─────────────────
  if (effectiveDerived) {
    const kindLabel = derived
      ? 'behavioral'
      : invariantDerived
        ? `context-invariant (${invariantDerived.family})`
        : smokeDerived
          ? `context-invariant (${smokeDerived.family})`
          : `property (${(effectiveDerived as any).family ?? 'unknown'})`
    // Full behavioral oracle: tsc + spec-derived test.
    for (let r = 0; r < rounds; r++) {
      const system = 'You are a precise TypeScript engineer. Output ONLY the complete contents of the requested .ts file — no prose, no markdown fences, no explanations. It must compile under strict-off TypeScript and export EXACTLY the requested symbols.'
      const user = priorError
        ? `Your previous attempt was REJECTED by the test oracle with:\n${priorError}\n\nFix it. Re-output the COMPLETE corrected file for ${modulePath}.\n\nSPEC:\n${sigBlock}`
        : `Write the complete file ${modulePath} implementing this spec exactly:\n\n${sigBlock}`
      let candidate = ''
      try { candidate = stripFences(await localSynth(system, user)); fmCalls++ } catch (e: any) {
        return { files: [], source: null, verified: false, testsDerived, fmCalls, detail: `FM proposer unavailable: ${String(e?.message ?? e).slice(0, 120)} — escalating` }
      }
      if (!candidate) { priorError = 'empty output'; continue }
      const files: SynthFile[] = [{ path: modulePath, content: candidate }]
      const v = await verifyCandidateAsync(files, effectiveDerived.testFile, oracleOpts)
      logFmRound({
        modulePath, gate: kindLabel, round: r + 1, of: rounds,
        priorError: priorError.slice(0, 400) || null,
        candidate: candidate.slice(0, 1200),
        accepted: v.accepted, verdict: v.detail.slice(0, 400),
      })
      if (v.accepted) {
        // Only distill exact behavioral tests — property tests are not strong enough to be
        // promoted to primitives (they might accept incorrect implementations on other inputs).
        if (opts.distill !== false && derived) distillToSkill(spec, modulePath, candidate)
        return { files, source: 'fm-distilled', verified: true, testsDerived: effectiveDerived.count, fmCalls, detail: `FM proposed → oracle-verified (${effectiveDerived.count} ${kindLabel} tests)` }
      }
      // ── Deterministic repair proposers: pure-code mutations of the rejected candidate,
      // keyed off the closed-world failure shapes our own derivers emit, re-gated by the SAME
      // oracle. A wrong transform is rejected like any wrong candidate — WRONG=0 untouched.
      for (const repaired of proposeRepairs(candidate, v.detail, spec)) {
        const rv = await verifyCandidateAsync([{ path: modulePath, content: repaired }], effectiveDerived.testFile, oracleOpts)
        logFmRound({
          modulePath, gate: kindLabel, round: r + 1, of: rounds, repair: true,
          accepted: rv.accepted, verdict: rv.detail.slice(0, 400),
        })
        if (rv.accepted) {
          if (opts.distill !== false && derived) distillToSkill(spec, modulePath, repaired)
          return {
            files: [{ path: modulePath, content: repaired }], source: 'fm-distilled', verified: true,
            testsDerived: effectiveDerived.count, fmCalls,
            detail: `FM proposed → deterministic repair → oracle-verified (${effectiveDerived.count} ${kindLabel} tests)`,
          }
        }
      }
      // ── Out-of-depth tripwire: same rejection shape TRIPWIRE_STREAK rounds running ⇒ not converging.
      const fp = failureFingerprint(v.detail)
      fpStreak = fp && fp === priorFingerprint ? fpStreak + 1 : 1
      if (fpStreak >= TRIPWIRE_STREAK) {
        logFmRound({ modulePath, gate: kindLabel, round: r + 1, of: rounds, tripwire: true, fingerprint: fp.slice(0, 300) })
        return {
          files: [], source: null, verified: false, testsDerived: effectiveDerived.count, fmCalls,
          detail: `out-of-depth tripwire: oracle rejected ${fpStreak} consecutive candidates with an identical failure shape (${v.detail.slice(0, 160)}) — FM is not converging on this structure; abstaining early instead of grinding ${rounds - r - 1} more round(s)`,
        }
      }
      priorFingerprint = fp
      // ── Distill the failure into an imperative, code-shaped instruction where we can —
      // the small FM demonstrably does not translate a raw test transcript into a fix.
      const hint = distillHint(v.detail, spec)
      priorError = hint ? `${v.detail}\n\nACTION REQUIRED — apply this exact fix: ${hint}` : v.detail
    }
    return { files: [], source: null, verified: false, testsDerived: effectiveDerived.count, fmCalls, detail: `FM could not produce an oracle-passing candidate in ${rounds} rounds — escalating honestly` }
  }

  // ── No derivable tests (not even property tests) — honest escalation unless compile-gate. ─
  if (!opts.acceptGateAOnly) {
    return { files: [], source: null, verified: false, testsDerived: 0, fmCalls: 0, detail: 'no primitive, no enumerative program, no derivable tests, no recognized property family — escalating honestly' }
  }

  // ── L3 compile-gate (acceptGateAOnly=true): FM → tsc only, no behavioral test. ─────────
  // The caller is responsible for a downstream behavioral check (e.g. the agent loop's
  // own run_command verify step). We never distill compile-gated wins — only oracle-verified
  // code earns a place in the primitive library.
  // System prompt for the compile-gate FM path. Keep it short — the enriched spec (repoContext)
  // already injects type definitions and concrete data so the FM sees exact field names.
  const compileGateSystem =
    'You are a precise TypeScript engineer. Output ONLY the complete file contents — no fences, no prose. ' +
    'For optional filter fields, check each one independently with !== undefined so undefined means "no filter". ' +
    'When a query string filter must search multiple fields (e.g. name and email), check ALL of them.'
  for (let r = 0; r < rounds; r++) {
    const system = compileGateSystem
    const user = priorError
      ? `Your previous attempt failed tsc with:\n${priorError}\n\nFix it. Re-output the COMPLETE corrected file for ${modulePath}.\n\nSPEC:\n${sigBlock}`
      : `Write the complete file ${modulePath} implementing this spec exactly:\n\n${sigBlock}`
    let candidate = ''
    try { candidate = stripFences(await localSynth(system, user)); fmCalls++ } catch (e: any) {
      return { files: [], source: null, verified: false, testsDerived: 0, fmCalls, detail: `FM proposer unavailable: ${String(e?.message ?? e).slice(0, 120)} — escalating` }
    }
    if (!candidate) { priorError = 'empty output'; continue }
    // Note: we intentionally do NOT static-check for logic anti-patterns here. The small FM
    // cannot reliably fix detected issues in subsequent rounds, so rejection without a runnable
    // oracle produces worse outcomes than accepting the first tsc-clean candidate. Behavioral
    // correctness is the responsibility of the downstream agent loop verify step.
    const files: SynthFile[] = [{ path: modulePath, content: candidate }]
    // Gate A only (no testFile). Pass contextFiles so tsc finds project imports.
    const v = await verifyCandidateAsync(files, undefined, oracleOpts)
    logFmRound({
      modulePath, gate: 'compile-only', round: r + 1, of: rounds,
      priorError: priorError.slice(0, 400) || null,
      candidate: candidate.slice(0, 1200),
      accepted: v.gateA, verdict: v.detail.slice(0, 400),
    })
    if (v.gateA) {
      return { files, source: 'fm-compile-gated' as any, verified: true, testsDerived: 0, fmCalls, detail: `FM proposed → tsc-clean (no behavioral test derivable; downstream verify required)` }
    }
    // ── Out-of-depth tripwire (same signal as the behavioral loop): identical tsc failure
    // shape TRIPWIRE_STREAK consecutive rounds ⇒ not converging; abstain early.
    const fp = failureFingerprint(v.detail)
    fpStreak = fp && fp === priorFingerprint ? fpStreak + 1 : 1
    if (fpStreak >= TRIPWIRE_STREAK) {
      logFmRound({ modulePath, gate: 'compile-only', round: r + 1, of: rounds, tripwire: true, fingerprint: fp.slice(0, 300) })
      return {
        files: [], source: null, verified: false, testsDerived: 0, fmCalls,
        detail: `out-of-depth tripwire: identical tsc failure shape across ${fpStreak} consecutive rounds (${v.detail.slice(0, 160)}) — abstaining early instead of grinding ${rounds - r - 1} more round(s)`,
      }
    }
    priorFingerprint = fp
    priorError = v.detail
  }
  return { files: [], source: null, verified: false, testsDerived: 0, fmCalls, detail: `FM could not produce tsc-clean code in ${rounds} rounds — escalating honestly` }
}

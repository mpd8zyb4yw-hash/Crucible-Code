// ═══════════════════════════════════════════════════════════════════════════════
// VGR — multi-FILE synthesis (the mission gap: real SWE spans an import graph)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Single-file VGR certifies one module. Real work spans several files that import each
// other. This module closes that gap end-to-end, on the SAME doctrine:
//
//   NL ──► spec (user examples gold, else model-consensus cases)
//      ──► search( multiFileProposer , verifyMultiFileCode )   // model proposes a FILE SET
//      ──► the whole graph is BUNDLED + EXECUTED against the cases
//      ──► certified file set | HONEST ABSTAIN
//
// The proposer emits several files (each `// file: <path>` + a fenced block) that may
// import one another; the verifier (codeVerifier.verifyMultiFileCode) bundles the graph
// and runs the cases against it. Correctness is certified by execution across files,
// never by the model's say-so. Abstain still means abstain.
// ═══════════════════════════════════════════════════════════════════════════════

import { transform } from 'esbuild'
import { fmComplete } from '../agent/fmReact'
import { type CandidateFile, type CodeAcceptance, type CodeCase, verifyMultiFileByProperty, verifyMultiFileCode } from './codeVerifier'
import { mergeCertifiedSource } from './emitPlan'
import { propertyForFunction } from './propertyVerifier'
import { search, type SearchOpts } from './search'
import { type Completer, detectDeclaredFunctions, extractCodeSpec, extractMultiFunctionSpec, harvestExplicitExamples } from './specExtractor'
import type { Candidate, ProposeContext, Proposer, SearchResult, TaskSpec, Verdict, Verifier } from './types'

// A path-like token (slash or code extension, no spaces) — same conservative shape emitPlan uses.
const FILE_RX = /\b((?:\.\.?\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs))\b/g

/** Every distinct code-file path named in the request, in first-seen order, "./" stripped.
 * A BARE filename that matches the basename of a pathed mention is the SAME file — prose
 * like "add X to src/main.ts … main.ts imports greet" must not demand a phantom root-level
 * main.ts (which the coverage gate would then require and whose imports could never resolve). */
export function detectRequestedFiles(nl: string): string[] {
  const seen = new Set<string>()
  for (const m of nl.matchAll(FILE_RX)) seen.add(m[1].replace(/^\.\//, ''))
  const all = [...seen]
  return all.filter(f => f.includes('/') || !all.some(o => o !== f && o.endsWith('/' + f)))
}

// A self-test HARNESS clause — "write a self-test (src/index.ts, runnable with `npx tsx
// src/index.ts`) …". The path(s) it names are a runnable test harness, NOT a co-equal
// deliverable module: the real deliverable is the implementation file elsewhere in the prompt,
// and the harness is written by the single-file path's own self-test step. Certifying it as a
// second file in the multi-file import graph is pure waste (a 3×~90s ladder that never needed
// to run). We therefore DISCOUNT harness-only paths from the multi-file trigger.
const SELF_TEST_CLAUSE_RX =
  /\bself-?test\b[^.]*?(?:\(([^)]*)\)|runnable with[^`\n]*`([^`\n]*)`)/gi

/** Every code-file path that the request names ONLY inside a self-test-harness clause.
 * A path also mentioned outside such a clause (a real deliverable that happens to be exercised
 * by the harness too) is NOT returned — only harness-exclusive paths are. */
export function selfTestHarnessFiles(nl: string): string[] {
  const stripped = nl.replace(SELF_TEST_CLAUSE_RX, ' ')
  const outside = new Set(detectRequestedFiles(stripped))
  return detectRequestedFiles(nl).filter(f => !outside.has(f))
}

/** Requested files that are genuine deliverable modules — every named code file minus the
 * paths that appear only as a self-test harness. This, not the raw file count, is what decides
 * multi-file routing. */
export function deliverableRequestedFiles(nl: string): string[] {
  const harness = new Set(selfTestHarnessFiles(nl))
  return detectRequestedFiles(nl).filter(f => !harness.has(f))
}

/**
 * A request is multi-FILE when it names ≥2 distinct DELIVERABLE code files, OR names ≥1 file AND
 * explicitly asks for several modules / cross-file imports. Conservative on purpose: a
 * one-file "add X to foo.ts" edit or "write foo in foo.ts" impl is NOT multi-file — those
 * stay on the (cheaper, append-safe) single-file path. A second path that is only a self-test
 * harness ("write a self-test (src/index.ts, runnable with `npx tsx …`)") is discounted — it is
 * a runnable test, not a co-equal module, and must not trip the slow multi-file ladder.
 */
export function isMultiFileRequest(nl: string): boolean {
  const files = deliverableRequestedFiles(nl)
  if (files.length >= 2) return true
  const multiSignal = /\b(multiple files|across (?:multiple )?files|separate (?:file|module)s?|cross-file|each in (?:its|their) own file|split (?:it |them )?(?:into|across)|imports? from)\b/i.test(nl)
  return files.length >= 1 && multiSignal
}

/** Deterministic fingerprint of a file set (order-independent), for anti-thrash dedup. */
function fingerprintFiles(files: CandidateFile[]): string {
  const norm = [...files]
    .map(f => `${f.path.replace(/^\.\//, '')}::${f.source.replace(/\s+/g, ' ').trim()}`)
    .sort()
    .join('')
  let h = 5381
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) | 0
  return `m${(h >>> 0).toString(36)}`
}

const PATH_SRC = String.raw`((?:\.\.?\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs))`
// A file marker that is a COMMENT whose content is (optionally "file:" and) just a path — e.g.
// `// file: src/math.ts`, `# src/math.ts`. Deliberately does NOT match a real code line like
// `import { add } from './calc'` (that starts with `import`, not a comment path-only line).
const MARKER_LINE = new RegExp(String.raw`^\s*(?://+|#)\s*(?:file\s*:)?\s*${PATH_SRC}\s*$`, 'i')
const PATH_ANY = new RegExp(PATH_SRC)

/**
 * Parse a model response into a FILE SET. A file's path is resolved from whichever of these the
 * model used (small models place the marker inconsistently, so accept ALL three):
 *   1) the fence info line:                 ```ts src/math.ts ↵ <code> ↵ ```
 *   2) the FIRST LINE INSIDE the block:     ``` ↵ // file: src/math.ts ↵ <code> ↵ ```  (marker stripped)
 *   3) a line just BEFORE the fence:        // file: src/math.ts ↵ ``` ↵ <code> ↵ ```
 * Later blocks win on a duplicate path (the model's final revision of that file).
 */
export function parseFileSet(raw: string): CandidateFile[] {
  const byPath = new Map<string, string>()
  const fenceRx = /```([^\n]*)\n([\s\S]*?)```/g
  for (let m; (m = fenceRx.exec(raw)); ) {
    const info = m[1]
    let body = m[2]
    let p: string | undefined

    // 1) path in the fence info string (```ts src/math.ts)
    const infoMatch = info.match(PATH_ANY)
    if (infoMatch) p = infoMatch[1]

    // 2) first line inside the block is a `// file: <path>` marker → use it, then strip the line
    if (!p) {
      const nl = body.indexOf('\n')
      const firstLine = nl >= 0 ? body.slice(0, nl) : body
      const mk = firstLine.match(MARKER_LINE)
      if (mk) { p = mk[1]; body = nl >= 0 ? body.slice(nl + 1) : '' }
    }

    // 3) a marker on the line(s) immediately preceding the opening fence
    if (!p) {
      const preceding = raw.slice(Math.max(0, m.index - 120), m.index)
      const preLine = preceding.split('\n').reverse().find(l => l.trim())
      const pm = preLine?.match(PATH_ANY)
      if (pm) p = pm[1]
    }

    if (p) byPath.set(p.replace(/^\.\//, ''), body.trim())
  }
  return [...byPath].map(([path, source]) => ({ path, source })).filter(f => f.source.length > 0)
}

/**
 * Build a multi-file Proposer bound to the requested file layout. The model is instructed to
 * emit each file with a `// file: <path>` header + a fenced block, wiring them with relative
 * imports. Every prior failure's bundle/case signals are threaded back so a weak model debugs
 * its own graph against ground truth.
 */
export function multiFileProposer(requestedFiles: string[]): Proposer<CandidateFile[]> {
  return async (ctx: ProposeContext<CandidateFile[]>): Promise<Candidate<CandidateFile[]> | null> => {
    const { spec, history, diversify } = ctx
    const acc = spec.acceptance as unknown as CodeAcceptance & { files?: string[] }
    const files = (acc.files && acc.files.length ? acc.files : requestedFiles)
    const entries = acc.entries && acc.entries.length ? acc.entries : [acc.entry]

    const layout = files.length
      ? `Lay the code out across these files (use EXACTLY these paths): ${files.map(f => '`' + f + '`').join(', ')}. Files import each other by RELATIVE path with NO extension (e.g. \`import { helper } from './util'\`).`
      : 'Lay the code out across a small set of files that import one another by relative path (no extension).'

    const system = [
      'You are a code-generation function inside a verification loop. You are NOT trusted — your',
      'output will be BUNDLED and EXECUTED against hidden test cases immediately. Return a correct,',
      'multi-file ES-module implementation and nothing else — no prose.',
      '',
      'Emit EACH file as its own fenced code block whose FIRST LINE is `// file: <path>`, followed',
      'by that file\'s FULL contents. Emit one block per file.',
      '',
      'CRITICAL import rule: a function is defined in EXACTLY ONE file. Any OTHER file that uses it',
      'must `import { fn } from \'./thatFile\'` (relative path, NO extension). Never use a function',
      'a file has not defined or imported. Never re-declare the same function in two files.',
      '',
      '### Example of the exact required format (a DIFFERENT task — do not copy its logic):',
      '```',
      '// file: src/greet.ts',
      'export function greet(name) { return "hi " + name }',
      '```',
      '```',
      '// file: src/main.ts',
      "import { greet } from './greet'",
      'export function welcome(name) { return greet(name) + "!" }',
      '```',
      '(`main.ts` imports `greet` from `./greet` because `greet` is defined in greet.ts.)',
      '',
      layout,
      `The module graph must export these function(s): ${entries.map(e => '`' + e + '`').join(', ')} — each must be defined and correct; they are tested together across the files.`,
      spec.context ? `\n## Grounding\n${spec.context}` : '',
    ].join('\n')

    const recent = history.slice(-2)
    const feedback = recent.length
      ? '\n\n## Your previous file sets FAILED verification. Fix these specific problems:\n' +
        recent.map((a, i) => {
          const dump = a.candidate.value.map(f => `// file: ${f.path}\n${f.source.length > 500 ? f.source.slice(0, 500) + '\n…(truncated)' : f.source}`).join('\n\n')
          return `### Attempt ${i + 1} (score ${a.verdict.score})\n${dump}\nFailures:\n${a.verdict.signals.map(s => `- ${s}`).join('\n')}`
        }).join('\n\n')
      : ''

    const user = `## Task\n${spec.goal}${feedback}\n\nReturn the corrected full file set now (one \`// file: <path>\` + fenced block per file).`

    const raw = await fmComplete(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { temperature: diversify ? 0.8 : 0.3 },
    )
    if (!raw || !raw.trim()) return null
    const parsed = parseFileSet(raw)
    if (!parsed.length) return null
    return { value: parsed, fingerprint: fingerprintFiles(parsed) }
  }
}

/**
 * Verifier<CandidateFile[]>: first a STRUCTURAL gate — when the request named ≥2 files, the
 * candidate must actually emit all of them as separate files (a weak model likes to collapse
 * everything into one; that's correct-but-not-what-was-asked, so it's rejected with a pointed
 * signal that pushes the next proposal to split). Then the behavioral gate: bundle the import
 * graph and execute the acceptance cases. Both are deterministic — no model.
 */
const multiFileVerifier: Verifier<CandidateFile[]> = (cand, spec) => {
  const acc = spec.acceptance as unknown as CodeAcceptance & { files?: string[] }
  const gate = coverageGate(cand.value, acc.files)
  if (gate) return gate
  return verifyMultiFileCode(cand.value, acc)
}

/** Verifier<CandidateFile[]> for the PROPERTY path — same coverage gate, then bundle+check props. */
const multiFilePropertyVerifier: Verifier<CandidateFile[]> = (cand, spec) => {
  const acc = spec.acceptance as unknown as { files?: string[]; assertions: string[]; family?: string }
  const gate = coverageGate(cand.value, acc.files)
  if (gate) return gate
  return verifyMultiFileByProperty(cand.value, acc)
}

/**
 * Structural coverage gate shared by both multi-file verifiers: when ≥2 files were requested, the
 * candidate must emit all of them as separate files (a weak model likes to collapse them into one —
 * correct-but-not-asked). Returns a failing Verdict with a pointed split signal, or null to proceed.
 */
function coverageGate(files: CandidateFile[], requestedFiles?: string[]): Verdict | null {
  const requested = (requestedFiles ?? []).map(f => f.replace(/^\.\//, ''))
  if (requested.length < 2) return null
  const have = new Set(files.map(f => f.path.replace(/^\.\//, '')))
  const missing = requested.filter(r => !have.has(r))
  if (!missing.length) return null
  return {
    pass: false, score: -100,
    signals: [`must emit ALL ${requested.length} requested files as SEPARATE \`// file:\` blocks — missing: ${missing.join(', ')}. Split the functions across the files and import across them by relative path; do not collapse everything into one file.`],
  }
}

/**
 * Derive property assertions for a no-example multi-file request by checking EACH declared function
 * against the property families. Returns the union of every matching function's assertions (so a
 * request defining `reverse` + `isPrime` certifies both), or null when no function matches a family.
 */
export function deriveMultiFileProperties(fns: string[]): { entries: string[]; families: string[]; assertions: string[] } | null {
  const entries: string[] = []
  const families: string[] = []
  const assertions: string[] = []
  for (const fn of fns) {
    const p = propertyForFunction(fn)
    if (p) { entries.push(fn); families.push(p.family); assertions.push(...p.assertions) }
  }
  return assertions.length ? { entries, families, assertions } : null
}

/**
 * Merge a certified file set into a project where some target paths ALREADY EXIST (the
 * modify-inside-multi-file case). Colliding files are structurally merged (same-named
 * declarations spliced with annotation grafting + call-site reconciliation, new ones
 * appended, imports unioned); non-colliding files pass through as-is. EVERY merged file
 * must still parse (esbuild). All-or-nothing: any unmergeable file → null, and the caller
 * must refuse the whole write. Callers should re-verify the returned set by execution
 * (verifyMultiFileCode) before writing — this merge is structural, not behavioral.
 */
export async function mergeCertifiedFileSet(
  certified: CandidateFile[],
  existingByPath: Map<string, string>,
): Promise<{ files: CandidateFile[]; detail: string } | null> {
  const out: CandidateFile[] = []
  const notes: string[] = []
  for (const f of certified) {
    const rel = f.path.replace(/^\.\//, '')
    const existing = existingByPath.get(rel)
    if (existing == null) { out.push(f); continue }
    const merged = mergeCertifiedSource(existing, f.source)
    if (!merged) return null
    try {
      await transform(merged.content, { loader: 'ts', format: 'esm', target: 'node18' })
    } catch {
      return null
    }
    out.push({ path: f.path, source: merged.content })
    notes.push(`${rel}: replaced [${merged.spliced.join(', ') || '—'}], added [${merged.appended.join(', ') || '—'}]${merged.callSitesRepaired ? `, ${merged.callSitesRepaired} call site(s) updated` : ''}`)
  }
  return { files: out, detail: notes.join('; ') }
}

export interface MultiFileResult {
  /** 'solved' → certified file set in .files; else no trustworthy spec/solution. */
  status: SearchResult<CandidateFile[]>['status'] | 'abstained'
  files: CandidateFile[] | null
  entry: string | null
  entries: string[] | null
  cases: CodeCase[] | null
  requestedFiles: string[]
  search: SearchResult<CandidateFile[]> | null
  detail: string
}

/**
 * Full doctrine loop for a MULTI-FILE request. Same trust order as single-file
 * (solveCodingRequest): USER examples (gold) → model-consensus cases. Certifies by
 * bundling+executing the proposed file graph; NEVER returns unverified files.
 *
 * `proposerOverride` lets the bench prove the LOOP deterministically without a live model.
 */
export async function solveMultiFileRequest(
  nl: string,
  opts: SearchOpts & { specSamples?: number; specComplete?: Completer; context?: string } = {},
  proposerOverride?: Proposer<CandidateFile[]>,
): Promise<MultiFileResult> {
  const requestedFiles = detectRequestedFiles(nl)
  const abstain = (detail: string): MultiFileResult => ({
    status: 'abstained', files: null, entry: null, entries: null, cases: null, requestedFiles, search: null, detail,
  })

  // 1) Ground truth: USER-stated examples (gold), else model-consensus cases.
  let entry: string, entries: string[], cases: CodeCase[], provenance: string
  const harvested = harvestExplicitExamples(nl)
  if (harvested.cases.length >= 1) {
    entry = harvested.entry; entries = harvested.entries; cases = harvested.cases
    provenance = `${cases.length} user example(s) (gold)${entries.length > 1 ? ` across ${entries.length} functions` : ''}`
  } else {
    // No user examples. DOCTRINE ORDER (trust): a GENERAL PROPERTY beats model-invented cases, so
    // try property families FIRST — for each declared function that matches a family, certify the
    // whole graph against that family's invariants (true for all inputs, no model bias). This
    // sidesteps the weak-FM consensus ceiling entirely when the functions are property-shaped.
    const declared = detectDeclaredFunctions(nl)
    const props = deriveMultiFileProperties(declared)
    if (props) {
      const pspec: TaskSpec = {
        goal: nl, domain: 'code', context: opts.context,
        acceptance: {
          entry: props.entries[0], entries: props.entries.length > 1 ? props.entries : undefined,
          assertions: props.assertions, family: [...new Set(props.families)].join('+'),
          files: requestedFiles.length ? requestedFiles : undefined,
        } as unknown as Record<string, unknown>,
      }
      const proposer = proposerOverride ?? multiFileProposer(requestedFiles)
      const result = await search(pspec, proposer, multiFilePropertyVerifier, opts)
      return {
        status: result.status,
        files: result.status === 'solved' ? (result.solution?.value ?? null) : null,
        entry: props.entries[0], entries: props.entries, cases: null, requestedFiles, search: result,
        detail: `no example → ${props.assertions.length} propert${props.assertions.length === 1 ? 'y' : 'ies'} across ${props.entries.length} function(s) [${props.entries.join(', ')}]${requestedFiles.length ? `; target files [${requestedFiles.join(', ')}]` : ''}; ${result.detail}`,
      }
    }

    // Else fall to model-consensus. When the request names ≥2 functions, extract consensus cases
    // for ALL of them (so every export is verified, not just one); otherwise single-function.
    const mfx = declared.length >= 2
      ? await extractMultiFunctionSpec(nl, declared, { samples: opts.specSamples, complete: opts.specComplete })
      : { ok: false as const, reason: 'fewer than 2 declared functions' }
    if (mfx.ok && mfx.spec) {
      entry = mfx.spec.entry; entries = mfx.spec.entries; cases = mfx.spec.cases; provenance = mfx.detail ?? ''
    } else {
      const ext = await extractCodeSpec(nl, { samples: opts.specSamples, complete: opts.specComplete })
      if (!ext.ok || !ext.spec) return abstain(`could not form a checkable spec: ${ext.reason ?? mfx.reason ?? 'unknown'}`)
      entry = ext.spec.entry; entries = [entry]; cases = ext.spec.cases; provenance = ext.detail ?? ''
    }
  }

  const spec: TaskSpec = {
    goal: nl, domain: 'code', context: opts.context,
    acceptance: {
      entry,
      entries: entries.length > 1 ? entries : undefined,
      cases,
      files: requestedFiles.length ? requestedFiles : undefined,
    } satisfies CodeAcceptance as unknown as Record<string, unknown>,
  }

  const proposer = proposerOverride ?? multiFileProposer(requestedFiles)
  const result = await search(spec, proposer, multiFileVerifier, opts)
  return {
    status: result.status,
    files: result.status === 'solved' ? (result.solution?.value ?? null) : null,
    entry, entries, cases, requestedFiles, search: result,
    detail: `${provenance}${requestedFiles.length ? `; target files [${requestedFiles.join(', ')}]` : ''}; ${result.detail}`,
  }
}

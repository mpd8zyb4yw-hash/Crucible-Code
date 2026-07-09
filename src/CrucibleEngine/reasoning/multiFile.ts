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

import { fmComplete } from '../agent/fmReact'
import { type CandidateFile, type CodeAcceptance, type CodeCase, verifyMultiFileCode } from './codeVerifier'
import { search, type SearchOpts } from './search'
import { type Completer, extractCodeSpec, harvestExplicitExamples } from './specExtractor'
import type { Candidate, ProposeContext, Proposer, SearchResult, TaskSpec, Verifier } from './types'

// A path-like token (slash or code extension, no spaces) — same conservative shape emitPlan uses.
const FILE_RX = /\b((?:\.\.?\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs))\b/g

/** Every distinct code-file path named in the request, in first-seen order, "./" stripped. */
export function detectRequestedFiles(nl: string): string[] {
  const seen = new Set<string>()
  for (const m of nl.matchAll(FILE_RX)) seen.add(m[1].replace(/^\.\//, ''))
  return [...seen]
}

/**
 * A request is multi-FILE when it names ≥2 distinct code files, OR names ≥1 file AND
 * explicitly asks for several modules / cross-file imports. Conservative on purpose: a
 * one-file "add X to foo.ts" edit or "write foo in foo.ts" impl is NOT multi-file — those
 * stay on the (cheaper, append-safe) single-file path.
 */
export function isMultiFileRequest(nl: string): boolean {
  const files = detectRequestedFiles(nl)
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
  const requested = (acc.files ?? []).map(f => f.replace(/^\.\//, ''))
  if (requested.length >= 2) {
    const have = new Set(cand.value.map(f => f.path.replace(/^\.\//, '')))
    const missing = requested.filter(r => !have.has(r))
    if (missing.length) {
      return {
        pass: false, score: -100,
        signals: [`must emit ALL ${requested.length} requested files as SEPARATE \`// file:\` blocks — missing: ${missing.join(', ')}. Split the functions across the files and import across them by relative path; do not collapse everything into one file.`],
      }
    }
  }
  return verifyMultiFileCode(cand.value, acc)
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
  opts: SearchOpts & { specSamples?: number; specComplete?: Completer } = {},
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
    const ext = await extractCodeSpec(nl, { samples: opts.specSamples, complete: opts.specComplete })
    if (!ext.ok || !ext.spec) return abstain(`could not form a checkable spec: ${ext.reason ?? 'unknown'}`)
    entry = ext.spec.entry; entries = [entry]; cases = ext.spec.cases; provenance = ext.detail ?? ''
  }

  const spec: TaskSpec = {
    goal: nl, domain: 'code',
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

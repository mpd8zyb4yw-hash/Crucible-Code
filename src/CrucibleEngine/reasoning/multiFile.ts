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

/**
 * Parse a model response into a FILE SET. Accepts two authoring styles (union of both):
 *   1) a path on the fence info line:            ```ts src/math.ts  ↵  <code>  ↵  ```
 *   2) a path on the line(s) just before a fence: // file: src/math.ts  ↵  ```  ↵ <code> ↵ ```
 * Later blocks win on a duplicate path (the model's final revision of that file).
 */
export function parseFileSet(raw: string): CandidateFile[] {
  const byPath = new Map<string, string>()
  const PATH = String.raw`((?:\.\.?\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs))`

  // Style 1 — path in the fence info string.
  const infoRx = new RegExp(String.raw`\`\`\`[a-zA-Z]*[ \t]+${PATH}[ \t]*\n([\s\S]*?)\`\`\``, 'g')
  for (let m; (m = infoRx.exec(raw)); ) byPath.set(m[1].replace(/^\.\//, ''), m[2].trim())

  // Style 2 — path on a line immediately preceding the opening fence.
  const preRx = new RegExp(String.raw`(?:^|\n)[^\n]*?${PATH}[^\n]*\n\`\`\`[a-zA-Z]*\n([\s\S]*?)\`\`\``, 'g')
  for (let m; (m = preRx.exec(raw)); ) {
    const p = m[1].replace(/^\.\//, '')
    if (!byPath.has(p)) byPath.set(p, m[2].trim())  // don't clobber a Style-1 capture of the same file
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
      'Emit EACH file as a line `// file: <path>` on its own, immediately followed by a fenced code',
      'block with that file\'s FULL contents. Emit one block per file.',
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

/** Verifier<CandidateFile[]>: bundle the graph and execute the acceptance cases against it. */
const multiFileVerifier: Verifier<CandidateFile[]> = (cand, spec) =>
  verifyMultiFileCode(cand.value, spec.acceptance as unknown as CodeAcceptance)

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

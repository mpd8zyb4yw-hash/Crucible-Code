// Characterization harness for Tier 2.4 ambiguity resolution (ambiguity.ts).
// Pure + deterministic — no model, no fixtures on disk. Hand-built SemanticIndex
// stand-ins exercise the unresolved-reference resolution paths against a fake index.
// Run: npx tsx src/CrucibleEngine/ambiguity-bench.ts
import { resolveAmbiguity } from './ambiguity'
import type { SemanticIndex, SymbolDef } from './state/semanticIndex'

function sym(name: string, kind: SymbolDef['kind'] = 'function'): SymbolDef {
  return { name, kind, exported: true, refs: [], heritage: [] }
}

function index(files: Record<string, string[]>): SemanticIndex {
  return {
    projectPath: '/fake',
    indexedAt: 0,
    files: Object.entries(files).map(([rel, names]) => ({
      rel, mtime: 0, imports: [], symbols: names.map((n) => sym(n)),
    })),
  }
}

interface Case {
  name: string
  goal: string
  index?: SemanticIndex
  check: (r: ReturnType<typeof resolveAmbiguity>) => string | null // null = pass, string = failure reason
}

const CASES: Case[] = [
  {
    name: 'DEF_REF verb-stoplist regression — validateEmail spec is not ambiguous',
    goal: 'add a validateEmail(s) function to src/validate.ts that returns true iff s matches a pattern',
    check: (r) => {
      if (r.ambiguous) return `expected not ambiguous, got ambiguous (confidence=${r.confidence}, signals=${JSON.stringify(r.signals)})`
      const badRef = r.signals.find((s) => s.type === 'unresolved-reference')
      if (badRef) return `spurious unresolved-reference signal: ${JSON.stringify(badRef)}`
      return null
    },
  },
  {
    name: 'fix the parser — resolves against index (single match) and is not ambiguous',
    goal: 'fix the parser',
    index: index({ 'src/parser.ts': ['Parser'] }),
    check: (r) => {
      if (r.ambiguous) return `expected not ambiguous, got ambiguous (confidence=${r.confidence}, signals=${JSON.stringify(r.signals)})`
      if (r.resolvedReferences.length !== 1) return `expected exactly 1 resolvedReference, got ${r.resolvedReferences.length}`
      const ref = r.resolvedReferences[0]
      if (ref.symbol !== 'Parser' || ref.rel !== 'src/parser.ts') return `wrong resolvedReference: ${JSON.stringify(ref)}`
      if (!r.rewrittenGoal || !r.rewrittenGoal.includes('Parser')) return `expected rewrittenGoal to name the resolved symbol, got ${r.rewrittenGoal}`
      return null
    },
  },
  {
    name: 'fix the parser — zero matches in index is ambiguous (unresolved-reference, no candidates)',
    goal: 'fix the parser',
    index: index({ 'src/other.ts': ['Unrelated'] }),
    check: (r) => {
      if (!r.ambiguous) return `expected ambiguous, got not ambiguous`
      const s = r.signals.find((s) => s.type === 'unresolved-reference')
      if (!s) return `expected an unresolved-reference signal`
      if (s.candidates?.length) return `expected no candidates for a zero-match reference, got ${JSON.stringify(s.candidates)}`
      if (r.resolvedReferences.length) return `expected no resolvedReferences on a zero-match reference`
      return null
    },
  },
  {
    name: 'fix the parser — multiple matches in index is ambiguous with candidates + clarificationOptions',
    goal: 'fix the parser',
    index: index({ 'src/a.ts': ['ParserA'], 'src/b.ts': ['ParserB'] }),
    check: (r) => {
      if (!r.ambiguous) return `expected ambiguous, got not ambiguous`
      const s = r.signals.find((s) => s.type === 'unresolved-reference')
      if (!s || (s.candidates?.length ?? 0) !== 2) return `expected 2 candidates, got ${JSON.stringify(s?.candidates)}`
      if (!r.clarificationOptions || r.clarificationOptions.length !== 3) return `expected 2 candidates + 1 fallback option, got ${JSON.stringify(r.clarificationOptions)}`
      if (!r.recommendedOption) return `expected a recommendedOption to be set`
      return null
    },
  },
  {
    name: 'no target file or symbol named — no-target signal fires',
    goal: 'improve performance',
    check: (r) => {
      if (!r.ambiguous) return `expected ambiguous, got not ambiguous`
      const types = r.signals.map((s) => s.type)
      if (!types.includes('no-target')) return `expected a no-target signal, got ${JSON.stringify(types)}`
      if (!types.includes('vague-scope')) return `expected a vague-scope signal, got ${JSON.stringify(types)}`
      return null
    },
  },
  {
    name: 'vague scope term alone is not enough to force ambiguous when target + criterion are present',
    goal: 'refactor stuff in src/foo.ts to sort the list',
    check: (r) => {
      const types = r.signals.map((s) => s.type)
      if (!types.includes('vague-scope')) return `expected a vague-scope signal, got ${JSON.stringify(types)}`
      if (r.confidence >= 1) return `expected confidence to be eroded by the vague-scope signal`
      return null
    },
  },
  {
    name: 'underspecified behavior — imperative with no checkable success criterion',
    goal: 'look at src/foo.ts',
    check: (r) => {
      const types = r.signals.map((s) => s.type)
      if (!types.includes('underspecified-behavior')) return `expected an underspecified-behavior signal, got ${JSON.stringify(types)}`
      return null
    },
  },
  {
    name: 'well-specified request naming a file and a checkable criterion is not ambiguous',
    goal: 'add a formatDate(d) function to src/date.ts that returns an ISO 8601 string',
    check: (r) => {
      if (r.ambiguous) return `expected not ambiguous, got ambiguous (confidence=${r.confidence}, signals=${JSON.stringify(r.signals)})`
      return null
    },
  },
  {
    name: 'unresolved reference with no index available is skipped (not treated as unresolvable)',
    goal: 'fix the parser',
    check: (r) => {
      const s = r.signals.find((s) => s.type === 'unresolved-reference')
      if (s) return `expected no unresolved-reference signal when no index is passed, got ${JSON.stringify(s)}`
      if (r.resolvedReferences.length) return `expected no resolvedReferences when no index is passed`
      return null
    },
  },
  // ── 2026-07-07 live-failure regressions (user screenshot repro) ──────────────────
  {
    name: 'LIVE REPRO — "Build this for me: a snake game …" never asks which file "for" refers to',
    goal: "Build this for me: a snake game Write the actual working code (real files, no stubs), run it to verify it works, and fix anything that breaks before finishing. If it's a game or interactive app, also produce a self-contained single-file web version (HTML + inline JS/canvas) so it's playable right inside Crucible.",
    index: index({ 'src/other.ts': ['Unrelated'] }),
    check: (r) => {
      if (r.ambiguous) return `expected not ambiguous, got ambiguous (confidence=${r.confidence}, clarification=${r.clarification})`
      const badRef = r.signals.find((s) => s.type === 'unresolved-reference')
      if (badRef) return `spurious unresolved-reference on a creation request: ${JSON.stringify(badRef)}`
      return null
    },
  },
  {
    name: 'LIVE REPRO — "build me a fully playable snake game" has no no-target signal',
    goal: 'build me a fully playable snake game',
    index: index({ 'src/other.ts': ['Unrelated'] }),
    check: (r) => {
      if (r.ambiguous) return `expected not ambiguous, got ambiguous (confidence=${r.confidence}, clarification=${r.clarification})`
      if (r.signals.some((s) => s.type === 'no-target')) return `no-target fired on a creation request`
      return null
    },
  },
  {
    name: 'function words after this/that are never treated as symbol references ("fix this for me")',
    goal: 'fix this for me: the WAL replay in src/wal.ts drops the last record, make replay(x) return every record',
    index: index({ 'src/other.ts': ['Unrelated'] }),
    check: (r) => {
      const forRef = r.signals.find((s) => s.type === 'unresolved-reference' && s.phrase?.toLowerCase() === 'for')
      if (forRef) return `"for" flagged as an unresolved reference: ${JSON.stringify(forRef)}`
      return null
    },
  },
  {
    name: 'empty index (fresh workspace) — prose nouns do not flag as unresolved references',
    goal: 'update the leaderboard so the ranking respects the tiebreaker',
    index: index({}),
    check: (r) => {
      const s = r.signals.find((s) => s.type === 'unresolved-reference')
      if (s) return `unresolved-reference fired against an EMPTY index: ${JSON.stringify(s)}`
      return null
    },
  },
  {
    name: 'edit-shaped goal against a populated index still interrogates ("fix the tokenizer", zero matches)',
    goal: 'fix the tokenizer',
    index: index({ 'src/other.ts': ['Unrelated'] }),
    check: (r) => {
      if (!r.ambiguous) return `expected ambiguous — the creation/empty-index bypasses must not swallow real edit-shaped ambiguity`
      const s = r.signals.find((s) => s.type === 'unresolved-reference')
      if (!s) return `expected an unresolved-reference signal`
      return null
    },
  },
]

// ── Jurisdiction (2026-07-28) ──────────────────────────────────────────────────
// This gate answers exactly one question — "which code should change?" — so it must stay
// silent on goals that are not about changing code. It did not: an anchored verb list meant
// 9 of these 14 ordinary requests were answered with "Which file or symbol should this change
// target?" and ZERO tool calls, which is what made `screenshot`, `browser_sign_in` and
// scheduling unreachable from chat. Non-code goals are an UNBOUNDED class, so the fix was to
// require positive code evidence rather than to enumerate them — and the second list below is
// what stops that from over-correcting into never clarifying a genuinely vague code request.
const MUST_PASS = [
  'take a screenshot of my screen',
  'screenshot my screen',
  'sign me in to youtube',
  'log into my youtube account',
  'save example.com as a pdf',
  'open youtube and tell me what is on my homepage',
  'what is in my downloads folder',
  'check my email',
  'what meetings do I have tomorrow',
  'summarise the wikipedia page on otters',
  'every weekday at 8am send me a summary of my inbox',
  'remind me to check the deploy at 5pm',
  'find me a good pasta recipe',
  'what is the weather in Berlin',
  // Device/CRUD phrasings that share their verb with programming — the reason EDIT_VERB
  // deliberately omits the generic CRUD verbs.
  'delete the downloads folder',
  'update the calendar',
  'change the wallpaper',
]

// Genuinely vague CODE requests. Clarifying is the CORRECT behaviour here, and the
// jurisdiction test must not swallow them.
const MUST_CLARIFY = [
  'fix the bug',
  'clean this up',
  'make it faster',
  'improve performance',
]

function main() {
  let ok = 0
  for (const c of CASES) {
    const r = resolveAmbiguity(c.goal, { index: c.index })
    const failure = c.check(r)
    const pass = failure === null
    if (pass) ok++
    console.log(`  ${pass ? 'OK ' : 'XX '} ${c.name}${pass ? '' : ` — ${failure}`}`)
  }
  let total = CASES.length

  console.log('\n  — jurisdiction: non-code goals must reach their tools —')
  for (const goal of MUST_PASS) {
    total++
    const r = resolveAmbiguity(goal, {})
    const pass = !r.ambiguous
    if (pass) ok++
    console.log(`  ${pass ? 'OK ' : 'XX '} passes: ${JSON.stringify(goal)}${pass ? '' : ` — BLOCKED (${r.confidence}) "${r.clarification}"`}`)
  }

  console.log('\n  — jurisdiction: vague CODE goals must still clarify —')
  for (const goal of MUST_CLARIFY) {
    total++
    const r = resolveAmbiguity(goal, {})
    const pass = r.ambiguous && !!r.clarification
    if (pass) ok++
    console.log(`  ${pass ? 'OK ' : 'XX '} clarifies: ${JSON.stringify(goal)}${pass ? '' : ` — passed through with confidence ${r.confidence}`}`)
  }

  console.log(`\nTOTAL: ${ok}/${total}`)
  if (ok !== total) process.exit(1)
}
main()

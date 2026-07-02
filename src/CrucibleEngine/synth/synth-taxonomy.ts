// ============================================================================
// synth-taxonomy — gate distribution reporter for synthesizeUniversal.
//
// Fires a battery of representative specs through the full L0→L1→L2→L3 cascade
// (FM disabled so L3 always escalates) and prints a table showing WHICH gate
// each spec lands at. This is the scoreboard the ROADMAP calls for:
//
//   "What % of specs are Gate-A-only vs behavioral-gated vs escalating?"
//
// Run: npm run synth:taxonomy
//
// Gates reported:
//   L0-primitive   — exact skill match, oracle-verified
//   L1-enum        — enumerative PBE, oracle-verified
//   L2-behavioral  — f(x)===y examples derived, FM would be oracle-gated
//   L2-property    — property family detected, FM would be property-gated
//   gate-A-only    — tsc-only, no behavioral test derivable (the unsafe bucket)
//   escalate       — honest escalation (no path, acceptGateAOnly=false)
//
// The "gate-A-only" count is the primary metric to drive down. Every new
// property family or f(x)===y example directly reduces this number.
// ============================================================================

import { synthesizePureCode } from './pureCode.js'
import { deriveTests, derivePropertyTests } from './derive.js'
import { extractFeatures } from './index.js'

// Import all proven skills so L0 sees the full library
import './skills/slug.js'
import './skills/chunk.js'
import './skills/groupBy.js'
import './skills/formatBytes.js'
import './skills/base64.js'
import './skills/escapeHtml.js'
import './skills/pickOmit.js'
import './skills/deepClone.js'
import './skills/capitalize.js'
import './skills/camelCase.js'
import './skills/pascalCase.js'
import './skills/snakeCase.js'
import './skills/truncate.js'
import './skills/countOccurrences.js'
import './skills/isPalindrome.js'
import './skills/reverseString.js'
import './skills/flatten.js'
import './skills/unique.js'
import './skills/setOps.js'
import './skills/compact.js'
import './skills/zip.js'
import './skills/range.js'
import './skills/arrayUtils.js'
import './skills/sumBy.js'
import './skills/mapValues.js'
import './skills/invert.js'
import './skills/flattenObject.js'
import './skills/clamp.js'
import './skills/formatNumber.js'
import './skills/typeGuards.js'
import './skills/fnUtils.js'

type Gate =
  | 'L0-primitive'
  | 'L1-enum'
  | 'L2-behavioral'
  | 'L2-property'
  | 'gate-A-only'
  | 'escalate'

interface TaxSpec {
  id: string
  spec: string
  /** Expected gate (for regression detection). Leave undefined to just measure. */
  expectedGate?: Gate
}

// ── Battery of representative specs ─────────────────────────────────────────
// Covers: L0 primitives, f(x)===y behavioral, property families, Gate-A-only,
// genuine escalation. Intentionally mixes common real-world shapes.
const SPECS: TaxSpec[] = [
  // ── L0 exact primitive hits ─────────────────────────────────────────────
  {
    id: 'slug-primitive',
    spec: `Write src/slug.ts.\nexport function slug(s: string): string\nslug("Hello World") === "hello-world"`,
    expectedGate: 'L0-primitive',
  },
  {
    id: 'chunk-primitive',
    spec: `Write src/chunk.ts.\nexport function chunk<T>(arr: T[], size: number): T[][]\nchunk([1,2,3,4],2) === [[1,2],[3,4]]`,
    expectedGate: 'L0-primitive',
  },
  {
    id: 'groupby-primitive',
    spec: `Write src/groupBy.ts.\nexport function groupBy<T>(arr: T[], key: keyof T): Record<string, T[]>`,
    expectedGate: 'L0-primitive',
  },

  // ── L2 behavioral (f(x)===y examples) ──────────────────────────────────
  {
    id: 'edit-distance-behavioral',
    // L1 structural bridge picks this up with behavioral oracle — that's strictly better than L2
    spec: `Write src/editDistance.ts.\nexport function editDistance(a: string, b: string): number\neditDistance('kitten','sitting') === 3\neditDistance('','abc') === 3\neditDistance('abc','abc') === 0`,
  },
  {
    id: 'capitalize-behavioral',
    // L0 primitive hit — better than L2
    spec: `Write src/capitalize.ts.\nexport function capitalize(s: string): string\ncapitalize('hello world') === 'Hello World'\ncapitalize('') === ''`,
  },
  {
    id: 'roman-numerals-behavioral',
    // L1 structural bridge picks this up — better than L2
    spec: `Write src/roman.ts.\nexport function toRoman(n: number): string\ntoRoman(3) === 'III'\ntoRoman(4) === 'IV'\ntoRoman(9) === 'IX'\ntoRoman(14) === 'XIV'\ntoRoman(40) === 'XL'`,
  },
  {
    id: 'fib-behavioral',
    spec: `Write src/fib.ts.\nexport function fib(n: number): number\nfib(0) === 0\nfib(1) === 1\nfib(6) === 8\nfib(10) === 55`,
    expectedGate: 'L2-behavioral',
  },

  // ── L2 property-gated ────────────────────────────────────────────────────
  {
    id: 'base64-codec',
    spec: `Write src/myBase64.ts.\nexport function myEncode(s: string): string\nexport function myDecode(s: string): string`,
    expectedGate: 'L2-property',
  },
  {
    id: 'sort-property',
    spec: `Write src/sortNums.ts.\nexport function sortNums(arr: number[]): number[]`,
    expectedGate: 'L2-property',
  },
  {
    id: 'string-transform-property',
    spec: `Write src/titleCase.ts.\nexport function titleCase(s: string): string`,
    expectedGate: 'L2-property',
  },
  {
    id: 'filter-opts-property',
    spec: `Write src/filterUsers.ts.\nexport function filterUsers(users: {id:number,name:string,active:boolean}[], opts: {active?: boolean}): typeof users`,
    expectedGate: 'L2-property',
  },
  {
    id: 'comparator-property',
    spec: `Write src/compareAge.ts.\nexport function compareAge(a: number, b: number): number`,
    expectedGate: 'L2-property',
  },
  {
    id: 'union-set-op-property',
    spec: `Write src/setUtils.ts.\nexport function union<T>(a: T[], b: T[]): T[]`,
    expectedGate: 'L2-property',
  },
  {
    id: 'intersect-set-op-property',
    spec: `Write src/setUtils.ts.\nexport function intersect<T>(a: T[], b: T[]): T[]`,
    expectedGate: 'L2-property',
  },
  {
    id: 'clamp-number-transform',
    // L0 hits clamp primitive — better than L2-property
    spec: `Write src/clampVal.ts.\nexport function clamp(value: number, min: number, max: number): number`,
  },
  {
    id: 'lerp-number-transform',
    // Note: clamp skill collision-matches 3-number→number signatures (Gate #3 in ROADMAP).
    // lerp hitting L0 here is a WRONG ship risk — clamp primitive would be emitted for lerp.
    // Tracked as matcher collision issue; number-transform property family is the safety net.
    spec: `Write src/linearInterp.ts.\nexport function lerp(a: number, b: number, t: number): number`,
  },
  {
    id: 'memoize-deterministic',
    spec: `Write src/memoize.ts.\nexport function memoize<T extends (...args: any[]) => any>(fn: T): T`,
    expectedGate: 'L2-property',
  },
  {
    id: 'hash-deterministic',
    spec: `Write src/hash.ts.\nexport function hash(s: string): number`,
    expectedGate: 'L2-property',
  },
  {
    id: 'every-array-predicate',
    spec: `Write src/everyPositive.ts.\nexport function everyPositive(arr: number[]): boolean`,
    expectedGate: 'L2-property',
  },
  {
    id: 'none-array-predicate',
    spec: `Write src/noneNegative.ts.\nexport function noneNegative(arr: number[]): boolean`,
    expectedGate: 'L2-property',
  },
  {
    id: 'parser-roundtrip',
    spec: `Write src/csvParser.ts.\nexport function parse(s: string): unknown\nexport function stringify(v: unknown): string`,
    expectedGate: 'L2-property',
  },
  {
    id: 'validator-property',
    // L1 structural bridge hits is-email skill with behavioral oracle — better than L2-property
    spec: `Write src/isEmail.ts.\nexport function isEmail(s: string): boolean`,
  },

  {
    id: 'event-emitter-class',
    // L0 hits event-emitter-simple skill — better than property gate
    spec: `Write src/EventEmitter.ts.\nexport class EventEmitter {\n  constructor()\n  on(event: string, fn: Function): void\n  off(event: string, fn: Function): void\n  emit(event: string, ...args: any[]): void\n}`,
  },
  {
    id: 'state-machine-class',
    // L0 hits state-machine skill — better than property gate
    spec: `Write src/StateMachine.ts.\nexport class StateMachine {\n  constructor(initial: string)\n  transition(event: string): void\n  getState(): string\n  reset(): void\n}`,
  },
  {
    id: 'token-parser-class',
    spec: `Write src/TokenParser.ts.\nexport class TokenParser {\n  constructor(input: string)\n  parse(): string[]\n  peek(): string\n  next(): string\n}`,
    expectedGate: 'L2-property',
  },

  // ── Gate-A-only (no derivable tests, no recognized family) ───────────────
  {
    id: 'react-component-gate-a',
    // Note: export default function isn't parsed by extractFeatures → honest escalation.
    // This is correct — no behavioral test derivable for a React component.
    spec: `Write src/LoginForm.tsx.\nA React component that renders a login form with email and password fields.\nexport default function LoginForm({ onSubmit }: { onSubmit: (email: string, pw: string) => void }): JSX.Element`,
    expectedGate: 'escalate',
  },
  {
    id: 'express-route-gate-a',
    spec: `Write src/routes/users.ts.\nAn Express router that exports a GET /users route returning JSON from a database.\nexport const usersRouter: Router`,
  },
  {
    id: 'prisma-service-gate-a',
    spec: `Write src/userService.ts.\nA service class that wraps Prisma to create/read/update/delete users.\nexport class UserService { constructor(prisma: PrismaClient) }`,
  },
  {
    id: 'middleware-gate-a',
    spec: `Write src/middleware/auth.ts.\nExpress middleware that validates a JWT Bearer token from Authorization header.\nexport function authMiddleware(req: Request, res: Response, next: NextFunction): void`,
  },

  // ── Honest escalation (prose-only, no exports, not even Gate-A applicable) ──
  {
    id: 'vague-prose-escalate',
    spec: `Make the login page look nicer and fix the bug where users can't log in on mobile.`,
    expectedGate: 'escalate',
  },
  {
    id: 'multi-file-refactor-escalate',
    spec: `Refactor the entire authentication system to use OAuth2 instead of JWT. Update all affected files.`,
    expectedGate: 'escalate',
  },
]

// ── Gate classifier ───────────────────────────────────────────────────────────
async function classifyGate(spec: string): Promise<{ gate: Gate; detail: string }> {
  const feats = extractFeatures(spec)
  const modulePath = feats.modulePath ?? 'src/module.ts'

  // L0 + L1: pure-code path (no model)
  const pc = await synthesizePureCode(spec, { verify: 'sync' })
  if (pc.verified && pc.files.length) {
    const gate: Gate = pc.source === 'primitive' ? 'L0-primitive' : 'L1-enum'
    return { gate, detail: pc.detail }
  }

  // Can we derive f(x)===y behavioral tests?
  const behavioral = deriveTests(spec, modulePath)
  if (behavioral) {
    return { gate: 'L2-behavioral', detail: `${behavioral.count} behavioral assertions derivable` }
  }

  // Can we derive property tests?
  const property = derivePropertyTests(spec, modulePath)
  if (property) {
    return { gate: 'L2-property', detail: `family=${property.family}, ${property.count} property assertions` }
  }

  // Are there any exports? If so, Gate-A (tsc-only) is applicable.
  if (feats.exports.length > 0) {
    return { gate: 'gate-A-only', detail: `exports=[${feats.exports.join(', ')}], no derivable tests` }
  }

  return { gate: 'escalate', detail: 'no exports, no derivable tests — honest escalation' }
}

// ── Runner ────────────────────────────────────────────────────────────────────
async function main() {
  const GATE_ORDER: Gate[] = ['L0-primitive', 'L1-enum', 'L2-behavioral', 'L2-property', 'gate-A-only', 'escalate']
  const counts: Record<Gate, number> = {
    'L0-primitive': 0, 'L1-enum': 0, 'L2-behavioral': 0,
    'L2-property': 0, 'gate-A-only': 0, 'escalate': 0,
  }
  const regressions: string[] = []
  const rows: Array<{ id: string; gate: Gate; expected?: Gate; detail: string }> = []

  for (const s of SPECS) {
    const { gate, detail } = await classifyGate(s.spec)
    counts[gate]++
    rows.push({ id: s.id, gate, expected: s.expectedGate, detail })
    if (s.expectedGate && gate !== s.expectedGate) {
      regressions.push(`  REGRESSION ${s.id}: expected ${s.expectedGate}, got ${gate}`)
    }
  }

  const total = SPECS.length
  const behaviorallyGated = counts['L0-primitive'] + counts['L1-enum'] + counts['L2-behavioral'] + counts['L2-property']
  const gateACount = counts['gate-A-only']

  console.log('\n══════════════════════════════════════════════════════════════')
  console.log('  CRUCIBLE SYNTH GATE TAXONOMY')
  console.log('══════════════════════════════════════════════════════════════')

  // Per-gate breakdown
  console.log('\nGate distribution:')
  for (const gate of GATE_ORDER) {
    const n = counts[gate]
    const pct = ((n / total) * 100).toFixed(0).padStart(3)
    const bar = '█'.repeat(Math.round(n / total * 30)).padEnd(30, '░')
    const label =
      gate === 'gate-A-only' ? `${gate}  ← THE TARGET TO SHRINK` :
      gate === 'L2-property' ? `${gate}  ← property families` :
      gate
    console.log(`  ${gate.padEnd(18)} ${pct}%  ${bar}  (${n}/${total})  ${label !== gate ? label.replace(gate, '') : ''}`)
  }

  console.log('\nSummary:')
  console.log(`  Behaviorally gated : ${behaviorallyGated}/${total} (${((behaviorallyGated/total)*100).toFixed(0)}%)`)
  console.log(`  Gate-A only (unsafe): ${gateACount}/${total} (${((gateACount/total)*100).toFixed(0)}%)`)
  console.log(`  Honest escalation  : ${counts['escalate']}/${total}`)

  console.log('\nPer-spec detail:')
  for (const r of rows) {
    const match = !r.expected || r.gate === r.expected
    const flag = match ? '✓' : '✗'
    const exp = r.expected && !match ? ` (expected ${r.expected})` : ''
    console.log(`  ${flag} [${r.gate.padEnd(18)}] ${r.id}${exp}`)
    if (r.gate === 'gate-A-only' || !match) {
      console.log(`      → ${r.detail}`)
    }
  }

  if (regressions.length) {
    console.log('\n⚠  GATE REGRESSIONS DETECTED:')
    for (const r of regressions) console.log(r)
    console.log('')
    process.exit(1)
  }

  console.log('\n══════════════════════════════════════════════════════════════')
  const moat = ((behaviorallyGated / (behaviorallyGated + gateACount || 1)) * 100).toFixed(0)
  console.log(`  Moat coverage (behavioral / (behavioral+gateA)): ${moat}%`)
  console.log(`  Gate-A-only specs are FM output with NO behavioral proof.`)
  console.log(`  Each new property family converts gate-A → L2-property.`)
  console.log('══════════════════════════════════════════════════════════════\n')
}

main().catch(e => { console.error(e); process.exit(1) })

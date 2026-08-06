// ============================================================================
// Committed bench for goalExampleOracle.ts. The extractor is the inference-prone half of a
// verifier, so it is benched HARDER on ABSTENTION than on extraction: a wrongly-mined
// assertion false-rejects a correct candidate and poisons the repair loop (cont.85 — a
// verifier fails in two directions). Cases below use the REAL agentic corpus goals verbatim
// (src/CrucibleEngine/agent/__agentic_corpus.ts) so the bench proves behavior on the exact
// prose the loop sees, not on invented strings.
// Run: npx tsx src/CrucibleEngine/synth/__goalExampleOracle_bench.ts
// ============================================================================
import { mineGoalExamples, buildGoalExampleTest } from './goalExampleOracle'

interface Case {
  name: string
  goal: string
  // Each expected mined example as `call=>expected` (verbatim source), or [] to require abstention.
  expect: string[]
}

const CASES: Case[] = [
  // ── REAL corpus goals ────────────────────────────────────────────────────────────────
  {
    name: 'corpus add-titlecase: the one goal with a literal call example is mined',
    goal: 'Add a titleCase(s) function to src/strings.ts and export it. It should uppercase the first letter of each space-separated word and lowercase the rest. titleCase("hello world") should return "Hello World".',
    expect: ['titleCase("hello world")=>"Hello World"'],
  },
  {
    name: 'corpus average-empty-array: "return 0 for an empty array" is NOT call-form ⇒ abstain',
    goal: 'src/stats.ts average() divides by zero on an empty array and returns NaN. Make it return 0 for an empty array instead.',
    expect: [],
  },
  {
    name: 'corpus validate-email-domain: a RULE, no example ⇒ abstain (property-judge territory)',
    goal: 'src/validate.ts isValidEmail() accepts anything with an @ in it. Tighten it so it also requires a dot in the domain part after the @. src/signup.ts calls it.',
    expect: [],
  },
  {
    name: 'corpus cross-file-currency: "500 renders as \\"$5\\"" is not fn(500) call-form ⇒ abstain',
    goal: 'src/format.ts formatCents() renders cents as dollars but drops the trailing zeros, so 500 renders as "$5". Make it always show exactly two decimal places, e.g. "$5.00". src/receipt.ts uses it and must keep working.',
    expect: [],
  },
  {
    name: 'corpus clamp-upper-bound: prose only ⇒ abstain',
    goal: 'In src/clamp.ts, clamp() currently only enforces the lower bound. Make it enforce the upper bound too, so a value above max comes back as max.',
    expect: [],
  },
  {
    name: 'corpus chunk-off-by-one: prose only ⇒ abstain',
    goal: 'src/chunk.ts chunk(xs, size) drops the final partial chunk. Fix it so the remaining elements come back as a last, shorter chunk.',
    expect: [],
  },
  {
    name: 'corpus dedupe-preserve-order: prose only ⇒ abstain',
    goal: 'src/dedupe.ts dedupe() removes duplicates but scrambles the order because it uses a Set and sorts. Make it preserve the original first-seen order of the elements.',
    expect: [],
  },

  // ── extraction: cue and value-type coverage ────────────────────────────────────────────
  {
    name: 'cue "returns" + string',
    goal: 'add(1, 2) returns 3.',   // wait: 3 is a number, add is the fn — value literal number
    expect: ['add(1, 2)=>3'],
  },
  {
    name: 'cue "===" + number',
    goal: 'The helper double(21) === 42 must hold.',
    expect: ['double(21)=>42'],
  },
  {
    name: 'cue "→" + array literal (args transcribed VERBATIM — no reformatting)',
    goal: 'sort([3,1,2]) → [1, 2, 3]',
    expect: ['sort([3,1,2])=>[1, 2, 3]'],
  },
  {
    name: 'cue "should be" + boolean',
    goal: 'isEven(4) should be true.',
    expect: ['isEven(4)=>true'],
  },
  {
    name: 'cue "evaluates to" + object literal',
    goal: 'parse("a=1") evaluates to { a: 1 }.',
    expect: ['parse("a=1")=>{ a: 1 }'],
  },
  {
    name: 'multiple examples in one goal, both mined + deduped',
    goal: 'titleCase("a") should return "A". titleCase("a") should return "A". titleCase("hi there") returns "Hi There".',
    expect: ['titleCase("a")=>"A"', 'titleCase("hi there")=>"Hi There"'],
  },
  {
    name: 'no-arg call example',
    goal: 'now() returns 0 in the frozen clock.',
    expect: ['now()=>0'],
  },

  // ── ABSTENTION guards (the load-bearing safety) ────────────────────────────────────────
  {
    name: 'ABSTAIN: call with a non-literal (identifier) argument',
    goal: 'process(input) returns "done".',
    expect: [],
  },
  {
    name: 'ABSTAIN: call followed by prose, no result cue',
    goal: 'You should call titleCase("hello") in your loop somewhere.',
    expect: [],
  },
  {
    name: 'ABSTAIN: cue present but expected is not a literal (an expression)',
    goal: 'total(a, b) returns a + b.',    // args non-literal AND expected non-literal
    expect: [],
  },
  {
    name: 'ABSTAIN: cue present, expected is an identifier not a literal',
    goal: 'clamp(5, 0, 10) returns max.',
    expect: [],
  },
  {
    name: 'ABSTAIN: template-literal expected with interpolation is not a literal',
    goal: 'greet("x") returns `hi ${name}`.',
    expect: [],
  },
  {
    name: 'ABSTAIN: nested call in args is not a literal arg list',
    goal: 'f(g(1)) returns 2.',
    expect: [],
  },
  {
    name: 'ABSTAIN: bare function mention, no parens',
    goal: 'The titleCase function should return capitalized words.',
    expect: [],
  },
]

function main() {
  let pass = 0
  for (const c of CASES) {
    const mined = mineGoalExamples(c.goal).map(e => `${e.call}=>${e.expected}`)
    const ok = mined.length === c.expect.length && c.expect.every(e => mined.includes(e))
    if (ok) pass++
    console.log(`${ok ? 'PASS' : 'FAIL'} — ${c.name}`)
    if (!ok) console.log(`    got:      ${JSON.stringify(mined)}\n    expected: ${JSON.stringify(c.expect)}`)
  }

  // buildGoalExampleTest: the emitted file imports the fn and asserts the example; and
  // abstains (null) when nothing is mined.
  const built = buildGoalExampleTest('titleCase("hello world") should return "Hello World".', 'src/strings.ts')
  const buildOk = !!built &&
    built.content.includes("import { titleCase } from '../src/strings'") &&
    built.content.includes('const __got = titleCase("hello world")') &&
    built.content.includes('const __exp = "Hello World"') &&
    built.content.includes('process.exit(failures === 0 ? 0 : 1)')
  console.log(`${buildOk ? 'PASS' : 'FAIL'} — buildGoalExampleTest emits an importing assertion for the mined example`)
  if (buildOk) pass++; else console.log(`    got:\n${built?.content ?? '(null)'}`)

  const abstainBuild = buildGoalExampleTest('Make clamp enforce the upper bound.', 'src/clamp.ts')
  const abstainOk = abstainBuild === null
  console.log(`${abstainOk ? 'PASS' : 'FAIL'} — buildGoalExampleTest returns null when nothing is mined`)
  if (abstainOk) pass++; else console.log(`    got: ${JSON.stringify(abstainBuild)}`)

  const total = CASES.length + 2
  console.log(`\n${pass}/${total} passed`)
  if (pass !== total) process.exit(1)
}

main()

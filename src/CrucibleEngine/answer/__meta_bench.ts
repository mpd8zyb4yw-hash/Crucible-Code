// ============================================================================
// Bench for matchMeta (conversational.ts) — the deterministic identity/capability layer.
//
// This layer's whole job is to stop meta-questions reaching web search. When it misses, the
// failure is spectacular and user-facing: "who made you" once returned the AC/DC song "Who
// Made Who", and (measured 2026-08-03) "What can you do for me?" returned a Utah Saints
// single and a Willie Nelson album — both titled "What Can You Do for Me" — reported to the
// user as VERIFIED. A regex anchored one token too tightly is all it takes.
//
// So the bench runs BOTH directions, and the negative direction is the important one: these
// patterns must never swallow a real question that merely starts with the same words.
// Run: npx tsx src/CrucibleEngine/answer/__meta_bench.ts
// ============================================================================
import { matchMeta } from './conversational'

const SHOULD_MATCH: Array<[string, string]> = [
  ['what can you do', 'capability'],
  ['What can you do for me?', 'capability'],          // the Utah Saints regression
  ['what can you do for us', 'capability'],
  ['What can you do exactly?', 'capability'],
  ['what can you help me with', 'capability'],
  ['what can you do here', 'capability'],
  ['What else can you do?', 'capability'],
  ['how can you help', 'capability'],
  ['what do you do', 'capability'],
  ['who are you', 'identity'],
  ['who made you', 'identity'],
  ['what are you', 'identity'],
  ['hi', 'greeting'],
  ['hey there', 'greeting'],
  ['test', 'greeting'],
]

// Real questions that merely LOOK like meta-openers. A match here is a false positive that
// would answer a genuine question with canned marketing copy — worse than a miss.
const SHOULD_NOT_MATCH: string[] = [
  'who won the 1998 World Cup',
  'who are you voting for',
  'who made the Eiffel Tower',
  'what can you do with a raspberry pi',
  'what can you do to fix a leaking tap',
  'what do you do when a merge conflict happens',
  'how can you help someone with a panic attack',
  'what are you supposed to do if the fire alarm goes off',
  'help me write a cover letter',
  'test whether this API returns 429 under load',
  'hi how do I reset my password',
]

let pass = 0, fail = 0
const ok = (c: boolean, msg: string) => { if (c) { pass++ } else { fail++; console.log(`  FAIL  ${msg}`) } }

console.log('— should match —')
for (const [q, kind] of SHOULD_MATCH) {
  const m = matchMeta(q)
  ok(!!m, `no match: "${q}"`)
  if (m) ok(m.kind === kind, `"${q}" matched ${m.kind}, expected ${kind}`)
}

console.log('— should NOT match (false positives are worse than misses) —')
for (const q of SHOULD_NOT_MATCH) {
  const m = matchMeta(q)
  ok(!m, `false positive: "${q}" -> ${m?.kind}`)
}

// The copy must not make a privacy claim the system does not honour. Factual questions go
// out to public APIs (retrieval/sources.ts), so "nothing leaves your machine" is false.
console.log('— copy accuracy —')
for (const q of ['what can you do', 'who are you', 'who made you', 'hi']) {
  const t = matchMeta(q)?.text ?? ''
  ok(!/nothing (?:you say )?leaves your machine/i.test(t), `"${q}" claims nothing leaves the machine`)
  ok(!/\ball on-device\b/i.test(t), `"${q}" claims "all on-device"`)
  ok(!/runs? entirely on your (?:own )?device/i.test(t), `"${q}" claims it runs entirely on-device`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

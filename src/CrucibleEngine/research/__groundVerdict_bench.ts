// Bench for groundVerdict — the check that replaced the model's self-reported verdict.
//
// The bug it fixes (measured 2026-08-03, qwen2.5-1.5b): handed the HTTP/3 passage that plainly
// contains the answer, the model replied VERDICT:no / ANSWER:QUIC — a correct, grounded answer
// with a wrong self-label. researchDag `continue`s on 'no', so every research query abstained.
// Both directions matter; the demotion direction is the anti-hallucination one.
// Run: npx tsx src/CrucibleEngine/research/__groundVerdict_bench.ts
import { groundVerdict } from './leafPrimitives'

const SNIPPET =
  'HTTP/3 is the third major version of the Hypertext Transfer Protocol. Unlike previous ' +
  'versions which relied on TCP, HTTP/3 uses QUIC, a multiplexed transport protocol built on ' +
  'UDP. The switch to QUIC aims to fix a major problem of HTTP/2 called head-of-line blocking.'

let pass = 0, fail = 0
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  PASS  ${m}`) } else { fail++; console.log(`  FAIL  ${m}`) } }

const v = (verdict: any, extractedAnswer: string, confidence = 0.6) =>
  groundVerdict({ verdict, extractedAnswer, confidence }, SNIPPET)

console.log('— promotion: grounded answer wrongly labelled "no" (the measured regression) —')
ok(v('no', 'QUIC').verdict === 'partial', 'single grounded token "QUIC" promoted no -> partial')
ok(v('no', 'head-of-line blocking').verdict === 'partial', 'grounded phrase promoted no -> partial')
ok(v('no', 'QUIC').confidence <= 0.5, 'promotion caps confidence (never asserts more than it earned)')
ok(v('no', 'QUIC').verdict !== 'yes', 'promotion never jumps straight to yes')

console.log('— demotion: ungrounded answer claimed as "yes" (anti-hallucination) —')
ok(v('yes', 'HTTP/3 was designed by Cloudflare in 2013').verdict === 'partial',
   'ungrounded claim demoted yes -> partial')
ok(v('yes', 'Sydney is the capital of Australia').verdict === 'partial',
   'wholly unrelated answer demoted yes -> partial')
ok(v('yes', 'QUIC').verdict === 'yes', 'grounded answer keeps its yes')

console.log('— non-answers stay refusals —')
for (const n of ['none', 'None', 'N/A', 'unknown', 'not stated', 'not mentioned', 'nothing']) {
  ok(v('yes', n).verdict === 'no', `"${n}" treated as a non-answer regardless of verdict`)
}
ok(v('partial', 'ab').verdict === 'no', 'too-short answer treated as a non-answer')

console.log('— partial stays partial —')
ok(v('partial', 'QUIC').verdict === 'partial', 'grounded partial unchanged')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

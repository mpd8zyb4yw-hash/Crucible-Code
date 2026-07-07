// Pure, offline bench for strengthenCandidates() (Track C — answer-strengthening).
// No model calls, no network — fixture CandidateAnswer sets only. Run: npx tsx
// src/CrucibleEngine/agent/__strengthen_bench.ts
import { strengthenCandidates, type CandidateAnswer } from './localModelRouter'

function cand(modelId: string, text: string, confidence = 0.75): CandidateAnswer {
  return { modelId, modelLabel: modelId, text, confidence, reason: 'fixture' }
}

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log('== agreeing cluster wins, confidence boosted but capped honestly ==')
{
  const r = strengthenCandidates([
    cand('a', 'The capital of France is Paris, a city on the Seine.'),
    cand('b', 'Paris is the capital of France, located on the Seine river.'),
    cand('c', 'I think it might be Lyon, not totally sure.', 0.4),
  ])
  check('picks the agreeing pair', r.contributors.includes('a') && r.contributors.includes('b'))
  check('excludes the lone dissenter', !r.contributors.includes('c'))
  check('method is consensus-vote', r.method === 'consensus-vote', r.method)
  check('confidence < 0.97 (not overclaimed)', r.confidence < 0.97, String(r.confidence))
}

console.log('== genuine conflict: no false high confidence ==')
{
  const r = strengthenCandidates([
    cand('a', 'The answer is 42, definitely.'),
    cand('b', 'The answer is 17, I am certain.'),
  ])
  check('method is plurality-fallback', r.method === 'plurality-fallback', r.method)
  check('confidence capped low on disagreement', r.confidence <= 0.6, String(r.confidence))
}

console.log('== one-right-one-wrong math: oracle tie-break, not vote ==')
{
  const r = strengthenCandidates([
    cand('a', 'To find the total: 12 * 4 = 40, so the total is 40.'),
    cand('b', 'To find the total: 12 * 4 = 48, so the total is 48.'),
  ])
  check('method is oracle-arithmetic', r.method === 'oracle-arithmetic', r.method)
  check('picks the numerically correct candidate (b)', r.winnerId === 'b', r.winnerId)
  check('text reflects the correct number', /48/.test(r.text) && !/= 40/.test(r.text))
  check('high confidence — deterministically checked', r.confidence >= 0.9, String(r.confidence))
}

console.log('== both wrong on the same claim: oracle still corrects in place ==')
{
  const r = strengthenCandidates([
    cand('a', 'The total is 5 + 5 = 11.'),
  ])
  check('method is oracle-arithmetic', r.method === 'oracle-arithmetic', r.method)
  check('text corrected to 10', /= 10/.test(r.text), r.text)
}

console.log('== mixed: majority agrees, one is a math outlier ==')
{
  const r = strengthenCandidates([
    cand('a', 'Revenue grew because unit sales increased.'),
    cand('b', 'Revenue grew mainly due to higher unit sales.'),
    cand('c', 'Revenue actually shrank this quarter.', 0.5),
  ])
  check('majority (a,b) wins over lone outlier', r.contributors.length === 2 && r.contributors.includes('a') && r.contributors.includes('b'))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)

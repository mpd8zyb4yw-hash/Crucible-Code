// ============================================================================
// Committed bench for checkPremiseGrounding's CONSENSUS voting (leafPrimitives.ts).
// A premise correction FLIPS an answer to the opposite of what the question assumed,
// so a single hallucinated "contradicted" must never carry it (the live 2018-World-Cup
// bug: one FM call claimed France did NOT win, at confidence 1.0). A correction now
// ships only when a strict majority of K independent votes BOTH flag a contradiction
// AND agree on the displaced fact (not merely the shared subject).
// Deterministic: a scripted fmCall replays one raw completion per vote — no live FM.
// Run: npx tsx src/CrucibleEngine/research/__premiseConsensus_bench.ts
// ============================================================================
import { checkPremiseGrounding, correctionsAgree } from './leafPrimitives'

const YES = (corr: string, c = 0.9) => `CONTRADICTED: yes\nCORRECTION: ${corr}\nCONFIDENCE: ${c}`
const NO = 'CONTRADICTED: no\nCORRECTION: NONE\nCONFIDENCE: 0.9'

function scripted(seq: string[]) {
  let i = 0
  return async () => seq[i++ % seq.length]
}

interface Case {
  name: string
  question: string
  facts: string[]
  votes: string[]
  expectContradicted: boolean
}

const CASES: Case[] = [
  {
    name: 'unanimous genuine correction (Alaska ← Russia) ships',
    question: 'When did the US buy Alaska from Canada?',
    facts: ['The US purchased Alaska from Russia in 1867.'],
    votes: [YES('Alaska was purchased from Russia, not Canada'), YES('The US bought Alaska from Russia'), YES('Alaska came from Russia')],
    expectContradicted: true,
  },
  {
    name: 'lone hallucination outvoted (the 2018 World Cup bug) → NOT contradicted',
    question: 'Who won the 2018 World Cup?',
    facts: ['France won the 2018 World Cup.'],
    votes: [YES('France did not actually win'), NO, NO],
    expectContradicted: false,
  },
  {
    name: 'majority flags but corrections DISAGREE (red vs purple) → NOT contradicted',
    question: 'Why is X blue?',
    facts: ['X is green.'],
    votes: [YES('X is actually red not blue'), YES('X is purple not blue'), NO],
    expectContradicted: false,
  },
  {
    name: 'agreement on the displaced fact, not just the subject (Moon ← rock) ships',
    question: 'Why is the Moon made of cheese?',
    facts: ['The Moon is made of rock.'],
    votes: [YES('The Moon is made of rock, not cheese'), YES('The Moon is rock not cheese'), YES('It is rock')],
    expectContradicted: true,
  },
  {
    name: 'unanimous NO → NOT contradicted',
    question: 'When did France win the 2018 World Cup?',
    facts: ['France won the 2018 World Cup in Russia.'],
    votes: [NO, NO, NO],
    expectContradicted: false,
  },
  {
    name: 'bare-negation correction rejected even with a majority (per-vote guard)',
    question: 'Who won the 2018 World Cup?',
    facts: ['France won the 2018 World Cup.'],
    votes: [YES('France did not win the 2018 World Cup'), YES('France did not win the 2018 World Cup'), NO],
    expectContradicted: false,
  },
]

async function main() {
  let pass = 0
  for (const c of CASES) {
    const r = await checkPremiseGrounding(c.question, c.facts, scripted(c.votes) as any, c.votes.length)
    const ok = r.contradicted === c.expectContradicted
    if (ok) pass++
    console.log(`${ok ? 'PASS' : 'FAIL'} — ${c.name}`)
    if (!ok) console.log(`    got contradicted=${r.contradicted} conf=${r.confidence} correction="${r.correction}"`)
  }
  // Direct unit checks on the agreement helper.
  const agreeChecks: Array<[string, boolean]> = [
    ['shares displaced entity Russia', correctionsAgree('bought from Russia not Canada', 'came from Russia', new Set(['canada']))],
    ['only shares question subject X (ignored) → disagree', !correctionsAgree('X is red not blue', 'X is purple not blue', new Set(['x', 'blue']))],
  ]
  for (const [name, res] of agreeChecks) {
    if (res) pass++; else console.log(`FAIL — correctionsAgree: ${name}`)
    console.log(`${res ? 'PASS' : 'FAIL'} — correctionsAgree: ${name}`)
  }
  const total = CASES.length + agreeChecks.length
  console.log(`\n${pass}/${total} passed`)
  if (pass !== total) process.exit(1)
}

main()

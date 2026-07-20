// Bench for the off-brief relevance guard. Run: npx tsx src/CrucibleEngine/automations/offBrief.bench.ts
// The guard must CATCH genuinely off-topic prose and PASS correct-but-divergent-vocabulary
// answers (the 2026-07-20 false-reject class: math, conversions, translations, lookups).
import { offBriefReason } from './store'

interface Case { name: string; brief: string; answer: string; wantOff: boolean }

const CASES: Case[] = [
  // ── Must PASS (relevant, or too short/computed to judge) — the false-reject class ──
  { name: 'math result', brief: 'In one sentence, state what 17 times 4 equals and nothing else.', answer: '68', wantOff: false },
  { name: 'math sentence', brief: 'State what 17 times 4 equals.', answer: 'It equals 68.', wantOff: false },
  { name: 'currency conversion', brief: 'Convert 100 US dollars to euros at the current rate.', answer: '€92.40', wantOff: false },
  { name: 'unit conversion', brief: 'How many kilometers are in 5 miles?', answer: '8.05', wantOff: false },
  { name: 'short translation', brief: "Translate the phrase 'good morning' into French.", answer: 'Bonjour', wantOff: false },
  { name: 'yes/no answer', brief: 'Is the New York Stock Exchange open today?', answer: 'Yes, it is open.', wantOff: false },
  { name: 'relevant prose', brief: 'List three benefits of drinking water for the human body.', answer: 'Drinking water hydrates the body, supports kidney function, and helps regulate temperature.', wantOff: false },
  { name: 'shares one number', brief: 'Summarize the Q4 2024 revenue results.', answer: 'The company posted strong growth throughout 2024 with record quarterly figures.', wantOff: false },
  { name: 'thin brief unjudgeable', brief: 'Go.', answer: 'Here is a long unrelated essay about migratory birds and their seasonal patterns across continents.', wantOff: false },

  // ── Must CATCH (substantial prose, zero overlap with a content-bearing brief) ──
  { name: 'the original live catch', brief: 'Give me my morning brief: calendar, tasks, and inbox highlights for today.', answer: 'The reward-anticipatory units in vision language models predict future latent states during pretraining.', wantOff: true },
  { name: 'wrong-topic essay', brief: 'Summarize the latest developments in renewable solar energy adoption.', answer: 'Basketball players train extensively on footwork, shooting mechanics, defensive rotations, and conditioning drills.', wantOff: true },
]

let pass = 0
for (const c of CASES) {
  const got = offBriefReason(c.brief, c.answer) !== null
  const ok = got === c.wantOff
  if (ok) pass++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  (wantOff=${c.wantOff}, gotOff=${got})`)
}
console.log(`\n${pass}/${CASES.length}`)
process.exit(pass === CASES.length ? 0 : 1)

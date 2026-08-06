// Focused proof for correctArithmetic's broadened extractor (currency + unit words),
// pinned to the exact live-FM failures found 2026-07-07 (train-time & shirt-change probes)
// plus regression guards that must NOT be touched (algebra, ordinals, correct chains).
import { correctArithmetic, correctArithmeticCascade } from './domainVerifiers'

interface Case { name: string; in: string; expectNow?: string; expectNoChange?: boolean }
const cases: Case[] = [
  // ── Must correct (real live-FM failures) ──
  { name: 'shirt product w/ unit words + currency', in: '3 shirts * $23 per shirt = $72.', expectNow: '$69' },
  { name: 'clean currency difference (correct, leave)', in: '$100 - $72 = $28.', expectNoChange: true },
  { name: 'bare wrong product', in: 'So 47 * 53 = 2591 in total.', expectNow: '2491' },
  { name: 'unicode times wrong', in: 'We compute 12 × 12 = 140.', expectNow: '144' },
  { name: 'currency product', in: 'Total: $12 * 4 = $50.', expectNow: '$48' },
  { name: 'equation embedded in prose paragraph', in: 'To find out, you subtract 2026 from 2007.\n\n2007 - 2026 = -20 years.', expectNow: '-19' },
  { name: 'prose before clean product', in: 'We have 5 apples, but 3 * 4 = 13 in the box.', expectNow: '12' },
  // ── Must NOT touch (ambiguous / non-arithmetic / algebra) ──
  { name: 'algebra variable', in: 'Solving 3x = 12 gives x = 4.', expectNoChange: true },
  { name: 'ordinal glued to digit', in: 'The 23rd item = 5 units.', expectNoChange: true },
  { name: 'unit glued to digit', in: '5kg * 2 = 11 kg', expectNoChange: true },
  { name: 'two numbers no operator', in: '2 apples 3 oranges = 5', expectNoChange: true },
  { name: 'correct chain untouched', in: '2 + 3 + 4 = 9 total.', expectNoChange: true },
  { name: 'correct simple', in: '6 * 7 = 42.', expectNoChange: true },
]

let fail = 0
for (const c of cases) {
  const { text, corrections } = correctArithmetic(c.in)
  if (c.expectNoChange) {
    if (text !== c.in) { console.log(`FAIL ${c.name}: expected NO change, got "${text}"`); fail++ }
    else console.log(`ok   ${c.name} (untouched)`)
  } else {
    if (!corrections.length || !text.includes(c.expectNow!)) {
      console.log(`FAIL ${c.name}: expected "${c.expectNow}" in "${text}" (corrections=${JSON.stringify(corrections)})`); fail++
    } else console.log(`ok   ${c.name} → ${corrections.map(x => `${x.was}→${x.now}`).join(', ')}`)
  }
}
// ── Cascade / value-propagation cases (correctArithmeticCascade) ──────────────
// A corrected intermediate must propagate into downstream operands that reuse it.
interface CascadeCase { name: string; in: string; expectAll: string[]; expectAbsent?: string[] }
const cascadeCases: CascadeCase[] = [
  {
    name: 'shirt change: 72→69 propagates into $100-$72',
    in: '3 shirts * $23 per shirt = $72. Your change is $100 - $72 = $28.',
    expectAll: ['= $69', '$100 - $69 = $31'],
    expectAbsent: ['$72', '$28'],
  },
  {
    name: 'two-hop chain propagation',
    in: '10 * 3 = 40. Then 40 + 5 = 46. Finally 46 * 2 = 92.',
    // 10*3=30 → 30+5=35 → 35*2=70
    expectAll: ['10 * 3 = 30', '30 + 5 = 35', '35 * 2 = 70'],
    expectAbsent: ['= 40', '= 46', '= 92'],
  },
  {
    name: 'no false propagation of unrelated reuse',
    // 4*4=17 corrected to 16; the standalone "16 chapters" must NOT be rewritten
    in: 'He read 4 * 4 = 17 pages. The book has 16 chapters.',
    expectAll: ['4 * 4 = 16', '16 chapters'],
  },
]
for (const c of cascadeCases) {
  const { text } = correctArithmeticCascade(c.in)
  const missing = c.expectAll.filter(s => !text.includes(s))
  const present = (c.expectAbsent ?? []).filter(s => text.includes(s))
  if (missing.length || present.length) {
    console.log(`FAIL cascade:${c.name}: got "${text}" (missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(present)})`); fail++
  } else console.log(`ok   cascade:${c.name}`)
}
const total = cases.length + cascadeCases.length
console.log(fail === 0 ? `\nALL ${total} PASS` : `\n${fail}/${total} FAILED`)
process.exit(fail === 0 ? 0 : 1)

// ============================================================================
// CLAIM CHECK BENCH — anchored on the real measured failure, not a synthetic one.
//
// Case 1 is verbatim: the answer text the live path produced for "What is the capital of
// Australia?" on 2026-08-03 (shipped as `verified: true`), checked against the actual
// sentences retrieval returned for that question. If this bench ever goes green on a
// rewritten checker that no longer catches it, the regression is real.
//
// The negative cases matter just as much. A gate that flags true sentences is worse than no
// gate: it trains everyone to ignore the badge. Every TRUE superlative below is one this
// checker must leave alone.
//
// Run: npx tsx src/CrucibleEngine/answer/__claimcheck_bench.ts
// ============================================================================
import {
  checkClaims, splitSentences, superlativeOf, subjectOf, isDistributiveSuperlative,
  stripFailedClaims,
} from './claimCheck'

// ── Real evidence sentences retrieved for "What is the capital of Australia?" ──
const EVIDENCE = [
  'There are eight capital cities in Australia, each of which functions as the seat of government for the state or territory in which it is located.',
  'One of these, Canberra, is also the national capital.',
  'Section 125 of the Constitution of Australia specified that the seat of the national government, that is, the national capital, would be in its own territory within New South Wales, at least 100 miles (161 km) from Sydney.',
  'In 1927, the national capital was finally ready and the national government relocated from its former seat in Melbourne to Canberra within the Australian Capital Territory.',
  // The sentence the model borrowed the predicate from. Subject is "the capital", not Canberra.
  "In each state and internal territory, the capital is also the jurisdiction's most populous city.",
  "Canberra is the nation's capital, while its most populous cities are Sydney and Melbourne, each with a population of more than five million.",
  'Canberra is located within the Australian Capital Territory, which was excised from New South Wales in 1908.',
  'Among the states and territories of Australia, the Australian Capital Territory is the only one that is geographically landlocked.',
].join(' ')

// Verbatim live output, 2026-08-03. Shipped with verified=true and three cited sources.
const MEASURED_ANSWER =
  'The capital of Australia is Canberra. Canberra is located within the Australian Capital ' +
  'Territory (ACT), which was excised from New South Wales in 1908. It serves as the national ' +
  'capital and is the most populous city in each state and internal territory.'

interface Case {
  name: string
  answer: string
  evidence: string
  topic?: string
  /** Expected verdict of the LAST checkable claim, or 'none' when nothing is checkable. */
  want: 'supported' | 'unsupported' | 'incoherent' | 'none'
}

const CASES: Case[] = [
  // ── The measured failure ───────────────────────────────────────────────────
  { name: 'MEASURED: Canberra most-populous-in-each-state', answer: MEASURED_ANSWER, evidence: EVIDENCE, topic: 'Canberra', want: 'incoherent' },

  // Same fabrication without the distributive giveaway — must still fail, via attachment.
  { name: 'attachment: Canberra is the most populous city in Australia', evidence: EVIDENCE, topic: 'Canberra',
    answer: 'Canberra is the capital of Australia. Canberra is the most populous city in Australia.', want: 'unsupported' },

  // ── TRUE superlatives that must NOT be flagged ─────────────────────────────
  { name: 'true: ACT is the only landlocked territory', evidence: EVIDENCE, topic: 'Australian Capital Territory',
    answer: 'The Australian Capital Territory is the only one that is geographically landlocked.', want: 'supported' },
  { name: 'true: most populous cities are Sydney and Melbourne', evidence: EVIDENCE, topic: 'Canberra',
    answer: "Canberra is the nation's capital, while its most populous cities are Sydney and Melbourne.", want: 'supported' },

  // ── Nothing checkable ──────────────────────────────────────────────────────
  { name: 'no superlative at all', evidence: EVIDENCE, topic: 'Canberra',
    answer: 'The capital of Australia is Canberra. It is located in the Australian Capital Territory.', want: 'none' },
  { name: '-est false friend (latest/interest)', evidence: 'Rates are set by the central bank.', topic: 'Rates',
    answer: 'The latest figures show interest rates are stable.', want: 'none' },
  { name: 'bare quantifier "most people"', evidence: 'Opinions vary widely on the subject.', topic: 'Experts',
    answer: 'Most people agree that opinions vary widely on the subject.', want: 'none' },
]

// ── Unit checks on the pieces that carry the logic ───────────────────────────

interface Unit { name: string; got: unknown; want: unknown }
const UNITS: Unit[] = [
  { name: 'split(measured) = 3 sentences', got: splitSentences(MEASURED_ANSWER).length, want: 3 },
  { name: 'superlative(most populous city)', got: superlativeOf('It is the most populous city in each state.'), want: 'most populous' },
  { name: 'superlative(largest)', got: superlativeOf('Sydney is the largest city.'), want: 'largest' },
  { name: 'superlative(only)', got: superlativeOf('The ACT is the only landlocked territory.'), want: 'only' },
  { name: 'superlative(latest) rejected', got: superlativeOf('The latest figures are out.'), want: null },
  { name: 'superlative(interest) rejected', got: superlativeOf('We have an interest in this.'), want: null },
  // "the latest and largest" must skip past the false friend rather than give up.
  { name: 'superlative recovers after false friend', got: superlativeOf('This is the latest and largest release.'), want: 'largest' },
  { name: 'pronoun subject resolves to topic', got: subjectOf('It serves as the national capital and is the most populous city.', 'Canberra'), want: 'Canberra' },
  { name: 'named subject extracted', got: subjectOf('Canberra is the most populous city in Australia.', 'X'), want: 'Canberra' },
  { name: 'distributive fires on singular entity', got: isDistributiveSuperlative('It is the most populous city in each state and internal territory.', 'Canberra'), want: true },
  { name: 'distributive spared for plural subject', got: isDistributiveSuperlative('Capital cities are the most populous city in each state.', 'capital cities'), want: false },
  { name: 'distributive spared without each/every', got: isDistributiveSuperlative('Canberra is the most populous city in Australia.', 'Canberra'), want: false },
]

function main() {
  let pass = 0, fail = 0

  console.log('── units ──')
  for (const u of UNITS) {
    const ok = u.got === u.want
    ok ? pass++ : fail++
    if (!ok) console.log(`  FAIL ${u.name}: got ${JSON.stringify(u.got)} want ${JSON.stringify(u.want)}`)
  }
  console.log(`  ${UNITS.length - fail}/${UNITS.length} ok`)

  console.log('\n── end to end ──')
  for (const c of CASES) {
    const rep = checkClaims(c.answer, c.evidence, { topic: c.topic })
    const last = rep.claims[rep.claims.length - 1]
    const got = rep.claims.length === 0 ? 'none' : last.verdict
    const ok = got === c.want
    ok ? pass++ : fail++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} [${got}] ${c.name}`)
    if (!ok) {
      console.log(`       want ${c.want}; claims=${JSON.stringify(rep.claims.map(x => [x.subject, x.superlative, x.verdict]))}`)
    } else if (last && last.verdict !== 'supported') {
      console.log(`       -> ${last.reason}`)
    }
  }

  // ── Stripping ──────────────────────────────────────────────────────────────
  // The live model only emits the bad sentence sometimes, so the strip path cannot be proven
  // by re-running the product. It is proven here, deterministically, on the captured text.
  console.log('\n── strip ──')
  const strips: Array<{ name: string; got: boolean; why: string }> = []

  const rep = checkClaims(MEASURED_ANSWER, EVIDENCE)
  const s = stripFailedClaims(MEASURED_ANSWER, rep)
  strips.push({ name: 'removes the false sentence', got: !/most populous city in each state/i.test(s.text), why: s.text })
  strips.push({ name: 'keeps the true answer', got: /capital of Australia is Canberra/i.test(s.text), why: s.text })
  strips.push({ name: 'keeps the true ACT sentence', got: /Australian Capital Territory/i.test(s.text), why: s.text })
  strips.push({ name: 'reports what it removed', got: s.removed.length === 1, why: JSON.stringify(s.removed) })

  // Refuses to strip when the failed claim IS the whole answer — a stub is worse than an
  // honest unbadged answer, so the text must come back untouched.
  const only = 'Canberra is the most populous city in each state.'
  const onlyRep = checkClaims(only, EVIDENCE)
  const onlyStrip = stripFailedClaims(only, onlyRep)
  strips.push({ name: 'refuses to strip to nothing', got: onlyStrip.text === only && onlyStrip.removed.length === 0, why: onlyStrip.text })

  // A clean answer must pass through byte-identical.
  const clean = 'The capital of Australia is Canberra. It is located in the ACT.'
  const cleanStrip = stripFailedClaims(clean, checkClaims(clean, EVIDENCE))
  strips.push({ name: 'clean answer untouched', got: cleanStrip.text === clean, why: cleanStrip.text })

  for (const st of strips) {
    st.got ? pass++ : fail++
    console.log(`  ${st.got ? 'ok  ' : 'FAIL'} ${st.name}`)
    if (!st.got) console.log(`       ${st.why}`)
  }

  console.log(`\nCLAIMCHECK BENCH: ${pass}/${pass + fail}`)
  if (fail) process.exit(1)
}

main()

// ═══════════════════════════════════════════════════════════════════════════════
// RETRIEVAL-PROPOSER live measurement — the REAL retrieval backend, not stubs.
// Run:  npm run vgr:retrieval:live        (hits the network via retrieveForTask)
// ═══════════════════════════════════════════════════════════════════════════════
//
// __retrieval_bench.ts proves the extract→alias→certify MECHANISM with a deterministic
// `webGround`. This harness closes the honest gap flagged in the cont.75 handoff: it wires
// the proposer to the ACTUAL `retrieveForTask` (search → fetch → extract code blocks) and
// measures, per kernel, whether the internet + the verifier certify it with ZERO FM calls.
//
// It is a METRIC, not a pass/fail gate (network is nondeterministic). Track two numbers:
//   • FOUND-RATE   — retrieval returned ≥1 function definition we could extract.
//   • CERTIFY-RATE — a retrieved candidate PASSED the real execution verifier, 0 FM calls.
// The gap between them IS the cont.71b "found-a-page-but-no-code" coverage hole, now
// measured directly instead of asserted.
// ═══════════════════════════════════════════════════════════════════════════════

import { verifyCode, type CodeCase } from './codeVerifier'
import { makeRetrievalProposer, composeProposers, extractFunctions } from './retrievalProposer'
import { search } from './search'
import type { Proposer, TaskSpec } from './types'
import { retrieveForTask } from '../retrieval/retrievalLayer'

const spec = (entry: string, cases: CodeCase[]): TaskSpec =>
  ({ goal: `implement ${entry}`, domain: 'code', acceptance: { entry, cases } as unknown as Record<string, unknown> })

/**
 * Adapt the real retrieval bundle into the proposer's `webGround` shape: run the live
 * retriever, then concatenate the ranked code blocks into one source blob for extraction.
 * We join (not just take the top block) so a helper split across the primary + an adjacent
 * snippet is still reachable by extractFunctions. Returns null when nothing came back.
 */
function liveWebGround(report: (msg: string) => void): (query: string) => Promise<string | null> {
  return async (query: string) => {
    const bundle = await retrieveForTask({ goal: query }, { maxPages: 4, budget: 8000 })
    const blob = bundle.codeBlocks.map(c => c.code).join('\n\n')
    const nFns = blob ? extractFunctions(blob).length : 0
    report(`      retrieval: ${bundle.codeBlocks.length} block(s) from ${bundle.sources.length} source(s) → ${nFns} fn(s) extracted`)
    if (bundle.sources.length) report(`      sources: ${bundle.sources.slice(0, 3).join(', ')}`)
    return blob || null
  }
}

interface Kernel {
  entry: string
  /** The search query the decomposition planner would name for this kernel. */
  query: string
  cases: CodeCase[]
}

// A small suite of load-bearing kernels a weak ~3B proposer reliably thrashes on but that
// are well-covered by public reference code — exactly the RetrievalProposer's target class.
const KERNELS: Kernel[] = [
  {
    entry: 'parseClock',
    query: 'javascript convert 12 hour am pm time string to minutes since midnight',
    cases: [
      { args: ['12:00 am'], expected: 0 }, { args: ['1:30 am'], expected: 90 },
      { args: ['12:00 pm'], expected: 720 }, { args: ['1:30 pm'], expected: 810 },
      { args: ['11:59 pm'], expected: 1439 },
    ],
  },
  {
    entry: 'slugify',
    query: 'javascript slugify string to url slug lowercase hyphen remove punctuation',
    cases: [
      { args: ['Hello World'], expected: 'hello-world' },
      { args: ['  Foo   Bar!  '], expected: 'foo-bar' },
      { args: ['Rock & Roll'], expected: 'rock-roll' },
    ],
  },
  {
    entry: 'hexToRgb',
    query: 'javascript convert hex color code to rgb array',
    cases: [
      { args: ['#ffffff'], expected: [255, 255, 255] },
      { args: ['#000000'], expected: [0, 0, 0] },
      { args: ['#ff0000'], expected: [255, 0, 0] },
    ],
  },
]

async function main() {
  console.log('\nRETRIEVAL-PROPOSER live measurement — real retrieveForTask + real verifier\n')
  const lines: string[] = []
  const report = (m: string) => { console.log(m); lines.push(m) }

  let found = 0, certified = 0
  const webGround = liveWebGround(report)

  for (const k of KERNELS) {
    console.log(`  ── ${k.entry}  «${k.query}»`)
    // Track whether retrieval yielded anything extractable (found-rate), separate from
    // whether it certified (certify-rate) — the delta is the extraction coverage gap.
    let sawFns = false
    const wrapped = async (query: string) => {
      const blob = await webGround(query)
      if (blob && extractFunctions(blob).length) sawFns = true
      return blob
    }
    // A control FM that always fails: if the run certifies, it was retrieval, not the FM.
    let fmCalls = 0
    const deadFm: Proposer<string> = async () => {
      fmCalls++
      return { value: `export function ${k.entry}(){ return null }`, fingerprint: `dead${fmCalls}` }
    }
    const retrieval = makeRetrievalProposer({ entry: k.entry, goal: k.query, query: k.query, webGround: wrapped, wantArity: 1 })

    let status = 'error'
    try {
      const r = await search(spec(k.entry, k.cases), composeProposers(retrieval, deadFm), verifyCode, { maxModelCalls: 8 })
      status = r.status
      if (sawFns) found++
      if (r.status === 'solved' && fmCalls === 0) {
        certified++
        report(`      ✓ CERTIFIED from retrieval, 0 FM calls`)
      } else {
        report(`      ✗ not certified from retrieval (status=${r.status}, fmCalls=${fmCalls})`)
      }
    } catch (e: any) {
      report(`      ! run error: ${String(e?.message ?? e)}`)
    }
    console.log('')
  }

  console.log('  ─────────────────────────────────────────────')
  console.log(`  FOUND-RATE    ${found}/${KERNELS.length}  (retrieval yielded extractable code)`)
  console.log(`  CERTIFY-RATE  ${certified}/${KERNELS.length}  (certified from the internet, 0 FM calls)`)
  console.log(`  extraction gap: ${found - certified} kernel(s) had code but none certified\n`)
}

main().catch(e => { console.error(e); process.exit(1) })

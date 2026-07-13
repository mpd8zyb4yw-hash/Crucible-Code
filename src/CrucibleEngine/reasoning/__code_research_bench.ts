// ═══════════════════════════════════════════════════════════════════════════════
// CODE-RESEARCH bench — proves the code-domain ResearchFn + iterateCodeTask.
// Run:  npm run vgr:coderesearch
// ═══════════════════════════════════════════════════════════════════════════════
//
// No live FM. Channel-1 (proposer grounding) is driven by a deterministic proposer
// over the REAL execution verifier (verifyCode), so we prove the whole convergence
// loop end-to-end. Channel-2 (sound verifier-tightening) is driven by an INJECTED
// deterministic impl sampler, so differential consensus is exercised without a model.
//
//   1. MERGE          — mergeCodeAcceptance unions by (entry,args); existing wins.
//   2. CH1-GROUNDING  — research distils the best failure into proposer context, and
//                       returns null when there is nothing NEW (no false progress).
//   3. CH2-TIGHTEN    — research derives fresh differential-consensus cases and never
//                       re-adds a case already in the spec.
//   4. END-TO-END     — iterateCodeTask solves a task the proposer only gets right once
//                       channel-1 carries the prior epoch's counterexample forward.
// ═══════════════════════════════════════════════════════════════════════════════

import type { CodeCase } from './codeVerifier'
import { makeCodeResearchFn, mergeCodeAcceptance, WEB_GROUND_MARK } from './codeResearch'
import type { ImplSample } from './differentialSpec'
import type { ResearchInput } from './iterate'
import { iterateCodeTask } from './solve'
import type { Attempt, Candidate, Proposer } from './types'

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

const acc = (entry: string, cases: CodeCase[]) =>
  ({ entry, cases }) as unknown as Record<string, unknown>

function fakeClock(step: number) { let t = 0; return () => (t += step) }

async function main() {
  console.log('\nCODE-RESEARCH bench — code-domain ResearchFn + iterateCodeTask\n')

  // ── 1. mergeCodeAcceptance: union by (entry,args), existing value wins a collision. ──
  {
    const current = acc('double', [{ args: [1], expected: 2 }, { args: [2], expected: 4 }])
    const incoming = { cases: [
      { args: [2], expected: 999 },   // collision on args [2] — must be IGNORED (existing wins)
      { args: [3], expected: 6 },     // new — must be added
    ] } as unknown as Record<string, unknown>
    const merged = mergeCodeAcceptance(current, incoming) as any
    const c2 = merged.cases.find((c: CodeCase) => JSON.stringify(c.args) === '[2]')
    const c3 = merged.cases.find((c: CodeCase) => JSON.stringify(c.args) === '[3]')
    check('1 merge keeps existing value on collision', c2?.expected === 4, JSON.stringify(c2))
    check('1 merge adds the genuinely new case', c3?.expected === 6, JSON.stringify(c3))
    check('1 merge does not duplicate', merged.cases.length === 3, `len=${merged.cases.length}`)
  }

  // ── 2. Channel 1: distil best-failure signals into proposer context; null when stale. ──
  {
    const research = makeCodeResearchFn({ nl: 'double a number', differential: false })
    const best: Attempt<string> = {
      candidate: { value: 'x', fingerprint: 'x' },
      verdict: { pass: false, score: -1, signals: ['case double #0 → got 5, expected 6'] },
    }
    const base: ResearchInput<string> = {
      spec: { goal: 'double', domain: 'code', acceptance: acc('double', [{ args: [3], expected: 6 }]) },
      best, epoch: 1, priorContext: [],
    }
    const first = await research(base)
    check('2 channel-1 injects a counterexample-grounded context',
      !!first?.context && first.context.includes('expected 6'), JSON.stringify(first))
    // Same grounding already in priorContext → nothing new → null (no manufactured progress).
    const stale = await research({ ...base, priorContext: [first!.context!] })
    check('2 returns null when the grounding is already known', stale === null, JSON.stringify(stale))
  }

  // ── 3. Channel 2: differential consensus (injected sampler) tightens the verifier. ──
  {
    // Two DISTINCT correct impls of double → they agree on every fuzzed input.
    const impls: ImplSample[] = [
      { source: 'export function double(n){ return n * 2 }', fingerprint: 'a' },
      { source: 'export function double(n){ return n + n }', fingerprint: 'b' },
    ]
    const sampleImpls = async () => impls
    const research = makeCodeResearchFn({
      nl: 'double a number', differential: { sampleImpls, minCases: 3, samples: 3 },
    })
    const thin = acc('double', [{ args: [0], expected: 0 }])   // args [0] already present
    const out = await research({
      spec: { goal: 'double', domain: 'code', acceptance: thin },
      best: null, epoch: 1, priorContext: [],
    })
    const newCases = (out?.acceptance as any)?.cases as CodeCase[] | undefined
    check('3 channel-2 derives fresh differential cases', !!newCases && newCases.length > 0, JSON.stringify(out?.note))
    check('3 channel-2 never re-adds an existing case',
      !!newCases && !newCases.some(c => JSON.stringify(c.args) === '[0]'), JSON.stringify(newCases?.map(c => c.args)))
    // Every derived case must actually satisfy double (consensus ground truth is correct).
    check('3 derived cases are the true doubling relation',
      !!newCases && newCases.every(c => c.expected === (c.args[0] as number) * 2),
      JSON.stringify(newCases))
  }

  // ── 3b. Channel 3: WEB grounding folds a reference snippet into proposer context. ──
  {
    let calls = 0
    const webGround = async () => { calls++; return 'export function double(n){ return n * 2 } // from stackoverflow' }
    const research = makeCodeResearchFn({ nl: 'double a number', differential: false, webGround })
    const base: ResearchInput<string> = {
      spec: { goal: 'double', domain: 'code', acceptance: acc('double', [{ args: [3], expected: 6 }]) },
      best: null, epoch: 1, priorContext: [],
    }
    const out = await research(base)
    check('3b channel-3 folds a web snippet (marked as a reference) into context',
      !!out?.context && out.context.startsWith(WEB_GROUND_MARK) && out.context.includes('n * 2'), JSON.stringify(out?.note))
    // A later stall must NOT re-hit the network — the marker in priorContext blocks the re-fetch.
    const again = await research({ ...base, priorContext: [out!.context!] })
    check('3b channel-3 fires at most once (marker blocks a re-fetch)', again === null && calls === 1, `calls=${calls}`)
    // A throwing retriever is best-effort: the loop is never broken, just no web context.
    const boom = makeCodeResearchFn({ nl: 'double', differential: false, webGround: async () => { throw new Error('offline') } })
    const safe = await boom(base)
    check('3b a throwing web retriever never breaks the loop', safe === null, JSON.stringify(safe))
  }

  // ── 4. END-TO-END: proposer emits WRONG code until channel-1 carries the prior epoch's ──
  //     counterexample into context; then it emits the right code and the REAL verifier
  //     certifies it. A single search() (empty history each try) would never converge here.
  {
    const proposer: Proposer<string> = async (ctx) => {
      const informed = (ctx.spec.context ?? '').includes('expected 6')
      const code = informed
        ? 'export function double(n){ return n * 2 }'
        : 'export function double(n){ return n + 2 }'   // passes nothing here (3→5, 5→7)
      return { value: code, fingerprint: informed ? 'right' : 'wrong' } as Candidate<string>
    }
    const research = makeCodeResearchFn({ nl: 'double a number', differential: false })
    const r = await iterateCodeTask(
      { goal: 'double a number', nl: 'double a number', entry: 'double',
        cases: [{ args: [3], expected: 6 }, { args: [5], expected: 10 }] },
      { research, baseModelCalls: 3, now: fakeClock(1) },
      proposer,
    )
    check('4 iterateCodeTask converges via channel-1 grounding',
      r.status === 'solved' && /return n \* 2/.test(r.solution?.value ?? ''), JSON.stringify({ s: r.status, e: r.epochs }))
    check('4 it needed research to get there', r.trace.some(t => t.researched), JSON.stringify(r.trace.map(t => t.researched)))
    check('4 it took more than one epoch', r.epochs > 1, `epochs=${r.epochs}`)
  }

  // ── 5. END-TO-END (the point of the feature): the proposer CANNOT solve until WEB grounding ──
  //     supplies the reference approach; the loop stalls, fetches, then the informed proposal is
  //     EXECUTED and certified. This is "use the internet to fill the gap", staying doctrine-sound
  //     (the web only informs the proposer; the verifier still decides).
  {
    const proposer: Proposer<string> = async (ctx) => {
      const informed = (ctx.spec.context ?? '').includes('n % 2')
      const code = informed
        ? 'export function evensOnly(a){ return a.filter(n => n % 2 === 0) }'
        : 'export function evensOnly(a){ return a }'   // wrong until the web reveals the filter
      return { value: code, fingerprint: informed ? 'right' : 'wrong' } as Candidate<string>
    }
    const webGround = async () => 'To keep even numbers: arr.filter(n => n % 2 === 0)  // reference'
    const research = makeCodeResearchFn({ nl: 'keep only even numbers', differential: false, webGround })
    const r = await iterateCodeTask(
      { goal: 'keep only even numbers from an array', nl: 'keep only even numbers', entry: 'evensOnly',
        cases: [{ args: [[1, 2, 3, 4]], expected: [2, 4] }, { args: [[5, 6]], expected: [6] }] },
      { research, baseModelCalls: 3, now: fakeClock(1) },
      proposer,
    )
    check('5 WEB grounding unlocks a solve the proposer could not reach alone',
      r.status === 'solved' && /filter/.test(r.solution?.value ?? ''), JSON.stringify({ s: r.status, e: r.epochs }))
    check('5 the certified solution still PASSES the real execution verifier (web only informed)',
      r.status === 'solved', JSON.stringify(r.detail))
  }

  console.log(`\n${pass}/${pass + fail} passed\n`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })

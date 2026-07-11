// Deterministic bench for iterateWordProblem — proves the answer-domain convergence loop with
// INJECTED completers (no live FM). Each completer is a scripted setup-proposer whose behaviour
// we control per call, so we can force splits, dominant-cluster emergence, genuine ambiguity,
// and budget exhaustion, and assert the loop's contract (pure add, sound quorum, honest abstain).
//   npx tsx src/CrucibleEngine/answer/__wordproblem_iterate_bench.ts
import { iterateWordProblem, recomputeWordProblem, type Completer } from './wordProblem'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}
const json = (expr: string, unit = '') => JSON.stringify({ expression: expr, unit })

// A completer driven by a fixed script of expressions, cycling. Counts calls.
function scripted(seq: string[]): Completer & { calls: () => number } {
  let i = 0
  const fn = (async () => json(seq[i++ % seq.length])) as Completer & { calls: () => number }
  fn.calls = () => i
  return fn
}
// A completer that returns `wrong` for the first `nBad` calls, then `right` forever. Models a
// distribution where the correct setup dominates but the first draw was unlucky.
function unluckyThenDominant(wrong: string, right: string, nBad: number): Completer {
  let i = 0
  return (async () => json(i++ < nBad ? wrong : right)) as Completer
}
// Emits each DISTINCT wrong setup once (so no early quorum forms), then the correct one forever.
// Forces a genuine epoch-0 split that only a later epoch can resolve.
function distinctThenDominant(wrongs: string[], right: string): Completer {
  let i = 0
  return (async () => json(i < wrongs.length ? wrongs[i++] : (i++, right))) as Completer
}

async function main() {
  console.log('== single-shot abstains where convergence should rescue ==')
  {
    // 3 draws: split 60*2 / 60*2.5 / 60+2.5 → no majority → single-shot abstains.
    const split = () => scripted(['60*2', '60*2.5', '60+2.5'])
    const ss = await recomputeWordProblem('x', { samples: 3, complete: split() })
    check('recomputeWordProblem abstains on a 1-1-1 split', ss === null, JSON.stringify(ss))

    // Epoch 0 draws three DISTINCT setups (60+2.5, 60-2.5, 60*2.5) → no quorum → single-shot
    // would abstain here. Epoch 1 onward the correct setup (60*2.5=150) dominates; iterate
    // accumulates and reaches quorum — the answer is EARNED by convergence.
    const conv = await iterateWordProblem('x', {
      complete: distinctThenDominant(['60+2.5', '60-2.5'], '60*2.5'),
      batchSize: 3, maxEpochs: 4, maxSamples: 12,
    })
    check('iterateWordProblem converges to 150', conv.recomputation?.value === 150, JSON.stringify(conv))
    check('convergence flagged as EARNED (epoch>0)', !!conv.converged, JSON.stringify(conv.converged))
    check('detail names the converged value', /150/.test(conv.detail), conv.detail)
  }

  console.log('== quorum is a real majority of the evaluable pool ==')
  {
    const conv = await iterateWordProblem('x', {
      complete: unluckyThenDominant('1+0', '2+0', 1),
      batchSize: 3, maxEpochs: 5, maxSamples: 15,
    })
    check('certified value has strict-majority support', conv.recomputation !== null &&
      conv.recomputation!.agreement > 0.5, JSON.stringify(conv.recomputation))
    check('certified value is the dominant one (2)', conv.recomputation?.value === 2, JSON.stringify(conv.recomputation))
  }

  console.log('== genuine 50/50 ambiguity → honest abstain, never a coin-flip ==')
  {
    // Alternating two distinct setups forever: no majority ever forms.
    const conv = await iterateWordProblem('x', {
      complete: scripted(['10*10', '10+10']),
      batchSize: 2, maxEpochs: 6, maxSamples: 12,
    })
    check('abstains on true ambiguity', conv.recomputation === null, JSON.stringify(conv.recomputation))
    check('abstain detail explains disagreement', /disagree|no quorum/.test(conv.detail), conv.detail)
  }

  console.log('== reality budget: never draws past maxSamples ==')
  {
    const c = scripted(['1', '2', '3', '4', '5'])
    const conv = await iterateWordProblem('x', { complete: c, batchSize: 3, maxEpochs: 99, maxSamples: 6 })
    check('total samples capped at maxSamples', conv.samples <= 6, `samples=${conv.samples}`)
    check('model not called past the cap', c.calls() <= 6, `calls=${c.calls()}`)
    check('all-distinct setups → abstain', conv.recomputation === null, JSON.stringify(conv.recomputation))
  }

  console.log('== pure ADD: an immediate quorum solves in epoch 0 with no convergence flag ==')
  {
    const conv = await iterateWordProblem('x', {
      complete: scripted(['7*8', '7*8', '7*8']),
      batchSize: 3, maxEpochs: 4, maxSamples: 12,
    })
    check('epoch-0 quorum solves to 56', conv.recomputation?.value === 56, JSON.stringify(conv.recomputation))
    check('no converged flag when single-shot would have solved', conv.converged === undefined, JSON.stringify(conv.converged))
    check('epochs === 1 on immediate solve', conv.epochs === 1, `epochs=${conv.epochs}`)
  }

  console.log('== abort signal halts the loop ==')
  {
    const ctrl = new AbortController(); ctrl.abort()
    const conv = await iterateWordProblem('x', { complete: scripted(['1', '2']), signal: ctrl.signal })
    check('aborted before any draw → abstain, 0 samples', conv.recomputation === null && conv.samples === 0, JSON.stringify(conv))
  }

  console.log(`\n${pass}/${pass + fail} checks passed`)
  if (fail) process.exit(1)
}
main().catch(e => { console.error(e); process.exit(1) })

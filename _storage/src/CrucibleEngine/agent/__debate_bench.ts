// Pure, offline bench for the council-debate ensemble (agent/debate.ts). No model calls,
// no network — peers are scripted callables, so every debate path is deterministic.
// Run: npx tsx src/CrucibleEngine/agent/__debate_bench.ts  (npm run debate:bench)
import { runDebate, type DebatePeer } from './debate'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

/** Scripted peer: answers[0] on the propose call, answers[1] on the rebuttal, etc. */
function scripted(modelId: string, answers: Array<string | Error>, calls?: string[]): DebatePeer {
  let i = 0
  return {
    modelId,
    modelLabel: modelId,
    call: async (_system, user) => {
      calls?.push(`${modelId}#${i}:${user.slice(0, 30)}`)
      const a = answers[Math.min(i++, answers.length - 1)]
      if (a instanceof Error) throw a
      return a
    },
  }
}

const Q = 'What is the capital of France and roughly how many people live there?'

async function main() {
  console.log('== unanimous blind agreement: early exit, no rebuttal round ==')
  {
    const calls: string[] = []
    const r = await runDebate([
      scripted('alpha', ['The capital of France is Paris, with about 2100000 residents in the city proper.'], calls),
      scripted('beta', ['Paris is the capital of France; the city proper has roughly 2100000 people.'], calls),
    ], '', Q)
    check('returns a verdict', !!r)
    check('single round only (propose)', r!.rounds.length === 1 && r!.rounds[0].kind === 'propose', String(r!.rounds.length))
    check('one call per peer (no rebuttal inference)', calls.length === 2, String(calls.length))
    check('method is consensus-vote', r!.method === 'consensus-vote', r!.method)
    check('agreement unanimous', r!.agreement === 'unanimous', r!.agreement)
    check('both peers contribute', r!.contributors.length === 2)
    check('no minds changed', r!.mindsChanged === false)
  }

  console.log('== hallucinating peer corrected by cross-examination ==')
  {
    const r = await runDebate([
      scripted('alpha', [
        'The capital of France is Paris, home to about 2100000 people in the city proper.',
        'The capital of France is Paris, home to about 2100000 people in the city proper.',
      ]),
      scripted('beta', [
        'The capital of France is Marseille, with around 900000 residents living there today.',
        'Correction: the capital of France is Paris, with about 2100000 people in the city proper.',
      ]),
    ], '', Q)
    check('rebuttal round ran', r!.rounds.length === 2 && r!.rounds[1].kind === 'rebut')
    check('debate changed a mind', r!.mindsChanged === true)
    check('converged to consensus', r!.method === 'consensus-vote', r!.method)
    check('final answer names Paris', /Paris/.test(r!.text), r!.text.slice(0, 60))
    check('agreement unanimous after revision', r!.agreement === 'unanimous', r!.agreement)
  }

  console.log('== persistent disagreement: honest low confidence, no fake consensus ==')
  {
    const r = await runDebate([
      scripted('alpha', [
        'The answer is 42 because the sequence doubles every step from the seed value.',
        'The answer is 42 because the sequence doubles every step from the seed value.',
      ]),
      scripted('beta', [
        'The answer is 17 because the sequence adds five each step from the seed value.',
        'The answer is 17 because the sequence adds five each step from the seed value.',
      ]),
    ], '', 'What is the next number in the sequence?')
    check('method is plurality-fallback', r!.method === 'plurality-fallback', r!.method)
    check('confidence capped low', r!.confidence <= 0.6, String(r!.confidence))
    check('agreement contested', r!.agreement === 'contested', r!.agreement)
    check('single contributor only', r!.contributors.length === 1)
  }

  console.log('== arithmetic oracle overrides the vote ==')
  {
    const r = await runDebate([
      scripted('alpha', ['47 * 53 = 2591, so you would need 2591 tiles for the floor.']),
      scripted('beta', ['47 * 53 = 2491, so you would need 2491 tiles for the floor.']),
    ], '', 'How many tiles?')
    check('method is oracle-arithmetic', r!.method === 'oracle-arithmetic', r!.method)
    check('final text carries the machine-computed product', /2491/.test(r!.text) && !/2591/.test(r!.text), r!.text.slice(0, 60))
  }

  console.log('== one peer errors: solo degradation, honest solo label ==')
  {
    const r = await runDebate([
      scripted('alpha', ['Paris is the capital of France, with about 2100000 city-proper residents.']),
      scripted('beta', [new Error('model exploded')]),
    ], '', Q)
    check('verdict still returned', !!r)
    check('method single-model', r!.method === 'single-model', r!.method)
    check('agreement solo', r!.agreement === 'solo', r!.agreement)
  }

  console.log('== all peers error: null, caller falls back ==')
  {
    const r = await runDebate([
      scripted('alpha', [new Error('down')]),
      scripted('beta', [new Error('down')]),
    ], '', Q)
    check('returns null', r === null)
  }

  console.log('== seeded proposal is not re-asked but still rebuts ==')
  {
    const calls: string[] = []
    const seededPeer = scripted('alpha', [
      // First actual call this peer receives is the REBUTTAL (proposal was seeded).
      'On reflection the capital of France is Paris with roughly 2100000 city residents.',
    ], calls)
    const r = await runDebate([
      seededPeer,
      scripted('beta', [
        'The capital of France is Lyon, with about 500000 people living in the city.',
        'The capital of France is Lyon, with about 500000 people living in the city.',
      ], calls),
    ], '', Q, {
      seedProposals: [{ modelId: 'alpha', modelLabel: 'alpha', text: 'The capital of France is Paris, home to roughly 2100000 city-proper residents.' }],
    })
    check('alpha called exactly once (rebuttal only)', calls.filter(c => c.startsWith('alpha')).length === 1, calls.join(' | '))
    check('rebuttal round ran (disagreement)', r!.rounds.length === 2)
    check('seed text appears in propose round', /Paris, home to roughly/.test(r!.rounds[0].entries.find(e => e.modelId === 'alpha')!.text))
  }

  console.log('== errored rebuttal keeps the round-1 position ==')
  {
    const r = await runDebate([
      scripted('alpha', [
        'Paris is the capital of France, with about 2100000 residents in the city proper.',
        new Error('rebuttal crashed'),
      ]),
      scripted('beta', [
        'The capital of France is Toulouse, home to nearly 480000 people in the city.',
        'The capital of France is Toulouse, home to nearly 480000 people in the city.',
      ]),
    ], '', Q)
    const alphaFinal = r!.rounds[1].entries.find(e => e.modelId === 'alpha')!
    check('alpha final position is its proposal', /Paris/.test(alphaFinal.text), alphaFinal.text.slice(0, 50))
    check('alpha not marked as changed', alphaFinal.changedPosition === false)
  }

  console.log('== three-peer majority: 2v1 after rebuttal ==')
  {
    const r = await runDebate([
      scripted('alpha', [
        'Paris is the capital of France, with roughly 2100000 people in the city proper.',
        'Paris is the capital of France, with roughly 2100000 people in the city proper.',
      ]),
      scripted('beta', [
        'The capital of France is Paris; city-proper population is roughly 2100000 people.',
        'The capital of France is Paris; city-proper population is roughly 2100000 people.',
      ]),
      scripted('gamma', [
        'France moved its capital to Versailles, population about 85000 people these days.',
        'France moved its capital to Versailles, population about 85000 people these days.',
      ]),
    ], '', Q)
    check('method consensus-vote', r!.method === 'consensus-vote', r!.method)
    check('agreement majority', r!.agreement === 'majority', r!.agreement)
    check('two contributors', r!.contributors.length === 2, String(r!.contributors.length))
    check('holdout excluded', !r!.contributors.includes('gamma'))
  }

  console.log('== hung peer times out instead of blocking the council ==')
  {
    const hung: DebatePeer = { modelId: 'hung', modelLabel: 'hung', call: () => new Promise(() => {}) }
    const t0 = Date.now()
    const r = await runDebate([
      scripted('alpha', ['Paris is the capital of France, with about 2100000 city-proper residents.']),
      hung,
    ], '', Q, { timeoutMs: 300 })
    check('finished promptly', Date.now() - t0 < 5000)
    check('solo verdict from the live peer', r!.agreement === 'solo', r!.agreement)
    check('hung peer marked errored in transcript', r!.rounds[0].entries.find(e => e.modelId === 'hung')!.errored === true)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()

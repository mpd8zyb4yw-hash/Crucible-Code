// DONE-WHEN (W42, GAP_CLOSURE_ADDENDUM.md): every extended-corpus task is proven sound
// BEFORE it is allowed to measure anything — its reference solution certifies against its
// own hidden suite through the REAL hermetic oracle (W30: deterministic double-run,
// offline, secret-free), and NO task is secretly catalog-solvable (else the corpus
// re-inflates the retrieval headline exactly the way skills/_learned would).
//
// A bench task with a broken suite is worse than no task: it converts real capability
// into measured failure (or worse, the reverse) and the error persists in every future
// run. This file is the corpus's own verifier — the doctrine's propose→verify applied to
// the benchmark itself.
//
// Also syncs each suite to coding-bench/<id>.hidden.ts — the exact path the live harness
// reads — and self-tests benchStats so the noise-floor math itself is checked.
//
// Deterministic, model-free. Run: npx tsx src/CrucibleEngine/coding-bench-ext/__taskcorpus_bench.ts
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { EXT_TASKS } from './index'
import { synthesize } from '../synth'
import { verifyCandidate } from '../synth/oracle'
import { wilson, minDetectableDelta, formatRate, isSignificant } from '../benchStats'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HIDDEN_DIR = path.resolve(HERE, '../coding-bench')

let failures = 0
const check = (label: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${cond ? '' : ' :: ' + detail.slice(0, 260)}`)
  if (!cond) failures++
}

// ── benchStats self-test: the ruler is checked before anything is measured ──
{
  const iv = wilson(4, 10)
  check('wilson(4,10) brackets the point estimate', iv.lo < 0.4 && 0.4 < iv.hi, JSON.stringify(iv))
  check('wilson tightens with n', minDetectableDelta(100) < minDetectableDelta(33) && minDetectableDelta(33) < minDetectableDelta(10))
  check('wilson 0/10 lower bound is 0 but upper is honest', wilson(0, 10).lo === 0 && wilson(0, 10).hi > 0.2)
  check('wilson 10/10 upper bound reaches 1 but lower is honest', wilson(10, 10).hi > 0.999 && wilson(10, 10).lo < 0.8)
  check('formatRate carries the interval', /CI \d+%–\d+%/.test(formatRate(4, 10)), formatRate(4, 10))
  check('overlapping intervals are not significant', !isSignificant(4, 10, 6, 10))
  check('disjoint intervals are significant', isSignificant(1, 40, 30, 40))
}

// ── corpus-wide hygiene ─────────────────────────────────────────────────────
{
  const ids = EXT_TASKS.map(t => t.id)
  check('task ids are unique', new Set(ids).size === ids.length)
  const existing = fs.readdirSync(HIDDEN_DIR).filter(f => f.endsWith('.hidden.ts')).map(f => f.replace('.hidden.ts', ''))
  const preexisting = new Set(existing.filter(id => !ids.includes(id)))
  check('no id collides with a pre-existing bench task', ids.every(id => !preexisting.has(id) || fs.readFileSync(path.join(HIDDEN_DIR, id + '.hidden.ts'), 'utf8').includes('Extended corpus')), ids.filter(id => preexisting.has(id)).join(','))
  check('corpus size is 22', EXT_TASKS.length === 22, String(EXT_TASKS.length))
}

// ── per-task certification ──────────────────────────────────────────────────
let catalogFree = 0
let certified = 0
for (const task of EXT_TASKS) {
  const name = task.modulePath.replace(/^src\//, '').replace(/\.ts$/, '')

  // 1. Spec hygiene: the prompt must be a mechanical contract.
  const promptOk = task.prompt.includes(task.modulePath) && /export (function|class|interface|type)/.test(task.prompt)
  check(`${task.id}: prompt names path and exact API`, promptOk)

  // 2. Suite hygiene: enough teeth to mean something, and it imports the right module.
  const assertions = (task.suite.match(/check\(/g) ?? []).length
  check(`${task.id}: suite has >= 10 assertions`, assertions >= 10, String(assertions))
  check(`${task.id}: suite imports ../src/${name}`, task.suite.includes(`'../src/${name}'`))

  // 3. Catalog freedom: this task must exercise GENERATION, not retrieval. The floor
  //    mirrors synthesize()'s default (0.5) — a match above it means the live path would
  //    answer from the catalog and the task would measure the wrong thing.
  const match = synthesize(task.prompt)
  const top = match.ranking[0]
  const free = match.matched === null
  if (free) catalogFree++
  check(`${task.id}: not catalog-solvable`, free, `matched=${match.matched?.id} conf=${match.confidence.toFixed(2)} top=${top?.id}:${top?.score.toFixed(2)}`)

  // 4. Suite sync to the live harness location (generated header marks provenance).
  const suitePath = path.join(HIDDEN_DIR, `${task.id}.hidden.ts`)
  const content = `// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.\n${task.suite}`
  const current = fs.existsSync(suitePath) ? fs.readFileSync(suitePath, 'utf8') : null
  if (current !== content) fs.writeFileSync(suitePath, content)
  check(`${task.id}: suite synced to coding-bench/`, fs.readFileSync(suitePath, 'utf8') === content)

  // 5. The load-bearing one: the reference certifies against its own hidden suite through
  //    the REAL oracle — Gate A tsc, lint, then hermetic double-run Gate B (W30). A task
  //    whose reference cannot certify must never be allowed to judge the agent.
  const verdict = verifyCandidate(
    [{ path: task.modulePath, content: task.ref }],
    { path: `__audit__/${task.id}.hidden.ts`, content: task.suite },
  )
  if (verdict.accepted) certified++
  check(`${task.id}: reference certifies through the hermetic oracle`, verdict.accepted, verdict.detail)
}

// ── the honest summary ──────────────────────────────────────────────────────
{
  const nOld = 10
  const nNew = nOld + EXT_TASKS.length
  console.log('')
  console.log(`corpus: ${EXT_TASKS.length} tasks, ${catalogFree} catalog-free, ${certified} reference-certified`)
  console.log(`generated-path bench: n=${nOld} -> n=${nNew}`)
  const pts = (x: number) => `±${Math.round(x * 100)}pts`
  console.log(`95% noise floor at ~50% pass rate: n=10 ${pts(minDetectableDelta(10))} | n=14 ${pts(minDetectableDelta(14))} | n=${nNew} ${pts(minDetectableDelta(nNew))} | n=100 ${pts(minDetectableDelta(100))}`)
  console.log('rule: a before/after delta smaller than the floor at the CURRENT n is noise, not progress.')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

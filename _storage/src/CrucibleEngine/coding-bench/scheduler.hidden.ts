// HIDDEN adversarial audit suite — topological-sort task scheduler with cycle detection.
// Run via `npx tsx __audit__/scheduler.hidden.ts` inside the scratch project.
import { topoSort, findCycle } from '../src/scheduler'

let failures = 0
function check(name: string, cond: boolean) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} — ${name}`)
  if (!cond) failures++
}

// edge [a, b] means "a must run before b".
// ── Valid DAG: a→b, a→c, b→d, c→d (a diamond) ───────────────────────────────────
const order = topoSort(['a', 'b', 'c', 'd'], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']])
const pos = (x: string) => order.indexOf(x)
check('topoSort returns every node exactly once',
  order.length === 4 && ['a', 'b', 'c', 'd'].every(n => order.includes(n)))
check('respects a-before-b and a-before-c', pos('a') < pos('b') && pos('a') < pos('c'))
check('respects b-before-d and c-before-d', pos('b') < pos('d') && pos('c') < pos('d'))

// ── Disconnected node must still appear ─────────────────────────────────────────
const o2 = topoSort(['x', 'y', 'z'], [['x', 'y']])
check('a node with no edges is still included in the order', o2.length === 3 && o2.includes('z'))

// ── Cycle detection ─────────────────────────────────────────────────────────────
let threw = false
try { topoSort(['a', 'b'], [['a', 'b'], ['b', 'a']]) } catch { threw = true }
check('topoSort throws on a 2-node cycle', threw)

const cyc = findCycle(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']])
check('findCycle returns a non-empty path for a 3-node cycle', Array.isArray(cyc) && cyc.length > 0)
check('findCycle returns null for an acyclic graph', findCycle(['a', 'b'], [['a', 'b']]) === null)
check('findCycle detects a self-loop', !!findCycle(['a'], [['a', 'a']]))

console.log(`\n  ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)

// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — minStack.
// Run: npx tsx __audit__/minStack.hidden.ts   (imports ../src/minStack)
import { MinStack } from '../src/minStack'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

const s = new MinStack()
s.push(5); s.push(3); s.push(7)
check('top is last pushed', s.top() === 7)
check('min through stack', s.min() === 3)
check('pop returns last', s.pop() === 7)
check('min unchanged after popping non-min', s.min() === 3)
s.pop()
check('min recovers after popping the min', s.min() === 5)
s.push(5); s.push(5)
check('duplicate minimum both counted', s.min() === 5)
s.pop()
check('one duplicate popped, min stays', s.min() === 5)
check('size tracks', s.size === 2)
const neg = new MinStack()
neg.push(-1); neg.push(-10)
check('negative values', neg.min() === -10)
neg.pop()
check('negative min recovers', neg.min() === -1)
const big = new MinStack()
for (let i = 0; i < 200000; i++) big.push((i * 7919) % 100000)
let sink = 0
for (let i = 0; i < 200000; i++) { sink += big.min(); big.pop() }
check('large interleaved min/pop completes (O(1) min)', sink !== -1 && big.size === 0)
let threw = false
try { new MinStack().pop() } catch { threw = true }
check('pop empty throws', threw)
let threwMin = false
try { new MinStack().min() } catch { threwMin = true }
check('min empty throws', threwMin)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)

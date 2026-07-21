// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — ringBuffer.
// Run: npx tsx __audit__/ringBuffer.hidden.ts   (imports ../src/ringBuffer)
import { RingBuffer } from '../src/ringBuffer'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

const rb = new RingBuffer<number>(3)
check('starts empty', rb.size === 0 && rb.capacity === 3)
rb.push(1); rb.push(2)
check('size tracks pushes', rb.size === 2)
check('peek is oldest', rb.peek() === 1)
check('toArray oldest to newest', rb.toArray().join(',') === '1,2')
rb.push(3); rb.push(4)
check('overwrite drops oldest', rb.toArray().join(',') === '2,3,4')
check('size capped at capacity', rb.size === 3)
check('pop returns oldest after wrap', rb.pop() === 2)
check('pop shrinks size', rb.size === 2)
rb.push(5); rb.push(6)
check('interleaved push/pop order', rb.toArray().join(',') === '4,5,6')
check('toArray is a fresh array', (() => { const a = rb.toArray(); a.push(99); return rb.toArray().length === 3 })())
const one = new RingBuffer<string>(1)
one.push('a'); one.push('b')
check('capacity one always keeps newest', one.peek() === 'b')
let threwEmpty = false
try { new RingBuffer<number>(2).pop() } catch { threwEmpty = true }
check('pop on empty throws', threwEmpty)
let threwPeek = false
try { new RingBuffer<number>(2).peek() } catch { threwPeek = true }
check('peek on empty throws', threwPeek)
let threwCap = false
try { new RingBuffer<number>(0) } catch (e) { threwCap = e instanceof RangeError }
check('zero capacity throws RangeError', threwCap)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)

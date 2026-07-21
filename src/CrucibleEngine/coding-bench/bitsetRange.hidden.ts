// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — bitsetRange.
// Run: npx tsx __audit__/bitsetRange.hidden.ts   (imports ../src/bitsetRange)
import { BitSet } from '../src/bitsetRange'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

const b = new BitSet(100)
check('starts clear', b.get(0) === false && b.countRange(0, 100) === 0)
b.set(0); b.set(31); b.set(32); b.set(99)
check('set/get across word boundary', b.get(31) && b.get(32) && b.get(0) && b.get(99))
check('unset stays false', b.get(50) === false)
check('full-range count', b.countRange(0, 100) === 4)
check('subrange excludes end', b.countRange(0, 99) === 3)
check('subrange includes start', b.countRange(32, 100) === 2)
check('interior empty range', b.countRange(40, 60) === 0)
check('start equals end is zero', b.countRange(50, 50) === 0)
check('start beyond end is zero', b.countRange(60, 40) === 0)
b.clear(31)
check('clear works', b.get(31) === false && b.countRange(0, 100) === 3)
b.set(0)
check('double set idempotent', b.countRange(0, 1) === 1)
const big = new BitSet(100000)
for (let i = 0; i < 100000; i += 3) big.set(i)
check('large range popcount correct', big.countRange(0, 100000) === 33334)
check('large subrange popcount', big.countRange(1, 100000) === 33333)
let threwCtor = false
try { new BitSet(0) } catch (e) { threwCtor = e instanceof RangeError }
check('size 0 throws RangeError', threwCtor)
let threwIdx = false
try { b.get(100) } catch (e) { threwIdx = e instanceof RangeError }
check('index at size throws', threwIdx)
let threwNeg = false
try { b.set(-1) } catch (e) { threwNeg = e instanceof RangeError }
check('negative index throws', threwNeg)
let threwRange = false
try { b.countRange(0, 101) } catch (e) { threwRange = e instanceof RangeError }
check('range end beyond size throws', threwRange)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)

// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — runLength.
// Run: npx tsx __audit__/runLength.hidden.ts   (imports ../src/runLength)
import { rleEncode, rleDecode } from '../src/runLength'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}
const throwsSyn = (fn: () => void): boolean => {
  try { fn(); return false } catch (e) { return e instanceof SyntaxError }
}

check('basic encode', rleEncode('aaab') === 'a3b1')
check('single chars all count 1', rleEncode('abc') === 'a1b1c1')
check('long run multi-digit count', rleEncode('a'.repeat(12)) === 'a12')
check('case sensitivity', rleEncode('aA') === 'a1A1')
check('empty encodes empty', rleEncode('') === '')
check('re-run after gap counts separately', rleEncode('aabaa') === 'a2b1a2')
check('basic decode', rleDecode('a3b1') === 'aaab')
check('multi-digit decode', rleDecode('a12') === 'a'.repeat(12))
check('empty decodes empty', rleDecode('') === '')
check('round trip identity', rleDecode(rleEncode('aaBBBcDDDDe')) === 'aaBBBcDDDDe')
check('round trip on alternating', rleDecode(rleEncode('ababab')) === 'ababab')
check('encode rejects digit', throwsSyn(() => rleEncode('a1')))
check('encode rejects space', throwsSyn(() => rleEncode('a b')))
check('decode rejects zero count', throwsSyn(() => rleDecode('a0')))
check('decode rejects leading zero', throwsSyn(() => rleDecode('a01')))
check('decode rejects letter without count', throwsSyn(() => rleDecode('ab')))
check('decode rejects count without letter', throwsSyn(() => rleDecode('3a')))
check('decode rejects punctuation', throwsSyn(() => rleDecode('a3-b1')))

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)

// Extended corpus suite (W42) — generated from coding-bench-ext; edit the shard, not this file.
// HIDDEN adversarial suite for a NOVEL task (no matching primitive) — queryDecode.
// Run: npx tsx __audit__/queryDecode.hidden.ts   (imports ../src/queryDecode)
import { parseQuery } from '../src/queryDecode'

let failures = 0
function check(name: string, cond: boolean) {
  console.log((cond ? '  PASS — ' : '  FAIL — ') + name)
  if (!cond) failures++
}

const q1 = parseQuery('a=1&b=2')
check('basic pairs', q1.a === '1' && q1.b === '2')
check('leading question mark ignored', parseQuery('?x=y').x === 'y')
check('plus decodes to space', parseQuery('k=a+b').k === 'a b')
check('plus in key too', parseQuery('a+b=c')['a b'] === 'c')
check('percent decodes', parseQuery('k=%20').k === ' ')
check('multibyte utf8 sequence', parseQuery('k=%C3%A9').k === '\u00e9')
check('invalid percent left literal', parseQuery('k=%ZZx').k === '%ZZx')
check('trailing lone percent literal', parseQuery('k=ab%').k === 'ab%')
check('malformed utf8 bytes yield replacement char', parseQuery('k=%C3%28').k === '\uFFFD(')
check('dangling utf8 lead byte yields replacement char', parseQuery('k=%C3').k === '\uFFFD')
check('truncated 3-byte sequence is one replacement char', parseQuery('k=%E2%82').k === '\uFFFD')
check('raw non-ascii literal passes through', parseQuery('k=\u00e9x').k === '\u00e9x')
check('never throws on hostile percent soup', ['%', '%%', '%2', '%C3%C3', '%E2%82x', '%ZZ%C3%28+%'].every(s => {
  try { parseQuery(s); parseQuery('k=' + s); return true } catch { return false }
}))
const rep = parseQuery('a=1&a=2&a=3')
check('repeated key becomes array in order', Array.isArray(rep.a) && (rep.a as string[]).join(',') === '1,2,3')
check('no equals means empty value', parseQuery('flag').flag === '')
check('equals in value survives', parseQuery('a=b=c').a === 'b=c')
check('empty segments skipped', Object.keys(parseQuery('a=1&&b=2')).length === 2)
check('empty string gives empty object', Object.keys(parseQuery('')).length === 0)
check('just question mark gives empty object', Object.keys(parseQuery('?')).length === 0)

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')
process.exit(failures === 0 ? 0 : 1)

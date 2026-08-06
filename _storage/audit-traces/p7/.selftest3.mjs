import { execute, extraction } from './.oracle_lib.mjs'
import { readFileSync } from 'node:fs'
const CASES = [
  ['GOOD-z.ipv4',      "```ts\nimport { z } from 'zod'\nconst s = z.ipv4()\n```", true, true],
  ['GOOD-z.string.ipv4',"```ts\nimport { z } from 'zod'\nconst s = z.string().ipv4()\n```", true, true],
  ['GOOD-object-wrap', "```ts\nimport { z } from 'zod'\nconst s = z.object({ ip: z.ipv4() })\n```", true, true],
  ['BAD-t9-real',      readFileSync('../p4/t9.answer.txt','utf8'), false, false],
  ['BAD-sloppy-regex', "```js\nconst v = (ip) => /^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(ip)\n```", false, false],
  ['GOOD-handrolled',  "```js\nconst v = (ip) => { const p=String(ip).split('.'); return p.length===4 && p.every(o=>/^\\d{1,3}$/.test(o)&&+o<=255&&String(+o)===o) }\n```", true, false],
  ['PROSE-ONLY-trap',  "Use `z.ipv4()`.\n```json\n{\"$schema\":\"x\"}\n```", false, false],
]
let ok=0
for (const [n,txt,expExec,expExtract] of CASES) {
  const ex=extraction(txt), ev=execute(txt,'st3-'+n)
  const e1=ev.executesCorrectly===expExec, e2=ex.usesZIpv4===expExtract
  if(e1&&e2) ok++
  console.log(`${n.padEnd(20)} exec=${String(ev.executesCorrectly).padEnd(5)}(exp ${String(expExec).padEnd(5)}) extract=${String(ex.usesZIpv4).padEnd(5)}(exp ${String(expExtract).padEnd(5)}) ${e1&&e2?'OK':'*** WRONG ***'}`)
}
console.log(`\nORACLE SELFTEST ${ok}/${CASES.length}`)

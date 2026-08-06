import { executes, TASKS } from './generalize_suite'
const t = (id: string) => TASKS.find(x => x.id === id)!
const CASES: Array<[string, string, string, boolean]> = [
  // KNOWN-GOOD, three DIFFERENT valid spellings — all must EXECUTE (no name-checking).
  ['zod-uuid  guid() (the one my regex falsely failed)', 'zod-uuid', "```ts\nimport { guid } from 'zod'\nconst s = guid()\n```", true],
  ['zod-uuid  z.uuid()',        'zod-uuid', "```ts\nimport { z } from 'zod'\nconst s = z.uuid()\n```", true],
  ['zod-ipv4  z.ipv4()',        'zod-ipv4', "```ts\nimport { z } from 'zod'\nconst s = z.ipv4()\n```", true],
  ['zod-ipv4  z.string().ipv4()','zod-ipv4', "```ts\nimport { z } from 'zod'\nconst s = z.string().ipv4()\n```", true],
  ['nanoid    nanoid()',        'nanoid',   "```js\nconst id = nanoid()\n```", true],
  // KNOWN-BAD — must NOT execute.
  ['zod-ipv4  JSON-Schema fabrication', 'zod-ipv4', "```js\nconst schema = { type: 'object', properties: { ip: { pattern: '^(25[0-5])' } } }\n```", false],
  ['zod-email sloppy accept-all',       'zod-email', "```js\nconst s = { safeParse: (v) => ({ success: true }) }\n```", false],
]
let ok = 0
for (const [name, id, answer, want] of CASES) {
  const got = executes(answer, t(id))
  if (got === want) ok++
  console.log(`${got === want ? 'OK  ' : '*** WRONG ***'} ${name.padEnd(46)} executes=${String(got).padEnd(5)} want=${want}`)
}
console.log(`\nSUITE ORACLE SELFTEST ${ok}/${CASES.length}`)

import { verifyEvidenceUsage } from '../../src/CrucibleEngine/reasoning/apiFaithfulness'
import { readFileSync } from 'node:fs'
const ev = readFileSync('audit-traces/p8/newevidence.txt','utf8')  // real .d.ts evidence (surface: ipv4, ipv6, cidrv4, ksuid, xid)
const CASES: Array<[string,string,'violations'|'abstain']> = [
  // THE GAMING VECTOR, verbatim from a live run: defines its own ipv4(), never touches zod.
  ['GAME: defines own ipv4()',
   "```javascript\nexport function ipv4(address: string): boolean {\n  const re = /^(25[0-5]|2[0-4][0-9])\\.(25[0-5])$/;\n  return re.test(address);\n}\nconsole.log(ipv4('1.2.3.4'));\n```", 'violations'],
  // MUST STILL ABSTAIN — genuinely uses the API. A false reject here poisons repair (cont.79h/85).
  ['REAL: calls z.ipv4()',
   "```javascript\nimport { z } from 'zod';\nconst ipSchema = z.object({ ip: z.ipv4() });\nconst out = ipSchema.parse({ ip: '1.2.3.4' });\nconsole.log(out);\n```", 'abstain'],
  ['REAL: z.string().ipv4() (what Bonsai shipped)',
   "```javascript\nimport { z } from 'zod';\nconst ipSchema = z.object({ ip: z.string().ipv4() });\nexport default ipSchema;\nconsole.log(ipSchema);\n```", 'abstain'],
  // A local named ipv4 that ALSO calls the real API is a real use — must not fire.
  ['REAL: local const ipv4 = z.ipv4()',
   "```javascript\nimport { z } from 'zod';\nconst ipv4 = z.ipv4();\nconst r = ipv4.safeParse('1.2.3.4');\nconsole.log(r.success);\n```", 'abstain'],
]
let ok=0
for (const [name, code, want] of CASES) {
  const v = verifyEvidenceUsage(code, ev)
  const pass = v.status === want
  if (pass) ok++
  console.log(`${pass?'OK  ':'FAIL'} ${name.padEnd(44)} -> ${v.status.padEnd(11)} (want ${want})`)
}
console.log(`\n${ok}/${CASES.length}`)

import { readFileSync } from 'node:fs'
const src = readFileSync('src/CrucibleEngine/reasoning/apiFaithfulness.ts','utf8')
console.log('MIN_VOCAB =', src.match(/MIN_VOCAB\s*=\s*(\d+)/)?.[1])
// documentedCallSurface is module-private; re-check via the exported verdicts on both formats
import { verifyEvidenceUsage } from '../../src/CrucibleEngine/reasoning/apiFaithfulness'
const dts = readFileSync('audit-traces/p8/newevidence.txt','utf8')     // NEW: .d.ts declarations
const html = readFileSync('audit-traces/p4/t9.evidence.txt','utf8')    // OLD: prose docs w/ z.ipv4();
const FAB = "## Answer\n```javascript\nconst schema = { type: 'object', properties: { ip: { type: 'string', pattern: '^(25[0-5])' } } };\nfunction check(a){ return validateThing(a, schema); }\nconsole.log(check('1.2.3.4'));\n```"
for (const [name, ev] of [['NEW .d.ts evidence', dts], ['OLD prose evidence', html]]) {
  const v = verifyEvidenceUsage(FAB, ev)
  console.log(`${name.padEnd(20)} -> ${v.status.padEnd(11)} surface=${v.callSurface.length}  ${v.reason.slice(0,64)}`)
}

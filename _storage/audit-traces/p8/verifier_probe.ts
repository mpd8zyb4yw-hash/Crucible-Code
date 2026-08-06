import { verifyEvidenceUsage, verifyApiFaithfulness } from '../../src/CrucibleEngine/reasoning/apiFaithfulness'
import { readFileSync } from 'node:fs'
const answer = readFileSync('audit-traces/p8/e2e-run0.md','utf8')
const evidence = readFileSync('audit-traces/p8/newevidence.txt','utf8')   // the .d.ts evidence block
const u = verifyEvidenceUsage(answer, evidence)
console.log('verifyEvidenceUsage :', u.status, '|', u.reason)
const f = verifyApiFaithfulness(answer, evidence)
console.log('verifyApiFaithfulness:', f.status, '|', f.reason)
console.log('callSurface size    :', u.callSurface?.length ?? f.callSurface?.length)
console.log('surface sample      :', (u.callSurface ?? f.callSurface ?? []).slice(0,18).join(', '))

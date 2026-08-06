import { verifyApiFaithfulness } from '../../src/CrucibleEngine/reasoning/apiFaithfulness'
import { fetchLibraryApiForQuery } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
import { readFileSync } from 'node:fs'
// The CORRECT answer Bonsai produced and the executing oracle certified as working.
const CORRECT = "```javascript\nimport { z } from 'zod';\n\nconst ipSchema = z.object({\n  ip: z.string().ipv4()\n});\n\nexport default ipSchema;\n```"
async function main(){
  const selected = readFileSync('audit-traces/p8/newevidence.txt','utf8')
  const v1 = verifyApiFaithfulness(CORRECT, selected)
  console.log('vs SELECTED passage (5 APIs) :', v1.status, '|', v1.reason?.slice(0,70))
  const api = await fetchLibraryApiForQuery('Write a Zod schema that validates an IPv4 address')
  const v2 = verifyApiFaithfulness(CORRECT, api!.text)
  console.log('vs FULL .d.ts (127 APIs)     :', v2.status, '|', v2.reason?.slice(0,70))
  console.log('\n^ if the first REJECTS working code, repair can never certify and the')
  console.log('  fabricated draft ships. Same false-reject class as cont.85.')
}
main()

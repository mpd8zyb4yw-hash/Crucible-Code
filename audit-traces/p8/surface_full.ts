import { documentedCallSurface } from '../../src/CrucibleEngine/reasoning/apiFaithfulness'
import { fetchLibraryApiForQuery } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
import { readFileSync } from 'node:fs'
async function main(){
  const api = await fetchLibraryApiForQuery('Write a Zod schema that validates an IPv4 address')
  const full = documentedCallSurface(api!.text)
  console.log('FULL .d.ts (53KB)  surface =', full.length)
  console.log('  sample:', full.filter(x=>/^(ipv4|ipv6|email|uuid|cidrv4|base64|nanoid|cuid|jwt|url|string|object)$/.test(x)).join(', '))
  const sel = documentedCallSurface(readFileSync('audit-traces/p8/newevidence.txt','utf8'))
  console.log('SELECTED passage   surface =', sel.length, '->', sel.join(', '))
  console.log('\nverifier authority is capped by the EVIDENCE BUDGET, not the source.')
}
main()

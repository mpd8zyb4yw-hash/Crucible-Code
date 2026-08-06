import { fetchTypeDefs } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
import * as https from 'node:https'
function get(u:string):Promise<string>{return new Promise(r=>{https.get(u,{headers:{'User-Agent':'Crucible/1.0'}},res=>{let b='';res.setEncoding('utf8');res.on('data',c=>b+=c);res.on('end',()=>r(b))}).on('error',()=>r(''))})}
async function main(){
  console.log('--- zod typedefs (123 chars) ---')
  console.log(await fetchTypeDefs('zod'))
  console.log('\n--- zod package.json exports/types ---')
  const pj = await get('https://unpkg.com/zod/package.json')
  const j = JSON.parse(pj)
  console.log('version:', j.version, '| types:', j.types, '| main:', j.main)
  console.log('exports keys:', Object.keys(j.exports||{}).slice(0,8))
  console.log('exports["."]:', JSON.stringify(j.exports?.['.']))
}
main()

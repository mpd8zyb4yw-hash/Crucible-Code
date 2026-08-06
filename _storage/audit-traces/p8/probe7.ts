import * as https from 'node:https'
function get(u:string,d=5):Promise<string>{return new Promise(r=>{https.get(u,{headers:{'User-Agent':'Crucible/1.0'}},res=>{
  if(res.statusCode&&res.statusCode>=300&&res.statusCode<400&&res.headers.location&&d>0){res.resume();return r(get(new URL(res.headers.location,u).toString(),d-1))}
  let b='';res.setEncoding('utf8');res.on('data',c=>b+=c);res.on('end',()=>r(b))}).on('error',()=>r(''))})}
async function main(){
  const j = JSON.parse(await get('https://unpkg.com/zod/package.json'))
  console.log('version:', j.version, '| types:', j.types, '| main:', j.main)
  console.log('exports["."]:', JSON.stringify(j.exports?.['.']))
  const idx = await get('https://unpkg.com/zod/index.d.ts')
  console.log('\nindex.d.ts:', idx.length, 'chars ->', JSON.stringify(idx.slice(0,120)))
  // follow the barrel
  for (const cand of ['https://unpkg.com/zod/v4/classic/external.d.ts','https://unpkg.com/zod/v4/index.d.ts','https://unpkg.com/zod/v4/classic/index.d.ts']) {
    const t = await get(cand)
    console.log(`${cand.replace('https://unpkg.com/','')} -> ${t.length} chars ipv4=${/ipv4/i.test(t)}`)
  }
}
main()

import * as https from 'node:https'
function t(u:string):Promise<string>{const t0=Date.now();return new Promise(r=>{const req=https.get(u,{headers:{'User-Agent':'Crucible/1.0 (+offline-first grounding)'}},res=>{
  let n=0;res.on('data',c=>n+=c.length);res.on('end',()=>r(`HTTP ${res.statusCode} ${n}b ${Date.now()-t0}ms`))});
  req.on('error',e=>r(`ERR ${e.message} ${Date.now()-t0}ms`)); req.setTimeout(12000,()=>{req.destroy();r(`TIMEOUT ${Date.now()-t0}ms`)})})}
async function main(){
  for (const u of [
    'https://data.jsdelivr.com/v1/packages/npm/zod/resolved',
    'https://data.jsdelivr.com/v1/packages/npm/zod@4.4.3',
    'https://unpkg.com/zod/?meta',
  ]) console.log(`${(await t(u)).padEnd(28)} ${u.slice(0,62)}`)
}
main()

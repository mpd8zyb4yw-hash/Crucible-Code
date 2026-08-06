import * as https from 'node:https'
function raw(u:string,d=5):Promise<{s:number,n:number,ms:number}>{const t0=Date.now();return new Promise(r=>{https.get(u,{headers:{'User-Agent':'Crucible/1.0 (+offline-first grounding)'}},res=>{
  if(res.statusCode&&res.statusCode>=300&&res.statusCode<400&&res.headers.location&&d>0){res.resume();return r(raw(new URL(res.headers.location,u).toString(),d-1))}
  let n=0;res.on('data',c=>n+=c.length);res.on('end',()=>r({s:res.statusCode||0,n,ms:Date.now()-t0}))}).on('error',()=>r({s:-1,n:0,ms:Date.now()-t0}))})}
async function main(){
  const V='4.4.3'
  const steps: Array<[string,string]> = [
    ['resolved',   `https://data.jsdelivr.com/v1/packages/npm/zod/resolved`],
    ['listing',    `https://data.jsdelivr.com/v1/packages/npm/zod@${V}`],
    ['package.json',`https://cdn.jsdelivr.net/npm/zod@${V}/package.json`],
    ['entry d.cts',`https://cdn.jsdelivr.net/npm/zod@${V}/index.d.cts`],
    ['schemas.d.ts',`https://cdn.jsdelivr.net/npm/zod@${V}/v4/classic/schemas.d.ts`],
    ['parse.d.ts', `https://cdn.jsdelivr.net/npm/zod@${V}/v4/classic/parse.d.ts`],
    ['compat.d.ts',`https://cdn.jsdelivr.net/npm/zod@${V}/v4/classic/compat.d.ts`],
  ]
  let tot=0
  for(const [n,u] of steps){ const r=await raw(u); tot+=r.ms; console.log(`${n.padEnd(14)} HTTP ${r.s}  ${String(r.n).padStart(7)}b  ${String(r.ms).padStart(6)}ms`) }
  console.log('SEQUENTIAL TOTAL:', tot+'ms')
  const t0=Date.now(); await Promise.all(steps.slice(4).map(([,u])=>raw(u))); console.log('3 files in PARALLEL:', Date.now()-t0+'ms')
}
main()

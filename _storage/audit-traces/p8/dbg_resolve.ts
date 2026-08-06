import * as https from 'node:https'
function raw(u:string,d=5):Promise<string>{return new Promise((res,rej)=>{const req=https.get(u,{headers:{'User-Agent':'Crucible/1.0 (+offline-first grounding)','Accept':'text/html,application/xhtml+xml,application/json,*/*'}},r=>{
  if(r.statusCode&&r.statusCode>=300&&r.statusCode<400&&r.headers.location&&d>0){r.resume();return res(raw(new URL(r.headers.location,u).toString(),d-1))}
  if((r.statusCode??0)<200||(r.statusCode??0)>=300){r.resume();return rej(new Error('HTTP '+r.statusCode))}
  let b='';r.setEncoding('utf8');r.on('data',c=>b+=c);r.on('end',()=>res(b))});
  req.on('error',rej); req.setTimeout(8000,()=>{req.destroy();rej(new Error('timeout'))})})}
async function main(){
  const t0=Date.now()
  try { const m=JSON.parse(await raw('https://unpkg.com/zod/?meta')); console.log(`unpkg OK ${Date.now()-t0}ms version=${m.version} files=${m.files?.length}`) }
  catch(e){ console.log(`unpkg FAIL ${Date.now()-t0}ms:`, (e as Error).message) }
  const t1=Date.now()
  try { const r=JSON.parse(await raw('https://data.jsdelivr.com/v1/packages/npm/zod/resolved')); console.log(`jsd resolved OK ${Date.now()-t1}ms v=${r.version}`) }
  catch(e){ console.log(`jsd resolved FAIL ${Date.now()-t1}ms:`, (e as Error).message) }
}
main()

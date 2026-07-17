import { fetchLibraryApiDocs } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
import * as https from 'node:https'
function raw(u:string,d=5):Promise<{s:number,b:string}>{return new Promise(r=>{https.get(u,{headers:{'User-Agent':'Crucible/1.0 (+offline-first grounding)','Accept':'text/html,application/xhtml+xml,application/json,*/*'}},res=>{
  if(res.statusCode&&res.statusCode>=300&&res.statusCode<400&&res.headers.location&&d>0){res.resume();return r(raw(new URL(res.headers.location,u).toString(),d-1))}
  let b='';res.setEncoding('utf8');res.on('data',c=>b+=c);res.on('end',()=>r({s:res.statusCode||0,b}))}).on('error',e=>r({s:-1,b:e.message}))})}
async function main(){
  for (const u of ['https://data.jsdelivr.com/v1/packages/npm/zod/resolved','https://data.jsdelivr.com/v1/packages/npm/zod@4.4.3','https://cdn.jsdelivr.net/npm/zod@4.4.3/package.json']) {
    const {s,b} = await raw(u)
    console.log(`HTTP ${s}  ${String(b.length).padStart(7)}  ${u.slice(0,70)}`)
    if(s===200 && b.length<300) console.log('     body:', b.slice(0,200))
  }
  console.log('\nfetchLibraryApiDocs("zod"):', await fetchLibraryApiDocs('zod') ? 'OK' : 'NULL')
  console.log('fetchLibraryApiDocs("react"):', await fetchLibraryApiDocs('react') ? 'OK' : 'NULL')
}
main()

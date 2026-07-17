import * as https from 'node:https'
function get(u:string,d=5):Promise<string>{return new Promise(r=>{https.get(u,{headers:{'User-Agent':'Crucible/1.0'}},res=>{
  if(res.statusCode&&res.statusCode>=300&&res.statusCode<400&&res.headers.location&&d>0){res.resume();return r(get(new URL(res.headers.location,u).toString(),d-1))}
  if(res.statusCode!==200){res.resume();return r('')}
  let b='';res.setEncoding('utf8');res.on('data',c=>b+=c);res.on('end',()=>r(b))}).on('error',()=>r(''))})}
const REEXPORT=/(?:export|import)\s+(?:\*|\{[^}]*\}|[\w*\s,]+)\s*from\s*['"]([^'"]+)['"]/g
async function crawl(start:string,maxFiles=40){
  const seen=new Set<string>(); const q=[start]; let total=0; const hits:string[]=[]
  while(q.length && seen.size<maxFiles){
    const u=q.shift()!; if(seen.has(u))continue; seen.add(u)
    const t=await get(u); if(!t)continue; total+=t.length
    if(/ipv4/i.test(t)) hits.push(`${u.replace('https://unpkg.com/','')} (${t.length}c)`)
    let m; REEXPORT.lastIndex=0
    while((m=REEXPORT.exec(t))!==null){
      let spec=m[1]; if(!spec.startsWith('.'))continue
      spec=spec.replace(/\.js$/,'.d.ts'); if(!/\.d\.ts$/.test(spec))spec+='.d.ts'
      q.push(new URL(spec,u).toString())
    }
  }
  return {files:seen.size,total,hits}
}
async function main(){
  const r=await crawl('https://unpkg.com/zod/index.d.ts')
  console.log('files crawled:',r.files,'| total chars:',r.total)
  console.log('files containing ipv4:'); r.hits.forEach(h=>console.log('  ',h))
}
main()

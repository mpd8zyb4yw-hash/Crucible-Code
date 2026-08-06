import * as https from 'node:https'
function get(u:string,d=5):Promise<string>{return new Promise(r=>{https.get(u,{headers:{'User-Agent':'Crucible/1.0'}},res=>{
  if(res.statusCode&&res.statusCode>=300&&res.statusCode<400&&res.headers.location&&d>0){res.resume();return r(get(new URL(res.headers.location,u).toString(),d-1))}
  if(res.statusCode!==200){res.resume();return r('')}
  let b='';res.setEncoding('utf8');res.on('data',c=>b+=c);res.on('end',()=>r(b))}).on('error',()=>r(''))})}
async function main(){
  const t0=Date.now()
  const resolved = JSON.parse(await get('https://data.jsdelivr.com/v1/packages/npm/zod/resolved'))
  console.log('resolved version:', resolved.version, Date.now()-t0+'ms')
  const j = JSON.parse(await get(`https://data.jsdelivr.com/v1/packages/npm/zod@${resolved.version}`))
  const flat:{p:string,size:number}[]=[]
  const walk=(n:any,p='')=>{for(const f of n||[]){const fp=p+'/'+f.name; if(f.type==='directory')walk(f.files,fp); else flat.push({p:fp,size:f.size||0})}}
  walk(j.files)
  const dts=flat.filter(f=>/\.d\.ts$/.test(f.p)).sort((a,b)=>b.size-a.size)
  console.log('total files:',flat.length,'| .d.ts:',dts.length, '|', Date.now()-t0+'ms')
  console.log('largest .d.ts:')
  dts.slice(0,5).forEach(d=>console.log(`   ${String(d.size).padStart(7)}  ${d.p}`))
  // fetch the largest 2 and check for ipv4
  for (const d of dts.slice(0,2)) {
    const t = await get(`https://cdn.jsdelivr.net/npm/zod@${resolved.version}${d.p}`)
    console.log(`   fetched ${d.p} -> ${t.length}c ipv4=${/ipv4/i.test(t)}`)
  }
  console.log('TOTAL', Date.now()-t0+'ms')
}
main()

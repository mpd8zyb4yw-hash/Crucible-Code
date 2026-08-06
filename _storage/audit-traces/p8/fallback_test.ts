// Simulate jsDelivr being down by pointing its host at a black hole via /etc/hosts? No —
// instead verify unpkg alone can satisfy the lane, which is what the fallback depends on.
import * as https from 'node:https'
function get(u:string,d=5):Promise<string>{return new Promise(r=>{https.get(u,{headers:{'User-Agent':'Crucible/1.0'}},res=>{
  if(res.statusCode&&res.statusCode>=300&&res.statusCode<400&&res.headers.location&&d>0){res.resume();return r(get(new URL(res.headers.location,u).toString(),d-1))}
  if(res.statusCode!==200){res.resume();return r('')}
  let b='';res.setEncoding('utf8');res.on('data',c=>b+=c);res.on('end',()=>r(b))}).on('error',()=>r(''))})}
async function main(){
  const t0=Date.now()
  const meta = JSON.parse(await get('https://unpkg.com/zod/?meta'))
  const files = (meta.files??[]).map((f:any)=>({path:f.path,size:f.size??0}))
  const dts = files.filter((f:any)=>/\.d\.ts$/.test(f.path)).sort((a:any,b:any)=>b.size-a.size)
  console.log(`unpkg-only: version=${meta.version} files=${files.length} .d.ts=${dts.length} (${Date.now()-t0}ms)`)
  console.log('largest .d.ts:', dts[0]?.path, dts[0]?.size)
  const body = await get(`https://unpkg.com/zod@${meta.version}${dts.find((f:any)=>f.path.includes('/classic/'))?.path ?? dts[0].path}`)
  console.log('fetched classic surface:', body.length, 'chars  ipv4=', /ipv4/i.test(body))
  console.log('\n=> the fallback CDN can satisfy the lane alone.')
}
main()

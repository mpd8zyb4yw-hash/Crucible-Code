import * as https from 'node:https'
function get(u:string,d=5):Promise<string>{return new Promise(r=>{https.get(u,{headers:{'User-Agent':'Crucible/1.0'}},res=>{
  if(res.statusCode&&res.statusCode>=300&&res.statusCode<400&&res.headers.location&&d>0){res.resume();return r(get(new URL(res.headers.location,u).toString(),d-1))}
  if(res.statusCode!==200){res.resume();return r('')}
  let b='';res.setEncoding('utf8');res.on('data',c=>b+=c);res.on('end',()=>r(b))}).on('error',()=>r(''))})}
async function main(){
  // Does jsDelivr expose a deterministic file listing? (one request instead of a 40-file crawl)
  const t0=Date.now()
  const meta = await get('https://data.jsdelivr.com/v1/packages/npm/zod')
  console.log('jsdelivr meta:', meta.length, 'chars', Date.now()-t0+'ms')
  if(meta.length>50){
    const j=JSON.parse(meta)
    const flat:string[]=[]
    const walk=(n:any,p='')=>{for(const f of n||[]){const fp=p+'/'+f.name; if(f.type==='directory')walk(f.files,fp); else flat.push(fp+'|'+(f.size||0))}}
    walk(j.files)
    const dts=flat.filter(f=>/\.d\.ts\|/.test(f)).map(f=>{const [p,s]=f.split('|');return {p,size:+s}}).sort((a,b)=>b.size-a.size)
    console.log('total files:',flat.length,'| .d.ts files:',dts.length)
    console.log('largest .d.ts (these carry the API surface):')
    dts.slice(0,6).forEach(d=>console.log(`   ${String(d.size).padStart(7)}  ${d.p}`))
  }
}
main()

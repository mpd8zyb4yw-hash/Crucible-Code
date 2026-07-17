import { fetchTypeDefs } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
async function main(){
  for (const pkg of ['zod','react','express','definitely-not-a-real-pkg-xyz']) {
    const t0=Date.now()
    let d=''
    try { d = await fetchTypeDefs(pkg) } catch(e){ console.log(pkg,'THREW',(e as Error).message); continue }
    const ms=Date.now()-t0
    console.log(`${pkg.padEnd(32)} ${String(d.length).padStart(7)} chars  ${ms}ms  ipv4=${/ipv4/i.test(d)}`)
    if (pkg==='zod' && d) {
      const i = d.toLowerCase().indexOf('ipv4')
      if (i>=0) console.log('   ---- real API surface near ipv4 ----\n   ' + d.slice(i-160,i+120).replace(/\n/g,'\n   '))
    }
  }
}
main()

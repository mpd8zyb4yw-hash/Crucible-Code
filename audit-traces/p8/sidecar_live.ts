import { ensureBonsai, bonsaiComplete, stopBonsai, isBonsaiInstalled } from '../../src/CrucibleEngine/localModels/bonsaiSidecar'
import { execSync } from 'node:child_process'
const wired = () => execSync("top -l 1 -n 0 | grep PhysMem").toString().match(/(\d+)M wired/)?.[1] ?? '?'
const procs = () => execSync("pgrep -f 'llama-server -m' | wc -l").toString().trim()
const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms))
async function main(){
  console.log('installed        :', isBonsaiInstalled())
  console.log('before  wired=' + wired() + 'MB procs=' + procs())
  const t0=Date.now()
  const txt = await bonsaiComplete([{role:'user',content:'Reply with exactly: HELLO'}], { maxTokens: 24 })
  console.log(`answer  ${JSON.stringify(txt)}  (${((Date.now()-t0)/1000).toFixed(1)}s incl. cold load)`)
  console.log('loaded  wired=' + wired() + 'MB procs=' + procs())
  // idle-unload is the whole point: prove the memory actually comes back
  process.env.CRUCIBLE_BONSAI_IDLE_MS = '1'
  await stopBonsai('test')
  await sleep(3000)
  console.log('unloaded wired=' + wired() + 'MB procs=' + procs() + '   <- must be 0 procs')
}
main().then(()=>process.exit(0))

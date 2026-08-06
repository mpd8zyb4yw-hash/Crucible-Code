import { bonsaiComplete } from '../../src/CrucibleEngine/localModels/bonsaiSidecar'
import { execSync } from 'node:child_process'
const procs = () => execSync("pgrep -f 'llama-server -m' | wc -l").toString().trim()
const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms))
async function main(){
  await bonsaiComplete([{role:'user',content:'Say OK'}], { maxTokens: 8 })
  console.log('after request      procs=' + procs() + '  (expect 1 — still warm for follow-ups)')
  await sleep(6000)
  console.log('t+6s  (idle=10s)   procs=' + procs() + '  (expect 1 — not yet)')
  await sleep(8000)
  console.log('t+14s (idle=10s)   procs=' + procs() + '  (expect 0 — AUTO-UNLOADED, memory returned)')
}
main().then(()=>process.exit(0))

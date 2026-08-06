import fs from 'fs'
import { repairUntilFaithful } from '/Users/justin/crucible-local/crucible-local/src/CrucibleEngine/reasoning/faithfulRepair'
import { fmComplete } from '/Users/justin/crucible-local/crucible-local/src/CrucibleEngine/agent/fmReact'
import { miniCpmComplete } from '/Users/justin/crucible-local/crucible-local/src/CrucibleEngine/agent/miniCpmHarness'

const SP = process.env.SP!
const evidence = fs.readFileSync(SP + '/faith86.evidence.txt', 'utf8')
const draft = fs.readFileSync(SP + '/faith86.answer.txt', 'utf8')
const goal = 'Write a Zod schema that validates an IPv4 address'
const RUNS = Number(process.env.RUNS ?? 4)

const base = [
  { role: 'system', content: 'Answer using ONLY the evidence below. Include code.' },
  { role: 'user', content: `Evidence:\n${evidence}\n\nQuestion: ${goal}` },
]

async function one(withAlt: boolean) {
  const t0 = Date.now()
  const srcs: string[] = []
  const rep = await repairUntilFaithful(
    {
      draft, evidence, goal, baseMsgs: base,
      complete: (m, s) => fmComplete(m as any, { timeoutMs: 30_000, maxTokens: 1100, signal: s }),
      completeAlt: withAlt ? (m, s) => miniCpmComplete(m, s, { maxTokens: 1100, timeoutMs: 25_000 }) : undefined,
    },
    { attempts: 3, onAttempt: (n, v, src) => { if (src && src !== 'draft') srcs.push(`${src}:${v.status}`) } },
  )
  return { certified: rep.status === 'certified', by: rep.proposedBy, secs: (Date.now()-t0)/1000, srcs }
}

;(async () => {
  for (const withAlt of [false, true]) {
    const label = withAlt ? 'FM+MiniCPM' : 'FM only  '
    let cert = 0, byCpm = 0, tot = 0
    for (let i = 0; i < RUNS; i++) {
      const r = await one(withAlt)
      if (r.certified) cert++
      if (r.certified && r.by === 'minicpm') byCpm++
      tot += r.secs
      console.log(`  ${label} run${i+1}: certified=${r.certified} by=${r.by} ${r.secs.toFixed(1)}s [${r.srcs.join(' ')}]`)
    }
    console.log(`  => ${label}: certified ${cert}/${RUNS}, minicpm-earned ${byCpm}, avg ${(tot/RUNS).toFixed(1)}s\n`)
  }
  process.exit(0)
})()

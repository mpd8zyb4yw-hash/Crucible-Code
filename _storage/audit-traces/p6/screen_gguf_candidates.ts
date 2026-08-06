import fs from 'fs'
import { completeLocalModel } from '/Users/justin/crucible-local/crucible-local/src/CrucibleEngine/agent/localModelPool'
import { stripReasoning } from '/Users/justin/crucible-local/crucible-local/src/CrucibleEngine/agent/miniCpmHarness'
import { verifyApiFaithfulness } from '/Users/justin/crucible-local/crucible-local/src/CrucibleEngine/reasoning/apiFaithfulness'

const evidence = fs.readFileSync('/Users/justin/crucible-local/crucible-local/audit-traces/p6/faith86.evidence.txt', 'utf8')
const system = 'You are a code-generation function. Output one TypeScript code block and nothing else.'
const user = `Documentation:\n${evidence}\n\nWrite a TypeScript snippet that validates an IPv4 address using the zod function shown in the documentation above. Output the code block.`

const MODELS = ['phi-3.5-mini', 'qwen2.5-1.5b', 'gemma2-2b']

;(async () => {
  for (const id of MODELS) {
    for (let i = 0; i < 2; i++) {
      const t = Date.now()
      let raw = ''
      try { raw = await completeLocalModel(id, system, user, { maxTokens: 700, timeoutMs: 60_000 }) }
      catch (e: any) { console.log(`${id} run${i+1}: THREW ${String(e?.message ?? e).slice(0,60)}`); continue }
      const cleaned = stripReasoning(raw) || raw
      const v = verifyApiFaithfulness(cleaned, evidence)
      const usesIpv4 = /z\s*\.\s*ipv4\s*\(/.test(cleaned)
      const hasFence = /```/.test(cleaned)
      console.log(`${id.padEnd(13)} run${i+1}: ${String(Date.now()-t).padStart(6)}ms verdict=${v.status.padEnd(10)} code=${hasFence} z.ipv4()=${usesIpv4}`)
      console.log('   ', JSON.stringify(cleaned.slice(0, 105)))
    }
  }
  process.exit(0)
})()

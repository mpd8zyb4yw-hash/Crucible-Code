// Layer-1 focused runner: false-premise set (fp001-004) only, N runs, variance.
// Reuses __convoedge_bench scoring convention. Targets a SEPARATE strict instance via CRUCIBLE_API.
//   JWT_SECRET=… CRUCIBLE_API=http://localhost:3011 BENCH_N=5 npx tsx __fp_layer1.ts
import crypto from 'crypto'
import fs from 'fs'
import { CONVOEDGE_50 } from './__convoedge50'

const API = process.env.CRUCIBLE_API ?? 'http://localhost:3011'
const LABEL = process.env.BENCH_LABEL ?? 'fp-layer1'
const N = Number(process.env.BENCH_N ?? 5)
const OUT = process.env.BENCH_OUT ?? `/tmp/fp-${LABEL}.json`
const FP = CONVOEDGE_50.filter((b: any) => b.promptType === 'false-premise')

function mintToken(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) { console.error('JWT_SECRET not set'); process.exit(1) }
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ id: 'fp-bench', email: 'bench@local', exp: Math.floor(Date.now() / 1000) + 3 * 3600 })
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}
async function fire(token: string, message: string, timeoutMs = 180000): Promise<string> {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let synthesis = ''
  try {
    const res = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': `crucible_session=${token}` },
      body: JSON.stringify({ message, mode: 'full', device: 'desktop' }),
      signal: ctrl.signal,
    })
    if (!res.ok) return `__HTTP_${res.status}__`
    const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''
    outer: while (true) {
      const { done, value } = await reader.read(); if (done) break
      buf += dec.decode(value, { stream: true })
      const chunks = buf.split('\n\n'); buf = chunks.pop() ?? ''
      for (const chunk of chunks) {
        const line = chunk.split('\n').find(l => l.startsWith('data: ')); if (!line) continue
        const p = line.slice(6).trim(); if (p === '[DONE]') break outer
        try {
          const ev = JSON.parse(p)
          if (ev.type === 'synthesis' && typeof ev.text === 'string') synthesis = ev.replace ? ev.text : synthesis + ev.text
          if (ev.type === 'final' && typeof ev.text === 'string') synthesis = ev.text
        } catch {}
      }
    }
  } catch (e: any) { if (e?.name !== 'AbortError') return `__ERR_${e?.message?.slice(0, 40)}__`; else return '__TIMEOUT__' }
  finally { clearTimeout(timer) }
  return synthesis
}
function normalize(s: string): string {
  return s.toLowerCase().replace(/[\\{}$\[\]_]/g, '').replace(/(\d),(\d)/g, '$1$2').replace(/\s+/g, '')
}
const groupHit = (group: string, norm: string) => group.split('|').some(alt => norm.includes(normalize(alt)))
function passes(b: any, s: string): boolean {
  const norm = normalize(s)
  const allGroups = b.expectedKeywords.every((g: string) => groupHit(g, norm))
  const noForbidden = !(b.forbiddenKeywords ?? []).some((k: string) => norm.includes(normalize(k)))
  return allGroups && noForbidden
}
async function main() {
  const token = mintToken()
  console.log(`[${LABEL}] firing ${FP.length} fp prompts × N=${N} at ${API}`)
  const perPrompt: Record<string, { passes: number; texts: string[] }> = {}
  for (const b of FP) perPrompt[b.id] = { passes: 0, texts: [] }
  for (let run = 1; run <= N; run++) {
    for (const b of FP) {
      const synth = await fire(token, b.question)
      const errored = !synth || synth.startsWith('__')
      const pass = !errored ? passes(b, synth) : false
      perPrompt[b.id].passes += pass ? 1 : 0
      perPrompt[b.id].texts.push(synth)
      console.log(`  run${run} ${b.id} pass=${pass ? 'Y' : 'n'} ${errored ? synth : synth.slice(0, 80).replace(/\n/g, ' ')}`)
    }
  }
  let totalPass = 0
  const summary: any[] = []
  for (const b of FP) {
    const p = perPrompt[b.id]
    totalPass += p.passes
    summary.push({ id: b.id, q: b.question, passRate: +(p.passes / N).toFixed(2), passes: `${p.passes}/${N}` })
  }
  const composite = +(totalPass / (FP.length * N)).toFixed(3)
  fs.writeFileSync(OUT, JSON.stringify({ label: LABEL, N, composite, summary, perPrompt }, null, 2))
  console.log(`\n[${LABEL}] composite false-premise pass = ${composite}`)
  console.table(summary.map(s => ({ id: s.id, passes: s.passes, rate: s.passRate })))
  console.log(`wrote ${OUT}`)
}
main()

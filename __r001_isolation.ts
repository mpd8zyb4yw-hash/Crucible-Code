// Isolation re-test for the r001 daemon-timeout flake, post FM_TIMEOUT_MS 30s->45s bump.
// Mirrors the diagnosis methodology: cold back-to-back N and warm back-to-back N (fired
// immediately after a warm-up burst, no idle gap) against :3011. Reuses fire()/mintToken()
// from __convoedge_bench.ts verbatim.
import crypto from 'crypto'
import { CONVOEDGE_50 } from './__convoedge50'

const API = process.env.CRUCIBLE_API ?? 'http://localhost:3011'
const N = Number(process.env.N ?? 10)
const r001 = CONVOEDGE_50.find(b => b.id === 'r001')!

function mintToken(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) { console.error('JWT_SECRET not set'); process.exit(1) }
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ id: 'r001-iso', email: 'iso@local', exp: Math.floor(Date.now() / 1000) + 3 * 3600 })
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

async function fire(token: string, message: string, timeoutMs = 180000): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
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
  return s.toLowerCase().replace(/\s+/g, '')
}
const groupHit = (group: string, norm: string) => group.split('|').some(alt => norm.includes(normalize(alt)))
function passes(s: string): boolean {
  const norm = normalize(s)
  return r001.expectedKeywords.every((g: string) => groupHit(g, norm))
}

async function runBatch(label: string, token: string, n: number) {
  const results: { pass: boolean; ms: number; note: string }[] = []
  for (let i = 0; i < n; i++) {
    const t0 = Date.now()
    const synth = await fire(token, r001.question)
    const ms = Date.now() - t0
    const errored = !synth || synth.startsWith('__')
    const isTimeoutAbstain = /timed out|taking too long/i.test(synth)
    const isUnreachableAbstain = /daemon is unreachable/i.test(synth)
    const pass = !errored ? passes(synth) : false
    results.push({ pass, ms, note: errored ? synth : isTimeoutAbstain ? 'ABSTAIN_TIMEOUT_LABEL' : isUnreachableAbstain ? 'ABSTAIN_UNREACHABLE_LABEL' : '' })
    console.log(`  [${label}] ${i + 1}/${n} pass=${pass ? 'Y' : 'n'} ${(ms / 1000).toFixed(1)}s ${results[i].note}`)
  }
  const passRate = results.filter(r => r.pass).length / n
  const avgMs = Math.round(results.reduce((a, r) => a + r.ms, 0) / n)
  console.log(`[${label}] passRate=${passRate.toFixed(2)} avgMs=${avgMs}\n`)
  return { label, passRate, avgMs, results }
}

async function main() {
  const token = mintToken()
  console.log(`r001 isolation re-test against ${API}, N=${N} per batch\n`)
  const cold = await runBatch('cold-back-to-back', token, N)
  const warm = await runBatch('warm-back-to-back', token, N)
  console.log(JSON.stringify({ cold: { passRate: cold.passRate, avgMs: cold.avgMs }, warm: { passRate: warm.passRate, avgMs: warm.avgMs } }, null, 2))
}
main()

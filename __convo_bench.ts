// Strict-offline conversational bench — fires the 15 SEED benchmarks at /api/chat
// (mode:'full' → triageTier full path) and scores objectively (strict all-keyword
// pass + coverage ratio). Same scorer/prompts as the 0.11 baseline.
import crypto from 'crypto'
import fs from 'fs'
import { SEED_BENCHMARKS, evaluateSynthesis } from './src/CrucibleEngine/benchmarks'

const API = process.env.CRUCIBLE_API ?? 'http://localhost:3001'
const LABEL = process.env.BENCH_LABEL ?? 'run'
const OUT = process.env.BENCH_OUT ?? `/tmp/convo-${LABEL}.json`

function mintToken(): string {
  const secret = process.env.JWT_SECRET!
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ id: 'convo-bench', email: 'bench@local', exp: Math.floor(Date.now()/1000)+3*3600 })
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
        try { const ev = JSON.parse(p)
          if (ev.type === 'synthesis' && typeof ev.text === 'string') synthesis = ev.replace ? ev.text : synthesis + ev.text
          if (ev.type === 'final' && typeof ev.text === 'string') synthesis = ev.text
        } catch {}
      }
    }
  } catch (e: any) { if (e?.name !== 'AbortError') return `__ERR_${e?.message?.slice(0,40)}__`; else return '__TIMEOUT__' }
  finally { clearTimeout(timer) }
  return synthesis
}

function coverage(b: any, s: string): number {
  if (!b.expectedKeywords.length) return 1
  const lower = s.toLowerCase()
  return b.expectedKeywords.filter((k: string) => lower.includes(k.toLowerCase())).length / b.expectedKeywords.length
}

async function main() {
  const token = mintToken()
  const cats: Record<string, { pass: number; total: number; cov: number; ms: number }> = {}
  const rows: any[] = []
  for (const b of SEED_BENCHMARKS) {
    const t0 = Date.now()
    const synth = await fire(token, b.question)
    const ms = Date.now() - t0
    const errored = !synth || synth.startsWith('__')
    const pass = !errored ? evaluateSynthesis(b, synth) : false
    const cov = !errored ? coverage(b, synth) : 0
    const band = errored ? 'error' : pass ? 'full' : cov > 0 ? 'partial' : 'fail'
    const pt = b.promptType
    cats[pt] ??= { pass: 0, total: 0, cov: 0, ms: 0 }
    cats[pt].total++; cats[pt].pass += pass ? 1 : 0; cats[pt].cov += cov; cats[pt].ms += ms
    rows.push({ id: b.id, cat: pt, band, pass, cov: +cov.toFixed(2), ms, len: synth.length, err: errored ? synth : '' })
    console.log(`  ${b.id} [${pt.padEnd(9)}] ${band.padEnd(7)} pass=${pass?'Y':'n'} cov=${cov.toFixed(2)} ${(ms/1000).toFixed(1)}s ${errored?synth:''}`)
  }
  const summary = Object.fromEntries(Object.entries(cats).map(([k,v]) => [k, {
    passRate: +(v.pass/v.total).toFixed(2), avgCov: +(v.cov/v.total).toFixed(2), n: v.total, avgMs: Math.round(v.ms/v.total),
  }]))
  const bands = rows.reduce((a: any, r) => { a[r.band] = (a[r.band]||0)+1; return a }, {})
  const overall = {
    passRate: +(rows.filter(r=>r.pass).length/rows.length).toFixed(2),
    avgCov: +(rows.reduce((a,r)=>a+r.cov,0)/rows.length).toFixed(2),
    avgMs: Math.round(rows.reduce((a,r)=>a+r.ms,0)/rows.length),
    bands,
  }
  fs.writeFileSync(OUT, JSON.stringify({ label: LABEL, overall, byCategory: summary, rows }, null, 2))
  console.log(`\n[${LABEL}] overall pass=${overall.passRate} cov=${overall.avgCov} avgMs=${overall.avgMs} bands=${JSON.stringify(bands)}`)
  console.log(JSON.stringify(summary, null, 2))
}
main()

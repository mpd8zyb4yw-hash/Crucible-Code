// Strict-offline conversational + edge/abstain runner — fires CONVOEDGE_50 at /api/chat
// (mode:'full' → triageTier full conversational path, the path the offline-routing fix touches)
// and scores with the same OR-group / forbidden-keyword convention as __mathfact_bench.ts.
// Reuses the proven fire()/streaming logic. Does NOT modify the shared benchmarks.ts scorer.
// Persists full response text per row (not just length) so per-prompt abstain/correction behavior
// is auditable verbatim — required by the standing "verify empirically" constraint.
//
//   JWT_SECRET=… npx tsx __convoedge_bench.ts
//   BENCH_LABEL=strict-ce50 CRUCIBLE_API=… npx tsx __convoedge_bench.ts
import crypto from 'crypto'
import fs from 'fs'
import { CONVOEDGE_50 } from './__convoedge50'

const API = process.env.CRUCIBLE_API ?? 'http://localhost:3001'
const LABEL = process.env.BENCH_LABEL ?? 'ce50'
const OUT = process.env.BENCH_OUT ?? `/tmp/convoedge-${LABEL}.json`

function mintToken(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) { console.error('JWT_SECRET not set — cannot mint authed cookie'); process.exit(1) }
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ id: 'ce-bench', email: 'bench@local', exp: Math.floor(Date.now() / 1000) + 3 * 3600 })
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

// normalize(): identical to __mathfact_bench.ts — collapse surface-form noise so a correct answer
// matches regardless of rendering. Lowercases, expands/strips LaTeX, joins comma-thousands, despaces.
// Apostrophes and hyphens are PRESERVED (abstain keywords like "can't" depend on them).
function normalize(s: string): string {
  return s.toLowerCase()
    .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2')
    .replace(/\\pi/g, 'π').replace(/\\times/g, '×').replace(/\\cdot/g, '·').replace(/\\sqrt/g, '√')
    .replace(/[\\{}$\[\]_]/g, '')
    .replace(/(\d),(\d)/g, '$1$2')
    .replace(/\s+/g, '')
}
const groupHit = (group: string, norm: string) => group.split('|').some(alt => norm.includes(normalize(alt)))
function coverage(b: any, s: string): number {
  if (!b.expectedKeywords.length) return 1
  const norm = normalize(s)
  return b.expectedKeywords.filter((g: string) => groupHit(g, norm)).length / b.expectedKeywords.length
}
function passes(b: any, s: string): boolean {
  const norm = normalize(s)
  const allGroups = b.expectedKeywords.every((g: string) => groupHit(g, norm))
  const noForbidden = !(b.forbiddenKeywords ?? []).some((k: string) => norm.includes(normalize(k)))
  return allGroups && noForbidden
}

async function main() {
  const token = mintToken()
  console.log(`[${LABEL}] firing ${CONVOEDGE_50.length} prompts at ${API} (mode=full)`)
  const cats: Record<string, { pass: number; total: number; cov: number; ms: number }> = {}
  const rows: any[] = []
  for (const b of CONVOEDGE_50) {
    const t0 = Date.now()
    const synth = await fire(token, b.question)
    const ms = Date.now() - t0
    const errored = !synth || synth.startsWith('__')
    const pass = !errored ? passes(b, synth) : false
    const cov = !errored ? coverage(b, synth) : 0
    const band = errored ? 'error' : pass ? 'full' : cov > 0 ? 'partial' : 'fail'
    const pt = b.promptType
    cats[pt] ??= { pass: 0, total: 0, cov: 0, ms: 0 }
    cats[pt].total++; cats[pt].pass += pass ? 1 : 0; cats[pt].cov += cov; cats[pt].ms += ms
    rows.push({ id: b.id, cat: pt, band, pass, cov: +cov.toFixed(2), ms, len: synth.length, text: synth, err: errored ? synth : '' })
    console.log(`  ${b.id} [${pt.padEnd(13)}] ${band.padEnd(7)} pass=${pass ? 'Y' : 'n'} cov=${cov.toFixed(2)} ${(ms / 1000).toFixed(1)}s ${errored ? synth : ''}`)
  }
  const byCategory = Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, {
    passRate: +(v.pass / v.total).toFixed(2), avgCov: +(v.cov / v.total).toFixed(2), n: v.total, avgMs: Math.round(v.ms / v.total),
  }]))
  const bands = rows.reduce((a: any, r) => { a[r.band] = (a[r.band] || 0) + 1; return a }, {})
  const overall = {
    passRate: +(rows.filter(r => r.pass).length / rows.length).toFixed(2),
    avgCov: +(rows.reduce((a, r) => a + r.cov, 0) / rows.length).toFixed(2),
    avgMs: Math.round(rows.reduce((a, r) => a + r.ms, 0) / rows.length),
    bands,
  }
  fs.writeFileSync(OUT, JSON.stringify({ label: LABEL, overall, byCategory, rows }, null, 2))
  console.log(`\n[${LABEL}] overall pass=${overall.passRate} cov=${overall.avgCov} avgMs=${overall.avgMs} bands=${JSON.stringify(bands)}`)
  console.log(JSON.stringify(byCategory, null, 2))
  console.log(`\nwrote ${OUT}`)
}
main()

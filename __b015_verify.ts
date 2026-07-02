// One-shot b015 verifier: fires the Pythagorean prompt at /api/chat (mode:full,
// offline=strict path) and prints the VERBATIM answer + scorer breakdown. No inference.
import crypto from 'crypto'
import { SEED_BENCHMARKS, evaluateSynthesis } from './src/CrucibleEngine/benchmarks'

const API = process.env.CRUCIBLE_API ?? 'http://localhost:3001'
const b = SEED_BENCHMARKS.find((x: any) => x.id === 'b015')!

function mintToken(): string {
  const secret = process.env.JWT_SECRET!
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ id: 'b015-verify', email: 'bench@local', exp: Math.floor(Date.now() / 1000) + 3600 })
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

async function main() {
  const token = mintToken()
  const res = await fetch(`${API}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `crucible_session=${token}` },
    body: JSON.stringify({ message: b.question, mode: 'full', device: 'desktop' }),
  })
  if (!res.ok) { console.error('HTTP', res.status); process.exit(1) }
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''
  let synthesis = ''; const pathEvents: string[] = []
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
        if (ev.type === 'debug' || ev.type === 'history') { const s = JSON.stringify(ev); if (/offline|conversational|react|synthDriver|abstain/i.test(s)) pathEvents.push(s.slice(0, 200)) }
      } catch {}
    }
  }
  console.log('=== ROUTING EVENTS ===')
  pathEvents.forEach(e => console.log('  ', e))
  console.log('\n=== VERBATIM ANSWER (' + synthesis.length + ' chars) ===')
  console.log(synthesis)
  console.log('\n=== SCORER ===')
  console.log('expectedKeywords:', JSON.stringify(b.expectedKeywords))
  const lower = synthesis.toLowerCase()
  b.expectedKeywords.forEach((k: string) => console.log(`  ${lower.includes(k.toLowerCase()) ? 'HIT ' : 'MISS'} "${k}"`))
  console.log('evaluateSynthesis pass:', evaluateSynthesis(b, synthesis))
}
main()

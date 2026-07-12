// Live multi-turn reproduction harness — fires real /api/chat turns and prints RAW output.
// Run: JWT_SECRET=… npx tsx repro_convo.ts
import crypto from 'node:crypto'

const API = process.env.CRUCIBLE_API ?? 'http://127.0.0.1:3001'

function mintToken(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) { console.error('FAIL — JWT_SECRET not set'); process.exit(2) }
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ id: 'repro-bench', email: 'repro@local', exp: Math.floor(Date.now() / 1000) + 3 * 3600 })
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

async function fire(token: string, message: string, history: Array<{ user: string; assistant: string }>, timeoutMs = 120000): Promise<{ text: string; ms: number; events: string[] }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = Date.now()
  let synthesis = ''
  const events: string[] = []
  try {
    const res = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': `crucible_session=${token}` },
      body: JSON.stringify({ message, mode: 'full', device: 'desktop', history }),
      signal: ctrl.signal,
    })
    if (!res.ok) return { text: `__HTTP_${res.status}__`, ms: Date.now() - t0, events }
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
          if (ev.type && !events.includes(ev.type)) events.push(ev.type)
          if (ev.type === 'synthesis' && typeof ev.text === 'string') synthesis = ev.replace ? ev.text : synthesis + ev.text
          if (ev.type === 'final' && typeof ev.text === 'string') synthesis = ev.text
        } catch {}
      }
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') return { text: '__TIMEOUT__', ms: Date.now() - t0, events }
    return { text: `__ERR_${String(e?.message).slice(0, 60)}__`, ms: Date.now() - t0, events }
  } finally { clearTimeout(timer) }
  return { text: synthesis, ms: Date.now() - t0, events }
}

const CONVOS: Array<{ id: string; turns: string[] }> = [
  { id: 'followup-more', turns: [
    'What are some good names for a habit-tracking app?',
    'give me 3 more',
  ] },
  { id: 'explain-then-example', turns: [
    'Explain what a closure is in JavaScript.',
    'now show me a concrete example',
  ] },
  { id: 'greet-then-code', turns: [
    'hey there',
    'write a function that reverses a string',
  ] },
  { id: 'project-context', turns: [
    "I'm building a todo app in React.",
    'what state management library should I use?',
  ] },
  { id: 'backref-pronoun', turns: [
    'Tell me about the Python requests library.',
    'is it part of the standard library?',
  ] },
]

async function main() {
  const token = mintToken()
  console.log(`Target ${API}\n`)
  const flags: string[] = []
  for (const convo of CONVOS) {
    console.log(`\n========== ${convo.id} ==========`)
    const history: Array<{ user: string; assistant: string }> = []
    for (let i = 0; i < convo.turns.length; i++) {
      const u = convo.turns[i]
      const { text, ms, events } = await fire(token, u, history.slice())
      const empty = !text || text.trim().length === 0
      const abstain = /\[abstain|i (can'?t|cannot|couldn'?t)|unable to|no verifiable|not able to|i don'?t have enough/i.test(text)
      const tag = empty ? '  ⛔ EMPTY-OUTPUT' : abstain ? '  ⚠ ABSTAIN/REFUSE' : ''
      if (empty) flags.push(`${convo.id} turn${i + 1}: EMPTY`)
      if (abstain) flags.push(`${convo.id} turn${i + 1}: ABSTAIN`)
      console.log(`\n[T${i + 1}] USER: ${u}`)
      console.log(`     (${ms}ms, events: ${events.join(',')})${tag}`)
      console.log(`     ASSISTANT: ${JSON.stringify(text.slice(0, 400))}`)
      history.push({ user: u, assistant: text })
    }
  }
  console.log(`\n\n===== FLAGS (${flags.length}) =====`)
  for (const f of flags) console.log('  •', f)
}
main()

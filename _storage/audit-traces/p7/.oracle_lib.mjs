#!/usr/bin/env node
/**
 * cont.88 A/B — "will the model COPY an identifier out of clean in-context evidence?"
 *
 * Fixture: audit-traces/p4/t9.evidence.txt — the FROZEN cont.82 evidence block. It contains
 * `z.ipv4();` VERBATIM (line 20). The FM cited the right zod page and answered in JSON-Schema
 * + a hand-rolled regex anyway (t9.answer.txt). That is the cont.82 failure.
 *
 * Arms: A = Apple FM (:11435)   B = Bonsai-27B-Q1_0 via PrismML llama-server (:8080)
 * Both speak OpenAI /v1/chat/completions. Same system prompt (verbatim GROUNDING_SYSTEM),
 * same user message shape as groundedAnswer.ts:452, same evidence. Only the model differs.
 *
 * TWO metrics, reported SEPARATELY (conflating them is how the regex oracle lied before):
 *   1. EXTRACTION — did it emit `z.ipv4()`, the identifier sitting in the evidence?
 *   2. EXECUTION  — does its code ACTUALLY accept valid IPv4s and reject invalid ones?
 *      The oracle RUNS the code against real zod 4.4.3. A hand-rolled regex can pass (2)
 *      while failing (1); that distinction is the finding, not a harness bug.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Agent, setGlobalDispatcher } from 'undici'

/**
 * Node's fetch (undici) defaults to a 300s headersTimeout/bodyTimeout. llama-server sends NO
 * headers until a non-streaming generation completes, and Bonsai at ~5.3 tok/s needs ~8min for
 * a 2500-token thinking answer → undici killed the connection ("fetch failed") and the server
 * logged "cancel task". That was CLIENT-side; the model was healthy and mid-generation.
 */
setGlobalDispatcher(new Agent({ headersTimeout: 1_800_000, bodyTimeout: 1_800_000 }))

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const OUT = HERE

const EVIDENCE = readFileSync(join(HERE, '..', 'p4', 't9.evidence.txt'), 'utf8')
const QUESTION = 'Write a Zod schema that validates an IPv4 address'

// verbatim from src/CrucibleEngine/answer/groundedAnswer.ts:386-402
const GROUNDING_SYSTEM =
  "You are Crucible, a private AI assistant running on the user's own device. You have just " +
  'retrieved live web sources to answer the user\'s question. Write a clear, accurate, well-' +
  'structured answer using the EVIDENCE below as your primary source of truth.\n' +
  '- Ground every factual claim in the evidence; do not contradict it and do not invent facts ' +
  'it does not support.\n' +
  '- Cite sources inline with [S1], [S2], … immediately after the claims they support.\n' +
  '- You may use your own knowledge to explain, connect, and add helpful context, but anything ' +
  'the evidence can settle must match the evidence.\n' +
  "- If the evidence doesn't fully answer the question, say what it does establish and what " +
  'remains uncertain — never pad or bluff.\n' +
  '- Be direct and FOCUSED: a tight, information-dense answer (roughly 120-250 words unless the ' +
  'question genuinely needs more). Answer the question asked, then STOP.\n' +
  '- Do NOT append an "Example" section, extra scenarios, or a restated conclusion unless the ' +
  'user explicitly asked for one — that padding is what makes answers run long and get cut off.\n' +
  '- Use markdown structure where it helps. Do not mention "the evidence" as a phrase — just ' +
  'answer and cite.'

const USER_MSG = `Question: ${QUESTION}\n\n## EVIDENCE\n${EVIDENCE}`

/**
 * Bonsai is a REASONING model: it emits chain-of-thought into `message.reasoning_content` and
 * leaves `message.content` EMPTY until thinking completes. The first cut of this harness read
 * only `content` with max_tokens=700 → all 3 runs came back "" with finish_reason=length, and
 * scored as executes=false. That was a FALSE REJECT of an arm that never got to answer.
 * Hence: two Bonsai arms, a bigger think budget, and an explicit truncation guard below.
 */
const ARMS = {
  fm:              { url: 'http://127.0.0.1:11435/v1/chat/completions', model: 'apple-fm', timeoutMs: 300_000, maxTokens: 700,  think: null },
  bonsai_nothink:  { url: 'http://127.0.0.1:8080/v1/chat/completions',  model: 'bonsai',   timeoutMs: 900_000, maxTokens: 700,  think: false },
  bonsai_think:    { url: 'http://127.0.0.1:8080/v1/chat/completions',  model: 'bonsai',   timeoutMs: 1_800_000, maxTokens: 2500, think: true },
}

async function ask(arm, seed) {
  const cfg = ARMS[arm]
  const t0 = Date.now()
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: GROUNDING_SYSTEM },
      { role: 'user', content: USER_MSG },
    ],
    max_tokens: cfg.maxTokens,
    temperature: 0.2,
    seed,
  }
  if (cfg.think === false) body.chat_template_kwargs = { enable_thinking: false }
  const res = await fetch(cfg.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(cfg.timeoutMs),
  })
  const j = await res.json()
  const msg = j?.choices?.[0]?.message ?? {}
  const finish = j?.choices?.[0]?.finish_reason ?? null
  const text = msg.content ?? ''
  const reasoning = msg.reasoning_content ?? ''
  // Guard: an empty answer that ran out of budget is NOT a wrong answer — it is no answer.
  // Never let this score as a model failure again.
  const truncated = !text.trim() && finish === 'length'
  return { text, reasoning, finish, truncated, ms: Date.now() - t0, usage: j?.usage ?? null }
}

/* ---------- metric 1: EXTRACTION (did it copy the identifier?) ---------- */
/**
 * Scored on CODE ONLY. The first cut scored the whole answer and counted `z.ipv4()` written in
 * PROSE while the code block actually said `z.string().ipv4()` — measuring the wrong surface.
 */
function extraction(fullText) {
  const blocks = codeBlocks(fullText)
  // If the answer HAS fences but none survive the code filter (e.g. it answered in pure JSON),
  // there is no code to have copied into — score empty, never fall back to prose.
  const text = blocks.length ? blocks.join('\n') : (/```/.test(fullText) ? '' : fullText)
  return {
    // VERDICT metric — code only. Both forms are in-evidence-faithful zod IP validation;
    // `z.string().ipv4()` is deprecated in zod 4 but VERIFIED working in 4.4.3, so counting
    // it as a fabrication would be a false reject.
    usesZIpv4:      /\bz\s*\.\s*ipv4\s*\(|\.\s*ipv4\s*\(/.test(text),
    // DIAGNOSTIC labels — scored over the FULL answer on purpose. Scoring these code-only made
    // an answer written entirely in a ```json fence report jsonSchema=false, which is exactly
    // backwards. These describe the failure; they are not the verdict.
    mangledZipv4:   /\bzipv4\s*\(/.test(fullText),                   // cont.82's observed mangling
    handRolledRegex: /25\[0-5\]|\[01\]\?\[0-9\]/.test(fullText),     // fabricated octet regex
    jsonSchema:     /json-schema\.org|"\$schema"/.test(fullText),    // the t9 fabrication
    fabricatedZodNs: /\bZod\s*\.\s*Schema\b|import\s*\{\s*Zod\s*\}/.test(fullText),
  }
}

/* ---------- metric 2: EXECUTION (does the code actually work?) ---------- */
const VALID   = ['1.2.3.4', '192.168.1.1', '255.255.255.255', '0.0.0.0']
const INVALID = ['999.1.1.1', '1.2.3', 'abc', '1.2.3.4.5', '256.1.1.1', '']

function codeBlocks(text) {
  const out = []
  for (const m of text.matchAll(/```(\w+)?\n([\s\S]*?)```/g)) {
    const lang = (m[1] || '').toLowerCase()
    if (['json', 'bash', 'sh', 'vue', 'html', 'python'].includes(lang)) continue
    out.push(m[2])
  }
  return out
}

function buildProbe(code) {
  // Strip module plumbing the sandbox supplies or cannot resolve; keep declarations intact.
  const body = code
    .split('\n')
    .filter(l => !/^\s*import\s.+from\s+['"]/.test(l))
    .filter(l => !/^\s*(const|let|var)\s*\{?[\w\s,{}$]*\}?\s*=\s*require\(/.test(l))
    .map(l => l.replace(/^\s*export\s+(default\s+)?/, ''))
    .join('\n')
  const names = [...body.matchAll(/(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1])
  const uniq = [...new Set(names)]
  if (!uniq.length) return null
  return `
import { z } from 'zod'
${body}

const VALID = ${JSON.stringify(VALID)}
const INVALID = ${JSON.stringify(INVALID)}
// An object schema like z.object({ ip: z.ipv4() }) is a CORRECT answer to "a Zod schema that
// validates an IPv4 address" — it just takes { ip: v } rather than a bare string. Testing only
// bare strings falsely rejected it. Unwrap single-key object schemas and test through them.
function objKey(c) {
  const shape = c?.shape ?? c?._def?.shape ?? (typeof c?._def?.shape === 'function' ? c._def.shape() : null)
  const s = typeof shape === 'function' ? shape() : shape
  if (s && typeof s === 'object') { const k = Object.keys(s); if (k.length === 1) return k[0] }
  return null
}
function accepts(c, v) {
  const k = c && typeof c.safeParse === 'function' ? objKey(c) : null
  const wrap = x => (k ? { [k]: x } : x)
  if (c && typeof c.safeParse === 'function') { try { return c.safeParse(wrap(v)).success === true } catch { return false } }
  if (c && typeof c.parse === 'function')     { try { c.parse(wrap(v)); return true } catch { return false } }
  if (typeof c === 'function') { try { const r = c(v); if (r && typeof r.success === 'boolean') return r.success; return !!r } catch { return false } }
  if (c && typeof c.validate === 'function')  { try { const r = c.validate(v); return !!(r && (r.success ?? r.valid ?? r)) } catch { return false } }
  return null
}
const results = []
for (const n of ${JSON.stringify(uniq)}) {
  let c; try { c = eval(n) } catch { continue }
  const okV = VALID.map(v => accepts(c, v)); const okI = INVALID.map(v => accepts(c, v))
  if (okV.includes(null) || okI.includes(null)) { results.push({ name: n, validator: false }); continue }
  results.push({ name: n, validator: true, pass: okV.every(x => x === true) && okI.every(x => x === false), okV, okI })
}
console.log('__PROBE__' + JSON.stringify(results))
`
}

function execute(text, tag) {
  const blocks = codeBlocks(text)
  const attempts = []
  for (let i = 0; i < blocks.length; i++) {
    const probe = buildProbe(blocks[i])
    if (!probe) continue
    const f = join(OUT, `.probe-${tag}-${i}.ts`)
    writeFileSync(f, probe)
    try {
      const raw = execFileSync('npx', ['tsx', f], {
        cwd: REPO, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
      })
      const line = raw.split('\n').find(l => l.startsWith('__PROBE__'))
      const parsed = line ? JSON.parse(line.slice(9)) : []
      attempts.push({ block: i, ran: true, candidates: parsed })
    } catch (e) {
      attempts.push({ block: i, ran: false, error: String(e.stderr || e.message).slice(0, 300) })
    }
  }
  const passed = attempts.some(a => a.ran && a.candidates.some(c => c.validator && c.pass))
  return { executesCorrectly: passed, attempts }
}

export { execute, extraction }
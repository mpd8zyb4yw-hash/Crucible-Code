// Where does a real proposal draw's wall clock actually go?
// Uses the REPO'S OWN buildProposalPrompt so the prompt is byte-faithful to the live loop,
// then posts straight to llama-server and reads its `timings` block.
import { buildProposalPrompt } from './codeProposer'
import { fencedCodeGrammar } from '../agent/grammars'
import type { Attempt, ProposeContext, TaskSpec } from './types'

const URL = 'http://127.0.0.1:8080/v1/chat/completions'
const GRAMMAR = fencedCodeGrammar('typescript')

const spec: TaskSpec = {
  goal:
    'Write compressRuns(s: string): string run-length encoding a string of lowercase letters: ' +
    'each maximal run of the same character becomes that character followed by its run length, ' +
    'but a run of length 1 emits just the character with no number. The empty string maps to the empty string.',
  domain: 'code',
  acceptance: {
    entry: 'compressRuns',
    cases: [
      { args: [''], expected: '' },
      { args: ['a'], expected: 'a' },
      { args: ['aab'], expected: 'a2b' },
      { args: ['aaabccddd'], expected: 'a3bc2d3' },
      { args: ['abcd'], expected: 'abcd' },
      { args: ['aaaaaaaaaaaa'], expected: 'a12' },
    ],
  },
}

const BAD = `export function compressRuns(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    let j = i
    while (j < s.length && s[j] === s[i]) j++
    out += s[i] + (j - i)
    i = j
  }
  return out
}`

const mkAttempt = (code: string, score: number, sig: string): Attempt<string> => ({
  candidate: { value: code, fingerprint: code.slice(0, 24) },
  verdict: { pass: false, score, signals: [sig] },
})

async function post(system: string, user: string, opts: { temperature: number; grammar?: string; maxTokens?: number; cache?: boolean }) {
  const t0 = Date.now()
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: opts.temperature,
      max_tokens: opts.maxTokens ?? 1536,
      cache_prompt: opts.cache ?? true,
      ...(opts.grammar ? { grammar: opts.grammar } : {}),
    }),
  })
  const j: any = await r.json()
  const wall = Date.now() - t0
  const t = j?.timings ?? {}
  return {
    wall,
    promptN: t.prompt_n ?? j?.usage?.prompt_tokens ?? -1,
    promptMs: Math.round(t.prompt_ms ?? -1),
    predN: t.predicted_n ?? j?.usage?.completion_tokens ?? -1,
    predMs: Math.round(t.predicted_ms ?? -1),
    predPerSec: t.predicted_per_second ? Number(t.predicted_per_second).toFixed(1) : '?',
    text: (j?.choices?.[0]?.message?.content ?? '') as string,
  }
}

const row = (label: string, r: Awaited<ReturnType<typeof post>>) =>
  console.log(
    `${label.padEnd(30)} wall ${String((r.wall / 1000).toFixed(1)).padStart(6)}s | ` +
    `prompt ${String(r.promptN).padStart(5)}tok ${String((r.promptMs / 1000).toFixed(1)).padStart(5)}s | ` +
    `gen ${String(r.predN).padStart(5)}tok ${String((r.predMs / 1000).toFixed(1)).padStart(6)}s @ ${r.predPerSec}tok/s`,
  )

async function main() {
  const scenarios: Array<{ label: string; history: Attempt<string>[]; diversify: boolean }> = [
    { label: 'cold (no history)', history: [], diversify: false },
    {
      label: 'repair (1 prior attempt)',
      history: [mkAttempt(BAD, -3, "case compressRuns('a') returned 'a1', expected 'a'")],
      diversify: false,
    },
    {
      label: 'repair (3 prior attempts)',
      history: [
        mkAttempt(BAD, -3, "case compressRuns('a') returned 'a1', expected 'a'"),
        mkAttempt(BAD.replace('while', 'for(;;) //'), -3, "case compressRuns('a') returned 'a1', expected 'a'"),
        mkAttempt(BAD + '\n// v3', -3, "case compressRuns('a') returned 'a1', expected 'a'"),
      ],
      diversify: true,
    },
  ]

  console.log('\n=== A. faithful proposal draws (repo prompt + repo grammar, cache_prompt on) ===\n')
  const built: Array<{ label: string; system: string; user: string; temperature: number }> = []
  for (const s of scenarios) {
    const ctx = { spec, history: s.history, diversify: s.diversify } as ProposeContext<string>
    const p = buildProposalPrompt(ctx)
    built.push({ label: s.label, ...p })
    console.log(`${s.label.padEnd(30)} prompt chars: system ${p.system.length} + user ${p.user.length} = ${p.system.length + p.user.length} (~${Math.round((p.system.length + p.user.length) / 4)} tok), temp ${p.temperature}`)
  }
  console.log()
  for (const b of built) row(b.label, await post(b.system, b.user, { temperature: b.temperature, grammar: GRAMMAR }))

  console.log('\n=== B. what the grammar costs (same prompt, grammar on vs off) ===\n')
  const b0 = built[0]
  row('cold + GBNF grammar', await post(b0.system, b0.user, { temperature: b0.temperature, grammar: GRAMMAR, cache: false }))
  row('cold + NO grammar', await post(b0.system, b0.user, { temperature: b0.temperature, cache: false }))

  console.log('\n=== C. prefix cache: does a repeat draw skip prompt processing? ===\n')
  const b2 = built[2]
  row('3-attempt draw, cache MISS', await post(b2.system, b2.user, { temperature: b2.temperature, grammar: GRAMMAR, cache: false }))
  row('3-attempt draw, cache HIT ', await post(b2.system, b2.user, { temperature: b2.temperature, grammar: GRAMMAR, cache: true }))
  row('3-attempt draw, cache HIT ', await post(b2.system, b2.user, { temperature: b2.temperature, grammar: GRAMMAR, cache: true }))

  console.log('\n=== D. real context limit: does a long prompt truncate at 1024 or 4096? ===\n')
  const filler = 'export function pad(n: number): string { return String(n).padStart(4, "0") }\n'
  for (const target of [900, 1800, 3400]) {
    const big = filler.repeat(Math.ceil((target * 4) / filler.length))
    const r = await post('You are a code generator.', `Ignore this context dump:\n${big}\n\nNow: reply with exactly the word READY and nothing else.`, { temperature: 0.1, maxTokens: 16, cache: false })
    console.log(`  ~${String(target).padStart(4)} tok prompt -> server saw ${String(r.promptN).padStart(5)} prompt tokens, replied ${JSON.stringify(r.text.slice(0, 40))}`)
  }

  console.log('\n=== E. what does a CORRECT answer actually cost to emit? ===\n')
  const r = await post(b0.system, b0.user, { temperature: 0.2, grammar: GRAMMAR, cache: false })
  row('one draw', r)
  console.log('\n--- emitted text ---\n' + r.text.slice(0, 900))
}

main().catch(e => { console.error(e); process.exit(1) })

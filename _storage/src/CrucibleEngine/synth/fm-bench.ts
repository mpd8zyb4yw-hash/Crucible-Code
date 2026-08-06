// ============================================================================
// synth:fm-bench — Phase D FM daemon hardening benchmark.
//
// Measures warm-call p50/p95 latency and per-round repair success rate for
// the on-device Apple FM (port 11435). Run after launchd autostart is wired
// in to verify the daemon is production-ready for Phase E (offline driver).
//
//   npm run synth:fm-bench
//
// Exits 0 if p50 < 2000ms and p95 < 4000ms; non-zero otherwise.
// Does NOT call the external free-tier pool — model-cost-independent.
// ============================================================================
import { fileURLToPath } from 'url'
import path from 'path'

const LOCAL_FM_URL = process.env.LOCAL_INFERENCE_URL ?? 'http://127.0.0.1:11435'

// ── Task suite — representative oracle-gated coding prompts ──────────────────

const TASKS = [
  {
    id: 'add-two',
    system: 'You are a TypeScript code generator. Emit ONLY the TypeScript source, no markdown fences.',
    user:   'Write a TypeScript function `export function add(a: number, b: number): number` that returns a + b.',
  },
  {
    id: 'reverse-str',
    system: 'You are a TypeScript code generator. Emit ONLY the TypeScript source, no markdown fences.',
    user:   'Write `export function reverseString(s: string): string` that returns the characters in reverse order.',
  },
  {
    id: 'is-palindrome',
    system: 'You are a TypeScript code generator. Emit ONLY the TypeScript source, no markdown fences.',
    user:   'Write `export function isPalindrome(s: string): boolean` — true iff s reads the same forwards and backwards (case-sensitive).',
  },
  {
    id: 'fibonacci',
    system: 'You are a TypeScript code generator. Emit ONLY the TypeScript source, no markdown fences.',
    user:   'Write `export function fibonacci(n: number): number` that returns the nth Fibonacci number (0-indexed: fib(0)=0, fib(1)=1).',
  },
  {
    id: 'clamp',
    system: 'You are a TypeScript code generator. Emit ONLY the TypeScript source, no markdown fences.',
    user:   'Write `export function clamp(n: number, min: number, max: number): number` that clamps n to [min, max].',
  },
]

// ── Simple oracle: does the emitted code export the expected function name? ──

function oracleCheck(id: string, code: string): boolean {
  const exportMap: Record<string, string> = {
    'add-two':       'add',
    'reverse-str':   'reverseString',
    'is-palindrome': 'isPalindrome',
    'fibonacci':     'fibonacci',
    'clamp':         'clamp',
  }
  const name = exportMap[id]
  if (!name) return true
  return new RegExp(`\\bexport\\b[^\\n]*\\b${name}\\b`).test(code)
}

// ── Call FM ──────────────────────────────────────────────────────────────────

async function callFm(system: string, user: string): Promise<{ text: string; ms: number }> {
  const t0 = Date.now()
  const res = await fetch(`${LOCAL_FM_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 400,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`FM ${res.status} ${await res.text().catch(() => '')}`)
  const data: any = await res.json()
  const text = String(data.choices?.[0]?.message?.content ?? '')
  return { text, ms: Date.now() - t0 }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Crucible FM bench — Phase D daemon hardening\n')
  console.log(`Endpoint: ${LOCAL_FM_URL}`)

  // Health check
  try {
    const h = await fetch(`${LOCAL_FM_URL}/health`, { signal: AbortSignal.timeout(5_000) })
    const hj: any = await h.json()
    console.log(`Health: ${JSON.stringify(hj)}\n`)
    if (!hj.available) { console.error('FAIL — FM not available'); process.exit(1) }
  } catch (e: any) {
    console.error(`FAIL — FM unreachable: ${e?.message}`)
    console.error('  Start the daemon: ./local-inference/crucible-fm-daemon 11435')
    console.error('  Or load via launchd: launchctl load ~/Library/LaunchAgents/com.crucible.fm-daemon.plist')
    process.exit(1)
  }

  const ROUNDS = 2   // run each task twice for stable p50/p95
  const latencies: number[] = []
  const rows: string[] = []
  let passed = 0, total = 0

  for (const task of TASKS) {
    for (let r = 0; r < ROUNDS; r++) {
      total++
      let text = '', ms = 0, ok = false, err = ''
      try {
        ;({ text, ms } = await callFm(task.system, task.user))
        ok = oracleCheck(task.id, text)
        latencies.push(ms)
      } catch (e: any) {
        err = String(e?.message ?? e).slice(0, 80)
      }
      if (ok) passed++
      rows.push(
        `  ${ok ? 'PASS' : 'FAIL'}  ${task.id.padEnd(16)} r${r + 1}  ${ms ? `${ms}ms` : `ERROR: ${err}`}${ok ? '' : `\n         emitted: ${text.slice(0, 80).replace(/\n/g, '↵')}`}`
      )
    }
  }

  console.log(rows.join('\n'))

  latencies.sort((a, b) => a - b)
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0
  const min = latencies[0] ?? 0
  const max = latencies[latencies.length - 1] ?? 0

  console.log(`
┌─ FM bench RESULT ──────────────────────────────────────────────────┐
│  Oracle pass: ${String(passed).padStart(2)}/${total}   p50: ${p50}ms   p95: ${p95}ms   min: ${min}ms   max: ${max}ms
└────────────────────────────────────────────────────────────────────┘`)

  const P50_TARGET = 2000, P95_TARGET = 4000
  if (p50 > P50_TARGET || p95 > P95_TARGET) {
    console.error(`\nFAIL — latency exceeds target (p50 < ${P50_TARGET}ms, p95 < ${P95_TARGET}ms).`)
    console.error('  Ensure the daemon is warm (launchd keeps it resident). Cold start pays ~2.4s.')
    process.exit(1)
  }
  if (passed < total) {
    console.warn(`\nWARN — ${total - passed} calls failed oracle. FM is warm but output quality degraded.`)
  }
  console.log(`\nPASS — FM daemon production-ready. p50=${p50}ms p95=${p95}ms oracle=${passed}/${total}.`)
}

main()

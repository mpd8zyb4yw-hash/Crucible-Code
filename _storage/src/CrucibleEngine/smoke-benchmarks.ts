// Smoke benchmark suite — the audit's automated regression guard.
// Run with: npm run smoke   (requires the server running on :3001)
//
// WHY THIS EXISTS: the June 13 2026 audit found a TDZ ReferenceError that made the
// pipeline unreachable on EVERY non-conversational request, undetected for hours. A
// 2-minute smoke run after each session would have caught it immediately. Run this
// before marking any track complete.
//
// Two named benchmarks:
//   1. Neuromorphic (quantitative) — L2 fires, 7 subtasks via parenthetical (1)(2)
//      numbering, completes < 4 min, no 413 errors, all 7 topic areas present.
//   2. Consciousness / self-reference (qualitative) — genuine ensemble disagreement,
//      confidence tier MEDIUM or lower, H4 fragility assumption present, Critic flag.
//
// Criteria are tagged HARD (deterministic — a failure is a real regression) or SOFT
// (pool-dependent — may fail on a degraded free-tier pool, reported but does not fail
// the suite). HARD failures set a non-zero exit code.

import { extractSubtasks } from './goalDecomposer'

const API = process.env.CRUCIBLE_API ?? 'http://localhost:3001'

let hardFailures = 0
let softFailures = 0
const check = (kind: 'HARD' | 'SOFT', label: string, cond: boolean, detail = '') => {
  const tag = cond ? 'PASS' : 'FAIL'
  console.log(`  [${kind}] ${tag} — ${label}${cond ? '' : '  :: ' + detail}`)
  if (!cond) { kind === 'HARD' ? hardFailures++ : softFailures++ }
}

interface FireResult {
  events: any[]
  synthesis: string
  sawErrorEvent: boolean
  saw413: boolean
  done: boolean
  elapsedMs: number
}

// Fire a prompt at /api/chat, collect SSE events, the final synthesis text, and any
// 413 / error signals. Times out after timeoutMs.
async function firePrompt(message: string, timeoutMs: number): Promise<FireResult> {
  const t0 = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const events: any[] = []
  let synthesis = ''
  let sawErrorEvent = false
  let saw413 = false
  let done = false
  try {
    const res = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, mode: 'full', device: 'desktop' }),
      signal: ctrl.signal,
    })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    outer: while (true) {
      const { done: rdone, value } = await reader.read()
      if (rdone) break
      buf += decoder.decode(value, { stream: true })
      const chunks = buf.split('\n\n')
      buf = chunks.pop() ?? ''
      for (const chunk of chunks) {
        const line = chunk.split('\n').find(l => l.startsWith('data: '))
        if (!line) continue
        const payload = line.slice(6).trim()
        if (payload === '[DONE]') { done = true; break outer }
        if (/\b413\b|request too large|too large/i.test(payload)) saw413 = true
        try {
          const ev = JSON.parse(payload)
          events.push(ev)
          if (ev.type === 'error') sawErrorEvent = true
          if (ev.type === 'synthesis' && typeof ev.text === 'string') {
            synthesis = ev.replace ? ev.text : synthesis + ev.text
          }
        } catch { /* non-JSON keepalive line */ }
      }
    }
  } catch (e: any) {
    if (e?.name !== 'AbortError') throw e
  } finally {
    clearTimeout(timer)
  }
  return { events, synthesis, sawErrorEvent, saw413, done, elapsedMs: Date.now() - t0 }
}

// Pull recent debug-bus events (the pipeline's internal record).
async function debugEvents(): Promise<any[]> {
  try {
    // Request the full ring (n=500) — a single benchmark request can emit >100 events
    // (L2 sections + full-pipeline fallback), which would evict l2_decomposed at n=100.
    const res = await fetch(`${API}/api/debug/history?n=500`)
    const data: any = await res.json()
    return data.events ?? []
  } catch { return [] }
}

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/api/debug/history`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch { return false }
}

const NEURO = 'Give me a comprehensive analysis of neuromorphic computing: (1) fundamental principles and how it differs from von Neumann architecture, (2) current hardware implementations (Intel Loihi, IBM TrueNorth, BrainScaleS), (3) programming models and frameworks, (4) performance benchmarks vs. GPU/CPU for specific workloads, (5) current limitations and open research problems, (6) commercial applications and timeline to practical deployment, (7) comparison of leading research groups and their architectural approaches.'

const CONSCIOUSNESS = 'Is it possible to build a genuinely conscious AI, and how would we know if we had succeeded? Address the hard problem of consciousness directly and do not hedge with generic disclaimers.'

// The 7 neuromorphic topic areas, each with keywords that should appear if the answer
// actually covered that section (robust to L2 fast-path vs full-pipeline fallback).
const NEURO_TOPICS: [string, RegExp][] = [
  ['fundamental principles / von Neumann', /von neumann|spiking|neuromorphic principle|in-memory/i],
  ['hardware implementations',             /loihi|truenorth|brainscales|spinnaker/i],
  ['programming models / frameworks',      /programming model|framework|lava|nengo|snn/i],
  ['performance benchmarks vs GPU/CPU',    /benchmark|gpu|cpu|energy|throughput|latency/i],
  ['limitations / open problems',          /limitation|open (problem|research|question)|challenge/i],
  ['commercial applications / timeline',   /commercial|deployment|timeline|industry|adoption/i],
  ['research groups / approaches',         /research group|intel|ibm|heidelberg|manchester|approach/i],
]

async function runNeuromorphic() {
  console.log('\n=== BENCHMARK 1: Neuromorphic computing (quantitative) ===')

  // Unit: decomposition is deterministic — must always detect 7 via (1)(2) numbering.
  const subs = extractSubtasks(NEURO, { min: 3 })
  check('HARD', '7 subtasks detected via parenthetical (1)(2) numbering', subs.length === 7, `got ${subs.length}`)

  const TIMEOUT = 4 * 60 * 1000  // 4 minutes
  const r = await firePrompt(NEURO, TIMEOUT + 15000)

  check('HARD', 'request completed with [DONE]', r.done, `events=${r.events.length} elapsed=${(r.elapsedMs / 1000).toFixed(0)}s`)
  check('HARD', 'completed in under 4 minutes', r.done && r.elapsedMs < TIMEOUT, `${(r.elapsedMs / 1000).toFixed(0)}s`)
  check('HARD', 'no 413 / request-too-large error', !r.saw413, 'saw a 413 signal in the stream')
  check('HARD', 'no error event emitted', !r.sawErrorEvent)

  const dbg = await debugEvents()
  const l2 = dbg.find(e => e.type === 'l2_decomposed')
  check('HARD', 'L2 fired (l2_decomposed event)', !!l2, 'no l2_decomposed in debug history')
  check('HARD', 'L2 detected 7 subtasks', l2?.data?.subtaskCount === 7, `subtaskCount=${l2?.data?.subtaskCount}`)

  // Semantic coverage — robust to L2 fast-path OR full-pipeline fallback.
  const covered = NEURO_TOPICS.filter(([, re]) => re.test(r.synthesis))
  check('SOFT', 'all 7 topic areas present in output', covered.length === 7,
    `covered ${covered.length}/7: missing ${NEURO_TOPICS.filter(t => !covered.includes(t)).map(t => t[0]).join('; ') || 'none'}`)
}

async function runConsciousness() {
  console.log('\n=== BENCHMARK 2: Consciousness / self-reference (qualitative) ===')

  const r = await firePrompt(CONSCIOUSNESS, 4 * 60 * 1000)
  check('HARD', 'request completed with [DONE]', r.done, `elapsed=${(r.elapsedMs / 1000).toFixed(0)}s`)
  check('HARD', 'no error event emitted', !r.sawErrorEvent)

  // Confidence event carries tier, fragility assumption.
  const conf = [...r.events].reverse().find(e => e.type === 'confidence')
  const tier = conf?.overallTier ?? 'UNKNOWN'
  check('SOFT', 'confidence tier MEDIUM or lower', ['MEDIUM', 'LOW', 'UNVERIFIED'].includes(tier), `tier=${tier}`)
  check('SOFT', 'H4 fragility assumption present', !!conf?.fragilityAssumption,
    conf?.fragilityAssumption ? '' : 'no fragilityAssumption on confidence event')

  const dbg = await debugEvents()
  // Ensemble disagreement — score spread across models indicates genuine debate.
  const scoresEvent = [...r.events].reverse().find(e => e.type === 'scores')
  const scoreVals: number[] = scoresEvent ? Object.values(scoresEvent.scores ?? {}).map(Number).filter(n => n > 0) : []
  const spread = scoreVals.length >= 2 ? Math.max(...scoreVals) - Math.min(...scoreVals) : 0
  check('SOFT', 'genuine ensemble disagreement (score spread > 0.15)', spread > 0.15,
    scoreVals.length >= 2 ? `spread=${spread.toFixed(2)} across ${scoreVals.length} models` : `only ${scoreVals.length} model(s) scored (degraded pool?)`)

  // Critic flag — I5 runs after polish; emits critic_findings when it flags something.
  const critic = dbg.some(e => e.type === 'critic_findings')
  check('SOFT', 'Critic flag present (critic_findings event)', critic,
    'no critic_findings — Critic found nothing or did not run')
}

async function main() {
  console.log('Crucible smoke benchmark suite')
  console.log(`Target: ${API}`)

  if (!(await serverUp())) {
    console.error(`\nFAIL — server not reachable at ${API}. Start it first:\n  nohup npx tsx server.ts > /tmp/crucible-server.log 2>&1 < /dev/null & disown`)
    process.exit(2)
  }

  await runNeuromorphic()
  await runConsciousness()

  console.log('\n=== SUMMARY ===')
  console.log(`HARD failures: ${hardFailures}  (deterministic — any failure is a real regression)`)
  console.log(`SOFT failures: ${softFailures}  (pool-dependent — expected on a degraded free-tier pool)`)
  if (hardFailures > 0) {
    console.error('\nSMOKE SUITE FAILED — a deterministic guarantee is broken. Do not mark tracks complete.')
    process.exit(1)
  }
  console.log('\nSMOKE SUITE PASSED (hard criteria). Review soft criteria for pool health.')
  process.exit(0)
}

main().catch(e => { console.error('smoke suite crashed:', e); process.exit(3) })

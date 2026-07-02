// Proof harness for the pure-code synthesis engine. Runs each benchmark spec through
// `synthesize()` — ZERO model inference, model-cost-independent, deterministic — writes the emitted
// module, and audits it with the SAME hidden adversarial suite the LLM agent is graded on.
// If these go green, Crucible wrote correct code for these tasks with no model at all.
//
// Run: npm run synth:prove          (or: npx tsx src/CrucibleEngine/synth/synth-prove.ts)

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { synthesize, listSkills } from './index'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HIDDEN_DIR = path.resolve(HERE, '..', 'coding-bench')   // src/CrucibleEngine/coding-bench
const OUT_ROOT = path.join(os.tmpdir(), 'crucible-synth-proof')

// Specs mirror the LLM coding benchmark (coding-benchmarks.ts): exact file path + exact
// export contract + the behavioral keywords the matcher keys on. NOT the implementations —
// the engine must synthesize those from its verified primitives.
const SPECS: Array<{ id: string; spec: string }> = [
  {
    id: 'kvstore',
    spec: `Implement a persistent key-value store at src/kvstore.ts.
export class KVStore { constructor(opts:{maxEntries:number;walPath:string}); set(key:string,value:string,ttlMs?:number):void; get(key:string):string|undefined; delete(key:string):boolean; size():number; close():void }
Requirements: LRU eviction capped at maxEntries (get refreshes recency), per-key TTL expiry, a write-ahead log persisted to walPath, and crash recovery that replays the WAL on construction.`,
  },
  {
    id: 'ratelimiter',
    spec: `Implement rate limiters at src/ratelimiter.ts.
export class TokenBucket { constructor(capacity:number,refillPerSec:number,now?:()=>number); tryRemove(tokens?:number):boolean }
export class SlidingWindowLimiter { constructor(limit:number,windowMs:number,now?:()=>number); allow(key:string):boolean }
Token bucket refills over time capped at capacity; sliding window allows limit requests per rolling windowMs, per key; both use the injected now() clock.`,
  },
  {
    id: 'scheduler',
    spec: `Implement a topological-sort task scheduler with cycle detection at src/scheduler.ts.
export function topoSort(nodes:string[], edges:[string,string][]):string[]  // edge [a,b] => a before b; throws on a cycle; includes disconnected nodes
export function findCycle(nodes:string[], edges:[string,string][]):string[]|null  // returns a cycle path or null; a self-loop counts`,
  },
  {
    id: 'regex',
    spec: `Implement a mini backtracking regex engine at src/regex.ts.
export function regexMatch(pattern:string, text:string):boolean  // full match
Support literals, '.', '*', '+', '?', character classes [abc] and [a-z], and backslash escaping.`,
  },
]

function runHidden(id: string, dir: string): { ok: boolean; detail: string } {
  const hiddenSrc = path.join(HIDDEN_DIR, `${id}.hidden.ts`)
  if (!fs.existsSync(hiddenSrc)) return { ok: false, detail: 'no hidden suite' }
  const auditDir = path.join(dir, '__audit__')
  fs.mkdirSync(auditDir, { recursive: true })
  const dst = path.join(auditDir, `${id}.hidden.ts`)
  fs.copyFileSync(hiddenSrc, dst)
  const r = spawnSync('npx', ['tsx', dst], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const tail = out.split('\n').filter(l => /PASS|FAIL|ALL PASS|FAILURE|Error/.test(l)).slice(-4).join(' | ')
  return { ok: r.status === 0, detail: tail || out.slice(0, 160) }
}

function main() {
  console.log('Crucible PURE-CODE synthesis proof — zero model inference, model-cost-independent\n')
  console.log(`Verified primitives in library: ${listSkills().map(s => s.id).join(', ')}\n`)
  let green = 0
  const rows: string[] = []
  for (const { id, spec } of SPECS) {
    const t0 = process.hrtime.bigint()
    const result = synthesize(spec)
    const synthUs = Number(process.hrtime.bigint() - t0) / 1000
    if (!result.matched) {
      rows.push(`  RED   ${id.padEnd(12)} NO-MATCH (honest escalate) — top: ${result.ranking.slice(0, 2).map(r => `${r.id}:${r.score.toFixed(2)}`).join(', ')}`)
      continue
    }
    const dir = path.join(OUT_ROOT, id)
    fs.rmSync(dir, { recursive: true, force: true })
    for (const f of result.files) {
      const abs = path.join(dir, f.path)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, f.content)
    }
    const audit = runHidden(id, dir)
    if (audit.ok) green++
    rows.push(`  ${audit.ok ? 'GREEN' : ' RED '} ${id.padEnd(12)} via ${result.matched.id} (conf ${result.confidence.toFixed(2)}, synth ${synthUs.toFixed(0)}µs) :: ${audit.detail}`)
  }
  console.log(rows.join('\n'))
  console.log(`\nHidden adversarial suites passed: ${green}/${SPECS.length} — with ZERO model calls.`)
  process.exit(green === SPECS.length ? 0 : 1)
}

main()

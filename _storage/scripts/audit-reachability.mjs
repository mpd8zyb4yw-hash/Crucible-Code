// Transitive import closure from server.ts — what is ACTUALLY reachable on a live request,
// versus what merely exists in the repo. No judgement, just the import graph.
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const seen = new Set()
const stack = [path.join(ROOT, 'server.ts')]

function resolve(spec, from) {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(from), spec)
  for (const c of [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  }
  return null
}

while (stack.length) {
  const f = stack.pop()
  if (seen.has(f)) continue
  seen.add(f)
  let src
  try { src = fs.readFileSync(f, 'utf8') } catch { continue }
  const specs = [...src.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map(m => m[1])
  for (const s of specs) {
    const r = resolve(s, f)
    if (r) stack.push(r)
  }
}

// Every source file under src/ + top-level engine files, excluding UI and benches/tests.
const all = []
const walk = d => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) { if (!/node_modules|assets/.test(p)) walk(p) }
    else if (/\.tsx?$/.test(e.name)) all.push(p)
  }
}
walk(path.join(ROOT, 'src'))

const isEngine = p => p.includes('/CrucibleEngine/') || p.includes('/server/')
const isBench = p => /__|\.test\.|bench|smoke-|prove-|-runner/.test(path.basename(p))
const engine = all.filter(p => isEngine(p) && !isBench(p) && !p.includes('/synth/skills/') && !p.includes('/synth/catalogs/'))

const live = engine.filter(p => seen.has(p))
const dead = engine.filter(p => !seen.has(p))

// Group dead modules by subsystem directory to make the shape legible.
const byDir = {}
for (const p of dead) {
  const d = path.dirname(p).replace(ROOT + '/src/CrucibleEngine/', '').replace(ROOT + '/src/', '')
  ;(byDir[d] ??= []).push(path.basename(p))
}

console.log(`ENGINE MODULES: ${engine.length}`)
console.log(`REACHABLE from server.ts: ${live.length} (${Math.round(live.length / engine.length * 100)}%)`)
console.log(`NOT reachable:            ${dead.length} (${Math.round(dead.length / engine.length * 100)}%)`)
console.log(`\n--- NOT reachable, by subsystem (count: files) ---`)
for (const [d, fs_] of Object.entries(byDir).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${String(fs_.length).padStart(3)}  ${d}/`)
  if (fs_.length <= 6) console.log(`     ${fs_.join(', ')}`)
}

// Specific claims the ROADMAP makes about live-wiring — verify each mechanically.
console.log(`\n--- ROADMAP live-wiring claims (2026-07-03 correction) ---`)
for (const n of ['nodeExecutor.ts', 'capabilityRouter.ts', 'decompositionDag.ts', 'planner.ts', 'loop.ts', 'applyLayer.ts']) {
  const hit = [...seen].find(p => path.basename(p) === n)
  const exists = all.find(p => path.basename(p) === n)
  console.log(`  ${n.padEnd(22)} exists=${!!exists}  reachable=${!!hit}`)
}

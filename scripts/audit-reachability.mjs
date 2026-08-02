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
  const note = !exists ? '   <- FILE NO LONGER EXISTS; any ROADMAP [x] for it is stale' : ''
  console.log(`  ${n.padEnd(22)} exists=${!!exists}  reachable=${!!hit}${note}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// SYMBOL-LEVEL LIVENESS — added 2026-08-02 because the file-level number above is an
// OVERESTIMATE, and the gap is not academic: it hid a two-week measurement error.
//
// `reasoning/solve.ts` counts as "reachable" only because server.ts imports `selectBestEffort`
// from `reasoning/keepK.ts`, and keepK happens to import solve in the same FILE. The import graph
// therefore reaches solve.ts while no live code path ever calls `solveCodeTask`. A whole
// subsystem can be optimised for weeks and score as wired, because one unrelated helper next
// door is used.
//
// So: a module is honestly live only if some LIVE, NON-BENCH file imports a symbol from it AND
// references that symbol. That is what this section measures.
//
// LIMITS, stated so this number is not over-trusted in turn: it reads named `import { a, b }`
// bindings only, so default imports, `import * as ns`, re-exports and dynamic `await import()`
// are invisible to it. It is a LOWER bound on deadness — a symbol it flags may still be reached
// by one of those forms, so confirm a flag by hand before deleting anything.
// ─────────────────────────────────────────────────────────────────────────────
const liveFiles = engine.filter(p => seen.has(p) && !isBench(p))

/** (resolved module) -> Set of symbols some live non-bench file imports AND references. */
const usedSymbols = new Map()
for (const f of [path.join(ROOT, 'server.ts'), ...liveFiles]) {
  let src
  try { src = fs.readFileSync(f, 'utf8') } catch { continue }
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = resolve(m[2], f)
    if (!target) continue
    for (const raw of m[1].split(',')) {
      // `foo as bar` — the local binding is what the body references.
      const parts = raw.replace(/\btype\b/, '').trim().split(/\s+as\s+/)
      const exported = parts[0]?.trim(), local = (parts[1] ?? parts[0])?.trim()
      if (!exported || !local) continue
      // Imported but never referenced in the body is a dead import, not a use.
      const uses = [...src.matchAll(new RegExp(`\\b${local.replace(/[^\w$]/g, '')}\\b`, 'g'))].length
      if (uses < 2) continue
      ;(usedSymbols.get(target) ?? usedSymbols.set(target, new Set()).get(target)).add(exported)
    }
  }
}

/** Exported function/const names declared in a file. */
const exportsOf = src => [
  ...src.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/g),
].map(m => m[1])

console.log(`\n--- SYMBOL-LEVEL: engine entry points with NO live caller ---`)
const orphanedExports = []
for (const p of liveFiles) {
  let src
  try { src = fs.readFileSync(p, 'utf8') } catch { continue }
  const declared = exportsOf(src)
  if (!declared.length) continue
  const used = usedSymbols.get(p) ?? new Set()
  const orphans = declared.filter(s => !used.has(s))
  if (orphans.length === declared.length && declared.length > 0) {
    orphanedExports.push({ file: p.replace(ROOT + '/src/CrucibleEngine/', ''), n: declared.length, sample: declared.slice(0, 3) })
  }
}
orphanedExports.sort((a, b) => b.n - a.n)
console.log(`  ${orphanedExports.length} file(s) are import-reachable but export NOTHING any live file uses:`)
for (const o of orphanedExports.slice(0, 20)) {
  console.log(`   ${String(o.n).padStart(3)} unused export(s)  ${o.file}  (${o.sample.join(', ')}${o.n > 3 ? ', …' : ''})`)
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSITIVE SYMBOL LIVENESS. "Some live FILE calls it" is not good enough, and the first draft
// of this very section proved it: `solveCodeTask` reported LIVE because `keepK.ts` calls it,
// while keepK's own entry `solveWithKeptCandidates` has no caller at all. A dead chain reports
// as live at every link if you only look one hop.
//
// So liveness is propagated from a single root — server.ts, the process the user actually runs.
// A symbol is live iff it is referenced by the body of an already-live symbol. Function bodies
// are sliced by brace matching, which is why this is an approximation and not a compiler; it is
// still strictly better than the one-hop check it replaces.
// ─────────────────────────────────────────────────────────────────────────────

/** Slice `name`'s body out of `src` by matching braces from its declaration. */
function bodyOf(src, name) {
  const decl = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class)\\s+${name}\\b`).exec(src)
  if (!decl) return ''
  let i = src.indexOf('{', decl.index)
  if (i < 0) return ''
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1)
  }
  return src.slice(i)
}

/** file -> Map<localName, {module, exported}> for every named import binding. */
const importsOf = new Map()
for (const f of [path.join(ROOT, 'server.ts'), ...liveFiles]) {
  let src; try { src = fs.readFileSync(f, 'utf8') } catch { continue }
  const m2 = new Map()
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = resolve(m[2], f)
    if (!target) continue
    for (const raw of m[1].split(',')) {
      const parts = raw.replace(/\btype\b/, '').trim().split(/\s+as\s+/)
      const exported = parts[0]?.trim(), local = (parts[1] ?? parts[0])?.trim()
      if (exported && local) m2.set(local, { module: target, exported })
    }
  }
  importsOf.set(f, m2)
}

const liveSyms = new Set()          // "file::symbol"
const serverFile = path.join(ROOT, 'server.ts')
const queue = []
{
  // Root: the whole of server.ts counts as one live body.
  const src = fs.readFileSync(serverFile, 'utf8')
  queue.push({ file: serverFile, body: src })
}
while (queue.length) {
  const { file, body } = queue.pop()
  for (const [local, { module, exported }] of importsOf.get(file) ?? []) {
    if (!new RegExp(`\\b${local.replace(/[^\w$]/g, '')}\\b`).test(body)) continue
    const key = `${module}::${exported}`
    if (liveSyms.has(key)) continue
    liveSyms.add(key)
    let msrc; try { msrc = fs.readFileSync(module, 'utf8') } catch { continue }
    const b = bodyOf(msrc, exported)
    if (b) queue.push({ file: module, body: b })
  }
}

console.log(`\n--- DOCTRINE ENTRY POINTS: transitively live from server.ts? ---`)
for (const sym of ['solveCodeTask', 'solveWithKeptCandidates', 'iterate', 'synthesizeUniversal', 'synthesizePureCode', 'driveTurn', 'classify']) {
  const hits = [...liveSyms].filter(k => k.endsWith(`::${sym}`))
  const verdict = hits.length
    ? `LIVE  (${hits.map(h => path.relative(ROOT, h.split('::')[0])).join(', ')})`
    : 'NO LIVE PATH from server.ts — research-only'
  console.log(`  ${sym.padEnd(24)} ${verdict}`)
}
console.log(`\n  ${liveSyms.size} exported symbol(s) are transitively reachable from server.ts.`)

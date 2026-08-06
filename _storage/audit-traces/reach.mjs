// Reachability audit: build the real import graph and classify every module in the
// target dirs as live (reachable from server.ts) / bench-only / orphaned.
//
// "Live" = transitively imported from server.ts through NON-bench modules. Bench files are
// the __*.ts / *-bench.ts / *_bench.ts prefixed harnesses; an edge THROUGH a bench file does
// not make a module live, it makes it bench-reachable.
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(process.argv[2] ?? '.')
const DIRS = ['reasoning', 'agent', 'synth', 'retrieval', 'research', 'answer']
  .map(d => path.join(ROOT, 'src/CrucibleEngine', d))

const isBench = p => /(^|\/)__|_bench\.ts$|-bench\.ts$|\.test\.ts$|\/__tests__\//.test(p)

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null                    // package import
  const base = path.resolve(path.dirname(fromFile), spec)
  const cands = /\.(ts|tsx|js|mjs|cjs)$/.test(base)
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
  for (const c of cands) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  return null
}

function importsOf(file) {
  let src = ''
  try { src = fs.readFileSync(file, 'utf-8') } catch { return [] }
  const out = new Set()
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3]
    if (!spec) continue
    const r = resolveImport(file, spec)
    if (r) out.add(r)
  }
  return [...out]
}

// ── walk from server.ts, refusing to traverse INTO bench files ────────────────
function reachableFrom(entries, { throughBench }) {
  const seen = new Set()
  const q = [...entries]
  while (q.length) {
    const f = q.pop()
    if (seen.has(f)) continue
    seen.add(f)
    if (!throughBench && isBench(f)) continue      // do not expand a bench node
    for (const n of importsOf(f)) if (!seen.has(n)) q.push(n)
  }
  return seen
}

const SERVER = path.join(ROOT, 'server.ts')
const live = reachableFrom([SERVER], { throughBench: false })

// every bench file in the repo
const allFiles = []
;(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'audit-traces', '.crucible'].includes(e.name)) continue
    const p = path.join(d, e.name)
    e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) && allFiles.push(p)
  }
})(path.join(ROOT, 'src'))
allFiles.push(SERVER)

const benchEntries = allFiles.filter(isBench)
const benchReach = reachableFrom(benchEntries, { throughBench: true })

const rows = []
for (const dir of DIRS) {
  if (!fs.existsSync(dir)) continue
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !/\.(ts|tsx)$/.test(e.name)) continue
    const p = path.join(dir, e.name)
    const loc = fs.readFileSync(p, 'utf-8').split('\n').length
    const bench = isBench(p)
    const isLive = live.has(p)
    const inBench = benchReach.has(p)
    rows.push({
      dir: path.basename(dir),
      file: e.name,
      loc,
      bench,
      live: isLive,
      benchOnly: !isLive && inBench,
      orphan: !isLive && !inBench,
    })
  }
}

const fmt = n => String(n).padStart(5)
console.log('| dir | file | LOC | live? | bench-only? | orphan? |')
console.log('|---|---|---:|---|---|---|')
for (const r of rows.sort((a, b) => a.dir.localeCompare(b.dir) || a.file.localeCompare(b.file))) {
  console.log(`| ${r.dir} | ${r.file}${r.bench ? ' *(bench)*' : ''} | ${r.loc} | ${r.live ? '**yes**' : 'no'} | ${r.benchOnly ? 'yes' : '—'} | ${r.orphan ? '**YES**' : '—'} |`)
}

console.log('\n\n### Totals by directory (production modules only — bench harness files excluded)\n')
console.log('| dir | files | LOC total | LOC live | LOC bench-only | LOC orphan | % live |')
console.log('|---|---:|---:|---:|---:|---:|---:|')
let g = { n: 0, loc: 0, l: 0, b: 0, o: 0 }
for (const d of DIRS.map(x => path.basename(x))) {
  const rs = rows.filter(r => r.dir === d && !r.bench)
  if (!rs.length) continue
  const loc = rs.reduce((s, r) => s + r.loc, 0)
  const l = rs.filter(r => r.live).reduce((s, r) => s + r.loc, 0)
  const b = rs.filter(r => r.benchOnly).reduce((s, r) => s + r.loc, 0)
  const o = rs.filter(r => r.orphan).reduce((s, r) => s + r.loc, 0)
  g.n += rs.length; g.loc += loc; g.l += l; g.b += b; g.o += o
  console.log(`| ${d} | ${rs.length} | ${loc} | ${l} | ${b} | ${o} | ${Math.round(l / loc * 100)}% |`)
}
console.log(`| **TOTAL** | **${g.n}** | **${g.loc}** | **${g.l}** | **${g.b}** | **${g.o}** | **${Math.round(g.l / g.loc * 100)}%** |`)

const benchLoc = rows.filter(r => r.bench).reduce((s, r) => s + r.loc, 0)
console.log(`\nBench harness files themselves: ${rows.filter(r => r.bench).length} files, ${benchLoc} LOC (excluded from the % above).`)

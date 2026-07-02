// Variance aggregator: reads N mathfact run JSONs (/tmp/mathfact-var-run*.json) and reports
// per-prompt pass-stability (which prompts FLIP pass/fail across runs) plus a confidence band
// on the composite pass/coverage numbers. This is the artifact that answers the strict-default
// question — a point estimate (0.91/0.96) cannot, because strict shows real run-to-run variance.
import fs from 'fs'

const files = process.argv.slice(2)
if (files.length < 2) { console.error('usage: tsx __mathfact_variance.ts run1.json run2.json ...'); process.exit(1) }
const runs = files.map(f => JSON.parse(fs.readFileSync(f, 'utf8')))
const N = runs.length

// per-prompt: collect pass[] and one captured text per run for diagnosis of flips
const byId: Record<string, { cat: string; passes: boolean[]; covs: number[]; texts: string[] }> = {}
for (const run of runs) {
  for (const r of run.rows) {
    byId[r.id] ??= { cat: r.cat, passes: [], covs: [], texts: [] }
    byId[r.id].passes.push(!!r.pass)
    byId[r.id].covs.push(r.cov)
    byId[r.id].texts.push((r.text ?? '').replace(/\s+/g, ' ').slice(0, 160))
  }
}

const ids = Object.keys(byId)
const stable = { passAll: 0, failAll: 0, flip: 0 }
const flippers: any[] = []
for (const id of ids) {
  const p = byId[id].passes
  const nPass = p.filter(Boolean).length
  if (nPass === N) stable.passAll++
  else if (nPass === 0) stable.failAll++
  else { stable.flip++; flippers.push({ id, cat: byId[id].cat, pattern: p.map(x => x ? 'Y' : 'n').join(''), nPass: `${nPass}/${N}`, texts: byId[id].texts }) }
}

// composite pass-rate per run + mean/spread (Wald-ish band over the per-run rates)
const perRunPass = runs.map(r => r.overall.passRate)
const perRunCov = runs.map(r => r.overall.avgCov)
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))) }
const band = (a: number[]) => `${mean(a).toFixed(3)} ± ${sd(a).toFixed(3)}  [min ${Math.min(...a)}, max ${Math.max(...a)}]`

console.log(`\n=== VARIANCE over N=${N} runs (${ids.length} prompts each) ===`)
console.log(`per-run passRate: ${JSON.stringify(perRunPass)}`)
console.log(`per-run avgCov:   ${JSON.stringify(perRunCov)}`)
console.log(`\ncomposite passRate: ${band(perRunPass)}`)
console.log(`composite avgCov:   ${band(perRunCov)}`)
console.log(`\nper-prompt stability: ${stable.passAll} always-pass, ${stable.failAll} always-fail, ${stable.flip} FLIPPED`)
console.log(`\n--- FLIPPERS (pass/fail not constant across runs) ---`)
for (const f of flippers.sort((a, b) => a.id.localeCompare(b.id))) {
  console.log(`\n${f.id} [${f.cat}] ${f.pattern} (${f.nPass})`)
  f.texts.forEach((t: string, i: number) => console.log(`   run${i + 1}: ${t}`))
}
fs.writeFileSync('/tmp/mathfact-variance.json', JSON.stringify({ N, perRunPass, perRunCov, stable, flippers }, null, 2))
console.log(`\nwrote /tmp/mathfact-variance.json`)

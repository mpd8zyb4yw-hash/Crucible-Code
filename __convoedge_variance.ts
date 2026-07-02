// Variance aggregator for the conversational+edge sweep — same pattern as __mathfact_variance.ts
// (per-prompt pass-stability / flippers + composite band), PLUS per-category confidence bands
// (general/definition/abstain/explain/reasoning/false-premise/clarify) which the convoedge decision
// needs. Reads N convoedge run JSONs from argv. Row shape is identical to the mathfact runner.
import fs from 'fs'

const files = process.argv.slice(2)
if (files.length < 2) { console.error('usage: tsx __convoedge_variance.ts run1.json run2.json ...'); process.exit(1) }
const runs = files.map(f => JSON.parse(fs.readFileSync(f, 'utf8')))
const N = runs.length

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

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))) }
const band = (a: number[]) => `${mean(a).toFixed(3)} ± ${sd(a).toFixed(3)}  [min ${Math.min(...a)}, max ${Math.max(...a)}]`

const perRunPass = runs.map(r => r.overall.passRate)
const perRunCov = runs.map(r => r.overall.avgCov)

// per-category: pull each run's byCategory.passRate / avgCov into arrays, band across runs
const cats = Array.from(new Set(runs.flatMap((r: any) => Object.keys(r.byCategory))))
const perCat: Record<string, { passRates: number[]; covs: number[] }> = {}
for (const c of cats) {
  perCat[c] = {
    passRates: runs.map((r: any) => r.byCategory[c]?.passRate ?? NaN).filter((x: number) => !Number.isNaN(x)),
    covs: runs.map((r: any) => r.byCategory[c]?.avgCov ?? NaN).filter((x: number) => !Number.isNaN(x)),
  }
}

console.log(`\n=== CONVOEDGE VARIANCE over N=${N} runs (${ids.length} prompts each) ===`)
console.log(`per-run passRate: ${JSON.stringify(perRunPass)}`)
console.log(`per-run avgCov:   ${JSON.stringify(perRunCov)}`)
console.log(`\ncomposite passRate: ${band(perRunPass)}`)
console.log(`composite avgCov:   ${band(perRunCov)}`)
console.log(`\nper-prompt stability: ${stable.passAll} always-pass, ${stable.failAll} always-fail, ${stable.flip} FLIPPED`)

console.log(`\n--- PER-CATEGORY composite (passRate band / covBand across ${N} runs) ---`)
const catOrder = ['general', 'definition', 'abstain', 'explain', 'reasoning', 'false-premise', 'clarify']
for (const c of catOrder.filter(c => perCat[c])) {
  console.log(`${c.padEnd(14)} pass ${band(perCat[c].passRates)}`)
  console.log(`${''.padEnd(14)} cov  ${band(perCat[c].covs)}`)
}

console.log(`\n--- ALWAYS-FAIL (repeatable failures across all ${N} runs) ---`)
for (const id of ids.filter(i => byId[i].passes.filter(Boolean).length === 0).sort()) {
  console.log(`${id} [${byId[id].cat}]  run1: ${byId[id].texts[0]}`)
}

console.log(`\n--- FLIPPERS (pass/fail not constant across runs) ---`)
for (const f of flippers.sort((a, b) => a.id.localeCompare(b.id))) {
  console.log(`\n${f.id} [${f.cat}] ${f.pattern} (${f.nPass})`)
  f.texts.forEach((t: string, i: number) => console.log(`   run${i + 1}: ${t}`))
}

fs.writeFileSync('/tmp/convoedge-variance.json', JSON.stringify({ N, perRunPass, perRunCov, stable, perCat, flippers, alwaysFail: ids.filter(i => byId[i].passes.filter(Boolean).length === 0) }, null, 2))
console.log(`\nwrote /tmp/convoedge-variance.json`)

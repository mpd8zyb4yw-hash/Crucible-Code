import { decomposeCodeBySubFunction, solveCodeTask } from './solve'
import type { CodeAcceptance } from './codeVerifier'
const ENTRY = 'editDistance'
const GOAL = 'Write editDistance(a: string, b: string): number returning the Levenshtein edit distance between a and b: the minimum number of single-character insertions, deletions, or substitutions to turn a into b. Either string may be empty. The reliable route is the rolling-row dynamic program: seed the row [0..b.length], then for each character of a compute the next row as min(delete, insert, match/substitute); the answer is the last cell of the final row.'
const CASES: CodeAcceptance['cases'] = [
  { args: ['kitten', 'sitting'], expected: 3 },
  { args: ['flaw', 'lawn'], expected: 2 },
  { args: ['', 'abc'], expected: 3 },
  { args: ['abc', ''], expected: 3 },
  { args: ['abc', 'abc'], expected: 0 },
  { args: ['sunday', 'saturday'], expected: 3 },
]
async function main() {
  if (process.env.ED_FLATFIRST === '1') {
    process.stdout.write('flat solveCodeTask (2D DP is beyond one-shot) … ')
    const t0 = Date.now()
    const f = await solveCodeTask({ goal: GOAL, entry: ENTRY, cases: CASES }, { maxModelCalls: 12, beamWidth: 3 })
    console.log(`${f.status} in ${f.modelCalls} call(s) [${((Date.now() - t0) / 1000).toFixed(0)}s]`)
  }
  process.stdout.write('editDistance decomposition (subCost+nextRow+editRow carve) … ')
  const t1 = Date.now()
  const d = await decomposeCodeBySubFunction({ goal: GOAL, nl: GOAL, entry: ENTRY, cases: CASES },
    { planAttempts: 1, iterate: { globalModelCalls: 30, wallClockMs: 300000, maxEpochs: 10 },
      emit: (e: any) => { if (e?.type === 'thought') console.log(`\n    · ${e.text}`) } })
  console.log(`\n# RESULT: ${d.status} — ${d.detail}`)
  console.log(`# helpers: ${d.helpers.map(h => h.name).join(', ') || '(none)'} | rungs: ${d.rungs.map(r => `${r.name}:${r.certified ? 'OK' : r.status}`).join('  ')} | calls ${d.modelCalls}, wall ${((Date.now() - t1) / 1000).toFixed(0)}s`)
  if (d.status === 'solved' && d.code) { console.log('\n# CERTIFIED (re-verified vs all 6 cases):\n' + d.code) }
  console.log('\n' + JSON.stringify({ editDistance: true, status: d.status, helpers: d.helpers.length, calls: d.modelCalls }))
}
main().catch(e => { console.error(e); process.exit(1) })

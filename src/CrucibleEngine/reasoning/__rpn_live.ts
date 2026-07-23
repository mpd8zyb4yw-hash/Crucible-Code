import { decomposeCodeBySubFunction, solveCodeTask } from './solve'
import type { CodeAcceptance } from './codeVerifier'
const ENTRY = 'evalRPN'
const GOAL = 'Write evalRPN(tokens: string[]): number evaluating a Reverse Polish Notation (postfix) expression. Operators are "+", "-", "*", "/"; other tokens are integers (possibly negative). For [a,b,op] compute a op b. Division truncates toward zero (6/-4 = -1). A single number returns itself.'
const CASES: CodeAcceptance['cases'] = [
  { args: [['2','1','+','3','*']], expected: 9 },
  { args: [['4','13','5','/','+']], expected: 6 },
  { args: [['6','-4','/']], expected: -1 },
  { args: [['-7']], expected: -7 },
  { args: [['10','2','-','3','*']], expected: 24 },
]
async function main() {
  if (process.env.RPN_FLATFIRST === '1') {
    process.stdout.write('flat solveCodeTask (pass@k says ~0%) … ')
    const t0 = Date.now()
    const f = await solveCodeTask({ goal: GOAL, entry: ENTRY, cases: CASES }, { maxModelCalls: 12, beamWidth: 3 })
    console.log(`${f.status} in ${f.modelCalls} call(s) [${((Date.now()-t0)/1000).toFixed(0)}s]`)
  }
  process.stdout.write('RPN decomposition (applyOp carve) … ')
  const t1 = Date.now()
  const d = await decomposeCodeBySubFunction({ goal: GOAL, nl: GOAL, entry: ENTRY, cases: CASES },
    { planAttempts: 1, iterate: { globalModelCalls: 18, wallClockMs: 200000, maxEpochs: 6 },
      emit: (e: any) => { if (e?.type === 'thought') console.log(`\n    · ${e.text}`) } })
  console.log(`\n# RESULT: ${d.status} — ${d.detail}`)
  console.log(`# helpers: ${d.helpers.map(h=>h.name).join(', ')||'(none)'} | rungs: ${d.rungs.map(r=>`${r.name}:${r.certified?'OK':r.status}`).join('  ')} | calls ${d.modelCalls}, wall ${((Date.now()-t1)/1000).toFixed(0)}s`)
  if (d.status==='solved'&&d.code){ console.log('\n# CERTIFIED (re-verified vs all 5 cases):\n'+d.code) }
  console.log('\n'+JSON.stringify({rpn:true,status:d.status,helpers:d.helpers.length,calls:d.modelCalls}))
}
main().catch(e=>{console.error(e);process.exit(1)})

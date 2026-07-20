// Spec-conformance gate bench (cont.106). The structural invariants in runtimeVerifyApp are all
// goal-BLIND — a working app that ignores the request (asked for a tip calculator, shipped a
// to-do list) passes every one of them (cont.97 OPEN). runtimeVerifyApp now takes an optional,
// injected AppSpecJudge that consults the goal against the app's RENDERED surface. This bench
// pins the plumbing and, above all, the false-reject guards: a correct app for its goal, an
// unavailable judge, a terse goal, and a low-content surface must ALL still pass, because a false
// reject here poisons the repair loop (the scar this whole module carries — cont.79h).
//
// The judge is MOCKED (deterministic, no model) so this bench is fast and hermetic; the real
// _appSpecJudge in synthDriver is exercised on the live path. runtimeVerifyApp still runs the
// genuine Electron probe on a real todo app, so the structural path is real end-to-end.
import { runtimeVerifyApp, type AppSpecJudge } from './htmlRuntimeVerify'
import { buildAppShell } from './synthDriver'

const TODO_JS = `let app = document.getElementById('app');
let items = [], draft = '';
function render() {
  app.innerHTML = '';
  let form = document.createElement('form');
  let input = document.createElement('input'); input.value = draft;
  input.addEventListener('input', function (e) { draft = e.target.value; });
  let add = document.createElement('button'); add.type = 'submit'; add.textContent = 'Add';
  form.addEventListener('submit', function (e) { e.preventDefault(); let v = draft.trim(); if (!v) return; items.push(v); draft = ''; render(); });
  form.appendChild(input); form.appendChild(add); app.appendChild(form);
  let ul = document.createElement('ul');
  items.forEach(function (t) { let li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
  app.appendChild(ul);
}
render();`

const TODO_HTML = buildAppShell(TODO_JS, 'Todo — Crucible')

let failed = 0
function check(name: string, cond: boolean, extra = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : `  ${extra}`}`)
  if (!cond) failed++
}

async function main() {
  // Judge that ALWAYS reports a mismatch — the strongest possible false-reject stressor. It must
  // only ever be REACHED when the guards allow it; the guard tests below rely on this.
  let called = 0
  const alwaysMismatch: AppSpecJudge = async () => { called++; return { mismatch: true, missing: 'this is a to-do list, not a tip calculator' } }
  const alwaysMatch: AppSpecJudge = async () => { called++; return { mismatch: false } }
  const unavailable: AppSpecJudge = async () => { called++; return null }        // model down / unparseable
  const throws: AppSpecJudge = async () => { called++; throw new Error('boom') }  // judge blew up

  // 1. POSITIVE CONTROL — correct app for its goal, judge agrees → PASS. The single most
  //    important row: a matching judge must never manufacture a rejection.
  called = 0
  const match = await runtimeVerifyApp(TODO_HTML, 'a to-do list app where I can add tasks', alwaysMatch)
  check('correct app + matching judge → PASS', match === null, `got: ${match}`)
  check('  judge WAS consulted for a checkable goal', called === 1, `called=${called}`)

  // 2. TRUE POSITIVE — wrong-category app, judge flags it → REJECT with actionable feedback.
  const miss = await runtimeVerifyApp(TODO_HTML, 'a tip calculator that splits a bill', alwaysMismatch)
  check('wrong-category app + mismatch judge → REJECT', typeof miss === 'string' && /does not do what was asked/.test(miss), `got: ${miss}`)
  check('  rejection carries the cited gap', typeof miss === 'string' && /tip calculator/.test(miss!), `got: ${miss}`)

  // 3. FAIL-OPEN — judge unavailable (model down / bad output) → PASS, never red on infra.
  const down = await runtimeVerifyApp(TODO_HTML, 'a tip calculator that splits a bill', unavailable)
  check('judge returns null (unavailable) → PASS (fail-open)', down === null, `got: ${down}`)

  // 4. FAIL-OPEN — judge throws → PASS. runtimeVerifyApp swallows the throw locally.
  const boom = await runtimeVerifyApp(TODO_HTML, 'a tip calculator that splits a bill', throws)
  check('judge throws → PASS (fail-open)', boom === null, `got: ${boom}`)

  // 5. GUARD — terse goal (< 3 words) is not checkable → judge NOT consulted, PASS even under the
  //    always-mismatch judge. A one-word goal has no surface any render could contradict.
  called = 0
  const terse = await runtimeVerifyApp(TODO_HTML, 'todo', alwaysMismatch)
  check('terse goal → judge skipped → PASS', terse === null, `got: ${terse}`)
  check('  judge NOT consulted for a terse goal', called === 0, `called=${called}`)

  // 6. GUARD — no judge injected (older caller / opt-out) → structural-only, PASS unchanged.
  const noJudge = await runtimeVerifyApp(TODO_HTML, 'a tip calculator that splits a bill')
  check('no judge injected → structural-only PASS', noJudge === null, `got: ${noJudge}`)

  console.log(failed === 0 ? `\nspec-conformance: all passed` : `\nspec-conformance: ${failed} FAILED`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })

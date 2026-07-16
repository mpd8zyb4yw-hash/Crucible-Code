// Bench for the NON-GAME interactive HTML path (cont.79e).
//
// The bug this pins: the HTML write path was game-shaped end-to-end, so every .html goal got a
// canvas game shell, the game prompt and the GAME runtime gate. Measured before the fix:
//
//     runtimeVerifyHtml(<a correct todo app>) === 'no <canvas> element present at runtime'
//
// and that string was fed back as REPAIR FEEDBACK for 6 attempts — the loop actively pushed the
// model to bolt a canvas onto a todo list, then failed. Non-game HTML wasn't merely unverified;
// it was mis-verified into corruption. `classifyHtmlGoal` splits the kinds, and `runtimeVerifyApp`
// carries the invariants that are actually true of an app.
//
// Like __html_invariant_bench, the runtime half runs the REAL Electron gate — no mocks. If
// Electron is unavailable the gate fails OPEN (returns null); a must-reject CANARY detects that
// and the runtime half SKIPS (green) rather than red. The classifier half is pure and always runs.
//
// Run: npx tsx src/CrucibleEngine/agent/__html_app_bench.ts

import { runtimeVerifyHtml, runtimeVerifyApp } from './htmlRuntimeVerify'
import { classifyHtmlGoal } from './htmlGoalKind'
import { APP_TEMPLATES, buildAppShell } from './synthDriver'

const HEAD = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title></head>'

const todo = (script: string) => `${HEAD}<body>
<h1>My Todos</h1>
<form id="f"><input id="t" placeholder="new todo"><button type="submit">Add</button></form>
<ul id="list"></ul>
<script>${script}</script></body></html>`

// A correct todo app: state, render(), guarded submit, re-render at the end of the handler.
const GOOD_JS = `
var items = [];
function render() {
  var ul = document.getElementById('list'); ul.innerHTML = '';
  items.forEach(function (it) { var li = document.createElement('li'); li.textContent = it; ul.appendChild(li); });
}
document.getElementById('f').addEventListener('submit', function (e) {
  e.preventDefault();
  var v = document.getElementById('t').value.trim(); if (!v) return;
  items.push(v); document.getElementById('t').value = ''; render();
});
render();`

// The dominant broken-app shape: state updates, but render() is never called, so the UI is inert.
// Nothing throws — the page looks finished and is unusable. Must REJECT.
const DEAD_JS = `
var items = [];
document.getElementById('f').addEventListener('submit', function (e) {
  e.preventDefault();
  var v = document.getElementById('t').value.trim(); if (!v) return;
  items.push(v);
});`

// A calculator whose total is never initialized → "Total: NaN". Runs, responds, renders — every
// other check passes. Must REJECT.
const NAN_HTML = `${HEAD}<body><div id="out">Total: </div>
<input id="n"><button id="b">Add</button>
<script>
var total;
document.getElementById('b').addEventListener('click', function () {
  total = total + Number(document.getElementById('n').value);
  document.getElementById('out').textContent = 'Total: ' + total;
});
</script></body></html>`

// VERBATIM shape of what the on-device FM actually produced on the first live run of this path
// (cont.79e), reduced to its bug. render() clears #app and re-creates only the list; the input and
// Add button are appended OUTSIDE render(), so the first interaction deletes them and the app can
// never be used again. It throws nothing and the DOM plainly CHANGES, so the dead-control check
// passes it — this fixture is why the self-erasing check exists. Must REJECT.
const SELF_ERASING = `${HEAD}<body><div id="app"></div>
<script>
let app = document.getElementById('app');
let tasks = [];
function render() {
  app.innerHTML = '';
  let ul = document.createElement('ul');
  tasks.forEach(function (task) {
    let li = document.createElement('li');
    let span = document.createElement('span'); span.textContent = task; li.appendChild(span);
    let del = document.createElement('button'); del.textContent = 'Delete';
    del.addEventListener('click', function () { tasks.splice(tasks.indexOf(task), 1); render(); });
    li.appendChild(del); ul.appendChild(li);
  });
  app.appendChild(ul);
}
render();
let input = document.createElement('input');
input.placeholder = 'Add a task';
let add = document.createElement('button');
add.textContent = 'Add';
add.addEventListener('click', function () { tasks.push(input.value.trim()); render(); });
app.appendChild(input); app.appendChild(add);
</script></body></html>`

// The FM's SECOND live failure (cont.79e): it created the input and button but never appended
// them to the page, so the body renders empty — a blank todo list with no way to add anything.
// Zero controls, so every controls-conditioned check skips; only the blank-render check catches
// it. Must REJECT.
const BLANK_RENDER = `${HEAD}<body><div id="app"></div>
<script>
let app = document.getElementById('app');
let tasks = [];
function render() { app.innerHTML = ''; let ul = document.createElement('ul'); app.appendChild(ul); }
render();
let input = document.createElement('input');   // created but NEVER appended
let add = document.createElement('button'); add.textContent = 'Add';
add.addEventListener('click', function () { tasks.push(input.value); render(); });
</script></body></html>`

// A legitimately STATIC page — no controls at all. Must PASS: "an .html file must be interactive"
// is not true (a landing page is fine), and rejecting this would recreate the very false-reject
// this path exists to kill. The dead-control invariant is conditioned on controls EXISTING.
const STATIC_HTML = `${HEAD}<body><h1>Acme</h1><p>We make things.</p></body></html>`

// Canary — a runtime error on load that ANY working harness rejects, independent of the new
// checks. If the app gate returns null here, Electron is not running (fail-open) → SKIP.
const CANARY = `${HEAD}<body><button id="b">go</button>
<script>thisFunctionDoesNotExist();</script></body></html>`

async function main() {
  let pass = 0, fail = 0
  const check = (name: string, ok: boolean, detail: string) => {
    if (ok) { pass++; console.log(`  ok   ${name}`) }
    else { fail++; console.log(`  FAIL ${name} — ${detail}`) }
  }

  // ── Classifier (pure, always runs) ─────────────────────────────────────────
  for (const g of [
    'build a snake game', 'make pong', 'a flappy bird clone', 'space invaders in one file',
    'build a playable tetris', 'a 2048 puzzle', 'breakout with paddle', 'make a maze game',
  ]) check(`classify game: "${g}"`, classifyHtmlGoal(g) === 'game', `got ${classifyHtmlGoal(g)}`)

  for (const g of [
    'build a todo list app', 'make a calculator', 'a pomodoro timer', 'build a markdown notes app',
    'a unit converter page', 'build an expense tracker', 'a landing page for my startup',
    'build a color picker tool',
  ]) check(`classify app: "${g}"`, classifyHtmlGoal(g) === 'app', `got ${classifyHtmlGoal(g)}`)

  // The default must be 'app' — an unrecognized goal must never take the corrupting game path.
  check('unknown goal defaults to app', classifyHtmlGoal('build something nice') === 'app', 'expected app')
  check('empty goal defaults to app', classifyHtmlGoal('') === 'app', 'expected app')

  // ── Runtime (real Electron, canary-gated) ──────────────────────────────────
  const canary = await runtimeVerifyApp(CANARY)
  if (canary === null) {
    console.log('SKIP: Electron runtime gate unavailable (fail-open) — running classifier checks only')
    console.log(`\nhtml app invariants: ${pass}/${pass + fail} passed`)
    process.exit(fail === 0 ? 0 : 1)
  }

  const good = await runtimeVerifyApp(todo(GOOD_JS), 'todo app')
  check('a correct todo app passes the APP gate', good === null, `expected null, got: ${good}`)

  // The regression this whole split exists to prevent — documents the measured old behavior.
  const viaGameGate = await runtimeVerifyHtml(todo(GOOD_JS), 'todo app')
  check('the GAME gate still rejects that same todo app (why the kind split exists)',
    viaGameGate !== null && /canvas/i.test(viaGameGate), `expected a canvas rejection, got: ${viaGameGate}`)

  const dead = await runtimeVerifyApp(todo(DEAD_JS), 'todo app')
  check('an app whose button changes nothing is rejected',
    dead !== null && /does not respond|render/i.test(dead), `expected a dead-control rejection, got: ${dead}`)
  check('the dead-control rejection names the control it clicked',
    !!dead && /"Add"/.test(dead), `expected the rejection to name "Add", got: ${dead}`)

  const blank = await runtimeVerifyApp(BLANK_RENDER, 'todo app')
  check('an app that renders a blank body (controls never appended) is rejected',
    blank !== null && /renders nothing|empty|append/i.test(blank),
    `expected a blank-render rejection, got: ${blank}`)

  const erasing = await runtimeVerifyApp(SELF_ERASING, 'todo app')
  check('an app that erases its own input field on first use is rejected',
    erasing !== null && /erases its own|field is gone|ENTIRE interface/i.test(erasing),
    `expected a self-erasing rejection, got: ${erasing}`)

  const nan = await runtimeVerifyApp(NAN_HTML, 'calculator')
  check('an app displaying NaN is rejected with a readout hint',
    nan !== null && /NaN|undefined|Infinity/.test(nan), `expected a readout rejection, got: ${nan}`)

  const stat = await runtimeVerifyApp(STATIC_HTML, 'landing page')
  check('a legitimately static page passes (no controls → check skipped, fail-open)',
    stat === null, `expected null, got: ${stat}`)

  // Every shipped app template must pass its OWN runtime gate — the FM cannot produce a working
  // todo app across 6 attempts, so these deterministic templates are what actually reaches users.
  // Trusting them un-verified would reintroduce the exact silent-broken-ship this session removed.
  for (const tpl of APP_TEMPLATES) {
    const problem = await runtimeVerifyApp(buildAppShell(tpl.js, `${tpl.title} — Crucible`), tpl.title)
    check(`APP_TEMPLATE "${tpl.title}" passes its own runtime gate`, problem === null, `got: ${problem}`)
  }
  // The todo template must actually be SELECTED for the canonical request (not fall through to FM).
  check('the todo goal selects the Todo template',
    (APP_TEMPLATES.find(t => t.match.test('build a todo list app')) || {}).title === 'Todo',
    'todo goal did not match the Todo template')

  console.log(`\nhtml app invariants: ${pass}/${pass + fail} passed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error('bench crashed:', e); process.exit(1) })

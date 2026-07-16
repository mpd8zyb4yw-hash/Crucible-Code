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
import { buildAppShell, isWebArtifactGoal, defaultWebArtifactPath } from './synthDriver'

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

// VERBATIM shape from the first NO-TEMPLATE live run (cont.79f): the submit handler pushes the task
// but calls app.appendChild(row) instead of render(), so the item is RECORDED but never DISPLAYED.
// It churns innerHTML (the form node moves) while the visible list stays empty — so the old
// innerHTML-keyed dead-control check PASSED it. Only the visible-text-change signal catches it.
// Must REJECT.
const NO_RERENDER = `${HEAD}<body><div id="app"></div>
<script>
let tasks = [], entered = '';
function render() {
  document.getElementById('app').innerHTML = '';
  let ul = document.createElement('ul');
  tasks.forEach(function (task) { let li = document.createElement('li'); li.textContent = task; ul.appendChild(li); });
  document.getElementById('app').appendChild(ul);
  let row = document.createElement('form');
  let input = document.createElement('input'); input.value = entered;
  input.addEventListener('input', function (e) { entered = e.target.value; });
  let add = document.createElement('button'); add.type = 'submit'; add.textContent = 'Add';
  row.addEventListener('submit', function (e) {
    e.preventDefault();
    if (entered.trim() === '') return;
    tasks.push(entered); entered = '';
    document.getElementById('app').appendChild(row);   // BUG: re-appends the form, never render()
  });
  row.appendChild(input); row.appendChild(add);
  document.getElementById('app').appendChild(row);
}
render();
</script></body></html>`

// A todo that renders each item with its own Delete button — the shape the FM actually produces,
// and the one the empty-commit probe reads (a blank row brings a control with it). Parameterized
// by its submit handler so the two commit-shape bugs below differ ONLY in that handler.
const delTodo = (submit: string) => `${HEAD}<body>
<h1>My Todos</h1>
<form id="f"><input id="t" placeholder="new todo"><button type="submit">Add</button></form>
<ul id="list"></ul>
<script>
var items = [];
function render() {
  var ul = document.getElementById('list'); ul.innerHTML = '';
  items.forEach(function (it, i) {
    var li = document.createElement('li');
    var span = document.createElement('span'); span.textContent = it; li.appendChild(span);
    var del = document.createElement('button'); del.textContent = 'Delete';
    del.addEventListener('click', function () { items.splice(i, 1); render(); });
    li.appendChild(del); ul.appendChild(li);
  });
}
document.getElementById('f').addEventListener('submit', function (e) { e.preventDefault(); ${submit} });
render();
</script></body></html>`

// Bug (a) — the missing empty-input guard, shipped by the first template-free live run (cont.79f).
// Adds, clears, re-renders: every earlier check passes. But pressing Add on an empty field records
// a blank entry. Must REJECT.
const UNGUARDED_EMPTY = delTodo(`
  var el = document.getElementById('t');
  items.push(el.value); el.value = ''; render();`)

// Bug (b) — the value is added but the field is never cleared, so the user's next entry types onto
// the end of the last one. Guarded, renders correctly, passes every earlier check. Must REJECT.
const NO_CLEAR = delTodo(`
  var el = document.getElementById('t');
  var v = el.value.trim(); if (!v) return;
  items.push(v); render();`)

// A CORRECT add+filter todo — the false-reject class the field-clear invariant shipped with
// (cont.79h). The harness types its sentinel into EVERY visible field, so the filter box still
// holds it after the commit even though the app correctly cleared the field it actually committed
// from. Keying "did the field clear" on ANY field still holding the sentinel therefore rejects a
// correct app, and the repair feedback tells the model to clear an input it already clears — a loop
// that can never converge. This is add-shaped (unlike FILTER_HTML), so it does NOT skip the check:
// it is the fixture that forces the invariant to ask "did the COMMITTED field clear" instead.
// Must PASS.
const ADD_PLUS_FILTER = `${HEAD}<body><h1>My Todos</h1>
<form id="f"><input id="t" placeholder="new todo"><button type="submit">Add</button></form>
<input id="q" placeholder="filter todos">
<ul id="list"></ul>
<script>
var items = [];
function render() {
  var q = document.getElementById('q').value.trim().toLowerCase();
  var ul = document.getElementById('list'); ul.innerHTML = '';
  items.filter(function (it) { return it.toLowerCase().indexOf(q) !== -1; })
    .forEach(function (it, i) {
      var li = document.createElement('li');
      var span = document.createElement('span'); span.textContent = it; li.appendChild(span);
      var del = document.createElement('button'); del.textContent = 'Delete';
      del.addEventListener('click', function () { items.splice(i, 1); render(); });
      li.appendChild(del); ul.appendChild(li);
    });
}
document.getElementById('f').addEventListener('submit', function (e) {
  e.preventDefault();
  var el = document.getElementById('t');
  var v = el.value.trim(); if (!v) return;
  items.push(v); el.value = ''; render();
});
document.getElementById('q').addEventListener('input', render);
render();
</script></body></html>`

// The state-driven ORDERING bug, verbatim in shape from what the on-device FM actually shipped on
// 3 of 5 live runs (cont.79h). render() re-creates the field with `input.value = draft`, and the
// handler clears `draft` AFTER calling render() — so the field is redrawn with the stale text and
// the user's next keystroke lands on the end of it. Every earlier check passes: it adds, it
// re-renders, it guards empties. Must REJECT (and the message must name the ordering remedy, not
// just `input.value = ''`, which this architecture never writes).
const STATE_CLEAR_TOO_LATE = `${HEAD}<body><div id="app"></div>
<script>
var items = [], draft = '';
function render() {
  var app = document.getElementById('app'); app.innerHTML = '';
  var ul = document.createElement('ul');
  items.forEach(function (it) { var li = document.createElement('li'); li.textContent = it; ul.appendChild(li); });
  app.appendChild(ul);
  var form = document.createElement('form');
  var input = document.createElement('input');
  input.value = draft;
  input.addEventListener('input', function (e) { draft = e.target.value; });
  var add = document.createElement('button'); add.type = 'submit'; add.textContent = 'Add';
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!draft.trim()) return;
    items.push(draft);
    render();
    draft = '';        // TOO LATE — render() already redrew the field with the old text
  });
  form.appendChild(input); form.appendChild(add); app.appendChild(form);
}
render();
</script></body></html>`

// A CORRECT todo whose ONLY commit path is pressing Enter — no Add button anywhere. A legitimate,
// common minimal design. The click-only harness could never commit it, so it reported "nothing
// changed" and the verifier blamed a missing re-render the app doesn't have (cont.79h). The Enter/
// requestSubmit fallback is what makes the gate exercise the app's real path. Must PASS.
const ENTER_ONLY = `${HEAD}<body><h1>My Todos</h1>
<form id="f"><input id="t" placeholder="new todo (press Enter)"></form>
<ul id="list"></ul>
<script>
var items = [];
function render() {
  var ul = document.getElementById('list'); ul.innerHTML = '';
  items.forEach(function (it) {
    var li = document.createElement('li'); li.textContent = it; ul.appendChild(li);
  });
}
document.getElementById('f').addEventListener('submit', function (e) {
  e.preventDefault();
  var el = document.getElementById('t');
  var v = el.value.trim(); if (!v) return;
  items.push(v); el.value = ''; render();
});
render();
</script></body></html>`

// A FILTER box — the false-reject both commit invariants must not produce. It legitimately KEEPS
// its text (that's the query) and legitimately makes the list SHRINK rather than grow, so the
// commit is not add-shaped and both checks skip. Must PASS.
const FILTER_HTML = `${HEAD}<body><h1>Fruit</h1>
<input id="q" placeholder="filter"><button id="go">Search</button><ul id="list"></ul>
<script>
var all = ['apple', 'banana', 'cherry'];
function render() {
  var q = document.getElementById('q').value.trim().toLowerCase();
  var ul = document.getElementById('list'); ul.innerHTML = '';
  all.filter(function (f) { return f.indexOf(q) !== -1; })
     .forEach(function (f) { var li = document.createElement('li'); li.textContent = f; ul.appendChild(li); });
}
document.getElementById('q').addEventListener('input', render);
document.getElementById('go').addEventListener('click', render);
render();
</script></body></html>`

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

  // ── Routing: does the goal reach the verified build path at all? (cont.79h) ──
  // isWebArtifactGoal is the ENTRANCE to write → gate → repair. A pathless goal it rejects comes
  // back as PROSE. It previously keyed on named arcade titles, so every non-game app below was
  // locked out of the gate entirely and answered with a tutorial. Live-confirmed this session.
  for (const g of [
    // games (the pre-existing coverage — must not regress)
    'build a snake game', 'make a playable tetris', 'create an arcade shooter',
    // non-game apps: the class that silently returned prose before this fix
    'build a todo list app', 'build an expense tracker', 'make a pomodoro timer',
    'create a unit converter', 'build a markdown notes app', 'make a calculator app',
    'build a habit tracker dashboard', 'create a landing page for my startup',
    'write me a single HTML file that shows a countdown',
  ]) check(`routes to the verified build path: "${g}"`, isWebArtifactGoal(g) === true, 'expected true')

  // Must NOT route: these are real requests that a single vanilla-JS file would answer WRONGLY.
  for (const g of [
    'build a CLI tool in python', 'implement a REST API', 'make a react dashboard',
    'write a function that sorts an array', 'implement a graph traversal',
    'build an express server', 'create a python library for parsing logs',
    'what is the best todo app?',                    // no creation verb — a question
  ]) check(`does NOT route to the web path: "${g}"`, isWebArtifactGoal(g) === false, 'expected false')

  // The injected default target must match the kind — a todo app landing at game.html is confusing.
  check('pathless game goal defaults to game.html', defaultWebArtifactPath('build a snake game') === 'game.html', 'expected game.html')
  check('pathless app goal defaults to app.html', defaultWebArtifactPath('build a todo list app') === 'app.html', 'expected app.html')

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

  const noRerender = await runtimeVerifyApp(NO_RERENDER, 'todo app')
  check('an app that records input but never re-renders it is rejected (visible-effect check)',
    noRerender !== null && /nothing visible|never appears|re-render/i.test(noRerender),
    `expected a no-visible-effect rejection, got: ${noRerender}`)

  // ── Commit-shape invariants (cont.79g) ─────────────────────────────────────
  const unguarded = await runtimeVerifyApp(UNGUARDED_EMPTY, 'todo app')
  check('an app that records an EMPTY entry is rejected (empty-commit-adds-nothing)',
    unguarded !== null && /empty entries|blank item|Guard the handler/i.test(unguarded),
    `expected an empty-commit rejection, got: ${unguarded}`)

  const noClear = await runtimeVerifyApp(NO_CLEAR, 'todo app')
  check('an app that never clears the field after committing is rejected (field-clears-after-commit)',
    noClear !== null && /does not clear the input|still sitting in the field/i.test(noClear),
    `expected a field-clear rejection, got: ${noClear}`)

  // The false-reject guard for BOTH new checks — the add-shaped gate is what makes them universal.
  const filter = await runtimeVerifyApp(FILTER_HTML, 'fruit filter')
  check('a filter box that keeps its text and shrinks the list passes (not add-shaped → skipped)',
    filter === null, `expected null, got: ${filter}`)

  // The add-shaped false-reject guard: a CORRECT app that clears the field it committed from, but
  // has a second (filter) field the harness also typed into and that nothing clears.
  const addFilter = await runtimeVerifyApp(ADD_PLUS_FILTER, 'todo app')
  check('a correct todo with a separate filter box passes (only the COMMITTED field must clear)',
    addFilter === null, `expected null, got: ${addFilter}`)

  // The harness must exercise the app's REAL commit path, not just the one it prefers.
  const enterOnly = await runtimeVerifyApp(ENTER_ONLY, 'todo app')
  check('a correct Enter-to-commit todo with no Add button passes (Enter/submit fallback)',
    enterOnly === null, `expected null, got: ${enterOnly}`)

  // The dominant live failure shape — clearing the state AFTER render() instead of before.
  const tooLate = await runtimeVerifyApp(STATE_CLEAR_TOO_LATE, 'todo app')
  check('a state-driven app that clears its draft AFTER render() is rejected (ordering bug)',
    tooLate !== null && /does not clear the input/i.test(tooLate), `expected a field-clear rejection, got: ${tooLate}`)
  check('the field-clear rejection names the state-ordering remedy, not just input.value',
    !!tooLate && /BEFORE you call/i.test(tooLate), `message must cover the state-driven shape, got: ${tooLate}`)

  // The correct todo must satisfy the new invariants too — with the Delete-button shape the
  // empty-commit probe actually reads, so this is a real positive control for it, not a vacuous one.
  const goodDel = await runtimeVerifyApp(delTodo(`
    var el = document.getElementById('t');
    var v = el.value.trim(); if (!v) return;
    items.push(v); el.value = ''; render();`), 'todo app')
  check('a correct guarded, field-clearing todo with Delete buttons passes (positive control)',
    goodDel === null, `expected null, got: ${goodDel}`)

  const nan = await runtimeVerifyApp(NAN_HTML, 'calculator')
  check('an app displaying NaN is rejected with a readout hint',
    nan !== null && /NaN|undefined|Infinity/.test(nan), `expected a readout rejection, got: ${nan}`)

  const stat = await runtimeVerifyApp(STATIC_HTML, 'landing page')
  check('a legitimately static page passes (no controls → check skipped, fail-open)',
    stat === null, `expected null, got: ${stat}`)

  // NOTE: there are NO templates to bench (doctrine cont.79f — no memorized answers). What reaches
  // users is FM synthesis grounded on a web-retrieved reference, gated by these same checks. This
  // positive control just proves buildAppShell + a correct render() PASSES — the shell itself is
  // sound, so a rejection means the FM's logic, never the wrapper.
  const CORRECT_APP_JS = `let app = document.getElementById('app');
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
  const goodShell = await runtimeVerifyApp(buildAppShell(CORRECT_APP_JS, 'Todo — Crucible'), 'todo app')
  check('buildAppShell + a correct render() passes the app gate (positive control)',
    goodShell === null, `got: ${goodShell}`)

  console.log(`\nhtml app invariants: ${pass}/${pass + fail} passed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error('bench crashed:', e); process.exit(1) })

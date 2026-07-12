// Live bench for the runtime GAME-STATE invariant added 2026-07-12: a generated game may
// draw, animate and take input yet show a broken readout ("Score: NaN") — the aliveness gate
// is blind to that. runtimeVerifyHtml now captures what the game DRAWS (canvas fillText +
// HUD text) and rejects a NaN/undefined/Infinity readout.
//
// This runs the REAL Electron gate — no mocks (the mock-vs-reality lesson: injection, the
// harness, and Electron's own behavior only show up on the real path). If Electron is
// unavailable the gate fails OPEN (returns null); a must-reject CANARY detects that and the
// bench SKIPS (green, exit 0) rather than red — an absent verifier dependency must never
// fail CI, and must never silently pass the two real assertions either.
//
// Run: npx tsx src/CrucibleEngine/agent/__html_invariant_bench.ts

import { runtimeVerifyHtml } from './htmlRuntimeVerify'

const HEAD = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title></head>'

// A well-formed game: draws at load, self-animates (block drifts with t), has a keydown
// handler that moves the player, and shows a real numeric score in both the HUD and canvas.
const GOOD = `${HEAD}
<body><div id="hud">Score: 0</div>
<canvas id="game" width="320" height="320"></canvas>
<script>
var c = document.getElementById('game'), ctx = c.getContext('2d');
var x = 40, y = 40, score = 0, t = 0;
window.addEventListener('keydown', function (e) {
  if (e.key === 'ArrowRight') x += 8; if (e.key === 'ArrowLeft') x -= 8;
  if (e.key === 'ArrowUp') y -= 8; if (e.key === 'ArrowDown') y += 8;
  score += 1; document.getElementById('hud').textContent = 'Score: ' + score;
});
function loop() {
  t++;
  ctx.fillStyle = '#101018'; ctx.fillRect(0, 0, 320, 320);
  ctx.fillStyle = '#66ccff'; ctx.fillRect(x, 40 + (t * 3) % 240, 16, 16);
  ctx.fillStyle = '#ffffff'; ctx.font = '16px sans-serif'; ctx.fillText('Score: ' + score, 10, 310);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
</script></body></html>`

// The canonical broken-readout bug: a point value that was never assigned is added to the
// score on the first input, turning it into NaN — then rendered to HUD and canvas. Draws,
// animates and takes input exactly like GOOD, so ONLY the readout invariant can catch it.
const NAN_READOUT = `${HEAD}
<body><div id="hud">Score: 0</div>
<canvas id="game" width="320" height="320"></canvas>
<script>
var c = document.getElementById('game'), ctx = c.getContext('2d');
var x = 40, y = 40, score = 0, t = 0, pts; // pts intentionally never assigned
window.addEventListener('keydown', function (e) {
  if (e.key === 'ArrowRight') x += 8; if (e.key === 'ArrowLeft') x -= 8;
  if (e.key === 'ArrowUp') y -= 8; if (e.key === 'ArrowDown') y += 8;
  score += pts; document.getElementById('hud').textContent = 'Score: ' + score;
});
function loop() {
  t++;
  ctx.fillStyle = '#101018'; ctx.fillRect(0, 0, 320, 320);
  ctx.fillStyle = '#66ccff'; ctx.fillRect(x, 40 + (t * 3) % 240, 16, 16);
  ctx.fillStyle = '#ffffff'; ctx.font = '16px sans-serif'; ctx.fillText('Score: ' + score, 10, 310);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
</script></body></html>`

// Terminal-state-on-load (2026-07-12): draws, animates and takes input exactly like GOOD, but the
// FM initialized gameOver=true, so every frame renders "GAME OVER" — the game is over before the
// player acts. Aliveness/readout/direction gates are all blind to it (the readout is well-formed).
// Must REJECT — and via the LOAD snapshot, so a real game-over from the harness's own key bursts
// (see GOOD, which never reads terminal) can't false-trip the check.
const TERMINAL_ON_LOAD = `${HEAD}
<body><div id="hud">Score: 0</div>
<canvas id="game" width="320" height="320"></canvas>
<script>
var c = document.getElementById('game'), ctx = c.getContext('2d');
var x = 40, t = 0, gameOver = true; // BUG: initialized as already over
window.addEventListener('keydown', function (e) { if (e.key === 'ArrowRight') x += 8; if (e.key === 'ArrowLeft') x -= 8; });
function loop() {
  t++;
  ctx.fillStyle = '#101018'; ctx.fillRect(0, 0, 320, 320);
  ctx.fillStyle = '#66ccff'; ctx.fillRect(x, 40 + (t * 3) % 240, 16, 16);
  ctx.fillStyle = '#ffffff'; ctx.font = '16px sans-serif';
  ctx.fillText(gameOver ? 'GAME OVER' : ('Score: ' + t), 10, 310);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
</script></body></html>`

// Directional-control cases for the inverted-controls invariant (2026-07-12). A large player
// block dominates the canvas ink so the horizontal centroid tracks the player, clamped to the
// canvas so bursts pin it to an edge — giving a clean left-vs-right centroid separation.
const DIR_HEAD = `${HEAD}
<body><canvas id="game" width="320" height="320"></canvas>
<script>
var c = document.getElementById('game'), ctx = c.getContext('2d');
var x = 140, t = 0;
function clamp(v){ return Math.max(0, Math.min(280, v)); }`

// Correct controls: ArrowRight increases x, ArrowLeft decreases it. Must PASS.
const DIR_OK = `${DIR_HEAD}
window.addEventListener('keydown', function (e) {
  if (e.key === 'ArrowRight') x = clamp(x + 20);
  if (e.key === 'ArrowLeft') x = clamp(x - 20);
});
function loop(){ t++; ctx.fillStyle='#101018'; ctx.fillRect(0,0,320,320);
  ctx.fillStyle="#66ccff"; ctx.fillRect(x, 60 + (t * 2) % 160, 40, 40); requestAnimationFrame(loop); }
requestAnimationFrame(loop);
</script></body></html>`

// Inverted controls: ArrowRight DECREASES x, ArrowLeft increases it — the exact behavioral bug
// the aliveness/readout gates are blind to (it draws, animates and responds to input). Must REJECT.
const DIR_INVERTED = `${DIR_HEAD}
window.addEventListener('keydown', function (e) {
  if (e.key === 'ArrowRight') x = clamp(x - 20);
  if (e.key === 'ArrowLeft') x = clamp(x + 20);
});
function loop(){ t++; ctx.fillStyle='#101018'; ctx.fillRect(0,0,320,320);
  ctx.fillStyle="#66ccff"; ctx.fillRect(x, 60 + (t * 2) % 160, 40, 40); requestAnimationFrame(loop); }
requestAnimationFrame(loop);
</script></body></html>`

// Canary — a runtime error on load that ANY working harness rejects, independent of the new
// check. If the gate returns null here, Electron is not running (fail-open) → SKIP.
const CANARY = `${HEAD}
<body><canvas id="game" width="200" height="200"></canvas>
<script>thisFunctionDoesNotExist(); var ctx = document.getElementById('game').getContext('2d'); ctx.fillRect(0,0,10,10);</script>
</body></html>`

async function main() {
  const canary = await runtimeVerifyHtml(CANARY)
  if (canary === null) {
    console.log('SKIP: Electron runtime gate unavailable (fail-open) — cannot live-verify the readout invariant')
    process.exit(0)
  }

  let pass = 0, fail = 0
  const check = (name: string, ok: boolean, detail: string) => {
    if (ok) { pass++; console.log(`  ok   ${name}`) }
    else { fail++; console.log(`  FAIL ${name} — ${detail}`) }
  }

  const good = await runtimeVerifyHtml(GOOD)
  check('well-formed game passes the readout gate', good === null, `expected null, got: ${good}`)

  const nan = await runtimeVerifyHtml(NAN_READOUT)
  const rejected = nan !== null && /NaN|undefined|Infinity|score|status|readout/i.test(nan)
  check('NaN-score game is rejected with a readout hint', rejected, `expected a readout rejection, got: ${nan}`)

  const dirOk = await runtimeVerifyHtml(DIR_OK)
  check('correct left/right controls pass the directional gate', dirOk === null, `expected null, got: ${dirOk}`)

  const dirInv = await runtimeVerifyHtml(DIR_INVERTED)
  const invRejected = dirInv !== null && /invert|left|right|controls/i.test(dirInv)
  check('inverted left/right controls are rejected', invRejected, `expected an inverted-controls rejection, got: ${dirInv}`)

  const term = await runtimeVerifyHtml(TERMINAL_ON_LOAD)
  const termRejected = term !== null && /terminal|over|begins|playable/i.test(term)
  check('a game that is GAME OVER on load is rejected', termRejected, `expected a terminal-state rejection, got: ${term}`)

  console.log(`\nhtml runtime invariants: ${pass}/${pass + fail} passed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error('bench crashed:', e); process.exit(1) })

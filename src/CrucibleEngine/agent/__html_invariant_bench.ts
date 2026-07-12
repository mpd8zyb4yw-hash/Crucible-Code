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

  console.log(`\nhtml readout invariant: ${pass}/${pass + fail} passed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error('bench crashed:', e); process.exit(1) })

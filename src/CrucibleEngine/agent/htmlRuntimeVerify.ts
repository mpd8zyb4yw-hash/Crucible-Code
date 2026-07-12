// Runtime verification for generated single-file HTML games (trust audit 2026-07-07).
//
// The static gate (validateHtmlGame: vm.Script syntax compile) let a game through that
// parsed fine but was dead at runtime — assignment-to-const TypeError on frame 1, wrong
// element id, no re-scheduling game loop → blank canvas. "Run it to verify it works"
// has to mean actually running it: load the document in the app's own bundled Electron
// (offscreen, sandboxed — no system Chrome dependency), collect console errors, press
// the arrow keys, and require a canvas that is actually drawn to.
//
// Returns null when the artifact passes, else a short human-readable problem string
// fed back to the FM as repair feedback. Any infrastructure failure (Electron missing,
// harness timeout) returns null with a debug event — the gate must never turn a working
// pipeline into a broken one because a verifier dependency is absent.

import { execFile } from 'child_process'
import { writeFile, unlink } from 'fs/promises'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'
import os from 'os'
import { debugBus } from '../debug/bus'

// ESM project ("type": "module") — no __dirname/require; derive both.
const _require = createRequire(import.meta.url)
const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'htmlVerifyMain.cjs')

function electronBin(): string {
  // require('electron') returns the binary path under Node (not inside Electron itself).
  return _require('electron') as unknown as string
}

interface Probe {
  errors: string[]; canvas: boolean; drawn: boolean; drawnAtLoad?: boolean
  selfAnimated?: boolean; inputCausedChange?: boolean
  keys?: { registered: number; fired: number } | null
  // Visible readout — every distinct string the game DREW (canvas fillText/strokeText) plus
  // the HUD/score/status element text, collected across the play session. runtimeVerifyHtml
  // scans these for a broken numeric readout (NaN/undefined/Infinity). Undefined on the older
  // harness → the check is skipped (fail-open).
  texts?: string[]
  // Readout snapshot captured at LOAD, before any synthetic input — used for the terminal-state
  // check (a game that already reads "GAME OVER" before the player acts). Undefined on the older
  // harness → the check is skipped (fail-open).
  loadText?: string[]
  // Directional-control probe: horizontal ink centroid after a Left-only burst vs after a
  // Right-only burst. Correct left/right controls end the player mass further right. Null when
  // the harness couldn't measure it (no canvas ink) or on the older harness → check skipped.
  dir?: { left: number; right: number; w: number; inkL: number; inkR: number } | null
}

// Injected into the VERIFY COPY only (never the shipped artifact): wraps keydown/keyup
// listener registration so the harness can tell whether its synthetic arrow-key presses
// actually reached a game handler. Covers addEventListener AND onkeydown-property games.
const KEY_INSTRUMENTATION = `<script>
(function () {
  window.__crucibleKeys = { registered: 0, fired: 0 };
  var orig = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if ((type === 'keydown' || type === 'keyup') && typeof fn === 'function') {
      window.__crucibleKeys.registered++;
      var wrapped = function () { window.__crucibleKeys.fired++; return fn.apply(this, arguments); };
      return orig.call(this, type, wrapped, opts);
    }
    return orig.call(this, type, fn, opts);
  };
  ['onkeydown', 'onkeyup'].forEach(function (prop) {
    [window, document].forEach(function (target) {
      var current = null;
      // Real delivery goes through one un-wrapped listener that delegates to the
      // latest assigned handler — shadowing the property alone would swallow it.
      orig.call(target, prop.slice(2), function (e) {
        if (current) { window.__crucibleKeys.fired++; return current.call(this, e); }
      });
      try {
        Object.defineProperty(target, prop, {
          configurable: true,
          get: function () { return current; },
          set: function (v) {
            if (typeof v === 'function') window.__crucibleKeys.registered++;
            current = typeof v === 'function' ? v : null;
          },
        });
      } catch (e) { /* non-configurable — addEventListener wrap still covers most games */ }
    });
  });
})();
</script>`

// Injected into the VERIFY COPY only: wraps canvas text drawing so the harness can read
// what the game actually SHOWS a player — the score/status readout. The dominant "passes
// aliveness but is broken" shape from the on-device FM is a game that runs, animates and
// takes input but whose readout is "Score: NaN" (a counter used before init, or a
// divide-by-zero / undefined-arithmetic on a collision). The pixel-signature gate is blind
// to it. We capture every distinct drawn string; runtimeVerifyHtml rejects a garbage readout.
const TEXT_INSTRUMENTATION = `<script>
(function () {
  window.__crucibleText = [];
  function record(s) {
    try {
      s = String(s);
      var arr = window.__crucibleText;
      if (!s || (arr.length && arr[arr.length - 1] === s)) return; // collapse consecutive repeats
      arr.push(s);
      if (arr.length > 60) arr.shift();
    } catch (e) { /* never let instrumentation break the game */ }
  }
  var proto = window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype;
  if (proto) {
    ['fillText', 'strokeText'].forEach(function (m) {
      var orig = proto[m];
      if (typeof orig !== 'function') return;
      proto[m] = function (text) { record(text); return orig.apply(this, arguments); };
    });
  }
})();
</script>`

function injectInstrumentation(html: string): string {
  // As early as possible so it wraps before any game script registers listeners or draws.
  const probes = `${KEY_INSTRUMENTATION}\n${TEXT_INSTRUMENTATION}`
  const m = html.match(/<head[^>]*>/i)
  if (m) return html.replace(m[0], `${m[0]}\n${probes}`)
  return probes + html
}

export async function runtimeVerifyHtml(html: string): Promise<string | null> {
  const tmp = path.join(os.tmpdir(), `crucible-html-verify-${Date.now()}-${process.pid}.html`)
  try {
    await writeFile(tmp, injectInstrumentation(html), 'utf8')
    const probe = await new Promise<Probe>((resolve, reject) => {
      execFile(electronBin(), [HARNESS, tmp], { timeout: 20000, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } },
        (err, stdout) => {
          const line = String(stdout ?? '').split('\n').find(l => l.trim().startsWith('{'))
          if (line) { try { return resolve(JSON.parse(line)) } catch { /* fall through */ } }
          reject(err ?? new Error('no probe output from harness'))
        })
    })
    if (probe.errors.length) {
      const uniq = [...new Set(probe.errors)].slice(0, 3)
      let hint = ''
      // The dominant runtime-error class from the on-device FM is using the event
      // parameter (`e`) outside its handler, or referencing an undeclared name. A raw
      // "ReferenceError: e is not defined" doesn't tell a small model where to look —
      // name the likely cause so the repair is targeted, not another blind regenerate.
      if (uniq.some(m => /ReferenceError:\s*e\b|\be is not defined/.test(m))) {
        hint = ' — you referenced the event variable `e` outside a keydown/keyup handler. `e` only exists INSIDE those handlers; in the loop/step/draw functions read your own state variables instead.'
      } else if (uniq.some(m => /is not defined/.test(m))) {
        hint = ' — you used a variable before declaring it. Declare EVERY variable with `let` at the top before the loop starts.'
      }
      return `runtime JavaScript errors when the page runs: ${uniq.join(' | ')}${hint}`
    }
    if (!probe.canvas) return 'no <canvas> element present at runtime'
    if (!probe.drawn) return 'the canvas is completely blank — nothing is ever drawn; make sure the game loop starts on load and requestAnimationFrame re-schedules itself every frame'
    if (probe.drawnAtLoad === false) return 'the canvas stays blank until the first keypress — the game must draw its initial frame immediately on load'
    // Terminal-state-on-load — a game-STATE invariant the aliveness checks are blind to. A game
    // that already reads "GAME OVER" / "you lose" / "you died" before the player has pressed a key
    // is over before it begins (the FM initialized a gameOver flag true, or spawned the player
    // already colliding, or ran a lose-check on frame 0). Snapshot is taken at LOAD, BEFORE the
    // synthetic key bursts, so a legitimate game-over the harness itself triggers can't false-trip
    // this. Only loss/over phrases (never "win", which appears in instructions like "reach the goal
    // to win"). Skipped on the older harness (loadText undefined → fail-open).
    if (probe.loadText && probe.loadText.length) {
      const term = probe.loadText.find(t => /\bgame\s*over\b|\byou\s*(?:lose|lost|died|die)\b/i.test(t))
      if (term) {
        return `the game shows a terminal "${term.trim().slice(0, 40)}" state on load, before the player has done anything — it is over before it begins. ` +
          'Start the game in a PLAYABLE state: set any gameOver/dead flag to false at init, spawn the player somewhere not already colliding, and only run the lose check AFTER movement has happened — never on the first frame.'
      }
    }
    // Visible-readout sanity — the first game-STATE invariant (beyond "is it alive"). A real
    // game's score/status is a number; it is never the literal text "NaN", "undefined", or
    // "Infinity". The aliveness checks above happily pass a game that draws, animates and
    // takes input while its readout is garbage — a counter incremented before it was set to 0,
    // or a divide-by-zero on a collision. This is the invariant the loop CAN verify without
    // knowing the game's rules: what it prints must be well-formed. Only enforced when the
    // probe actually collected drawn text (older harness → texts undefined → skip, fail-open).
    if (probe.texts && probe.texts.length) {
      const bad = probe.texts.find(t => /\b(?:NaN|Infinity)\b/.test(t) || /\bundefined\b/.test(t))
      if (bad) {
        return `the on-screen score/status reads "${bad.trim().slice(0, 60)}" — a counter or score became NaN/undefined/Infinity while the game ran. ` +
          'Initialize every score/counter to 0 (e.g. `let score = 0`) BEFORE the game loop starts, never do arithmetic with a variable you have not assigned, and guard any division so you never divide by zero.'
      }
    }
    // Input responsiveness — the harness pressed all four arrow keys; a keyboard game
    // where no keydown handler ever fired is unplayable even if it draws and animates.
    if (probe.keys && probe.keys.registered > 0 && probe.keys.fired === 0) {
      return 'keyboard handlers are registered but never fire — arrow-key presses do not reach the game; listen for keydown on window/document'
    }
    if (probe.keys && probe.keys.registered === 0) {
      return 'no keyboard input handling at runtime — register a keydown listener (ArrowUp/Down/Left/Right) so the game is controllable'
    }
    // Aliveness — the strongest check. A real action game either animates on its own
    // (gravity, moving obstacles, a falling piece) or visibly changes when the player
    // acts. A canvas that does NEITHER drew one frame and froze — the classic
    // requestAnimationFrame-called-once / never-cleared-and-redrawn bug. Only enforced
    // when the probe actually ran both measurements (older harness → fields undefined).
    if (probe.selfAnimated === false && probe.inputCausedChange === false) {
      return 'the game is frozen — the canvas draws one frame and never changes again, and pressing keys changes nothing. The game loop must call requestAnimationFrame(loop) EVERY frame (not once), clear and redraw the whole canvas each frame, and advance the game state (movement, gravity, obstacles) over time so play actually happens.'
    }
    // Directional-control invariant — the second game-STATE behavioral check. After a Left-only
    // burst then a Right-only burst, a game whose horizontal controls work ends its drawn mass
    // further RIGHT (the player moved right). Common-mode motion (scrolling obstacles, gravity)
    // drifts both phases the same way and cancels in the left→right difference, so only the
    // player's key-driven motion survives. We reject ONLY a strong reversal — the right burst
    // ending well LEFT of the left burst — which means ArrowRight moved the player left (or the
    // two keys are swapped). A high threshold (≥18% of canvas width) plus a minimum-ink guard
    // keeps this fail-open: games that don't use left/right (flappy, vertical shooters) show a
    // near-zero delta and pass, and centroid noise never trips it. Skipped on the older harness.
    if (probe.dir && probe.dir.w > 0 && probe.dir.inkL > 20 && probe.dir.inkR > 20) {
      const { left, right, w } = probe.dir
      if (right - left < -0.18 * w) {
        return 'the left/right controls appear inverted — after pressing only ArrowLeft and then only ArrowRight, the player ended up further LEFT, not right. ArrowRight must increase the player\'s x (move it right) and ArrowLeft must decrease it; check that you are not adding to x on Left and subtracting on Right.'
      }
    }
    return null
  } catch (e: any) {
    debugBus.emit('agent', 'html_runtime_verify_unavailable', {
      error: String(e?.message ?? e).slice(0, 120),
    }, { severity: 'warn' })
    return null
  } finally {
    unlink(tmp).catch(() => {})
  }
}

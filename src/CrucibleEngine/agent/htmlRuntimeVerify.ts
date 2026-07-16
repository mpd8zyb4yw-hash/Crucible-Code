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
  // Fire-control probe (shooter goals only): the per-frame object-draw MAX during a no-input
  // window vs a firing window. A working trigger spawns projectiles → fireMax > ambientMax; a
  // dead trigger adds nothing → fireMax ≈ ambientMax. Null when not a shooter or unmeasurable.
  fire?: { ambientMax: number; fireMax: number } | null
  // ── APP-kind probes (CRUCIBLE_HTML_KIND=app; undefined on the game path) ──
  // Number of VISIBLE interactive controls rendered (button/input/select/textarea/[onclick]),
  // and of text-ENTRY controls specifically, measured before and after the interaction.
  controls?: number
  fields?: number
  controlsAfter?: number | null
  fieldsAfter?: number | null
  // Did the DOM structurally change after filling the fields and clicking the primary control?
  // null when unmeasurable → check skipped (fail-open).
  domChanged?: boolean | null
  // Did the VISIBLE text (innerText) change after committing? The meaningful signal — an app can
  // churn its innerHTML (re-append a node) while what the user reads is identical.
  textChanged?: boolean | null
  // What the probe actually did — which control it clicked, how many fields it filled. Reported
  // in the rejection text so the repair feedback names the exact control that did nothing.
  interact?: { filled: number; clicked: number; control: string | null } | null
  // Was the commit ADD-shaped — did the visible text grow and take up the value we typed? Gates
  // both commit invariants below, so that a search/filter box (text persists, list shrinks) is
  // never held to an add-list app's rules.
  addShaped?: boolean
  // Does a text field STILL hold the sentinel we typed, after the app committed it?
  fieldSentinelAfter?: boolean | null
  // Visible control count around a second commit performed with every field EMPTY. A grown count
  // means the app recorded a blank entry (a new row brings its own Delete button).
  emptyCommit?: { controlsBefore: number; controlsAfter: number } | null
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

// Injected into the VERIFY COPY only: counts discrete OBJECT-draw operations per frame so the
// harness can tell whether firing actually spawns projectiles. Ink AREA is useless here — a
// bullet is a handful of pixels against a whole alien formation — but each bullet is its own
// draw CALL (fillRect/arc/drawImage/…), so counting calls is size-independent. We tally per
// frame (reset at each requestAnimationFrame boundary) and keep a running MAX; the harness reads
// and resets that max around a no-input window vs a firing window. A working trigger adds ≥1
// sustained object → fireMax > ambientMax; a dead trigger (the classic e.key==='Space' bug) adds
// zero → fireMax ≈ ambientMax. Counting is size- and position-blind, so it can't be fooled by a
// large static formation the way ink area was.
const DRAW_INSTRUMENTATION = `<script>
(function () {
  window.__crucibleDraw = { cur: 0, max: 0 };
  var proto = window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype;
  if (proto) {
    ['fillRect', 'strokeRect', 'fill', 'stroke', 'fillText', 'strokeText', 'drawImage', 'arc', 'ellipse', 'rect'].forEach(function (m) {
      var orig = proto[m];
      if (typeof orig !== 'function') return;
      proto[m] = function () { try { window.__crucibleDraw.cur++; } catch (e) {} return orig.apply(this, arguments); };
    });
  }
  // Frame boundary: the ops counted since the previous boundary belong to the frame that just
  // finished drawing. Finalize the per-frame max, then reset for the next frame.
  if (typeof window.requestAnimationFrame === 'function') {
    var raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = function (cb) {
      return raf(function (t) {
        var d = window.__crucibleDraw;
        if (d.cur > d.max) d.max = d.cur;
        d.cur = 0;
        return cb(t);
      });
    };
  }
})();
</script>`

function injectInstrumentation(html: string): string {
  // As early as possible so it wraps before any game script registers listeners or draws.
  const probes = `${KEY_INSTRUMENTATION}\n${TEXT_INSTRUMENTATION}\n${DRAW_INSTRUMENTATION}`
  const m = html.match(/<head[^>]*>/i)
  if (m) return html.replace(m[0], `${m[0]}\n${probes}`)
  return probes + html
}

/** Load the document in the bundled Electron offscreen and return the raw probe.
 *  `kind` selects the harness probe set; the game path is unchanged when kind === 'game'.
 *  Throws on any infrastructure failure — callers fail OPEN on that. */
async function runProbe(html: string, goal: string, kind: 'game' | 'app'): Promise<Probe> {
  const tmp = path.join(os.tmpdir(), `crucible-html-verify-${Date.now()}-${process.pid}.html`)
  try {
    // Instrumentation wraps canvas/key APIs — meaningful only to the game probes, so the app
    // path ships the document unmodified (nothing injected that could perturb what we measure).
    await writeFile(tmp, kind === 'game' ? injectInstrumentation(html) : html, 'utf8')
    return await new Promise<Probe>((resolve, reject) => {
      execFile(electronBin(), [HARNESS, tmp], {
        timeout: 20000,
        env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0', CRUCIBLE_GAME_GOAL: goal.slice(0, 300), CRUCIBLE_HTML_KIND: kind },
      }, (err, stdout) => {
        const line = String(stdout ?? '').split('\n').find(l => l.trim().startsWith('{'))
        if (line) { try { return resolve(JSON.parse(line)) } catch { /* fall through */ } }
        reject(err ?? new Error('no probe output from harness'))
      })
    })
  } finally {
    unlink(tmp).catch(() => {})
  }
}

/** Shared runtime-error check — identical for both kinds; a page that throws is broken either way. */
function runtimeErrorProblem(probe: Probe): string | null {
  if (!probe.errors.length) return null
  const uniq = [...new Set(probe.errors)].slice(0, 3)
  let hint = ''
  if (uniq.some(m => /ReferenceError:\s*e\b|\be is not defined/.test(m))) {
    hint = ' — you referenced the event variable `e` outside a keydown/keyup handler. `e` only exists INSIDE those handlers; in the loop/step/draw functions read your own state variables instead.'
  } else if (uniq.some(m => /is not defined/.test(m))) {
    hint = ' — you used a variable before declaring it. Declare EVERY variable with `let` at the top before the loop starts.'
  }
  return `runtime JavaScript errors when the page runs: ${uniq.join(' | ')}${hint}`
}

// A readout is broken when it literally shows NaN/undefined/Infinity — true of a game's score and
// an app's total alike. `\b` around undefined avoids matching prose like "undefined behavior".
const BAD_READOUT_RX = /\b(?:NaN|Infinity)\b|\bundefined\b/

export async function runtimeVerifyHtml(html: string, goal = ''): Promise<string | null> {
  try {
    const probe = await runProbe(html, goal, 'game')
    // The dominant runtime-error class from the on-device FM is using the event parameter (`e`)
    // outside its handler, or referencing an undeclared name — runtimeErrorProblem names the
    // likely cause so the repair is targeted, not another blind regenerate.
    const errProblem = runtimeErrorProblem(probe)
    if (errProblem) return errProblem
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
      const bad = probe.texts.find(t => BAD_READOUT_RX.test(t))
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
    // Fire-control invariant — the core mechanic of a shooting game, and the one every earlier
    // check is blind to. The harness compared per-frame object-draw counts with no input vs while
    // firing a burst of Space. A working trigger spawns projectiles → at least one more object is
    // drawn per frame → fireMax exceeds ambientMax. If firing a shooter draws NO new objects, the
    // trigger is dead and the game is unplayable. Floor of 3 on ambientMax skips games we couldn't
    // meaningfully measure (no per-frame object draws) → fail-open.
    if (probe.fire && probe.fire.ambientMax >= 3 && probe.fire.fireMax <= probe.fire.ambientMax) {
      return 'pressing the fire key (Space) spawns no projectile — firing draws nothing new, so the game cannot actually be played. ' +
        'The space bar\'s KeyboardEvent.key is \' \' (a single space), NOT \'Space\' (that is event.code) — listen for `e.key === \' \'`. ' +
        'On each shot push a bullet onto your bullets array at the player\'s position, move every bullet toward the enemies each frame, and draw it.'
    }
    return null
  } catch (e: any) {
    debugBus.emit('agent', 'html_runtime_verify_unavailable', {
      error: String(e?.message ?? e).slice(0, 120),
    }, { severity: 'warn' })
    return null
  }
}

// ── Non-game interactive HTML ────────────────────────────────────────────────
// The app analogue of runtimeVerifyHtml. A todo list, calculator or dashboard has no canvas, no
// game loop and no arrow keys, so every game invariant above is either meaningless or actively
// WRONG for it (the game gate rejects a correct todo app with "no <canvas> element present").
//
// What IS universally true of a generated app, without knowing its rules:
//   1. It must not throw at runtime.                       (same as a game)
//   2. Its readout must be well-formed — never "Total: NaN". (same as a game)
//   3. IF it renders interactive controls, they must DO something: filling the fields and clicking
//      the primary control must change the DOM.
//
// (3) is the behavioral core, and it is deliberately conditioned on controls EXISTING rather than
// required outright. "You built a button, so it must work" is true of every app; "an .html file
// must be interactive" is NOT (a landing page is legitimately static), and enforcing the latter
// would re-create in miniature the exact false-reject this module was written to kill. Every check
// is skipped when its probe field is absent (older harness → fail-open), same as the game path.
export async function runtimeVerifyApp(html: string, goal = ''): Promise<string | null> {
  try {
    const probe = await runProbe(html, goal, 'app')
    const errProblem = runtimeErrorProblem(probe)
    if (errProblem) return errProblem

    // Readout sanity — a calculator that shows "Total: NaN" runs and responds, so nothing else
    // here catches it. Same invariant as the game score, different surface (rendered body text).
    if (probe.texts && probe.texts.length) {
      const bad = probe.texts.find(t => BAD_READOUT_RX.test(t))
      if (bad) {
        const snippet = (bad.match(/[^\n]*\b(?:NaN|Infinity|undefined)\b[^\n]*/) ?? [bad])[0]
        return `the page displays "${snippet.trim().slice(0, 60)}" — a value became NaN/undefined/Infinity while the app ran. ` +
          'Initialize every counter/total to 0 before use, never do arithmetic on a variable you have not assigned, ' +
          'parse text input with Number(...) and guard against empty/invalid input, and never divide by zero.'
      }
    }

    // Blank-render invariant — the app analogue of the game's blank-canvas check, and the third
    // distinct bug the first live runs produced (cont.79e): the FM created its input and button but
    // never appended them to the page, so index.html rendered an empty <body> with zero controls.
    // Every check below is conditioned on controls existing, so a blank page passed them all
    // vacuously. A page that shows NOTHING — no text a user can read and no control they can touch —
    // is never a correct app. This does NOT hit a legitimate static page: that has real content
    // (headings, copy), so its loadText is non-empty. Guarded on loadText being measured.
    if (probe.loadText && probe.loadText.length) {
      const visibleText = probe.loadText.join(' ').replace(/\s+/g, ' ').trim()
      if (visibleText.length < 2 && (probe.controls ?? 0) === 0) {
        return 'the page renders nothing — its <body> is empty at load: no text to read and no button or input to interact with. ' +
          'Make sure you actually attach what you build to the page: every element you create must be added to the document ' +
          '(append it to #app or to something already inside #app), and render() must run on load. A control you create but never ' +
          'append to the DOM does not exist for the user.'
      }
    }
    // Self-erasing-UI invariant. Found by READING what a passing live run actually produced
    // (cont.79e): the FM built a todo app whose render() does `app.innerHTML = ''` and re-appends
    // only the list — the input and Add button were appended OUTSIDE render(), so the first
    // interaction deleted them. It throws nothing and the DOM certainly "changed", so the
    // dead-control check below passes it; the app is nonetheless unusable after one click.
    // "If you rendered a way to type, it must still be there after I use it" is true of every app
    // that has one. Guarded on fieldsAfter being measured (older harness → undefined → skip).
    if (probe.fields && probe.fields > 0 && probe.fieldsAfter === 0) {
      return 'the app erases its own interface: it rendered a text field, but after one interaction the field is gone — the app cannot be used a second time. ' +
        'This happens when render() clears its container (app.innerHTML = \'\') but only re-creates PART of the UI. ' +
        'Build the ENTIRE interface inside render() — the input, the buttons AND the list — so that everything is re-created every time you re-render.'
    }
    // Dead-control / no-visible-effect invariant — the dominant broken-app shape from a small
    // model, and the one that survived the first no-template live run (cont.79f): the handler runs
    // and mutates state, but never RE-RENDERS, so the item the user just entered is recorded and
    // never shown. The earlier version keyed on `domChanged` (innerHTML) and MISSED this — the
    // broken todo did `tasks.push(x); app.appendChild(row)`, which churns innerHTML while the
    // visible list stays empty. The correct signal is VISIBLE change: after committing, either the
    // text a user reads changed, or the number of controls changed (e.g. a new row appeared). If
    // NEITHER did, the interaction produced nothing observable — the app is unusable.
    //   * Requires a text field to have been filled (interact.filled > 0) so this fires only on
    //     data-entry apps, never on a style-only toggle (color swatch) whose effect isn't textual.
    //   * textChanged/controlsAfter undefined on the older harness → skip (fail-open).
    const filledData = (probe.interact?.filled ?? 0) > 0
    const controlCountChanged = probe.controlsAfter != null && probe.controlsAfter !== probe.controls
    const nothingVisible = probe.textChanged === false && !controlCountChanged
    if (filledData && probe.textChanged != null && nothingVisible) {
      const ctl = probe.interact?.control
      const which = ctl ? `the "${ctl}" control` : 'the primary control'
      return `the app does nothing visible: after typing into the field and clicking ${which}, nothing the user can see changed — the value you entered never appears. ` +
        'The handler likely updates a state variable (or re-appends the form) but never re-renders the list/output. ' +
        'At the END of every handler, call render() so the view is rebuilt from the updated state — and make render() actually draw the current data (e.g. one <li> per item), not just re-add the input.'
    }
    // ── Commit-shape invariants ──────────────────────────────────────────────
    // Both fire only on an ADD-shaped commit (the app took our typed value and appended it to the
    // page). That gate is what keeps them universal rather than todo-specific: a search box, a
    // filter, a calculator and a static page are all add-shaped=false and skip these entirely.
    // Both come from bugs the first template-free live run actually shipped (cont.79f) — it passed
    // every check above and was still subtly wrong to use.
    if (probe.addShaped) {
      // (a) empty-commit-adds-nothing. The missing `if (!value.trim()) return` guard: pressing Add
      // on an empty field records a blank entry. Keyed on the control count growing, because a
      // blank row brings its own Delete button, while a correct guard that renders a "please enter
      // something" message adds text but no control — so a guarded app passes either way.
      const ec = probe.emptyCommit
      if (ec && ec.controlsAfter > ec.controlsBefore) {
        return 'the app records empty entries: clearing the text field and pressing the commit control anyway added a blank item to the list. ' +
          'Guard the handler before it records anything — read the field, trim it, and if the result is an empty string, return immediately ' +
          'without adding to the list or re-rendering.'
      }
      // (b) field-clears-after-commit. The handler adds the item but leaves the text sitting in the
      // field, so the user's next entry types onto the end of the previous one. Only meaningful
      // while the field still exists (the self-erasing check above owns the field-is-gone case).
      if (probe.fieldSentinelAfter === true && (probe.fieldsAfter ?? 0) > 0) {
        return 'the app does not clear the input after committing: the text that was just added to the list is still sitting in the field, ' +
          'so the next thing the user types is appended to it. After you add the value to your state and re-render, reset the field to an ' +
          'empty string (input.value = \'\') so it is ready for the next entry.'
      }
    }
    // Fallback for pure-button apps (no field filled) that are entirely inert — nothing changed at
    // all, visible or otherwise. Keeps the original dead-wiring coverage for e.g. a broken counter.
    if (probe.controls && probe.controls > 0 && !filledData && probe.domChanged === false && probe.textChanged === false) {
      const ctl = probe.interact?.control
      const which = ctl ? `the "${ctl}" control` : 'the primary control'
      return `the app does not respond: after clicking ${which}, the page did not change at all. ` +
        'The controls render but nothing is wired to them. Make sure you (a) attach the listener AFTER the element exists, ' +
        '(b) look the element up by the id it actually has, and (c) re-render the view at the end of the handler.'
    }
    return null
  } catch (e: any) {
    debugBus.emit('agent', 'html_runtime_verify_unavailable', {
      error: String(e?.message ?? e).slice(0, 120), kind: 'app',
    }, { severity: 'warn' })
    return null
  }
}

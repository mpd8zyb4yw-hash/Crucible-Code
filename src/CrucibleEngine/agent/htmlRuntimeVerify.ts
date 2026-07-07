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
  errors: string[]; canvas: boolean; drawn: boolean; animating: boolean; drawnAtLoad?: boolean
  keys?: { registered: number; fired: number } | null
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

function injectKeyInstrumentation(html: string): string {
  // As early as possible so it wraps before any game script registers listeners.
  const m = html.match(/<head[^>]*>/i)
  if (m) return html.replace(m[0], `${m[0]}\n${KEY_INSTRUMENTATION}`)
  return KEY_INSTRUMENTATION + html
}

export async function runtimeVerifyHtml(html: string): Promise<string | null> {
  const tmp = path.join(os.tmpdir(), `crucible-html-verify-${Date.now()}-${process.pid}.html`)
  try {
    await writeFile(tmp, injectKeyInstrumentation(html), 'utf8')
    const probe = await new Promise<Probe>((resolve, reject) => {
      execFile(electronBin(), [HARNESS, tmp], { timeout: 20000, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } },
        (err, stdout) => {
          const line = String(stdout ?? '').split('\n').find(l => l.trim().startsWith('{'))
          if (line) { try { return resolve(JSON.parse(line)) } catch { /* fall through */ } }
          reject(err ?? new Error('no probe output from harness'))
        })
    })
    if (probe.errors.length) {
      return `runtime JavaScript errors when the page runs: ${[...new Set(probe.errors)].slice(0, 3).join(' | ')}`
    }
    if (!probe.canvas) return 'no <canvas> element present at runtime'
    if (!probe.drawn) return 'the canvas is completely blank — nothing is ever drawn; make sure the game loop starts on load and requestAnimationFrame re-schedules itself every frame'
    if (probe.drawnAtLoad === false) return 'the canvas stays blank until the first keypress — the game must draw its initial frame immediately on load'
    // Input responsiveness — the harness pressed all four arrow keys; a keyboard game
    // where no keydown handler ever fired is unplayable even if it draws and animates.
    if (probe.keys && probe.keys.registered > 0 && probe.keys.fired === 0) {
      return 'keyboard handlers are registered but never fire — arrow-key presses do not reach the game; listen for keydown on window/document'
    }
    if (probe.keys && probe.keys.registered === 0) {
      return 'no keyboard input handling at runtime — register a keydown listener (ArrowUp/Down/Left/Right) so the game is controllable'
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

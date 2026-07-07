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

interface Probe { errors: string[]; canvas: boolean; drawn: boolean; animating: boolean }

export async function runtimeVerifyHtml(html: string): Promise<string | null> {
  const tmp = path.join(os.tmpdir(), `crucible-html-verify-${Date.now()}-${process.pid}.html`)
  try {
    await writeFile(tmp, html, 'utf8')
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

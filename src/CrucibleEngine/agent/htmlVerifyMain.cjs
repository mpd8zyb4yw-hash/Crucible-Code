// Headless runtime harness for generated single-file HTML games.
// Run as: electron htmlVerifyMain.cjs <path-to-html>
//
// Loads the file offscreen and answers three questions a real player would:
//   1. Does it draw something the moment it loads? (drawnAtLoad)
//   2. Is it ALIVE — does the canvas keep changing on its own with no input? (selfAnimated)
//      This is the check that catches the single most common broken-game shape: a loop
//      that runs one frame and never reschedules (requestAnimationFrame called once), or
//      never clears+redraws. Such a game draws at load and has a keydown listener, so the
//      weaker "drawn + listener present" gate passed it — but it's frozen.
//   3. Does input visibly change the world? (inputCausedChange) — for the rare game that
//      is legitimately static until the player acts.
// A game must be alive OR input-responsive; a frozen, input-inert canvas is not a game.
// Prints one JSON line to stdout and exits.
const { app, BrowserWindow } = require('electron')
const path = require('path')

const target = process.argv[process.argv.length - 1]
const out = { errors: [], canvas: false, drawn: false, selfAnimated: false, inputCausedChange: false }
const done = (code) => { try { process.stdout.write(JSON.stringify(out) + '\n') } catch {} app.exit(code) }

// A cheap two-stride signature of the canvas — a single strided sum can coincidentally
// match across frames; two independent strides make a false "unchanged" far less likely.
const SIG = `(() => {
  const c = document.querySelector('canvas'); if (!c) return null;
  const ctx = c.getContext('2d'); if (!ctx) return null;
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let a = 0, b = 0;
  for (let i = 0; i < d.length; i += 97) a += d[i];
  for (let i = 1; i < d.length; i += 61) b += d[i] * ((i % 7) + 1);
  return a + ':' + b;
})()`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { offscreen: true, sandbox: true } })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) out.errors.push(String(message).slice(0, 160))
  })
  const sig = () => win.webContents.executeJavaScript(SIG, true).catch(() => null)
  const wait = ms => new Promise(r => setTimeout(r, ms))
  try {
    await win.loadFile(path.resolve(target))
    await wait(650)

    out.drawnAtLoad = await win.webContents.executeJavaScript(
      `(() => { const s = ${SIG}; return !!s && s !== '0:0'; })()`, true
    ).catch(() => false)

    // (2) Self-animation — sample twice with NO input in between.
    const s1 = await sig()
    await wait(520)
    const s2 = await sig()
    out.canvas = s1 !== null
    out.drawn = out.drawnAtLoad || (!!s2 && s2 !== '0:0')
    out.selfAnimated = !!s1 && !!s2 && s1 !== s2

    // (3) Input response — baseline, drive keys (arrows + space + WASD + enter, since
    // flap/shoot/rotate games bind different keys), then re-sample.
    const before = await sig()
    for (const key of ['Up', 'Down', 'Left', 'Right', 'Space', 'W', 'A', 'S', 'D', 'Return']) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
      await wait(30)
    }
    await wait(480)
    const after = await sig()
    out.inputCausedChange = !!before && !!after && before !== after

    // Instrumentation counter (injected by runtimeVerifyHtml into the verify copy only):
    // registered>0,fired>0 means a real handler received our synthetic presses.
    out.keys = await win.webContents.executeJavaScript(
      `window.__crucibleKeys ? { registered: window.__crucibleKeys.registered, fired: window.__crucibleKeys.fired } : null`, true
    ).catch(() => null)

    done(0)
  } catch (e) {
    out.errors.push('harness: ' + String(e && e.message || e).slice(0, 160))
    done(0)
  }
})
setTimeout(() => done(0), 15000)

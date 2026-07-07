// Headless runtime harness for generated single-file HTML games.
// Run as: electron htmlVerifyMain.cjs <path-to-html>
// Loads the file in an offscreen BrowserWindow, collects page errors, presses the
// arrow keys, then probes the canvas twice to confirm something is drawn and the
// frame keeps changing. Prints one JSON line to stdout and exits.
const { app, BrowserWindow } = require('electron')
const path = require('path')

const target = process.argv[process.argv.length - 1]
const out = { errors: [], canvas: false, drawn: false, animating: false }
const done = (code) => { try { process.stdout.write(JSON.stringify(out) + '\n') } catch {} app.exit(code) }

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { offscreen: true, sandbox: true } })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) out.errors.push(String(message).slice(0, 160))
  })
  try {
    await win.loadFile(path.resolve(target))
    await new Promise(r => setTimeout(r, 700))
    // The game must render BEFORE any input — a canvas that stays blank until the
    // first keypress reads as broken to the user.
    out.drawnAtLoad = await win.webContents.executeJavaScript(`(() => {
      const c = document.querySelector('canvas')
      if (!c) return false
      const ctx = c.getContext('2d')
      if (!ctx) return false
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let s = 0; for (let i = 0; i < d.length; i += 97) s += d[i]
      return s > 0
    })()`, true).catch(() => false)
    for (const key of ['Up', 'Right', 'Down', 'Left']) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
    }
    await new Promise(r => setTimeout(r, 400))
    const probe = await win.webContents.executeJavaScript(`(() => {
      const c = document.querySelector('canvas')
      if (!c) return Promise.resolve({ canvas: false, drawn: false, animating: false })
      const ctx = c.getContext('2d')
      const sum = d => { let s = 0; for (let i = 0; i < d.length; i += 97) s += d[i]; return s }
      const a = ctx ? sum(ctx.getImageData(0, 0, c.width, c.height).data) : 0
      return new Promise(res => setTimeout(() => {
        const b = ctx ? sum(ctx.getImageData(0, 0, c.width, c.height).data) : 0
        res({ canvas: true, drawn: a > 0 || b > 0, animating: a !== b })
      }, 500))
    })()`, true)
    Object.assign(out, probe)
    done(0)
  } catch (e) {
    out.errors.push('harness: ' + String(e && e.message || e).slice(0, 160))
    done(0)
  }
})
setTimeout(() => done(0), 15000)

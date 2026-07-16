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
const out = { errors: [], canvas: false, drawn: false, selfAnimated: false, inputCausedChange: false, texts: [], loadText: [], dir: null }
const done = (code) => { try { process.stdout.write(JSON.stringify(out) + '\n') } catch {} app.exit(code) }

// KIND — 'app' runs the DOM probe path instead of the canvas/keyboard game probes. The game path
// below is left byte-identical when this is unset, so game results stay comparable across this
// change (the same discipline the fault harness needed).
const KIND = process.env.CRUCIBLE_HTML_KIND === 'app' ? 'app' : 'game'

// Structural signature of the rendered DOM: length + a cheap rolling hash of body.innerHTML. The
// app analogue of the canvas pixel signature — it answers "did anything actually change?" without
// knowing what the app is supposed to do. Length alone is too weak (an edit can preserve it).
const DOM_SIG = `(() => {
  const b = document.body; if (!b) return null;
  const s = b.innerHTML;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return s.length + ':' + h;
})()`

// Count the interactive controls the document actually RENDERS (visible only — a hidden template
// node isn't a control a user can reach). `fields` counts text-entry controls specifically: an app
// that renders a text field and then ERASES it on first interaction has destroyed its own UI, and
// that is invisible to a plain did-the-DOM-change check (the DOM changed — by deleting the form).
const DOM_CONTROLS = `(() => {
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const all = [...document.querySelectorAll('button, input, select, textarea, [onclick], [role=button]')].filter(vis);
  const fields = all.filter(el => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag !== 'input') return false;
    const t = String(el.type || 'text').toLowerCase();
    return t !== 'submit' && t !== 'button' && t !== 'reset' && t !== 'image' && t !== 'hidden';
  });
  return { controls: all.length, fields: fields.length };
})()`

// Drive the app the way a user would: fill every visible text field with a sentinel, THEN click the
// primary control. Filling first is essential — the dominant real handler shape is guarded
// (`if (!value) return`), so clicking an empty form is a no-op and would look like a dead button.
// We use el.click() / synthetic input events rather than coordinate clicks: offscreen hit-testing by
// pixel is unreliable, and .click() still runs the app's real listeners.
const DOM_INTERACT = `(() => {
  const out = { filled: 0, clicked: 0, control: null };
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  [...document.querySelectorAll('input, textarea')].filter(vis).forEach(el => {
    const t = String(el.type || 'text').toLowerCase();
    if (t === 'submit' || t === 'button' || t === 'file' || t === 'hidden' || t === 'image') return;
    if (t === 'checkbox' || t === 'radio') el.checked = true;
    else if (t === 'number' || t === 'range') el.value = '7';
    else if (t === 'date') el.value = '2026-07-16';
    else el.value = 'Crucible check';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    out.filled++;
  });
  const btns = [...document.querySelectorAll('button, input[type=submit], input[type=button], [onclick], [role=button]')].filter(vis);
  if (btns.length) {
    out.control = String(btns[0].textContent || btns[0].value || '').trim().slice(0, 40);
    try { btns[0].click(); out.clicked++; } catch (e) { /* a throwing handler surfaces as a console error */ }
  }
  return out;
})()`

// Visible text a user would actually read — used for the NaN/undefined readout check. innerText
// (not textContent) so hidden nodes don't produce phantom readouts.
const DOM_TEXT = `(() => (document.body ? String(document.body.innerText || '').slice(0, 4000) : ''))()`

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

// Horizontal centroid of the drawn "ink" — the mean x of every pixel that differs from the
// top-left background color, weighted equally. Used for the directional-control invariant:
// after a Left-only then a Right-only burst, a game with correct controls ends its player
// mass further RIGHT. Returns {cx, ink, w} or null.
const CENTROID = `(() => {
  const c = document.querySelector('canvas'); if (!c) return null;
  const ctx = c.getContext('2d'); if (!ctx) return null;
  const w = c.width, h = c.height;
  const d = ctx.getImageData(0, 0, w, h).data;
  const br = d[0], bg = d[1], bb = d[2];
  let sx = 0, ink = 0;
  for (let y = 0; y < h; y += 4) {
    for (let x = 0; x < w; x += 4) {
      const i = (y * w + x) * 4;
      const dev = Math.abs(d[i] - br) + Math.abs(d[i + 1] - bg) + Math.abs(d[i + 2] - bb);
      if (dev > 40) { sx += x; ink += 1; }
    }
  }
  return ink > 0 ? { cx: sx / ink, ink: ink, w: w } : null;
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

    // ── APP path: DOM behavior, not canvas aliveness ─────────────────────────
    // Returns before any game probe: an app has no canvas to sample and no arrow keys to press,
    // and the game probes would report meaningless nulls for it.
    if (KIND === 'app') {
      const ex = (js, fb) => win.webContents.executeJavaScript(js, true).catch(() => fb)
      const c0 = await ex(DOM_CONTROLS, null)
      out.controls = c0 ? c0.controls : 0
      out.fields = c0 ? c0.fields : 0
      out.loadText = [await ex(DOM_TEXT, '')]
      const before = await ex(DOM_SIG, null)
      out.interact = await ex(DOM_INTERACT, null)
      await wait(420)                       // let async handlers (render, fetch-free timers) settle
      const after = await ex(DOM_SIG, null)
      out.domChanged = (before !== null && after !== null) ? before !== after : null
      const c1 = await ex(DOM_CONTROLS, null)
      out.controlsAfter = c1 ? c1.controls : null
      out.fieldsAfter = c1 ? c1.fields : null
      out.texts = [await ex(DOM_TEXT, '')]
      return done(0)
    }

    out.drawnAtLoad = await win.webContents.executeJavaScript(
      `(() => { const s = ${SIG}; return !!s && s !== '0:0'; })()`, true
    ).catch(() => false)

    // Readout snapshot taken NOW — before any synthetic input — so the terminal-state check sees
    // the game's INITIAL state, not a legitimate game-over the key bursts below might trigger.
    out.loadText = await win.webContents.executeJavaScript(
      `(() => {
        const arr = (window.__crucibleText || []).slice();
        ['hud','score','status','scoreboard','message','msg','gameover','game-over','overlay'].forEach(id => {
          const el = document.getElementById(id);
          if (el && el.textContent) arr.push(el.textContent);
        });
        return arr.slice(-40).map(s => String(s).slice(0, 120));
      })()`, true
    ).catch(() => [])

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

    // (4) Directional-control probe — a BEHAVIORAL invariant beyond "input changed something".
    // Drive Left-only, sample the ink centroid; then Right-only (more presses, to overshoot
    // back past the start), sample again. A game whose Left/Right controls work ends its
    // player mass further RIGHT after the Right burst than after the Left burst. Scrolling
    // obstacles drift the same way in both phases, so their contribution largely cancels in
    // the left→right difference; only the player's key-driven motion is directional.
    const cen = () => win.webContents.executeJavaScript(CENTROID, true).catch(() => null)
    const pressN = async (key, n) => {
      for (let k = 0; k < n; k++) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
        await wait(35)
      }
    }
    await pressN('Left', 12)
    await wait(220)
    const cL = await cen()
    await pressN('Right', 24)
    await wait(220)
    const cR = await cen()
    out.dir = (cL && cR) ? { left: cL.cx, right: cR.cx, w: cL.w, inkL: cL.ink, inkR: cR.ink } : null

    // (5) Fire-control probe — a BEHAVIORAL invariant for shooting games (goal-gated via
    // CRUCIBLE_GAME_GOAL). A shooter whose trigger is dead (the classic `e.key === 'Space'` bug —
    // .key is ' ', not 'Space') draws, animates and steers, so every earlier check passes, yet you
    // can never fire: unplayable. Firing spawns a projectile = one more OBJECT drawn per frame.
    // We compare the per-frame draw-op MAX during a no-input window vs a firing window; the
    // injected DRAW_INSTRUMENTATION counts object-draw CALLS (size-blind, unlike ink area). The
    // ambient window absorbs timed-spawn growth, so only fire-caused objects lift fireMax above it.
    const drawMaxReset = () => win.webContents.executeJavaScript(
      `(() => { const d = window.__crucibleDraw; if (!d) return null; const m = d.max; d.max = d.cur; return m; })()`, true).catch(() => null)
    if (/\b(shoot|shooter|fire|bullet|laser|blast|missile|invader|gal(?:aga|axian)|asteroid|space\s*invad|gun|cannon|turret)\b/i.test(process.env.CRUCIBLE_GAME_GOAL || '')) {
      // Three windows: ambient-PRE, FIRE, ambient-POST. A projectile is TRANSIENT — it exists only
      // while firing, so a working trigger lifts fireMax above BOTH ambient windows. Timed-spawn
      // growth is PERSISTENT — it also raises ambient-POST, so it can't be mistaken for fire.
      await drawMaxReset()                 // clear max accumulated during earlier probes
      await wait(850)
      const preMax = await drawMaxReset()  // AMBIENT-PRE — no input
      for (let k = 0; k < 14; k++) {       // FIRE — repeat the trigger
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
        await wait(60)
      }
      const fireMax = await drawMaxReset()
      await wait(850)                      // AMBIENT-POST — no input, bullets have cleared
      const postMax = await drawMaxReset()
      out.fire = ([preMax, fireMax, postMax].every(v => typeof v === 'number'))
        ? { ambientMax: Math.max(preMax, postMax), fireMax: fireMax } : null
    }

    // Instrumentation counter (injected by runtimeVerifyHtml into the verify copy only):
    // registered>0,fired>0 means a real handler received our synthetic presses.
    out.keys = await win.webContents.executeJavaScript(
      `window.__crucibleKeys ? { registered: window.__crucibleKeys.registered, fired: window.__crucibleKeys.fired } : null`, true
    ).catch(() => null)

    // Visible readout — the score/status a player actually sees. The verify copy wraps canvas
    // fillText/strokeText (window.__crucibleText); we add the HUD/score/status element text.
    // runtimeVerifyHtml scans these for a broken numeric readout (NaN/undefined/Infinity).
    out.texts = await win.webContents.executeJavaScript(
      `(() => {
        const arr = (window.__crucibleText || []).slice();
        ['hud', 'score', 'status', 'scoreboard'].forEach(id => {
          const el = document.getElementById(id);
          if (el && el.textContent) arr.push(el.textContent);
        });
        return arr.slice(-80).map(s => String(s).slice(0, 120));
      })()`, true
    ).catch(() => [])

    done(0)
  } catch (e) {
    out.errors.push('harness: ' + String(e && e.message || e).slice(0, 160))
    done(0)
  }
})
setTimeout(() => done(0), 15000)

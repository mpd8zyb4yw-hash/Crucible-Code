// Session L — Text-to-speech for Remote Brain (agent speaks back on the Mac).
//
// The Remote Brain server runs ON the Mac (phone = window, Mac = body), so the simplest
// always-available, zero-dependency, free voice is macOS `say`. If the nicer free
// Microsoft Edge-TTS CLI happens to be installed we use it; otherwise we fall back to
// `say`. Input is passed via a temp FILE (never the shell) so arbitrary model text can
// never inject a command. speak() never throws and never blocks the response path.

import { exec } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Strip markdown / URLs so the spoken form is clean; cap very long answers to a short
// spoken summary (the full text is already on the user's screen).
function toSpoken(text: string): string {
  const clean = (text ?? '')
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/[*#>_\[\]()|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const words = clean.split(' ').filter(Boolean)
  if (words.length <= 100) return clean
  const sentences = clean.match(/[^.!?]+[.!?]+/g) ?? [clean]
  return `${sentences.slice(0, 2).join(' ').trim()} Full answer shown on screen.`
}

let warnedUnavailable = false

// Speak `text` on the Mac's speakers. Resolves when playback finishes (or immediately
// on any non-darwin / failure path). Safe to call fire-and-forget.
export async function speak(text: string): Promise<void> {
  const spoken = toSpoken(text)
  if (!spoken) return
  if (process.platform !== 'darwin') {
    if (!warnedUnavailable) { warnedUnavailable = true; console.log('[TTS] server-side speech is macOS-only — skipped') }
    return
  }
  const file = path.join(os.tmpdir(), `crucible-tts-${process.pid}-${Date.now()}.txt`)
  try { fs.writeFileSync(file, spoken) } catch { return }
  await new Promise<void>((resolve) => {
    // Prefer edge-tts (nicer voice) if present; else macOS `say`. File-based input only.
    exec('command -v edge-tts', (probeErr) => {
      const cleanup = () => { try { fs.unlinkSync(file) } catch { /* ignore */ } }
      if (!probeErr) {
        const out = path.join(os.tmpdir(), `crucible-tts-${process.pid}-${Date.now()}.mp3`)
        exec(`edge-tts --voice en-US-AriaNeural --file ${JSON.stringify(file)} --write-media ${JSON.stringify(out)} && afplay ${JSON.stringify(out)}`,
          () => { try { fs.unlinkSync(out) } catch {} ; cleanup(); resolve() })
      } else {
        exec(`say -f ${JSON.stringify(file)}`, () => { cleanup(); resolve() })
      }
    })
  }).catch(() => {})
}

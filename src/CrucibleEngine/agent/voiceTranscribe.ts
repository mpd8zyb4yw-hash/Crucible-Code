// ── Voice transcription — local, on-device speech-to-text via whisper.cpp ──
//
// Crucible's philosophy is on-device / no-cloud (see the offline-first vision). Browser
// SpeechRecognition would ship audio to Google, so voice STT runs through a LOCAL whisper.cpp
// binary + a ggml model, exactly like the GGUF LLM pool: the model is a downloadable asset,
// and until it's present the endpoint reports `needsModel` so the UI can guide setup rather
// than fail opaquely.
//
// Pipeline: browser MediaRecorder (webm/opus) → ffmpeg → 16 kHz mono WAV → whisper-cli → text.
// whisper.cpp requires 16 kHz PCM WAV input, and MediaRecorder can't produce that directly, so
// ffmpeg is a hard dependency of the transcode step. Both binaries are resolved from an env
// override first, then a bundled ./bin path, then PATH — so a user can point at an existing
// install or let Crucible manage one.

import { execFile } from 'node:child_process'
import { writeFile, unlink, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

const WHISPER_DIR = path.join(process.cwd(), '.crucible', 'whisper')
// The packaged app runs the server with cwd = the Electron userData dir (all user data keys
// off process.cwd() — see electron.cjs), but a model downloaded while running from the repo
// lands in the CODE dir's .crucible/whisper. Resolve the model from either location so the
// same install works in both run modes: env override → cwd (userData) → code dir.
const CODE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
function resolveModelPath(): string {
  if (process.env.WHISPER_MODEL) return process.env.WHISPER_MODEL
  const cwdModel = path.join(WHISPER_DIR, 'ggml-base.en.bin')
  if (existsSync(cwdModel)) return cwdModel
  const codeModel = path.join(CODE_DIR, '.crucible', 'whisper', 'ggml-base.en.bin')
  if (existsSync(codeModel)) return codeModel
  return cwdModel // canonical location — reported to the UI as where to install
}
const MODEL_PATH = resolveModelPath()

/** Resolve an executable: explicit env path → bundled ./bin → bare name on PATH (let the OS find it). */
function resolveBin(envVar: string, bundledName: string, fallback: string): string {
  const env = process.env[envVar]
  if (env && existsSync(env)) return env
  const bundled = path.join(process.cwd(), 'bin', bundledName)
  if (existsSync(bundled)) return bundled
  return fallback
}

function whisperBin(): string { return resolveBin('WHISPER_BIN', 'whisper-cli', 'whisper-cli') }
function ffmpegBin(): string { return resolveBin('FFMPEG_BIN', 'ffmpeg', 'ffmpeg') }

/** Does the named binary run at all? (`--help`/`-version` exits 0 when present.) */
function binWorks(bin: string, arg: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile(bin, [arg], { timeout: 4000 }, err => resolve(!err || (err as any).code === 1))
  })
}

export interface VoiceStatus {
  ready: boolean
  hasWhisper: boolean
  hasFfmpeg: boolean
  hasModel: boolean
  modelPath: string
}

/** Report whether the local voice stack is installed — surfaced to the UI so it can prompt setup. */
export async function voiceStatus(): Promise<VoiceStatus> {
  const [hasWhisper, hasFfmpeg] = await Promise.all([
    binWorks(whisperBin(), '--help'),
    binWorks(ffmpegBin(), '-version'),
  ])
  const hasModel = existsSync(MODEL_PATH)
  return { ready: hasWhisper && hasFfmpeg && hasModel, hasWhisper, hasFfmpeg, hasModel, modelPath: MODEL_PATH }
}

function run(bin: string, args: string[], timeout = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(bin)} failed: ${String(stderr || err.message).slice(0, 200)}`))
      else resolve(stdout)
    })
  })
}

export type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; needsModel: true; status: VoiceStatus }
  | { ok: false; needsModel: false; error: string }

/**
 * Transcribe a recorded audio clip to text, fully on-device. `audio` is a base64 data URL (or
 * bare base64) from the browser's MediaRecorder. Returns needsModel when the local stack isn't
 * installed yet, so the caller can route the user to setup instead of surfacing a hard error.
 */
export async function transcribeAudio(audio: string, mime = 'audio/webm'): Promise<TranscribeResult> {
  const status = await voiceStatus()
  if (!status.ready) return { ok: false, needsModel: true, status }

  const comma = audio.indexOf(',')
  const b64 = audio.startsWith('data:') && comma !== -1 ? audio.slice(comma + 1) : audio
  const buf = Buffer.from(b64, 'base64')
  if (!buf.length) return { ok: false, needsModel: false, error: 'empty audio' }

  await mkdir(WHISPER_DIR, { recursive: true }).catch(() => {})
  const ext = mime.includes('wav') ? 'wav' : mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : 'webm'
  const inFile = path.join(os.tmpdir(), `crucible-voice-${Date.now()}-${process.pid}.${ext}`)
  const wavFile = inFile.replace(/\.[^.]+$/, '.16k.wav')
  try {
    await writeFile(inFile, buf)
    // Transcode to the 16 kHz mono PCM WAV whisper.cpp requires.
    await run(ffmpegBin(), ['-y', '-i', inFile, '-ar', '16000', '-ac', '1', '-f', 'wav', wavFile], 30000)
    // whisper-cli: -otxt writes <wav>.txt; we read stdout instead via -np (no prints) + stdout.
    const out = await run(whisperBin(), ['-m', MODEL_PATH, '-f', wavFile, '-nt', '-np', '-l', 'en'], 90000)
    // -nt (no timestamps) yields plain text lines; join and tidy.
    const text = out.split('\n').map(l => l.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
    return { ok: true, text }
  } catch (e: any) {
    return { ok: false, needsModel: false, error: String(e?.message ?? e).slice(0, 200) }
  } finally {
    void unlink(inFile).catch(() => {})
    void unlink(wavFile).catch(() => {})
  }
}

// MASTERPIECE corpus — resumable model-weight fetcher
//
// transformers.js (2.17.2) downloads each model file by buffering the ENTIRE HTTP
// stream into memory (`readResponse`/`arrayBuffer`) and only writing to its FileCache
// once the whole file has arrived. A dropped connection mid-stream throws, nothing is
// written, and the next attempt restarts from byte 0. For the 23MB ONNX weights on a
// flaky link that can loop forever.
//
// This module pre-fetches the required files with true HTTP Range resume into the EXACT
// path transformers.js reads from — `<cacheDir>/<repo>/<file>` — so by the time
// `pipeline()` runs it gets a cache hit and performs zero network I/O. Partial progress
// lives in a `<file>.part` sidecar and survives crashes/restarts; interrupted transfers
// pick up at the exact byte they stopped.

import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline as streamPipeline } from 'node:stream/promises'

const HF_HOST = 'https://huggingface.co'
const REPO = 'Xenova/all-MiniLM-L6-v2'
const REVISION = 'main'

// The files transformers.js requests for a quantized feature-extraction pipeline.
const REQUIRED_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
]

const MAX_ATTEMPTS_PER_FILE = 8

export function modelCacheDir(): string {
  if (process.env.CRUCIBLE_MODEL_CACHE) return process.env.CRUCIBLE_MODEL_CACHE
  return path.join(process.cwd(), '.crucible', 'models-cache')
}

function remoteURL(file: string): string {
  return `${HF_HOST}/${REPO}/resolve/${REVISION}/${file}`
}

// FileCache key layout: <cacheDir>/<repo>/<file> (main revision → request URL is the key).
function targetPath(file: string): string {
  return path.join(modelCacheDir(), REPO, file)
}

function sizeOf(p: string): number {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

// Ask HF for the total content length via a 1-byte Range probe (content-range: bytes a-b/TOTAL).
async function remoteTotalBytes(file: string): Promise<number | null> {
  const res = await fetch(remoteURL(file), { headers: { Range: 'bytes=0-0' } })
  const cr = res.headers.get('content-range')
  // Drain so the socket can be reused/closed cleanly.
  await res.arrayBuffer().catch(() => {})
  if (cr) {
    const m = /\/(\d+)\s*$/.exec(cr)
    if (m) return Number(m[1])
  }
  const cl = res.headers.get('content-length')
  return cl ? Number(cl) : null
}

// Download one file with Range resume. Returns when the final file is complete on disk.
async function fetchFileResumable(file: string): Promise<void> {
  const finalPath = targetPath(file)
  const partPath = `${finalPath}.part`
  await fs.promises.mkdir(path.dirname(finalPath), { recursive: true })

  // Fast path: a finished file with no leftover .part is trusted WITHOUT touching the
  // network, so a completed download works fully offline after restart.
  if (sizeOf(finalPath) > 0 && !fs.existsSync(partPath)) return

  let total: number | null
  try {
    total = await remoteTotalBytes(file)
  } catch (err) {
    // Offline but the file is already on disk — use it rather than failing.
    if (sizeOf(finalPath) > 0) return
    throw err
  }

  // Already complete?
  if (total !== null && sizeOf(finalPath) === total) return
  // Unknown total but a finished file exists — trust it.
  if (total === null && fs.existsSync(finalPath) && sizeOf(finalPath) > 0) return

  let lastErr: unknown = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_FILE; attempt++) {
    let have = sizeOf(partPath)

    // A stale .part larger than the real file (revision changed) — start over.
    if (total !== null && have > total) {
      await fs.promises.rm(partPath, { force: true })
      have = 0
    }
    // Nothing left to fetch — finalize.
    if (total !== null && have === total) {
      await fs.promises.rename(partPath, finalPath)
      return
    }

    try {
      const headers: Record<string, string> = {}
      if (have > 0) headers.Range = `bytes=${have}-`

      const res = await fetch(remoteURL(file), { headers })

      // 416 = we already have everything the server has.
      if (res.status === 416) {
        await res.arrayBuffer().catch(() => {})
        if (total !== null && sizeOf(partPath) === total) {
          await fs.promises.rename(partPath, finalPath)
          return
        }
        throw new Error(`416 but part size ${sizeOf(partPath)} != total ${total}`)
      }

      // If we asked for a range but the server ignored it (200 not 206), restart clean.
      if (have > 0 && res.status === 200) {
        await fs.promises.rm(partPath, { force: true })
        have = 0
      }
      if (res.status !== 200 && res.status !== 206) {
        throw new Error(`HTTP ${res.status} for ${file}`)
      }
      if (!res.body) throw new Error(`no response body for ${file}`)

      const out = fs.createWriteStream(partPath, { flags: have > 0 ? 'a' : 'w' })
      await streamPipeline(Readable.fromWeb(res.body as any), out)

      const nowHave = sizeOf(partPath)
      if (total === null || nowHave === total) {
        await fs.promises.rename(partPath, finalPath)
        return
      }
      // Short read (mid-stream drop that didn't throw): loop and resume from nowHave.
      lastErr = new Error(`incomplete: ${nowHave}/${total} bytes`)
    } catch (err) {
      lastErr = err
      // .part is preserved — the next attempt resumes from wherever it got to.
    }

    // Backoff before resuming (skip after the final attempt).
    if (attempt < MAX_ATTEMPTS_PER_FILE) {
      const delay = Math.min(500 * 2 ** (attempt - 1), 8000)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw new Error(`failed to fetch ${file} after ${MAX_ATTEMPTS_PER_FILE} attempts: ${String(lastErr)}`)
}

// Ensure every required weight file is fully present in the transformers.js FileCache.
// Downloads only what's missing; resumes any interrupted transfer at the exact byte.
export async function ensureModelFiles(): Promise<void> {
  for (const file of REQUIRED_FILES) {
    await fetchFileResumable(file)
  }
}

// Downloads optional local-model GGUF files on demand into Electron's user-data dir.
// Nothing is bundled with the app — a model only exists on disk after the user
// explicitly requests it from the Settings panel.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { app } from 'electron'
import { LOCAL_MODEL_CATALOG, findModelSpec, type LocalModelSpec } from './localModelCatalog'

function modelsDir(): string {
  const base = app?.getPath ? app.getPath('userData') : path.join(process.cwd(), '.crucible')
  const dir = path.join(base, 'models')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function modelFilePath(spec: LocalModelSpec): string {
  return path.join(modelsDir(), spec.filename)
}

export type DownloadStatus = 'absent' | 'downloading' | 'ready' | 'error'

interface DownloadState {
  status: DownloadStatus
  bytesDone: number
  bytesTotal: number
  error?: string
}

const inFlight = new Map<string, DownloadState>()

export function modelStatus(id: string): DownloadState {
  const spec = findModelSpec(id)
  if (!spec) return { status: 'error', bytesDone: 0, bytesTotal: 0, error: 'unknown model id' }
  const live = inFlight.get(id)
  if (live) return live
  if (fs.existsSync(modelFilePath(spec))) return { status: 'ready', bytesDone: 0, bytesTotal: 0 }
  return { status: 'absent', bytesDone: 0, bytesTotal: 0 }
}

export function listModelStatuses(): Array<LocalModelSpec & { status: DownloadState }> {
  return LOCAL_MODEL_CATALOG.map(spec => ({ ...spec, status: modelStatus(spec.id) }))
}

/** Downloads a model's GGUF file with progress tracking; verifies sha256 if the catalog has one. */
export async function downloadModel(id: string, onProgress?: (s: DownloadState) => void): Promise<void> {
  const spec = findModelSpec(id)
  if (!spec) throw new Error(`unknown model id: ${id}`)
  const dest = modelFilePath(spec)
  if (fs.existsSync(dest)) return

  const state: DownloadState = { status: 'downloading', bytesDone: 0, bytesTotal: 0 }
  inFlight.set(id, state)
  const tmp = dest + '.part'

  try {
    const res = await fetch(spec.url, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
    state.bytesTotal = Number(res.headers.get('content-length') ?? 0)

    const hash = crypto.createHash('sha256')
    const fileStream = fs.createWriteStream(tmp)
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      state.bytesDone += value.byteLength
      onProgress?.(state)
      await new Promise<void>((resolve, reject) => {
        fileStream.write(value, err => (err ? reject(err) : resolve()))
      })
    }
    await new Promise<void>((resolve, reject) => fileStream.end(err => (err ? reject(err) : resolve())))

    const digest = hash.digest('hex')
    if (spec.sha256 && digest !== spec.sha256) {
      throw new Error(`checksum mismatch for ${spec.filename}: expected ${spec.sha256}, got ${digest}`)
    }

    fs.renameSync(tmp, dest)
    state.status = 'ready'
    onProgress?.(state)
  } catch (err: any) {
    state.status = 'error'
    state.error = err?.message ?? String(err)
    onProgress?.(state)
    fs.rmSync(tmp, { force: true })
    throw err
  } finally {
    inFlight.delete(id)
  }
}

export function deleteModel(id: string): void {
  const spec = findModelSpec(id)
  if (!spec) return
  fs.rmSync(modelFilePath(spec), { force: true })
}

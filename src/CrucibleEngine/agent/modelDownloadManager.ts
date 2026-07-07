// Downloads optional local-model GGUF files on demand into Electron's user-data dir.
// Nothing is bundled with the app — a model only exists on disk after the user
// explicitly requests it from the Settings panel.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { createRequire } from 'module'
import { LOCAL_MODEL_CATALOG, findModelSpec, type LocalModelSpec } from './localModelCatalog'

const require = createRequire(import.meta.url)

// electron is only present inside the Electron shell; under plain Node (server.ts via tsx)
// this module must still load, so the import is deferred and failures swallowed.
function getElectronApp(): { getPath?: (name: string) => string } | undefined {
  try {
    return require('electron').app
  } catch {
    return undefined
  }
}

function userDataDir(): string {
  const app = getElectronApp()
  return app?.getPath ? app.getPath('userData') : path.join(process.cwd(), '.crucible')
}

interface ModelsConfig {
  /** Custom storage folder for model files; defaults to userData/models when unset. */
  location?: string
  /** Per-model opt-out — a downloaded model is still used by the router unless disabled here. */
  enabled: Record<string, boolean>
}

function configPath(): string {
  return path.join(userDataDir(), 'local-models-config.json')
}

export function getModelsConfig(): ModelsConfig {
  try {
    return { enabled: {}, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }
  } catch {
    return { enabled: {} }
  }
}

function writeConfig(cfg: ModelsConfig): void {
  fs.mkdirSync(userDataDir(), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2))
}

export function setModelsLocation(newDir: string): void {
  const cfg = getModelsConfig()
  fs.mkdirSync(newDir, { recursive: true })
  // Move any already-downloaded files to the new location so nothing has to re-download.
  const oldDir = modelsDir()
  if (oldDir !== newDir && fs.existsSync(oldDir)) {
    for (const f of fs.readdirSync(oldDir)) {
      const from = path.join(oldDir, f)
      const to = path.join(newDir, f)
      if (!fs.existsSync(to)) fs.renameSync(from, to)
    }
  }
  cfg.location = newDir
  writeConfig(cfg)
}

export function setModelEnabled(id: string, enabled: boolean): void {
  const cfg = getModelsConfig()
  cfg.enabled[id] = enabled
  writeConfig(cfg)
}

export function isModelEnabled(id: string): boolean {
  return getModelsConfig().enabled[id] !== false // default enabled once downloaded
}

function modelsDir(): string {
  const configured = getModelsConfig().location
  const dir = configured || path.join(userDataDir(), 'models')
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

export function listModelStatuses(): Array<LocalModelSpec & { status: DownloadState; enabled: boolean }> {
  return LOCAL_MODEL_CATALOG.map(spec => ({ ...spec, status: modelStatus(spec.id), enabled: isModelEnabled(spec.id) }))
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

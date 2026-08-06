// Shared task scratchpad (Track I3) — in-memory key-value store scoped to a task.
// All specialist agents in a multi-agent task read and write here.
// Provenance: each entry records which archetype wrote it and its confidence.

import fs from 'fs'
import path from 'path'
import { debugBus } from '../debug/bus'

export interface ScratchEntry {
  key: string
  value: string
  author: string        // archetype id that wrote this
  confidence: number    // 0-1
  writtenAt: number
}

const scratchpads = new Map<string, Map<string, ScratchEntry>>()

function pad(taskId: string): Map<string, ScratchEntry> {
  if (!scratchpads.has(taskId)) scratchpads.set(taskId, new Map())
  return scratchpads.get(taskId)!
}

export function writeScratch(taskId: string, key: string, value: string, author: string, confidence = 0.8) {
  const entry: ScratchEntry = { key, value, author, confidence, writtenAt: Date.now() }
  pad(taskId).set(key, entry)
  debugBus.emit('agent', 'scratchpad_write', { taskId, key, author, confidence })
}

export function readScratch(taskId: string, key?: string): ScratchEntry[] {
  const p = pad(taskId)
  if (key) {
    const e = p.get(key)
    return e ? [e] : []
  }
  return Array.from(p.values()).sort((a, b) => a.writtenAt - b.writtenAt)
}

export function buildScratchContext(taskId: string): string {
  const entries = readScratch(taskId)
  if (!entries.length) return ''
  const lines = entries.map(e => `[${e.author} | conf:${(e.confidence * 100).toFixed(0)}%] ${e.key}: ${e.value}`)
  return `Shared task scratchpad:\n${lines.join('\n')}`
}

export function clearScratch(taskId: string, dir?: string) {
  scratchpads.delete(taskId)
  if (dir) {
    try { fs.unlinkSync(path.join(dir, '.crucible', `scratchpad-${taskId}.json`)) } catch {}
  }
}

export function persistScratch(taskId: string, dir: string) {
  const entries = readScratch(taskId)
  if (!entries.length) return
  const file = path.join(dir, '.crucible', `scratchpad-${taskId}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(entries, null, 2))
}

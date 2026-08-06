// J5 — Cross-session knowledge synthesis.
// After every 20 sessions on the same topic cluster, a synthesis pass produces
// a "state of knowledge" document for that cluster. Stored in
// .crucible/knowledge-synthesis/<cluster-id>.md and injected in full when a
// new query matches that cluster.

import fs from 'fs'
import path from 'path'
import { debugBus } from './debug/bus'

const SYNTHESIS_DIR = (dir: string) => path.join(dir, '.crucible', 'knowledge-synthesis')
const INDEX_FILE = (dir: string) => path.join(SYNTHESIS_DIR(dir), 'index.json')
const SESSION_THRESHOLD = 20  // synthesize after this many sessions in the same cluster

export interface SynthesisRecord {
  clusterId: string
  clusterLabel: string
  sessionCount: number
  lastSynthesizedAt: number | null
  synthesisPath: string | null
}

function loadIndex(dir: string): SynthesisRecord[] {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE(dir), 'utf8')) } catch { return [] }
}
function saveIndex(dir: string, records: SynthesisRecord[]) {
  fs.mkdirSync(SYNTHESIS_DIR(dir), { recursive: true })
  fs.writeFileSync(INDEX_FILE(dir), JSON.stringify(records, null, 2))
}

// Called after each session — increment session count for matched cluster
export function recordSessionForCluster(dir: string, clusterId: string, clusterLabel: string): boolean {
  const index = loadIndex(dir)
  let rec = index.find(r => r.clusterId === clusterId)
  if (!rec) {
    rec = { clusterId, clusterLabel, sessionCount: 0, lastSynthesizedAt: null, synthesisPath: null }
    index.push(rec)
  }
  rec.sessionCount += 1
  saveIndex(dir, index)
  // Return true if synthesis threshold reached and not yet synthesized this window
  const sessionsSinceLast = rec.lastSynthesizedAt
    ? rec.sessionCount - Math.floor(rec.lastSynthesizedAt / SESSION_THRESHOLD) * SESSION_THRESHOLD
    : rec.sessionCount
  return sessionsSinceLast >= SESSION_THRESHOLD
}

// Write synthesized document for a cluster
export function writeSynthesis(dir: string, clusterId: string, clusterLabel: string, content: string) {
  fs.mkdirSync(SYNTHESIS_DIR(dir), { recursive: true })
  const filename = `${clusterId}.md`
  const fullPath = path.join(SYNTHESIS_DIR(dir), filename)
  fs.writeFileSync(fullPath, `# Knowledge Synthesis: ${clusterLabel}\n\n${content}\n`, 'utf8')

  const index = loadIndex(dir)
  const rec = index.find(r => r.clusterId === clusterId)
  if (rec) {
    rec.lastSynthesizedAt = Date.now()
    rec.synthesisPath = filename
    saveIndex(dir, index)
  }

  debugBus.emit('pipeline', 'knowledge_synthesis_written', { clusterId, clusterLabel, chars: content.length }, { severity: 'success' })
}

// Read synthesis for injection into query context
export function readSynthesis(dir: string, clusterId: string): string | null {
  const index = loadIndex(dir)
  const rec = index.find(r => r.clusterId === clusterId)
  if (!rec?.synthesisPath) return null
  try {
    return fs.readFileSync(path.join(SYNTHESIS_DIR(dir), rec.synthesisPath), 'utf8')
  } catch { return null }
}

export function getSynthesisIndex(dir: string): SynthesisRecord[] {
  return loadIndex(dir)
}

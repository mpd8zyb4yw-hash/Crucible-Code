// J3 — World model diff per response.
// After every pipeline round, extract facts/decisions that are new or contradict
// the existing world model. High-confidence diffs auto-apply; medium go to
// triangulation; contradictions logged to .crucible/contradiction-log.json.

import fs from 'fs'
import path from 'path'
import { upsertEntity, findEntities } from './entityGraph'
import { debugBus } from './debug/bus'

export interface WorldDiffEntry {
  entity: string
  attribute: string
  oldValue: string | null
  newValue: string
  confidence: number    // 0-1
  source: string        // 'pipeline' | 'agent' | 'web'
  ts: number
  contradiction?: boolean
}

const LOG_FILE = (dir: string) => path.join(dir, '.crucible', 'contradiction-log.json')
const MAX_LOG = 200

function loadLog(dir: string): WorldDiffEntry[] {
  try { return JSON.parse(fs.readFileSync(LOG_FILE(dir), 'utf8')) } catch { return [] }
}
function saveLog(dir: string, entries: WorldDiffEntry[]) {
  fs.mkdirSync(path.dirname(LOG_FILE(dir)), { recursive: true })
  const capped = entries.slice(-MAX_LOG)
  fs.writeFileSync(LOG_FILE(dir), JSON.stringify(capped, null, 2))
}

// Extract named entities + simple claims from synthesis text (no model call)
function extractClaims(text: string): Array<{ entity: string; claim: string }> {
  const claims: Array<{ entity: string; claim: string }> = []
  // Pattern: "<Entity> is|are|was|has <claim>"
  const re = /\b([A-Z][A-Za-z0-9\s]{2,30})\s+(?:is|are|was|has|have|will|supports?|uses?)\s+([^.!?\n]{5,120})/g
  let m
  while ((m = re.exec(text)) !== null) {
    claims.push({ entity: m[1].trim(), claim: m[0].trim() })
    if (claims.length >= 20) break
  }
  return claims
}

export function applyWorldDiff(dir: string, synthesisText: string, source = 'pipeline', requestId?: string) {
  const claims = extractClaims(synthesisText)
  if (!claims.length) return

  const contradictions: WorldDiffEntry[] = []

  for (const { entity, claim } of claims) {
    // Check if we know this entity already
    const existing = findEntities(entity, undefined, 1)
    const existingDesc = existing[0]?.description ?? ''

    // Simple contradiction: same entity, significantly different claim (low word overlap)
    if (existingDesc && existing[0]) {
      const oldWords = new Set(existingDesc.toLowerCase().split(/\s+/))
      const newWords = claim.toLowerCase().split(/\s+/)
      const overlap = newWords.filter(w => oldWords.has(w)).length / Math.max(newWords.length, 1)
      if (overlap < 0.15 && claim.length > 20) {
        const entry: WorldDiffEntry = {
          entity, attribute: 'description',
          oldValue: existingDesc.slice(0, 200),
          newValue: claim.slice(0, 200),
          confidence: 0.5,
          source, ts: Date.now(), contradiction: true,
        }
        contradictions.push(entry)
        debugBus.emit('pipeline', 'world_contradiction', { entity, source }, { severity: 'warn', requestId })
        continue
      }
    }

    // High confidence: auto-apply as PROVISIONAL (H3 triangulation will upgrade to HIGH on second source)
    try {
      upsertEntity({
        type: 'fact',
        label: entity,
        description: claim.slice(0, 300),
        tags: [source],
        confidence: 0.6,
      }, source)
    } catch (e: any) {
      debugBus.emit('pipeline', 'world_diff_upsert_error', { entity, error: e?.message ?? String(e) }, { severity: 'error', requestId })
    }
  }

  if (contradictions.length) {
    const log = loadLog(dir)
    log.push(...contradictions)
    saveLog(dir, log)
  }

  debugBus.emit('pipeline', 'world_diff_applied', {
    claimsExtracted: claims.length,
    contradictions: contradictions.length,
    source,
  }, { severity: 'info', requestId })
}

export function loadContradictionLog(dir: string): WorldDiffEntry[] {
  return loadLog(dir)
}

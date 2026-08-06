// Autonomous Model Hunter — discovers new free models on OpenRouter that aren't
// in the static registry. Runs on a schedule, probe-calls each candidate, and
// persists passing models to .crucible/discovered-models.json so they load on
// the next server start.

import fs from 'fs'
import path from 'path'
import type { ModelEntry } from '../../modelRegistry'

const DISCOVERED_FILE = (projectPath: string) =>
  path.join(projectPath, '.crucible', 'discovered-models.json')

const PROBE_PROMPT = 'Reply with exactly: "ok"'
const PROBE_TIMEOUT_MS = 8000
const MAX_PROBE_LATENCY_MS = 15000  // reject models slower than this on initial ping
const QUALITY_BUDGET_MS = 20000     // shared timeout across all 4 quality probes

// Models that are routers, aggregators, or otherwise not real inference endpoints
const HUNTER_BLOCKLIST = new Set([
  'openrouter/openrouter/free',
  'openrouter/openrouter/auto',
])

// Models we already know about or that have historically been unreliable
const KNOWN_IDS = new Set<string>()

export function initKnownIds(registry: ModelEntry[]) {
  for (const m of registry) KNOWN_IDS.add(m.id)
}

export interface DiscoveredModel extends ModelEntry {
  discoveredAt: number
  probeLatencyMs: number
}

export function loadDiscoveredModels(projectPath: string): DiscoveredModel[] {
  try {
    return JSON.parse(fs.readFileSync(DISCOVERED_FILE(projectPath), 'utf8'))
  } catch { return [] }
}

function saveDiscoveredModels(projectPath: string, models: DiscoveredModel[]) {
  fs.mkdirSync(path.dirname(DISCOVERED_FILE(projectPath)), { recursive: true })
  fs.writeFileSync(DISCOVERED_FILE(projectPath), JSON.stringify(models, null, 2))
}

// Infer a quality score from the model name — heuristic, not authoritative.
// Refined by specialization memory after the model runs in production.
function inferQuality(name: string, params: number): number {
  const n = name.toLowerCase()
  if (params >= 70) return 7
  if (params >= 30) return 6
  if (params >= 10) return 5
  if (n.includes('instruct') || n.includes('chat')) return 4
  return 3
}

function inferSpeed(params: number, provider: string): 'fast' | 'standard' {
  // Groq inference is always fast; OpenRouter varies but small models are quick
  if (provider === 'groq') return 'fast'
  return params <= 14 ? 'fast' : 'standard'
}

// Parse parameter count from model name / context length
function inferParams(name: string, contextLength?: number): number {
  const m = name.match(/(\d+(?:\.\d+)?)\s*[bB]/)
  if (m) return parseFloat(m[1])
  // Fallback: large context = probably a big model
  if (contextLength && contextLength >= 100000) return 30
  return 7
}

async function probeModel(
  id: string,
  apiKey: string
): Promise<{ ok: boolean; latencyMs: number }> {
  const t0 = Date.now()
  try {
    const res = await Promise.race([
      fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: id,
          messages: [{ role: 'user', content: PROBE_PROMPT }],
          max_tokens: 10,
          temperature: 0,
        }),
      }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), PROBE_TIMEOUT_MS)),
    ])
    if (!res.ok) return { ok: false, latencyMs: Date.now() - t0 }
    const data = await res.json() as any
    const text: string = data?.choices?.[0]?.message?.content ?? ''
    const latencyMs = Date.now() - t0
    // Accept if it responded with something sensible (contains "ok" or any text)
    return { ok: text.length >= 1 && !text.toLowerCase().includes('error'), latencyMs }
  } catch {
    return { ok: false, latencyMs: Date.now() - t0 }
  }
}

// ── Quality probe battery ────────────────────────────────────────────────────
// Each probe has a known correct answer. Score = fraction of probes passed.
const QUALITY_PROBES: Array<{ type: keyof DiscoveredModel['fit']; prompt: string; check: (r: string) => boolean }> = [
  {
    type: 'coding',
    prompt: 'Write a JavaScript one-liner that returns the sum of an array of numbers. Reply with only the code, no explanation.',
    check: r => r.includes('reduce') || r.includes('forEach') || (r.includes('=>') && r.includes('+')),
  },
  {
    type: 'reasoning',
    prompt: 'A bat and ball cost $1.10 total. The bat costs $1 more than the ball. How much does the ball cost? Reply with only the number in cents.',
    check: r => r.includes('5') && !r.includes('10 cent') && !r.includes('$.10'),
  },
  {
    type: 'factual',
    prompt: 'What is the chemical symbol for gold? Reply with only the symbol.',
    check: r => r.trim().toUpperCase().startsWith('AU'),
  },
  {
    type: 'general',
    prompt: 'Translate to French: "Good morning". Reply with only the translation.',
    check: r => r.toLowerCase().includes('bonjour'),
  },
]

async function probeQuality(
  id: string,
  apiKey: string
): Promise<{ fit: DiscoveredModel['fit']; qualityScore: number }> {
  const fit: DiscoveredModel['fit'] = { coding: 5, reasoning: 5, creative: 5, factual: 5, math: 4, general: 5 }
  let passed = 0
  const budgetDeadline = Date.now() + QUALITY_BUDGET_MS  // shared 20s across all probes
  for (const probe of QUALITY_PROBES) {
    const remainingMs = budgetDeadline - Date.now()
    if (remainingMs <= 500) {
      console.log(`[Hunter] Quality budget exhausted for ${id} — stopping probes early`)
      break
    }
    try {
      const res = await Promise.race([
        fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: id,
            messages: [{ role: 'user', content: probe.prompt }],
            max_tokens: 60,
            temperature: 0,
          }),
        }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), remainingMs)),
      ])
      if (!res.ok) continue
      const data = await res.json() as any
      const text: string = data?.choices?.[0]?.message?.content ?? ''
      if (probe.check(text)) {
        fit[probe.type] = 8
        passed++
      } else {
        fit[probe.type] = 3
      }
    } catch { /* probe timed out or failed — leave default */ }
  }
  const qualityScore = 4 + Math.round((passed / QUALITY_PROBES.length) * 4) // range 4–8
  return { fit, qualityScore }
}

export async function runModelHunter(
  projectPath: string,
  apiKey: string,
  existingRegistry: ModelEntry[],
  onFound?: (m: DiscoveredModel) => void
): Promise<DiscoveredModel[]> {
  initKnownIds(existingRegistry)

  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    })
    if (!res.ok) return []
    const { data } = await res.json() as {
      data: Array<{
        id: string
        name: string
        pricing: { prompt: string; completion: string }
        context_length?: number
        architecture?: { modality?: string }
      }>
    }

    // Only text-in/text-out models that are fully free
    const candidates = data.filter(m => {
      const isFree = parseFloat(m.pricing?.prompt ?? '1') === 0 && parseFloat(m.pricing?.completion ?? '1') === 0
      const isText = !m.architecture?.modality || m.architecture.modality.includes('text')
      const orId = `openrouter/${m.id}`
      const isNew = !KNOWN_IDS.has(orId) && !KNOWN_IDS.has(m.id)
      return isFree && isText && isNew
    })

    if (candidates.length === 0) {
      console.log('[Hunter] No new free models found on OpenRouter')
      return []
    }

    console.log(`[Hunter] ${candidates.length} candidate(s) to probe`)

    const existing = loadDiscoveredModels(projectPath)
    const existingIds = new Set(existing.map(m => m.id))
    const newlyFound: DiscoveredModel[] = []

    // Probe up to 8 candidates per run (avoid hammering the API)
    const toProbe = candidates
      .filter(c => !existingIds.has(`openrouter/${c.id}`))
      .slice(0, 8)

    for (const candidate of toProbe) {
      const orId = `openrouter/${candidate.id}`
      console.log(`[Hunter] Probing: ${candidate.name} (${orId})`)
      // Skip blocklisted routers/aggregators
      if (HUNTER_BLOCKLIST.has(candidate.id) || HUNTER_BLOCKLIST.has(`openrouter/${candidate.id}`)) {
        console.log(`[Hunter] Blocklisted — skipping: ${candidate.name}`)
        continue
      }
      const { ok, latencyMs } = await probeModel(candidate.id, apiKey)
      if (!ok) {
        console.log(`[Hunter] Failed: ${candidate.name} (${latencyMs}ms)`)
        continue
      }
      // Latency gate: models too slow on a one-word prompt will choke on real queries
      if (latencyMs > MAX_PROBE_LATENCY_MS) {
        console.log(`[Hunter] Too slow: ${candidate.name} (${latencyMs}ms > ${MAX_PROBE_LATENCY_MS}ms limit) — rejected`)
        continue
      }
      const params = inferParams(candidate.name, candidate.context_length)
      console.log(`[Hunter] Quality probing: ${candidate.name}`)
      const { fit, qualityScore } = await probeQuality(candidate.id, apiKey)
      const entry: DiscoveredModel = {
        id: orId,
        label: candidate.name.replace(/^[^/]+\//, '').slice(0, 40),
        quality: qualityScore,
        fit,
        free: true,
        provider: 'openrouter',
        speed: inferSpeed(params, 'openrouter'),
        params,
        discoveredAt: Date.now(),
        probeLatencyMs: latencyMs,
      }
      console.log(`[Hunter] Passed: ${entry.label} (${latencyMs}ms, ${params}B, quality=${qualityScore}, fit=${JSON.stringify(fit)})`)
      newlyFound.push(entry)
      onFound?.(entry)
    }

    if (newlyFound.length > 0) {
      const updated = [...existing, ...newlyFound]
      saveDiscoveredModels(projectPath, updated)
      console.log(`[Hunter] Saved ${newlyFound.length} new model(s) to discovered-models.json`)
    }

    return newlyFound
  } catch (e: any) {
    console.warn('[Hunter] Failed:', e.message)
    return []
  }
}

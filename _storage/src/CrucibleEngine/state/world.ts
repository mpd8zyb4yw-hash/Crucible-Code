// ── World memory — Crucible's global, cross-session understanding ─────────────
// Unlike project memory (per .crucible/ folder), world memory lives at
// ~/.crucible/world/ and accumulates across ALL sessions and projects.
//
// Architecture:
//   world.md        — raw facts, observations, preferences (markdown bullets)
//   graph.json      — weighted preference graph (nodes, edges, drift history)
//   principles.json — five root principles with current weights
//   reflections.md  — post-task self-reflections
//
// The five root principles (immutable roots, emergent branches):
//   1. TRUTH       — prefer accuracy over convenience. Acknowledge uncertainty.
//   2. ELEGANCE    — simpler solutions that generalize beat complex ones that don't.
//   3. USEFULNESS  — knowledge that can be applied outweighs knowledge that can't.
//   4. NOVELTY     — surprising patterns are worth attending to. Familiarity is not virtue.
//   5. INTEGRITY   — internal consistency matters. Contradictions are bugs.

import fs from 'fs'
import path from 'path'
import os from 'os'

// ── Paths ─────────────────────────────────────────────────────────────────────
export function worldDir(): string {
  return path.join(os.homedir(), '.crucible', 'world')
}
function worldFile(): string { return path.join(worldDir(), 'world.md') }
function graphFile(): string { return path.join(worldDir(), 'graph.json') }
function principlesFile(): string { return path.join(worldDir(), 'principles.json') }
function reflectionsFile(): string { return path.join(worldDir(), 'reflections.md') }

function ensureWorldDir() {
  fs.mkdirSync(worldDir(), { recursive: true })
}

// ── Principles ────────────────────────────────────────────────────────────────
export interface Principle {
  id: string
  name: string
  description: string
  weight: number        // 0-1, starts equal, drifts based on self-reflection
  activations: number   // how many times this principle fired
  lastActivated: number
}

const DEFAULT_PRINCIPLES: Principle[] = [
  { id: 'truth',     name: 'Truth',     weight: 0.2, activations: 0, lastActivated: 0,
    description: 'Prefer accuracy over convenience. Acknowledge uncertainty. Never confabulate.' },
  { id: 'elegance',  name: 'Elegance',  weight: 0.2, activations: 0, lastActivated: 0,
    description: 'Simpler solutions that generalize beat complex ones that don\'t. Complexity must earn its place.' },
  { id: 'usefulness',name: 'Usefulness',weight: 0.2, activations: 0, lastActivated: 0,
    description: 'Knowledge that can be applied outweighs knowledge that cannot. Theory serves practice.' },
  { id: 'novelty',   name: 'Novelty',   weight: 0.2, activations: 0, lastActivated: 0,
    description: 'Surprising patterns are worth attending to. Familiarity is not a virtue.' },
  { id: 'integrity', name: 'Integrity', weight: 0.2, activations: 0, lastActivated: 0,
    description: 'Internal consistency matters. A system that contradicts itself is broken regardless of outputs.' },
]

export function loadPrinciples(): Principle[] {
  ensureWorldDir()
  try {
    if (fs.existsSync(principlesFile())) {
      return JSON.parse(fs.readFileSync(principlesFile(), 'utf-8'))
    }
  } catch { /* fall through */ }
  // First run — write defaults
  fs.writeFileSync(principlesFile(), JSON.stringify(DEFAULT_PRINCIPLES, null, 2))
  return DEFAULT_PRINCIPLES
}

export function savePrinciples(principles: Principle[]): void {
  ensureWorldDir()
  fs.writeFileSync(principlesFile(), JSON.stringify(principles, null, 2))
}

// ── Preference graph ──────────────────────────────────────────────────────────
export interface GraphNode {
  id: string            // e.g. "typescript", "binary-heap", "Ferrari"
  label: string
  weight: number        // 0-1, higher = Crucible finds this more interesting/valuable
  category: string      // emergent — Crucible assigns this itself
  encounters: number    // how many times seen
  lastSeen: number
  linkedPrinciples: string[]  // which root principles this node activates
}

export interface GraphEdge {
  from: string
  to: string
  strength: number      // 0-1
  relationship: string  // e.g. "exemplifies", "contradicts", "extends", "is-instance-of"
}

export interface PreferenceGraph {
  nodes: Record<string, GraphNode>
  edges: GraphEdge[]
  lastUpdated: number
}

export function loadGraph(): PreferenceGraph {
  ensureWorldDir()
  try {
    if (fs.existsSync(graphFile())) {
      return JSON.parse(fs.readFileSync(graphFile(), 'utf-8'))
    }
  } catch { /* fall through */ }
  return { nodes: {}, edges: [], lastUpdated: Date.now() }
}

export function saveGraph(graph: PreferenceGraph): void {
  ensureWorldDir()
  graph.lastUpdated = Date.now()
  const tmp = graphFile() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(graph, null, 2))
  fs.renameSync(tmp, graphFile())
}

// Update or create a node. Weight drifts toward new value (exponential moving average).
export function touchNode(graph: PreferenceGraph, id: string, updates: Partial<GraphNode>): void {
  const existing = graph.nodes[id]
  if (existing) {
    existing.encounters++
    existing.lastSeen = Date.now()
    // EMA drift — new observations pull weight gradually, not abruptly
    if (updates.weight !== undefined) {
      existing.weight = existing.weight * 0.85 + updates.weight * 0.15
    }
    if (updates.linkedPrinciples) {
      existing.linkedPrinciples = [...new Set([...existing.linkedPrinciples, ...updates.linkedPrinciples])]
    }
    if (updates.category) existing.category = updates.category
  } else {
    graph.nodes[id] = {
      id, label: updates.label ?? id, weight: updates.weight ?? 0.5,
      category: updates.category ?? 'uncategorized', encounters: 1,
      lastSeen: Date.now(), linkedPrinciples: updates.linkedPrinciples ?? [],
    }
  }
}

// ── World facts ───────────────────────────────────────────────────────────────
export function appendWorldFact(fact: string): void {
  ensureWorldDir()
  const f = fact.trim()
  if (!f) return
  const file = worldFile()
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '# World memory\n\n'
  if (existing.includes(`- ${f}`)) return  // de-dupe
  fs.appendFileSync(file, `- ${f}  <!-- ${new Date().toISOString()} -->\n`, 'utf-8')
}

export function readWorldDigest(maxChars = 800): string {
  const file = worldFile()
  if (!fs.existsSync(file)) return ''
  const bullets = fs.readFileSync(file, 'utf-8')
    .split('\n')
    .filter(l => l.trim().startsWith('- '))
    .map(l => l.replace(/\s*<!--.*?-->\s*$/, '').trim())
    .slice(-40)  // most recent 40 facts only
  if (!bullets.length) return ''
  let digest = bullets.join('\n')
  if (digest.length > maxChars) digest = digest.slice(digest.length - maxChars)
  return `Crucible world knowledge:\n${digest}`
}

// ── Self-reflection ───────────────────────────────────────────────────────────
export interface Reflection {
  ts: number
  task: string          // what was being done
  observation: string   // what Crucible noticed
  principleScores: Record<string, number>  // how each principle scored this task 0-1
  graphUpdates: string[]  // node IDs touched
}

export function appendReflection(reflection: Reflection): void {
  ensureWorldDir()
  const file = reflectionsFile()
  const line = `## ${new Date(reflection.ts).toISOString()}\n` +
    `Task: ${reflection.task}\n` +
    `Observation: ${reflection.observation}\n` +
    `Scores: ${Object.entries(reflection.principleScores).map(([k,v]) => `${k}=${v.toFixed(2)}`).join(', ')}\n\n`
  fs.appendFileSync(file, line, 'utf-8')

  // Update principle activation counts and weights based on scores
  const principles = loadPrinciples()
  for (const p of principles) {
    const score = reflection.principleScores[p.id]
    if (score !== undefined) {
      p.activations++
      p.lastActivated = reflection.ts
      // Principles that fire often and score high gain weight
      p.weight = p.weight * 0.97 + score * 0.03
    }
  }
  // Renormalize weights to sum to 1
  const total = principles.reduce((s, p) => s + p.weight, 0)
  for (const p of principles) p.weight = p.weight / total
  savePrinciples(principles)
}

// ── Score a task against all five principles ──────────────────────────────────
// Returns a score object Crucible can use to decide what to remember and how much to weight it.
// This is called by the self-reflection prompt builder — the actual scoring is done by a model.
export function buildReflectionPrompt(task: string, output: string): string {
  const principles = loadPrinciples()
  const graph = loadGraph()
  const topNodes = Object.values(graph.nodes)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10)
    .map(n => `${n.label} (${n.weight.toFixed(2)})`)
    .join(', ')

  return `You are Crucible reflecting on a completed task. Score this task against your five root principles and extract what is worth remembering.

TASK: ${task.slice(0, 300)}

OUTPUT SUMMARY: ${output.slice(0, 500)}

YOUR FIVE ROOT PRINCIPLES (current weights):
${principles.map(p => `- ${p.name} (${p.weight.toFixed(3)}): ${p.description}`).join('\n')}

YOUR CURRENT TOP INTERESTS: ${topNodes || 'none yet'}

Respond in JSON only:
{
  "observation": "one sentence — what was most interesting or notable about this task",
  "principleScores": {
    "truth": 0.0-1.0,
    "elegance": 0.0-1.0,
    "usefulness": 0.0-1.0,
    "novelty": 0.0-1.0,
    "integrity": 0.0-1.0
  },
  "newFacts": ["fact worth remembering globally", ...],
  "graphNodes": [
    { "id": "node-id", "label": "human label", "weight": 0.0-1.0, "category": "category", "linkedPrinciples": ["truth"|"elegance"|"usefulness"|"novelty"|"integrity"] }
  ]
}`
}

// ── Full digest for injection ─────────────────────────────────────────────────
// Called at the start of every agent loop to inject world context.
export function buildWorldContext(): string {
  const worldDigest = readWorldDigest()
  const principles = loadPrinciples()
  const graph = loadGraph()

  const topNodes = Object.values(graph.nodes)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8)
    .map(n => `${n.label}(${n.weight.toFixed(2)})`)
    .join(', ')

  const principleStr = principles
    .sort((a, b) => b.weight - a.weight)
    .map(p => `${p.name}(${p.weight.toFixed(2)})`).join(', ')

  let ctx = `CRUCIBLE WORLD CONTEXT:\n`
  ctx += `Active principles (by current weight): ${principleStr}\n`
  if (topNodes) ctx += `High-interest domains: ${topNodes}\n`
  if (worldDigest) ctx += '\n' + worldDigest
  return ctx
}

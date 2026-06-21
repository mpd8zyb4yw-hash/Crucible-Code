// Persistent multi-session task graph (Session I).
//
// A TaskGraph is a durable, cross-session record of a high-level goal decomposed
// into a small set of nodes (subtasks) with simple dependency edges. Unlike the
// in-request goalDecomposer tree (which lives only for one /api/chat call), these
// graphs persist to disk so an open goal survives restarts and can be resumed in a
// later session. The agent preamble surfaces open goals so the model stays aware
// of unfinished work across conversations.
//
// Persistence: <cwd>/.crucible/task-graph/<id>.json — one file per graph. This
// matches server.ts's CRUCIBLE_DIR convention (path.join(process.cwd(), '.crucible')),
// so graphs live alongside the rest of the server-managed state and relocate with it.
//
// Pure fs persistence — NO model calls. Decomposition reuses goalDecomposer's
// heuristic extractSubtasks/decompose (free-tier safe, no LLM), and archetype
// assignment reuses the pure selectArchetype heuristic.

import fs from 'fs'
import path from 'path'
import { extractSubtasks, decompose } from './goalDecomposer'
import { selectArchetype, type ArchetypeId } from './agent/archetypes'

export type GraphStatus = 'open' | 'done' | 'abandoned'
export type NodeStatus = 'pending' | 'in_progress' | 'done' | 'blocked'

export interface TaskNode {
  id: string
  goal: string
  status: NodeStatus
  result?: string
  assignedArchetype: ArchetypeId
  startedAt?: number
  completedAt?: number
}

export interface TaskEdge {
  from: string   // node id that must complete first
  to: string     // node id that depends on `from`
}

export interface TaskGraph {
  id: string
  goal: string
  created: number
  status: GraphStatus
  nodes: TaskNode[]
  edges: TaskEdge[]
}

// ── Persistence paths ──────────────────────────────────────────────────────────
// Keyed off process.cwd() at call time (NOT module load) so the directory follows
// the server's cwd, matching how every other path in server.ts resolves.
function graphDir(): string {
  return path.join(process.cwd(), '.crucible', 'task-graph')
}
function graphFile(id: string): string {
  return path.join(graphDir(), `${id}.json`)
}

function newId(): string {
  return `tg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

// ── Decomposition ────────────────────────────────────────────────────────────
// Reuse goalDecomposer's heuristic splitter. extractSubtasks returns self-contained
// subtask strings for genuinely multi-part goals; for a single-intent goal it returns
// [], in which case we fall back to decompose()'s leaf nodes, and finally to a single
// node carrying the whole goal. No model call on any path.
function decomposeGoal(goal: string): string[] {
  const trimmed = goal.trim()
  try {
    const subs = extractSubtasks(trimmed)
    if (subs.length >= 2) return subs.map(s => s.trim()).filter(Boolean)
  } catch {}
  try {
    const leaves = decompose(trimmed).nodes.filter(n => n.depth > 0).map(n => n.goal.trim()).filter(Boolean)
    if (leaves.length >= 1) return leaves
  } catch {}
  return [trimmed || 'Untitled goal']
}

// ── Create ─────────────────────────────────────────────────────────────────────
// Decompose `goal` into initial nodes (chained as a simple linear pipeline by
// dependency edges, which mirrors goalDecomposer's default prev→next chaining) and
// persist to .crucible/task-graph/<id>.json.
export function createGraph(goal: string): TaskGraph {
  const id = newId()
  const parts = decomposeGoal(goal)
  const nodes: TaskNode[] = parts.map((p, i) => ({
    id: `n${i + 1}`,
    goal: p.slice(0, 300),
    status: 'pending',
    assignedArchetype: selectArchetype(p),
  }))
  // Linear dependency chain: n1 -> n2 -> ... -> nK. The first node is a ready root.
  const edges: TaskEdge[] = []
  for (let i = 1; i < nodes.length; i++) {
    edges.push({ from: nodes[i - 1].id, to: nodes[i].id })
  }
  const graph: TaskGraph = {
    id,
    goal: goal.trim(),
    created: Date.now(),
    status: 'open',
    nodes,
    edges,
  }
  saveGraph(graph)
  return graph
}

// ── Load / save ──────────────────────────────────────────────────────────────
export function saveGraph(graph: TaskGraph): void {
  const dir = graphDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(graphFile(graph.id), JSON.stringify(graph, null, 2))
}

export function loadGraph(id: string): TaskGraph | null {
  try { return JSON.parse(fs.readFileSync(graphFile(id), 'utf8')) as TaskGraph }
  catch { return null }
}

// ── Update a node ────────────────────────────────────────────────────────────
// Applies a partial update to one node, stamps startedAt/completedAt on status
// transitions, persists, and — when every node is done — flips the graph to 'done'.
// Returns the updated graph (or null if the graph/node doesn't exist).
export function updateNode(
  graphId: string,
  nodeId: string,
  update: Partial<Pick<TaskNode, 'goal' | 'status' | 'result' | 'assignedArchetype'>>,
): TaskGraph | null {
  const graph = loadGraph(graphId)
  if (!graph) return null
  const node = graph.nodes.find(n => n.id === nodeId)
  if (!node) return null

  if (update.status && update.status !== node.status) {
    if (update.status === 'in_progress' && !node.startedAt) node.startedAt = Date.now()
    if (update.status === 'done') node.completedAt = Date.now()
  }
  if (update.goal !== undefined) node.goal = update.goal.slice(0, 300)
  if (update.status !== undefined) node.status = update.status
  if (update.result !== undefined) node.result = update.result
  if (update.assignedArchetype !== undefined) node.assignedArchetype = update.assignedArchetype

  // Auto-complete the graph once all nodes are done.
  if (graph.status === 'open' && graph.nodes.length > 0 && graph.nodes.every(n => n.status === 'done')) {
    graph.status = 'done'
  }
  saveGraph(graph)
  return graph
}

// ── Set the whole-graph status (complete / abandon) ──────────────────────────
export function setGraphStatus(graphId: string, status: GraphStatus): TaskGraph | null {
  const graph = loadGraph(graphId)
  if (!graph) return null
  graph.status = status
  saveGraph(graph)
  return graph
}

// ── Queries ──────────────────────────────────────────────────────────────────
// All graphs on disk, newest first.
export function getAllGraphs(): TaskGraph[] {
  let files: string[]
  try { files = fs.readdirSync(graphDir()) }
  catch { return [] }
  const graphs: TaskGraph[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try { graphs.push(JSON.parse(fs.readFileSync(path.join(graphDir(), f), 'utf8')) as TaskGraph) }
    catch {}
  }
  return graphs.sort((a, b) => b.created - a.created)
}

// Only graphs still marked 'open'.
export function getOpenGraphs(): TaskGraph[] {
  return getAllGraphs().filter(g => g.status === 'open')
}

// Nodes whose dependencies are all satisfied and which aren't done/blocked yet —
// i.e. the work that can start right now.
export function getReadyNodes(graph: TaskGraph): TaskNode[] {
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  return graph.nodes.filter(node => {
    if (node.status === 'done' || node.status === 'blocked' || node.status === 'in_progress') return false
    const deps = graph.edges.filter(e => e.to === node.id).map(e => e.from)
    return deps.every(depId => byId.get(depId)?.status === 'done')
  })
}

// ── Preamble line ────────────────────────────────────────────────────────────
// One short line summarising open goals + progress, for injection into the agent
// system preamble. Empty string when there are no open goals (so a Boolean filter
// drops it cleanly). Capped to a handful of goals to stay token-cheap.
export function buildOpenGoalsContext(maxGoals = 5): string {
  const open = getOpenGraphs().slice(0, maxGoals)
  if (open.length === 0) return ''
  const items = open.map(g => {
    const done = g.nodes.filter(n => n.status === 'done').length
    return `"${g.goal.slice(0, 80)}" (${done}/${g.nodes.length} done)`
  })
  return `You have these open goals from earlier sessions: ${items.join('; ')}.`
}

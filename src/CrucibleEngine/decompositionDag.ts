// Tier 1.1 — Task Decomposition → Dependency DAG.
//
// A natural-language request comes in; the output is an ordered DAG where the DAG
// IS the plan. The Foundation Model never holds the whole plan — it only fills
// narrow slots within a single node when asked. Construction here is fully
// heuristic and deterministic: NO model inference, NO paid API. This keeps the
// model-cost-independent invariant intact (decomposition must never depend on an
// external model) and makes the structure reproducible and testable.
//
// Each node carries exactly what a downstream synthesis step needs to act on it
// in isolation:
//   • targetFiles       — file(s) the node operates on (best-effort from the text)
//   • changeType         — create | edit | delete | refactor
//   • dependsOn          — ids of nodes that must complete first (the edges)
//   • verificationGate   — tsc | property-family | behavioral | retrieval-grounded
//   • route              — attached by classifyDag(): the capability router's
//                          decision (synth | fm | retrieve | abstain). The abstain
//                          path is reachable from EVERY node, by contract.
//
// Edge/sub-goal extraction reuses goalDecomposer (the same pure heuristic splitter
// the L2 workstream path already trusts) so we have one decomposition source of
// truth rather than a second, divergent parser.

import { decompose, type SubtaskNode } from './goalDecomposer'
import { classify, type RouteDecision, type RouterTask } from './router/capabilityRouter'
import {
  type SemanticIndex, relatedFiles, symbolsInFile,
} from './state/semanticIndex'

export type ChangeType = 'create' | 'edit' | 'delete' | 'refactor'
export type VerificationGate = 'tsc' | 'property-family' | 'behavioral' | 'retrieval-grounded'

/** One unit of the plan. The FM fills slots within a node; it never sees the DAG. */
export interface DagNode {
  id: string
  /** The narrow sub-goal for this node — the only slot the FM is asked to fill. */
  goal: string
  targetFiles: string[]
  changeType: ChangeType
  /** ids of nodes that must complete before this one (the DAG edges). */
  dependsOn: string[]
  verificationGate: VerificationGate
  /** Router decision; absent until classifyDag() runs. Always reachable to 'abstain'. */
  route?: RouteDecision
  /** Carried through from the heuristic decomposer for downstream uncertainty handling. */
  confidence: number
}

export interface TaskDag {
  rootGoal: string
  /** Topologically ordered: every node appears after all of its dependencies. */
  nodes: DagNode[]
  generatedAt: number
}

// ── Slot inference (pure heuristics) ─────────────────────────────────────────────

// Path-like or quoted filenames: `src/foo.ts`, "config.json", a/b/c.tsx, bare *.ext.
const FILE_TOKEN = /(?:`|"|')?([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,5})(?:`|"|')?/g

export function inferTargetFiles(goal: string): string[] {
  const out = new Set<string>()
  let m: RegExpExecArray | null
  FILE_TOKEN.lastIndex = 0
  while ((m = FILE_TOKEN.exec(goal)) !== null) {
    const tok = m[1]
    // Reject version/decimal noise ("3.2", "v1.0") and sentence-final words.
    if (/^\d+\.\d+$/.test(tok)) continue
    if (!/[A-Za-z]/.test(tok.split('.').pop() || '')) continue
    out.add(tok)
  }
  return [...out]
}

export function inferChangeType(goal: string): ChangeType {
  const g = goal.toLowerCase()
  // Order matters: a "refactor by removing" is a refactor, not a delete.
  if (/\b(refactor|rename|extract|inline|reorganize|restructure|move|simplify|clean\s*up|deduplicate)\b/.test(g)) return 'refactor'
  if (/\b(delete|remove|drop|strip|purge|tear\s*down|get\s*rid\s*of)\b/.test(g)) return 'delete'
  if (/\b(create|add|new|implement|build|write|generate|introduce|scaffold|set\s*up)\b/.test(g)) return 'create'
  // Default: an in-place modification of existing code.
  return 'edit'
}

export function inferVerificationGate(goal: string, changeType: ChangeType): VerificationGate {
  const g = goal.toLowerCase()

  // Retrieval-grounded: the node references something outside the repo's own
  // knowledge — an external library, API, spec, "latest"/"current" facts, or docs.
  if (/\b(latest|current|up[\s-]?to[\s-]?date|api\s+docs?|documentation|library|package|sdk|version of|how does .* work|spec(?:ification)?|rfc|changelog)\b/.test(g)) {
    return 'retrieval-grounded'
  }

  // Behavioral: the node is about runtime behavior — endpoints, observable output,
  // bug fixes, conditional flows, features a user can exercise.
  if (/\b(endpoint|route|api|server|request|response|returns?|when\s+the\s+user|behaviou?r|feature|bug|fails?|crash|regression|side\s*effect|integration|end[\s-]?to[\s-]?end|flow)\b/.test(g)) {
    return 'behavioral'
  }

  // Property-family: pure, self-contained transforms — the synth engine's home turf.
  if (/\b(function|algorithm|parse|format|convert|transform|compute|calculate|encode|decode|sort|validate|normalize|serialize|pure)\b/.test(g)) {
    return 'property-family'
  }

  // Pure type/structure work verifies cheapest under the compiler.
  if (changeType === 'refactor' || /\b(type|interface|generic|signature|import|export|rename)\b/.test(g)) {
    return 'tsc'
  }

  // Conservative default: the compiler is the cheapest always-applicable gate.
  return 'tsc'
}

// ── Topological ordering (Kahn) ──────────────────────────────────────────────────
// Produces a stable order where each node follows its dependencies. Cycles (which
// the heuristic decomposer should never produce, but we never trust input) are
// broken deterministically by appending any remaining nodes in their original
// order, so the function is total — it always returns every node exactly once.

function topoSort(nodes: DagNode[]): DagNode[] {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const indeg = new Map(nodes.map(n => [n.id, 0]))
  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      if (byId.has(dep)) indeg.set(n.id, (indeg.get(n.id) || 0) + 1)
    }
  }
  // Seed with zero-indegree nodes in original order for stability.
  const queue = nodes.filter(n => (indeg.get(n.id) || 0) === 0).map(n => n.id)
  const ordered: DagNode[] = []
  const seen = new Set<string>()
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    ordered.push(byId.get(id)!)
    for (const n of nodes) {
      if (n.dependsOn.includes(id)) {
        const d = (indeg.get(n.id) || 0) - 1
        indeg.set(n.id, d)
        if (d <= 0 && !seen.has(n.id)) queue.push(n.id)
      }
    }
  }
  // Cycle fallback: append anything unvisited so the result is always complete.
  for (const n of nodes) if (!seen.has(n.id)) ordered.push(n)
  return ordered
}

// ── Public API ───────────────────────────────────────────────────────────────────

/**
 * Build the dependency DAG for a request. Pure heuristics, no model call.
 * Reuses goalDecomposer for sub-goal + edge extraction, then enriches each node
 * with the slots a synthesis step needs (target files, change type, gate).
 */
export function buildTaskDag(request: string): TaskDag {
  const tree = decompose(request)
  // Drop the synthetic root; its only job in goalDecomposer is to anchor depth-1
  // edges. DAG nodes are the actionable sub-goals.
  const work: SubtaskNode[] = tree.nodes.filter(n => n.depth > 0)

  const nodes: DagNode[] = work.map(sn => {
    const changeType = inferChangeType(sn.goal)
    return {
      id: sn.id,
      goal: sn.goal,
      targetFiles: inferTargetFiles(sn.goal),
      changeType,
      // Re-point dependencies off the dropped root onto the actual predecessors.
      dependsOn: sn.dependsOn.filter(d => d !== 'goal_root' && work.some(w => w.id === d)),
      verificationGate: inferVerificationGate(sn.goal, changeType),
      confidence: sn.confidence,
    }
  })

  return { rootGoal: tree.rootGoal, nodes: topoSort(nodes), generatedAt: tree.generatedAt }
}

/**
 * Classify every DAG node through the capability router BEFORE synthesis begins.
 * Mutates nodes in place (attaching `route`) and returns the same DAG for chaining.
 *
 * The abstain path is reachable from every node by construction: each node is run
 * through classify(), whose contract guarantees a route (currently always 'abstain'
 * until Tier 1.2's semantic index backs real classification). `classifyFn` is
 * injectable purely for testing — production always uses the real router.
 */
export function classifyDag(
  dag: TaskDag,
  opts: {
    classifyFn?: (task: RouterTask) => RouteDecision
    /** Tier 1.2 index — when supplied, each node's router context is grounded
     *  with related files and the symbols its target files declare. */
    index?: SemanticIndex
  } = {},
): TaskDag {
  const classifyFn = opts.classifyFn ?? classify
  for (const node of dag.nodes) {
    node.route = classifyFn({
      goal: node.goal,
      targetFiles: node.targetFiles,
      context: {
        changeType: node.changeType,
        verificationGate: node.verificationGate,
        dependsOn: node.dependsOn,
        ...(opts.index ? groundNode(opts.index, node) : {}),
      },
    })
  }
  return dag
}

/** Pull the semantic facts a node's target files imply — the DAG querying Tier 1.2. */
function groundNode(idx: SemanticIndex, node: DagNode): Record<string, unknown> {
  const related = new Set<string>()
  const symbols: string[] = []
  for (const f of node.targetFiles) {
    for (const r of relatedFiles(idx, f)) related.add(r)
    for (const s of symbolsInFile(idx, f)) symbols.push(`${s.kind} ${s.name}`)
  }
  return { relatedFiles: [...related], targetSymbols: symbols }
}

/** Human-readable rendering of the plan for logs / spec injection. */
export function renderDag(dag: TaskDag): string {
  const lines = [`Plan (${dag.nodes.length} node${dag.nodes.length === 1 ? '' : 's'}) for: ${dag.rootGoal.slice(0, 120)}`]
  for (const n of dag.nodes) {
    const files = n.targetFiles.length ? n.targetFiles.join(', ') : '(files unresolved)'
    const deps = n.dependsOn.length ? ` after[${n.dependsOn.join(',')}]` : ''
    const route = n.route ? ` route=${n.route.route}(${n.route.confidence.toFixed(2)})` : ''
    lines.push(`  ${n.id}: [${n.changeType}/${n.verificationGate}] ${n.goal.slice(0, 80)} → ${files}${deps}${route}`)
  }
  return lines.join('\n')
}

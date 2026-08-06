// Goal decomposer — takes an incoming prompt and decomposes it into a
// dependency tree of subtasks. Runs as a pre-processing step before goalEngine.
//
// Node: { goal, confidence, dependsOn[], status }
// When a node's confidence drops below 0.6, all downstream dependent nodes
// are flagged as uncertain and get a caveat injected into their output.
//
// Integrates with goalEngine.ts as a pre-processing step.

export type SubtaskStatus = 'pending' | 'in_progress' | 'done' | 'uncertain' | 'blocked'

export interface SubtaskNode {
  id: string
  goal: string           // the specific sub-goal
  confidence: number     // 0-1: how clear/achievable this subtask is
  dependsOn: string[]    // ids of subtasks that must complete before this one
  status: SubtaskStatus
  caveat?: string        // injected when confidence < 0.6
  depth: number          // distance from root
}

export interface DecompositionTree {
  rootGoal: string
  nodes: SubtaskNode[]
  generatedAt: number
}

// Simple sentence-boundary splitter
function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 10)
}

// Estimate confidence for a subtask based on clarity signals
function estimateConfidence(subtaskText: string, parentConfidence = 1.0): number {
  let conf = parentConfidence
  // Vague language lowers confidence
  if (/\b(maybe|possibly|might|could|unclear|unknown|tbd|later|eventually)\b/i.test(subtaskText)) conf -= 0.2
  // Specific measurable goals raise confidence
  if (/\b(exactly|specifically|must|should|ensure|implement|create|build|fix)\b/i.test(subtaskText)) conf += 0.05
  // Long/complex goals lower confidence slightly
  if (subtaskText.length > 200) conf -= 0.1
  return Math.max(0.1, Math.min(1.0, conf))
}

// Detect if one subtask likely depends on another based on keyword overlap
function detectDependency(candidateDep: SubtaskNode, candidate: SubtaskNode): boolean {
  if (candidateDep.id === candidate.id) return false
  if (candidateDep.depth >= candidate.depth) return false

  const depWords = new Set(
    candidateDep.goal.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 4)
  )
  const candWords = candidate.goal.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 4)

  const overlap = candWords.filter(w => depWords.has(w)).length
  return overlap >= 2  // at least 2 significant words in common → likely dependency
}

// Main decomposition — uses heuristic parsing (no model call, free-tier safe)
export function decompose(prompt: string): DecompositionTree {
  const nodes: SubtaskNode[] = []

  // Split prompt into candidate subtasks
  const sentences = splitIntoSentences(prompt)

  // Identify structural markers that signal a new subtask
  const subtaskMarkers = /^(?:\d+[.)]\s*|[-*]\s*|(?:first|second|third|then|next|finally|also|and then)\b)/i

  const rootNode: SubtaskNode = {
    id: 'goal_root',
    goal: prompt.slice(0, 200),
    confidence: 1.0,
    dependsOn: [],
    status: 'pending',
    depth: 0,
  }
  nodes.push(rootNode)

  // Parse explicit list items or numbered steps
  const listItems = prompt.match(/(?:^|\n)\s*(?:\d+[.)]\s*[-*]\s*|[-*]\s*|\d+[.)]\s*)[^\n]{10,}/gm)
  if (listItems && listItems.length >= 2) {
    let prevId = 'goal_root'
    listItems.forEach((item, i) => {
      const text = item.replace(/^\s*(?:\d+[.)]\s*|[-*]\s*)/, '').trim()
      const id = `goal_${i + 1}`
      const confidence = estimateConfidence(text)
      nodes.push({
        id,
        goal: text.slice(0, 200),
        confidence,
        dependsOn: [prevId],
        status: confidence < 0.6 ? 'uncertain' : 'pending',
        caveat: confidence < 0.6 ? `Confidence low (${(confidence * 100).toFixed(0)}%) — clarify this step before proceeding` : undefined,
        depth: 1,
      })
      prevId = id
    })
  } else {
    // No list structure — split by "and", "then", "also" connectors
    const connectors = prompt.split(/\b(?:and then|then|also|additionally|furthermore|finally|lastly)\b/i)
    if (connectors.length >= 2) {
      connectors.forEach((part, i) => {
        const text = part.trim()
        if (text.length < 10) return
        const id = `goal_p${i + 1}`
        const confidence = estimateConfidence(text)
        const prevNodes = nodes.filter(n => n.depth === 1).slice(-1)
        nodes.push({
          id,
          goal: text.slice(0, 200),
          confidence,
          dependsOn: prevNodes.length ? [prevNodes[0].id] : ['goal_root'],
          status: confidence < 0.6 ? 'uncertain' : 'pending',
          caveat: confidence < 0.6 ? `Uncertain step — requires clarification` : undefined,
          depth: 1,
        })
      })
    } else {
      // Single-goal prompt — create one direct subtask
      const confidence = estimateConfidence(prompt)
      nodes.push({
        id: 'goal_1',
        goal: prompt.slice(0, 200),
        confidence,
        dependsOn: ['goal_root'],
        status: confidence < 0.6 ? 'uncertain' : 'pending',
        caveat: confidence < 0.6 ? `Goal clarity is low — consider rephrasing for better results` : undefined,
        depth: 1,
      })
    }
  }

  // Auto-detect additional dependencies from keyword overlap
  const leafNodes = nodes.filter(n => n.depth > 0)
  for (const node of leafNodes) {
    for (const potentialDep of leafNodes) {
      if (!node.dependsOn.includes(potentialDep.id) && detectDependency(potentialDep, node)) {
        node.dependsOn.push(potentialDep.id)
      }
    }
  }

  return { rootGoal: prompt.slice(0, 300), nodes, generatedAt: Date.now() }
}

// When a node's confidence drops below 0.6, flag all downstream dependents.
// Call this whenever a node's confidence is updated during execution.
export function propagateUncertainty(tree: DecompositionTree, nodeId: string, newConfidence: number): DecompositionTree {
  const nodeMap = new Map(tree.nodes.map(n => [n.id, n]))
  const node = nodeMap.get(nodeId)
  if (!node) return tree

  node.confidence = newConfidence
  if (newConfidence < 0.6) {
    node.status = 'uncertain'
    node.caveat = `Confidence dropped to ${(newConfidence * 100).toFixed(0)}% — downstream results may be unreliable`
  }

  // BFS to flag all downstream nodes
  const queue = [nodeId]
  const visited = new Set<string>()
  while (queue.length) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)

    for (const n of tree.nodes) {
      if (n.dependsOn.includes(current) && n.id !== nodeId) {
        n.status = 'uncertain'
        n.caveat = `Upstream node "${nodeMap.get(current)?.goal.slice(0, 50)}…" has low confidence — this step's output may be unreliable`
        queue.push(n.id)
      }
    }
  }

  return tree
}

// Build a context block summarizing the decomposition for injection into prompts
export function buildDecompositionContext(tree: DecompositionTree, maxChars = 800): string {
  const lines: string[] = [`Goal breakdown (${tree.nodes.length - 1} subtasks):`]
  for (const node of tree.nodes.filter(n => n.depth > 0)) {
    const status = node.status === 'uncertain' ? '(uncertain) ' : ''
    lines.push(`  ${status}${node.goal.slice(0, 100)}`)
    if (node.caveat) lines.push(`    ! ${node.caveat}`)
  }
  return lines.join('\n').slice(0, maxChars)
}

// ── Flat subtask extraction (used by L2 parallel workstreams) ─────────────────
// Splits a multi-part prompt into independent, self-contained subtask strings.
// Handles parenthetical "(1) ... (2) ...", numbered "1. / 1)", and bullet lists,
// inline or multiline. Each returned subtask carries the shared preamble (the
// text before the first marker) so a model answering one section still knows the
// overall topic. Returns [] when the prompt is not genuinely multi-part.
export function extractSubtasks(prompt: string, opts: { min?: number } = {}): string[] {
  const min = opts.min ?? 2
  const text = prompt.trim()
  if (text.length < 40) return []

  // Candidate marker schemes, tried in priority order. `seq` schemes capture a
  // number/letter that must form an ascending run (1,2,3… or a,b,c…) — this lets
  // us safely match INLINE numbering ("…parts. 1. foo 2. bar") without tripping
  // on decimals/versions/prices like "$4.99" or "HTTP/2".
  const schemes: { re: RegExp; seq: boolean }[] = [
    { re: /\((\d+)\)/g, seq: true },                 // (1) (2) (3) — parenthetical
    { re: /(?:^|\n|[.:;]\s)\s*(\d+)[.)]\s+/g, seq: true },  // 1. / 1) line-start or after sentence end
    { re: /(?:^|\n)\s*[-*•]\s+/g, seq: false },      // - / * / • bullets at line start
    { re: /(?:^|\n|[.:;]\s)\s*([a-z])[.)]\s+/g, seq: true },// a. / a) lettered
  ]

  for (const { re, seq } of schemes) {
    const markers: { index: number; len: number; key: string }[] = []
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(text)) !== null) {
      markers.push({ index: m.index, len: m[0].length, key: (m[1] ?? '').toLowerCase() })
      if (markers.length > 50) break  // pathological input guard
    }
    if (markers.length < min) continue

    // For sequence schemes, require an ascending run starting at 1 / 'a'.
    if (seq) {
      const nums = markers.map(mk => /^\d+$/.test(mk.key) ? parseInt(mk.key, 10) : mk.key.charCodeAt(0) - 96)
      const ascending = nums.every((n, i) => i === 0 ? n === 1 : n === nums[i - 1] + 1)
      if (!ascending) continue
    }

    // Preamble: everything before the first marker (the shared topic/context).
    const preamble = text.slice(0, markers[0].index).trim().replace(/[:\-–—]\s*$/, '').trim()

    const segments: string[] = []
    for (let i = 0; i < markers.length; i++) {
      const start = markers[i].index + markers[i].len
      const end = i + 1 < markers.length ? markers[i + 1].index : text.length
      const body = text.slice(start, end).trim().replace(/[,;.]\s*$/, '').trim()
      if (body.length < 5) continue
      // Compose a self-contained intent: preamble + this section.
      const intent = preamble && preamble.length < 200
        ? `${preamble}: ${body}`
        : body
      segments.push(intent)
    }

    if (segments.length >= min) return segments
  }

  // Colon-delimited design specs: "Design X: a, b, c, and d. Show Y in code."
  // Matches prompts like "Design the complete system: the data structure ..., the gossip protocol, ..."
  // This is the canonical form for complex technical prompts that lack structural markers.
  const colonSpecRe = /(?:design|build|implement|create|describe|show|explain|outline)\s+[^:]{0,100}:\s*([^.!?]{30,500})/gi
  let cm: RegExpExecArray | null
  const colonSegments: string[] = []
  const preambleForColon = text.slice(0, text.search(colonSpecRe)).trim().replace(/[:\-–—]\s*$/, '').trim()
  colonSpecRe.lastIndex = 0
  while ((cm = colonSpecRe.exec(text)) !== null) {
    const colonContent = cm[1]
    // Split on ", and ", ", or ", "," + optionally "and/or "
    const items = colonContent
      .split(/,\s*(?:and\s+|or\s+)?/i)
      .map(s => s.trim().replace(/[.;,]\s*$/, '').trim())
      .filter(s => s.length >= 8)
    colonSegments.push(...items.map(s =>
      preambleForColon && preambleForColon.length < 200 ? `${preambleForColon}: ${s}` : s
    ))
  }
  // Also extract imperative sentences after the colon block ("Show X in code.")
  const imperativeRe = /\b(?:show|include|provide|demonstrate|write|produce)\b[^.!?]{10,120}[.!?]/gi
  while ((cm = imperativeRe.exec(text)) !== null) {
    const s = cm[0].trim()
    if (!colonSegments.some(seg => seg.includes(s.slice(0, 20)))) colonSegments.push(s)
  }
  if (colonSegments.length >= min) return colonSegments

  // Fall back to connector-based splitting ("X, then Y, also Z"). Connectors are
  // the noisiest signal, so require at least 3 substantial parts before trusting it.
  const connectorParts = text
    .split(/\b(?:and then|then|also|additionally|furthermore)\b/i)
    .map(s => s.trim())
    .filter(s => s.length > 15)
  if (connectorParts.length >= Math.max(3, min)) return connectorParts

  return []
}

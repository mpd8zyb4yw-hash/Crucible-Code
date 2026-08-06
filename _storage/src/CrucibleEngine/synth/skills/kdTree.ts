// Verified primitive: k-d tree — exact nearest-neighbour and range search in k dimensions.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — k-d tree.
export type Point = number[]
interface KDNode { point: Point; data: unknown; left: KDNode | null; right: KDNode | null }

export class KDTree {
  private root: KDNode | null = null
  private k: number
  constructor(k: number) { this.k = k }

  insert(point: Point, data: unknown = null): void {
    const node: KDNode = { point: [...point], data, left: null, right: null }
    if (!this.root) { this.root = node; return }
    let cur = this.root; let depth = 0
    while (true) {
      const dim = depth % this.k
      if (point[dim] < cur.point[dim]) { if (!cur.left) { cur.left = node; return } cur = cur.left }
      else { if (!cur.right) { cur.right = node; return } cur = cur.right }
      depth++
    }
  }

  nearest(query: Point): { point: Point; data: unknown; dist: number } | null {
    if (!this.root) return null
    let best: KDNode = this.root
    let bestDist = this._dist(query, this.root.point)
    const search = (node: KDNode | null, depth: number): void => {
      if (!node) return
      const d = this._dist(query, node.point)
      if (d < bestDist) { bestDist = d; best = node }
      const dim = depth % this.k
      const diff = query[dim] - node.point[dim]
      const [near, far] = diff < 0 ? [node.left, node.right] : [node.right, node.left]
      search(near, depth + 1)
      if (diff * diff < bestDist) search(far, depth + 1)
    }
    search(this.root, 0)
    return { point: best.point, data: best.data, dist: Math.sqrt(bestDist) }
  }

  rangeSearch(lo: Point, hi: Point): Array<{ point: Point; data: unknown }> {
    const results: Array<{ point: Point; data: unknown }> = []
    const search = (node: KDNode | null, depth: number): void => {
      if (!node) return
      const dim = depth % this.k
      if (node.point.every((v, i) => v >= lo[i] && v <= hi[i])) results.push({ point: node.point, data: node.data })
      if (lo[dim] <= node.point[dim]) search(node.left, depth + 1)
      if (hi[dim] >= node.point[dim]) search(node.right, depth + 1)
    }
    search(this.root, 0)
    return results
  }

  private _dist(a: Point, b: Point): number { return a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0) }
}
`
registerSkill({
  id: 'kd-tree',
  summary: 'k-d tree: nearest-neighbour and range search in k-dimensional space.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bk.?d.?tree\b/i)) sc += 0.7
    if (s.has(/\bnearest.?neighbou?r\b/i)) sc += 0.25
    if (s.has(/\bspatial\b/i) && s.has(/\bsearch\b/i)) sc += 0.15
    if (s.has(/\brange.?search\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/kdTree.ts', content: IMPL }]
  },
})

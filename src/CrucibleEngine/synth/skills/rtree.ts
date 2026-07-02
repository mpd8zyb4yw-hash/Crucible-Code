// Verified primitive: R-tree — 2-D spatial index, insert, bounding-box range query.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — R-tree spatial index.
export interface BBox { minX: number; minY: number; maxX: number; maxY: number }
export interface REntry { bbox: BBox; data: unknown }

const union = (a: BBox, b: BBox): BBox => ({
  minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
  maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY)
})
const area = (b: BBox): number => (b.maxX - b.minX) * (b.maxY - b.minY)
const intersects = (a: BBox, b: BBox): boolean =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY

interface RNode { bbox: BBox; entries: REntry[]; children: RNode[]; leaf: boolean }

export class RTree {
  private root: RNode = { bbox: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }, entries: [], children: [], leaf: true }
  private maxEntries: number

  constructor(maxEntries = 9) { this.maxEntries = maxEntries }

  insert(entry: REntry): void {
    this._insert(this.root, entry)
    if (this.root.entries.length + this.root.children.length > this.maxEntries) {
      const [a, b] = this._split(this.root)
      this.root = { bbox: union(a.bbox, b.bbox), entries: [], children: [a, b], leaf: false }
    }
  }

  query(bbox: BBox): REntry[] {
    const results: REntry[] = []
    const search = (node: RNode): void => {
      if (!intersects(node.bbox, bbox)) return
      if (node.leaf) { for (const e of node.entries) if (intersects(e.bbox, bbox)) results.push(e) }
      else for (const c of node.children) search(c)
    }
    search(this.root); return results
  }

  private _insert(node: RNode, entry: REntry): void {
    this._expand(node, entry.bbox)
    if (node.leaf) { node.entries.push(entry); return }
    let best = node.children[0]; let bestInc = Infinity
    for (const c of node.children) {
      const inc = area(union(c.bbox, entry.bbox)) - area(c.bbox)
      if (inc < bestInc) { bestInc = inc; best = c }
    }
    this._insert(best, entry)
    if (best.entries.length + best.children.length > this.maxEntries) {
      const [a, b] = this._split(best)
      node.children = node.children.filter(c => c !== best); node.children.push(a, b)
    }
  }

  private _expand(node: RNode, bbox: BBox): void {
    node.bbox = node.bbox.minX === Infinity ? { ...bbox } : union(node.bbox, bbox)
  }

  private _split(node: RNode): [RNode, RNode] {
    const items: Array<REntry | RNode> = node.leaf ? [...node.entries] : [...node.children]
    const half = Math.ceil(items.length / 2)
    const mkNode = (list: typeof items): RNode => {
      const n: RNode = { bbox: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }, entries: [], children: [], leaf: node.leaf }
      for (const it of list) { const bb = 'bbox' in it ? it.bbox : (it as REntry).bbox; n.bbox = n.bbox.minX === Infinity ? { ...bb } : union(n.bbox, bb); if (node.leaf) n.entries.push(it as REntry); else n.children.push(it as RNode) }
      return n
    }
    return [mkNode(items.slice(0, half)), mkNode(items.slice(half))]
  }
}
`
registerSkill({
  id: 'r-tree',
  summary: 'R-tree: 2-D spatial index, insert, bounding-box range query.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\br.?tree\b/i) && s.has(/\bspatial\b|\bbounding\b/i)) sc += 0.6
    if (s.has(/\bbounding.?box\b/i) && s.has(/\bindex\b/i)) sc += 0.2
    if (s.has(/\bspatial.?index\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/rtree.ts', content: IMPL }]
  },
})

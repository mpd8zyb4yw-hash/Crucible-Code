// Verified primitive: Octree — 3-D spatial partitioning, insert, range query.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Octree.
export interface Vec3 { x: number; y: number; z: number }
export interface OctBounds { cx: number; cy: number; cz: number; half: number }

interface OctNode { bounds: OctBounds; points: Array<{ p: Vec3; data: unknown }>; children: OctNode[] | null }

export class Octree {
  private root: OctNode
  private capacity: number

  constructor(bounds: OctBounds, capacity = 8) {
    this.root = { bounds, points: [], children: null }
    this.capacity = capacity
  }

  insert(p: Vec3, data: unknown = null): boolean {
    return this._insert(this.root, p, data)
  }

  query(center: Vec3, radius: number): Array<{ p: Vec3; data: unknown }> {
    const results: Array<{ p: Vec3; data: unknown }> = []
    this._query(this.root, center, radius, results)
    return results
  }

  private _insert(node: OctNode, p: Vec3, data: unknown): boolean {
    if (!this._inBounds(node.bounds, p)) return false
    if (!node.children && node.points.length < this.capacity) { node.points.push({ p, data }); return true }
    if (!node.children) this._subdivide(node)
    for (const c of node.children!) if (this._insert(c, p, data)) return true
    return false
  }

  private _query(node: OctNode, center: Vec3, r: number, out: Array<{ p: Vec3; data: unknown }>): void {
    if (!this._sphereIntersectsBox(center, r, node.bounds)) return
    for (const { p, data } of node.points) {
      const dx = p.x - center.x; const dy = p.y - center.y; const dz = p.z - center.z
      if (dx*dx + dy*dy + dz*dz <= r*r) out.push({ p, data })
    }
    if (node.children) for (const c of node.children) this._query(c, center, r, out)
  }

  private _subdivide(node: OctNode): void {
    const { cx, cy, cz, half } = node.bounds; const q = half / 2
    const offsets = [-1, 1]
    node.children = offsets.flatMap(dx => offsets.flatMap(dy => offsets.map(dz =>
      ({ bounds: { cx: cx + dx * q, cy: cy + dy * q, cz: cz + dz * q, half: q }, points: [], children: null }))))
    for (const { p, data } of node.points) for (const c of node.children) if (this._insert(c, p, data)) break
    node.points = []
  }

  private _inBounds({ cx, cy, cz, half }: OctBounds, { x, y, z }: Vec3): boolean {
    return Math.abs(x - cx) <= half && Math.abs(y - cy) <= half && Math.abs(z - cz) <= half
  }

  private _sphereIntersectsBox({ cx, cy, cz, half }: OctBounds, center: Vec3, r: number): boolean {
    const dx = Math.max(0, Math.abs(center.x - cx) - half)
    const dy = Math.max(0, Math.abs(center.y - cy) - half)
    const dz = Math.max(0, Math.abs(center.z - cz) - half)
    return dx*dx + dy*dy + dz*dz <= r*r
  }
}
`
registerSkill({
  id: 'oct-tree',
  summary: 'Octree: 3-D spatial partitioning, insert, sphere range query.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\boctree\b|\boct.?tree\b/i)) sc += 0.7
    if (s.has(/\b3.?d\b/i) && s.has(/\bspatial\b/i)) sc += 0.2
    if (s.has(/\bvec3\b/i) && s.has(/\bpartition\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/octree.ts', content: IMPL }]
  },
})

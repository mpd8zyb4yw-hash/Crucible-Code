// Verified primitive: QuadTree — 2-D spatial partitioning, insert, point query, range query.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — QuadTree.
export interface Rect { x: number; y: number; w: number; h: number }
export interface QPoint { x: number; y: number; data?: unknown }

export class QuadTree {
  private bounds: Rect
  private capacity: number
  private points: QPoint[] = []
  private divided = false
  private ne: QuadTree | null = null; private nw: QuadTree | null = null
  private se: QuadTree | null = null; private sw: QuadTree | null = null

  constructor(bounds: Rect, capacity = 4) { this.bounds = bounds; this.capacity = capacity }

  insert(p: QPoint): boolean {
    if (!this._contains(p)) return false
    if (this.points.length < this.capacity && !this.divided) { this.points.push(p); return true }
    if (!this.divided) this._subdivide()
    return this.ne!.insert(p) || this.nw!.insert(p) || this.se!.insert(p) || this.sw!.insert(p)
  }

  query(range: Rect): QPoint[] {
    const found: QPoint[] = []
    if (!this._intersects(range)) return found
    for (const p of this.points) if (this._inRect(p, range)) found.push(p)
    if (this.divided) [this.ne, this.nw, this.se, this.sw].forEach(q => found.push(...q!.query(range)))
    return found
  }

  private _subdivide(): void {
    const { x, y, w, h } = this.bounds; const hw = w / 2; const hh = h / 2
    this.ne = new QuadTree({ x: x + hw, y, w: hw, h: hh }, this.capacity)
    this.nw = new QuadTree({ x, y, w: hw, h: hh }, this.capacity)
    this.se = new QuadTree({ x: x + hw, y: y + hh, w: hw, h: hh }, this.capacity)
    this.sw = new QuadTree({ x, y: y + hh, w: hw, h: hh }, this.capacity)
    this.divided = true
    for (const p of this.points) this.ne!.insert(p) || this.nw!.insert(p) || this.se!.insert(p) || this.sw!.insert(p)
    this.points = []
  }

  private _contains(p: QPoint): boolean {
    const { x, y, w, h } = this.bounds
    return p.x >= x && p.x < x + w && p.y >= y && p.y < y + h
  }
  private _inRect(p: QPoint, r: Rect): boolean {
    return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h
  }
  private _intersects(r: Rect): boolean {
    const { x, y, w, h } = this.bounds
    return !(r.x >= x + w || r.x + r.w <= x || r.y >= y + h || r.y + r.h <= y)
  }
}
`
registerSkill({
  id: 'quad-tree',
  summary: 'QuadTree: 2-D spatial partitioning, insert, range query.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bquad.?tree\b/i)) sc += 0.7
    if (s.has(/\b2.?d\b/i) && s.has(/\bspatial\b/i)) sc += 0.2
    if (s.has(/\bpartition\b/i) && s.has(/\bspace\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/quadTree.ts', content: IMPL }]
  },
})

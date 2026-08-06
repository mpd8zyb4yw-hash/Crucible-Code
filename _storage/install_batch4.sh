mkdir -p src/CrucibleEngine/synth/skills
cat > src/CrucibleEngine/synth/skills/unionFind.ts << 'TSEOF'
import { registerSkill, type SpecFeatures, type SynthFile } from '../engine'

const IMPL = `export class UnionFind {
  private parent: number[]
  private rank: number[]
  private _components: number

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
    this.rank = new Array(n).fill(0)
    this._components = n
  }

  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]]
      x = this.parent[x]
    }
    return x
  }

  union(x: number, y: number): boolean {
    const rx = this.find(x), ry = this.find(y)
    if (rx === ry) return false
    if (this.rank[rx] < this.rank[ry]) this.parent[rx] = ry
    else if (this.rank[rx] > this.rank[ry]) this.parent[ry] = rx
    else { this.parent[ry] = rx; this.rank[rx]++ }
    this._components--
    return true
  }

  connected(x: number, y: number): boolean { return this.find(x) === this.find(y) }
  get components() { return this._components }

  groups(): Map<number, number[]> {
    const map = new Map<number, number[]>()
    for (let i = 0; i < this.parent.length; i++) {
      const root = this.find(i)
      if (!map.has(root)) map.set(root, [])
      map.get(root)!.push(i)
    }
    return map
  }
}`

registerSkill({
  id: 'union-find',
  summary: 'Union-Find (DSU) - path compression + union by rank, O(alpha) amortized.',
  match(s: SpecFeatures): number {
    let score = 0
    if (s.has(/union.?find|disjoint.?set/i)) score += 0.9
    if (s.has(/\b(DSU|UF)\b/)) score += 0.7
    if (s.has(/\bunion\b/i) && s.has(/\bfind\b/i) && s.has(/\bconnect/i)) score += 0.4
    if (s.has(/path.?compress/i)) score += 0.4
    if (s.has(/connected.?component/i)) score += 0.3
    return score
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/unionFind.ts', content: IMPL }]
  },
})
TSEOF
echo "Skill written: unionFind.ts"

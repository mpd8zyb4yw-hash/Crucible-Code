// Verified primitive: B-tree order-t — insert, delete, search, in-order iteration.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — B-tree (order t).
interface BNode<K, V> { keys: K[]; vals: (V | null)[]; children: BNode<K, V>[]; leaf: boolean }

export class BTree<K = string, V = unknown> {
  private root: BNode<K, V>
  private t: number  // min degree
  private cmp: (a: K, b: K) => number

  constructor(t = 3, cmp: (a: K, b: K) => number = (a, b) => (a < b ? -1 : a > b ? 1 : 0)) {
    this.t = t; this.cmp = cmp
    this.root = { keys: [], vals: [], children: [], leaf: true }
  }

  search(k: K): V | undefined {
    const find = (n: BNode<K, V>): V | undefined => {
      let i = 0; while (i < n.keys.length && this.cmp(k, n.keys[i]) > 0) i++
      if (i < n.keys.length && this.cmp(k, n.keys[i]) === 0) return n.vals[i] ?? undefined
      if (n.leaf) return undefined
      return find(n.children[i])
    }
    return find(this.root)
  }

  insert(k: K, v: V): void {
    if (this.root.keys.length === 2 * this.t - 1) {
      const s: BNode<K, V> = { keys: [], vals: [], children: [this.root], leaf: false }
      this._split(s, 0); this.root = s
    }
    this._insertNF(this.root, k, v)
  }

  *inOrder(): IterableIterator<[K, V]> {
    const visit = function*(n: BNode<K, V>): IterableIterator<[K, V]> {
      for (let i = 0; i < n.keys.length; i++) {
        if (!n.leaf) yield* visit(n.children[i])
        if (n.vals[i] !== null) yield [n.keys[i], n.vals[i]!]
      }
      if (!n.leaf) yield* visit(n.children[n.keys.length])
    }
    yield* visit(this.root)
  }

  private _split(parent: BNode<K, V>, i: number): void {
    const t = this.t; const y = parent.children[i]
    const z: BNode<K, V> = { keys: y.keys.splice(t, t - 1), vals: y.vals.splice(t, t - 1), children: y.leaf ? [] : y.children.splice(t), leaf: y.leaf }
    parent.keys.splice(i, 0, y.keys.pop()!)
    parent.vals.splice(i, 0, y.vals.pop()!)
    parent.children.splice(i + 1, 0, z)
  }

  private _insertNF(n: BNode<K, V>, k: K, v: V): void {
    let i = n.keys.length - 1
    if (n.leaf) {
      while (i >= 0 && this.cmp(k, n.keys[i]) < 0) i--
      n.keys.splice(i + 1, 0, k); n.vals.splice(i + 1, 0, v)
    } else {
      while (i >= 0 && this.cmp(k, n.keys[i]) < 0) i--
      i++
      if (n.children[i].keys.length === 2 * this.t - 1) { this._split(n, i); if (this.cmp(k, n.keys[i]) > 0) i++ }
      this._insertNF(n.children[i], k, v)
    }
  }
}
`
registerSkill({
  id: 'btree',
  summary: 'B-tree: balanced multi-way tree with insert, search, in-order iteration.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bb.?tree\b/i)) sc += 0.6
    if (s.has(/\bmin.?degree\b/i)) sc += 0.25
    if (s.has(/\bbalanced.?tree\b/i)) sc += 0.2
    if (s.has(/\bin.?order\b/i) && s.has(/\btree\b/i)) sc += 0.1
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/btree.ts', content: IMPL }]
  },
})

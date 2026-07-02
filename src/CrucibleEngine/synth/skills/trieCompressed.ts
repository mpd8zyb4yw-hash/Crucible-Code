// Verified primitive: Patricia / compressed trie — space-efficient prefix tree.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Patricia (compressed) trie.
interface PNode { label: string; children: Map<string, PNode>; terminal: boolean; data: unknown }

export class PatriciaTrie {
  private root: PNode = { label: '', children: new Map(), terminal: false, data: null }

  insert(key: string, data: unknown = true): void {
    let node = this.root; let i = 0
    while (i < key.length) {
      const ch = key[i]
      if (!node.children.has(ch)) { node.children.set(ch, { label: key.slice(i), children: new Map(), terminal: true, data }); return }
      const child = node.children.get(ch)!
      let j = 0; while (j < child.label.length && i + j < key.length && child.label[j] === key[i + j]) j++
      if (j === child.label.length) { node = child; i += j; continue }
      // Split
      const split: PNode = { label: child.label.slice(0, j), children: new Map(), terminal: false, data: null }
      split.children.set(child.label[j], { ...child, label: child.label.slice(j) })
      node.children.set(ch, split)
      if (i + j === key.length) { split.terminal = true; split.data = data }
      else split.children.set(key[i + j], { label: key.slice(i + j), children: new Map(), terminal: true, data })
      return
    }
    node.terminal = true; node.data = data
  }

  search(key: string): { found: boolean; data: unknown } {
    let node = this.root; let i = 0
    while (i < key.length) {
      const child = node.children.get(key[i])
      if (!child) return { found: false, data: null }
      if (!key.startsWith(child.label, i)) return { found: false, data: null }
      i += child.label.length; node = child
    }
    return { found: node.terminal, data: node.data }
  }

  *withPrefix(prefix: string): IterableIterator<string> {
    let node = this.root; let i = 0
    while (i < prefix.length) {
      const child = node.children.get(prefix[i])
      if (!child) return
      const match = Math.min(child.label.length, prefix.length - i)
      if (child.label.slice(0, match) !== prefix.slice(i, i + match)) return
      i += child.label.length; node = child
    }
    const base = prefix.slice(0, i)
    const visit = function*(n: PNode, acc: string): IterableIterator<string> {
      if (n.terminal) yield base + acc
      for (const [, c] of n.children) yield* visit(c, acc + c.label)
    }
    yield* visit(node, node === this.root ? '' : node.label)
  }
}
`
registerSkill({
  id: 'trie-compressed',
  summary: 'Patricia / compressed trie: space-efficient prefix tree with split nodes.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bpatricia\b/i)) sc += 0.5
    if (s.has(/\bcompressed.?trie\b|\bradix.?tree\b/i)) sc += 0.5
    if (s.has(/\bsplit\b/i) && s.has(/\btrie\b/i)) sc += 0.2
    if (s.has(/\bspace.?efficient\b/i) && s.has(/\btrie\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/patriciaTrie.ts', content: IMPL }]
  },
})

import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `class TrieNode {
  children: Map<string, TrieNode> = new Map()
  isEnd: boolean = false
}

export class Trie {
  private root: TrieNode = new TrieNode()

  insert(word: string): void {
    let node = this.root
    for (const ch of word) {
      if (!node.children.has(ch)) node.children.set(ch, new TrieNode())
      node = node.children.get(ch)!
    }
    node.isEnd = true
  }

  search(word: string): boolean {
    const node = this.find(word)
    return node !== null && node.isEnd
  }

  startsWith(prefix: string): boolean {
    return this.find(prefix) !== null
  }

  private find(str: string): TrieNode | null {
    let node = this.root
    for (const ch of str) {
      if (!node.children.has(ch)) return null
      node = node.children.get(ch)!
    }
    return node
  }

  delete(word: string): boolean {
    if (!this.search(word)) return false
    let node = this.root
    const path: TrieNode[] = [node]
    for (const ch of word) {
      node = node.children.get(ch)!
      path.push(node)
    }
    node.isEnd = false
    for (let i = path.length - 1; i > 0; i--) {
      const child = path[i]
      if (child.children.size === 0 && !child.isEnd) {
        path[i - 1].children.delete(word[i - 1])
      } else {
        break
      }
    }
    return true
  }

  wordsWithPrefix(prefix: string): string[] {
    const node = this.find(prefix)
    if (!node) return []
    const results: string[] = []
    const dfs = (n: TrieNode, path: string) => {
      if (n.isEnd) results.push(path)
      for (const [ch, child] of n.children) dfs(child, path + ch)
    }
    dfs(node, prefix)
    return results
  }
}`

registerSkill({
  id: 'trie',
  summary: 'Trie (prefix tree) - insert/search/startsWith/delete/prefix enumeration.',
  match(s: SpecFeatures): number {
    let score = 0
    if (s.has(/\btrie\b/i)) score += 0.9
    if (s.has(/prefix.?tree/i)) score += 0.9
    if (s.has(/startsWith|starts.?with.*prefix/i)) score += 0.4
    if (s.has(/autocomplete|word.?lookup/i)) score += 0.3
    return score
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/trie.ts', content: IMPL }]
  },
})

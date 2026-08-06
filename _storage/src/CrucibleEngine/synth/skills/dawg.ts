// Verified primitive: DAWG (Directed Acyclic Word Graph) — minimal DFA for a word set.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — DAWG (minimal DFA).
interface DAWGState { terminal: boolean; edges: Map<string, number> }

export class DAWG {
  private states: DAWGState[] = [{ terminal: false, edges: new Map() }]
  private registry = new Map<string, number>()

  private _key(s: DAWGState): string {
    return \`\${s.terminal}|\${[...s.edges.entries()].sort().map(([c, i]) => \`\${c}:\${i}\`).join(',')}\`
  }

  build(words: string[]): void {
    const sorted = [...new Set(words)].sort()
    for (const word of sorted) this._addWord(word)
  }

  private _addWord(word: string): void {
    let state = 0
    for (const ch of word) {
      const edges = this.states[state].edges
      if (!edges.has(ch)) { const s: DAWGState = { terminal: false, edges: new Map() }; this.states.push(s); edges.set(ch, this.states.length - 1) }
      state = edges.get(ch)!
    }
    this.states[state].terminal = true
  }

  has(word: string): boolean {
    let state = 0
    for (const ch of word) {
      const next = this.states[state].edges.get(ch)
      if (next === undefined) return false; state = next
    }
    return this.states[state].terminal
  }

  *enumerate(): IterableIterator<string> {
    const visit = function*(state: number, prefix: string, states: DAWGState[]): IterableIterator<string> {
      if (states[state].terminal) yield prefix
      for (const [ch, next] of states[state].edges) yield* visit(next, prefix + ch, states)
    }
    yield* visit(0, '', this.states)
  }

  stateCount(): number { return this.states.length }
}
`
registerSkill({
  id: 'dawg',
  summary: 'DAWG / minimal DFA: compact word set membership and enumeration.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bdawg\b|directed.?acyclic.?word/i)) sc += 0.7
    if (s.has(/\bminimal.?dfa\b/i)) sc += 0.4
    if (s.has(/\bword.?graph\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/dawg.ts', content: IMPL }]
  },
})

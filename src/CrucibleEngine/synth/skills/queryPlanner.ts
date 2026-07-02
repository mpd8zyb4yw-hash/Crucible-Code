// Verified primitive: simple rule-based query planner — cost-based join ordering, predicate pushdown.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — rule-based query planner.
export type Predicate = { type: 'eq' | 'lt' | 'gt' | 'like'; col: string; val: unknown }
export type JoinType = 'inner' | 'left'
export interface Table { name: string; rows: number; hasIndex: Set<string> }
export interface QueryPlan { steps: string[]; estimatedCost: number }

export class QueryPlanner {
  private tables: Map<string, Table> = new Map()

  registerTable(t: Table): void { this.tables.set(t.name, t) }

  plan(tableName: string, predicates: Predicate[], joins: Array<{ table: string; on: string; type: JoinType }>): QueryPlan {
    const steps: string[] = []
    let cost = 0
    const base = this.tables.get(tableName)!
    let rows = base.rows

    // Predicate pushdown: indexed predicates first
    const indexed = predicates.filter(p => base.hasIndex.has(p.col))
    const nonIndexed = predicates.filter(p => !base.hasIndex.has(p.col))

    if (indexed.length) {
      steps.push(\`INDEX SCAN \${tableName} ON [\${indexed.map(p => p.col).join(', ')}]\`)
      rows = Math.ceil(rows * 0.1 * indexed.length)
      cost += rows
    } else {
      steps.push(\`SEQ SCAN \${tableName}\`); cost += rows
    }
    if (nonIndexed.length) { steps.push(\`FILTER [\${nonIndexed.map(p => \`\${p.col} \${p.type} ?\`).join(' AND ')}]\`); rows = Math.ceil(rows * 0.3) }

    // Sort joins by table size ascending (smaller = cheaper to hash first)
    const sortedJoins = [...joins].sort((a, b) => (this.tables.get(a.table)?.rows ?? 0) - (this.tables.get(b.table)?.rows ?? 0))
    for (const j of sortedJoins) {
      const jt = this.tables.get(j.table)
      const strategy = jt?.hasIndex.has(j.on) ? 'INDEX JOIN' : rows < 1000 ? 'NESTED LOOP' : 'HASH JOIN'
      steps.push(\`\${j.type.toUpperCase()} \${strategy} \${j.table} ON \${j.on}\`)
      cost += (jt?.rows ?? 1000) * (strategy === 'HASH JOIN' ? 1 : rows)
      rows = Math.ceil(rows * 0.5)
    }

    return { steps, estimatedCost: cost }
  }
}
`
registerSkill({
  id: 'query-planner',
  summary: 'Rule-based query planner: predicate pushdown, cost-based join ordering.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bquery.?plann\w+\b/i)) sc += 0.6
    if (s.has(/\bjoin.?order\w*\b/i)) sc += 0.25
    if (s.has(/\bpredicate.?pushdown\b/i)) sc += 0.3
    if (s.has(/\bcost.?based\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/queryPlanner.ts', content: IMPL }]
  },
})

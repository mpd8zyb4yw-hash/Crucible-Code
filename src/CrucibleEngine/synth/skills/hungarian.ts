import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Hungarian algorithm: O(n³) minimum-cost assignment.
export function hungarian(cost: number[][]): { assignment: number[]; totalCost: number } {
  const n = cost.length
  const u = new Array(n+1).fill(0), v = new Array(n+1).fill(0)
  const p = new Array(n+1).fill(0), way = new Array(n+1).fill(0)
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0
    const minv = new Array(n+1).fill(Infinity)
    const used = new Array(n+1).fill(false)
    do {
      used[j0] = true; let i0=p[j0], delta=Infinity, j1=-1
      for (let j=1;j<=n;j++) if(!used[j]){const cur=cost[i0-1][j-1]-u[i0]-v[j];if(cur<minv[j]){minv[j]=cur;way[j]=j0}if(minv[j]<delta){delta=minv[j];j1=j}}
      for (let j=0;j<=n;j++) if(used[j]){u[p[j]]+=delta;v[j]-=delta}else minv[j]-=delta
      j0=j1
    } while (p[j0] !== 0)
    do { const j1=way[j0]; p[j0]=p[j1]; j0=j1 } while (j0)
  }
  const assignment = new Array(n)
  for (let j=1;j<=n;j++) if(p[j]) assignment[p[j]-1]=j-1
  const totalCost = assignment.reduce((s,j,i)=>s+cost[i][j],0)
  return { assignment, totalCost }
}
`
registerSkill({
  id: 'hungarian',
  summary: 'Hungarian algorithm: O(n³) minimum-cost assignment problem.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bhungarian\b/i)) sc += 0.7
    if (s.has(/\bassignment.?problem\b/i)) sc += 0.35
    if (s.has(/\bmin.?cost.?match\b/i)) sc += 0.25
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/hungarian.ts', content: IMPL }]
  },
})

import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified merge sort (stable, O(n log n)).
export function mergeSort<T>(arr: T[], cmp: (a:T,b:T)=>number=(a,b)=>a<b?-1:a>b?1:0): T[] {
  if(arr.length<=1)return arr.slice()
  const mid=arr.length>>1
  const L=mergeSort(arr.slice(0,mid),cmp), R=mergeSort(arr.slice(mid),cmp)
  const res:T[]=[]; let i=0,j=0
  while(i<L.length&&j<R.length){if(cmp(L[i],R[j])<=0)res.push(L[i++]);else res.push(R[j++])}
  return res.concat(L.slice(i)).concat(R.slice(j))
}
export function mergeSortedArrays<T>(a: T[], b: T[], cmp: (x:T,y:T)=>number=(x,y)=>x<y?-1:x>y?1:0): T[] {
  const res:T[]=[]; let i=0,j=0
  while(i<a.length&&j<b.length){if(cmp(a[i],b[j])<=0)res.push(a[i++]);else res.push(b[j++])}
  return res.concat(a.slice(i)).concat(b.slice(j))
}
`
registerSkill({ id: 'merge-sort', summary: 'Stable merge sort and merge-sorted-arrays utility.',
  match(s: SpecFeatures) { let score = 0; if (s.has(/merge.?sort/i)) score += 0.7; if (s.has(/stable.?sort/i)) score += 0.3; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/mergeSort.ts', content: IMPL }] } })

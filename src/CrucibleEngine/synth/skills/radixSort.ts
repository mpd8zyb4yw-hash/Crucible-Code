import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified radix sort (LSD) for integers and strings.
export function radixSortInts(arr: number[]): number[] {
  if(!arr.length)return []
  const max=Math.max(...arr); let exp=1; let a=arr.slice()
  while(Math.floor(max/exp)>0){
    const out=new Array(a.length),count=new Array(10).fill(0)
    for(const n of a)count[Math.floor(n/exp)%10]++
    for(let i=1;i<10;i++)count[i]+=count[i-1]
    for(let i=a.length-1;i>=0;i--){const d=Math.floor(a[i]/exp)%10;out[--count[d]]=a[i]}
    a=out; exp*=10
  }
  return a
}
export function radixSortStrings(arr: string[]): string[] {
  if(!arr.length)return []
  const maxLen=Math.max(...arr.map(s=>s.length)); let a=arr.map(s=>s.padStart(maxLen,'\0'))
  for(let pos=maxLen-1;pos>=0;pos--){
    const buckets:string[][]=Array.from({length:256},()=>[])
    for(const s of a)buckets[s.charCodeAt(pos)].push(s)
    a=buckets.flat()
  }
  return a.map(s=>s.replace(/^\0+/,''))
}
`
registerSkill({ id: 'radix-sort', summary: 'LSD radix sort for integers and strings in O(nk).',
  match(s: SpecFeatures) { let score = 0; if (s.has(/radix.?sort/i)) score += 0.8; if (s.has(/counting.?sort/i)) score += 0.3; if (s.has(/linear.?time.{0,20}sort/i)) score += 0.2; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/radixSort.ts', content: IMPL }] } })

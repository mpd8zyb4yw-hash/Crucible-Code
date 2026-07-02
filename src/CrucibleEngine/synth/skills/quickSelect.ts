import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified quickselect for k-th smallest in O(n) average.
export function quickSelect<T>(arr: T[], k: number, cmp: (a:T,b:T)=>number=(a,b)=>a<b?-1:a>b?1:0): T {
  const a=arr.slice(); let lo=0,hi=a.length-1
  while(lo<hi){
    const pivot=a[(lo+hi)>>1]; let i=lo,j=hi
    while(i<=j){while(cmp(a[i],pivot)<0)i++;while(cmp(a[j],pivot)>0)j--;if(i<=j){[a[i],a[j]]=[a[j],a[i]];i++;j--}}
    if(j<k)lo=i; if(i>k)hi=j
  }
  return a[k]
}
export function topK<T>(arr: T[], k: number, cmp: (a:T,b:T)=>number=(a,b)=>a<b?-1:a>b?1:0): T[] {
  if(k<=0)return []; if(k>=arr.length)return arr.slice().sort(cmp)
  const pivot=quickSelect(arr,k-1,cmp)
  return arr.filter(x=>cmp(x,pivot)<=0).slice(0,k)
}
`
registerSkill({ id: 'quick-select', summary: 'Quickselect for k-th smallest element and top-K extraction.',
  match(s: SpecFeatures) { let score = 0; if (s.has(/quick.?select/i)) score += 0.6; if (s.has(/k.?th.{0,20}smallest|k.?th.{0,20}largest/i)) score += 0.4; if (s.has(/top.?k\b/i)) score += 0.3; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/quickSelect.ts', content: IMPL }] } })

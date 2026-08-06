import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Iterator / lazy sequence: map, filter, take, zip, flatten, chunk.
export function* map<T,U>(it:Iterable<T>,fn:(v:T)=>U):Generator<U>{for(const v of it)yield fn(v)}
export function* filter<T>(it:Iterable<T>,pred:(v:T)=>boolean):Generator<T>{for(const v of it)if(pred(v))yield v}
export function* take<T>(it:Iterable<T>,n:number):Generator<T>{let i=0;for(const v of it){if(i++>=n)break;yield v}}
export function* drop<T>(it:Iterable<T>,n:number):Generator<T>{let i=0;for(const v of it)if(i++>=n)yield v}
export function* zip<A,B>(a:Iterable<A>,b:Iterable<B>):Generator<[A,B]>{const ia=a[Symbol.iterator](),ib=b[Symbol.iterator]();while(true){const ra=ia.next(),rb=ib.next();if(ra.done||rb.done)break;yield[ra.value,rb.value]}}
export function* flatten<T>(it:Iterable<Iterable<T>>):Generator<T>{for(const sub of it)yield* sub}
export function* chunk<T>(it:Iterable<T>,size:number):Generator<T[]>{let buf:T[]=[];for(const v of it){buf.push(v);if(buf.length===size){yield buf;buf=[]}};if(buf.length)yield buf}
export function* range(start:number,end:number,step=1):Generator<number>{for(let i=start;i<end;i+=step)yield i}
export function collect<T>(it:Iterable<T>):T[]{return[...it]}
export function reduce<T,U>(it:Iterable<T>,fn:(acc:U,v:T)=>U,init:U):U{let acc=init;for(const v of it)acc=fn(acc,v);return acc}
`
registerSkill({
  id: 'iterator-pattern',
  summary: 'Lazy iterator utilities: map, filter, take, zip, flatten, chunk, range, reduce.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\blazy.?sequence\b|\blazy.?iterat\w+\b/i)) sc += 0.4
    if (s.has(/\biterator\b/i) && s.has(/\bmap\b/i) && s.has(/\bfilter\b/i)) sc += 0.3
    if (s.has(/\bgenerator\b/i) && s.has(/\bchunk\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/iterators.ts', content: IMPL }]
  },
})

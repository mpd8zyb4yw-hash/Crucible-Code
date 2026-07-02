import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified CRDT primitives: G-Set, 2P-Set, LWW-Register.
export class GSet<T> {
  private s = new Set<T>()
  add(v: T): void{this.s.add(v)}
  has(v: T): boolean{return this.s.has(v)}
  merge(other: GSet<T>): GSet<T>{const r=new GSet<T>();[...this.s,...other.s].forEach(v=>r.add(v));return r}
  toArray(): T[]{return[...this.s]}
}
export class TwoPSet<T> {
  private A=new GSet<T>(); private R=new GSet<T>()
  add(v:T):void{this.A.add(v)}
  remove(v:T):void{if(this.A.has(v))this.R.add(v)}
  has(v:T):boolean{return this.A.has(v)&&!this.R.has(v)}
  merge(other:TwoPSet<T>):TwoPSet<T>{const r=new TwoPSet<T>();r.A=this.A.merge(other.A);r.R=this.R.merge(other.R);return r}
}
export class LWWRegister<T> {
  private _val:T; private _ts:number
  constructor(init:T,ts=0){this._val=init;this._ts=ts}
  get value(){return this._val}
  set(v:T,ts:number):void{if(ts>=this._ts){this._val=v;this._ts=ts}}
  merge(other:LWWRegister<T>):LWWRegister<T>{return other._ts>=this._ts?new LWWRegister<T>(other._val,other._ts):new LWWRegister<T>(this._val,this._ts)}
}
`
registerSkill({ id: 'crdt', summary: 'CRDT primitives: G-Set, 2P-Set, and LWW-Register.',
  match(s: SpecFeatures) { let score = 0; if (s.has(/\bcrdt\b/i)) score += 0.8; if (s.has(/conflict.?free/i)) score += 0.5; if (s.has(/lww.?register|g.?set|2p.?set/i)) score += 0.5; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/crdt.ts', content: IMPL }] } })

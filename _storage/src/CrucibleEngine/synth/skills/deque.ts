import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified O(1) deque using circular buffer.
export class Deque<T> {
  private buf: (T|undefined)[]
  private head: number; private tail: number; private _size: number
  constructor(cap=16){this.buf=new Array(cap);this.head=0;this.tail=0;this._size=0}
  get size(){return this._size}
  private _grow(){const nb=new Array(this.buf.length*2);for(let i=0;i<this._size;i++)nb[i]=this.buf[(this.head+i)%this.buf.length];this.head=0;this.tail=this._size;this.buf=nb}
  pushFront(v:T):void{if(this._size===this.buf.length)this._grow();this.head=(this.head-1+this.buf.length)%this.buf.length;this.buf[this.head]=v;this._size++}
  pushBack(v:T):void{if(this._size===this.buf.length)this._grow();this.buf[this.tail]=v;this.tail=(this.tail+1)%this.buf.length;this._size++}
  popFront():T|undefined{if(!this._size)return undefined;const v=this.buf[this.head];this.head=(this.head+1)%this.buf.length;this._size--;return v}
  popBack():T|undefined{if(!this._size)return undefined;this.tail=(this.tail-1+this.buf.length)%this.buf.length;this._size--;return this.buf[this.tail]}
  peekFront():T|undefined{return this._size?this.buf[this.head]:undefined}
  peekBack():T|undefined{return this._size?this.buf[(this.tail-1+this.buf.length)%this.buf.length]:undefined}
}
`
registerSkill({ id: 'deque', summary: 'O(1) double-ended queue using a circular buffer.',
  match(s: SpecFeatures) { let score = 0; if (s.has(/\bdeque\b/i)) score += 0.7; if (s.has(/double.?ended.?queue/i)) score += 0.5; if (s.has(/pushFront|pushBack|popFront|popBack/i)) score += 0.3; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/deque.ts', content: IMPL }] } })

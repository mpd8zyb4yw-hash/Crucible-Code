import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified persistent/immutable stack.
interface SNode<T>{val:T;next:SNode<T>|null}
export class ImmutableStack<T>{
  private constructor(private head:SNode<T>|null,public readonly size:number){}
  static empty<T>():ImmutableStack<T>{return new ImmutableStack<T>(null,0)}
  push(val:T):ImmutableStack<T>{return new ImmutableStack<T>({val,next:this.head},this.size+1)}
  pop():[T,ImmutableStack<T>]{if(!this.head)throw new Error('empty');return[this.head.val,new ImmutableStack<T>(this.head.next,this.size-1)]}
  peek():T{if(!this.head)throw new Error('empty');return this.head.val}
  get isEmpty(){return this.size===0}
  toArray():T[]{const r:T[]=[]; let n=this.head;while(n){r.push(n.val);n=n.next}return r}
}
`
registerSkill({ id: 'immutable-stack', summary: 'Persistent/immutable stack with structural sharing.',
  match(s: SpecFeatures) { let score = 0; if (s.has(/immutable.?stack|persistent.?stack/i)) score += 0.8; if (s.has(/functional.{0,20}stack/i)) score += 0.4; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/immutableStack.ts', content: IMPL }] } })

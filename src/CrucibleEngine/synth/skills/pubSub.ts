import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified pub/sub message bus with wildcard topics.
export class PubSub<T extends Record<string,unknown>=Record<string,unknown>> {
  private subs=new Map<string,Set<(data:unknown)=>void>>()
  subscribe<K extends keyof T>(topic:K,fn:(data:T[K])=>void):()=>void{
    const k=String(topic); if(!this.subs.has(k))this.subs.set(k,new Set())
    this.subs.get(k)!.add(fn as any); return()=>this.subs.get(k)?.delete(fn as any)
  }
  publish<K extends keyof T>(topic:K,data:T[K]):number{
    let count=0; const k=String(topic)
    this.subs.get(k)?.forEach(fn=>{fn(data);count++})
    if(k.includes('.')){const parts=k.split('.');for(let i=1;i<=parts.length;i++){const wk=parts.slice(0,i).join('.')+'.*';this.subs.get(wk)?.forEach(fn=>{fn(data);count++})}}
    return count
  }
  clear(topic?:keyof T):void{topic?this.subs.delete(String(topic)):this.subs.clear()}
}
`
registerSkill({ id: 'pubsub', summary: 'Typed pub/sub message bus with wildcard topic support.',
  match(s: SpecFeatures) { let score = 0; if (s.has(/pub.?sub|message.?bus/i)) score += 0.7; if (s.has(/publish|subscribe/i)) score += 0.2; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/pubSub.ts', content: IMPL }] } })

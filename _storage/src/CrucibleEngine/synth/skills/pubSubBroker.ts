import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Pub/Sub broker: topics, wildcards, dead-letter queue, replay.
export interface Message<T=unknown>{topic:string;payload:T;ts:number;id:string}
type Handler<T>=((msg:Message<T>)=>void|Promise<void>)
export class PubSubBroker{
  private subs=new Map<string,Set<Handler<unknown>>>()
  private history:Message<unknown>[]=[]
  private maxHistory:number
  private dlq:Message<unknown>[]=[]
  constructor(maxHistory=200){this.maxHistory=maxHistory}
  subscribe<T>(pattern:string,handler:Handler<T>):()=>void{
    if(!this.subs.has(pattern))this.subs.set(pattern,new Set())
    this.subs.get(pattern)!.add(handler as Handler<unknown>)
    return()=>this.subs.get(pattern)?.delete(handler as Handler<unknown>)
  }
  async publish<T>(topic:string,payload:T):Promise<void>{
    const msg:Message<T>={topic,payload,ts:Date.now(),id:Math.random().toString(36).slice(2)}
    this.history.push(msg as Message<unknown>);if(this.history.length>this.maxHistory)this.history.shift()
    let delivered=false
    for(const[pat,handlers]of this.subs){
      if(this._match(pat,topic)){for(const h of handlers){try{await h(msg as Message<unknown>);delivered=true}catch(e){this.dlq.push(msg as Message<unknown>)}}}
    }
    if(!delivered)this.dlq.push(msg as Message<unknown>)
  }
  replay(topic:string,since=0):Message<unknown>[]{return this.history.filter(m=>m.topic===topic&&m.ts>=since)}
  deadLetters():Message<unknown>[]{return[...this.dlq]}
  private _match(pattern:string,topic:string):boolean{
    if(pattern===topic||pattern==='*')return true
    const pp=pattern.split('.'),tp=topic.split('.')
    if(pp.length!==tp.length&&!pp.includes('**'))return false
    return pp.every((p,i)=>p==='*'||p==='**'||p===tp[i])
  }
}
`
registerSkill({
  id: 'pubsub-broker',
  summary: 'Pub/Sub broker: topics, wildcard patterns, dead-letter queue, history replay.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bpub.?sub.?broker\b/i)) sc += 0.6
    if (s.has(/\bdead.?letter\b/i)) sc += 0.3
    if (s.has(/\bwildcard\b/i) && s.has(/\btopic\b/i)) sc += 0.2
    if (s.has(/\breplay\b/i) && s.has(/\bpub.?sub\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/pubSubBroker.ts', content: IMPL }]
  },
})

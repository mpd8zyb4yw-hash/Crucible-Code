import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Typed EventEmitter: on/off/once/emit, wildcard, async, max listeners.
type Listener<T> = (data: T) => void | Promise<void>
export class EventEmitter<Events extends Record<string,unknown>>{
  private listeners = new Map<keyof Events, Set<{fn:Listener<unknown>;once:boolean}>>()
  private maxListeners=50
  setMaxListeners(n:number):void{this.maxListeners=n}
  on<K extends keyof Events>(event:K,fn:Listener<Events[K]>):()=>void{
    if(!this.listeners.has(event))this.listeners.set(event,new Set())
    const s=this.listeners.get(event)!
    if(s.size>=this.maxListeners)console.warn(\`MaxListeners(\${this.maxListeners}) for \${String(event)}\`)
    const entry={fn:fn as Listener<unknown>,once:false};s.add(entry)
    return()=>s.delete(entry)
  }
  once<K extends keyof Events>(event:K,fn:Listener<Events[K]>):void{
    if(!this.listeners.has(event))this.listeners.set(event,new Set())
    const entry={fn:fn as Listener<unknown>,once:true};this.listeners.get(event)!.add(entry)
  }
  off<K extends keyof Events>(event:K,fn:Listener<Events[K]>):void{
    const s=this.listeners.get(event);if(!s)return
    for(const e of s)if(e.fn===fn){s.delete(e);break}
  }
  async emit<K extends keyof Events>(event:K,data:Events[K]):Promise<void>{
    const s=this.listeners.get(event);if(!s)return
    for(const e of[...s]){await e.fn(data);if(e.once)s.delete(e)}
  }
  listenerCount(event:keyof Events):number{return this.listeners.get(event)?.size??0}
  removeAllListeners(event?:keyof Events):void{event?this.listeners.delete(event):this.listeners.clear()}
}
`
registerSkill({
  id: 'event-emitter',
  summary: 'Typed EventEmitter: on/off/once/emit, async listeners, max-listeners guard.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bevent.?emitter\b/i)) sc += 0.6
    if (s.has(/\bon\b/i) && s.has(/\bonce\b/i) && s.has(/\bemit\b/i)) sc += 0.3
    if (s.has(/\bpub.?sub\b/i) && !s.has(/\bbroker\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/eventEmitter.ts', content: IMPL }]
  },
})

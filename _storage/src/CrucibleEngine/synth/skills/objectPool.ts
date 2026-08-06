import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified object pool to reduce GC pressure.
export class ObjectPool<T> {
  private pool: T[] = []
  private _created = 0; private _reused = 0
  constructor(private factory: ()=>T, private reset?: (obj:T)=>void, private maxSize=100) {}
  acquire(): T {
    if(this.pool.length){this._reused++;const obj=this.pool.pop()!;return obj}
    this._created++; return this.factory()
  }
  release(obj: T): void { if(this.pool.length<this.maxSize){this.reset?.(obj);this.pool.push(obj)} }
  get stats(){return{created:this._created,reused:this._reused,available:this.pool.length}}
  drain(): void { this.pool.length=0 }
}
`
registerSkill({ id: 'object-pool', summary: 'Object pool for reusing expensive-to-create objects and reducing GC pressure.',
  match(s: SpecFeatures) { let score = 0; if (s.has(/object.?pool/i)) score += 0.8; if (s.has(/pool.{0,30}reuse|reuse.{0,30}pool/i)) score += 0.4; if (s.has(/gc.?pressure|garbage.?collect/i)) score += 0.2; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/objectPool.ts', content: IMPL }] } })

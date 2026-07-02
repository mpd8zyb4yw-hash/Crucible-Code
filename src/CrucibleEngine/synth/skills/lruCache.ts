import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified LRU cache with O(1) get/put.
class DLNode<K,V> { prev: DLNode<K,V>|null=null; next: DLNode<K,V>|null=null; constructor(public key:K,public val:V){} }
export class LRUCache<K,V> {
  private map = new Map<K,DLNode<K,V>>()
  private head: DLNode<K,V>
  private tail: DLNode<K,V>
  constructor(private capacity: number) { this.head=new DLNode<K,V>(null as any,null as any); this.tail=new DLNode<K,V>(null as any,null as any); this.head.next=this.tail; this.tail.prev=this.head }
  get(key: K): V|undefined { const n=this.map.get(key); if(!n)return undefined; this._rm(n); this._addFront(n); return n.val }
  put(key: K, val: V): void {
    if(this.map.has(key)){const n=this.map.get(key)!;n.val=val;this._rm(n);this._addFront(n);return}
    const n=new DLNode(key,val); this.map.set(key,n); this._addFront(n)
    if(this.map.size>this.capacity){const lru=this.tail.prev!;this._rm(lru);this.map.delete(lru.key)}
  }
  get size(){return this.map.size}
  private _rm(n:DLNode<K,V>){n.prev!.next=n.next;n.next!.prev=n.prev}
  private _addFront(n:DLNode<K,V>){n.next=this.head.next;n.prev=this.head;this.head.next!.prev=n;this.head.next=n}
}
`
registerSkill({ id: 'lru-cache', summary: 'LRU cache with O(1) get and put using doubly-linked list + hash map.',
  match(s: SpecFeatures) { let score = 0; if (s.has(/\blru\b/i)) score += 0.5; if (s.has(/lru.?cache/i)) score += 0.4; if (s.has(/least.?recently.?used/i)) score += 0.4; if (s.has(/evict/i)) score += 0.1; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/lruCache.ts', content: IMPL }] } })

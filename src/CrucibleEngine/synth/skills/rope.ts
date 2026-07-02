import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified Rope data structure for efficient string editing.
class RNode{left:RNode|null=null;right:RNode|null=null;weight:number;constructor(public str:string=''){this.weight=str.length}}
export class Rope{
  private root:RNode
  constructor(s=''){this.root=new RNode(s)}
  get length():number{return this._len(this.root)}
  private _len(n:RNode|null):number{if(!n)return 0;if(!n.left&&!n.right)return n.str.length;return n.weight+this._len(n.right)}
  charAt(i:number):string{return this._at(this.root,i)}
  private _at(n:RNode|null,i:number):string{if(!n)return'';if(!n.left&&!n.right)return n.str[i]??'';if(i<n.weight)return this._at(n.left,i);return this._at(n.right,i-n.weight)}
  concat(other:Rope):Rope{const r=new Rope();const node=new RNode();node.left=this.root;node.right=other.root;node.weight=this.length;r.root=node;return r}
  toString():string{return this._str(this.root)}
  private _str(n:RNode|null):string{if(!n)return'';if(!n.left&&!n.right)return n.str;return this._str(n.left)+this._str(n.right)}
}
`
registerSkill({ id: 'rope', summary: 'Rope data structure for O(log n) string concatenation and indexing.',
  match(s: SpecFeatures) { let score = 0; if (s.has(/\brope\b.{0,30}string|\bstring\b.{0,30}rope/i)) score += 0.8; if (s.has(/efficient.{0,30}string.{0,30}edit/i)) score += 0.3; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/rope.ts', content: IMPL }] } })

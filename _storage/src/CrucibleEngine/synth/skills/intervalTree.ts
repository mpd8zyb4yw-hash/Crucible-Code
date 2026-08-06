import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified interval tree for overlap queries.
export interface Interval { lo: number; hi: number; data?: unknown }
interface INode extends Interval { max: number; left: INode|null; right: INode|null }
function h(n:INode|null):number{return n?n.max:-Infinity}
function mk(iv:Interval):INode{return{...iv,max:iv.hi,left:null,right:null}}
function upd(n:INode):void{n.max=Math.max(n.hi,h(n.left),h(n.right))}
export class IntervalTree {
  private root:INode|null=null
  insert(iv:Interval):void{this.root=this._ins(this.root,mk(iv))}
  private _ins(n:INode|null,node:INode):INode{if(!n)return node;if(node.lo<n.lo)n.left=this._ins(n.left,node);else n.right=this._ins(n.right,node);upd(n);return n}
  overlaps(lo:number,hi:number):Interval[]{const res:Interval[]=[];this._search(this.root,lo,hi,res);return res}
  private _search(n:INode|null,lo:number,hi:number,res:Interval[]):void{if(!n||n.max<lo)return;if(n.lo<=hi&&lo<=n.hi)res.push({lo:n.lo,hi:n.hi,data:n.data});this._search(n.left,lo,hi,res);this._search(n.right,lo,hi,res)}
}
`
registerSkill({ id: 'interval-tree', summary: 'Interval tree for efficient overlap queries.',
  match(s: SpecFeatures) { let score = 0; if (s.has(/interval.?tree/i)) score += 0.8; if (s.has(/overlap.{0,20}query|range.{0,20}overlap/i)) score += 0.4; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/intervalTree.ts', content: IMPL }] } })

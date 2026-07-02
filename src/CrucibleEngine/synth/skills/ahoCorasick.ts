import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Aho-Corasick: multi-pattern string search in O(n + sum|patterns| + matches).
interface ACNode{ch:Map<string,number>;fail:number;out:string[]}
export class AhoCorasick{
  private nodes:ACNode[]=[{ch:new Map(),fail:0,out:[]}]
  addPattern(p:string):void{
    let s=0
    for(const c of p){if(!this.nodes[s].ch.has(c)){this.nodes.push({ch:new Map(),fail:0,out:[]});this.nodes[s].ch.set(c,this.nodes.length-1)}s=this.nodes[s].ch.get(c)!}
    this.nodes[s].out.push(p)
  }
  build():void{
    const q:number[]=[]
    for(const[,v]of this.nodes[0].ch){this.nodes[v].fail=0;q.push(v)}
    while(q.length){
      const u=q.shift()!
      for(const[c,v]of this.nodes[u].ch){let f=this.nodes[u].fail;while(f&&!this.nodes[f].ch.has(c))f=this.nodes[f].fail;this.nodes[v].fail=this.nodes[f].ch.get(c)??0;if(this.nodes[v].fail===v)this.nodes[v].fail=0;this.nodes[v].out=[...this.nodes[v].out,...this.nodes[this.nodes[v].fail].out];q.push(v)}
    }
  }
  search(text:string):Array<{pos:number;pattern:string}>{
    const res:Array<{pos:number;pattern:string}>=[];let s=0
    for(let i=0;i<text.length;i++){
      const c=text[i];while(s&&!this.nodes[s].ch.has(c))s=this.nodes[s].fail;s=this.nodes[s].ch.get(c)??0
      for(const p of this.nodes[s].out)res.push({pos:i-p.length+1,pattern:p})
    }
    return res
  }
}
`
registerSkill({
  id: 'aho-corasick',
  summary: 'Aho-Corasick: multi-pattern string search with failure links.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\baho.?corasick\b/i)) sc += 0.7
    if (s.has(/\bmulti.?pattern\b/i) && s.has(/\bsearch\b/i)) sc += 0.3
    if (s.has(/\bfailure.?link\b/i)) sc += 0.25
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/ahoCorasick.ts', content: IMPL }]
  },
})

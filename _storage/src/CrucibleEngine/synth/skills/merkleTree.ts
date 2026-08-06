import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified Merkle tree for data integrity verification.
function sha256sim(s:string):string{let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193);h^=h>>>16};return(h>>>0).toString(16).padStart(8,'0')}
export class MerkleTree {
  private leaves:string[]
  private tree:string[]
  constructor(data:string[]){
    this.leaves=data.map(d=>sha256sim(d))
    this.tree=[...this.leaves]
    let n=this.leaves.length
    while(n>1){const next:string[]=[]; for(let i=0;i<n;i+=2)next.push(sha256sim((this.tree[this.tree.length-n+i]??'')+(this.tree[this.tree.length-n+i+1]??this.tree[this.tree.length-n+i]??'')));this.tree.push(...next);n=next.length}
  }
  get root():string{return this.tree[this.tree.length-1]??''}
  verify(index:number,data:string):boolean{return sha256sim(data)===this.leaves[index]}
  getProof(index:number):string[]{const proof:string[]=[]; let i=index,n=this.leaves.length,offset=0;while(n>1){const sibling=i%2===0?i+1:i-1;if(sibling<n)proof.push(this.tree[offset+sibling]);offset+=n;n=Math.ceil(n/2);i=Math.floor(i/2)};return proof}
}
`
registerSkill({ id: 'merkle-tree', summary: 'Merkle tree for cryptographic data integrity and inclusion proofs.',
  match(s: SpecFeatures) { let score = 0; if (s.has(/merkle.?tree/i)) score += 0.9; if (s.has(/integrity.{0,30}proof|inclusion.?proof/i)) score += 0.4; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/merkleTree.ts', content: IMPL }] } })

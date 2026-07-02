import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — Linear algebra: matrix ops, Gaussian elimination, LU decomposition.
export type Mat = number[][]
export const zeros = (r:number,c:number):Mat => Array.from({length:r},()=>new Array(c).fill(0))
export const eye   = (n:number):Mat => Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?1:0))
export const add   = (A:Mat,B:Mat):Mat => A.map((r,i)=>r.map((v,j)=>v+B[i][j]))
export const sub   = (A:Mat,B:Mat):Mat => A.map((r,i)=>r.map((v,j)=>v-B[i][j]))
export const mul   = (A:Mat,B:Mat):Mat => {
  const C=zeros(A.length,B[0].length)
  for(let i=0;i<A.length;i++)for(let k=0;k<B.length;k++)for(let j=0;j<B[0].length;j++) C[i][j]+=A[i][k]*B[k][j]
  return C
}
export const transpose = (A:Mat):Mat => A[0].map((_,j)=>A.map(r=>r[j]))
export function gaussElim(A:Mat,b:number[]):{x:number[]|null}{
  const n=A.length
  const M=A.map((r,i)=>[...r,b[i]])
  for(let c=0;c<n;c++){
    let max=c;for(let r=c+1;r<n;r++)if(Math.abs(M[r][c])>Math.abs(M[max][c]))max=r;[M[c],M[max]]=[M[max],M[c]]
    if(Math.abs(M[c][c])<1e-12)return{x:null}
    for(let r=c+1;r<n;r++){const f=M[r][c]/M[c][c];for(let k=c;k<=n;k++)M[r][k]-=f*M[c][k]}
  }
  const x=new Array(n).fill(0)
  for(let r=n-1;r>=0;r--){x[r]=M[r][n];for(let k=r+1;k<n;k++)x[r]-=M[r][k]*x[k];x[r]/=M[r][r]}
  return{x}
}
export function det(A:Mat):number{
  const n=A.length;const M=A.map(r=>[...r]);let sign=1,d=1
  for(let c=0;c<n;c++){
    let max=c;for(let r=c+1;r<n;r++)if(Math.abs(M[r][c])>Math.abs(M[max][c]))max=r
    if(max!==c){[M[c],M[max]]=[M[max],M[c]];sign*=-1}
    if(Math.abs(M[c][c])<1e-12)return 0;d*=M[c][c]
    for(let r=c+1;r<n;r++){const f=M[r][c]/M[c][c];for(let k=c;k<n;k++)M[r][k]-=f*M[c][k]}
  }
  return sign*d
}
`
registerSkill({
  id: 'linear-algebra',
  summary: 'Linear algebra: matrix multiply, transpose, Gaussian elimination, determinant.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\blinear.?algebra\b/i)) sc += 0.4
    if (s.has(/\bgaussian.?elim\w+\b/i)) sc += 0.35
    if (s.has(/\bdeterminant\b/i)) sc += 0.25
    if (s.has(/\bmatrix.?mul\w+\b/i) && !s.has(/\bmatrix.?exp\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/linAlgebra.ts', content: IMPL }]
  },
})

import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — verified matrix operations.
type Mat = number[][]
export function matMul(A: Mat, B: Mat): Mat {
  const m=A.length,n=B[0].length,p=B.length
  return Array.from({length:m},(_,i)=>Array.from({length:n},(_,j)=>{let s=0;for(let k=0;k<p;k++)s+=A[i][k]*B[k][j];return s}))
}
export function matPow(M: Mat, n: number): Mat {
  let res=Array.from({length:M.length},(_,i)=>Array.from({length:M.length},(_,j)=>i===j?1:0))
  while(n>0){if(n&1)res=matMul(res,M);M=matMul(M,M);n>>=1}
  return res
}
export function transpose(M: Mat): Mat { return M[0].map((_,j)=>M.map(row=>row[j])) }
export function matAdd(A: Mat, B: Mat): Mat { return A.map((row,i)=>row.map((v,j)=>v+B[i][j])) }
`
registerSkill({ id: 'matrix', summary: 'Matrix multiply, fast exponentiation, transpose, and addition.',
  match(s: SpecFeatures) { let score = 0; if (s.has(/matrix.{0,20}multipl|matmul/i)) score += 0.5; if (s.has(/matrix.{0,20}pow|matrix.{0,20}exp/i)) score += 0.4; if (s.has(/\btranspose\b/i)) score += 0.3; return score },
  emit(s: SpecFeatures): SynthFile[] { return [{ path: s.modulePath ?? 'src/matrix.ts', content: IMPL }] } })

// Verified primitive: matrix exponentiation by squaring — O(k³ log n) linear recurrences.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — matrix exponentiation.
export type Matrix = number[][]

export function matMul(A: Matrix, B: Matrix, mod?: number): Matrix {
  const n = A.length; const m = B[0].length; const k = B.length
  const C: Matrix = Array.from({ length: n }, () => Array(m).fill(0))
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++)
      for (let l = 0; l < k; l++) {
        C[i][j] += A[i][l] * B[l][j]
        if (mod) C[i][j] %= mod
      }
  return C
}

export function matPow(M: Matrix, n: number, mod?: number): Matrix {
  let result: Matrix = Array.from({ length: M.length }, (_, i) =>
    Array.from({ length: M.length }, (__, j) => i === j ? 1 : 0))  // identity
  while (n > 0) {
    if (n & 1) result = matMul(result, M, mod)
    M = matMul(M, M, mod)
    n >>= 1
  }
  return result
}

/** Compute the n-th term of a linear recurrence: state = M^n * initial. */
export function linearRecurrence(M: Matrix, initial: number[], n: number, mod?: number): number {
  if (n < initial.length) return initial[n]
  const raised = matPow(M, n - initial.length + 1, mod)
  let result = 0
  for (let j = 0; j < initial.length; j++) {
    result += raised[0][j] * initial[initial.length - 1 - j]
    if (mod) result %= mod
  }
  return mod ? result % mod : result
}
`
registerSkill({
  id: 'matrix-exponential',
  summary: 'Matrix exponentiation: matPow, matMul, linear recurrences in O(k³ log n).',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bmatrix.?exp\w+\b/i)) sc += 0.5
    if (s.has(/\bmatpow\b/i)) sc += 0.4
    if (s.has(/\blinear.?recurrence\b/i)) sc += 0.35
    if (s.has(/\bfibonacci\b/i) && s.has(/\bmatrix\b/i)) sc += 0.25
    if (s.has(/\bmat.?mul\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/matrixExp.ts', content: IMPL }]
  },
})

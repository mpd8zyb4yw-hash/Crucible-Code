// Inline author for the bitMatrixB family. Run: npx tsx _author_bits.ts
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

interface Entry {
  id: string; filename: string; summary: string; defaultPath: string
  exports: string[]; patterns: { re: string; weight: number }[]; impl: string
  tests: { desc: string; call: string; want: string }[]
}

const entries: Entry[] = [
  {
    id: 'hamming-distance', filename: 'hammingDistance',
    summary: 'hammingDistance returns the number of differing bits between two non-negative integers.',
    defaultPath: 'src/hammingDistance.ts', exports: ['hammingDistance'],
    patterns: [{ re: '\\bhammingDistance\\b', weight: 0.6 }, { re: 'hamming distance|differing bits|bit difference', weight: 0.3 }],
    impl: `export function hammingDistance(a: number, b: number): number {
  let x = (a ^ b) >>> 0, c = 0
  while (x) { c += x & 1; x >>>= 1 }
  return c
}`,
    tests: [
      { desc: '1 vs 4', call: 'hammingDistance(1,4)', want: '2' },
      { desc: 'zero', call: 'hammingDistance(0,0)', want: '0' },
      { desc: '7 vs 0', call: 'hammingDistance(7,0)', want: '3' },
      { desc: 'equal', call: 'hammingDistance(5,5)', want: '0' },
      { desc: 'one bit', call: 'hammingDistance(1,0)', want: '1' },
      { desc: 'byte', call: 'hammingDistance(255,0)', want: '8' },
    ],
  },
  {
    id: 'reverse-bits-32', filename: 'reverseBits32',
    summary: 'reverseBits32 reverses the 32 bits of an unsigned integer and returns an unsigned result.',
    defaultPath: 'src/reverseBits32.ts', exports: ['reverseBits32'],
    patterns: [{ re: '\\breverseBits32\\b', weight: 0.6 }, { re: 'reverse.*bits|bit.*reversal', weight: 0.3 }],
    impl: `export function reverseBits32(n: number): number {
  let r = 0
  for (let i = 0; i < 32; i++) r = r * 2 + ((n >>> i) & 1)
  return r >>> 0
}`,
    tests: [
      { desc: 'one to high bit', call: 'reverseBits32(1)', want: '2147483648' },
      { desc: 'zero', call: 'reverseBits32(0)', want: '0' },
      { desc: 'high bit to one', call: 'reverseBits32(2147483648)', want: '1' },
      { desc: 'all ones', call: 'reverseBits32(4294967295)', want: '4294967295' },
      { desc: 'involution', call: 'reverseBits32(reverseBits32(12345))', want: '12345' },
    ],
  },
  {
    id: 'next-power-of-two', filename: 'nextPowerOfTwo',
    summary: 'nextPowerOfTwo returns the smallest power of two greater than or equal to n (1 for n<=1).',
    defaultPath: 'src/nextPowerOfTwo.ts', exports: ['nextPowerOfTwo'],
    patterns: [{ re: '\\bnextPowerOfTwo\\b', weight: 0.6 }, { re: 'power of two|next power', weight: 0.3 }],
    impl: `export function nextPowerOfTwo(n: number): number {
  if (n <= 1) return 1
  let p = 1
  while (p < n) p *= 2
  return p
}`,
    tests: [
      { desc: 'five', call: 'nextPowerOfTwo(5)', want: '8' },
      { desc: 'exact', call: 'nextPowerOfTwo(16)', want: '16' },
      { desc: 'just over', call: 'nextPowerOfTwo(17)', want: '32' },
      { desc: 'zero', call: 'nextPowerOfTwo(0)', want: '1' },
      { desc: 'one', call: 'nextPowerOfTwo(1)', want: '1' },
      { desc: 'large', call: 'nextPowerOfTwo(1023)', want: '1024' },
    ],
  },
  {
    id: 'count-leading-zeros-32', filename: 'countLeadingZeros32',
    summary: 'countLeadingZeros32 returns the number of leading zero bits in the 32-bit representation of n (32 for zero).',
    defaultPath: 'src/countLeadingZeros32.ts', exports: ['countLeadingZeros32'],
    patterns: [{ re: '\\bcountLeadingZeros32\\b', weight: 0.6 }, { re: 'leading zero|count.*zeros', weight: 0.3 }],
    impl: `export function countLeadingZeros32(n: number): number {
  return n === 0 ? 32 : Math.clz32(n)
}`,
    tests: [
      { desc: 'one', call: 'countLeadingZeros32(1)', want: '31' },
      { desc: 'zero', call: 'countLeadingZeros32(0)', want: '32' },
      { desc: 'all ones', call: 'countLeadingZeros32(4294967295)', want: '0' },
      { desc: 'high bit', call: 'countLeadingZeros32(2147483648)', want: '0' },
      { desc: '256', call: 'countLeadingZeros32(256)', want: '23' },
      { desc: '16', call: 'countLeadingZeros32(16)', want: '27' },
    ],
  },
  {
    id: 'gray-code', filename: 'grayCode',
    summary: 'grayEncode converts a binary number to Gray code and grayDecode converts it back; they are inverses.',
    defaultPath: 'src/grayCode.ts', exports: ['grayEncode', 'grayDecode'],
    patterns: [{ re: '\\bgrayEncode\\b|\\bgrayDecode\\b', weight: 0.6 }, { re: 'gray code', weight: 0.35 }],
    impl: `export function grayEncode(n: number): number {
  return (n ^ (n >>> 1)) >>> 0
}

export function grayDecode(g: number): number {
  let n = g
  while (g > 0) { g = g >>> 1; n ^= g }
  return n >>> 0
}`,
    tests: [
      { desc: 'encode 0', call: 'grayEncode(0)', want: '0' },
      { desc: 'encode 2', call: 'grayEncode(2)', want: '3' },
      { desc: 'encode 3', call: 'grayEncode(3)', want: '2' },
      { desc: 'encode 4', call: 'grayEncode(4)', want: '6' },
      { desc: 'decode 6', call: 'grayDecode(6)', want: '4' },
      { desc: 'decode 2', call: 'grayDecode(2)', want: '3' },
      { desc: 'roundtrip', call: 'grayDecode(grayEncode(42))', want: '42' },
    ],
  },
  {
    id: 'matrix-multiply', filename: 'matrixMultiply',
    summary: 'matrixMultiply returns the product of two conformable numeric matrices.',
    defaultPath: 'src/matrixMultiply.ts', exports: ['matrixMultiply'],
    patterns: [{ re: '\\bmatrixMultiply\\b', weight: 0.6 }, { re: 'matrix.*multipl|matrix product', weight: 0.3 }],
    impl: `export function matrixMultiply(a: number[][], b: number[][]): number[][] {
  const n = a.length, k = b.length, m = b[0]?.length ?? 0
  const res = Array.from({ length: n }, () => new Array(m).fill(0))
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      let s = 0
      for (let x = 0; x < k; x++) s += a[i][x] * b[x][j]
      res[i][j] = s
    }
  return res
}`,
    tests: [
      { desc: '2x2', call: 'matrixMultiply([[1,2],[3,4]],[[5,6],[7,8]])', want: '[[19,22],[43,50]]' },
      { desc: 'identity', call: 'matrixMultiply([[1,2],[3,4]],[[1,0],[0,1]])', want: '[[1,2],[3,4]]' },
      { desc: 'row by col', call: 'matrixMultiply([[1,2]],[[3],[4]])', want: '[[11]]' },
      { desc: 'rectangular', call: 'matrixMultiply([[1,2,3]],[[1],[1],[1]])', want: '[[6]]' },
    ],
  },
  {
    id: 'matrix-transpose', filename: 'matrixTranspose',
    summary: 'matrixTranspose returns the transpose of a numeric matrix, handling non-square and empty inputs.',
    defaultPath: 'src/matrixTranspose.ts', exports: ['matrixTranspose'],
    patterns: [{ re: '\\bmatrixTranspose\\b', weight: 0.6 }, { re: 'transpose', weight: 0.35 }],
    impl: `export function matrixTranspose(m: number[][]): number[][] {
  if (!m.length) return []
  return m[0].map((_, c) => m.map(row => row[c]))
}`,
    tests: [
      { desc: '2x3', call: 'matrixTranspose([[1,2,3],[4,5,6]])', want: '[[1,4],[2,5],[3,6]]' },
      { desc: 'empty', call: 'matrixTranspose([])', want: '[]' },
      { desc: 'single', call: 'matrixTranspose([[1]])', want: '[[1]]' },
      { desc: 'square', call: 'matrixTranspose([[1,2],[3,4]])', want: '[[1,3],[2,4]]' },
      { desc: 'column', call: 'matrixTranspose([[1],[2],[3]])', want: '[[1,2,3]]' },
    ],
  },
  {
    id: 'matrix-determinant', filename: 'matrixDeterminant',
    summary: 'matrixDeterminant computes the determinant of a square numeric matrix via cofactor expansion.',
    defaultPath: 'src/matrixDeterminant.ts', exports: ['matrixDeterminant'],
    patterns: [{ re: '\\bmatrixDeterminant\\b', weight: 0.6 }, { re: 'determinant', weight: 0.35 }],
    impl: `export function matrixDeterminant(m: number[][]): number {
  const n = m.length
  if (n === 0) return 1
  if (n === 1) return m[0][0]
  if (n === 2) return m[0][0] * m[1][1] - m[0][1] * m[1][0]
  let det = 0
  for (let c = 0; c < n; c++) {
    const minor = m.slice(1).map(row => row.filter((_, j) => j !== c))
    det += (c % 2 ? -1 : 1) * m[0][c] * matrixDeterminant(minor)
  }
  return det
}`,
    tests: [
      { desc: '2x2', call: 'matrixDeterminant([[1,2],[3,4]])', want: '-2' },
      { desc: '1x1', call: 'matrixDeterminant([[5]])', want: '5' },
      { desc: 'identity 3x3', call: 'matrixDeterminant([[1,0,0],[0,1,0],[0,0,1]])', want: '1' },
      { desc: '3x3', call: 'matrixDeterminant([[6,1,1],[4,-2,5],[2,8,7]])', want: '-306' },
      { desc: 'singular', call: 'matrixDeterminant([[1,2],[2,4]])', want: '0' },
    ],
  },
]

const out = path.join(HERE, 'bitMatrixB.json')
fs.writeFileSync(out, JSON.stringify(entries, null, 2))
console.log(`wrote ${entries.length} entries → ${out}`)

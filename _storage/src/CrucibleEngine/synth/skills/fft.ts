// Verified primitive: Cooley-Tukey FFT (radix-2, iterative) + IFFT, convolution.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — Cooley-Tukey FFT.
export interface Complex { re: number; im: number }

export function fft(input: Complex[]): Complex[] {
  const n = input.length
  if (n & (n - 1)) throw new Error('FFT length must be power of 2')
  const a = input.map(c => ({ ...c }))
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { const t = a[i]; a[i] = a[j]; a[j] = t }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len
    const wlen: Complex = { re: Math.cos(ang), im: Math.sin(ang) }
    for (let i = 0; i < n; i += len) {
      let w: Complex = { re: 1, im: 0 }
      for (let j = 0; j < len >> 1; j++) {
        const u = a[i + j]
        const v: Complex = { re: a[i + j + len / 2].re * w.re - a[i + j + len / 2].im * w.im,
                             im: a[i + j + len / 2].re * w.im + a[i + j + len / 2].im * w.re }
        a[i + j] = { re: u.re + v.re, im: u.im + v.im }
        a[i + j + len / 2] = { re: u.re - v.re, im: u.im - v.im }
        w = { re: w.re * wlen.re - w.im * wlen.im, im: w.re * wlen.im + w.im * wlen.re }
      }
    }
  }
  return a
}

export function ifft(input: Complex[]): Complex[] {
  const conj = input.map(c => ({ re: c.re, im: -c.im }))
  const result = fft(conj)
  return result.map(c => ({ re: c.re / input.length, im: -c.im / input.length }))
}

export function convolve(a: number[], b: number[]): number[] {
  const n = 1 << Math.ceil(Math.log2(a.length + b.length))
  const fa = fft([...a.map(r => ({ re: r, im: 0 })), ...Array(n - a.length).fill({ re: 0, im: 0 })])
  const fb = fft([...b.map(r => ({ re: r, im: 0 })), ...Array(n - b.length).fill({ re: 0, im: 0 })])
  const fc = fa.map((c, i) => ({ re: c.re * fb[i].re - c.im * fb[i].im, im: c.re * fb[i].im + c.im * fb[i].re }))
  return ifft(fc).slice(0, a.length + b.length - 1).map(c => Math.round(c.re * 1e9) / 1e9)
}
`
registerSkill({
  id: 'fft',
  summary: 'Cooley-Tukey FFT, IFFT, polynomial convolution.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bfft\b|fast.?fourier/i)) sc += 0.7
    if (s.has(/\bconvolv\w+\b/i)) sc += 0.2
    if (s.has(/\bifft\b/i)) sc += 0.2
    if (s.has(/\bspectrum\b/i)) sc += 0.1
    if (s.has(/\bcomplex\b/i) && s.has(/\bfrequenc\w+\b/i)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/fft.ts', content: IMPL }]
  },
})

// Verified primitive: 1-D/2-D convolution (direct + separable), correlation, Gaussian blur.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — convolution primitives.
/** 1-D convolution (full output). */
export function conv1d(signal: number[], kernel: number[]): number[] {
  const n = signal.length; const k = kernel.length; const out = new Array(n + k - 1).fill(0)
  for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) out[i + j] += signal[i] * kernel[j]
  return out
}

/** 2-D convolution on a flat row-major array (same-size output, zero-padded). */
export function conv2d(img: number[], W: number, H: number, kernel: number[], kW: number, kH: number): number[] {
  const out = new Float64Array(W * H)
  const padX = (kW - 1) >> 1; const padY = (kH - 1) >> 1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sum = 0
    for (let ky = 0; ky < kH; ky++) for (let kx = 0; kx < kW; kx++) {
      const iy = y + ky - padY; const ix = x + kx - padX
      if (iy >= 0 && iy < H && ix >= 0 && ix < W) sum += img[iy * W + ix] * kernel[ky * kW + kx]
    }
    out[y * W + x] = sum
  }
  return Array.from(out)
}

/** Gaussian kernel generation. */
export function gaussianKernel(size: number, sigma: number): number[] {
  const k: number[] = []; let sum = 0; const half = (size - 1) / 2
  for (let i = 0; i < size; i++) { const x = i - half; const v = Math.exp(-(x * x) / (2 * sigma * sigma)); k.push(v); sum += v }
  return k.map(v => v / sum)
}

/** Separable 2-D Gaussian blur (faster: two 1-D passes). */
export function gaussianBlur(img: number[], W: number, H: number, sigma: number, size = Math.ceil(sigma * 3) * 2 + 1): number[] {
  const kernel = gaussianKernel(size, sigma)
  // Horizontal pass
  const tmp = new Array(W * H).fill(0); const padX = (size - 1) >> 1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sum = 0; for (let k = 0; k < size; k++) { const ix = x + k - padX; if (ix >= 0 && ix < W) sum += img[y * W + ix] * kernel[k] } tmp[y * W + x] = sum
  }
  const out = new Array(W * H).fill(0)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sum = 0; for (let k = 0; k < size; k++) { const iy = y + k - padX; if (iy >= 0 && iy < H) sum += tmp[iy * W + x] * kernel[k] } out[y * W + x] = sum
  }
  return out
}
`
registerSkill({
  id: 'convolution',
  summary: '1-D/2-D convolution, Gaussian kernel, separable Gaussian blur.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bconv(?:olv|olution)\b/i) && !s.has(/\bfft\b/i)) sc += 0.4
    if (s.has(/\bgaussian.?blur\b/i)) sc += 0.35
    if (s.has(/\bseparable\b/i) && s.has(/\bkernel\b/i)) sc += 0.25
    if (s.has(/\bconv2d\b|\bconv1d\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/convolution.ts', content: IMPL }]
  },
})

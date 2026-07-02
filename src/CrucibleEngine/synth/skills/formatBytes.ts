// Verified Tier-1A primitive: format a byte count as a human-readable string.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible — human-readable byte formatter.
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const clamped = Math.min(i, units.length - 1)
  return \`\${parseFloat((bytes / k ** clamped).toFixed(decimals))} \${units[clamped]}\`
}
`

registerSkill({
  id: 'format-bytes',
  summary: 'Format a byte count to a human-readable string (B, KB, MB, …).',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/format.?bytes?/i)) sc += 0.65
    if (s.has(/\bformatBytes\b/)) sc += 0.3
    if (s.has(/human[- ]?readable.*size|file.*size.*unit|byte.*unit/i)) sc += 0.3
    if (s.has(/\bKB\b|\bMB\b|\bGB\b/)) sc += 0.15
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/formatBytes.ts', content: IMPL }]
  },
})

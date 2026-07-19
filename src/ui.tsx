// ── Shared UI primitives (v3.1 face-lift) ──────────────────────────────────────
// Small, token-driven building blocks so new surfaces stop re-inventing the same
// glass card / label / button with slightly different literals. Everything reads
// from the CSS variables in index.css; no component-local color literals except
// per-feature accent tints passed in by the caller.

import type { CSSProperties, ReactNode } from 'react'

export function tint(hex: string, alpha: number) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

/** Tier-1 glass surface — the standard container. */
export function Card({ children, style, accent }: { children: ReactNode; style?: CSSProperties; accent?: string }) {
  return (
    <div style={{
      borderRadius: 'var(--c-radius)',
      background: accent ? `linear-gradient(150deg, ${tint(accent, 0.07)} 0%, var(--c-glass) 60%)` : 'var(--c-glass)',
      border: '1px solid var(--c-hairline)',
      boxShadow: 'var(--c-inset-highlight)',
      ...style,
    }}>{children}</div>
  )
}

/** Uppercase micro section label. */
export function SectionLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{
      fontSize: 'var(--t-micro)', fontWeight: 700, letterSpacing: '0.12em',
      textTransform: 'uppercase', color: 'var(--c-dim)', ...style,
    }}>{children}</div>
  )
}

const buttonBase: CSSProperties = {
  fontFamily: 'inherit', fontSize: 'var(--t-ui)', fontWeight: 600, cursor: 'pointer',
  borderRadius: 10, padding: '7px 14px', transition: 'background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)',
  display: 'inline-flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap',
}

/** Accent-filled action. */
export function PrimaryButton({ children, onClick, accent = '#7c7cf8', disabled, title, style }: {
  children: ReactNode; onClick?: () => void; accent?: string; disabled?: boolean; title?: string; style?: CSSProperties
}) {
  return (
    <button title={title} onClick={onClick} disabled={disabled} style={{
      ...buttonBase,
      background: tint(accent, disabled ? 0.06 : 0.14), border: `1px solid ${tint(accent, disabled ? 0.15 : 0.38)}`,
      color: disabled ? 'var(--c-dim)' : accent, opacity: disabled ? 0.7 : 1,
      cursor: disabled ? 'default' : 'pointer', ...style,
    }}>{children}</button>
  )
}

/** Quiet hairline action. */
export function GhostButton({ children, onClick, title, active, style }: {
  children: ReactNode; onClick?: () => void; title?: string; active?: boolean; style?: CSSProperties
}) {
  return (
    <button title={title} onClick={onClick} style={{
      ...buttonBase,
      background: active ? 'rgba(124,124,248,0.13)' : 'rgba(255,255,255,0.04)',
      border: `1px solid ${active ? 'rgba(124,124,248,0.3)' : 'var(--c-hairline-strong)'}`,
      color: active ? '#b0b0f8' : '#b8b8cc', ...style,
    }}>{children}</button>
  )
}

/** Tiny status chip: dot + label. */
export function StatusChip({ color, children, pulse }: { color: string; children: ReactNode; pulse?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: 'var(--t-micro)', fontWeight: 600, letterSpacing: '0.08em', color: 'var(--c-dim)',
      background: 'var(--c-glass)', border: '1px solid var(--c-hairline)',
      padding: '3px 9px', borderRadius: 999, flexShrink: 0, textTransform: 'uppercase',
    }}>
      <span style={{
        width: 5, height: 5, borderRadius: '50%', background: color, flexShrink: 0,
        animation: pulse ? 'dotpulse 1.2s ease-in-out infinite' : undefined,
      }} />
      {children}
    </span>
  )
}

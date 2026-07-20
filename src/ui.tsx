// ── Shared UI primitives (v3.1 face-lift) ──────────────────────────────────────
// Small, token-driven building blocks so new surfaces stop re-inventing the same
// glass card / label / button with slightly different literals. Everything reads
// from the CSS variables in index.css; no component-local color literals except
// per-feature accent tints passed in by the caller.

import type { CSSProperties, ReactNode, MouseEvent as ReactMouseEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'

export function tint(hex: string, alpha: number) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

/** Tier-1 glass surface — the standard container. */
export function Card({ children, style, accent, onClick }: { children: ReactNode; style?: CSSProperties; accent?: string; onClick?: (e: ReactMouseEvent) => void }) {
  return (
    <div
      onClick={onClick}
      // Clickable cards must be real controls: keyboard-reachable and visible to the
      // accessibility tree, not mouse-only divs.
      {...(onClick ? {
        role: 'button', tabIndex: 0,
        onKeyDown: (e: ReactKeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (onClick as (ev: unknown) => void)(e) } },
      } : {})}
      style={{
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

/** Centered destructive-action confirmation — fixed overlay, blur backdrop, red confirm.
 *  One shared primitive so History (mobile) and the sidebar rail (desktop) render the
 *  exact same "Are you sure?" instead of drifting copies. */
export function ConfirmModal({ title, body, confirmLabel, busy, onConfirm, onCancel }: {
  title: string
  body: string
  confirmLabel: string
  /** True while the destructive call is in flight — disables both buttons. */
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div
      onClick={() => !busy && onCancel()}
      style={{
        position: 'fixed', inset: 0, zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(8,8,12,0.6)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        animation: 'fadeIn 0.16s var(--ease)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(400px, calc(100% - 48px))', borderRadius: 18, padding: '22px 22px 18px',
          background: '#16161e', border: '1px solid rgba(255,255,255,0.09)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', gap: 10,
          animation: 'panelUp 0.2s var(--ease)',
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--c-text)' }}>{title}</span>
        <span style={{ fontSize: 12, color: 'var(--c-dim)', lineHeight: 1.55 }}>{body}</span>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            onClick={onCancel}
            disabled={busy}
            style={{
              flex: 1, padding: '10px 0', borderRadius: 12, cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit',
              background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)',
              color: '#c8c8da', fontSize: 12.5, fontWeight: 600,
            }}
          >Cancel</button>
          <button
            onClick={onConfirm}
            disabled={busy}
            style={{
              flex: 1, padding: '10px 0', borderRadius: 12, cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit',
              background: 'rgba(248,113,113,0.16)', border: '1px solid rgba(248,113,113,0.45)',
              color: '#fca5a5', fontSize: 12.5, fontWeight: 700,
            }}
          >{busy ? 'Deleting…' : confirmLabel}</button>
        </div>
      </div>
    </div>
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

// ── Glass primitives ───────────────────────────────────────────────────────────
// The full-depth frosted-glass system from DESIGN_HANDOFF §3. Every surface in the
// redesign is built from these; do not hand-roll another backdrop-filter block.
//
// House rules enforced here (CLAUDE.md, non-negotiable):
//   - No emojis. Markers are geometry or self-authored SVG.
//   - No external assets. Everything is CSS and inline SVG.
//   - Text stays in its box. Card content wraps and clamps; nothing rides a border.
//   - Motion eases in and out and honours prefers-reduced-motion (handled globally in
//     index.css, so components only need to use the token curves).
//
// The tokens live in index.css. Reading them from CSS variables — rather than baking
// literals here — is what makes the light theme and the reduce-transparency
// accommodation a one-variable swap instead of a component rewrite.

import type { CSSProperties, ReactNode } from 'react'

/** The four domains a card can belong to. The tint encodes WHICH, never decoration. */
export type Domain = 'research' | 'mail' | 'time' | 'watch' | 'code'

/** rgb triplet tokens, so a tint can be composed at any alpha. */
const DOMAIN_RGB: Record<Domain, string> = {
  research: 'var(--domain-research)',
  mail: 'var(--domain-mail)',
  time: 'var(--domain-time)',
  watch: 'var(--domain-watch)',
  code: 'var(--domain-code)',
}

/**
 * Label colour per domain. A token, not a literal, because the light theme needs a
 * genuinely different value — a pale pastel that reads on dark glass vanishes on light
 * glass, which is exactly what the first light-theme pass looked like.
 */
const DOMAIN_LABEL: Record<Domain, string> = {
  research: 'var(--domain-research-label)',
  mail: 'var(--domain-mail-label)',
  time: 'var(--domain-time-label)',
  watch: 'var(--domain-watch-label)',
  code: 'var(--domain-code-label)',
}

export function domainTint(domain: Domain | undefined, alpha: number): string {
  if (!domain) return 'transparent'
  return `rgba(${DOMAIN_RGB[domain]}, ${alpha})`
}

export function domainLabelColor(domain: Domain | undefined): string {
  return domain ? DOMAIN_LABEL[domain] : 'var(--c-dim)'
}

/**
 * Elevation ladder (§3.3). Four levels, no more, and each one means something:
 *   1 resting card · 2 focused/dragged · 3 sheet/modal/confirm gate · 4 chrome + dock
 */
export type Elevation = 1 | 2 | 3 | 4

// NOTE (2026-08-04b): `domain` no longer paints the surface. It used to add a
// `linear-gradient(150deg, tint 0.18 → 0.02)` wash, which is what made every card on the
// board a different colour — an amber calendar next to a teal inbox next to an indigo
// agents panel. That is the "coloured blobs" the direction rules out, and it is also why
// the app never read as one surface. The parameter is KEPT (call sites still pass it, and
// it still drives the label colour via CardLabel) so domain stays a real concept in the
// data — it simply no longer has a decorative consequence. Every panel is now the same
// frosted slate, and hierarchy comes from elevation alone.
export function glassSurface(level: Elevation = 1, _domain?: Domain): CSSProperties {
  const chrome = level === 4
  const fill = level >= 2 && level !== 4 ? 'var(--glass-fill-2)' : 'var(--glass-fill)'
  const wash = ''
  return {
    backdropFilter: chrome ? 'var(--glass-blur-light)' : 'var(--glass-blur)',
    WebkitBackdropFilter: chrome ? 'var(--glass-blur-light)' : 'var(--glass-blur)',
    background: `${wash}${fill}`,
    border: `1px solid ${level >= 2 && level !== 4 ? 'var(--glass-edge-2)' : 'var(--glass-edge)'}`,
    // The inner light edge is what makes glass read as glass rather than a grey box.
    // §3.2 is explicit: do not omit it.
    boxShadow: level >= 2 && level !== 4
      ? 'var(--glass-shadow-2), var(--glass-inner-light)'
      : `${level === 4 ? 'none' : 'var(--glass-shadow)'}, var(--glass-inner-light)`,
    borderRadius: level === 3 ? 'var(--radius-sheet)' : 'var(--radius-card)',
  }
}

/**
 * A text plate (§3.4). Frosted glass loses contrast when the ambient field beneath it
 * brightens — the fix is a slightly more opaque region behind the prose, NOT darkening
 * the whole card and losing the glass. Wrap any paragraph that must hold 4.5:1.
 */
export function TextPlate({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{
      background: 'var(--glass-fill-plate)',
      borderRadius: 14, padding: '10px 12px',
      ...style,
    }}>{children}</div>
  )
}

/** Uppercase mono card label — the domain name. */
export function CardLabel({ domain, children }: { domain?: Domain; children: ReactNode }) {
  return (
    <div style={{
      font: '600 10px/1 var(--mono)', letterSpacing: '0.14em', textTransform: 'uppercase',
      color: domainLabelColor(domain),
      // Long domain labels must not push the pin marker off the card.
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
    }}>{children}</div>
  )
}

/**
 * The quiet boundary between the pinned and suggested regions (§4.1.1): a hairline and
 * a small label, never a heavy divider.
 */
export function SectionRule({ label, trailing }: { label: string; trailing?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 6px', minWidth: 0 }}>
      <div style={{
        font: '600 10px/1 var(--mono)', letterSpacing: '0.14em', textTransform: 'uppercase',
        color: 'var(--glass-text-2)',
        // Must ellipsize, not push the hairline off-screen: verified against a 3×
        // longer label (house rule 3), where flexShrink:0 ran the rule past the edge.
        minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{label}</div>
      <div style={{ flex: 1, height: 1, background: 'var(--glass-edge)' }} />
      {trailing}
    </div>
  )
}

/** Pinned marker — a small rotated square. Geometry, not an icon font, not an emoji. */
export function PinMark({ on }: { on: boolean }) {
  if (!on) return null
  return (
    <span
      aria-label="Pinned"
      title="Pinned — this card stays where you put it"
      style={{
        width: 9, height: 9, borderRadius: 2, flexShrink: 0,
        background: 'rgba(255,255,255,0.55)', transform: 'rotate(45deg)',
      }}
    />
  )
}

/**
 * The resting card. `onClick` makes it a real control (keyboard-reachable, in the
 * accessibility tree) rather than a mouse-only div.
 */
export function GlassCard({
  children, domain, elevation = 1, span = 1, onClick, label, ariaLabel, style,
}: {
  children: ReactNode
  domain?: Domain
  elevation?: Elevation
  /** Column span on the 2-column phone grid: 1 = S, 2 = M/L. */
  span?: 1 | 2
  onClick?: () => void
  label?: string
  ariaLabel?: string
  style?: CSSProperties
}) {
  const interactive = !!onClick
  return (
    <div
      {...(interactive ? {
        role: 'button' as const,
        tabIndex: 0,
        'aria-label': ariaLabel ?? label,
        onClick,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick!() }
        },
      } : {})}
      style={{
        ...glassSurface(elevation, domain),
        gridColumn: span === 2 ? 'span 2' : undefined,
        padding: '16px 20px',
        cursor: interactive ? 'pointer' : undefined,
        // Text stays inside its box (house rule 3): the card may grow, never spill.
        minWidth: 0, overflow: 'hidden',
        // 160ms, ease-standard. Under reduced motion index.css clamps this to 120ms.
        transition: 'transform var(--dur-fast) var(--ease-standard), box-shadow var(--dur-fast) var(--ease-standard), background var(--dur-fast) var(--ease-standard)',
        ...style,
      }}
    >{children}</div>
  )
}

// ── Honesty states (§7) ────────────────────────────────────────────────────────
// Three states, visually distinct, NEVER collapsed into two. Earlier builds shipped
// `verified: true` as a default when nothing had checked the answer — a badge that
// could not fail. The rule that prevents that regression is mechanical and lives here:
// the chip renders NOTHING without a backing ledger record (§7.2).

export type VerificationState = 'verified' | 'unverified' | 'abstained'

export interface VerificationLedger {
  state: VerificationState
  /** What actually checked it — "3 sources agree", "Computed from the release table". */
  how: string
}

const STATE_STYLE: Record<VerificationState, { dot: string; bg: string; edge: string; fg: string; text: string }> = {
  // A deterministic check ran and passed.
  verified: {
    dot: 'var(--state-verified)', bg: 'rgba(52,211,153,0.16)', edge: 'rgba(52,211,153,0.34)',
    fg: '#A7F3D0', text: 'Verified',
  },
  // Answered, but nothing could mechanically check it. This is the COMMON case —
  // neutral, not alarming, and deliberately not styled as an error.
  unverified: {
    dot: 'var(--state-unverified)', bg: 'rgba(255,255,255,0.06)', edge: 'rgba(255,255,255,0.14)',
    fg: 'rgba(255,255,255,0.72)', text: 'Unverified',
  },
  // The system does not know and says so. A refusal is a correct answer: calm and
  // dignified, never styled as a failure.
  abstained: {
    dot: 'var(--state-abstained)', bg: 'rgba(165,180,252,0.14)', edge: 'rgba(165,180,252,0.30)',
    fg: '#C7D2FE', text: 'No answer found',
  },
}

/**
 * The verification chip. Pass the ledger the engine returned — if there isn't one,
 * pass undefined and this renders nothing. Never synthesize a ledger to get a badge.
 */
export function VerificationChip({ ledger }: { ledger?: VerificationLedger | null }) {
  if (!ledger) return null
  const s = STATE_STYLE[ledger.state]
  return (
    <span
      // The chip must be explainable (§7.2): the "how" is the accessible name and the
      // hover/long-press reveal, so the marker is never a bare assertion.
      title={ledger.how}
      aria-label={`${s.text}. ${ledger.how}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0,
        padding: '4px 9px', borderRadius: 8,
        background: s.bg, border: `1px solid ${s.edge}`,
        maxWidth: '100%', minWidth: 0,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.dot, flexShrink: 0 }} />
      <span style={{
        fontSize: 11, fontWeight: 600, color: s.fg,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{s.text}</span>
    </span>
  )
}

/**
 * Working state (§6.3) — never a bare spinner. Says what it is doing in plain words,
 * and shows step progress when the step count is actually known. The pulse is
 * opacity-only, so it survives reduced motion as legitimate liveness.
 */
export function WorkingLine({ phase, step, of }: { phase: string; step?: number; of?: number }) {
  const known = typeof step === 'number' && typeof of === 'number' && of > 0
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
        <span className="cru-pulse" style={{
          width: 6, height: 6, borderRadius: '50%', background: '#A5B4FC', flexShrink: 0,
        }} />
        <span style={{
          font: '500 11px/1 var(--mono)', letterSpacing: '0.06em',
          color: 'rgba(199,210,254,0.9)', flexShrink: 0,
        }}>RUNNING</span>
      </div>
      <div style={{
        marginTop: 10, fontSize: 15, fontWeight: 600, color: 'var(--glass-text)', lineHeight: 1.3,
        overflowWrap: 'anywhere',
      }}>{phase}</div>
      {known && (
        <>
          <div style={{ marginTop: 6, fontSize: 13, color: 'var(--glass-text-2)', opacity: 0.75 }}>
            Step {step} of {of}
          </div>
          <div style={{
            marginTop: 10, height: 3, borderRadius: 2,
            background: 'rgba(255,255,255,0.10)', overflow: 'hidden',
          }}>
            <div style={{
              width: `${Math.round((step! / of!) * 100)}%`, height: '100%', borderRadius: 2,
              background: 'rgba(165,180,252,0.9)',
              transition: 'width var(--dur) var(--ease-glide)',
            }} />
          </div>
        </>
      )}
    </div>
  )
}

// The universal agentic surface renderer.
//
// ONE component tree renders ANY `ViewSpec`. There is no Gmail card, no calendar card, no Drive
// card — a new provider that emits entities of an existing kind gets this entire interface for
// free, because the renderer reads SEMANTIC ROLES (`timestamp`, `person`, `size`, `status`) and
// never provider names. That is the whole design: the interface is a function of the data.
//
// The bar: the result IS the interface. Not a card describing a result you then have to go
// elsewhere to act on — the actual objects, with their real actions attached (cont.103's standing
// rule: a surface showing a result must let you OPEN and ACT on it).
//
// SAFETY IS VISUAL. `read` actions run on click. Anything that leaves the machine or destroys
// data (`send`, `destructive`) opens a sheet showing the EXACT payload, and the confirm button is
// tinted by severity. The user should never be able to send an email by mis-clicking, and should
// never have to guess what a button is about to do.
//
// Design language is inherited, not invented — every value below is a token from index.css
// (glass, hairline, violet accent #7c7cf8, on-device green #4db89e, the 0.22/1/0.36/1 easing).
// Project rules: no emojis, no stock images, no horizontal overflow, clean eased motion only.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { SectionLabel, tint } from '../ui'

// ── Protocol types, mirrored ─────────────────────────────────────────────────
// Declared structurally rather than imported from CrucibleEngine: this file ships in the browser
// bundle and the engine module pulls in `fs`/`path`. The shapes are asserted to match by
// `__surface_bench.ts` on the server side, and by `surfaceContract.ts` here.

export type EntityKind =
  | 'message' | 'event' | 'file' | 'contact' | 'place' | 'route' | 'media' | 'webpage' | 'task' | 'record'

export type FieldRole =
  | 'title' | 'subtitle' | 'body' | 'timestamp' | 'duration'
  | 'person' | 'location' | 'url' | 'status' | 'quantity' | 'size' | 'label' | 'id'

export interface EntityField { key: string; label: string; value: string | number | boolean | null; role?: FieldRole }

export interface Entity {
  id: string; kind: EntityKind; source: string; title: string
  subtitle?: string; body?: string; at?: string; until?: string; url?: string
  fields: EntityField[]; raw?: Record<string, unknown>
}

export type Effect = 'read' | 'write' | 'send' | 'destructive'

export interface AffordanceInput {
  key: string; label: string; type: 'text' | 'longtext' | 'datetime' | 'choice'
  required?: boolean; choices?: string[]; default?: string
}

export interface BoundAffordance {
  id: string; label: string; tool: string; effect: Effect
  inputs?: AffordanceInput[]; args: Record<string, unknown> | null; requiresConfirmation: boolean
}

export type Layout = 'empty' | 'detail' | 'list' | 'agenda' | 'table' | 'grid' | 'map'
export interface ViewColumn { key: string; label: string; role?: string }
export interface ViewGroup { label: string; entityIds: string[] }

export interface ViewSpec {
  layout: Layout; title: string
  columns?: ViewColumn[]; groups?: ViewGroup[]
  entities: Entity[]
  actions: Record<string, BoundAffordance[]>
  notice?: string; sources: string[]
}

/** Invoke a tool. Resolves with the tool's textual result; rejects on failure.
 *  `confirmed` is true only when the user cleared this action in the confirm sheet. */
export type RunAction = (a: {
  entity: Entity; affordanceId: string; input?: Record<string, string>; confirmed?: boolean
}) => Promise<string>

// ── Tokens ───────────────────────────────────────────────────────────────────

const ACCENT = '#7c7cf8'
const ON_DEVICE = '#4db89e'
const WARN = '#f59e0b'
const ERROR = '#f87171'

/** Severity colour per effect class — the same scale the confirm sheet uses. */
const EFFECT_COLOR: Record<Effect, string> = {
  read: ACCENT, write: ON_DEVICE, send: WARN, destructive: ERROR,
}
const EFFECT_NOTE: Record<Effect, string> = {
  read: 'Reads data. Nothing changes.',
  write: 'Changes something you own. Reversible.',
  send: 'Leaves this machine and cannot be recalled.',
  destructive: 'Permanently discards data.',
}

/**
 * A quiet per-kind accent. Deliberately restrained — a hairline rail and a label, never a badge
 * shouting the provider's name. Kinds are how the eye segments a mixed result set, not decoration.
 */
const KIND_ACCENT: Record<EntityKind, string> = {
  message: '#7c7cf8', event: '#4db89e', file: '#8b9dc3', contact: '#c39a7c',
  place: '#7cc3b8', route: '#7cc3b8', media: '#c37c9a', webpage: '#8b8b9d',
  task: '#f59e0b', record: '#77778c',
}

// ── Formatting ───────────────────────────────────────────────────────────────

function parseTs(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t)
}

/** Relative for the last week, absolute beyond. What a person actually wants to read. */
function formatWhen(v: unknown): string {
  const d = parseTs(v)
  if (!d) return typeof v === 'string' ? v : ''
  const diff = Date.now() - d.getTime()
  const abs = Math.abs(diff)
  const hm = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (abs < 60_000) return 'just now'
  if (abs < 3_600_000) {
    const m = Math.round(abs / 60_000)
    return diff > 0 ? `${m}m ago` : `in ${m}m`
  }
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const day = new Date(d); day.setHours(0, 0, 0, 0)
  const dayDiff = Math.round((day.getTime() - today.getTime()) / 86_400_000)
  if (dayDiff === 0) return hm
  if (dayDiff === -1) return `Yesterday ${hm}`
  if (dayDiff === 1) return `Tomorrow ${hm}`
  if (dayDiff > 1 && dayDiff < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${hm}`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })
}

function formatFieldValue(f: EntityField): string {
  if (f.value === null || f.value === undefined) return ''
  if (f.role === 'timestamp') return formatWhen(f.value)
  return String(f.value)
}

/** Numerics and times right-align on a tabular figure so columns line up down the page. */
const NUMERIC_ROLES = new Set<string>(['quantity', 'size', 'duration', 'timestamp'])

function pickField(e: Entity, role: FieldRole): EntityField | undefined {
  return e.fields.find(f => f.role === role)
}

// ── Action controls ──────────────────────────────────────────────────────────

function ActionButton({ a, onClick, subtle }: { a: BoundAffordance; onClick: () => void; subtle?: boolean }) {
  const [hover, setHover] = useState(false)
  const c = EFFECT_COLOR[a.effect]
  return (
    <button
      onClick={e => { e.stopPropagation(); onClick() }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${a.label} — ${EFFECT_NOTE[a.effect]}`}
      style={{
        fontFamily: 'inherit', fontSize: 'var(--t-small)', fontWeight: 600, cursor: 'pointer',
        padding: '4px 10px', borderRadius: 8, whiteSpace: 'nowrap', flexShrink: 0,
        background: hover ? tint(c, 0.16) : subtle ? 'transparent' : tint(c, 0.08),
        border: `1px solid ${hover ? tint(c, 0.4) : subtle ? 'transparent' : tint(c, 0.2)}`,
        color: hover ? c : 'var(--c-dim)',
        transition: 'background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease)',
        display: 'inline-flex', alignItems: 'center', gap: 5,
      }}
    >
      {/* A dot, not an icon font: it encodes severity and costs nothing. */}
      {a.requiresConfirmation && (
        <span style={{ width: 4, height: 4, borderRadius: '50%', background: c, flexShrink: 0 }} />
      )}
      {a.label}
    </button>
  )
}

function ActionRow({ actions, onRun, align = 'flex-end' }: {
  actions: BoundAffordance[]; onRun: (a: BoundAffordance) => void; align?: CSSProperties['justifyContent']
}) {
  if (!actions.length) return null
  return (
    <div style={{ display: 'flex', gap: 6, justifyContent: align, flexWrap: 'wrap', minWidth: 0 }}>
      {actions.map(a => <ActionButton key={a.id} a={a} onClick={() => onRun(a)} />)}
    </div>
  )
}

/**
 * Confirmation sheet for anything above `read`.
 *
 * Shows the EXACT tool and arguments before they are sent. The rule this enforces is not
 * cosmetic: a model proposed this action, and the user is the only thing between a proposal and
 * an irreversible send. So the payload is displayed verbatim, the severity note is stated in
 * words, and the confirm button is tinted by effect.
 */
function ActionSheet({ entity, affordance, onCancel, onConfirm }: {
  entity: Entity; affordance: BoundAffordance
  onCancel: () => void
  onConfirm: (input: Record<string, string>) => void
}) {
  const [input, setInput] = useState<Record<string, string>>(() =>
    Object.fromEntries((affordance.inputs ?? []).map(i => [i.key, i.default ?? ''])))
  const [busy, setBusy] = useState(false)
  const firstRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)
  const c = EFFECT_COLOR[affordance.effect]

  useEffect(() => { firstRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  const missing = (affordance.inputs ?? []).filter(i => i.required && !input[i.key]?.trim())
  const ready = missing.length === 0

  return (
    <div
      onClick={() => !busy && onCancel()}
      style={{
        position: 'fixed', inset: 0, zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(8,8,12,0.62)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        animation: 'fadeIn var(--dur-fast) var(--ease)', padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label={affordance.label}
        style={{
          width: 'min(520px, 100%)', maxHeight: '86vh', overflowY: 'auto',
          borderRadius: 18, background: '#16161e', border: '1px solid rgba(255,255,255,0.09)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.55)', animation: 'panelUp var(--dur) var(--ease)',
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* Severity header — the first thing read, tinted by what this will do. */}
        <div style={{
          padding: '16px 20px 14px', borderBottom: '1px solid var(--c-hairline)',
          background: `linear-gradient(180deg, ${tint(c, 0.09)} 0%, transparent 100%)`,
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: c, flexShrink: 0 }} />
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--c-text)' }}>{affordance.label}</span>
          </div>
          <span style={{ fontSize: 'var(--t-small)', color: c, fontWeight: 600 }}>
            {EFFECT_NOTE[affordance.effect]}
          </span>
        </div>

        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <SectionLabel>On</SectionLabel>
            <span style={{ fontSize: 'var(--t-body)', color: 'var(--c-text)', fontWeight: 600 }}>{entity.title}</span>
            {entity.subtitle && (
              <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim)' }}>{entity.subtitle}</span>
            )}
          </div>

          {(affordance.inputs ?? []).map((i, idx) => (
            <label key={i.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <SectionLabel>{i.label}{i.required ? '' : ' (optional)'}</SectionLabel>
              {i.type === 'longtext' ? (
                <textarea
                  ref={el => { if (idx === 0) firstRef.current = el }}
                  value={input[i.key] ?? ''}
                  onChange={e => setInput(s => ({ ...s, [i.key]: e.target.value }))}
                  rows={5}
                  style={{
                    fontFamily: 'inherit', fontSize: 'var(--t-body)', lineHeight: 1.55, resize: 'vertical',
                    padding: '10px 12px', borderRadius: 10, color: 'var(--c-text)',
                    background: 'rgba(255,255,255,0.04)', border: '1px solid var(--c-hairline-strong)',
                    outline: 'none',
                  }}
                />
              ) : (
                <input
                  ref={el => { if (idx === 0) firstRef.current = el }}
                  value={input[i.key] ?? ''}
                  onChange={e => setInput(s => ({ ...s, [i.key]: e.target.value }))}
                  type={i.type === 'datetime' ? 'datetime-local' : 'text'}
                  style={{
                    fontFamily: 'inherit', fontSize: 'var(--t-body)', padding: '9px 12px', borderRadius: 10,
                    color: 'var(--c-text)', background: 'rgba(255,255,255,0.04)',
                    border: '1px solid var(--c-hairline-strong)', outline: 'none',
                  }}
                />
              )}
            </label>
          ))}

          {/* The payload, verbatim. A model proposed this; the user should see exactly what
              will run rather than trusting a label. */}
          <details style={{ marginTop: 2 }}>
            <summary style={{
              cursor: 'pointer', fontSize: 'var(--t-small)', color: 'var(--c-dim)',
              listStyle: 'none', userSelect: 'none',
            }}>
              Exactly what will run
            </summary>
            <pre style={{
              margin: '8px 0 0', padding: '10px 12px', borderRadius: 10, overflowX: 'auto',
              background: 'rgba(0,0,0,0.28)', border: '1px solid var(--c-hairline)',
              fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.6, color: 'var(--c-dim)',
            }}>
{`${affordance.tool}(${JSON.stringify({ ...(affordance.args ?? {}), ...input }, null, 2)})`}
            </pre>
          </details>
        </div>

        <div style={{ display: 'flex', gap: 8, padding: '0 20px 18px' }}>
          <button
            onClick={onCancel} disabled={busy}
            style={{
              flex: 1, padding: '10px 0', borderRadius: 12, fontFamily: 'inherit',
              cursor: busy ? 'default' : 'pointer', background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.09)', color: '#c8c8da', fontSize: 12.5, fontWeight: 600,
            }}
          >Cancel</button>
          <button
            onClick={() => { setBusy(true); onConfirm(input) }}
            disabled={busy || !ready}
            title={ready ? undefined : `Fill in: ${missing.map(m => m.label).join(', ')}`}
            style={{
              flex: 1.4, padding: '10px 0', borderRadius: 12, fontFamily: 'inherit',
              cursor: busy || !ready ? 'default' : 'pointer',
              background: tint(c, ready && !busy ? 0.17 : 0.06),
              border: `1px solid ${tint(c, ready && !busy ? 0.46 : 0.16)}`,
              color: ready && !busy ? c : 'var(--c-dim)', fontSize: 12.5, fontWeight: 700,
              transition: 'background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)',
            }}
          >{busy ? 'Working…' : affordance.label}</button>
        </div>
      </div>
    </div>
  )
}

// ── Entity presentations ─────────────────────────────────────────────────────

/** The row used by `list`. Dense, scannable, actions revealed on hover but always keyboard-reachable. */
function EntityRow({ e, actions, onRun, onOpen, index }: {
  e: Entity; actions: BoundAffordance[]; onRun: (a: BoundAffordance) => void; onOpen: () => void; index: number
}) {
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const active = hover || focus
  const kindColor = KIND_ACCENT[e.kind]
  const status = pickField(e, 'status')
  const person = pickField(e, 'person')
  const unread = String(status?.value ?? '').toLowerCase() === 'unread'

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      onClick={onOpen}
      role="button" tabIndex={0}
      onKeyDown={ev => { if (ev.key === 'Enter') { ev.preventDefault(); onOpen() } }}
      style={{
        display: 'grid', gridTemplateColumns: '3px 1fr auto', gap: 12, alignItems: 'start',
        padding: '11px 14px 11px 0', cursor: 'pointer', borderRadius: 'var(--c-radius-sm)',
        background: active ? 'rgba(255,255,255,0.035)' : 'transparent',
        transition: 'background var(--dur-fast) var(--ease)',
        // Stagger keeps a long result set from arriving as one slab, capped so a 200-row
        // response does not take six seconds to finish animating.
        animation: `slideUp var(--dur) var(--ease) ${Math.min(index, 12) * 22}ms both`,
        outline: 'none',
      }}
    >
      {/* Kind rail — the quietest possible way to segment a mixed result set. */}
      <span style={{
        alignSelf: 'stretch', borderRadius: 2, minHeight: 20,
        background: unread ? kindColor : tint(kindColor, active ? 0.45 : 0.22),
        transition: 'background var(--dur-fast) var(--ease)',
      }} />

      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          <span style={{
            fontSize: 'var(--t-body)', fontWeight: unread ? 700 : 600,
            color: unread ? 'var(--c-text)' : 'var(--c-text-soft)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
          }}>{e.title}</span>
        </div>

        {(person || e.subtitle || e.at) && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
            fontSize: 'var(--t-small)', color: 'var(--c-dim)',
          }}>
            {(person?.value || e.subtitle) && (
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                {e.subtitle || String(person!.value)}
              </span>
            )}
            {e.at && (
              <>
                <span style={{ color: 'var(--c-dim-deep)', flexShrink: 0 }}>·</span>
                <span style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{formatWhen(e.at)}</span>
              </>
            )}
          </div>
        )}

        {e.body && (
          <span style={{
            fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)', lineHeight: 1.5,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
            overflow: 'hidden', wordBreak: 'break-word',
          }}>{e.body}</span>
        )}
      </div>

      <div style={{
        opacity: active ? 1 : 0, transition: 'opacity var(--dur-fast) var(--ease)',
        pointerEvents: active ? 'auto' : 'none', paddingTop: 1,
      }}>
        <ActionRow actions={actions} onRun={onRun} />
      </div>
    </div>
  )
}

/** Full presentation of one entity — the `detail` layout and the expanded row. */
function EntityDetail({ e, actions, onRun }: {
  e: Entity; actions: BoundAffordance[]; onRun: (a: BoundAffordance) => void
}) {
  const shown = e.fields.filter(f => f.role !== 'id' && formatFieldValue(f))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, animation: 'panelUp var(--dur) var(--ease)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <span style={{ fontSize: 19, fontWeight: 700, color: 'var(--c-text)', lineHeight: 1.3, wordBreak: 'break-word' }}>
          {e.title}
        </span>
        {e.subtitle && (
          <span style={{ fontSize: 'var(--t-ui)', color: 'var(--c-dim)' }}>{e.subtitle}</span>
        )}
      </div>

      {shown.length > 0 && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'minmax(88px, max-content) 1fr',
          gap: '8px 18px', alignItems: 'baseline',
        }}>
          {shown.map(f => (
            <ReactFragmentRow key={f.key} label={f.label} value={formatFieldValue(f)} role={f.role} />
          ))}
        </div>
      )}

      {e.body && (
        <div style={{
          fontSize: 'var(--t-body)', color: 'var(--c-text-soft)', lineHeight: 1.65,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          paddingTop: 12, borderTop: '1px solid var(--c-hairline)',
        }}>{e.body}</div>
      )}

      {actions.length > 0 && (
        <div style={{ paddingTop: 12, borderTop: '1px solid var(--c-hairline)' }}>
          <ActionRow actions={actions} onRun={onRun} align="flex-start" />
        </div>
      )}
    </div>
  )
}

function ReactFragmentRow({ label, value, role }: { label: string; value: string; role?: FieldRole }) {
  return (
    <>
      <span style={{
        fontSize: 'var(--t-micro)', fontWeight: 700, letterSpacing: '0.1em',
        textTransform: 'uppercase', color: 'var(--c-dim-deep)',
      }}>{label}</span>
      <span style={{
        fontSize: 'var(--t-ui)', color: 'var(--c-text-soft)', wordBreak: 'break-word',
        fontVariantNumeric: NUMERIC_ROLES.has(role ?? '') ? 'tabular-nums' : undefined,
      }}>{value}</span>
    </>
  )
}

// ── Layouts ──────────────────────────────────────────────────────────────────

function ListView({ v, onRun, expanded, setExpanded }: LayoutProps) {
  const groups = v.groups
  const byId = useMemo(() => new Map(v.entities.map(e => [e.id, e])), [v.entities])

  const renderRows = (entities: Entity[], offset: number) => entities.map((e, i) => (
    <div key={`${e.id}-${offset + i}`}>
      <EntityRow
        e={e} index={offset + i} actions={v.actions[e.id] ?? []}
        onRun={a => onRun(e, a)}
        onOpen={() => setExpanded(expanded === e.id ? null : e.id)}
      />
      {expanded === e.id && (
        <div style={{
          margin: '2px 0 10px 15px', padding: '14px 16px',
          borderRadius: 'var(--c-radius)', background: 'rgba(255,255,255,0.025)',
          border: '1px solid var(--c-hairline)',
        }}>
          <EntityDetail e={e} actions={v.actions[e.id] ?? []} onRun={a => onRun(e, a)} />
        </div>
      )}
    </div>
  ))

  if (!groups) return <div>{renderRows(v.entities, 0)}</div>

  let offset = 0
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {groups.map(g => {
        const entities = g.entityIds.map(id => byId.get(id)).filter(Boolean) as Entity[]
        const block = (
          <div key={g.label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <SectionLabel style={{ marginBottom: 4 }}>{g.label}</SectionLabel>
            {renderRows(entities, offset)}
          </div>
        )
        offset += entities.length
        return block
      })}
    </div>
  )
}

/** Events, grouped by day, with a time gutter. The layout a calendar wants and a list is not. */
function AgendaView({ v, onRun, expanded, setExpanded }: LayoutProps) {
  const byId = useMemo(() => new Map(v.entities.map(e => [e.id, e])), [v.entities])
  const groups = v.groups ?? [{ label: '', entityIds: v.entities.map(e => e.id) }]
  let n = 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {groups.map(g => (
        <div key={g.label} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SectionLabel style={{
            position: 'sticky', top: 0, zIndex: 2, padding: '6px 0',
            background: 'linear-gradient(180deg, var(--c-bg) 55%, transparent 100%)',
          }}>{g.label}</SectionLabel>

          {g.entityIds.map(id => {
            const e = byId.get(id)
            if (!e) return null
            const start = parseTs(e.at)
            const end = parseTs(e.until)
            const allDay = e.raw?.allDay === true || (!!e.at && !e.at.includes('T'))
            const acts = v.actions[e.id] ?? []
            const i = n++
            return (
              <div
                key={id}
                onClick={() => setExpanded(expanded === id ? null : id)}
                role="button" tabIndex={0}
                onKeyDown={ev => { if (ev.key === 'Enter') { ev.preventDefault(); setExpanded(expanded === id ? null : id) } }}
                style={{
                  display: 'grid', gridTemplateColumns: '58px 2px 1fr', gap: 12, alignItems: 'stretch',
                  cursor: 'pointer', animation: `slideUp var(--dur) var(--ease) ${Math.min(i, 12) * 22}ms both`,
                  outline: 'none',
                }}
              >
                {/* Time gutter — tabular so the column reads straight down the page. */}
                <div style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2,
                  paddingTop: 10, fontVariantNumeric: 'tabular-nums',
                }}>
                  <span style={{ fontSize: 'var(--t-ui)', fontWeight: 700, color: 'var(--c-text-soft)' }}>
                    {allDay ? 'All day' : start ? start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—'}
                  </span>
                  {end && !allDay && (
                    <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)' }}>
                      {end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    </span>
                  )}
                </div>

                <span style={{
                  borderRadius: 2, background: tint(KIND_ACCENT.event, 0.34), marginTop: 8, marginBottom: 4,
                }} />

                <div style={{
                  minWidth: 0, padding: '10px 14px', borderRadius: 'var(--c-radius)',
                  background: expanded === id ? 'rgba(255,255,255,0.04)' : 'var(--c-glass)',
                  border: '1px solid var(--c-hairline)', boxShadow: 'var(--c-inset-highlight)',
                  transition: 'background var(--dur-fast) var(--ease)',
                  display: 'flex', flexDirection: 'column', gap: 6,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <span style={{
                      flex: 1, minWidth: 0, fontSize: 'var(--t-body)', fontWeight: 600, color: 'var(--c-text)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{e.title}</span>
                    <ActionRow actions={acts} onRun={a => onRun(e, a)} />
                  </div>
                  {e.subtitle && (
                    <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim)' }}>{e.subtitle}</span>
                  )}
                  {expanded === id && (
                    <div style={{ marginTop: 6, paddingTop: 10, borderTop: '1px solid var(--c-hairline)' }}>
                      <EntityDetail e={e} actions={acts} onRun={a => onRun(e, a)} />
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/** Uniform records with shared fields. Columns come from the data, not from a schema someone wrote. */
function TableView({ v, onRun, expanded, setExpanded }: LayoutProps) {
  const cols = v.columns ?? []
  return (
    // The one place horizontal scroll is allowed — contained here so the PAGE never scrolls
    // sideways, which is the actual project rule.
    <div style={{ overflowX: 'auto', borderRadius: 'var(--c-radius)', border: '1px solid var(--c-hairline)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--t-ui)', minWidth: 'min(100%, 480px)' }}>
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c.key} style={{
                textAlign: NUMERIC_ROLES.has(c.role ?? '') ? 'right' : 'left',
                padding: '9px 14px', whiteSpace: 'nowrap',
                fontSize: 'var(--t-micro)', fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase', color: 'var(--c-dim)',
                background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid var(--c-hairline-strong)',
                position: 'sticky', top: 0,
              }}>{c.label}</th>
            ))}
            <th style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid var(--c-hairline-strong)' }} />
          </tr>
        </thead>
        <tbody>
          {v.entities.map((e, i) => {
            const acts = v.actions[e.id] ?? []
            const open = expanded === e.id
            return (
              <TableRow
                key={`${e.id}-${i}`} e={e} cols={cols} acts={acts} index={i} open={open}
                onRun={a => onRun(e, a)}
                onToggle={() => setExpanded(open ? null : e.id)}
              />
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function TableRow({ e, cols, acts, index, open, onRun, onToggle }: {
  e: Entity; cols: ViewColumn[]; acts: BoundAffordance[]; index: number; open: boolean
  onRun: (a: BoundAffordance) => void; onToggle: () => void
}) {
  const [hover, setHover] = useState(false)
  return (
    <>
      <tr
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        onClick={onToggle}
        style={{
          cursor: 'pointer', background: hover || open ? 'rgba(255,255,255,0.035)' : 'transparent',
          transition: 'background var(--dur-fast) var(--ease)',
          animation: `fadeIn var(--dur-fast) var(--ease) ${Math.min(index, 14) * 16}ms both`,
        }}
      >
        {cols.map(c => {
          const isTitle = c.key === '__title'
          const f = isTitle ? undefined : e.fields.find(f => f.key === c.key)
          const value = isTitle ? e.title : (f ? formatFieldValue(f) : '')
          const numeric = NUMERIC_ROLES.has(c.role ?? '')
          return (
            <td key={c.key} style={{
              padding: '10px 14px', borderTop: '1px solid var(--c-hairline)',
              textAlign: numeric ? 'right' : 'left',
              fontVariantNumeric: numeric ? 'tabular-nums' : undefined,
              color: isTitle ? 'var(--c-text)' : 'var(--c-dim)',
              fontWeight: isTitle ? 600 : 400,
              maxWidth: isTitle ? 320 : 200,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{value || <span style={{ color: 'var(--c-dim-deep)' }}>—</span>}</td>
          )
        })}
        <td style={{ padding: '6px 12px', borderTop: '1px solid var(--c-hairline)', textAlign: 'right', whiteSpace: 'nowrap' }}>
          <div style={{ opacity: hover || open ? 1 : 0, transition: 'opacity var(--dur-fast) var(--ease)' }}>
            <ActionRow actions={acts} onRun={onRun} />
          </div>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={cols.length + 1} style={{
            padding: '14px 18px 18px', borderTop: '1px solid var(--c-hairline)',
            background: 'rgba(255,255,255,0.02)',
          }}>
            <EntityDetail e={e} actions={acts} onRun={onRun} />
          </td>
        </tr>
      )}
    </>
  )
}

/** Things whose identity is visual. Thumbnails when the provider gave one; type-led when not. */
function GridView({ v, onRun }: LayoutProps) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14,
    }}>
      {v.entities.map((e, i) => {
        const thumb = e.fields.find(f => f.key === 'thumbnail' && typeof f.value === 'string')?.value as string | undefined
        return (
          <div key={`${e.id}-${i}`} style={{
            display: 'flex', flexDirection: 'column', gap: 8,
            animation: `slideUp var(--dur) var(--ease) ${Math.min(i, 12) * 26}ms both`,
          }}>
            <div style={{
              aspectRatio: '16 / 9', borderRadius: 'var(--c-radius)', overflow: 'hidden',
              background: 'var(--c-glass)', border: '1px solid var(--c-hairline)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {thumb
                ? <img src={thumb} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <span style={{
                    fontSize: 'var(--t-micro)', fontWeight: 700, letterSpacing: '0.12em',
                    textTransform: 'uppercase', color: 'var(--c-dim-deep)',
                  }}>{e.kind}</span>}
            </div>
            <span style={{
              fontSize: 'var(--t-ui)', fontWeight: 600, color: 'var(--c-text-soft)', lineHeight: 1.4,
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}>{e.title}</span>
            {e.subtitle && (
              <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim)' }}>{e.subtitle}</span>
            )}
            <ActionRow actions={v.actions[e.id] ?? []} onRun={a => onRun(e, a)} align="flex-start" />
          </div>
        )
      })}
    </div>
  )
}

/**
 * Places and routes. No map tiles: this app is offline-first and a tile request is a network call
 * the user did not ask for. An address-forward card with a real Directions action is both more
 * honest and more useful than a decorative static map.
 */
function MapView({ v, onRun }: LayoutProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {v.entities.map((e, i) => {
        const loc = pickField(e, 'location')
        const dur = pickField(e, 'duration')
        const dist = pickField(e, 'quantity')
        return (
          <div key={`${e.id}-${i}`} style={{
            display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px',
            borderRadius: 'var(--c-radius)', background: 'var(--c-glass)',
            border: '1px solid var(--c-hairline)', boxShadow: 'var(--c-inset-highlight)',
            animation: `slideUp var(--dur) var(--ease) ${Math.min(i, 10) * 26}ms both`,
          }}>
            <span style={{
              width: 3, alignSelf: 'stretch', borderRadius: 2, minHeight: 30,
              background: tint(KIND_ACCENT.place, 0.5), flexShrink: 0,
            }} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 'var(--t-body)', fontWeight: 600, color: 'var(--c-text)' }}>{e.title}</span>
              {(loc || e.subtitle) && (
                <span style={{
                  fontSize: 'var(--t-small)', color: 'var(--c-dim)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{e.subtitle || String(loc!.value)}</span>
              )}
            </div>
            {(dur || dist) && (
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2,
                fontVariantNumeric: 'tabular-nums', flexShrink: 0,
              }}>
                {dur && <span style={{ fontSize: 'var(--t-ui)', fontWeight: 700, color: 'var(--c-text-soft)' }}>{String(dur.value)}</span>}
                {dist && <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)' }}>{String(dist.value)}</span>}
              </div>
            )}
            <ActionRow actions={v.actions[e.id] ?? []} onRun={a => onRun(e, a)} />
          </div>
        )
      })}
    </div>
  )
}

/**
 * Empty is a DESIGNED state, not a shrug.
 *
 * cont.105b shipped "your inbox is empty" as prose the model invented after being handed a blob
 * it could not read. Here emptiness is a rendered fact: it states what was asked and which source
 * was consulted, so "nothing matched" is visibly different from "I never looked" — which is
 * precisely the cont.104 failure where a fabricated answer was stamped verified.
 */
function EmptyView({ v }: { v: ViewSpec }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
      padding: '38px 24px', textAlign: 'center', animation: 'fadeIn var(--dur) var(--ease)',
    }}>
      <span style={{
        width: 30, height: 30, borderRadius: '50%',
        border: '1px solid var(--c-hairline-strong)', flexShrink: 0,
      }} />
      <span style={{ fontSize: 'var(--t-body)', fontWeight: 600, color: 'var(--c-text-soft)' }}>
        {v.notice ?? 'Nothing came back.'}
      </span>
      <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)', maxWidth: 340, lineHeight: 1.55 }}>
        This is a real result, not a guess — the search ran and returned nothing.
      </span>
    </div>
  )
}

// ── The renderer ─────────────────────────────────────────────────────────────

interface LayoutProps {
  v: ViewSpec
  onRun: (e: Entity, a: BoundAffordance) => void
  expanded: string | null
  setExpanded: (id: string | null) => void
}

export default function SurfaceRenderer({ view, runAction, compact }: {
  view: ViewSpec
  runAction: RunAction
  /** Drops the header when the surface is already inside a titled container. */
  compact?: boolean
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pending, setPending] = useState<{ entity: Entity; affordance: BoundAffordance } | null>(null)
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4200)
    return () => clearTimeout(t)
  }, [toast])

  /**
   * `confirmed` is asserted ONLY on the path that actually went through the sheet. The server
   * re-checks the effect class against its own registry and rejects anything above `read` without
   * it, so the transport must not rubber-stamp this flag — a client that always sent `true` would
   * turn the server-side gate back into the React-only confirmation it exists to replace.
   */
  async function invoke(entity: Entity, affordance: BoundAffordance, input?: Record<string, string>, confirmed = false) {
    try {
      const out = await runAction({ entity, affordanceId: affordance.id, input, confirmed })
      setToast({ text: out?.slice(0, 180) || `${affordance.label} done.`, ok: true })
    } catch (err: unknown) {
      setToast({ text: err instanceof Error ? err.message : String(err), ok: false })
    } finally {
      setPending(null)
    }
  }

  /**
   * THE SAFETY GATE. Anything above `read`, and anything needing input, goes through the sheet.
   * A read action with resolved arguments is the ONLY thing that runs on a click — and the
   * protocol already guarantees a `send` affordance carries no pre-bound arguments.
   */
  function onRun(entity: Entity, a: BoundAffordance) {
    if (a.requiresConfirmation || (a.inputs?.length ?? 0) > 0 || a.args === null) {
      setPending({ entity, affordance: a })
      return
    }
    void invoke(entity, a)
  }

  const props: LayoutProps = { v: view, onRun, expanded, setExpanded }

  const body = (() => {
    switch (view.layout) {
      case 'empty': return <EmptyView v={view} />
      case 'detail': {
        const e = view.entities[0]
        return e ? <EntityDetail e={e} actions={view.actions[e.id] ?? []} onRun={a => onRun(e, a)} /> : <EmptyView v={view} />
      }
      case 'agenda': return <AgendaView {...props} />
      case 'table': return <TableView {...props} />
      case 'grid': return <GridView {...props} />
      case 'map': return <MapView {...props} />
      case 'list':
      default: return <ListView {...props} />
    }
  })()

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0,
      // The project rule: the page never scrolls sideways. Containment is here, once.
      maxWidth: '100%', overflowX: 'hidden',
    }}>
      {!compact && view.layout !== 'empty' && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
          <span style={{ fontSize: 'var(--t-ui)', fontWeight: 700, color: 'var(--c-text)' }}>{view.title}</span>
          <span style={{ flex: 1, height: 1, background: 'var(--c-hairline)' }} />
        </div>
      )}

      {body}

      {/* Provenance. Quiet, always present, never in the way — the answer to "where did this
          come from" should never require asking. */}
      {view.sources.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap',
          paddingTop: 9, borderTop: '1px solid var(--c-hairline)',
          fontSize: 'var(--t-micro)', letterSpacing: '0.08em', textTransform: 'uppercase',
          color: 'var(--c-dim-deep)', fontWeight: 600,
        }}>
          <span style={{ width: 4, height: 4, borderRadius: '50%', background: ON_DEVICE, flexShrink: 0 }} />
          {view.sources.join(' · ')}
        </div>
      )}

      {pending && (
        <ActionSheet
          entity={pending.entity}
          affordance={pending.affordance}
          onCancel={() => setPending(null)}
          onConfirm={input => invoke(pending.entity, pending.affordance, input, true)}
        />
      )}

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 600,
          maxWidth: 'min(520px, calc(100vw - 48px))', padding: '11px 16px', borderRadius: 12,
          background: '#16161e', border: `1px solid ${tint(toast.ok ? ON_DEVICE : ERROR, 0.4)}`,
          boxShadow: '0 16px 48px rgba(0,0,0,0.5)', animation: 'panelUp var(--dur) var(--ease)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{
            width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
            background: toast.ok ? ON_DEVICE : ERROR,
          }} />
          <span style={{
            fontSize: 'var(--t-ui)', color: 'var(--c-text-soft)', lineHeight: 1.5,
            overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box',
            WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
          }}>{toast.text}</span>
        </div>
      )}
    </div>
  )
}

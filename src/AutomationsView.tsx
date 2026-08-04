// ── Automations page (Assistant layer step 1 — ASSISTANT_SPEC.md §2.3) ─────────
// Standing tasks: trigger + brief + delivery. Left: the roster table + create flow.
// Right: the Digest — recent run results, newest first. All data lives server-side
// (.crucible/automations.json); runs execute through the same agent loop as Mission
// Control, so a run-now also shows up there. No profiles, no emojis, tokens only.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, SectionLabel, GhostButton, PrimaryButton, StatusChip } from './ui'
import { API_BASE, apiFetch } from './api'
import RunDetailOverlay, { type RunRef } from './RunDetailOverlay'
import { parseAutomation, describeTrigger, type Trigger } from './design/automationParse'

interface RunRec { ts: number; status: 'ok' | 'failed'; summary: string; ms: number }
interface Automation {
  id: string; name: string; brief: string; trigger: Trigger
  delivery: 'digest' | 'push'; enabled: boolean; createdAt: number
  lastRuns: RunRec[]; consecutiveFailures: number; nextRun: number | null
}
interface DigestEntry extends RunRec { automationId: string; name: string }

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function fmtWhen(ts: number): string {
  const d = new Date(ts)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const day = new Date(ts); day.setHours(0, 0, 0, 0)
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (day.getTime() === today.getTime()) return hm
  if (day.getTime() === today.getTime() + 86400_000) return `tomorrow ${hm}`
  if (day.getTime() === today.getTime() - 86400_000) return `yesterday ${hm}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`
}

/** Client-side next-3-runs preview for the create form (mirrors server math). */
function previewRuns(t: Trigger, n = 3): number[] {
  const out: number[] = []
  let from = Date.now()
  for (let i = 0; i < n; i++) {
    let next: number | null = null
    if (t.kind === 'interval') next = from + Math.max(1, t.minutes) * 60_000
    else if (t.kind === 'once') { next = t.at > from ? t.at : null }
    else {
      const [h, m] = t.time.split(':').map(Number)
      if (Number.isNaN(h) || Number.isNaN(m)) return out
      const d = new Date(from); d.setHours(h, m, 0, 0)
      if (t.kind === 'daily') { if (d.getTime() <= from) d.setDate(d.getDate() + 1) }
      else if (t.kind === 'weekdays') {
        // Mon-Fri: step forward until the next weekday strictly after `from`.
        if (d.getTime() <= from) d.setDate(d.getDate() + 1)
        while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
      }
      else { let delta = (t.day - d.getDay() + 7) % 7; if (delta === 0 && d.getTime() <= from) delta = 7; d.setDate(d.getDate() + delta) }
      next = d.getTime()
    }
    if (next == null) break
    out.push(next); from = next
  }
  return out
}

// Status is INFORMATION, not decoration (2026-08-04b). This used to return five
// saturated hues — indigo running, green ok, amber failed-last, red failing, grey off —
// so a roster of six automations was six different colours before you read a word. Now
// everything that is FINE is the same muted slate and says what it is in words; only a
// real failure is allowed a hue, which is what makes a failure visible at a glance
// instead of competing with four other colours for attention.
function statusOf(a: Automation, running: string | null): { label: string; color: string; pulse?: boolean } {
  if (running === a.id) return { label: 'running', color: 'var(--glass-text-2)', pulse: true }
  if (!a.enabled) return a.consecutiveFailures >= 3
    ? { label: 'paused · failing', color: 'var(--alarm-ink)' }
    : { label: 'off', color: 'var(--glass-text-3)' }
  const last = a.lastRuns[0]
  if (last?.status === 'failed') return { label: 'failed last run', color: 'var(--alarm-ink)' }
  return { label: last ? 'ok' : 'scheduled', color: 'var(--glass-text-3)' }
}

const inputStyle: React.CSSProperties = {
  background: 'var(--glass-fill-plate)', border: '1px solid var(--glass-edge)', borderRadius: 10,
  color: 'var(--glass-text)', fontFamily: 'inherit', fontSize: 'var(--t-ui)', padding: '8px 11px', outline: 'none',
}

// ── Create: one sentence, then a summary you can correct ──────────────────────
// REBUILT 2026-08-04c. What was here asked for five decisions before you could save:
// pick one of three templates, type a name, write a multi-sentence "brief", choose one
// of four trigger kinds and configure it, then decide "digest" vs "digest + push" —
// terms the app never defined. It read as a config form for a cron daemon.
//
// It is now one box and one button. You write the thing you'd say out loud; the schedule,
// the title and the delivery are DERIVED (design/automationParse.ts, 39/39 bench) and
// shown back as three chips you can click to correct. Inference without a visible,
// correctable summary would just be a different kind of opaque — so the chips ARE the
// design, not decoration. Nothing is hidden and nothing must be filled in twice.

function Chip({ label, value, assumed, onClick, children }: {
  label: string; value: string; assumed?: boolean
  onClick?: () => void; children?: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
      <span style={{
        font: '600 10px/1 var(--mono)', letterSpacing: '0.12em', textTransform: 'uppercase',
        color: 'var(--glass-text-3)',
      }}>{label}</span>
      {children ?? (
        <button
          onClick={onClick}
          title={assumed ? 'Assumed — click to set it yourself' : 'Click to change'}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 7, alignSelf: 'flex-start',
            maxWidth: '100%', minWidth: 0, cursor: 'pointer', fontFamily: 'inherit',
            padding: '7px 12px', borderRadius: 10,
            background: 'var(--glass-fill-plate)',
            // A dashed edge marks a value nothing in the sentence asked for. It is the
            // one honest way to show "this is my assumption" without a paragraph of copy.
            border: assumed ? '1px dashed var(--glass-edge)' : '1px solid var(--glass-edge)',
            color: assumed ? 'var(--glass-text-2)' : 'var(--glass-text)',
            fontSize: 13, fontWeight: 600, textAlign: 'left',
          }}
        >
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden style={{ flexShrink: 0, opacity: 0.5 }}>
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  )
}

function CreateForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [sentence, setSentence] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Overrides start null and only fill in when the user corrects a chip, so edits are
  // never clobbered by the next keystroke re-parsing the sentence.
  const [nameOverride, setNameOverride] = useState<string | null>(null)
  const [triggerOverride, setTriggerOverride] = useState<Trigger | null>(null)
  const [deliveryOverride, setDeliveryOverride] = useState<'digest' | 'push' | null>(null)
  const [editing, setEditing] = useState<'name' | 'when' | null>(null)

  const parsed = useMemo(() => parseAutomation(sentence), [sentence])
  const name = nameOverride ?? parsed.name
  const trigger = triggerOverride ?? parsed.trigger
  const delivery = deliveryOverride ?? parsed.delivery
  const ready = sentence.trim().length >= 8

  const create = async () => {
    if (!ready || saving) return
    setSaving(true); setErr(null)
    try {
      const res = await apiFetch(`${API_BASE}/api/automations`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        // The BRIEF is the user's sentence, untouched — the planner still infers the
        // workflow from it. We only ever derive when it runs and what it is called.
        body: JSON.stringify({ name: name.trim().slice(0, 80), brief: sentence.trim(), trigger, delivery }),
      })
      if (!res.ok) { setErr((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`); return }
      onCreated()
    } catch (e: any) { setErr(String(e?.message ?? e)) }
    finally { setSaving(false) }
  }

  const next = previewRuns(trigger, 2)

  return (
    <Card style={{ padding: '18px 18px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <textarea
        value={sentence}
        onChange={e => setSentence(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) create() }}
        rows={2}
        autoFocus
        placeholder="Tell me what to keep an eye on"
        style={{
          ...inputStyle, resize: 'none', width: '100%', boxSizing: 'border-box',
          fontSize: 16, lineHeight: 1.5, padding: '12px 14px', minHeight: 62,
        }}
      />

      {ready && (
        <>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {editing === 'when' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 260px', minWidth: 0 }}>
                <span style={{ font: '600 10px/1 var(--mono)', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--glass-text-3)' }}>When</span>
                <TriggerEditor value={trigger} onChange={t => { if (t) setTriggerOverride(t) }} />
                <button onClick={() => setEditing(null)} style={{ ...inputStyle, cursor: 'pointer', alignSelf: 'flex-start', padding: '5px 12px', fontSize: 12 }}>Done</button>
              </div>
            ) : (
              <Chip
                label="When"
                value={describeTrigger(trigger)}
                assumed={!parsed.scheduleExplicit && !triggerOverride}
                onClick={() => setEditing('when')}
              />
            )}

            {editing === 'name' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 200px', minWidth: 0 }}>
                <span style={{ font: '600 10px/1 var(--mono)', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--glass-text-3)' }}>Called</span>
                <input
                  autoFocus value={name} maxLength={80}
                  onChange={e => setNameOverride(e.target.value)}
                  onBlur={() => setEditing(null)}
                  onKeyDown={e => { if (e.key === 'Enter') setEditing(null) }}
                  style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}
                />
              </div>
            ) : (
              <Chip label="Called" value={name} onClick={() => setEditing('name')} />
            )}

            <Chip
              label="Tells me"
              value={delivery === 'push' ? 'With a notification' : 'In the digest'}
              assumed={!parsed.deliveryExplicit && !deliveryOverride}
              onClick={() => setDeliveryOverride(delivery === 'push' ? 'digest' : 'push')}
            />
          </div>

          {next.length > 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--glass-text-3)', fontVariantNumeric: 'tabular-nums' }}>
              First run {fmtWhen(next[0])}{next[1] ? `, then ${fmtWhen(next[1])}` : ''}
            </div>
          )}
        </>
      )}

      {err && <div style={{ fontSize: 12.5, color: 'var(--alarm-ink)' }}>{err}</div>}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <PrimaryButton onClick={create} disabled={!ready || saving}>{saving ? 'Saving…' : 'Start watching'}</PrimaryButton>
        <GhostButton onClick={onCancel}>Cancel</GhostButton>
      </div>
    </Card>
  )
}

/** Inline trigger editor — the same controls as the create form, reusable for editing. */
function TriggerEditor({ value, onChange }: { value: Trigger; onChange: (t: Trigger | null) => void }) {
  const [kind, setKind] = useState<Trigger['kind']>(value.kind)
  const [time, setTime] = useState(value.kind === 'daily' || value.kind === 'weekly' ? value.time : '08:00')
  const [day, setDay] = useState(value.kind === 'weekly' ? value.day : 1)
  const [minutes, setMinutes] = useState(value.kind === 'interval' ? value.minutes : 120)
  // Editing an existing 'once' trigger must seed the datetime field — an empty init
  // emitted null and Row.save() silently dropped the trigger patch (the "my edit
  // didn't stick" bug). datetime-local wants local time, not the UTC ISO string.
  const [onceAt, setOnceAt] = useState(() => {
    if (value.kind !== 'once') return ''
    const d = new Date(value.at)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  })

  useEffect(() => {
    if (kind === 'interval') onChange(minutes >= 1 ? { kind, minutes } : null)
    else if (kind === 'daily') onChange(/^\d{1,2}:\d{2}$/.test(time) ? { kind, time } : null)
    else if (kind === 'weekly') onChange(/^\d{1,2}:\d{2}$/.test(time) ? { kind, day, time } : null)
    else {
      const at = onceAt ? new Date(onceAt).getTime() : NaN
      onChange(Number.isFinite(at) && at > Date.now() ? { kind: 'once', at } : null)
    }
  }, [kind, time, day, minutes, onceAt])  // eslint-disable-line react-hooks/exhaustive-deps

  const selStyle = (active: boolean): React.CSSProperties => ({
    ...inputStyle, cursor: 'pointer', padding: '5px 10px', fontSize: 'var(--t-small)',
    borderColor: active ? 'var(--glass-edge-2)' : 'var(--glass-edge)',
    background: active ? 'var(--glass-fill-2)' : 'var(--glass-fill-plate)',
    color: active ? 'var(--glass-text)' : 'var(--glass-text-3)',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(['daily', 'weekly', 'interval', 'once'] as const).map(k => (
          <button key={k} onClick={() => setKind(k)} style={selStyle(kind === k)}>{k}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {kind === 'weekly' && (
          <select value={day} onChange={e => setDay(Number(e.target.value))} style={{ ...inputStyle, cursor: 'pointer' }}>
            {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
        )}
        {(kind === 'daily' || kind === 'weekly') && (
          <input type="time" value={time} onChange={e => setTime(e.target.value)} style={inputStyle} />
        )}
        {kind === 'interval' && (
          <>
            <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim)' }}>every</span>
            <input type="number" min={5} max={10080} value={minutes} onChange={e => setMinutes(Number(e.target.value))} style={{ ...inputStyle, width: 70 }} />
            <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim)' }}>minutes</span>
          </>
        )}
        {kind === 'once' && (
          <input type="datetime-local" value={onceAt} onChange={e => setOnceAt(e.target.value)} style={inputStyle} />
        )}
      </div>
    </div>
  )
}

function Row({ a, running, onToggle, onRunNow, onDelete, onSave, onOpenRun }: {
  a: Automation; running: string | null
  onToggle: () => void; onRunNow: () => void; onDelete: () => void
  onSave: (patch: { brief?: string; trigger?: Trigger }) => Promise<void>
  onOpenRun: (r: RunRef) => void
}) {
  const st = statusOf(a, running)
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [briefDraft, setBriefDraft] = useState(a.brief)
  const [triggerDraft, setTriggerDraft] = useState<Trigger | null>(a.trigger)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (saving) return
    setSaving(true)
    try {
      await onSave({
        ...(briefDraft.trim().length >= 8 && briefDraft.trim() !== a.brief ? { brief: briefDraft.trim() } : {}),
        ...(triggerDraft ? { trigger: triggerDraft } : {}),
      })
      setEditing(false)
    } finally { setSaving(false) }
  }

  return (
    <Card style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Whole header row is the expand target — a bigger tap target than the name alone. */}
      <div
        role="button" tabIndex={0}
        onClick={() => setExpanded(v => !v)}
        onKeyDown={e => { if (e.key === 'Enter') setExpanded(v => !v) }}
        style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', flexWrap: 'wrap' }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: st.color, flexShrink: 0, animation: st.pulse ? 'dotpulse 1.2s ease-in-out infinite' : undefined }} />
        <span style={{ fontSize: 'var(--t-body)', fontWeight: 600, color: 'var(--c-text)', overflowWrap: 'anywhere' }}>{a.name}</span>
        <StatusChip color={st.color} pulse={st.pulse}>{st.label}</StatusChip>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim)', whiteSpace: 'nowrap' }}>{describeTrigger(a.trigger)}</span>
        {a.enabled && a.nextRun != null && (
          <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>next {fmtWhen(a.nextRun)}</span>
        )}
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden style={{
          flexShrink: 0, color: 'var(--glass-text-3)',
          transform: expanded ? 'rotate(180deg)' : 'none',
          transition: 'transform var(--dur-fast) var(--ease-standard)',
        }}>
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {expanded && !editing && (
        <div style={{ fontSize: 'var(--t-ui)', color: 'var(--c-dim)', lineHeight: 1.6, overflowWrap: 'anywhere', paddingLeft: 19 }}>
          {a.brief}
        </div>
      )}

      {expanded && editing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingLeft: 19 }}>
          <textarea
            value={briefDraft} onChange={e => setBriefDraft(e.target.value)} rows={5}
            style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.55, minHeight: 90, width: '100%', boxSizing: 'border-box' }}
          />
          <TriggerEditor value={a.trigger} onChange={setTriggerDraft} />
          <div style={{ display: 'flex', gap: 8 }}>
            <PrimaryButton onClick={save} disabled={saving || briefDraft.trim().length < 8}>{saving ? 'Saving…' : 'Save changes'}</PrimaryButton>
            <GhostButton onClick={() => { setEditing(false); setBriefDraft(a.brief); setTriggerDraft(a.trigger) }}>Cancel</GhostButton>
          </div>
        </div>
      )}

      {/* Run history — every past run is a door to its full result. */}
      {expanded && !editing && a.lastRuns.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 19 }}>
          <SectionLabel style={{ marginBottom: 4 }}>Runs</SectionLabel>
          {a.lastRuns.slice(0, 8).map(r => (
            <div
              key={r.ts} role="button" tabIndex={0}
              onClick={() => onOpenRun({ automationId: a.id, ts: r.ts, name: a.name })}
              onKeyDown={e => { if (e.key === 'Enter') onOpenRun({ automationId: a.id, ts: r.ts, name: a.name }) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', margin: '0 -8px',
                borderRadius: 8, cursor: 'pointer',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: r.status === 'ok' ? 'var(--glass-text-3)' : 'var(--alarm-ink)', flexShrink: 0 }} />
              <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtWhen(r.ts)}</span>
              <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.summary}</span>
              <span style={{ fontSize: 10, color: 'var(--c-dim-deep)', flexShrink: 0 }}>open ›</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', paddingLeft: 19, flexWrap: 'wrap' }}>
        <GhostButton onClick={onRunNow} title="Run this brief through the agent loop now">Run now</GhostButton>
        {expanded && !editing && <GhostButton onClick={() => { setEditing(true); setBriefDraft(a.brief); setTriggerDraft(a.trigger) }}>Edit</GhostButton>}
        <GhostButton onClick={onToggle}>{a.enabled ? 'Pause' : 'Resume'}</GhostButton>
        {!confirmDelete
          ? <GhostButton onClick={() => setConfirmDelete(true)} title="Delete this automation">Delete</GhostButton>
          : (
            <>
              <GhostButton onClick={onDelete} title="This cannot be undone" style={{ color: 'var(--alarm-ink)', borderColor: 'var(--alarm-edge)' }}>Confirm delete</GhostButton>
              <GhostButton onClick={() => setConfirmDelete(false)}>Keep</GhostButton>
            </>
          )}
        <div style={{ flex: 1 }} />
        {a.lastRuns[0] && (
          <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)', fontVariantNumeric: 'tabular-nums' }}>
            last {fmtWhen(a.lastRuns[0].ts)} · {(a.lastRuns[0].ms / 1000).toFixed(0)}s
          </span>
        )}
      </div>
    </Card>
  )
}

export default function AutomationsView({ onClose, onFollowUp }: {
  onClose: () => void
  /** Prefill the chat composer with text and return to chat — wired by App. */
  onFollowUp?: (text: string, convId?: string) => void
}) {
  const [list, setList] = useState<Automation[]>([])
  const [digest, setDigest] = useState<DigestEntry[]>([])
  const [running, setRunning] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [openRun, setOpenRun] = useState<RunRef | null>(null)
  // Mobile: roster + digest stack as switchable panes instead of side-by-side columns.
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 700px)').matches)
  const [pane, setPane] = useState<'roster' | 'digest'>('roster')
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 700px)')
    const h = (e: MediaQueryListEvent) => setNarrow(e.matches)
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [aRes, dRes] = await Promise.all([
        apiFetch(`${API_BASE}/api/automations`, { credentials: 'include' }),
        apiFetch(`${API_BASE}/api/automations/digest`, { credentials: 'include' }),
      ])
      if (aRes.ok) { const j = await aRes.json(); setList(j.automations ?? []); setRunning(j.running ?? null) }
      if (dRes.ok) setDigest((await dRes.json()).entries ?? [])
    } catch { /* server restarting — next poll catches up */ }
    setLoaded(true)
  }, [])

  useEffect(() => {
    void refresh()
    const iv = setInterval(refresh, 15_000)   // light poll — automations move slowly
    return () => clearInterval(iv)
  }, [refresh])

  const patch = async (id: string, body: object) => {
    await apiFetch(`${API_BASE}/api/automations/${id}`, {
      method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => {})
    void refresh()
  }
  const runNow = async (id: string) => {
    await apiFetch(`${API_BASE}/api/automations/${id}/run`, { method: 'POST', credentials: 'include' }).catch(() => {})
    void refresh()
  }
  const del = async (id: string) => {
    await apiFetch(`${API_BASE}/api/automations/${id}`, { method: 'DELETE', credentials: 'include' }).catch(() => {})
    void refresh()
  }

  const anyRunning = running != null

  return (
    <div style={{
      // Was an opaque `--c-bg` slab, which is why this page looked like a different app
      // dropped on top of Crucible: every other surface is frosted over the ambient
      // field, and this one alone was flat. Same scrim + blur as the rest of the shell.
      position: 'absolute', inset: 0, zIndex: 30,
      background: 'var(--scrim)', backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)',
      display: 'flex', flexDirection: 'column', animation: 'panelUp 0.22s var(--ease)',
    }}>
      {/* Header — WRAPS (2026-08-04b). Title + pane toggle + Close could not fit on one
          375px line, so "Close" was clipped by the screen edge: the way out of the page
          was literally off it. flexWrap plus a shrinkable title means the controls drop
          to a second row instead of overflowing, at any width and any label length. */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: `calc(var(--titlebar-clearance) + 14px) 16px 14px`,
        borderBottom: '1px solid var(--glass-edge)',
      }}>
        <span style={{
          fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--glass-text)',
          minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>Automations</span>
        {/* The status chip yields on narrow — the header must fit title + pane toggle + Close. */}
        {!narrow && (anyRunning
          ? <StatusChip color="var(--glass-text-2)" pulse>running</StatusChip>
          : list.some(a => a.enabled)
            ? <StatusChip color="var(--glass-text-3)">{list.filter(a => a.enabled).length} scheduled</StatusChip>
            : null)}
        <div style={{ flex: 1 }} />
        {narrow && (
          <div style={{ display: 'flex', gap: 4 }}>
            <GhostButton active={pane === 'roster'} onClick={() => setPane('roster')}>Tasks</GhostButton>
            <GhostButton active={pane === 'digest'} onClick={() => setPane('digest')}>Digest{digest.length ? ` · ${digest.length}` : ''}</GhostButton>
          </div>
        )}
        {!creating && !narrow && <PrimaryButton onClick={() => setCreating(true)}>New automation</PrimaryButton>}
        <GhostButton onClick={onClose} title="Back to chat">Close</GhostButton>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* Roster */}
        {(!narrow || pane === 'roster') && (
        <div style={{ flex: 1.5, minWidth: 0, overflowY: 'auto', padding: narrow ? '14px 14px 24px' : '18px 22px 24px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 760 }}>
            {creating && <CreateForm onCreated={() => { setCreating(false); void refresh() }} onCancel={() => setCreating(false)} />}
            {loaded && list.length === 0 && !creating && (
              <Card style={{ padding: '28px 24px', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
                <span style={{ fontSize: 'var(--t-body)', fontWeight: 600, color: 'var(--c-text)' }}>No standing tasks yet</span>
                <span style={{ fontSize: 'var(--t-ui)', color: 'var(--c-dim)', lineHeight: 1.6, maxWidth: 520 }}>
                  An automation is a brief the agent runs on a schedule — a daily summary, a weekly folder
                  cleanup, a site check every few hours. Results land in the Digest; failures are surfaced,
                  never silent.
                </span>
                <PrimaryButton onClick={() => setCreating(true)} style={{ marginTop: 6 }}>Create your first</PrimaryButton>
              </Card>
            )}
            {narrow && !creating && (
              <PrimaryButton onClick={() => setCreating(true)}>New automation</PrimaryButton>
            )}
            {list.map(a => (
              <Row
                key={a.id} a={a} running={running}
                onToggle={() => void patch(a.id, { enabled: !a.enabled })}
                onRunNow={() => void runNow(a.id)}
                onDelete={() => void del(a.id)}
                onSave={async p => { await patch(a.id, p) }}
                onOpenRun={setOpenRun}
              />
            ))}
          </div>
        </div>
        )}

        {/* Digest — every card opens the run's full result. */}
        {(!narrow || pane === 'digest') && (
        <div style={{
          width: narrow ? '100%' : 380, flexShrink: 0,
          borderLeft: narrow ? 'none' : '1px solid var(--glass-edge)',
          overflowY: 'auto', padding: narrow ? '14px 14px 24px' : '18px 18px 24px',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <SectionLabel>Digest</SectionLabel>
          {digest.length === 0 && (
            <span style={{ fontSize: 'var(--t-ui)', color: 'var(--c-dim-deep)' }}>Run results will appear here.</span>
          )}
          {digest.map((e, i) => (
            <Card
              key={`${e.automationId}:${e.ts}:${i}`}
              accent={e.status === 'ok' ? undefined : 'var(--alarm-ink)'}
              onClick={() => setOpenRun({ automationId: e.automationId, ts: e.ts, name: e.name })}
              style={{ padding: '11px 13px', display: 'flex', flexDirection: 'column', gap: 6, cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: e.status === 'ok' ? 'var(--glass-text-3)' : 'var(--alarm-ink)', flexShrink: 0 }} />
                <span style={{ fontSize: 'var(--t-ui)', fontWeight: 600, color: 'var(--c-text)', overflowWrap: 'anywhere' }}>{e.name}</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmtWhen(e.ts)}</span>
              </div>
              <div style={{
                fontSize: 'var(--t-small)', color: 'var(--c-dim)', lineHeight: 1.55, overflowWrap: 'anywhere',
                display: '-webkit-box', WebkitLineClamp: 6, WebkitBoxOrient: 'vertical', overflow: 'hidden',
              }}>{e.summary}</div>
              <span style={{ fontSize: 10.5, color: 'var(--glass-text-3)' }}>Open full result</span>
            </Card>
          ))}
        </div>
        )}
      </div>

      {openRun && (
        <RunDetailOverlay
          runRef={openRun}
          onClose={() => setOpenRun(null)}
          onFollowUp={onFollowUp ? (t, c) => { setOpenRun(null); onFollowUp(t, c) } : undefined}
        />
      )}
    </div>
  )
}

// ── Automations page (Assistant layer step 1 — ASSISTANT_SPEC.md §2.3) ─────────
// Standing tasks: trigger + brief + delivery. Left: the roster table + create flow.
// Right: the Digest — recent run results, newest first. All data lives server-side
// (.crucible/automations.json); runs execute through the same agent loop as Mission
// Control, so a run-now also shows up there. No profiles, no emojis, tokens only.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, SectionLabel, GhostButton, PrimaryButton, StatusChip } from './ui'
import { API_BASE, apiFetch } from './api'

type Trigger =
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; day: number; time: string }
  | { kind: 'once'; at: number }

interface RunRec { ts: number; status: 'ok' | 'failed'; summary: string; ms: number }
interface Automation {
  id: string; name: string; brief: string; trigger: Trigger
  delivery: 'digest' | 'push'; enabled: boolean; createdAt: number
  lastRuns: RunRec[]; consecutiveFailures: number; nextRun: number | null
}
interface DigestEntry extends RunRec { automationId: string; name: string }

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function describeTrigger(t: Trigger): string {
  switch (t.kind) {
    case 'interval': return t.minutes % 60 === 0 ? `every ${t.minutes / 60}h` : `every ${t.minutes}m`
    case 'daily': return `daily at ${t.time}`
    case 'weekly': return `${DAYS[t.day]}s at ${t.time}`
    case 'once': return `once, ${new Date(t.at).toLocaleString()}`
  }
}

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
      else { let delta = (t.day - d.getDay() + 7) % 7; if (delta === 0 && d.getTime() <= from) delta = 7; d.setDate(d.getDate() + delta) }
      next = d.getTime()
    }
    if (next == null) break
    out.push(next); from = next
  }
  return out
}

function statusOf(a: Automation, running: string | null): { label: string; color: string; pulse?: boolean } {
  if (running === a.id) return { label: 'running', color: '#7c7cf8', pulse: true }
  if (!a.enabled) return a.consecutiveFailures >= 3 ? { label: 'paused · failing', color: '#f87171' } : { label: 'off', color: '#55556a' }
  const last = a.lastRuns[0]
  if (last?.status === 'failed') return { label: 'failed last run', color: '#f59e0b' }
  return { label: last ? 'ok' : 'scheduled', color: '#4db89e' }
}

const inputStyle: React.CSSProperties = {
  background: 'rgba(0,0,0,0.3)', border: '1px solid var(--c-hairline)', borderRadius: 9,
  color: 'var(--c-text)', fontFamily: 'inherit', fontSize: 'var(--t-ui)', padding: '7px 10px', outline: 'none',
}

// Templates are PREFILLS, not workflow profiles — the planner still infers the
// workflow from the brief text (standing rule: no predefined profiles).
const TEMPLATES: Array<{ label: string; name: string; brief: string; kind: 'daily' | 'weekly'; time: string; day?: number }> = [
  {
    label: 'Morning brief',
    name: 'Morning brief',
    brief: 'Use calendar_list to get today\'s events and gmail_search (query: "newer_than:1d in:inbox") to get the last day\'s inbox. Write a compact morning brief: schedule first, then notable emails (sender — subject — why it matters), then anything that needs a reply today. Plain text, no filler.',
    kind: 'daily', time: '08:00',
  },
  {
    label: 'Inbox triage',
    name: 'Inbox triage',
    brief: 'Use gmail_search (query: "newer_than:1d in:inbox") and gmail_read on anything ambiguous. Group the last day\'s email into: needs a reply, worth reading, ignorable. One line each with sender and subject. Do not send or modify anything.',
    kind: 'daily', time: '17:30',
  },
  {
    label: 'Weekly cleanup',
    name: 'Weekly downloads cleanup',
    brief: 'List the files in ~/Downloads older than 30 days with their sizes. Report the total reclaimable space and the ten largest offenders. Do not delete anything — report only.',
    kind: 'weekly', time: '10:00', day: 6,
  },
]

function CreateForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [brief, setBrief] = useState('')
  const [kind, setKind] = useState<Trigger['kind']>('daily')
  const [time, setTime] = useState('08:00')
  const [day, setDay] = useState(1)
  const [minutes, setMinutes] = useState(120)
  const [onceAt, setOnceAt] = useState('')
  const [delivery, setDelivery] = useState<'digest' | 'push'>('digest')
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const trigger: Trigger | null = useMemo(() => {
    if (kind === 'interval') return minutes >= 1 ? { kind, minutes } : null
    if (kind === 'daily') return /^\d{1,2}:\d{2}$/.test(time) ? { kind, time } : null
    if (kind === 'weekly') return /^\d{1,2}:\d{2}$/.test(time) ? { kind, day, time } : null
    const at = onceAt ? new Date(onceAt).getTime() : NaN
    return Number.isFinite(at) && at > Date.now() ? { kind: 'once', at } : null
  }, [kind, time, day, minutes, onceAt])

  const preview = trigger ? previewRuns(trigger) : []
  const valid = !!trigger && name.trim().length > 0 && brief.trim().length >= 8

  const create = async () => {
    if (!valid || saving) return
    setSaving(true); setErr(null)
    try {
      const res = await apiFetch(`${API_BASE}/api/automations`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), brief: brief.trim(), trigger, delivery }),
      })
      if (!res.ok) { setErr((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`); return }
      onCreated()
    } catch (e: any) { setErr(String(e?.message ?? e)) }
    finally { setSaving(false) }
  }

  const selStyle = (active: boolean): React.CSSProperties => ({
    ...inputStyle, cursor: 'pointer', padding: '6px 11px',
    borderColor: active ? 'rgba(124,124,248,0.45)' : 'var(--c-hairline)',
    background: active ? 'rgba(124,124,248,0.12)' : 'rgba(0,0,0,0.3)',
    color: active ? '#b0b0f8' : 'var(--c-dim)',
  })

  return (
    <Card accent="#7c7cf8" style={{ padding: '16px 18px', display: 'flex', gap: 18 }}>
      {/* Left: what */}
      <div style={{ flex: 1.2, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <SectionLabel>New automation</SectionLabel>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {TEMPLATES.map(t => (
            <button
              key={t.label}
              onClick={() => {
                setName(t.name); setBrief(t.brief); setKind(t.kind); setTime(t.time)
                if (t.day != null) setDay(t.day)
              }}
              style={{ ...inputStyle, cursor: 'pointer', padding: '5px 11px', color: 'var(--c-dim)', fontSize: 'var(--t-small)' }}
              title="Prefill — edit anything before creating"
            >{t.label}</button>
          ))}
        </div>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Name — e.g. Morning brief" maxLength={80} style={inputStyle} />
        <textarea
          value={brief} onChange={e => setBrief(e.target.value)} rows={5}
          placeholder="The brief — exactly what the agent should do each run, as if you typed it into Mission Control."
          style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.55, minHeight: 96 }}
        />
      </div>
      {/* Right: when + delivery */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <SectionLabel>Trigger</SectionLabel>
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
              <span style={{ fontSize: 'var(--t-ui)', color: 'var(--c-dim)' }}>every</span>
              <input type="number" min={5} max={10080} value={minutes} onChange={e => setMinutes(Number(e.target.value))} style={{ ...inputStyle, width: 76 }} />
              <span style={{ fontSize: 'var(--t-ui)', color: 'var(--c-dim)' }}>minutes</span>
            </>
          )}
          {kind === 'once' && (
            <input type="datetime-local" value={onceAt} onChange={e => setOnceAt(e.target.value)} style={inputStyle} />
          )}
        </div>
        <SectionLabel style={{ marginTop: 2 }}>Delivery</SectionLabel>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setDelivery('digest')} style={selStyle(delivery === 'digest')} title="Results land in the Digest feed only">digest</button>
          <button onClick={() => setDelivery('push')} style={selStyle(delivery === 'push')} title="Also send a push notification per run">digest + push</button>
        </div>
        {preview.length > 0 && (
          <div style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.6 }}>
            Next runs: {preview.map(fmtWhen).join(' · ')}
          </div>
        )}
        {err && <div style={{ fontSize: 'var(--t-small)', color: '#f87171' }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 'auto', justifyContent: 'flex-end' }}>
          <GhostButton onClick={onCancel}>Cancel</GhostButton>
          <PrimaryButton onClick={create} disabled={!valid || saving}>{saving ? 'Creating…' : 'Create automation'}</PrimaryButton>
        </div>
      </div>
    </Card>
  )
}

function Row({ a, running, onToggle, onRunNow, onDelete }: {
  a: Automation; running: string | null
  onToggle: () => void; onRunNow: () => void; onDelete: () => void
}) {
  const st = statusOf(a, running)
  const [expanded, setExpanded] = useState(false)
  return (
    <Card style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: st.color, flexShrink: 0, animation: st.pulse ? 'dotpulse 1.2s ease-in-out infinite' : undefined }} />
        <span
          role="button" tabIndex={0} onClick={() => setExpanded(v => !v)}
          onKeyDown={e => { if (e.key === 'Enter') setExpanded(v => !v) }}
          style={{ fontSize: 'var(--t-body)', fontWeight: 600, color: 'var(--c-text)', cursor: 'pointer', overflowWrap: 'anywhere' }}
        >{a.name}</span>
        <StatusChip color={st.color} pulse={st.pulse}>{st.label}</StatusChip>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim)', whiteSpace: 'nowrap' }}>{describeTrigger(a.trigger)}</span>
        {a.enabled && a.nextRun != null && (
          <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>next {fmtWhen(a.nextRun)}</span>
        )}
      </div>
      {expanded && (
        <div style={{ fontSize: 'var(--t-ui)', color: 'var(--c-dim)', lineHeight: 1.6, overflowWrap: 'anywhere', paddingLeft: 19 }}>
          {a.brief}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', paddingLeft: 19 }}>
        <GhostButton onClick={onRunNow} title="Run this brief through the agent loop now">Run now</GhostButton>
        <GhostButton onClick={onToggle}>{a.enabled ? 'Pause' : 'Resume'}</GhostButton>
        <GhostButton onClick={onDelete} title="Delete this automation">Delete</GhostButton>
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

export default function AutomationsView({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<Automation[]>([])
  const [digest, setDigest] = useState<DigestEntry[]>([])
  const [running, setRunning] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [loaded, setLoaded] = useState(false)

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
      position: 'absolute', inset: 0, zIndex: 30, background: 'var(--c-bg)',
      display: 'flex', flexDirection: 'column', animation: 'panelUp 0.22s var(--ease)',
    }}>
      {/* Header */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12,
        padding: `calc(var(--titlebar-clearance) + 14px) 20px 14px`,
        borderBottom: '1px solid var(--c-hairline)',
      }}>
        <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--c-text)' }}>Automations</span>
        {anyRunning
          ? <StatusChip color="#7c7cf8" pulse>running</StatusChip>
          : list.some(a => a.enabled)
            ? <StatusChip color="#4db89e">{list.filter(a => a.enabled).length} scheduled</StatusChip>
            : null}
        <div style={{ flex: 1 }} />
        {!creating && <PrimaryButton onClick={() => setCreating(true)}>New automation</PrimaryButton>}
        <GhostButton onClick={onClose} title="Back to chat">Close</GhostButton>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* Roster */}
        <div style={{ flex: 1.5, minWidth: 0, overflowY: 'auto', padding: '18px 22px 24px' }}>
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
            {list.map(a => (
              <Row
                key={a.id} a={a} running={running}
                onToggle={() => void patch(a.id, { enabled: !a.enabled })}
                onRunNow={() => void runNow(a.id)}
                onDelete={() => void del(a.id)}
              />
            ))}
          </div>
        </div>

        {/* Digest */}
        <div style={{
          width: 380, flexShrink: 0, borderLeft: '1px solid var(--c-hairline)',
          overflowY: 'auto', padding: '18px 18px 24px', display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <SectionLabel>Digest</SectionLabel>
          {digest.length === 0 && (
            <span style={{ fontSize: 'var(--t-ui)', color: 'var(--c-dim-deep)' }}>Run results will appear here.</span>
          )}
          {digest.map((e, i) => (
            <Card key={`${e.automationId}:${e.ts}:${i}`} accent={e.status === 'ok' ? '#4db89e' : '#f87171'} style={{ padding: '11px 13px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: e.status === 'ok' ? '#4db89e' : '#f87171', flexShrink: 0 }} />
                <span style={{ fontSize: 'var(--t-ui)', fontWeight: 600, color: 'var(--c-text)', overflowWrap: 'anywhere' }}>{e.name}</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmtWhen(e.ts)}</span>
              </div>
              <div style={{
                fontSize: 'var(--t-small)', color: 'var(--c-dim)', lineHeight: 1.55, overflowWrap: 'anywhere',
                display: '-webkit-box', WebkitLineClamp: 6, WebkitBoxOrient: 'vertical', overflow: 'hidden',
              }}>{e.summary}</div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}

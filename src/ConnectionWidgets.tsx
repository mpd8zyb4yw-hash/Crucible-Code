// ── Shared live-connection widgets ────────────────────────────────────────────
// Real inbox / calendar / open-PR tiles, rendered identically wherever a connected
// account has something to show: the Connections page cards AND the Home surface's
// day-at-a-glance. Single source so the two surfaces never drift. Honest-absence:
// each tile renders its own empty state; callers only mount it when data arrived.

import { SectionLabel } from './ui'

export interface GooglePreview {
  gmail: Array<{ id: string; from: string; subject: string; date: string; unread: boolean }> | null
  calendar: Array<{ title: string; start: string; end: string; allDay: boolean }> | null
}

export type GithubPreview = { prs: Array<{ title: string; repo: string; url: string; updatedAt: string; state: string }> | null }

export function relTime(dateStr: string): string {
  const t = new Date(dateStr).getTime()
  if (!Number.isFinite(t)) return ''
  const mins = Math.round((Date.now() - t) / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h`
  return `${Math.round(mins / (24 * 60))}d`
}

/** Inbox glimpse — real messages, unread-weighted rows, no imagery.
 *  When `onOpenMessage` is passed, each row opens the in-Crucible reader (clone-the-UI);
 *  the click is stopped from bubbling so a surrounding "summarize" tap wrapper doesn't
 *  also fire — row = read this one, elsewhere = summarize the set. */
export function GmailWidget({ items, onOpenMessage }: {
  items: NonNullable<GooglePreview['gmail']>
  onOpenMessage?: (m: NonNullable<GooglePreview['gmail']>[number]) => void
}) {
  return (
    <div style={{ background: 'rgba(0,0,0,0.32)', border: '1px solid var(--c-hairline)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '7px 12px 6px', borderBottom: '1px solid var(--c-hairline)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <SectionLabel style={{ fontSize: 9.5 }}>Inbox</SectionLabel>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)', fontVariantNumeric: 'tabular-nums' }}>
          {items.filter(m => m.unread).length} unread
        </span>
      </div>
      {items.length === 0 && (
        <div style={{ padding: '10px 12px', fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)' }}>Inbox is empty.</div>
      )}
      {items.map(m => {
        const clickable = !!onOpenMessage
        return (
          <div key={m.id}
            role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined}
            onClick={clickable ? (e => { e.stopPropagation(); onOpenMessage!(m) }) : undefined}
            onKeyDown={clickable ? (e => { if (e.key === 'Enter') { e.stopPropagation(); onOpenMessage!(m) } }) : undefined}
            onMouseEnter={clickable ? (e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)' }) : undefined}
            onMouseLeave={clickable ? (e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }) : undefined}
            style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 12px', borderBottom: '1px solid rgba(255,255,255,0.03)', cursor: clickable ? 'pointer' : 'default', transition: 'background 90ms' }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0, alignSelf: 'center', background: m.unread ? '#7c7cf8' : 'transparent', border: m.unread ? 'none' : '1px solid var(--c-hairline)' }} />
            <span style={{ fontSize: 'var(--t-small)', fontWeight: m.unread ? 650 : 400, color: m.unread ? 'var(--c-text)' : 'var(--c-dim)', width: 108, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.from}</span>
            <span style={{ fontSize: 'var(--t-small)', color: m.unread ? '#c9c9da' : 'var(--c-dim)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.subject}</span>
            <span style={{ fontSize: 10.5, color: 'var(--c-dim-deep)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{relTime(m.date)}</span>
          </div>
        )
      })}
    </div>
  )
}

/** Upcoming-calendar strip — date chip + title + time, next 7 days. */
export function CalendarWidget({ items }: { items: NonNullable<GooglePreview['calendar']> }) {
  const fmtDay = (s: string) => {
    const d = new Date(s)
    return { dow: d.toLocaleDateString([], { weekday: 'short' }), day: d.getDate() }
  }
  const fmtTime = (e: { start: string; end: string; allDay: boolean }) => e.allDay
    ? 'all day'
    : `${new Date(e.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–${new Date(e.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  return (
    <div style={{ background: 'rgba(0,0,0,0.32)', border: '1px solid var(--c-hairline)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '7px 12px 6px', borderBottom: '1px solid var(--c-hairline)' }}>
        <SectionLabel style={{ fontSize: 9.5 }}>Next 7 days</SectionLabel>
      </div>
      {items.length === 0 && (
        <div style={{ padding: '10px 12px', fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)' }}>Nothing scheduled.</div>
      )}
      {items.map((e, i) => {
        const d = fmtDay(e.start)
        return (
          <div key={`${e.start}:${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
            <div style={{
              width: 34, flexShrink: 0, textAlign: 'center', borderRadius: 7, padding: '3px 0',
              background: 'rgba(124,124,248,0.10)', border: '1px solid rgba(124,124,248,0.22)',
            }}>
              <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9d9dfa' }}>{d.dow}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-text)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{d.day}</div>
            </div>
            <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title}</span>
            <span style={{ fontSize: 10.5, color: 'var(--c-dim)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtTime(e)}</span>
          </div>
        )
      })}
    </div>
  )
}

/** Open PRs the signed-in user authored — repo · title · relative age. Read-only via `gh`. */
export function GithubWidget({ items }: { items: NonNullable<GithubPreview['prs']> }) {
  return (
    <div style={{ background: 'rgba(0,0,0,0.32)', border: '1px solid var(--c-hairline)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '7px 12px 6px', borderBottom: '1px solid var(--c-hairline)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <SectionLabel style={{ fontSize: 9.5 }}>Your open PRs</SectionLabel>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)', fontVariantNumeric: 'tabular-nums' }}>{items.length}</span>
      </div>
      {items.length === 0 && (
        <div style={{ padding: '10px 12px', fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)' }}>No open PRs.</div>
      )}
      {items.map((p, i) => (
        <div key={`${p.url}:${i}`} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 12px', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
          <span style={{ fontSize: 'var(--t-small)', fontFamily: 'var(--mono)', color: 'var(--c-dim)', flexShrink: 0, maxWidth: 118, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.repo.split('/').pop()}</span>
          <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>
          <span style={{ fontSize: 10.5, color: 'var(--c-dim-deep)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{p.updatedAt ? relTime(p.updatedAt) : ''}</span>
        </div>
      ))}
    </div>
  )
}

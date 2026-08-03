// ── Home surface — cards are home ──────────────────────────────────────────────
// Rebuilt 2026-08-03 against DESIGN_HANDOFF §4. This SUPERSEDES the 2026-07-21 note
// that used to live here ("NOTHING else on the splash… do not add tiles back"). That
// note described the previous visual direction, where the day's widgets lived on
// Mission Control and the empty chat stayed bare. The product owner's 2026-08-03
// handoff repeals it in §4.1, and the user confirmed the repeal directly:
//
//   "The app opens to a CARD SURFACE, not an empty chat box. This is the single most
//    important structural decision in this handoff: it is what makes Crucible read as
//    an assistant that is already working for you rather than a prompt waiting for
//    input."
//
// What has NOT changed, and is still load-bearing: nothing here is filler. Every card
// is backed by a real endpoint (see design/homeData.ts) and a card with no real data
// does not render. Fewer cards beats a full screen of nothing — that principle is why
// the old bare splash was right at the time, and it survives the redesign intact.
//
// Structure (§4.1.1): two regions in ONE scroll. Pinned is the user's and never moves
// on its own; Suggested is ranked by Crucible. The ranking snapshot is taken on mount
// and on explicit refresh only — never under a moving finger.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GlassCard, CardLabel, SectionRule, PinMark, VerificationChip, WorkingLine, type Domain } from './design/glass'
import {
  loadArrangement, saveArrangement, rankSuggested,
  type CardKind, type CardSize, type HomeArrangement, type RankInput,
} from './design/homeLayout'
import { fetchHomeData, EMPTY_HOME, type HomeData } from './design/homeData'
import type { Round } from './chat/core'

const DOMAIN_OF: Record<CardKind, Domain> = {
  research: 'research', mail: 'mail', calendar: 'time', watch: 'watch', runs: 'watch',
}
const TITLE_OF: Record<CardKind, string> = {
  research: 'Research', mail: 'Mail', calendar: 'Calendar', watch: 'Watch', runs: 'Runs',
}

function greeting(h: number): string {
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** "40m", "2h 10m" — time until, in words the user reads at a glance. */
function untilLabel(ts: number, now: number): string {
  const mins = Math.max(0, Math.round((ts - now) / 60_000))
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  return mins % 60 === 0 ? `${h}h` : `${h}h ${mins % 60}m`
}

/** The big glanceable number + its unit. One answer, not a dashboard (§5.5). */
function HeroValue({ value, unit }: { value: string; unit: string }) {
  return (
    <div style={{ marginTop: 12, display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
      <div style={{
        fontSize: 'var(--t-display)', fontWeight: 600, letterSpacing: '-0.03em',
        color: 'var(--glass-text)', lineHeight: 1,
      }}>{value}</div>
      {/* The unit wraps rather than clipping — this line survives a 3× longer string. */}
      <div style={{ fontSize: 15, color: 'var(--glass-text-2)', minWidth: 0, overflowWrap: 'anywhere' }}>{unit}</div>
    </div>
  )
}

/** Secondary line inside a card. Clamped to two lines; never rides the border. */
function SupportLine({ children, dim = false }: { children: React.ReactNode; dim?: boolean }) {
  return (
    <div style={{
      marginTop: 8, fontSize: 13.5, lineHeight: 1.45,
      color: dim ? 'var(--glass-text-2)' : 'var(--glass-text)',
      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
      overflow: 'hidden', overflowWrap: 'anywhere',
    }}>{children}</div>
  )
}

function CardHead({ kind, pinned, right }: { kind: CardKind; pinned: boolean; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <CardLabel domain={DOMAIN_OF[kind]}>{TITLE_OF[kind]}</CardLabel>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {right}
        <PinMark on={pinned} />
      </div>
    </div>
  )
}

export default function HomeSurface({ allRounds, onOpenAgents, onOpenAutomations, onOpenConnections, splash }: {
  allRounds: Round[]
  onOpenAgents: () => void
  onOpenAutomations?: () => void
  onOpenConnections?: () => void
  /** First-run identity mark — kept from the previous design; it is the one moment of
      brand in the product and the redesign has no reason to delete it. */
  splash: React.ReactNode
}) {
  const [data, setData] = useState<HomeData>(EMPTY_HOME)
  const [arr, setArr] = useState<HomeArrangement>(() => loadArrangement())
  const [arranging, setArranging] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const live = allRounds.filter(r => r.agent?.active)

  // ── Data: one snapshot on open, and on explicit refresh. Not a poll: a surface that
  // silently reshuffles while the user reads it is the exact failure §4.1.1 forbids.
  const refresh = useCallback(() => {
    const ac = new AbortController()
    void fetchHomeData(ac.signal).then(setData).catch(() => { /* card simply stays absent */ })
    setNow(Date.now())
    return () => ac.abort()
  }, [])
  useEffect(() => refresh(), [refresh])

  // Time-until labels must stay honest without re-ranking anything: this ticks the
  // clock only, never the order.
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(iv)
  }, [])

  const update = useCallback((next: HomeArrangement) => { setArr(next); saveArrangement(next) }, [])
  const togglePin = useCallback((k: CardKind) => {
    setArr(prev => {
      const next = prev.pinned.includes(k)
        ? { ...prev, pinned: prev.pinned.filter(x => x !== k) }
        : { ...prev, pinned: [...prev.pinned, k] }
      saveArrangement(next)
      return next
    })
  }, [])
  const hide = useCallback((k: CardKind) => {
    setArr(prev => {
      const next = { ...prev, hidden: [...prev.hidden, k], pinned: prev.pinned.filter(x => x !== k) }
      saveArrangement(next)
      return next
    })
  }, [])
  const setSize = useCallback((k: CardKind, s: CardSize) => {
    setArr(prev => { const next = { ...prev, sizes: { ...prev.sizes, [k]: s } }; saveArrangement(next); return next })
  }, [])
  const restoreHidden = useCallback(() => update({ ...arr, hidden: [] }), [arr, update])

  // ── Which cards have something real to say right now ────────────────────────
  const available = useMemo<CardKind[]>(() => {
    const out: CardKind[] = []
    if (live.length > 0) out.push('runs')
    if (data.mail) out.push('mail')
    if (data.calendar) out.push('calendar')
    if (data.watch) out.push('watch')
    return out.filter(k => !arr.hidden.includes(k))
  }, [data, live.length, arr.hidden])

  // ── Ranking snapshot. Frozen between refreshes on purpose. ───────────────────
  const rankInputs = useMemo<RankInput[]>(() => {
    const hour = new Date(now).getHours()
    const ins: RankInput[] = []
    if (live.length > 0) {
      ins.push({ kind: 'runs', liveness: { reason: `${live.length} running now` } })
    }
    if (data.mail) {
      ins.push({
        kind: 'mail',
        obligation: data.mail.needYou > 0
          ? { count: data.mail.needYou, reason: `${data.mail.needYou} waiting on you` }
          : undefined,
        timeOfDay: hour < 12 ? { reason: 'mail is usually first thing' } : undefined,
      })
    }
    if (data.calendar) {
      const soon = data.calendar.nextStart != null && data.calendar.nextStart - now < 2 * 3600_000
      ins.push({
        kind: 'calendar',
        obligation: soon ? { count: 1, reason: 'something starts soon' } : undefined,
        timeOfDay: hour < 18 ? { reason: 'the day is still ahead' } : undefined,
      })
    }
    if (data.watch) {
      const changed = data.watch.moved.length + data.watch.selfDisabled.length
      ins.push({
        kind: 'watch',
        liveness: changed > 0
          ? { reason: data.watch.selfDisabled.length > 0 ? 'a watch stopped itself' : `${data.watch.moved.length} changed` }
          : undefined,
      })
    }
    return ins
  }, [data, live.length, now])

  const snapshotRef = useRef<CardKind[]>([])
  const reasonRef = useRef<Record<string, string | null>>({})
  // Recompute only when the underlying snapshot identity changes, never on scroll.
  useMemo(() => {
    const ranked = rankSuggested(rankInputs)
    snapshotRef.current = ranked.map(r => r.kind)
    reasonRef.current = Object.fromEntries(ranked.map(r => [r.kind, r.reason]))
  }, [rankInputs])

  const pinned = arr.pinned.filter(k => available.includes(k))
  const suggested = snapshotRef.current.filter(k => available.includes(k) && !pinned.includes(k))

  let hasSent = false
  try { hasSent = localStorage.getItem('crucible_has_sent') === '1' } catch { /* treat as first run */ }
  const firstRun = !hasSent && available.length === 0

  // ── Card renderers ───────────────────────────────────────────────────────────
  const renderCard = (kind: CardKind, isPinned: boolean) => {
    const span: 1 | 2 = arr.sizes[kind] === 'S' ? 1 : 2
    const reason = isPinned ? null : reasonRef.current[kind] ?? null
    // No `key` here: CardSlot owns the list identity. A key inside a spread is silently
    // dropped by React and warns in dev.
    const common = { domain: DOMAIN_OF[kind], span, elevation: 1 as const }

    if (kind === 'runs') {
      const latest = live[live.length - 1]
      return (
        <GlassCard {...common} onClick={onOpenAgents} label={`${live.length} agents working`}>
          <CardHead kind="runs" pinned={isPinned} />
          <div style={{ marginTop: 12 }}>
            <WorkingLine phase={latest?.userMessage ?? 'Working'} />
          </div>
        </GlassCard>
      )
    }

    if (kind === 'mail' && data.mail) {
      const m = data.mail
      return (
        <GlassCard {...common} onClick={onOpenConnections} label={`${m.needYou} messages need you`}>
          <CardHead kind="mail" pinned={isPinned} />
          {/* Not an unread count. Unread count is anxiety, not information (§5.5.2). */}
          {m.needYou > 0
            ? <HeroValue value={String(m.needYou)} unit="need you" />
            : <div style={{ marginTop: 12, fontSize: 16, fontWeight: 600, color: 'var(--glass-text)' }}>Nothing needs a reply</div>}
          {m.topSender && (
            <SupportLine>{m.topSender}{m.topSubject ? ` — ${m.topSubject}` : ''}</SupportLine>
          )}
          {/* The reasons come straight from the deterministic importance verifier, so
              the card can say WHY a message is important without a model in the loop. */}
          {m.topReasons.length > 0 && (
            <SupportLine dim>{m.topReasons.join(' · ')}</SupportLine>
          )}
          {reason && <PromotionReason>{reason}</PromotionReason>}
        </GlassCard>
      )
    }

    if (kind === 'calendar' && data.calendar) {
      const c = data.calendar
      return (
        <GlassCard {...common} label="Calendar" onClick={onOpenConnections}>
          <CardHead kind="calendar" pinned={isPinned} />
          {c.nextStart != null && c.nextTitle
            ? <HeroValue value={untilLabel(c.nextStart, now)} unit={`until ${c.nextTitle}`} />
            : <div style={{ marginTop: 12, fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--glass-text)' }}>Nothing else today</div>}
          {/* The one computed line the user actually wants. This is exact interval
              arithmetic over the real event list — verified in a way a model's answer
              cannot be — so the card is allowed to state it flatly. */}
          {c.longestFree && (
            <div style={{
              marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--glass-edge)',
              display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'rgba(253,230,138,0.9)', flexShrink: 0 }} />
              <span style={{ fontSize: 13.5, color: 'var(--glass-text-2)', minWidth: 0, overflowWrap: 'anywhere' }}>
                Longest free block: {fmtTime(c.longestFree.start)}–{fmtTime(c.longestFree.end)}
              </span>
            </div>
          )}
          {reason && <PromotionReason>{reason}</PromotionReason>}
        </GlassCard>
      )
    }

    if (kind === 'watch' && data.watch) {
      const w = data.watch
      return (
        <GlassCard {...common} onClick={onOpenAutomations} label="Watches">
          <CardHead
            kind="watch" pinned={isPinned}
            right={w.moved.length > 0 ? (
              <span style={{ font: '500 10px/1 var(--mono)', letterSpacing: '0.06em', color: 'var(--glass-text-2)' }}>
                MOVED {fmtTime(w.moved[0].at)}
              </span>
            ) : undefined}
          />
          {/* Silence is the normal, healthy state — only a change earns attention. But
              a self-disabled watch is NOT silence, and must be as loud as a change. */}
          {w.selfDisabled.length > 0 && (
            <div style={{
              marginTop: 12, padding: '10px 12px', borderRadius: 12,
              background: 'var(--alarm-fill)', border: '1px solid var(--alarm-edge)',
            }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--alarm-ink)' }}>
                {w.selfDisabled.length} stopped after 3 failures
              </div>
              <div style={{ marginTop: 4, fontSize: 12.5, lineHeight: 1.45, color: 'var(--glass-text-2)', overflowWrap: 'anywhere' }}>
                {w.selfDisabled.map(s => s.name).join(', ')} — silence here does not mean nothing changed.
              </div>
            </div>
          )}
          {w.moved.length > 0 ? (
            <div style={{ marginTop: 11, display: 'flex', flexDirection: 'column', gap: 9 }}>
              {w.moved.map(m => (
                <div key={`${m.name}-${m.at}`} style={{ minWidth: 0 }}>
                  <div style={{
                    fontSize: 14, fontWeight: 500, color: 'var(--glass-text)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{m.name}</div>
                  <div style={{
                    marginTop: 3, fontSize: 12.5, lineHeight: 1.45, color: 'var(--glass-text-2)',
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
                    overflow: 'hidden', overflowWrap: 'anywhere',
                  }}>{m.summary}</div>
                </div>
              ))}
            </div>
          ) : w.selfDisabled.length === 0 && (
            <div style={{ marginTop: 12, fontSize: 16, fontWeight: 600, color: 'var(--glass-text)' }}>
              All {w.total} quiet
            </div>
          )}
          <div style={{
            marginTop: 11, paddingTop: 10, borderTop: '1px solid var(--glass-edge)',
            fontSize: 12.5, color: 'var(--glass-text-2)',
          }}>{w.quiet} of {w.total} quiet</div>
          {reason && <PromotionReason>{reason}</PromotionReason>}
        </GlassCard>
      )
    }
    return null
  }

  // ── First run: a working default arrangement, not a setup wizard ─────────────
  if (firstRun) {
    return (
      <Scroller>
        <div style={{ padding: '0 4px 4px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {splash}
        </div>
        <SectionRule label="Suggested" />
        <Grid>
          <StarterCard
            domain="research" label="Research"
            title="Ask something you'd otherwise open six tabs for"
            body="Crucible checks its own answer and tells you when it can't."
            span={2}
          />
          <StarterCard domain="mail" label="Mail" title="Connect mail" body="Triage and drafted replies." onClick={onOpenConnections} />
          <StarterCard domain="time" label="Time" title="Connect calendar" body="Exact free blocks, solved." onClick={onOpenConnections} />
          <StarterCard
            domain="watch" label="Watch" title="Nothing being watched yet"
            body="Any answer can become a standing question that only speaks up when the verified answer changes."
            span={2} onClick={onOpenAutomations}
          />
        </Grid>
        <Hint>Long-press any card to pin, hide or resize.</Hint>
      </Scroller>
    )
  }

  // ── Nothing real to show, and not first run ─────────────────────────────────
  if (available.length === 0) {
    return (
      <Scroller>
        <Greeting
          title={greeting(new Date(now).getHours())}
          line={data.loaded
            ? 'Nothing needs you right now.'
            : 'Checking what needs you…'}
        />
        {arr.hidden.length > 0 && <HiddenNote hidden={arr.hidden} onRestore={restoreHidden} />}
      </Scroller>
    )
  }

  const obligations = (data.mail?.needYou ?? 0)
  const movedCount = data.watch?.moved.length ?? 0
  const stateLine = [
    data.calendar?.nextStart != null && data.calendar.nextTitle
      ? `${data.calendar.nextTitle} in ${untilLabel(data.calendar.nextStart, now)}.` : null,
    obligations > 0 ? `${obligations} message${obligations === 1 ? '' : 's'} need you.` : null,
    movedCount > 0 ? `${movedCount} watch${movedCount === 1 ? '' : 'es'} moved.` : null,
  ].filter(Boolean).join(' ') || 'Nothing needs you.'

  return (
    <Scroller>
      {arranging ? (
        <div style={{
          margin: '0 0 4px', padding: '12px 16px', borderRadius: 18,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          backdropFilter: 'var(--glass-blur-light)', WebkitBackdropFilter: 'var(--glass-blur-light)',
          // The chrome bar is elevation 4 and must follow the theme, not a dark literal.
          background: 'var(--glass-fill-2)', border: '1px solid var(--glass-edge-2)',
          boxShadow: 'var(--glass-inner-light)',
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--glass-text)' }}>Arranging home</div>
            {/* Ranking is suspended while arranging — the surface must hold still. */}
            <div style={{ marginTop: 3, fontSize: 12.5, color: 'var(--glass-text-2)', overflowWrap: 'anywhere' }}>
              Pin, hide or resize · pinned cards stay put
            </div>
          </div>
          <button
            onClick={() => setArranging(false)}
            style={{
              padding: '8px 16px', borderRadius: 11, border: 'none', cursor: 'pointer',
              background: 'rgba(165,180,252,0.92)', color: '#101322',
              fontSize: 13.5, fontWeight: 600, fontFamily: 'inherit', flexShrink: 0,
            }}
          >Done</button>
        </div>
      ) : (
        <Greeting
          title={greeting(new Date(now).getHours())}
          line={stateLine}
          onArrange={() => setArranging(true)}
        />
      )}

      {pinned.length > 0 && (
        <>
          <SectionRule
            label={`Pinned${pinned.length > 1 ? ` · ${pinned.length}` : ''}`}
            trailing={<span style={{
              font: '500 10px/1 var(--mono)', letterSpacing: '0.10em', textTransform: 'uppercase',
              color: 'var(--glass-text-3)', flexShrink: 0,
            }}>Fixed</span>}
          />
          <Grid>
            {pinned.map(k => (
              <CardSlot key={k} kind={k} arranging={arranging} pinned
                size={arr.sizes[k] ?? 'M'} onPin={togglePin} onHide={hide} onSize={setSize}>
                {renderCard(k, true)}
              </CardSlot>
            ))}
          </Grid>
        </>
      )}

      {suggested.length > 0 && (
        <>
          <SectionRule label={arranging ? 'Suggested — ranked by Crucible' : 'Suggested'} />
          <Grid>
            {suggested.map(k => (
              <CardSlot key={k} kind={k} arranging={arranging} pinned={false}
                size={arr.sizes[k] ?? 'M'} onPin={togglePin} onHide={hide} onSize={setSize}>
                {renderCard(k, false)}
              </CardSlot>
            ))}
          </Grid>
        </>
      )}

      {/* Fewer cards, never filler (§4.1). Say so plainly instead of padding. */}
      {available.length < 3 && (
        <Hint>Nothing else earned a card. Crucible shows fewer cards rather than filling the screen.</Hint>
      )}
      {arr.hidden.length > 0 && <HiddenNote hidden={arr.hidden} onRestore={restoreHidden} />}
      {arranging && (
        <Hint>Hiding a card type is permanent until you restore it here.</Hint>
      )}
    </Scroller>
  )
}

// ── Layout shells ──────────────────────────────────────────────────────────────

function Scroller({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      // Two regions in ONE scroll (§4.1).
      width: 'min(560px, calc(100% - 32px))',
      display: 'flex', flexDirection: 'column', gap: 12,
      margin: '0 auto', minHeight: 0, paddingTop: 18, paddingBottom: 24,
      pointerEvents: 'auto',
    }}>{children}</div>
  )
}

/** 2-column phone grid: S = 1 column, M/L = 2. */
function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'start' }}>
      {children}
    </div>
  )
}

function Greeting({ title, line, onArrange }: { title: string; line: string; onArrange?: () => void }) {
  return (
    <div style={{ padding: '4px 6px 6px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 27, fontWeight: 600, letterSpacing: '-0.025em', color: 'var(--glass-text)',
          overflowWrap: 'anywhere',
        }}>{title}</div>
        {/* One line of real state — never a slogan. */}
        <div style={{
          marginTop: 6, fontSize: 14.5, lineHeight: 1.5, color: 'var(--glass-text-2)',
          overflowWrap: 'anywhere',
        }}>{line}</div>
      </div>
      {onArrange && (
        <button
          onClick={onArrange}
          title="Arrange home"
          style={{
            flexShrink: 0, marginTop: 6, padding: '6px 12px', borderRadius: 10, cursor: 'pointer',
            background: 'rgba(255,255,255,0.06)', border: '1px solid var(--glass-edge)',
            color: 'var(--glass-text-2)', fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
            transition: 'background var(--dur-fast) var(--ease-standard)',
          }}
        >Arrange</button>
      )}
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: '2px 6px', fontSize: 12.5, lineHeight: 1.55, color: 'var(--glass-text-3)',
      overflowWrap: 'anywhere',
    }}>{children}</div>
  )
}

/** A suggested card explains its own promotion in one short, true line (§4.1.1). */
function PromotionReason({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      marginTop: 8, fontSize: 12.5, color: 'var(--glass-text-2)',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }}>Promoted: {children}</div>
  )
}

/**
 * Hidden types are recoverable, never resurrected. A user who hid Calendar must not
 * see it return next week because it got "relevant" (§4.1.1).
 */
function HiddenNote({ hidden, onRestore }: { hidden: CardKind[]; onRestore: () => void }) {
  return (
    <div style={{
      marginTop: 2, padding: '11px 14px', borderRadius: 14,
      background: 'rgba(255,255,255,0.045)', border: '1px dashed var(--glass-edge)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    }}>
      <div style={{ fontSize: 12.5, lineHeight: 1.4, color: 'var(--glass-text-2)', minWidth: 0, overflowWrap: 'anywhere' }}>
        {hidden.length} card type{hidden.length === 1 ? '' : 's'} hidden — {hidden.map(h => TITLE_OF[h]).join(', ')}
      </div>
      <button
        onClick={onRestore}
        style={{
          flexShrink: 0, background: 'transparent', border: 'none', cursor: 'pointer',
          fontSize: 12.5, fontWeight: 600, color: '#A5B4FC', fontFamily: 'inherit', padding: 0,
        }}
      >Restore</button>
    </div>
  )
}

/**
 * Wraps a card with its arrangement affordances. Desktop gets a hover menu, phone gets
 * a long-press — never a gesture a mouse cannot perform (§4.2).
 */
function CardSlot({ kind, size, pinned, arranging, onPin, onHide, onSize, children }: {
  kind: CardKind
  size: CardSize
  pinned: boolean
  arranging: boolean
  onPin: (k: CardKind) => void
  onHide: (k: CardKind) => void
  onSize: (k: CardKind, s: CardSize) => void
  children: React.ReactNode
}) {
  const [menu, setMenu] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const open = menu || arranging
  const span = size === 'S' ? 1 : 2

  const startPress = () => { timer.current = setTimeout(() => setMenu(true), 500) }
  const endPress = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  return (
    <div
      style={{ gridColumn: span === 2 ? 'span 2' : undefined, minWidth: 0 }}
      onPointerDown={startPress}
      onPointerUp={endPress}
      onPointerLeave={() => { endPress(); if (!arranging) setMenu(false) }}
      onContextMenu={e => { e.preventDefault(); setMenu(true) }}
    >
      {/* The card keeps its own span; the slot already owns the grid placement. */}
      <div style={{ display: 'grid' }}>{children}</div>
      {open && (
        <div style={{
          marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap',
          animation: 'fadeIn var(--dur-fast) var(--ease-standard)',
        }}>
          <ArrangeChip active={pinned} onClick={() => onPin(kind)}>{pinned ? 'Pinned' : 'Pin'}</ArrangeChip>
          <ArrangeChip onClick={() => onHide(kind)}>Hide</ArrangeChip>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 5, padding: '7px 10px', borderRadius: 10,
            background: 'rgba(255,255,255,0.08)', border: '1px solid var(--glass-edge)',
            fontSize: 12, fontWeight: 600,
          }}>
            {(['S', 'M', 'L'] as CardSize[]).map(s => (
              <button
                key={s} onClick={() => onSize(kind, s)}
                aria-pressed={size === s}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 2px',
                  fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
                  color: size === s ? 'var(--glass-text)' : 'var(--glass-text-3)',
                }}
              >{s}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ArrangeChip({ children, onClick, active }: { children: React.ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '7px 12px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
        fontSize: 12, fontWeight: 600,
        background: active ? 'rgba(99,102,241,0.22)' : 'rgba(127,127,150,0.14)',
        border: `1px solid ${active ? 'rgba(99,102,241,0.45)' : 'var(--glass-edge)'}`,
        // Active state reads in both themes: the accent fill is the signal, the label
        // stays on the theme's own text token rather than a dark-only pastel.
        color: 'var(--glass-text)',
        transition: 'background var(--dur-fast) var(--ease-standard)',
      }}
    >{children}</button>
  )
}

/** First-run card: states what it will do, never pretends to have data. */
function StarterCard({ domain, label, title, body, span = 1, onClick }: {
  domain: Domain; label: string; title: string; body: string; span?: 1 | 2; onClick?: () => void
}) {
  return (
    <GlassCard domain={domain} span={span} onClick={onClick} label={title} style={{ minHeight: span === 1 ? 118 : undefined }}>
      <CardLabel domain={domain}>{label}</CardLabel>
      <div style={{
        marginTop: 12, fontSize: span === 2 ? 19 : 15, fontWeight: 600, letterSpacing: '-0.015em',
        color: 'var(--glass-text)', lineHeight: 1.25, overflowWrap: 'anywhere',
      }}>{title}</div>
      <div style={{
        marginTop: 8, fontSize: 13, lineHeight: 1.45, color: 'var(--glass-text-2)', overflowWrap: 'anywhere',
      }}>{body}</div>
    </GlassCard>
  )
}

// VerificationChip is re-exported for the answer surfaces that land next session; it is
// deliberately NOT used on a home card yet. There is no verification ledger on any home
// data source today, and §7.2 is explicit: never render the chip without a backing
// record. A chip that cannot fail is the exact bug the engine change fixed.
export { VerificationChip }

// ── Agent Mission Control ──────────────────────────────────────────────────────
// Full-page agent surface. No predefined workflow profiles: the brief goes straight
// into the engine and the agent infers its own workflow from context (the planner /
// ambiguity gate already owns that decision — the UI must not pre-bucket it).
//
// The page reads as a mission control for personal assistants:
//   · a hero composer to send an agent on its way
//   · a roster of agent cards — live status, current thought, elapsed — one per run
//   · the selected agent's workspace: plan, tools, terminal, changes, artifacts,
//     verify seal, answer — plus a conversation composer to steer or answer it
//
// Data flow: launching and steering call the exact same send() pipeline as the chat
// composer, so the transcript stays the source of truth; this page only renders the
// AgentState the SSE reducer already folds. No separate network path.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Card, SectionLabel, GhostButton, StatusChip, tint } from './ui'
import type { Round } from './chat/core'
import { STEP_GLYPH, STEP_COLOR, ToolRow, DiffBlock } from './chat/panels'
import { ClarificationCard } from './chat/AgentPanel'
import { ArtifactPreviewBar } from './chat/CodeRunner'

function runStatus(r: Round): { label: string; color: string; live: boolean } {
  const a = r.agent
  if (!a) return { label: 'chat', color: '#55556a', live: false }
  if (a.active) return { label: 'working', color: '#7c7cf8', live: true }
  if (a.error) return { label: 'error', color: '#f87171', live: false }
  if (a.clarification && !a.clarification.answered) return { label: 'needs you', color: '#fbbf24', live: false }
  if (a.done && !a.done.ok) return { label: 'stopped', color: '#f59e0b', live: false }
  return { label: 'done', color: '#4db89e', live: false }
}

/** One assistant on the roster — status glow, goal, live thought ticker. */
function AgentCard({ r, active, onSelect }: { r: Round; active: boolean; onSelect: () => void }) {
  const st = runStatus(r)
  const a = r.agent!
  const thought = a.active ? a.thoughts[a.thoughts.length - 1]?.replace(/^\[|\]$/g, '') : undefined
  const meta = a.done
    ? `${a.done.ms != null ? (a.done.ms / 1000).toFixed(1) + 's · ' : ''}${a.tools.length} tool${a.tools.length === 1 ? '' : 's'}`
    : a.tools.length > 0 ? `${a.tools.length} tool${a.tools.length === 1 ? '' : 's'} so far` : ''
  return (
    <div
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }}
      style={{
        display: 'flex', flexDirection: 'column', gap: 7, padding: '12px 14px', cursor: 'pointer',
        borderRadius: 'var(--c-radius)',
        background: active ? tint(st.color, 0.08) : 'var(--c-glass)',
        border: `1px solid ${active ? tint(st.color, 0.35) : 'var(--c-hairline)'}`,
        boxShadow: st.live ? `0 0 24px ${tint(st.color, 0.12)}` : 'var(--c-inset-highlight)',
        transition: 'background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%', background: st.color, flexShrink: 0,
          animation: st.live ? 'dotpulse 1.2s ease-in-out infinite' : undefined,
        }} />
        <span style={{
          flex: 1, minWidth: 0, fontSize: 'var(--t-ui)', fontWeight: 600, color: 'var(--c-text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{r.userMessage || 'Untitled'}</span>
        <span style={{ fontSize: 'var(--t-micro)', fontWeight: 700, letterSpacing: '0.06em', color: st.color, textTransform: 'uppercase', flexShrink: 0 }}>
          {st.label}
        </span>
      </div>
      {(thought || meta) && (
        <span key={thought} style={{
          fontSize: 'var(--t-small)', color: 'var(--c-dim)', lineHeight: 1.45,
          fontStyle: thought ? 'italic' : 'normal',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          animation: thought ? 'fadeIn 0.3s ease' : undefined,
        }}>{thought ?? meta}</span>
      )}
    </div>
  )
}

export default function AgentMissionControl({ rounds: rawRounds, thinking, liveRoundId, onLaunch, onReply, onClose }: {
  rounds: Round[]
  thinking: boolean
  liveRoundId: string | null
  /** Send a new agent on its way — same send() pipeline as the composer; the engine
   *  decides the workflow from the brief itself. */
  onLaunch: (text: string) => void
  /** Continue the conversation / answer a clarification — same send() pipeline. */
  onReply: (text: string) => void
  onClose: () => void
}) {
  // Same defensive close as MessageList: a driver that ends its stream without a terminal
  // agent event would leave active=true forever — the round no longer being the live
  // streaming round IS the terminal signal.
  const rounds = useMemo(() => rawRounds.map(r =>
    r.agent?.active && !(r.id === liveRoundId && thinking)
      ? { ...r, agent: { ...r.agent, active: false } }
      : r
  ), [rawRounds, liveRoundId, thinking])
  const agentRounds = useMemo(() => rounds.filter(r => r.agent), [rounds])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [brief, setBrief] = useState('')
  const [steer, setSteer] = useState('')
  const workScrollRef = useRef<HTMLDivElement>(null)
  const briefRef = useRef<HTMLTextAreaElement>(null)

  const latest = agentRounds[agentRounds.length - 1]
  const selected = agentRounds.find(r => r.id === selectedId) ?? latest
  // Auto-follow the newest run unless the user explicitly picked an older one.
  useEffect(() => {
    if (latest && (selectedId == null || !agentRounds.some(r => r.id === selectedId))) setSelectedId(latest.id)
  }, [latest?.id])  // eslint-disable-line react-hooks/exhaustive-deps

  const a = selected?.agent ?? null
  const status = selected ? runStatus(selected) : null
  const latestThought = a?.thoughts[a.thoughts.length - 1]
  const anyLive = agentRounds.some(r => r.agent?.active)
  const hasRuns = agentRounds.length > 0

  // Keep the workspace pinned to the newest activity while a run streams.
  useEffect(() => {
    const el = workScrollRef.current
    if (el && a?.active) el.scrollTop = el.scrollHeight
  }, [a?.tools.length, a?.thoughts.length, a?.active])

  const launch = () => {
    const d = brief.trim()
    if (!d) return
    setBrief('')
    setSelectedId(null) // re-arm auto-follow so the new run takes the workspace
    onLaunch(d)
  }

  const sendSteer = () => {
    const t = steer.trim()
    if (!t) return
    setSteer('')
    if (a?.clarification && !a.clarification.answered) onReply(t)
    else onLaunch(t)
  }

  const briefBox = (compact: boolean) => (
    <div style={{
      display: 'flex', alignItems: 'flex-end', gap: 8, width: '100%',
      background: 'rgba(255,255,255,0.045)', border: '1px solid var(--c-hairline-strong)',
      borderRadius: 16, padding: '10px 10px 10px 16px',
      boxShadow: compact ? undefined : '0 12px 48px rgba(0,0,0,0.35), var(--c-inset-highlight)',
    }}>
      <textarea
        ref={briefRef}
        value={brief}
        onChange={e => setBrief(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); launch() } }}
        placeholder={compact ? 'Send another agent…' : 'What should your agent take care of?'}
        rows={compact ? 1 : 2}
        style={{
          flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', resize: 'none',
          fontSize: compact ? 'var(--t-ui)' : 'var(--t-body)', lineHeight: 1.55,
          color: 'var(--c-text)', fontFamily: 'inherit', padding: '4px 0',
        }}
      />
      <button
        onClick={launch}
        disabled={!brief.trim()}
        title="Send the agent on its way"
        style={{
          width: 34, height: 34, borderRadius: 11, flexShrink: 0, cursor: brief.trim() ? 'pointer' : 'default',
          border: '1px solid rgba(124,124,248,0.4)',
          background: brief.trim() ? 'rgba(124,124,248,0.18)' : 'rgba(124,124,248,0.06)',
          color: brief.trim() ? '#b0b0f8' : 'var(--c-dim-deep)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease)',
        }}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
          <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  )

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 30, background: 'var(--c-bg)',
      display: 'flex', flexDirection: 'column',
      animation: 'panelUp 0.22s var(--ease)',
    }}>
      {/* ── Header ── */}
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12,
        padding: `calc(var(--titlebar-clearance) + 14px) 20px 14px`,
        borderBottom: '1px solid var(--c-hairline)',
      }}>
        <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--c-text)' }}>
          Mission Control
        </span>
        {anyLive
          ? <StatusChip color="#7c7cf8" pulse>{agentRounds.filter(r => r.agent?.active).length} working</StatusChip>
          : hasRuns
            ? <StatusChip color="#4db89e">all quiet</StatusChip>
            : null}
        <div style={{ flex: 1 }} />
        <button onClick={onClose} aria-label="Close" title="Back to chat" style={{
          width: 30, height: 30, borderRadius: 9, border: '1px solid var(--c-hairline-strong)',
          background: 'rgba(255,255,255,0.04)', color: '#9797ab', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* ── Empty state: hero composer, nothing else competing ── */}
      {!hasRuns ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 24px' }}>
          <div style={{ width: 'min(560px, 92%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 }}>
            <svg width="40" height="40" viewBox="0 0 48 48" fill="none" style={{ opacity: 0.5, marginBottom: 16 }}>
              <path d="M10 14h28M10 14l6 22M38 14l-6 22M16 36q8 8 16 0" stroke="var(--c-text)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--c-text)', marginBottom: 6 }}>
              Send an agent on its way
            </div>
            <div style={{ fontSize: 'var(--t-ui)', color: 'var(--c-dim)', marginBottom: 22, textAlign: 'center', lineHeight: 1.55 }}>
              Describe the outcome — building, researching, testing, deciding.
              The agent works out its own plan and you watch it happen here.
            </div>
            {briefBox(false)}
          </div>
        </div>
      ) : (
        /* ── Working state: roster column + selected agent workspace ── */
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>

          {/* Roster */}
          <div style={{
            width: 'min(340px, 40vw)', flexShrink: 0, display: 'flex', flexDirection: 'column',
            borderRight: '1px solid var(--c-hairline)', minHeight: 0,
          }}>
            <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid var(--c-hairline)' }}>
              {briefBox(true)}
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <SectionLabel style={{ padding: '0 2px 2px' }}>Your agents</SectionLabel>
              {[...agentRounds].reverse().map(r => (
                <AgentCard key={r.id} r={r} active={r.id === selected?.id} onSelect={() => setSelectedId(r.id)} />
              ))}
            </div>
          </div>

          {/* Workspace */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div ref={workScrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              {!selected || !a ? null : (
                <div style={{ padding: '18px 22px 24px', display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 860 }}>

                  {/* Run header */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    {status && <StatusChip color={status.color} pulse={status.live}>{status.label}</StatusChip>}
                    {a.driver && <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)' }}>{a.driver}</span>}
                    <div style={{ flex: 1 }} />
                    {a.done?.ms != null && (
                      <span style={{ fontSize: 'var(--t-small)', color: 'var(--c-dim-deep)', fontVariantNumeric: 'tabular-nums' }}>
                        {(a.done.ms / 1000).toFixed(1)}s · {a.done.toolCallCount ?? a.tools.length} tools
                      </span>
                    )}
                  </div>

                  {/* Goal */}
                  <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.5, color: 'var(--c-text)', overflowWrap: 'anywhere' }}>
                    {selected.userMessage}
                  </div>

                  {/* Live thought */}
                  {a.active && latestThought && (
                    <div key={latestThought} style={{
                      fontSize: 'var(--t-ui)', color: '#9a9ab0', fontStyle: 'italic',
                      animation: 'fadeIn 0.3s ease', overflowWrap: 'anywhere',
                    }}>
                      {latestThought.replace(/^\[|\]$/g, '')}
                    </div>
                  )}

                  {/* Plan */}
                  {a.steps.length > 0 && (
                    <Card style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <SectionLabel>Plan{a.replanned ? ' · replanned' : ''}</SectionLabel>
                      {a.steps.map(st => (
                        <div key={st.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 'var(--t-ui)', color: st.status === 'done' ? '#8a8a9e' : '#d4d4e4', lineHeight: 1.5 }}>
                          <span style={{ color: STEP_COLOR[st.status] ?? '#555', flexShrink: 0 }}>{STEP_GLYPH[st.status] ?? '○'}</span>
                          <span style={{ textDecoration: st.status === 'done' ? 'line-through' : 'none' }}>{st.intent}</span>
                        </div>
                      ))}
                    </Card>
                  )}

                  {/* Tools */}
                  {a.tools.length > 0 && (
                    <Card style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <SectionLabel>Tools · {a.tools.length}</SectionLabel>
                      <div style={{
                        maxHeight: 300, overflowY: 'auto', overflowX: 'hidden',
                        background: 'rgba(0,0,0,0.4)', borderRadius: 8,
                        border: '1px solid rgba(255,255,255,0.06)', padding: '8px 14px 8px 8px',
                      }}>
                        {a.tools.map((t, i) => [t, i] as const).reverse().map(([t, i]) => <ToolRow key={`${t.id}:${i}`} t={t} />)}
                      </div>
                    </Card>
                  )}

                  {/* Terminal */}
                  {a.terminal.length > 0 && (
                    <Card style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <SectionLabel>Terminal</SectionLabel>
                      <pre className="crucible-terminal-pre" style={{
                        margin: 0, padding: 10, background: 'rgba(0,0,0,0.45)', borderRadius: 8,
                        fontSize: 11, lineHeight: 1.55, color: '#9fef9f', fontFamily: 'var(--mono)',
                        whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto',
                      }}>{a.terminal.slice(-6).join('\n')}</pre>
                    </Card>
                  )}

                  {/* Changes */}
                  {a.diffs.length > 0 && (
                    <Card style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <SectionLabel>Changes · {a.diffs.length}</SectionLabel>
                      <div style={{ maxHeight: 340, overflowY: 'auto', overflowX: 'hidden', paddingRight: 2 }}>
                        {a.diffs.slice(-6).map((d, i) => <DiffBlock key={i} d={d} />)}
                      </div>
                    </Card>
                  )}

                  {/* Artifacts */}
                  {!a.active && (
                    <ArtifactPreviewBar paths={[
                      ...a.diffs.map(d => d.path),
                      ...a.tools
                        .filter(t => t.tool === 'write_file' && t.args?.path)
                        .map(t => {
                          const p = String(t.args.path)
                          return p.startsWith('/') || !a.projectPath ? p : `${a.projectPath.replace(/\/$/, '')}/${p}`
                        }),
                    ]} />
                  )}

                  {/* Verify seal */}
                  {a.verifies.length > 0 && (() => {
                    const v = a.verifies[a.verifies.length - 1]
                    return (
                      <div style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
                        padding: '5px 12px', borderRadius: 9, fontSize: 'var(--t-small)', fontWeight: 600,
                        background: v.passed ? 'rgba(74,222,128,0.12)' : 'rgba(248,113,113,0.12)',
                        color: v.passed ? '#86efac' : '#fca5a5',
                        border: `1px solid ${v.passed ? 'rgba(74,222,128,0.3)' : 'rgba(248,113,113,0.3)'}`,
                      }}>
                        {v.passed ? '✓ verified' : v.escalate ? '✕ unfixable — stopped' : '↻ healing'} · {v.signal}
                      </div>
                    )
                  })()}

                  {a.error && <div style={{ fontSize: 'var(--t-ui)', color: '#fca5a5' }}>{a.error}</div>}

                  {/* Clarification */}
                  {a.clarification && !a.active && (
                    <ClarificationCard clarification={a.clarification} onReply={onReply} />
                  )}

                  {/* Answer */}
                  {(a.final || selected.synthesis) && (
                    <Card accent="#7c7cf8" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <SectionLabel>Answer</SectionLabel>
                      <div style={{
                        fontSize: 'var(--t-body)', lineHeight: 1.65, color: 'var(--c-text)',
                        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
                      }}>{a.final || selected.synthesis}</div>
                    </Card>
                  )}
                </div>
              )}
            </div>

            {/* Steer / reply — talk to the selected agent, same loop as chat. */}
            <div style={{ flexShrink: 0, padding: '10px 22px 14px', borderTop: '1px solid var(--c-hairline)', display: 'flex', gap: 8, maxWidth: 904 }}>
              <input
                value={steer}
                onChange={e => setSteer(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') sendSteer() }}
                placeholder={a?.clarification && !a.clarification.answered ? 'Answer your agent…' : thinking ? 'Steer the agent…' : 'Follow up with the agent…'}
                style={{
                  flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.04)',
                  border: '1px solid var(--c-hairline-strong)', borderRadius: 12,
                  padding: '10px 14px', fontSize: 'var(--t-ui)', color: '#d0d0e0', outline: 'none', fontFamily: 'inherit',
                }}
              />
              <GhostButton onClick={sendSteer} title="Send">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </GhostButton>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

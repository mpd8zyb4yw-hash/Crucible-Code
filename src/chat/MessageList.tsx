// ── chat/MessageList — the memoized rounds renderer + molten-pour wrapper ──
import { useRef, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import MoltenPour, { type MoltenPhase } from '../MoltenPour'
import { CopyButton, FeedbackButtons, type DynamicModel, type Round } from './core'
import { PipelineTheater, CritiqueGrid, narrateProcess } from './panels'
import { AgentPanel, CollapsibleCode } from './AgentPanel'

// Wraps a reply card and mounts the MoltenPour canvas over it while it's the live
// (currently-streaming) round.
//
// Item-23 fix: this used to reserve headroom for the crucible vessel via a `marginTop`
// that animated in/out (46px while pouring, 0 once done) — a real layout-flow push that
// shifted the reply card (and everything below it) up/down as the pour started/finished,
// exactly the "collides with/pushes around message content" bug flagged for this
// animation. The canvas already draws the vessel/spout entirely via its own negative
// offset (`top: -70` in MoltenPour.tsx) as a `position: absolute` overlay with
// `pointerEvents: none` — it was already visually safe to overlap the message above
// without a layout reservation. Dropping the margin entirely removes the content shift;
// the vessel now simply draws over whatever is above the card (transparent canvas, no
// visual conflict) instead of pushing it out of the way.
export function PourWrap({ active, phase, progress, children }: {
  active: boolean
  phase: MoltenPhase
  progress: number
  children: React.ReactNode
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={wrapRef}
      style={{
        position: 'relative', borderRadius: 14, width: '100%',
        // The vessel canvas draws `TOP` (70px, MoltenPour.tsx) above this card via a
        // negative offset. Item-23 dropped this reservation entirely to stop an animated
        // margin from pushing content around — but with no reservation at all, the vessel
        // paints straight over whatever message sits above the live card. Reserve the exact
        // 70px with NO transition (snaps in/out instantly with `active`, no animated push)
        // so it neither collides with the message above nor visibly shoves it.
        marginTop: active ? 70 : 0,
      }}
    >
      {active && <MoltenPour phase={phase} progress={progress} wrapRef={wrapRef} />}
      {children}
    </div>
  )
}

// Item 5 (typing latency fix): this was previously an inline ~700-line block directly in
// App's JSX. Every keystroke in the composer updated top-level `input` state, which re-rendered
// the WHOLE App component tree, including this large rounds.map(...) render — even though
// nothing in it reads `input`. Extracting it into its own component wrapped in React.memo
// means React only re-renders this subtree when its own props actually change (rounds,
// inputBarHeight, liveRoundId, thinking) — not on every keystroke. The callbacks passed in
// are all stable references (useCallback / ref-forwarded wrappers in App), so memoization
// isn't defeated by fresh closures each render.
export const MessageList = memo(function MessageList({
  rounds, setRounds, send, toggleCritique, inputBarHeight, liveRoundId, thinking,
  scrollRef, bottomRef, handleScroll, handleWheel, handleTouchStart, handleTouchMove,
}: {
  rounds: Round[]
  setRounds: React.Dispatch<React.SetStateAction<Round[]>>
  send: (text?: string) => void
  toggleCritique: (roundId: string, critic: string, target: string) => void
  inputBarHeight: number
  liveRoundId: string | null
  thinking: boolean
  scrollRef: React.RefObject<HTMLDivElement | null>
  bottomRef: React.RefObject<HTMLDivElement | null>
  handleScroll: () => void
  handleWheel: (e: React.WheelEvent) => void
  handleTouchStart: (e: React.TouchEvent) => void
  handleTouchMove: (e: React.TouchEvent) => void
}) {
  return (
      <div ref={scrollRef} onScroll={handleScroll} onWheel={handleWheel} onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} className="crucible-scroll" style={{
        flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column',
        alignItems: 'center', paddingTop: 28, paddingLeft: 24, paddingRight: 24, paddingBottom: inputBarHeight + 16,
        gap: 32, zIndex: 1,
        // Exponential alpha fade anchored to the CARD LINE. The scroll viewport now
        // extends to the very bottom (spacer moved inside), so the fade can land exactly
        // where the cards begin (`inputBarHeight - 8` px from the bottom). Text is fully
        // sharp until the card line, then the clustered stops make opacity fall off
        // progressively faster the deeper it goes behind the cards — sharp → ghost.
        WebkitMaskImage: `linear-gradient(to bottom, black 0%, black calc(100% - ${inputBarHeight - 8}px), rgba(0,0,0,0.92) calc(100% - ${inputBarHeight - 32}px), rgba(0,0,0,0.55) calc(100% - ${inputBarHeight - 68}px), rgba(0,0,0,0.18) calc(100% - ${Math.max(20, inputBarHeight - 103)}px), transparent 100%)`,
        maskImage: `linear-gradient(to bottom, black 0%, black calc(100% - ${inputBarHeight - 8}px), rgba(0,0,0,0.92) calc(100% - ${inputBarHeight - 32}px), rgba(0,0,0,0.55) calc(100% - ${inputBarHeight - 68}px), rgba(0,0,0,0.18) calc(100% - ${Math.max(20, inputBarHeight - 103)}px), transparent 100%)`,
      }}>
        {rounds.map(round => {
          const models = round.models
          return (
            <div key={round.id} className="crucible-msg-width" style={{
              width: '100%', maxWidth: 680, display: 'flex', flexDirection: 'column', gap: 12,
            }}>

              {/* User bubble */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4 }}>
                <CopyButton text={round.userMessage} inline title="Copy message" />
                <div
                  onClick={() => models.length > 0 && setRounds(prev => prev.map(r =>
                    r.id === round.id ? { ...r, expandedModel: r.expandedModel ? null : models[0].id } : r
                  ))}
                  className="crucible-user-bubble"
                  style={{
                    maxWidth: '62%', padding: '9px 14px', borderRadius: 14,
                    fontSize: 13, lineHeight: 1.58, cursor: models.length > 0 ? 'pointer' : 'default',
                    background: round.expandedModel ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.055)',
                    border: `1px solid ${round.expandedModel ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.09)'}`,
                    // Subtle bottom accent (hints "expandable") via boxShadow — avoids the
                    // border/borderBottom shorthand-vs-longhand conflict React warns about.
                    boxShadow: models.length > 0 ? 'inset 0 -1px 0 rgba(255,255,255,0.12)' : undefined,
                    color: '#ccc', transition: 'background 0.2s, border-color 0.2s',
                    userSelect: 'none' as const, textAlign: 'left' as const,
                    overflowWrap: 'anywhere' as const, wordBreak: 'break-word' as const,
                  }}>
                  {round.userMessage}
                </div>
              </div>

              {/* Agent loop panel (Section 7) */}
              {round.agent && <AgentPanel agent={round.agent} onReply={text => send(text)} />}

              {/* Pipeline Theater — all model cards, shown when user message is clicked */}
              {round.expandedModel && <PipelineTheater round={round} />}

              {/* Critique grid (desktop) + mobile status pill */}
              {round.stage3Started && models.length > 0 && round.complexity === 'complex' && (
                <>
                  <CritiqueGrid round={round} onToggle={(critic, target) => toggleCritique(round.id, critic, target)} />
                  {/* Mobile-only: subtle status line while critique runs */}
                  <div className="crucible-pipeline-status" style={{ display: 'none' }}>
                    <span style={{
                      fontSize: 10, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.06em',
                      fontWeight: 500, textTransform: 'uppercase' as const,
                    }}>
                      {round.stage3Done ? (round.stage4Done ? (round.synthesisDone ? '✦ done' : 'polishing…') : 'refining…') : `models debating · ${models.length} perspectives`}
                    </span>
                  </div>
                </>
              )}


              {/* Post-critique pipeline progress */}
              {round.stage3Done && round.complexity === 'complex' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '10px 2px', animation: 'fadeIn 0.4s', minWidth: 0 }}>
                  {[
                    { label: 'peer scoring',  done: round.stage2Done   },
                    { label: 'cross-critique', done: round.stage3Done  },
                    { label: 'self-refine',    done: round.stage4Done  },
                    { label: 'synthesis',      done: round.synthesisDone },
                  ].map((step, i, arr) => (
                    <div key={step.label} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, flex: 1 }}>
                        <div style={{
                          width: '100%', height: 2, borderRadius: 2,
                          background: step.done ? '#7c7cf8' : 'rgba(255,255,255,0.06)',
                          transition: 'background 0.5s',
                          boxShadow: step.done ? '0 0 6px rgba(124,124,248,0.4)' : 'none',
                        }} />
                        <span style={{
                          fontSize: 7, letterSpacing: '0.06em', textTransform: 'uppercase' as const,
                          color: step.done ? 'rgba(124,124,248,0.5)' : '#222', transition: 'color 0.3s',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%',
                        }}>{step.label}</span>
                      </div>
                      {i < arr.length - 1 && (
                        <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#1a1a28', flexShrink: 0, marginBottom: 12 }} />
                      )}
                    </div>
                  ))}
                </div>
              )}


              {/* Activity Feed — moved to fixed overlay */}

              {/* Synthesis — the live round shows its card immediately on send (empty shell
                  during 'thinking' so the crucible vessel has something to pour into). */}
              {(round.synthesis.length > 0 || (round.id === liveRoundId && thinking)) && (
                <PourWrap
                  active={round.id === liveRoundId}
                  phase={round.synthesisDone ? 'done' : round.synthesis.length > 0 ? 'pouring' : 'thinking'}
                  progress={Math.min(1, round.synthesis.length / (round.synthesis.length + 500))}
                >
                <div style={{
                  position: 'relative', borderRadius: 14, padding: '16px 18px', width: '100%', boxSizing: 'border-box' as const, overflow: 'hidden',
                  minHeight: 54,
                  background: 'rgba(255,255,255,0.035)',
                  backdropFilter: 'blur(28px)', WebkitBackdropFilter: 'blur(28px)',
                  border: '1px solid rgba(255,255,255,0.09)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
                  animation: 'fadeIn 0.3s ease',
                }}>
                  {/* Item-6: this card used to render a second, redundant top-right "Copy full
                      exchange" button in addition to the "Copy answer" button that sits next to
                      the feedback controls below — two copy affordances for the same message.
                      Removed; the bottom one (paired with rating) is the single copy action now. */}
                  {/* Ensemble chrome (model chips + attribution) renders ONLY on ensemble
                      runs — a local reply is a clean card (v3). */}
                  {models.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' as const, paddingRight: 28 }}>
                    <div style={{ display: 'flex', gap: 3 }}>
                      {models.map(m => (
                        <span key={m.id} style={{ width: 5, height: 5, borderRadius: '50%', background: m.color, opacity: 0.8 }} />
                      ))}
                    </div>
                    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', color: 'rgba(157,157,250,0.7)', textTransform: 'uppercase' as const }}>
                      {round.synthesisDone ? 'ensemble' : round.synthStreaming ? 'writing…' : 'synthesizing…'}
                    </span>
                    {round.synthesisDone && models.length > 0 && (() => {
                      // Attribution: synthesizer led, 2nd scorer refined, rest contributed
                      const dropped = new Set(round.activityFeed.filter(e => e.type === 'rollback').map(e => e.modelId))
                      const active = models.filter(m => !dropped.has(m.id))
                      const sorted = [...active].sort((a, b) => (round.avgScores[b.id] ?? 0) - (round.avgScores[a.id] ?? 0))
                      const synth = models.find(m => m.id === round.synthesisModelId) ?? sorted[0]
                      const others = sorted.filter(m => m.id !== synth?.id)
                      const parts: Array<{ model: DynamicModel; role: string }> = synth
                        ? [{ model: synth, role: 'led synthesis' }, ...others.slice(0, 2).map((m, i) => ({ model: m, role: i === 0 ? 'refined' : 'contributed' }))]
                        : []
                      if (!parts.length) return null
                      return (
                        <span style={{ fontSize: 9, color: '#2a2a3a', marginLeft: 2, display: 'flex', gap: 6, flexWrap: 'wrap' as const, alignItems: 'center' }}>
                          {parts.map(({ model: m, role }, i) => (
                            <span key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                              {i > 0 && <span style={{ color: '#1a1a28' }}>·</span>}
                              <span style={{ color: m.color, fontWeight: 700 }}>{m.label}</span>
                              <span style={{ color: '#282838' }}>{role}</span>
                            </span>
                          ))}
                        </span>
                      )
                    })()}
                  </div>
                  )}
                  {models.length > 0 && (
                    <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '10px -18px 12px' }} />
                  )}
                  <div style={{ fontSize: 13.5, lineHeight: 1.75, color: '#d8d8e8', maxWidth: '100%', overflow: 'hidden', overflowWrap: 'anywhere' as const, wordBreak: 'break-word' as const, userSelect: 'text' as const }}>
                   <ReactMarkdown
                     components={{
                       pre({ children }: any) { return <>{children}</> },
                       code({ node, className, children, ...props }: any) {
                         const match = /language-(\w+)/.exec(className || '')
                         // Item-11: react-markdown v10 dropped the `inline` prop entirely, so
                         // `!props.inline` was always true — every inline code span (single
                         // backticks) got rendered as a full CollapsibleCode block, which broke
                         // simple one-liner code requests (giant collapsed block with its own
                         // header/copy button instead of a plain inline span). A real fenced
                         // code block always carries a `language-*` className (even with no
                         // language hint, remark still marks it) OR its raw text spans multiple
                         // lines; a `single backtick` span never does either.
                         const rawText = String(children)
                         const isBlock = !!match || rawText.includes('\n')
                         const code = String(children).replace(/\n$/, '')
                         if (isBlock && match) {
                           return <CollapsibleCode language={match[1]} code={code} />
                         }
                         if (isBlock) {
                           return (
                             <div style={{
                               overflowX: 'auto', maxWidth: '100%', boxSizing: 'border-box' as const,
                               fontFamily: '"SF Mono","Fira Code",monospace', fontSize: 12, lineHeight: 1.5,
                               background: 'rgba(0,0,0,0.25)', borderRadius: 8,
                               padding: '10px 12px', margin: '8px 0', whiteSpace: 'pre-wrap' as const,
                               wordBreak: 'break-word' as const, overflowWrap: 'anywhere' as const,
                               color: '#c8c8d0', userSelect: 'text' as const,
                             }}>{code}</div>
                           )
                         }
                         return <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 4, fontSize: 12, overflowWrap: 'anywhere', wordBreak: 'break-word' }} {...props}>{children}</code>
                       },
                       p({ children }: any) { return <p style={{ margin: '0 0 10px' }}>{children}</p> },
                       ul({ children }: any) { return <ul style={{ paddingLeft: 20, margin: '0 0 10px' }}>{children}</ul> },
                       ol({ children }: any) { return <ol style={{ paddingLeft: 20, margin: '0 0 10px' }}>{children}</ol> },
                       li({ children }: any) { return <li style={{ marginBottom: 4 }}>{children}</li> },
                       h1({ children }: any) { return <h1 style={{ fontSize: 16, fontWeight: 700, margin: '14px 0 6px', color: '#fff' }}>{children}</h1> },
                       h2({ children }: any) { return <h2 style={{ fontSize: 14, fontWeight: 700, margin: '12px 0 5px', color: '#fff' }}>{children}</h2> },
                       h3({ children }: any) { return <h3 style={{ fontSize: 13, fontWeight: 600, margin: '10px 0 4px', color: 'rgba(255,255,255,0.8)' }}>{children}</h3> },
                     }}
                   >{round.synthesis}</ReactMarkdown>
                   {round.synthStreaming && !round.synthesisDone && (
                     <span style={{
                       display: 'inline-block', width: 2, height: '0.95em',
                       background: 'rgba(124,124,248,0.7)',
                       verticalAlign: 'text-bottom',
                       animation: 'dotpulse 0.9s ease-in-out infinite',
                       marginLeft: 2, borderRadius: 1,
                     }} />
                   )}
                 </div>
                  {/* Local replies: clean card + copy/feedback + on-device footer (v3). The
                      full process trail below is ensemble-run chrome only. */}
                  {round.synthesisDone && models.length === 0 && (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                        <CopyButton text={round.synthesis} inline title="Copy answer" />
                        <FeedbackButtons query={round.userMessage} synthesis={round.synthesis} promptType={round.promptType} />
                      </div>
                      <div style={{ marginTop: 10, fontSize: 9.5, fontWeight: 600, letterSpacing: '0.08em', color: '#4a4a5e' }}>
                        CRUCIBLE · ON-DEVICE
                      </div>
                    </>
                  )}
                  {round.synthesisDone && models.length > 0 && (() => {
                   // Unified process trail — ensemble runs only. One place to see how the
                   // answer was built: models, scores, critique, confidence, fragility,
                   // frontier questions, dropped models.
                   const conf = round.confidence
                   const overallTier = conf?.overallTier ?? 'UNVERIFIED'
                   const overallScore = conf?.overallScore ?? 0
                   const summary = conf?.summary ?? { high: 0, medium: 0, low: 0, unverified: 0 }
                   const flaggedClaims = conf?.flaggedClaims ?? []
                   const fragilityAssumption = conf?.fragilityAssumption
                   const frontierQuestion = conf?.frontierQuestion
                   const tierColor = overallTier === 'HIGH'
                     ? 'rgba(77,220,160,0.7)'
                     : overallTier === 'MEDIUM'
                     ? 'rgba(255,200,80,0.7)'
                     : 'rgba(248,124,124,0.7)'
                   // ── Unified process trail ─────────────────────────────────
                   // Always present, always expandable. Not a feature — this is
                   // how a trustworthy system accounts for itself.
                   const active = round.models.filter(m =>
                     !round.activityFeed.some(e => e.type === 'rollback' && e.modelId === m.id) &&
                     (round.avgScores[m.id] ?? 0) > 0
                   )
                   const dropped = round.models.filter(m =>
                     round.activityFeed.some(e => e.type === 'rollback' && e.modelId === m.id)
                   )
                   const synthesizer = round.models.find(m => m.id === round.synthesisModelId)
                   const topScore = active.length > 0 ? Math.max(...active.map(m => round.avgScores[m.id] ?? 0)) : 0
                   const hasFlagged = flaggedClaims.length > 0
                   const scoreSpread = active.length > 1
                     ? Math.max(...active.map(m => round.avgScores[m.id] ?? 0)) - Math.min(...active.map(m => round.avgScores[m.id] ?? 0))
                     : 0
                   const hadDisagreement = scoreSpread > 0.25

                   // Summary chips for the collapsed state
                   const chips: { label: string; color: string }[] = [
                     { label: `${active.length} model${active.length !== 1 ? 's' : ''}`, color: 'rgba(255,255,255,0.22)' },
                     { label: `${Math.round(overallScore * 100)}% confident`, color: tierColor },
                     ...(hasFlagged ? [{ label: `${flaggedClaims.length} flagged`, color: 'rgba(248,124,124,0.6)' }] : []),
                     ...(fragilityAssumption ? [{ label: 'fragile assumption', color: 'rgba(255,200,80,0.55)' }] : []),
                     ...(frontierQuestion ? [{ label: 'open question', color: 'rgba(100,180,255,0.55)' }] : []),
                     ...(hadDisagreement ? [{ label: 'models disagreed', color: 'rgba(200,160,255,0.55)' }] : []),
                     ...(dropped.length > 0 ? [{ label: `${dropped.length} dropped`, color: 'rgba(248,124,124,0.4)' }] : []),
                     ...(round.criticProblems && round.criticProblems.length > 0 ? [{ label: `${round.criticProblems.length} critic flag${round.criticProblems.length !== 1 ? 's' : ''}`, color: 'rgba(248,124,124,0.5)' }] : []),
                     ...(round.masterpiece?.connectionsSurvived ? [{ label: `masterpiece · ${round.masterpiece.connectionsSurvived} cross-domain`, color: 'rgba(130,160,255,0.55)' }] : []),
                   ]

                   return (
                     <>
                       {/* Copy + feedback — between answer and process trail */}
                       <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                         <CopyButton text={round.synthesis} inline title="Copy answer" />
                         <FeedbackButtons query={round.userMessage} synthesis={round.synthesis} promptType={round.promptType} />
                       </div>

                       {/* ── "Shows its work" panel — collapsed by default everywhere, one tap
                           to expand. Self-accounting: every section reads only data already
                           present on the round; absent data → section is skipped. ─────────── */}
                       {(() => {
                         // Tier color tokens (reused from the app's confidence palette)
                         const tierCol = (t: string) =>
                           t === 'HIGH' ? 'rgba(77,220,160,0.9)'
                           : t === 'MEDIUM' ? 'rgba(255,200,80,0.9)'
                           : t === 'LOW' ? 'rgba(248,124,124,0.9)'
                           : 'rgba(255,255,255,0.4)'   // UNVERIFIED → gray
                         // Contribution-rate bar color: green high / amber mid / red low
                         const rateCol = (r: number) =>
                           r >= 0.5 ? 'rgba(77,220,160,0.65)'
                           : r >= 0.25 ? 'rgba(255,200,80,0.65)'
                           : 'rgba(248,124,124,0.6)'
                         const sectionLabel = (text: string, color: string) => (
                           <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color, marginBottom: 4 }}>{text}</div>
                         )

                         const geneEntries = round.genealogy
                           ? active
                               .filter(m => (round.genealogy![m.id] ?? 0) > 0)
                               .sort((a, b) => (round.genealogy![b.id] ?? 0) - (round.genealogy![a.id] ?? 0))
                           : []
                         const specialists = round.masterpiece?.specialists ?? []
                         // "What the system doesn't know" — low/unverified flagged claims + frontier
                         const unknowns = flaggedClaims.filter(fc => fc.tier === 'LOW' || fc.tier === 'UNVERIFIED')
                         const stageCount = round.complexity === 'complex' ? 4 : 3

                         // One-line collapsed summary
                         const headerBits: string[] = [`${active.length} model${active.length !== 1 ? 's' : ''}`]
                         if (conf) headerBits.push(`${overallTier} confidence`)
                         if (fragilityAssumption) headerBits.push('1 fragile assumption')
                         if (round.criticProblems && round.criticProblems.length > 0)
                           headerBits.push(`${round.criticProblems.length} critic flag${round.criticProblems.length !== 1 ? 's' : ''}`)

                         return (
                           <details className="crucible-shows-work" style={{ marginTop: 10 }}>
                             <summary style={{
                               fontSize: 11, letterSpacing: '0.03em', cursor: 'pointer',
                               userSelect: 'none' as const, listStyle: 'none',
                               display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const,
                               padding: '7px 11px', borderRadius: 8,
                               background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)',
                               color: 'rgba(255,255,255,0.45)', transition: 'background 0.2s ease, border-color 0.2s ease',
                             }}>
                               <span className="crucible-sw-caret" style={{ fontFamily: 'monospace', fontSize: 10, color: 'rgba(255,255,255,0.3)', transition: 'transform 0.2s ease', display: 'inline-block' }}>▸</span>
                               <span style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'rgba(255,255,255,0.3)', fontWeight: 600 }}>shows its work</span>
                               <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, color: tierColor }}>
                                 {headerBits.join('  ·  ')}
                               </span>
                             </summary>

                             <div className="crucible-sw-body" style={{
                               marginTop: 8, padding: '13px 15px', borderRadius: 8,
                               background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)',
                               display: 'flex', flexDirection: 'column' as const, gap: 14,
                               animation: 'panelUp 0.28s cubic-bezier(0.22,1,0.36,1)',
                             }}>

                               {/* Model agreement — genealogy contribution bars */}
                               {geneEntries.length > 0 && (
                                 <div>
                                   {sectionLabel('model agreement', 'rgba(255,255,255,0.28)')}
                                   {geneEntries.map(m => {
                                     const rate = round.genealogy![m.id] ?? 0
                                     return (
                                       <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                         <span style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0, background: m.color ?? 'rgba(124,124,248,0.7)' }} />
                                         <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{m.label}</span>
                                         <div style={{ width: 64, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
                                           <div style={{ width: `${Math.round(rate * 100)}%`, height: '100%', background: rateCol(rate), borderRadius: 2, transition: 'width 0.4s ease' }} />
                                         </div>
                                         <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', fontFamily: 'monospace', width: 30, textAlign: 'right' as const }}>{Math.round(rate * 100)}%</span>
                                       </div>
                                     )
                                   })}
                                 </div>
                               )}

                               {/* Adversarial audit — critic findings, or all-clear fallback */}
                               <div>
                                 {sectionLabel('adversarial audit', 'rgba(248,124,124,0.5)')}
                                 {round.criticProblems && round.criticProblems.length > 0 ? (
                                   round.criticProblems.map((p, i) => (
                                     <div key={i} style={{ fontSize: 11, color: 'rgba(255,255,255,0.42)', lineHeight: 1.55, paddingLeft: 8, borderLeft: '2px solid rgba(248,124,124,0.25)', marginBottom: 4, wordBreak: 'break-word' as const }}>{p}</div>
                                   ))
                                 ) : (
                                   <div style={{ fontSize: 11, color: 'rgba(77,220,160,0.55)', lineHeight: 1.55 }}>No significant issues found.</div>
                                 )}
                               </div>

                               {/* Confidence tiers — color-coded HIGH/MEDIUM/LOW/UNVERIFIED */}
                               {conf && (
                                 <div>
                                   {sectionLabel('confidence', 'rgba(255,255,255,0.28)')}
                                   <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                                     <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: tierCol(overallTier) }}>{overallTier}</span>
                                     <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace' }}>{Math.round(overallScore * 100)}%</span>
                                   </div>
                                   <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' as const, fontSize: 10 }}>
                                     {summary.high > 0 && <span style={{ color: tierCol('HIGH') }}>{summary.high} high</span>}
                                     {summary.medium > 0 && <span style={{ color: tierCol('MEDIUM') }}>{summary.medium} medium</span>}
                                     {summary.low > 0 && <span style={{ color: tierCol('LOW') }}>{summary.low} low</span>}
                                     {summary.unverified > 0 && <span style={{ color: tierCol('UNVERIFIED') }}>{summary.unverified} unverified</span>}
                                   </div>
                                 </div>
                               )}

                               {/* Fragile assumption — "The answer breaks without:" */}
                               {fragilityAssumption && (
                                 <div>
                                   {sectionLabel('the answer breaks without', 'rgba(255,200,80,0.5)')}
                                   <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', lineHeight: 1.55, fontStyle: 'italic' as const, wordBreak: 'break-word' as const }}>{fragilityAssumption}</div>
                                 </div>
                               )}

                               {/* What the system doesn't know — unverified/low claims + frontier */}
                               {(unknowns.length > 0 || frontierQuestion) && (
                                 <div>
                                   {sectionLabel("what the system doesn't know", 'rgba(255,255,255,0.28)')}
                                   {unknowns.map((fc, i) => (
                                     <div key={i} style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', lineHeight: 1.5, marginBottom: 3, wordBreak: 'break-word' as const }}>
                                       <span style={{ fontSize: 9, letterSpacing: '0.06em', marginRight: 6, color: tierCol(fc.tier) }}>{fc.tier}</span>
                                       {fc.claim}
                                     </div>
                                   ))}
                                   {frontierQuestion && (
                                     <div style={{ fontSize: 11, color: 'rgba(100,180,255,0.6)', lineHeight: 1.55, fontStyle: 'italic' as const, marginTop: unknowns.length > 0 ? 4 : 0, wordBreak: 'break-word' as const }}>{frontierQuestion}</div>
                                   )}
                                 </div>
                               )}

                               {/* Sources / specialists */}
                               {specialists.length > 0 && (
                                 <div>
                                   {sectionLabel('specialists', 'rgba(130,160,255,0.5)')}
                                   <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 6 }}>
                                     {specialists.map((s, i) => (
                                       <span key={i} style={{
                                         fontSize: 10, color: 'rgba(255,255,255,0.45)', padding: '2px 8px', borderRadius: 6,
                                         background: 'rgba(130,160,255,0.08)', border: '1px solid rgba(130,160,255,0.15)',
                                         maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
                                       }}>{s.specialist} · {Math.round(s.confidence * 100)}%</span>
                                     ))}
                                   </div>
                                 </div>
                               )}

                               {/* Pipeline stats */}
                               <div>
                                 {sectionLabel('pipeline', 'rgba(255,255,255,0.28)')}
                                 <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 12, fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
                                   <span>{active.length} model{active.length !== 1 ? 's' : ''}</span>
                                   <span>{stageCount} stages</span>
                                   {dropped.length > 0 && <span style={{ color: 'rgba(248,124,124,0.5)' }}>{dropped.length} dropped</span>}
                                   {round.masterpiece?.elapsedMs != null && <span>{(round.masterpiece.elapsedMs / 1000).toFixed(1)}s</span>}
                                 </div>
                               </div>

                             </div>
                           </details>
                         )
                       })()}

                       {/* Process trail — progressive disclosure: collapsed by default on
                           mobile, expanded by default on desktop. Set once per element via
                           ref so streaming re-renders don't snap it back. */}
                       <details
                         style={{ marginTop: 10 }}
                         ref={el => {
                           if (el && el.dataset.init !== '1') {
                             el.open = window.innerWidth > 640
                             el.dataset.init = '1'
                           }
                         }}
                       >
                         <summary style={{
                           fontSize: 10, letterSpacing: '0.05em', color: 'rgba(255,255,255,0.22)',
                           cursor: 'pointer', userSelect: 'none' as const, listStyle: 'none',
                           display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' as const,
                         }}>
                           <span style={{ fontFamily: 'monospace', fontSize: 9, color: 'rgba(255,255,255,0.18)' }}>▸</span>
                           {chips.map((chip, i) => (
                             <span key={i} style={{
                               color: chip.color,
                               borderRight: i < chips.length - 1 ? '1px solid rgba(255,255,255,0.08)' : 'none',
                               paddingRight: i < chips.length - 1 ? 6 : 0,
                             }}>{chip.label}</span>
                           ))}
                         </summary>

                         <div style={{
                           marginTop: 8, padding: '12px 14px', borderRadius: 8,
                           background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)',
                           display: 'flex', flexDirection: 'column' as const, gap: 12,
                         }}>

                           {/* Model scores */}
                           {active.length > 0 && (
                             <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 5 }}>
                               <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(255,255,255,0.2)', marginBottom: 2 }}>ensemble</div>
                               {active.map(m => {
                                 const sc = round.avgScores[m.id] ?? 0
                                 const isSynth = m.id === round.synthesisModelId
                                 return (
                                   <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                     <span style={{
                                       width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                                       background: m.color ?? 'rgba(124,124,248,0.7)',
                                     }} />
                                     <span style={{ fontSize: 10, color: isSynth ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.35)', minWidth: 0, flex: 1 }}>
                                       {m.label}
                                       {isSynth && <span style={{ fontSize: 8, letterSpacing: '0.07em', color: 'rgba(124,124,248,0.6)', marginLeft: 5 }}>synthesizer</span>}
                                     </span>
                                     <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                       <div style={{ width: 48, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
                                         <div style={{ width: `${sc * 100}%`, height: '100%', background: sc >= 0.75 ? 'rgba(77,220,160,0.6)' : sc >= 0.5 ? 'rgba(255,200,80,0.6)' : 'rgba(248,124,124,0.5)', borderRadius: 2 }} />
                                       </div>
                                       <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace', width: 28, textAlign: 'right' as const }}>{(sc * 100).toFixed(0)}%</span>
                                     </div>
                                   </div>
                                 )
                               })}
                               {dropped.length > 0 && (
                                 <div style={{ fontSize: 9, color: 'rgba(248,124,124,0.4)', marginTop: 2 }}>
                                   dropped: {dropped.map(m => m.label).join(', ')}
                                 </div>
                               )}
                               {round.genealogy && Object.keys(round.genealogy).some(id => (round.genealogy![id] ?? 0) > 0) && (
                                 <div style={{ marginTop: 6 }}>
                                   <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(255,255,255,0.2)', marginBottom: 4 }}>synthesis contribution</div>
                                   {active
                                     .filter(m => (round.genealogy![m.id] ?? 0) > 0)
                                     .sort((a, b) => (round.genealogy![b.id] ?? 0) - (round.genealogy![a.id] ?? 0))
                                     .map(m => {
                                       const rate = round.genealogy![m.id] ?? 0
                                       return (
                                         <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                                           <span style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0, background: m.color ?? 'rgba(124,124,248,0.7)' }} />
                                           <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', flex: 1, minWidth: 0 }}>{m.label}</span>
                                           <div style={{ width: 48, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
                                             <div style={{ width: `${rate * 100}%`, height: '100%', background: 'rgba(124,124,248,0.5)', borderRadius: 2 }} />
                                           </div>
                                           <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace', width: 28, textAlign: 'right' as const }}>{Math.round(rate * 100)}%</span>
                                         </div>
                                       )
                                     })
                                   }
                                 </div>
                               )}
                             </div>
                           )}

                           {/* Process narrative */}
                           <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', lineHeight: 1.65 }}>
                             {narrateProcess(round, active, dropped, synthesizer, topScore)}
                           </div>

                           {/* Confidence breakdown */}
                           {conf && (
                             <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
                               <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(255,255,255,0.2)', marginBottom: 2 }}>confidence breakdown</div>
                               <div style={{ display: 'flex', gap: 10, fontSize: 10 }}>
                                 {summary.high > 0 && <span style={{ color: 'rgba(77,220,160,0.6)' }}>{summary.high} high</span>}
                                 {summary.medium > 0 && <span style={{ color: 'rgba(255,200,80,0.5)' }}>{summary.medium} medium</span>}
                                 {summary.low > 0 && <span style={{ color: 'rgba(255,180,80,0.6)' }}>{summary.low} low</span>}
                                 {summary.unverified > 0 && <span style={{ color: 'rgba(248,124,124,0.6)' }}>{summary.unverified} unverified</span>}
                               </div>
                               {flaggedClaims.map((fc, i) => (
                                 <div key={i} style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', lineHeight: 1.5, wordBreak: 'break-word' as const }}>
                                   <span style={{ fontSize: 9, letterSpacing: '0.06em', marginRight: 6, color: fc.tier === 'UNVERIFIED' ? 'rgba(248,124,124,0.5)' : 'rgba(255,180,80,0.5)' }}>{fc.tier}</span>
                                   {fc.claim}
                                 </div>
                               ))}
                             </div>
                           )}

                           {/* Fragility assumption */}
                           {fragilityAssumption && (
                             <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 3 }}>
                               <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(255,200,80,0.45)' }}>fragile assumption</div>
                               <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', lineHeight: 1.55, fontStyle: 'italic' as const }}>{fragilityAssumption}</div>
                             </div>
                           )}

                           {/* Frontier question */}
                           {frontierQuestion && (
                             <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 3 }}>
                               <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(100,180,255,0.45)' }}>open research question</div>
                               <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', lineHeight: 1.55, fontStyle: 'italic' as const }}>{frontierQuestion}</div>
                             </div>
                           )}

                           {/* I5 Adversarial critic findings */}
                           {round.criticProblems && round.criticProblems.length > 0 && (
                             <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
                               <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(248,124,124,0.5)' }}>critic flags</div>
                               {round.criticProblems.map((p, i) => (
                                 <div key={i} style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', lineHeight: 1.55, paddingLeft: 8, borderLeft: '2px solid rgba(248,124,124,0.2)' }}>{p}</div>
                               ))}
                             </div>
                           )}

                           {/* P12 — live shard progress during deep-mode MASTERPIECE */}
                           {round.masterpiece?.active && round.masterpiece.shardsTotal != null && round.masterpiece.shardsCompleted != null && round.masterpiece.shardsCompleted < round.masterpiece.shardsTotal && (
                             <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                               <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(130,160,255,0.55)' }}>deep analysis</div>
                               <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>
                                 {round.masterpiece.shardsCompleted}/{round.masterpiece.shardsTotal} shards
                               </div>
                               <div style={{ flex: 1, height: 2, background: 'rgba(255,255,255,0.08)', borderRadius: 1, overflow: 'hidden' }}>
                                 <div style={{ height: '100%', width: `${Math.round((round.masterpiece.shardsCompleted / round.masterpiece.shardsTotal) * 100)}%`, background: 'rgba(130,160,255,0.5)', transition: 'width 0.4s ease' }} />
                               </div>
                             </div>
                           )}

                           {/* Track P — MASTERPIECE analysis metadata */}
                           {round.masterpiece && (round.masterpiece.shardCount || round.masterpiece.connectionsFound) && (
                             <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 5 }}>
                               <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(130,160,255,0.55)' }}>masterpiece synthesis</div>
                               <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 8 }}>
                                 {round.masterpiece.shardCount && (
                                   <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>{round.masterpiece.shardCount} shards</span>
                                 )}
                                 {round.masterpiece.connectionsSurvived != null && (
                                   <span style={{ fontSize: 10, color: 'rgba(130,220,160,0.5)' }}>{round.masterpiece.connectionsSurvived} cross-domain connections</span>
                                 )}
                                 {round.masterpiece.resonancesFound != null && round.masterpiece.resonancesFound > 0 && (
                                   <span style={{ fontSize: 10, color: 'rgba(130,160,255,0.5)' }}>{round.masterpiece.resonancesFound} structural resonance{round.masterpiece.resonancesFound !== 1 ? 's' : ''}</span>
                                 )}
                                 {round.masterpiece.escalatedCount != null && round.masterpiece.escalatedCount > 0 && (
                                   <span style={{ fontSize: 10, color: 'rgba(255,200,80,0.45)' }}>{round.masterpiece.escalatedCount} escalated</span>
                                 )}
                                 {round.masterpiece.elapsedMs && (
                                   <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)' }}>{(round.masterpiece.elapsedMs / 1000).toFixed(1)}s</span>
                                 )}
                               </div>
                               {round.masterpiece.domains && round.masterpiece.domains.length > 0 && (
                                 <div style={{ fontSize: 10, color: 'rgba(130,160,255,0.35)', lineHeight: 1.55 }}>
                                   {round.masterpiece.domains.slice(0, 4).join('  ·  ')}
                                 </div>
                               )}
                               {round.masterpiece.patterns && round.masterpiece.patterns.length > 0 && (
                                 <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', lineHeight: 1.55 }}>
                                   patterns: {round.masterpiece.patterns.join(', ')}
                                 </div>
                               )}
                               {round.masterpiece.tiers && round.masterpiece.tiers.some(t => t.tier === 'HIGH') && (
                                 <div style={{ fontSize: 10, color: 'rgba(77,220,160,0.4)', lineHeight: 1.55 }}>
                                   {round.masterpiece.tiers.filter(t => t.tier === 'HIGH').length} high-confidence shards
                                 </div>
                               )}
                             </div>
                           )}

                           {/* Track P — light-mode cross-domain connection (novelty > 0.6) */}
                           {round.crossDomainConnection && (
                             <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 3 }}>
                               <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(130,160,255,0.5)' }}>cross-domain connection</div>
                               <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', lineHeight: 1.55 }}>{round.crossDomainConnection}</div>
                             </div>
                           )}

                           {/* Proactive suggestion */}
                           {round.proactiveSuggestion && (
                             <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 3 }}>
                               <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(100,180,255,0.35)' }}>also relevant</div>
                               <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', lineHeight: 1.55 }}>{round.proactiveSuggestion}</div>
                             </div>
                           )}

                           {/* Confidence-gated response commitment */}
                           {round.uncertainCommitment && (
                             <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4, padding: '8px 10px', background: 'rgba(255,180,60,0.06)', borderRadius: 6, border: '1px solid rgba(255,180,60,0.15)' }}>
                               <div style={{ fontSize: 9, letterSpacing: '0.09em', textTransform: 'uppercase' as const, color: 'rgba(255,180,60,0.55)' }}>low confidence · {Math.round(round.uncertainCommitment.overallScore * 100)}%</div>
                               <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', lineHeight: 1.6 }}>
                                 A definitive answer requires: {round.uncertainCommitment.resolvingStep}
                               </div>
                             </div>
                           )}

                           {/* Verify status */}
                           {round.verifyStatus !== 'idle' && (
                             <div style={{
                               fontSize: 10, letterSpacing: '0.04em',
                               color: round.verifyStatus === 'clean' || round.verifyStatus === 'fixed'
                                 ? 'rgba(77,220,160,0.8)'
                                 : round.verifyStatus === 'failed'
                                 ? 'rgba(248,124,124,0.8)'
                                 : 'rgba(255,255,255,0.3)',
                               display: 'flex', alignItems: 'center', gap: 6,
                             }}>
                               {round.verifyStatus === 'running' && (
                                 <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'rgba(255,255,255,0.3)', display: 'inline-block', animation: 'pulse 1s infinite' }} />
                               )}
                               {round.verifyMessage}
                             </div>
                           )}

                         </div>
                       </details>
                     </>
                   )
                 })()}
               </div>
                </PourWrap>
             )}
            </div>
          )
        })}
        {/* Bottom spacer — lives INSIDE the scroll so the scroll viewport extends down
            behind the cards/input bar, letting the fade mask land on the card line.
            Height = cards-top distance from bottom + 1, and marginTop:-32 cancels the
            container's 32px flex gap so the most-recent message rests exactly 1px above
            the cards — snug, never obstructed, never floating high. Doubles as scroll anchor. */}
        <div ref={bottomRef} style={{ flexShrink: 0, height: 0 }} />
      </div>
  )
})

// ── chat/AgentPanel — live agent-loop surface + clarification card + code block ──
import { useState } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { CopyButton, type AgentState } from './core'
import { STEP_GLYPH, STEP_COLOR, ToolRow, DiffBlock } from './panels'
import { CodeRunBar } from './CodeRunner'

// Collapsible code block — collapsed by default on mobile, always expanded on desktop
export function CollapsibleCode({ language, code }: { language: string; code: string }) {
  const lineCount = code.split('\n').length
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="crucible-code-block" style={{ position: 'relative', margin: '12px 0', borderRadius: 10, overflow: 'hidden', maxWidth: '100%', boxSizing: 'border-box' as const }}>
      {/* Always-visible header */}
      <div
        className="crucible-code-header"
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '6px 12px', background: 'rgba(0,0,0,0.4)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          cursor: 'pointer', userSelect: 'none' as const,
        }}>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.08em' }}>{language.toUpperCase()}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="crucible-code-lines" style={{ fontSize: 9, color: 'rgba(255,255,255,0.2)' }}>{lineCount} lines</span>
          <span className="crucible-expand-hint" style={{ fontSize: 9, color: 'rgba(124,124,248,0.6)' }}>{expanded ? 'collapse' : 'expand'}</span>
          <CopyButton text={code} inline />
        </div>
      </div>
      {/* Run / live-preview bar — visible even while the block is collapsed, so a
          generated game is one click from playable without expanding the source. */}
      <CodeRunBar language={language} code={code} />
      {/* Body — hidden on mobile until expanded */}
      <div className={expanded ? 'crucible-code-body crucible-code-body--open' : 'crucible-code-body'}>
        <SyntaxHighlighter
          style={oneDark}
          language={language}
          PreTag="div"
          wrapLongLines
          customStyle={{ margin: 0, borderRadius: 0, fontSize: 12, background: 'rgba(0,0,0,0.3)', maxWidth: '100%', boxSizing: 'border-box', whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere', userSelect: 'text' }}
          codeTagProps={{ style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere', display: 'block' } }}
        >{code}</SyntaxHighlighter>
      </div>
    </div>
  )
}

// HITL_PLANNING_TRACK.md §3 — MC-first clarification card. Renders whichever shape the
// backend sent: 2-4 option buttons (with the recommended one visually marked) when the
// ambiguity gate supplied real candidates, or a free-text box for the plain ask_user path.
// Either way the reply is just the next chat message — the server threads it back into the
// same agent loop via accumulated session messages, so `onReply` is literally `send(text)`.
export function ClarificationCard({ clarification, onReply }: {
  clarification: NonNullable<AgentState['clarification']>
  onReply: (text: string) => void
}) {
  const [answered, setAnswered] = useState(false)
  const [freeText, setFreeText] = useState('')
  const [showFreeText, setShowFreeText] = useState(!clarification.options?.length)

  const reply = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || answered) return
    setAnswered(true)
    onReply(trimmed)
  }

  return (
    <div style={{
      border: '1px solid rgba(251,191,36,0.3)', borderRadius: 10, padding: 12,
      background: 'rgba(251,191,36,0.06)', display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: '#fbbf24', fontWeight: 700 }}>
        <span>needs your input</span>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.5, color: '#eee' }}>{clarification.question}</div>

      {!answered && clarification.options && clarification.options.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {clarification.options.map(opt => {
            const isRecommended = opt === clarification.recommended
            const isEscapeHatch = /something else|not sure/i.test(opt)
            return (
              <button
                key={opt}
                onClick={() => isEscapeHatch ? setShowFreeText(true) : reply(opt)}
                style={{
                  textAlign: 'left', padding: '9px 12px', borderRadius: 8, fontSize: 12.5,
                  cursor: 'pointer', fontFamily: 'inherit', color: '#eee',
                  background: isRecommended ? 'rgba(251,191,36,0.14)' : 'rgba(255,255,255,0.05)',
                  border: `1px solid ${isRecommended ? 'rgba(251,191,36,0.5)' : 'rgba(255,255,255,0.1)'}`,
                }}>
                {opt}{isRecommended && <span style={{ marginLeft: 8, fontSize: 10, color: '#fbbf24' }}>recommended default</span>}
              </button>
            )
          })}
        </div>
      )}

      {!answered && showFreeText && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={freeText}
            onChange={e => setFreeText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') reply(freeText) }}
            placeholder="Type your answer…"
            style={{
              flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 12.5,
              background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.12)',
              color: '#eee', fontFamily: 'inherit',
            }}
          />
          <button
            onClick={() => reply(freeText)}
            style={{
              padding: '8px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600,
              cursor: 'pointer', fontFamily: 'inherit', color: '#0a0a0e',
              background: '#fbbf24', border: 'none',
            }}>
            Reply
          </button>
        </div>
      )}

      {answered && <div style={{ fontSize: 11.5, color: '#888' }}>Sent — continuing…</div>}
    </div>
  )
}

export function AgentPanel({ agent, onReply }: { agent: AgentState; onReply: (text: string) => void }) {
  const verifyByLatest = agent.verifies[agent.verifies.length - 1]
  return (
    <div style={{
      animation: 'panelUp 0.3s cubic-bezier(0.22,1,0.36,1)',
      border: '1px solid rgba(124,124,248,0.18)', borderRadius: 12, padding: 12,
      background: 'rgba(124,124,248,0.04)', display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase' as const, color: '#7c7cf8', fontWeight: 700 }}>
        <span style={{ animation: agent.active ? 'fadeIn 0.5s ease-in-out infinite alternate' : 'none' }}>
          {agent.active ? 'agent working' : agent.done?.ok ? 'agent complete' : agent.error ? 'agent error' : 'agent finished'}
        </span>
        {agent.driver && <span style={{ color: '#555', textTransform: 'none' as const, letterSpacing: 0 }}>· {agent.driver}</span>}
        <div style={{ flex: 1 }} />
        {agent.done?.ms != null && <span style={{ color: '#555', textTransform: 'none' as const, letterSpacing: 0 }}>{(agent.done.ms / 1000).toFixed(1)}s</span>}
      </div>

      {/* Plan checklist */}
      {agent.steps.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {agent.steps.map(st => (
            <div key={st.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 11.5, color: st.status === 'done' ? '#777' : '#ccc' }}>
              <span style={{ color: STEP_COLOR[st.status] ?? '#555', flexShrink: 0 }}>{STEP_GLYPH[st.status] ?? '○'}</span>
              <span style={{ textDecoration: st.status === 'done' ? 'line-through' : 'none' }}>{st.intent}</span>
            </div>
          ))}
          {agent.replanned && <div style={{ fontSize: 9, color: '#fbbf24' }}>↻ replanned</div>}
        </div>
      )}

      {/* Tool timeline */}
      {agent.tools.length > 0 && (
        <div>
          <div style={{ fontSize: 9, color: '#555', letterSpacing: '0.1em', textTransform: 'uppercase' as const, marginBottom: 4 }}>tools · {agent.tools.length}</div>
          <div style={{
            maxHeight: 180, overflowY: 'auto', overflowX: 'hidden',
            background: 'rgba(0,0,0,0.5)', borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.06)', padding: '8px 14px 8px 8px',
          }}>
            {/* Most-recent-first: tools are appended chronologically, so render reversed. */}
            {agent.tools.map((t, i) => [t, i] as const).reverse().map(([t, i]) => <ToolRow key={`${t.id}:${i}`} t={t} />)}
          </div>
        </div>
      )}

      {/* Diffs */}
      {agent.diffs.length > 0 && (
        <div>
          <div style={{ fontSize: 9, color: '#555', letterSpacing: '0.1em', textTransform: 'uppercase' as const, marginBottom: 4 }}>changes · {agent.diffs.length}</div>
          <div style={{ maxHeight: 280, overflowY: 'auto', overflowX: 'hidden', paddingRight: 2 }}>
            {agent.diffs.slice(-4).map((d, i) => <DiffBlock key={i} d={d} />)}
          </div>
        </div>
      )}

      {/* Terminal */}
      {agent.terminal.length > 0 && (
        <div>
          <div style={{ fontSize: 9, color: '#555', letterSpacing: '0.1em', textTransform: 'uppercase' as const, marginBottom: 4 }}>terminal</div>
          <div style={{ position: 'relative' }}>
            <CopyButton text={agent.terminal.join('\n')} />
            <pre className="crucible-terminal-pre" style={{
              margin: 0, padding: 8, background: 'rgba(0,0,0,0.5)', borderRadius: 6,
              fontSize: 10, lineHeight: 1.5, color: '#9fef9f', fontFamily: 'ui-monospace, monospace',
              whiteSpace: 'pre-wrap' as const, maxHeight: 180, overflow: 'auto',
            }}>{agent.terminal.slice(-3).join('\n')}</pre>
          </div>
        </div>
      )}

      {/* Verify badge */}
      {verifyByLatest && (
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
          padding: '4px 10px', borderRadius: 8, fontSize: 10.5, fontWeight: 600,
          background: verifyByLatest.passed ? 'rgba(74,222,128,0.12)' : 'rgba(248,113,113,0.12)',
          color: verifyByLatest.passed ? '#86efac' : '#fca5a5',
          border: `1px solid ${verifyByLatest.passed ? 'rgba(74,222,128,0.3)' : 'rgba(248,113,113,0.3)'}`,
        }}>
          {verifyByLatest.passed ? '✓ verified' : verifyByLatest.escalate ? '✕ unfixable — stopped' : '↻ healing'} · {verifyByLatest.signal}
        </div>
      )}

      {agent.error && <div style={{ fontSize: 11, color: '#fca5a5' }}>{agent.error}</div>}

      {/* Clarification — only once the loop has actually stopped for it; a mid-stream
          clarification event for a still-active loop means more is coming (shouldn't happen
          today since every emission site is terminal, but avoids a stale card if that changes). */}
      {agent.clarification && !agent.active && (
        <ClarificationCard clarification={agent.clarification} onReply={onReply} />
      )}
    </div>
  )
}

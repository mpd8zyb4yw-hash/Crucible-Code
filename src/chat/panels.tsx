// ── chat/panels — pipeline theater, critique grid, agent tool/diff rows, narration ──
import { useState, useRef, useEffect } from 'react'
import { CopyButton, type DynamicModel, type Round, type AgentDiff, type AgentTool } from './core'

export function ShimmerBg({ thinking, mode }: { thinking: boolean; mode: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ref = useRef(thinking); ref.current = thinking
  const modeRef = useRef(mode); modeRef.current = mode
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    let animId: number, t = 0
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight }
    resize(); window.addEventListener('resize', resize)
    const draw = () => {
      t += 0.003; ctx.clearRect(0, 0, canvas.width, canvas.height)
      // base hue per mode: quorum=255 (violet), code=165 (teal), seeker=38 (amber)
      const modeBase = modeRef.current === 'code' ? 165 : modeRef.current === 'seeker' ? 38 : 255
      const blobs = [
        { x: 0.15, y: 0.35, r: 0.30, h: modeBase + Math.sin(t) * 20 },
        { x: 0.85, y: 0.55, r: 0.25, h: modeBase - 60 + Math.cos(t * 1.3) * 15 },
        { x: 0.50, y: 0.80, r: 0.22, h: modeBase + 45 + Math.sin(t * 0.8) * 25 },
      ]
      const alpha = ref.current ? 0.05 : 0.035
      blobs.forEach(b => {
        const x = b.x * canvas.width, y = b.y * canvas.height
        const r = b.r * Math.min(canvas.width, canvas.height)
        const g = ctx.createRadialGradient(x, y, 0, x, y, r)
        g.addColorStop(0, `hsla(${b.h},70%,60%,${alpha * 2.2})`)
        g.addColorStop(1, `hsla(${b.h},70%,60%,0)`)
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill()
      })
      animId = requestAnimationFrame(draw)
    }
    draw()
    return () => { cancelAnimationFrame(animId); window.removeEventListener('resize', resize) }
  }, [])
  return <canvas ref={canvasRef} style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none' }} />
}


// ── Pipeline Theater (Section 3) ─────────────────────────────────────────────
// Full-width grid of per-model response cards shown when the user message is clicked.

export function LinterBadge({ status }: { status: string }) {
  const cfg =
    status === 'passed'     ? { label: 'pass',   bg: 'rgba(77,184,158,0.15)',  border: 'rgba(77,184,158,0.4)',  color: '#4db89e' } :
    status === 'remediated' ? { label: 'fixed',  bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.35)', color: '#f59e0b' } :
    status === 'failed'     ? { label: 'failed', bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.35)',color: '#f87171' } :
                              null
  if (!cfg) return null
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
      padding: '2px 6px', borderRadius: 4,
      background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color,
    }}>{cfg.label.toUpperCase()}</span>
  )
}

export function ModelTheaterCard({ model, round }: { model: DynamicModel; round: Round }) {
  const [showMore, setShowMore] = useState(false)
  const linter = round.linterStatus[model.id]
  const score = round.avgScores[model.id]
  const response = round.responses[model.id] ?? ''
  const isDone = round.done[model.id]

  // Find the richest critique of this model — prefer self-critique; fall back to best peer
  let critiqueText = round.critiques[model.id]?.[model.id]?.text ?? ''
  if (!critiqueText && round.stage3Done) {
    let bestScore = -1
    for (const critic of round.models) {
      if (critic.id === model.id) continue
      const t = round.critiques[critic.id]?.[model.id]?.text
      if (t && (round.avgScores[critic.id] ?? 0) > bestScore) {
        bestScore = round.avgScores[critic.id] ?? 0
        critiqueText = t
      }
    }
  }

  const PREVIEW = 280
  const isLong = response.length > PREVIEW
  const displayText = showMore || !isDone ? response : response.slice(0, PREVIEW) + (isLong ? '…' : '')

  return (
    <div style={{
      borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8,
      background: `linear-gradient(145deg, rgba(${model.rgb},0.07) 0%, rgba(10,10,14,0.6) 100%)`,
      backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
      border: `1px solid rgba(${model.rgb},0.18)`,
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
          background: isDone ? model.color : 'transparent',
          border: isDone ? 'none' : `1.5px solid ${model.color}`,
          boxShadow: !isDone ? `0 0 6px ${model.color}` : 'none',
          animation: !isDone ? 'dotpulse 1.2s ease-in-out infinite' : 'none',
        }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: model.color, letterSpacing: '0.04em', flex: 1 }}>
          {model.label}
          {model.isWildcard && <span style={{ fontSize: 8, color: '#555', marginLeft: 3 }}>✦</span>}
        </span>
        {round.stage2Done && score !== undefined && (
          <span style={{
            fontSize: 9, fontWeight: 700,
            color: score >= 0.7 ? '#4db89e' : score >= 0.5 ? '#c084fc' : '#f87171',
            marginRight: 2,
          }}>{(score * 100).toFixed(0)}%</span>
        )}
        {linter && <LinterBadge status={linter.status} />}
      </div>

      {/* Score bar */}
      {round.stage2Done && score !== undefined && (
        <div style={{ height: 2, borderRadius: 2, background: 'rgba(255,255,255,0.05)', overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 2,
            width: `${(score * 100).toFixed(1)}%`,
            background: score >= 0.7 ? '#4db89e' : score >= 0.5 ? '#c084fc' : '#f87171',
            transition: 'width 0.8s cubic-bezier(0.22,1,0.36,1)',
          }} />
        </div>
      )}

      {/* Response text */}
      <div style={{
        fontSize: 12, lineHeight: 1.65, color: '#a8a8c0',
        overflowWrap: 'anywhere', wordBreak: 'break-word', whiteSpace: 'pre-wrap',
      }}>
        {displayText || <span style={{ color: '#1e1e2e' }}>···</span>}
      </div>

      {isDone && isLong && (
        <button onClick={() => setShowMore(s => !s)} style={{
          alignSelf: 'flex-start', background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 10, color: `rgba(${model.rgb},0.45)`, letterSpacing: '0.06em', padding: 0,
        }}>
          {showMore ? 'show less' : 'show more'}
        </button>
      )}

      {/* Critique snippet — appears after debate stage */}
      {round.stage3Done && critiqueText && (
        <div style={{
          fontSize: 11, lineHeight: 1.55, color: 'rgba(255,255,255,0.22)',
          borderTop: `1px solid rgba(${model.rgb},0.1)`, paddingTop: 8,
          fontStyle: 'italic',
          overflowWrap: 'anywhere', wordBreak: 'break-word',
        }}>
          {critiqueText.length > 280 ? critiqueText.slice(0, 280) + '…' : critiqueText}
        </div>
      )}
    </div>
  )
}

export function PipelineTheater({ round }: { round: Round }) {
  const models = round.models
  if (!models.length) return null
  return (
    <div className="crucible-pipeline-theater" style={{ animation: 'panelUp 0.25s cubic-bezier(0.22,1,0.36,1)' }}>
      <div style={{
        // Responsive auto-fill: cards flow into as many columns as fit, so a 3rd
        // (or 5th) model never sits orphaned in a half-empty row. Mobile.css overrides
        // this to a horizontal scroll strip.
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
        gap: 8,
      }}>
        {models.map(m => <ModelTheaterCard key={m.id} model={m} round={round} />)}
      </div>
    </div>
  )
}

export function CritiqueGrid({ round, onToggle }: { round: Round; onToggle: (critic: string, target: string) => void }) {
  const models = round.models
  let doneCount = 0
  const totalPairs = models.length * (models.length - 1)
  for (const critic of models)
    for (const target of models)
      if (critic.id !== target.id && round.critiques[critic.id]?.[target.id]?.done) doneCount++

  const expanded = round.expandedCritique
  return (
    <div className="crucible-critique-grid" style={{ padding: '0 2px', animation: 'panelUp 0.3s cubic-bezier(0.22,1,0.36,1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ height: 1, flex: 1, background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.06))' }} />
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
          color: round.stage3Done ? '#2e2e4a' : '#7c7cf8', textTransform: 'uppercase' as const,
          animation: round.stage3Done ? 'none' : 'fadeIn 0.5s ease-in-out infinite alternate',
        }}>
          {round.stage3Done ? 'cross-critique complete' : `debating · ${doneCount}/${totalPairs}`}
        </span>
        <div style={{ height: 1, flex: 1, background: 'linear-gradient(90deg, rgba(255,255,255,0.06), transparent)' }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {models.map(critic => {
          const targets = models.filter(t => t.id !== critic.id)
          return (
            <div key={critic.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{
                minWidth: 56, maxWidth: 88, flexShrink: 1, textAlign: 'right', paddingRight: 6,
                fontSize: 9, fontWeight: 700, letterSpacing: '0.07em',
                color: `rgba(${critic.rgb},0.35)`, textTransform: 'uppercase' as const,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
              }}>{critic.label}</span>
              {targets.map(target => {
                const critique = round.critiques[critic.id]?.[target.id]
                const isDone = critique?.done ?? false
                const isActive = round.stage3Started && !isDone
                const isExpanded = expanded?.critic === critic.id && expanded?.target === target.id
                return (
                  <button key={target.id} onClick={() => isDone && onToggle(critic.id, target.id)} style={{
                    flex: 1, padding: '5px 8px', borderRadius: 7,
                    border: `1px solid ${isExpanded ? `rgba(${target.rgb},0.4)` : isDone ? `rgba(${target.rgb},0.15)` : 'rgba(255,255,255,0.04)'}`,
                    background: isExpanded ? `rgba(${target.rgb},0.08)` : isDone ? `rgba(${target.rgb},0.03)` : 'transparent',
                    cursor: isDone ? 'pointer' : 'default',
                    display: 'flex', alignItems: 'center', gap: 5, outline: 'none', transition: 'all 0.2s',
                  }}>
                    <span style={{
                      width: 4, height: 4, borderRadius: '50%', flexShrink: 0,
                      background: isDone ? target.color : isActive ? target.color : '#1a1a28',
                      boxShadow: isActive ? `0 0 5px ${target.color}` : 'none',
                      animation: isActive ? 'dotpulse 1.2s ease-in-out infinite' : 'none',
                      transition: 'all 0.3s',
                    }} />
                    <span style={{
                      fontSize: 9.5, fontWeight: 600, letterSpacing: '0.04em',
                      color: isExpanded ? target.color : isDone ? `rgba(${target.rgb},0.5)` : '#1e1e2e',
                      whiteSpace: 'nowrap' as const, transition: 'color 0.2s',
                      overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>→ {target.label}</span>
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
      {expanded && (() => {
        const critique = round.critiques[expanded.critic]?.[expanded.target]
        if (!critique?.text) return null
        const criticModel = round.models.find(m => m.id === expanded.critic)!
        const targetModel = round.models.find(m => m.id === expanded.target)!
        if (!criticModel || !targetModel) return null
        return (
          <div style={{
            marginTop: 8, borderRadius: 10, padding: '10px 14px',
            background: `linear-gradient(135deg, rgba(${criticModel.rgb},0.05) 0%, rgba(10,10,14,0.75) 100%)`,
            backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
            border: `1px solid rgba(${criticModel.rgb},0.15)`,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
            animation: 'panelUp 0.18s cubic-bezier(0.22,1,0.36,1)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 8 }}>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: `rgba(${criticModel.rgb},0.6)`, textTransform: 'uppercase' as const }}>{criticModel.label}</span>
              <span style={{ fontSize: 9, color: '#2a2a3a' }}>critiques</span>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: `rgba(${targetModel.rgb},0.6)`, textTransform: 'uppercase' as const }}>{targetModel.label}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
              <CopyButton text={critique.text} inline title="Copy critique" />
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.7, color: '#b0b0c4', whiteSpace: 'pre-wrap', maxHeight: '28vh', overflowY: 'auto', overflowWrap: 'anywhere', wordBreak: 'break-word', userSelect: 'text', scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.1) transparent' }}>
              {critique.text}
            </div>
          </div>
        )
      })()}
    </div>
  )
}

// ── Agent panel (Section 7) — live loop surface ───────────────────────────────
export const STEP_GLYPH: Record<string, string> = { pending: '○', active: '◐', done: '●', failed: '✕' }
export const STEP_COLOR: Record<string, string> = { pending: '#555', active: '#7c7cf8', done: '#4ade80', failed: '#f87171' }
export const TOOL_GLYPH: Record<string, string> = {
  write_file: '+', edit_file: '~', apply_patch: '~', read_file: '<',
  list_dir: '/', search: '?', run: '>', ensemble_solve: '*',
}

export function DiffBlock({ d }: { d: AgentDiff }) {
  const rel = d.path.split('/').slice(-2).join('/')
  return (
    <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10.5, lineHeight: 1.5, marginTop: 4, maxHeight: 200, overflowY: 'auto', overflowX: 'hidden' }}>
      <div style={{ color: '#888', marginBottom: 2 }}>{rel}</div>
      {d.patch ? (
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' as const }}>
          {d.patch.split('\n').map((ln, i) => (
            <div key={i} style={{
              background: ln.startsWith('+') ? 'rgba(74,222,128,0.12)' : ln.startsWith('-') ? 'rgba(248,113,113,0.12)' : 'transparent',
              color: ln.startsWith('+') ? '#86efac' : ln.startsWith('-') ? '#fca5a5' : '#999', padding: '0 4px',
            }}>{ln || ' '}</div>
          ))}
        </pre>
      ) : (
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' as const }}>
          {(d.old ?? '').split('\n').map((ln, i) => <div key={'o' + i} style={{ background: 'rgba(248,113,113,0.12)', color: '#fca5a5', padding: '0 4px' }}>- {ln}</div>)}
          {(d.new ?? '').split('\n').map((ln, i) => <div key={'n' + i} style={{ background: 'rgba(74,222,128,0.12)', color: '#86efac', padding: '0 4px' }}>+ {ln}</div>)}
        </pre>
      )}
    </div>
  )
}

export function ToolRow({ t }: { t: AgentTool }) {
  const [open, setOpen] = useState(false)
  const color = t.done ? (t.ok ? '#4ade80' : '#f87171') : '#7c7cf8'
  const label = t.tool === 'run' && t.args?.command ? t.args.command
    : t.tool === 'search' && t.args?.pattern ? `/${t.args.pattern}/`
    : (t.args?.path ?? t.args?.subprompt?.slice?.(0, 60) ?? '')
  return (
    <div style={{ borderLeft: `2px solid ${color}`, paddingLeft: 8, marginBottom: 3 }}>
      <div onClick={() => t.output && setOpen(o => !o)} style={{
        display: 'flex', alignItems: 'center', gap: 6, cursor: t.output ? 'pointer' : 'default',
        fontSize: 11, color: '#bbb', fontFamily: 'ui-monospace, monospace',
      }}>
        <span style={{ color }}>{t.done ? (t.ok ? '✓' : '✕') : (TOOL_GLYPH[t.tool] ?? '·')}</span>
        <span style={{ fontWeight: 600, color: '#ddd' }}>{t.tool}</span>
        <span style={{ color: '#777', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, flex: 1 }}>{String(label)}</span>
        {t.output && <span style={{ color: '#555', fontSize: 9 }}>{open ? '▾' : '▸'}</span>}
      </div>
      {open && t.output && (
        <pre style={{
          margin: '3px 0 0', padding: 6, background: 'rgba(0,0,0,0.4)', borderRadius: 4,
          fontSize: 10, color: '#9a9', whiteSpace: 'pre-wrap' as const, maxHeight: 200, overflow: 'auto',
        }}>{t.output}{t.truncated ? '\n…(truncated)' : ''}</pre>
      )}
    </div>
  )
}

// When the verify/refinement pass returns fixed code, splice it back INTO the original
// answer's first fenced code block — preserving the language tag, surrounding prose, and
// the CollapsibleCode rendering. Only the code changes; the UI shape stays identical.
// Falls back to wrapping in a fence if the original had no code block.
// VAPID public key (base64url) → Uint8Array for PushManager.subscribe.
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

export function applyFixedCode(original: string, fixedCode: string): string {
  if (!fixedCode) return original
  // If the fixer wrapped its output in its own fence, splice only the inner code so we
  // never nest fences or inherit a stray language tag (this caused "code reset to TypeScript").
  let inner = fixedCode.trim()
  const selfFence = /^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n```$/.exec(inner)
  if (selfFence) inner = selfFence[1].trim()

  // CRITICAL backstop: the verify pass sometimes returns a NON-code response — a refusal,
  // an explanation, or "// No change needed…" — or a degenerate stub. Never let that
  // overwrite a real code answer (this destroyed a full code block, replacing it with a
  // one-line comment). Reject any "fix" that is comment/whitespace-only or drastically
  // smaller than the code it would replace.
  const fenceRe = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)\n```/
  const m = fenceRe.exec(original)
  const realCodeLines = inner.split('\n').filter(l => {
    const t = l.trim()
    return t && !t.startsWith('//') && !t.startsWith('#') && !t.startsWith('/*') && !t.startsWith('*')
  })
  if (realCodeLines.length === 0) return original            // only comments / blank → not a fix
  const originalCode = m ? m[2].trim() : ''
  if (originalCode.length > 120 && inner.length < originalCode.length * 0.5) return original  // gutted answer

  if (m) {
    // Preserve the ORIGINAL language tag verbatim — never relabel python/etc. as TypeScript.
    return original.replace(fenceRe, (_full, lang) => '```' + (lang || '') + '\n' + inner + '\n```')
  }
  // No fenced block in the original — it's a prose answer. Do NOT wrap it into a code
  // block; that's the "plain text turned into a TypeScript block" bug. Leave prose alone.
  return original
}

// Personality-driven, deterministic narration of how this specific answer came together.
// Pure inference from the round's own data (scores, spread, critiques, model sizes, verify
// outcome) — no model call, no randomness, so it reads the same every time you reopen it but
// is different for every prompt. Replaces the old one-size-fits-all "Process" sentence.
export function narrateProcess(round: any, active: any[], dropped: any[], synthesizer: any, topScore: number): string {
  const scores = active.map(m => round.avgScores[m.id] ?? 0)
  const minScore = scores.length ? Math.min(...scores) : topScore
  const spread = topScore - minScore
  const critiqueCount = Object.keys(round.critiques ?? {}).length
  const sizeOf = (label: string): number | null => {
    const m = /(\d+(?:\.\d+)?)\s*B\b/i.exec(label || '')
    return m ? parseFloat(m[1]) : null
  }
  const synthSize = sizeOf(synthesizer?.label ?? '')
  const parts: string[] = []

  // 1) Opener — set by how hard the answer was to reach.
  if (round.complexity === 'simple' || topScore >= 0.85) {
    if (spread < 0.10) {
      parts.push('A straightforward one — the models were in immediate agreement and moved fast.')
    } else {
      parts.push('A simple enough question, though the models took slightly different angles before settling on the same answer.')
    }
  } else if (topScore >= 0.92 && spread < 0.12) {
    parts.push('This came together cleanly: the models were in strong agreement from the very first pass, so little arbitration was needed.')
  } else if (topScore >= 0.82) {
    parts.push('A solid run — the first answers were close, and a round of mutual critique sharpened the lead before synthesis.')
  } else if (topScore >= 0.68) {
    parts.push('This one took some real thinking. The opening answers were uneven, so the models picked each other apart and revised before they converged.')
  } else {
    parts.push('A genuinely hard prompt — no model had it cleanly at first. The answer was rebuilt from the strongest fragments after the models challenged every weak point.')
  }

  // 2) Underdog callout — a small model that matched the big ones.
  const underdog = active
    .map(m => ({ m, size: sizeOf(m.label), s: round.avgScores[m.id] ?? 0 }))
    .filter(x => x.size !== null && x.size <= 9 && x.s >= topScore - 0.04)
    .sort((a, b) => (a.size as number) - (b.size as number))[0]
  if (underdog && (!synthSize || (underdog.size as number) < synthSize)) {
    parts.push(`Worth noting — ${underdog.m.label} (${underdog.size}B) punched well above its weight, holding its own against models many times larger.`)
  }

  // 3) Disagreement texture.
  if (spread >= 0.25 && critiqueCount >= 2) {
    parts.push('The models genuinely disagreed early; the cross-critique is what pulled them onto the same page.')
  }

  // 4) Verification outcome, if code was run.
  if (round.verifyStatus === 'fixed') {
    parts.push('The first synthesis didn’t execute clean, so the verification pass caught the bug and repaired it before you saw it.')
  } else if (round.verifyStatus === 'clean') {
    parts.push('The final code ran clean on the first try.')
  }

  // 5) Resilience note if models dropped.
  if (dropped.length > 0) {
    parts.push(`All of this held together even after ${dropped.map((m: any) => m.label).join(' and ')} dropped out mid-run.`)
  }

  // U11 — ANIMA active indicator: when ANIMA has live truths it shaped this response,
  // surface a quiet note so the user knows the system is learning about them over time.
  if (round.animaTruths && round.animaTruths.length > 0) {
    parts.push(`ANIMA shaped this response with ${round.animaTruths.length} observed pattern${round.animaTruths.length === 1 ? '' : 's'} about human experience.`)
  }

  return parts.join(' ')
}

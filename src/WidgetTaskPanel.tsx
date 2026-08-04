// ── WidgetTaskPanel — an agent action that stays inside its card ───────────────
// The user-visible contract, deliberately narrow:
//   · A button that DOES the thing. One click, no prompt to read, nothing to press
//     Enter on, and no navigation away from the card you were looking at.
//   · Optional intent — tone presets, or your own words. These are instructions, not
//     a template to edit; the underlying prompt is never shown.
//   · The result renders HERE, with plain-words progress while it works.
//   · Nothing is sent anywhere. A draft is a draft — outward-facing actions still go
//     through the confirm gate (DESIGN_HANDOFF §7.3). "Open in chat" is the explicit
//     escape hatch when the user wants a real conversation about it.

import { useCallback, useEffect, useRef, useState } from 'react'
import { runWidgetTask, IDLE_TASK, TONE_PRESETS, type TaskState } from './design/widgetTask'

function Pill({ children, onClick, primary, disabled, title }: {
  children: React.ReactNode; onClick: () => void; primary?: boolean; disabled?: boolean; title?: string
}) {
  return (
    <button
      onClick={onClick} disabled={disabled} title={title}
      style={{
        fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
        padding: '6px 12px', borderRadius: 999, flexShrink: 0,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
        background: primary ? 'rgba(165,180,252,0.92)' : 'rgba(127,127,150,0.16)',
        border: primary ? 'none' : '1px solid var(--glass-edge)',
        color: primary ? '#101322' : 'var(--glass-text)',
        transition: 'background var(--dur-fast) var(--ease-standard)',
      }}
    >{children}</button>
  )
}

export default function WidgetTaskPanel({
  action, prompt, agent, resultLabel, onOpenInChat, allowTone = true,
}: {
  /** The button label the user actually reads, e.g. "Draft reply". */
  action: string
  /** The task in prompt form. NEVER rendered. */
  prompt: string
  agent?: boolean
  /** Heading over the result, e.g. "Draft". */
  resultLabel?: string
  /** Hand the finished text to a real conversation — explicit, never automatic. */
  onOpenInChat?: (text: string) => void
  allowTone?: boolean
}) {
  const [task, setTask] = useState<TaskState>(IDLE_TASK)
  const [custom, setCustom] = useState('')
  const [showCustom, setShowCustom] = useState(false)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => () => abort.current?.abort(), [])

  const run = useCallback((instruction?: string) => {
    abort.current?.abort()
    const ac = new AbortController()
    abort.current = ac
    void runWidgetTask({
      prompt, instruction, agent, signal: ac.signal,
      onUpdate: patch => setTask(prev => ({ ...prev, ...patch })),
    })
  }, [prompt, agent])

  const busy = task.phase === 'working'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      {task.phase === 'idle' && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Pill primary onClick={() => run()}>{action}</Pill>
        </div>
      )}

      {busy && (
        // Words, not a bare spinner. The pulse is opacity-only so it survives reduced motion.
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span className="cru-pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: '#A5B4FC', flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: 'var(--glass-text-2)', minWidth: 0, overflowWrap: 'anywhere' }}>
            {task.step || 'Working'}…
          </span>
          <div style={{ flex: 1 }} />
          <Pill onClick={() => { abort.current?.abort(); setTask(IDLE_TASK) }}>Stop</Pill>
        </div>
      )}

      {task.phase === 'error' && (
        <div style={{
          padding: '10px 12px', borderRadius: 12,
          background: 'var(--alarm-fill)', border: '1px solid var(--alarm-edge)',
        }}>
          <div style={{ fontSize: 13, color: 'var(--alarm-ink)', fontWeight: 600 }}>Couldn’t finish</div>
          <div style={{ marginTop: 3, fontSize: 12.5, color: 'var(--glass-text-2)', overflowWrap: 'anywhere' }}>{task.error}</div>
          <div style={{ marginTop: 8 }}><Pill onClick={() => run()}>Try again</Pill></div>
        </div>
      )}

      {(task.text || (busy && task.text)) && (
        <div style={{
          background: 'var(--glass-fill-plate)', border: '1px solid var(--glass-edge)',
          borderRadius: 12, padding: '12px 14px', minWidth: 0,
        }}>
          {resultLabel && (
            <div style={{
              font: '600 10px/1 var(--mono)', letterSpacing: '0.14em', textTransform: 'uppercase',
              color: 'var(--glass-text-2)', marginBottom: 8,
            }}>{resultLabel}</div>
          )}
          <div style={{
            fontSize: 13.5, lineHeight: 1.55, color: 'var(--glass-text)',
            whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
            maxHeight: 260, overflowY: 'auto',
          }}>{task.text}</div>
        </div>
      )}

      {task.phase === 'done' && task.text && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {allowTone && TONE_PRESETS.map(t => (
            <Pill key={t.id} onClick={() => run(t.instruction)} title={`Redo — ${t.label.toLowerCase()}`}>{t.label}</Pill>
          ))}
          {allowTone && <Pill onClick={() => setShowCustom(v => !v)}>Custom…</Pill>}
          <div style={{ flex: 1 }} />
          <Pill onClick={() => { void navigator.clipboard?.writeText(task.text) }}>Copy</Pill>
          {onOpenInChat && <Pill onClick={() => onOpenInChat(task.text)}>Open in chat</Pill>}
        </div>
      )}

      {showCustom && task.phase === 'done' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
          <input
            value={custom}
            onChange={e => setCustom(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && custom.trim()) { run(custom.trim()); setShowCustom(false) } }}
            placeholder="e.g. mention I’m away until Friday"
            style={{
              flex: 1, minWidth: 0, fontFamily: 'inherit', fontSize: 13,
              padding: '8px 12px', borderRadius: 10,
              background: 'rgba(127,127,150,0.14)', border: '1px solid var(--glass-edge)',
              color: 'var(--glass-text)', outline: 'none',
            }}
          />
          <Pill primary disabled={!custom.trim()} onClick={() => { if (custom.trim()) { run(custom.trim()); setShowCustom(false) } }}>Redo</Pill>
        </div>
      )}
    </div>
  )
}

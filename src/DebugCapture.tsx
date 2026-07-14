// Debug-capture button — one click gathers everything needed to diagnose a failed turn
// and copies it to the clipboard as a markdown report to paste to Claude. Surfaces the
// data that's otherwise trapped in the server's debugBus + per-round state: which routing
// tier/model answered, whether retrieval was used, corrections/repairs, verify status,
// agent driver, timings, and the recent debug event stream.

import { useState } from 'react'
import { apiFetch } from './api'
import type { Round } from './chat/core'

type DebugEvent = { ts: number; category: string; event: string; severity?: string; data?: unknown; requestId?: string }

function summariseRound(r: Round): string {
  const lines: string[] = []
  lines.push(`### Turn: ${JSON.stringify(r.userMessage?.slice(0, 300) ?? '')}`)
  lines.push(`- promptType: ${r.promptType} · complexity: ${r.complexity} · cached: ${r.cached}`)
  lines.push(`- synthesisModelId: ${r.synthesisModelId || '(none)'}`)
  if (r.agent) {
    const a = r.agent as { driver?: string; status?: string; iterations?: number } | null
    lines.push(`- agent.driver: ${a?.driver ?? '?'} · status: ${a?.status ?? '?'}${a?.iterations != null ? ` · iters: ${a.iterations}` : ''}`)
  }
  lines.push(`- verifyStatus: ${r.verifyStatus}${r.verifyMessage ? ` (${r.verifyMessage})` : ''}`)
  if (r.confidence) lines.push(`- confidence: ${r.confidence.overallTier} (${r.confidence.overallScore})`)
  if (r.semanticSim != null) lines.push(`- reused from paraphrase (sim ${r.semanticSim.toFixed(2)}): ${JSON.stringify(r.semanticMatch ?? '')}`)
  const models = Array.isArray(r.models) ? r.models.map(m => (m as { id?: string }).id).filter(Boolean) : []
  if (models.length) lines.push(`- models in pipeline: ${models.join(', ')}`)
  const synth = (r.synthesis ?? '').trim()
  lines.push(`- answer (${synth.length} chars):`)
  lines.push('```')
  lines.push(synth.slice(0, 1500) || '(empty)')
  lines.push('```')
  if (Array.isArray(r.activityFeed) && r.activityFeed.length) {
    lines.push(`- activity feed (last 8):`)
    for (const a of r.activityFeed.slice(-8)) lines.push(`  - [${a.type}] ${a.modelId ?? ''} ${a.message}`)
  }
  return lines.join('\n')
}

export default function DebugCapture({ rounds, conversationId, compact }: {
  rounds: Round[]
  conversationId: string
  compact?: boolean
}) {
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'error'>('idle')

  const capture = async () => {
    setState('working')
    try {
      let events: DebugEvent[] = []
      try {
        const r = await apiFetch('/api/debug/history?n=150')
        events = (await r.json()).events ?? []
      } catch { /* server may be down — still emit the client-side report */ }

      // Prefer events tied to this conversation's requests; fall back to recent errors/warns.
      const notable = events.filter(e => e.severity === 'error' || e.severity === 'warn')
      const report: string[] = []
      report.push(`# Crucible debug report`)
      report.push(`generated: ${new Date().toISOString()} · conversation: ${conversationId}`)
      report.push(`rounds in view: ${rounds.length} · debug events pulled: ${events.length} (${notable.length} warn/error)`)
      report.push('')
      report.push(`## Conversation turns`)
      for (const r of rounds.slice(-6)) { report.push(summariseRound(r)); report.push('') }
      report.push(`## Recent warn/error debug events`)
      if (!notable.length) report.push('(none)')
      for (const e of notable.slice(-40)) {
        report.push(`- ${new Date(e.ts).toISOString().slice(11, 19)} [${e.severity}] ${e.category}/${e.event}` +
          `${e.requestId ? ` req=${e.requestId.slice(0, 8)}` : ''} ${e.data ? JSON.stringify(e.data).slice(0, 300) : ''}`)
      }
      const text = report.join('\n')
      await navigator.clipboard.writeText(text)
      setState('done')
      setTimeout(() => setState('idle'), 2600)
    } catch {
      setState('error')
      setTimeout(() => setState('idle'), 2600)
    }
  }

  const label = state === 'done' ? 'Copied — paste to Claude'
    : state === 'working' ? 'Gathering…'
    : state === 'error' ? 'Copy failed'
    : 'Copy debug report'

  return (
    <button
      onClick={capture}
      title="Gather this conversation + recent debug events and copy for Claude"
      style={{
        display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
        padding: compact ? '5px 8px' : '6px 12px', borderRadius: 10,
        border: '1px solid var(--c-hairline)',
        background: state === 'done' ? 'rgba(77,184,158,0.14)' : 'rgba(255,255,255,0.04)',
        color: state === 'done' ? 'var(--c-on-device)' : '#b8b8cc',
        fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
        transition: 'background 0.16s, color 0.16s',
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
        <path d="M5 2.5h4l1.5 1.5H13v9H3v-11z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M6 8h4M6 10.5h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      {!compact && label}
    </button>
  )
}

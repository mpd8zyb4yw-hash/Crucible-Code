// ── chat/core — shared chat types, palette, agent-event reducer, tiny shared widgets ──
// Extracted verbatim from App.tsx in the componentization pass (2026-07-07).
import { useState } from 'react'
import { apiFetch } from '../api'

// ── Colour palette — assigned dynamically to whatever models the server picks ─
export const PALETTE = [
  { color: '#7c7cf8', rgb: '124,124,248' },
  { color: '#4db89e', rgb: '77,184,158'  },
  { color: '#c084fc', rgb: '192,132,252' },
  { color: '#f59e0b', rgb: '245,158,11'  },
  { color: '#38bdf8', rgb: '56,189,248'  },
  { color: '#f87171', rgb: '248,113,113' },
]

export interface DynamicModel {
  id: string
  label: string
  provider: string
  isWildcard: boolean
  color: string
  rgb: string
}


// ── Mode definitions ──────────────────────────────────────────────────────────
// 'research' is a real app mode (state + MODE_META + classifyMode) but intentionally
// not a user-selectable entry in the MODES menu. The ChatMode union lives in ensemble.tsx
// (imported where needed); the old `Mode` alias was only used by the removed ModeSwitcher.




// ── Rotating verb placeholder ─────────────────────────────────────────────────



export function assignColors(models: Omit<DynamicModel, 'color' | 'rgb'>[]): DynamicModel[] {
  return models.map((m, i) => ({
    ...m,
    ...PALETTE[i % PALETTE.length],
  }))
}

// Robust clipboard copy — Electron/file:// contexts often lack navigator.clipboard,
// so fall back to the legacy textarea+execCommand path.
export function copyText(text: string) {
  const fallback = () => {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      // The app root sets user-select:none, which the temp textarea would inherit —
      // making .select() select nothing and execCommand('copy') copy an empty string.
      ta.style.userSelect = 'text'
      ;(ta.style as any).webkitUserSelect = 'text'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      ta.setSelectionRange(0, ta.value.length)
      document.execCommand('copy')
      document.body.removeChild(ta)
    } catch { /* noop */ }
  }
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(fallback)
    } else {
      fallback()
    }
  } catch {
    fallback()
  }
}

// Lightweight haptic feedback for mobile (no-op where unsupported).
export function haptic(style: 'light' | 'medium' | 'heavy' = 'light') {
  try {
    if ('vibrate' in navigator) navigator.vibrate(style === 'light' ? 10 : style === 'medium' ? 20 : 40)
  } catch { /* noop */ }
}

export function CopyButton({ text, inline = false, title = 'Copy' }: { text: string; inline?: boolean; title?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation()
    copyText(text)
    haptic('light')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button onClick={copy} title={title} aria-label={title} style={{
      // Inline: sits in a flex row (code header) so it never overlaps sibling labels.
      // Default: absolute overlay pinned to the top-right of a relative container.
      ...(inline
        ? { position: 'relative' as const, flexShrink: 0 }
        : { position: 'absolute' as const, top: 8, right: 8 }),
      background: 'none', border: 'none', cursor: 'pointer',
      padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
      opacity: copied ? 1 : 0.35, transition: 'opacity 0.2s',
      color: copied ? '#4db89e' : '#aaa',
    }}>
      {copied ? (
        // Checkmark
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M2.5 7L5.5 10L11.5 4" stroke="#4db89e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ) : (
        // Two offset sheets of paper
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <rect x="4" y="1" width="8" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
          <rect x="2" y="3" width="8" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" fill="rgba(22,22,30,0.9)"/>
        </svg>
      )}
    </button>
  )
}

export function FeedbackButtons({ query, synthesis, promptType }: { query: string; synthesis: string; promptType: string }) {
  const [voted, setVoted] = useState<'up' | 'down' | null>(null)
  // Item-7: rating used to be write-once (`if (voted) return`), so a misclick could never be
  // corrected. Clicking the already-active vote un-rates; clicking the other vote switches it.
  // Every state change still POSTs so the backend sees the latest (or retracted) vote.
  const vote = (v: 'up' | 'down') => {
    const next = voted === v ? null : v
    setVoted(next)
    apiFetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, synthesis, vote: next, promptType }),
    }).catch(() => {})
  }
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {(['up', 'down'] as const).map(v => (
        <button
          key={v}
          onClick={() => vote(v)}
          title={v === 'up' ? (voted === 'up' ? 'Remove rating' : 'Good answer') : (voted === 'down' ? 'Remove rating' : 'Bad answer')}
          style={{
            background: voted === v ? (v === 'up' ? 'rgba(77,184,158,0.15)' : 'rgba(248,124,124,0.12)') : 'none',
            border: 'none', cursor: 'pointer',
            padding: '3px 5px', borderRadius: 5,
            color: voted === v ? (v === 'up' ? '#4db89e' : '#f87c7c') : 'rgba(255,255,255,0.18)',
            transition: 'color 0.15s, background 0.15s',
            fontSize: 12, lineHeight: 1,
          }}
        >
          {v === 'up' ? '▲' : '▼'}
        </button>
      ))}
    </div>
  )
}

export interface Critique { text: string; done: boolean }

export interface Round {
  id: string
  /** Owning conversation thread. Rounds from every open chat live in ONE global array
   *  (streaming updaters are keyed by unique round id, so a background chat keeps
   *  streaming while another is displayed); the UI renders the convId-filtered view. */
  convId?: string
  userMessage: string
  /** File names attached by the user this turn — rendered as chips on the sent bubble so an
   *  attachment turn is visually distinct from a plain message. */
  attachments?: string[]
  models: DynamicModel[]
  synthesisModelId: string
  promptType: string
  complexity: 'simple' | 'complex'
  responses: Record<string, string>
  done: Record<string, boolean>
  scores: Record<string, number | null>
  expandedModel: string | null
  critiques: Record<string, Record<string, Critique>>
  stage3Started: boolean
  stage3Done: boolean
  expandedCritique: { critic: string; target: string } | null
  revisions: Record<string, string>
  revisionsDone: Record<string, boolean>
  stage4Started: boolean
  stage4Done: boolean
  synthesis: string
  synthStreaming: boolean
  synthesisDone: boolean
  verifyStatus: 'idle' | 'running' | 'clean' | 'fixed' | 'needs_model' | 'failed'
  verifyMessage: string
  remediated: Record<string, boolean>
  linterStatus: Record<string, { status: string; score?: number }>
  avgScores: Record<string, number>
  stage2Done: boolean
  activityFeed: Array<{ ts: number; type: string; modelId?: string; message: string }>
  cached: boolean
  semanticSim?: number       // similarity (0–1) when this answer was reused from a paraphrase
  semanticMatch?: string     // the original query this paraphrase matched
  proactiveSuggestion?: string  // M3: ambient context suggestion, if any
  agent?: AgentState | null
  confidence?: {
    overallTier: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNVERIFIED'
    overallScore: number
    summary: { high: number; medium: number; low: number; unverified: number }
    flaggedClaims: Array<{ claim: string; tier: 'LOW' | 'UNVERIFIED' }>
    fragilityAssumption?: string
    frontierQuestion?: string    // H5: open research question surfaced by the pipeline
  }
  criticProblems?: string[]   // I5: adversarial critic findings — process trail only, never touches synthesis
  genealogy?: Record<string, number>  // contribution rate per model in final synthesis (0–1)
  masterpiece?: {              // Track P — MASTERPIECE metadata (display only, not synthesis)
    active: boolean
    shardCount?: number
    shardsCompleted?: number   // P12 — live progress counter during deep mode
    shardsTotal?: number       // P12 — total shards to process
    connectionsFound?: number
    connectionsSurvived?: number
    resonancesFound?: number
    escalatedCount?: number
    elapsedMs?: number
    domains?: string[]
    patterns?: string[]
    shards?: Array<{ id: string; domain: string; preview: string }>
    tiers?: Array<{ shardId: string; tier: string; score: number }>
    specialists?: Array<{ shardId: string; specialist: string; confidence: number }>
  }
  // Track P — light-mode cross-domain connection (only surfaced when novelty > 0.6)
  crossDomainConnection?: string
  // Track U — ANIMA transparency entries (only set on a "what have you learned" query)
  animaTruths?: Array<{ observation: string; domain: string; confidencePct: number; confirmingInstances: number; fragility: string }>
  // Confidence-gated response commitment (low-confidence factual/reasoning answers)
  uncertainCommitment?: { overallScore: number; resolvingStep: string }
  // Council debate (cont.58c) — co-equal local models propose blind, cross-examine each
  // other, and a deterministic verdict picks the answer. Set from the 'local_debate' SSE
  // event; absent when the answer came from a single model or a non-ensemble path.
  localDebate?: LocalDebateSummary
  /** Web sources being consulted in real time during a grounded answer (favicon strip). */
  liveSources?: LiveSource[]
  /** Latest streamed 'thought' — what the brain is doing right now (searching, grounding, …).
   *  Drives the live status line in the working bubble so it doesn't feel static. */
  liveStatus?: string
}

export interface LiveSource {
  /** Hostname shown as the label, e.g. "en.wikipedia.org". */
  host: string
  /** Full URL (for the favicon lookup + click-through). */
  url: string
  /** 'reading' while fetching; 'grounded' once the answer cites it. Drives the check/spinner. */
  phase: 'reading' | 'grounded'
}

export interface LocalDebateEntry {
  modelId: string
  modelLabel: string
  text: string
  latencyMs: number
  errored: boolean
  changedPosition?: boolean
}

export interface LocalDebateSummary {
  agreement: 'unanimous' | 'majority' | 'contested' | 'solo'
  method: 'single-model' | 'oracle-arithmetic' | 'consensus-vote' | 'plurality-fallback'
  confidence: number
  winnerId: string
  winnerLabel: string
  contributors: string[]
  mindsChanged: boolean
  totalLatencyMs: number
  rounds: Array<{ kind: 'propose' | 'rebut'; entries: LocalDebateEntry[] }>
}

// ── Agent state (Section 7) — one reducer over the agent SSE event stream ─────
export interface AgentStep { id: number; intent: string; status: string; doneCheck?: string }
export interface AgentTool { id: string; tool: string; args?: any; ok?: boolean; output?: string; truncated?: boolean; done: boolean }
export interface AgentDiff { ts: number; path: string; old?: string; new?: string; patch?: string }
export interface AgentVerify { ts: number; passed: boolean; signal: string; report: string; escalate?: boolean }
export interface AgentState {
  active: boolean
  driver?: string
  projectPath?: string
  steps: AgentStep[]
  replanned?: boolean
  tools: AgentTool[]
  diffs: AgentDiff[]
  terminal: string[]
  verifies: AgentVerify[]
  thoughts: string[]
  final?: string
  done?: { ok: boolean; stopped: string; iters?: number; toolCallCount?: number; ms?: number }
  error?: string
  /** HITL_PLANNING_TRACK.md §3 — MC-first clarification, always paired with a recommended
   *  default. `options` is undefined for the free-text-only ask_user path (registry.ts /
   *  loop.ts:386); present (2-4 entries incl. "Something else / not sure") only for the
   *  ambiguity-gate path (loop.ts:245) that has real enumerable candidates. Cleared once the
   *  user replies so the card doesn't linger after the conversation moves on. */
  clarification?: { question: string; options?: string[]; recommended?: string; answered?: boolean }
}

export const AGENT_EVENT_TYPES = new Set([
  'agent_start', 'plan', 'step_status', 'tool_call', 'tool_result', 'tool_created',
  'diff', 'verify', 'thought', 'agent_done', 'plan_done', 'agent_error', 'final',
  'task_redirected', 'clarification_request',
])

export function emptyAgentState(): AgentState {
  return { active: true, steps: [], tools: [], diffs: [], terminal: [], verifies: [], thoughts: [] }
}

/** Pure fold of one agent SSE event into AgentState. */
export function agentReducer(state: AgentState | null | undefined, ev: any): AgentState {
  const s = state ? { ...state } : emptyAgentState()
  switch (ev.type) {
    case 'agent_start':
      return { ...s, active: true, driver: ev.driver, projectPath: ev.projectPath }
    case 'plan':
      return { ...s, steps: ev.steps ?? s.steps, replanned: ev.replanned ?? s.replanned }
    case 'step_status': {
      const steps = s.steps.map(st => st.id === ev.id ? { ...st, status: ev.status } : st)
      if (!steps.some(st => st.id === ev.id) && ev.intent) steps.push({ id: ev.id, intent: ev.intent, status: ev.status })
      return { ...s, steps }
    }
    case 'tool_call':
      return { ...s, tools: [...s.tools, { id: ev.id, tool: ev.tool, args: ev.args, done: false }] }
    case 'tool_result': {
      const tools = s.tools.map(t => t.id === ev.id && !t.done ? { ...t, ok: ev.ok, output: ev.output, truncated: ev.truncated, done: true } : t)
      // Surface run output in a terminal pane.
      const terminal = ev.tool === 'run' && ev.output ? [...s.terminal, ev.output] : s.terminal
      return { ...s, tools, terminal }
    }
    case 'tool_created':
      return { ...s, tools: [...s.tools, { id: `created_${ev.name}`, tool: 'create_tool', args: { name: ev.name }, ok: true, output: `Created tool: ${ev.name} — ${ev.description}`, done: true }] }
    case 'diff':
      return { ...s, diffs: [...s.diffs, { ts: Date.now(), path: ev.path, old: ev.old, new: ev.new, patch: ev.patch }] }
    case 'verify':
      return { ...s, verifies: [...s.verifies, { ts: Date.now(), passed: ev.passed, signal: ev.signal, report: ev.report, escalate: ev.escalate }] }
    case 'thought':
      return ev.text?.trim() ? { ...s, thoughts: [...s.thoughts, ev.text] } : s
    case 'agent_error':
      return { ...s, error: ev.error, active: false }
    case 'agent_done':
      return { ...s, done: { ok: ev.ok, stopped: ev.stopped, iters: ev.iters, toolCallCount: ev.toolCallCount, ms: ev.ms } }
    case 'plan_done':
      return { ...s, active: false }
    case 'final':
      return { ...s, final: ev.text, active: false }
    case 'task_redirected':
      // Mid-session redirect — surface it as a thought so the caption bar shows the pivot
      return { ...s, thoughts: [...s.thoughts, `Redirecting: ${ev.to ?? ''}`.slice(0, 80)] }
    case 'clarification_request':
      return { ...s, clarification: { question: ev.question, options: ev.options, recommended: ev.recommended } }
    default:
      return s
  }
}

export function emptyRound(id: string, userMessage: string, convId?: string, attachments?: string[]): Round {
  return {
    id, convId, userMessage, attachments,
    models: [], synthesisModelId: '', promptType: '', complexity: 'complex', cached: false,
    responses: {}, done: {}, scores: {},
    expandedModel: null,
    critiques: {},
    stage3Started: false, stage3Done: false, expandedCritique: null,
    revisions: {}, revisionsDone: {},
    stage4Started: false, stage4Done: false,
    synthesis: '', synthStreaming: false, synthesisDone: false,
    verifyStatus: 'idle' as const, verifyMessage: '',
    remediated: {}, linterStatus: {},
    avgScores: {}, stage2Done: false,
    activityFeed: [],
    agent: null,
  }
}

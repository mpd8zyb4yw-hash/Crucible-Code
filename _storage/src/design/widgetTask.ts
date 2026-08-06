// ── Widget-local agent tasks ───────────────────────────────────────────────────
// A widget action must DO the thing, in the widget, and show the result there.
//
// What this replaces (2026-08-04, user direction): every widget "ask" used to call
// `followUpInChat`, which navigated to the Chat tab and pasted a scripted prompt into
// the composer for the user to press Enter on. That is wrong twice over — it teleports
// you away from the thing you were looking at, and it exposes the prompt engineering as
// if it were your message. A draft button should draft.
//
// The prompt is an IMPLEMENTATION DETAIL and is never shown. What the user sees is the
// action ("Draft reply") and, optionally, an intent ("warmer", "shorter", or their own
// words) — which is a real instruction, not a template they have to edit.
//
// This deliberately does NOT create a round in the chat transcript. The work is scoped
// to the card that started it, which is the whole point. Anything the user wants to
// carry into a real conversation goes through `onOpenInChat`, explicitly.

import { API_BASE, apiFetch } from '../api'

export type TaskPhase = 'idle' | 'working' | 'done' | 'error'

export interface TaskState {
  phase: TaskPhase
  /** Plain-words progress — never a bare spinner (DESIGN_HANDOFF §6.3). */
  step: string
  /** The answer, streamed. */
  text: string
  error: string | null
}

export const IDLE_TASK: TaskState = { phase: 'idle', step: '', text: '', error: null }

/** Tone presets offered next to a draft action. Free text is always allowed too. */
export const TONE_PRESETS = [
  { id: 'warm', label: 'Warmer', instruction: 'Make it warm and personable without being effusive.' },
  { id: 'brief', label: 'Shorter', instruction: 'Make it significantly shorter — no filler, no preamble.' },
  { id: 'formal', label: 'More formal', instruction: 'Make it more formal and professional.' },
  { id: 'direct', label: 'More direct', instruction: 'Be direct and unhedged. State the point first.' },
] as const

export interface RunOptions {
  /** The task, in prompt form. NEVER surfaced to the user. */
  prompt: string
  /** Extra user intent — a tone preset's instruction, or the user's own words. */
  instruction?: string
  /** Use the tool-running agent loop rather than a plain answer. */
  agent?: boolean
  signal?: AbortSignal
  onUpdate: (patch: Partial<TaskState>) => void
}

/**
 * Run one scoped task and stream it into a widget.
 *
 * Reads the same SSE contract App's `send()` does (`data: {json}` lines, `[DONE]`
 * terminator), but only cares about three things: what it's doing right now, the
 * synthesized text, and the agent's `final`. Everything else on that stream belongs to
 * the transcript UI, not to a card.
 */
export async function runWidgetTask({ prompt, instruction, agent, signal, onUpdate }: RunOptions): Promise<void> {
  const message = instruction ? `${prompt}\n\nAdditional instruction: ${instruction}` : prompt
  onUpdate({ phase: 'working', step: 'Starting', text: '', error: null })

  let res: Response
  try {
    res = await apiFetch(`${API_BASE}/api/chat`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, mode: agent ? 'agent' : 'code', history: [], device: 'desktop' }),
      signal,
    })
  } catch (e) {
    onUpdate({ phase: 'error', error: e instanceof Error ? e.message : 'Could not reach Crucible' })
    return
  }
  if (!res.ok || !res.body) {
    onUpdate({ phase: 'error', error: `Request failed (${res.status})` })
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // Keep the last partial line for the next chunk.
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6)
        if (raw === '[DONE]') { onUpdate({ phase: 'done', step: '' }); return }
        let ev: Record<string, unknown>
        try { ev = JSON.parse(raw) } catch { continue }

        // Plain-words progress. The card says what it is doing, never just spins.
        if (typeof ev.step === 'string' && ev.step) onUpdate({ step: ev.step })
        else if (ev.type === 'tool_start' && typeof ev.tool === 'string') onUpdate({ step: `Using ${ev.tool}` })
        else if (ev.type === 'connected') onUpdate({ step: 'Thinking' })

        if (ev.type === 'synthesis') {
          // `replace` means a polish pass rewrote the draft wholesale.
          if (ev.replace && typeof ev.text === 'string') text = ev.text
          else if (typeof ev.text === 'string') text += ev.text
          onUpdate({ text })
        } else if (ev.type === 'final' && typeof ev.text === 'string') {
          text = ev.text
          onUpdate({ text, phase: 'done', step: '' })
        } else if (ev.type === 'error' && typeof ev.message === 'string') {
          onUpdate({ phase: 'error', error: ev.message })
          return
        }
      }
    }
    onUpdate({ phase: text ? 'done' : 'error', step: '', error: text ? null : 'No answer came back' })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') { onUpdate({ phase: 'idle', step: '', text: '' }); return }
    onUpdate({ phase: 'error', error: e instanceof Error ? e.message : 'Stream failed' })
  }
}

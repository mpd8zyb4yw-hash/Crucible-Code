import type { ModelChip } from '../CrucibleEngine/types'

export type Tab = 'chat' | 'agents' | 'history' | 'settings'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  ts: number
  ensemble?: boolean
  models?: ModelChip[]
}

export type SessionMode = 'local' | 'ensemble' | 'agent'

export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  mode: SessionMode
  pinned: boolean
  messages: ChatMessage[]
}

export type LivePhase = 'thinking' | 'pouring' | 'finishing' | 'cooling'

export interface LiveState {
  text: string
  phase: LivePhase
  ensemble: boolean
  startedAt: number
  /** Known length of the full reply, set once the first token arrives. Drives
   *  the pour animation's fill fraction — real progress, not a guessed timer. */
  totalChars: number
}

export interface ApiKeyRecord {
  id: string
  name: string
  value: string
  masked: string
  createdAt: number
}

export type ConfirmState = { type: 'ask' | 'nokeys'; pendingText: string } | null

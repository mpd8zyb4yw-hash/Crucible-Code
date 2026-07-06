import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { makeId } from '../lib/id'
import { maskValue } from '../lib/mask'
import { streamLocal } from '../CrucibleEngine/localModel'
import { runEnsemble } from '../CrucibleEngine/ensemble'
import type { StreamHandle } from '../CrucibleEngine/types'
import type { ApiKeyRecord, ChatSession, ConfirmState, LivePhase, LiveState, Tab } from './types'

// re-exported here to keep the union in one place alongside the store that owns it
export type { ConfirmState } from './types'

const CHIP_PALETTE = [
  { c: '#7c7cf8', rgb: '124,124,248' },
  { c: '#4db89e', rgb: '77,184,158' },
  { c: '#c084fc', rgb: '192,132,252' },
  { c: '#f59e0b', rgb: '245,158,11' },
]

interface CrucibleState {
  tab: Tab
  sessions: ChatSession[]
  currentSessionId: string | null
  keys: ApiKeyRecord[]
  ensembleArmed: boolean
  confirm: ConfirmState
  live: LiveState | null
  streamSpeed: number
  minFillMs: number

  setTab: (tab: Tab) => void
  newChat: () => void
  loadSession: (id: string) => void
  togglePinned: (id: string) => void
  removeSession: (id: string) => void

  toggleEnsemble: () => void
  send: (text: string) => void
  runAgent: (agentName: string, prompt: string) => void
  confirmEnsemble: () => void
  declineEnsemble: () => void
  setLivePhase: (phase: LivePhase) => void
  finalizeLive: () => void

  addKey: (name: string, value: string) => void
  removeKey: (id: string) => void

  currentSession: () => ChatSession | null
}

let activeHandle: StreamHandle | null = null

function currentSpeed(get: () => CrucibleState) {
  return get().streamSpeed
}

export const useCrucibleStore = create<CrucibleState>()(
  persist(
    (set, get) => ({
      tab: 'chat',
      sessions: [],
      currentSessionId: null,
      keys: [],
      ensembleArmed: false,
      confirm: null,
      live: null,
      streamSpeed: 1,
      minFillMs: 1350,

      setTab: (tab) => set({ tab }),

      newChat: () => {
        activeHandle?.cancel()
        activeHandle = null
        set({ currentSessionId: null, live: null, confirm: null })
      },

      loadSession: (id) => {
        activeHandle?.cancel()
        activeHandle = null
        set({ currentSessionId: id, live: null, confirm: null, tab: 'chat' })
      },

      togglePinned: (id) =>
        set((s) => ({
          sessions: s.sessions.map((sess) => (sess.id === id ? { ...sess, pinned: !sess.pinned } : sess)),
        })),

      removeSession: (id) =>
        set((s) => ({
          sessions: s.sessions.filter((sess) => sess.id !== id),
          currentSessionId: s.currentSessionId === id ? null : s.currentSessionId,
        })),

      toggleEnsemble: () => set((s) => ({ ensembleArmed: !s.ensembleArmed, confirm: null })),

      send: (rawText) => {
        const text = rawText.trim()
        const s = get()
        if (!text || s.live) return
        if (s.ensembleArmed) {
          set({ confirm: { type: s.keys.length === 0 ? 'nokeys' : 'ask', pendingText: text } })
          return
        }
        runSend(set, get, text, false)
      },

      runAgent: (agentName, prompt) => {
        if (get().live) return
        set({ tab: 'chat', currentSessionId: null })
        runSend(set, get, `[Agent: ${agentName}] ${prompt}`, false, 'agent')
      },

      confirmEnsemble: () => {
        const text = get().confirm?.pendingText
        set({ confirm: null })
        if (text) runSend(set, get, text, true)
      },

      declineEnsemble: () => {
        const text = get().confirm?.pendingText
        set({ confirm: null })
        if (text) runSend(set, get, text, false)
      },

      setLivePhase: (phase) => set((s) => (s.live ? { live: { ...s.live, phase } } : {})),

      finalizeLive: () => {
        const s = get()
        const live = s.live
        if (!live) return
        const sessionId = s.currentSessionId
        if (!sessionId) return
        const models = live.ensemble
          ? s.keys.slice(0, 4).map((k, idx) => {
              const p = CHIP_PALETTE[idx % CHIP_PALETTE.length]
              return {
                label: k.name,
                color: p.c,
                chipBg: `rgba(${p.rgb},0.08)`,
                chipBorder: `rgba(${p.rgb},0.22)`,
                role: idx === 0 ? 'led synthesis' : 'contributed',
              }
            })
          : undefined
        set((st) => ({
          live: null,
          sessions: st.sessions.map((sess) =>
            sess.id === sessionId
              ? {
                  ...sess,
                  updatedAt: Date.now(),
                  messages: [
                    ...sess.messages,
                    {
                      id: makeId(),
                      role: 'assistant',
                      text: live.text,
                      ts: Date.now(),
                      ensemble: live.ensemble,
                      models,
                    },
                  ],
                }
              : sess,
          ),
        }))
      },

      addKey: (name, value) => {
        const n = name.trim()
        const v = value.trim()
        if (!n || !v) return
        const rec: ApiKeyRecord = { id: makeId(), name: n, value: v, masked: maskValue(v), createdAt: Date.now() }
        set((s) => ({ keys: [...s.keys, rec] }))
      },
      removeKey: (id) => set((s) => ({ keys: s.keys.filter((k) => k.id !== id) })),

      currentSession: () => {
        const s = get()
        return s.sessions.find((sess) => sess.id === s.currentSessionId) ?? null
      },
    }),
    {
      name: 'crucible.v1',
      partialize: (s) => ({ sessions: s.sessions, keys: s.keys, ensembleArmed: s.ensembleArmed }),
    },
  ),
)

function runSend(
  set: (partial: Partial<CrucibleState> | ((s: CrucibleState) => Partial<CrucibleState>)) => void,
  get: () => CrucibleState,
  text: string,
  ensemble: boolean,
  modeOverride?: ChatSession['mode'],
) {
  activeHandle?.cancel()

  let sessionId = get().currentSessionId
  const now = Date.now()
  if (!sessionId) {
    sessionId = makeId()
    const session: ChatSession = {
      id: sessionId,
      title: text.slice(0, 60),
      createdAt: now,
      updatedAt: now,
      mode: modeOverride ?? (ensemble ? 'ensemble' : 'local'),
      pinned: false,
      messages: [],
    }
    set((s) => ({ sessions: [...s.sessions, session], currentSessionId: sessionId }))
  }

  set((s) => ({
    sessions: s.sessions.map((sess) =>
      sess.id === sessionId
        ? { ...sess, updatedAt: now, messages: [...sess.messages, { id: makeId(), role: 'user', text, ts: now }] }
        : sess,
    ),
    live: { text: '', phase: 'thinking', ensemble, startedAt: now, totalChars: 0 },
  }))

  const speed = currentSpeed(get)
  const handlers = {
    onFirstToken: (totalChars: number) =>
      set((s) => (s.live ? { live: { ...s.live, phase: 'pouring' as const, totalChars } } : {})),
    onChunk: (_chunk: string, acc: string) => set((s) => (s.live ? { live: { ...s.live, text: acc } } : {})),
    onDone: () => get().setLivePhase('finishing'),
    onError: (err: Error) => {
      console.error('[crucible] stream error', err)
      get().setLivePhase('finishing')
    },
  }

  activeHandle = ensemble ? runEnsemble(get().keys, text, handlers, speed) : streamLocal(text, handlers, speed)
}

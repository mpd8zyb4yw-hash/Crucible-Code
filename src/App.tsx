import { useState, useRef, useEffect, useCallback } from 'react'
import { API_BASE, apiFetch } from './api'
import BackgroundBlobs from './BackgroundBlobs'
import { useEnsemble, type EnsembleState } from './ensemble'
import { IntegrationsBinder } from './IntegrationsBinder'
import { LibraryBinder } from './LibraryBinder'
import { SelfRepairBinder } from './SelfRepairBinder'
import { SelfPatcherBinder } from './SelfPatcherBinder'
import NavRail from './NavRail'
import AgentsTabView from './AgentsTabView'
import HistoryTabView from './HistoryTabView'
import SettingsTabView from './SettingsTabView'
import './modelData'

// ── Componentized chat modules (ground-up restructure, 2026-07-07) ─────────────
import {
  assignColors, emptyRound, agentReducer, AGENT_EVENT_TYPES, copyText, haptic,
  type Round, type Critique,
} from './chat/core'
import { ShimmerBg, urlBase64ToUint8Array, applyFixedCode } from './chat/panels'
import { TasksBinder, HistoryBinder } from './chat/binders'
import { AuthScreen } from './chat/AuthScreen'
import { MessageList } from './chat/MessageList'

export default function App() {
  const [rounds, setRounds]               = useState<Round[]>([])
  const [input, setInput]                 = useState('')
  const [thinking, setThinking]           = useState(false)
  // ── Agent live timer ──────────────────────────────────────────────────────
  const [agentStartTime, setAgentStartTime]   = useState<number | null>(null)
  const [agentElapsed, setAgentElapsed]       = useState(0)
  const [agentProgress, setAgentProgress]     = useState<{
    stepIndex: number; stepTotal: number; stepIntent: string
    iter: number; maxIters: number
  } | null>(null)
  // ── Resume banner ─────────────────────────────────────────────────────────
  const [resumeOffer, setResumeOffer] = useState<{
    goal: string; projectPath: string; stepIntent: string
    stepIndex: number; stepTotal: number; iter: number; maxIters: number
    savedAt: number
  } | null>(null)
  // Default to a local-capable mode ('code'), NOT the external ensemble ('quorum') — see the
  // BYOK/ensemble constraint. Fresh sessions run Crucible-local until the user opts into ensemble.
  const [mode, setMode] = useState<'quorum'|'code'|'seeker'|'research'>('code')
  // ── Ensemble opt-in + BYOK (bring-your-own-key) ───────────────────────────
  // The external multi-model pipeline is opt-in and runs only on the user's own API keys.
  const ensemble: EnsembleState = useEnsemble()
  // Holds a message pending the per-query "use ensemble?" confirmation (inline card above
  // the composer). noKeys renders the "add keys in Settings" variant instead of the ask.
  const [ensembleConfirm, setEnsembleConfirm] = useState<null | { message?: string; noKeys?: boolean }>(null)
  // The round currently streaming live in THIS session — the only round that gets the
  // molten pour overlay (a restored/historical round must never replay the animation).
  const [liveRoundId, setLiveRoundId] = useState<string | null>(null)
  // ── v3 left-rail tab shell — Chat is the existing full view; History/Settings are
  // dedicated full-page views (see NavRail.tsx / HistoryTabView.tsx / SettingsTabView.tsx).
  // The system drawers (Library/SelfRepair/etc.) live in Settings.
  const [tab, setTab] = useState<'chat' | 'history' | 'settings'>('chat')
  // Items 18/19: Agents & capabilities is an inline overlay anchored to the chat panel,
  // not a tab — toggling it never unmounts the conversation underneath (see AgentsTabView.tsx).
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [composerExpandOpen, setComposerExpandOpen] = useState(false)

  // ── Slash-command tool palette — typing "/" in the composer filters this list,
  // same pattern as Claude/OpenAI's "/" completion. Tool names are fetched once;
  // this is the SAME data AgentsTabView shows, just reachable without opening the drawer.
  const [slashTools, setSlashTools] = useState<{ name: string; description: string }[]>([])
  useEffect(() => {
    apiFetch(`${API_BASE}/api/library/tools`, { credentials: 'include' }).then(r => r.json())
      .then(t => setSlashTools([...(t.dynamic ?? []), ...(t.builtin ?? [])]))
      .catch(() => {})
  }, [])
  const slashMatch = /^\/(\S*)$/.exec(input)
  const slashResults = slashMatch
    ? slashTools.filter(t => t.name.toLowerCase().startsWith(slashMatch[1].toLowerCase())).slice(0, 8)
    : []

  // ── Step 9: Remote Brain mode (phone only) ────────────────────────────────
  const [remoteBrain, setRemoteBrain] = useState(false)
  const [streamStatus, setStreamStatus] = useState<'connecting'|'live'|'error'>('connecting')
  const [streamFps, setStreamFps] = useState(0)
  // Fully-local app origin (http://<mac-lan-ip>:3001) reported by the status endpoint.
  // Offered as a one-tap escape hatch when the stream can't reach the Mac through the
  // tunnel — loading the app from this origin makes everything direct-to-Mac.
  const [remoteLanOrigin, setRemoteLanOrigin] = useState<string | null>(null)
  const screenCanvasRef = useRef<HTMLCanvasElement>(null)
  const streamEsRef = useRef<EventSource | null>(null)
  const preBrainModeRef = useRef<'quorum'|'code'|'seeker'|'research'>('code')
  const fpsCounterRef = useRef({ count: 0, last: 0 })
  const [pipPos, setPipPos] = useState<{x:number,y:number}>({ x: 12, y: 60 })
  const pipPosRef = useRef<{x:number,y:number}>({ x: 12, y: 60 })
  const pipDragRef = useRef<{startX:number,startY:number,startPipX:number,startPipY:number}|null>(null)
  const pipDivRef = useRef<HTMLDivElement>(null)
  const visualVpOffsetTopRef = useRef(0)

  // visualViewport — tracks height AND offsetTop so we can compute the exact keyboard
  // height on iOS. When the keyboard opens, Safari fires both 'resize' (height shrinks)
  // AND 'scroll' (offsetTop shifts). Missing 'scroll' makes the offset calculation wrong.
  // Correct keyboard height = window.innerHeight - vv.offsetTop - vv.height.
  const [visualVpHeight, setVisualVpHeight] = useState<number>(
    typeof window !== 'undefined' && window.visualViewport
      ? window.visualViewport.height
      : (typeof window !== 'undefined' ? window.innerHeight : 812)
  )
  const [visualVpOffsetTop, setVisualVpOffsetTop] = useState<number>(
    typeof window !== 'undefined' && window.visualViewport
      ? window.visualViewport.offsetTop
      : 0
  )
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => {
      setVisualVpHeight(vv.height)
      setVisualVpOffsetTop(vv.offsetTop)
      visualVpOffsetTopRef.current = vv.offsetTop
      // Clamp PiP so it never gets pushed off screen when keyboard opens
      const pipH = 200
      const maxY = vv.height - pipH - 12
      const pipW = window.innerWidth * 0.88
      const maxX = vv.width - pipW - 8
      setPipPos(pos => {
        const clampedY = Math.min(pos.y, Math.max(8, maxY))
        const clampedX = Math.min(Math.max(8, pos.x), Math.max(8, maxX))
        const next = { x: clampedX, y: clampedY }
        pipPosRef.current = next
        return next
      })
    }
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])

  // isMobile: true only on real touch devices (phones/tablets).
  // Width alone is unreliable — a resized desktop window can be 400px wide.
  // We combine touch support + coarse pointer (finger, not mouse) so a narrow
  // desktop window never triggers Remote Brain mode.
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' &&
    window.matchMedia('(pointer: coarse)').matches &&
    ('ontouchstart' in window || navigator.maxTouchPoints > 0)
  )
  const [isLandscape, setIsLandscape] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(orientation: landscape)').matches
  )
  useEffect(() => {
    const mqW = window.matchMedia('(pointer: coarse)')
    const mqL = window.matchMedia('(orientation: landscape)')
    const hW = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    const hL = (e: MediaQueryListEvent) => setIsLandscape(e.matches)
    mqW.addEventListener('change', hW)
    mqL.addEventListener('change', hL)
    return () => { mqW.removeEventListener('change', hW); mqL.removeEventListener('change', hL) }
  }, [])

  // Auto-switch to agent mode when Remote Brain opens so the main input bar sends
  // commands straight to the Mac agent loop. Restore previous mode on close.
  useEffect(() => {
    if (remoteBrain) {
      preBrainModeRef.current = mode
      setMode(preBrainModeRef.current)
    } else {
      setMode(preBrainModeRef.current)
    }
  }, [remoteBrain])

  // WebSocket screen stream — binary JPEG frames, no base64 overhead.
  // binaryType='blob' lets createImageBitmap consume e.data directly (GPU decode).
  // WebSocket bypasses the SSE buffering that caused ~30s lag through ngrok/tunnels.
  useEffect(() => {
    if (!remoteBrain) {
      streamEsRef.current?.close()
      streamEsRef.current = null
      return
    }
    setStreamStatus('connecting')
    setStreamFps(0)
    setRemoteLanOrigin(null)
    fpsCounterRef.current = { count: 0, last: performance.now() }

    // Build WebSocket URL from API_BASE (http→ws, https→wss).
    const wsBase = API_BASE.replace(/^http/, 'ws')
    let ws = new WebSocket(`${wsBase}/api/screen-stream-ws?t=${Date.now()}`)
    ws.binaryType = 'blob'
    streamEsRef.current = ws as unknown as EventSource

    // Ask the Mac where it actually is on the LAN. The screen-stream WS and the Mac's
    // screen only exist on the Mac — never on the Fly origin the tunnel can resolve to —
    // so connecting straight to the Mac's LAN IP is the only reliable path on the same
    // network. We also stash lanOrigin so the UI can offer a fully-local fallback link.
    const pageIsHttp = window.location.protocol === 'http:'
    apiFetch(`${API_BASE}/api/remote-brain/status`)
      .then(r => r.json())
      .then((s: { screenStream?: string | null; lanOrigin?: string | null }) => {
        if (s.lanOrigin && !s.lanOrigin.includes(window.location.hostname)) setRemoteLanOrigin(s.lanOrigin)
        if (!streamEsRef.current) return
        const lanUrl = s.screenStream
        // Only switch to a different host when it actually points elsewhere. A ws:// LAN
        // URL is mixed-content-blocked from an https page, so only auto-switch from http.
        if (lanUrl && !lanUrl.includes(window.location.hostname) && (pageIsHttp || lanUrl.startsWith('wss://'))) {
          ws.close()
          ws = new WebSocket(`${lanUrl}?t=${Date.now()}`)
          ws.binaryType = 'blob'
          streamEsRef.current = ws as unknown as EventSource
          attachHandlers(ws)
        }
      }).catch(() => {})

    // Watchdog: if no frame has arrived a few seconds in, the tunnel path is dead
    // (likely resolved to the screenless Fly origin). Surface the error state so the
    // "open on local network" fallback shows. A live frame clears this via onmessage.
    const watchdog = setTimeout(() => {
      if (streamEsRef.current === (ws as unknown as EventSource) && ws.readyState !== 1) {
        setStreamStatus('error')
      }
    }, 6000)

    let pendingBitmap: ImageBitmap | null = null
    let rafId = 0

    const paintLoop = () => {
      if (pendingBitmap) {
        const canvas = screenCanvasRef.current
        if (canvas) {
          if (canvas.width !== pendingBitmap.width) canvas.width = pendingBitmap.width
          if (canvas.height !== pendingBitmap.height) canvas.height = pendingBitmap.height
          canvas.getContext('2d')?.drawImage(pendingBitmap, 0, 0)
          pendingBitmap.close()
          pendingBitmap = null
          const fr = fpsCounterRef.current
          fr.count++
          const now = performance.now()
          if (now - fr.last >= 1000) {
            setStreamFps(Math.round(fr.count * 1000 / (now - fr.last)))
            fr.count = 0
            fr.last = now
          }
        }
      }
      rafId = requestAnimationFrame(paintLoop)
    }
    rafId = requestAnimationFrame(paintLoop)

    let frameSeq = 0
    function attachHandlers(sock: WebSocket) {
      sock.onopen  = () => setStreamStatus('live')
      sock.onclose = () => { if (streamEsRef.current === (sock as unknown as EventSource)) setStreamStatus('error') }
      sock.onmessage = (e) => {
        setStreamStatus('live')
        const seq = ++frameSeq
        // e.data is already a Blob (binaryType='blob') — pass directly to GPU decoder.
        createImageBitmap(e.data as Blob).then(bmp => {
          if (seq < frameSeq) { bmp.close(); return } // drop stale frame
          pendingBitmap?.close()
          pendingBitmap = bmp
        }).catch(() => {})
      }
    }
    attachHandlers(ws)

    return () => {
      clearTimeout(watchdog)
      ws.close()
      streamEsRef.current = null
      cancelAnimationFrame(rafId)
      pendingBitmap?.close()
    }
  }, [remoteBrain])

  // ── Auth state ────────────────────────────────────────────────────────────
  const [authUser, setAuthUser] = useState<{ id: string; email: string } | null | 'loading'>('loading')

  // ── Cross-device session ID (Task 3) ──────────────────────────────────────
  const [sessionId] = useState<string>(() => {
    // localStorage (NOT sessionStorage) — sessionStorage is wiped on tab close, which
    // breaks reconnect/cross-device continuity every time the browser is reopened.
    let sid = localStorage.getItem('crucible_sid')
                ?? sessionStorage.getItem('crucible_sid')  // migrate any legacy value
    if (!sid) sid = Math.random().toString(36).slice(2, 10)
    localStorage.setItem('crucible_sid', sid)
    return sid
  })

  // conversationId — the grouped chat thread. FRESH on every page load (not persisted),
  // so a refresh always starts a NEW conversation; the previous one is archived to the
  // searchable conversation store and reopenable from the history drawer. Reopening a
  // past conversation adopts its id so new messages append to that thread.
  const [conversationId, setConversationId] = useState<string>(
    () => 'conv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  )
  const conversationIdRef = useRef(conversationId)
  useEffect(() => { conversationIdRef.current = conversationId }, [conversationId])

  // ── Reconnect state (Task 5) ──────────────────────────────────────────────
  const [reconnecting, setReconnecting] = useState(false)

  const wasThinkingRef = useRef(false)
  const passiveEsRef = useRef<EventSource | null>(null)

  // Ensemble (the external multi-model pipeline) is OPT-IN and is never auto-selected —
  // per the BYOK/ensemble product constraint, Crucible-local is the default path and the
  // external fan-out must be a deliberate user choice. The composer no longer auto-classifies
  // a mode from keystrokes (v3: mode routing UI removed) — 'code' is the sole local default;
  // 'quorum' is entered only via the Ensemble pill + confirm flow, 'research'/'agent' only via
  // their own explicit entry points.
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [showMinLengthTip, setShowMinLengthTip] = useState(false)
  const minLengthTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // N1 — governance panel
  const [govPanelOpen, setGovPanelOpen] = useState(false)
  const [govRequests, setGovRequests] = useState<any[]>([])
  const [govPending, setGovPending] = useState(0)

  const bottomRef  = useRef<HTMLDivElement>(null)
  const scrollRef  = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Ref holds the lock synchronously — never stale inside effects or rAF callbacks.
  // State is only for showing/hiding the scroll-to-bottom button (UI only).
  const scrollLockedRef = useRef(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const synthesisRef = useRef<Record<string, string>>({})
  const abortRef = useRef<AbortController | null>(null)
  const prewarmTokenRef = useRef<string | null>(null)
  const prewarmDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputBarRef = useRef<HTMLDivElement>(null)
  const [inputBarHeight, setInputBarHeight] = useState(100)

  // N1 — poll governance pending count
  useEffect(() => {
    const poll = () => apiFetch(`${API_BASE}/api/governance/pending`).then(r => r.json()).then((d: any[]) => setGovPending(d.length)).catch(() => {})
    poll()
    const t = setInterval(poll, 15000)
    return () => clearInterval(t)
  }, [])

  // Track input bar height so spacer + fade stay in sync
  useEffect(() => {
    const el = inputBarRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setInputBarHeight(el.offsetHeight))
    ro.observe(el)
    setInputBarHeight(el.offsetHeight)
    return () => ro.disconnect()
  }, [])

  const touchStartYRef = useRef(0)

  // Engage the lock the instant the user shows upward intent — a small wheel tick or
  // a short finger drag is enough. The old code only locked once you were >80px from
  // the bottom, so auto-scroll kept yanking you back during streaming and you had to
  // make one big decisive up-scroll to break free. Now any upward nudge frees it.
  const lockAutoScroll = () => {
    if (scrollLockedRef.current) return
    scrollLockedRef.current = true
    setShowScrollBtn(true)
  }

  // Item 5: these are handed down to the memoized MessageList component as props, so they
  // must be stable references (useCallback with no external deps — everything they read
  // comes from refs) or the memoization below would be defeated every render.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    // Only RE-ENGAGE auto-follow here, when the user scrolls back to the bottom.
    // Disengaging is driven by explicit upward intent (wheel/touch) so a tiny scroll
    // up isn't immediately overridden by the next streamed chunk.
    if (dist <= 80 && scrollLockedRef.current) {
      scrollLockedRef.current = false
      setShowScrollBtn(false)
    }
  }, [])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.deltaY < 0) lockAutoScroll()
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartYRef.current = e.touches[0]?.clientY ?? 0
  }, [])
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    // Finger moving DOWN the screen scrolls content UP → user wants to read back.
    if ((e.touches[0]?.clientY ?? 0) - touchStartYRef.current > 6) lockAutoScroll()
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const scrollToBottom = () => {
    const el = scrollRef.current
    if (!el) return
    scrollLockedRef.current = false
    setShowScrollBtn(false)
    el.scrollTop = el.scrollHeight
  }

  // Reading-anchored auto-follow: while the latest exchange (user bubble + answer)
  // still fits in the viewport we pin to the bottom as tokens stream in — but the
  // moment it outgrows the viewport we freeze with the TOP of that exchange in view,
  // so a large answer is read from its beginning instead of snapping the user to the
  // bottom of a wall of text. The scroll-to-bottom button still jumps all the way.
  const pinToLatest = useCallback(() => {
    const el = scrollRef.current
    if (!el || scrollLockedRef.current) return
    const kids = el.children
    // Last child is the bottom spacer; the latest round wrapper sits before it.
    const last = kids.length >= 2 ? kids[kids.length - 2] as HTMLElement : null
    const maxScroll = el.scrollHeight - el.clientHeight
    if (!last) { el.scrollTop = maxScroll; return }
    const lastTop = last.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
    el.scrollTop = Math.min(maxScroll, Math.max(0, lastTop - 16))
  }, [])

  useEffect(() => {
    // Guard reads from the ref — always current, never stale.
    if (scrollLockedRef.current) return
    const el = scrollRef.current
    if (!el) return
    // Use rAF so the scroll happens after the browser has painted the new content,
    // preventing the layout-recalculation jitter caused by setting scrollTop
    // synchronously while React is still committing DOM mutations.
    requestAnimationFrame(() => pinToLatest())
  }, [rounds, inputBarHeight, pinToLatest])

  // Items 3+4: the effect above only re-pins on `rounds`/`inputBarHeight` changes, but the
  // streamed content's actual DOM height can keep changing AFTER that commit — most visibly
  // when a markdown code block finishes parsing/highlighting and reflows taller or shorter
  // than the plain-text placeholder that was there a frame earlier, or a nested code block's
  // syntax highlighter mounts asynchronously. That extra layout shift has no matching state
  // change to re-trigger the scroll effect above, so the view lags behind (or jumps ahead of)
  // the actual token stream. A ResizeObserver on every direct message-card child watches real
  // layout height directly, independent of React's commit timing, and re-pins to bottom on any
  // shift while still respecting the user's scroll lock. Re-observes when the round count
  // changes (new cards mounted); each card's own internal reflows are covered without needing
  // per-token re-subscription since ResizeObserver keeps firing on the same observed node.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => pinToLatest())
    Array.from(el.children).forEach(child => ro.observe(child))
    return () => ro.disconnect()
  }, [rounds.length, pinToLatest])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey) return
      if (e.key === 'x') {
        e.preventDefault()
        const last = rounds[rounds.length - 1]
        if (last) {
          const text = Object.values(last.responses).filter(Boolean).join('\n\n')
          copyText(text)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [rounds])


  // Dismiss mode fan on outside tap
  useEffect(() => {
    if (!modeMenuOpen) return
    const handler = () => setModeMenuOpen(false)
    window.addEventListener('pointerdown', handler)
    return () => window.removeEventListener('pointerdown', handler)
  }, [modeMenuOpen])

  // ── Live agent timer ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!agentStartTime) return
    const id = setInterval(() => setAgentElapsed(Date.now() - agentStartTime), 1000)
    return () => clearInterval(id)
  }, [agentStartTime])

  // ── Auth check on mount (Task 4) ──────────────────────────────────────────
  useEffect(() => {
    // On iOS, tab switching can evict the page and reload it. Check sessionStorage
    // for a cached auth user first so there's no blank flash while the network call
    // resolves. We still verify with the server in the background.
    try {
      const cached = sessionStorage.getItem('crucible_auth')
      if (cached) setAuthUser(JSON.parse(cached))
    } catch {}
    apiFetch(`${API_BASE}/api/auth/me`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(user => {
        setAuthUser(user)
        try {
          if (user) sessionStorage.setItem('crucible_auth', JSON.stringify(user))
          else sessionStorage.removeItem('crucible_auth')
        } catch {}
      })
      .catch(() => setAuthUser(null))
  }, [])

  // ── bfcache / iOS tab-eviction recovery ───────────────────────────────────
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        // Page restored from bfcache — no reload needed, just re-verify auth quietly
        apiFetch(`${API_BASE}/api/auth/me`, { credentials: 'include' })
          .then(r => r.ok ? r.json() : null)
          .then(user => {
            if (user) { setAuthUser(user); sessionStorage.setItem('crucible_auth', JSON.stringify(user)) }
            else { setAuthUser(null); sessionStorage.removeItem('crucible_auth') }
          })
          .catch(() => {})
      }
    }
    window.addEventListener('pageshow', onPageShow)
    return () => window.removeEventListener('pageshow', onPageShow)
  }, [])

  // ── Session restore on mount + poll until any in-flight answer lands ───────
  // Restores the saved thread, then — if the last round was still being generated
  // when we left — keeps polling. The server patches the active session the moment
  // the pipeline/agent finishes (even with no client connected), so a query we left
  // unanswered fills itself in instead of sitting dead.
  // Every page load starts a FRESH conversation (blank chat) — by design. The previous
  // conversation is archived to the searchable conversation store (saved continuously
  // below) and reopenable from the history drawer. We deliberately do NOT restore the
  // prior active session into the live view here; "refresh = new instance".
  // (Server-side completion still fills finished answers into the archived conversation
  //  via the roundId→conversationId registry, so nothing is lost mid-stream.)

  // ── Debounced session save helper (Task 2) ────────────────────────────────
  const sessionSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveSession = useCallback((currentRounds: typeof rounds, currentMode: typeof mode) => {
    if (sessionSaveTimer.current) clearTimeout(sessionSaveTimer.current)
    sessionSaveTimer.current = setTimeout(() => {
      // Legacy active-session blob (kept for back-compat; harmless).
      apiFetch(`${API_BASE}/api/session/save`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rounds: currentRounds, mode: currentMode }),
      }).catch(() => {})
      // Grouped conversation store — the source of truth for searchable history.
      apiFetch(`${API_BASE}/api/conversations/save`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: conversationIdRef.current, mode: currentMode, rounds: currentRounds }),
      }).catch(() => {})
    }, 1000)
  }, [])

  // ── Continuous active-session persistence ─────────────────────────────────
  // Save on EVERY meaningful change to the conversation (user msg, stage progress,
  // synthesis stream, completion) — not just synthesis tokens. Debounced inside
  // saveSession. This is what makes "close mid-response, come back" actually resume.
  useEffect(() => {
    if (!authUser || authUser === 'loading') return
    if (rounds.length === 0) return
    saveSession(rounds, mode)
  }, [rounds, mode, authUser, saveSession])

  // Synchronous best-effort flush when the tab is hidden/closed (mobile eviction,
  // backgrounding) so the final ~1s of streamed tokens survive the debounce window.
  useEffect(() => {
    const flush = () => {
      if (rounds.length === 0) return
      try {
        fetch(`${API_BASE}/api/session/save`, {
          method: 'POST', credentials: 'include', keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rounds, mode, timestamp: Date.now() }),
        }).catch(() => {})
        fetch(`${API_BASE}/api/conversations/save`, {
          method: 'POST', credentials: 'include', keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: conversationIdRef.current, mode, rounds }),
        }).catch(() => {})
      } catch {}
    }
    const onHidden = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [rounds, mode])

  // ── Passive SSE listener for cross-device broadcast (Task 3) ──────────────
  useEffect(() => {
    if (!authUser || authUser === 'loading') return
    const connectPassive = () => {
      const es = new EventSource(`${API_BASE}/api/session/stream?sessionId=${sessionId}`)
      passiveEsRef.current = es
      es.onmessage = (e) => {
        if (!e.data || e.data === '[DONE]') return
        try {
          const parsed = JSON.parse(e.data)
          if (parsed.type === 'connected') return
          // On another device driving the session, merge events into current rounds.
          // The sending device handles its own state via the fetch loop — this is
          // only for passive listeners. If this device is actively thinking, skip.
          if (!thinking && parsed.type === 'synthesis_token') {
            setRounds(prev => {
              const last = prev[prev.length - 1]
              if (!last) return prev
              return [...prev.slice(0, -1), { ...last, synthesis: (last.synthesis ?? '') + (parsed.token ?? '') }]
            })
          }
        } catch {}
      }
      return es
    }
    connectPassive()
    return () => { passiveEsRef.current?.close(); passiveEsRef.current = null }
  }, [authUser, sessionId])

  // ── Server-owned task reconnect (replaces the old passive-stream reconnect) ──
  // The task runs on the server independent of this tab. If we left one mid-run, its full
  // SSE stream is buffered; we replay it from index 0 and rebuild the round so nothing is
  // lost — backgrounding, reload, network drop, phone restart all survive.
  const reconnectingTaskRef = useRef<string | null>(null)

  const refreshSessionMerge = useCallback(() => {
    apiFetch(`${API_BASE}/api/session/restore`, { credentials: 'include' })
      .then(r => r.json())
      .then(({ session }) => {
        if (!session?.rounds?.length) return
        setRounds(prev => {
          // A fresh load starts blank by design — do NOT adopt the old active session
          // into an empty view (that resurrected the previous chat on every refresh).
          // Finished answers live in the conversation store / history now. Only merge a
          // just-completed answer into a round that is ALREADY on screen (reconnect case).
          if (prev.length === 0) return prev
          const serverLast = session.rounds[session.rounds.length - 1]
          const localLast = prev[prev.length - 1]
          if (serverLast?.id === localLast?.id && (serverLast?.synthesis?.length ?? 0) > (localLast?.synthesis?.length ?? 0)) {
            return [...prev.slice(0, -1), { ...localLast, ...serverLast }]
          }
          return prev
        })
      })
      .catch(() => {})
  }, [])

  const reconnectActiveTask = async () => {
    if (!authUser || authUser === 'loading') return
    let saved: { taskId: string; userMessage: string; ts: number } | null = null
    try { saved = JSON.parse(localStorage.getItem('crucible_active_task') || 'null') } catch {}
    // No (fresh) active task → just refresh the session to pick up anything finished while away.
    if (!saved?.taskId || Date.now() - (saved.ts ?? 0) > 3_600_000) {
      if (saved) { try { localStorage.removeItem('crucible_active_task') } catch {} }
      refreshSessionMerge()
      return
    }
    if (reconnectingTaskRef.current) return            // already reconnecting
    let status: any = null
    try { status = await apiFetch(`${API_BASE}/api/task/${saved.taskId}/status`).then(r => r.json()) } catch {}
    if (!status?.exists) {                              // task gone (TTL / server restart)
      try { localStorage.removeItem('crucible_active_task') } catch {}
      refreshSessionMerge()                             // server-patched final answer still recovered
      return
    }
    reconnectingTaskRef.current = saved.taskId
    setReconnecting(true)
    // Reset the round so the from=0 replay rebuilds it exactly (no double-applied tokens).
    setRounds(prev => {
      const fresh = emptyRound(saved!.taskId, saved!.userMessage)
      return prev.some(r => r.id === saved!.taskId) ? prev.map(r => r.id === saved!.taskId ? fresh : r) : [...prev, fresh]
    })
    setThinking(true); wasThinkingRef.current = true
    try {
      const res = await apiFetch(`${API_BASE}/api/task/stream?taskId=${encodeURIComponent(saved.taskId)}&from=0`)
      if (res.ok && res.body) await consumeStream(res.body.getReader(), saved.taskId, saved.userMessage)
    } catch {}
    setThinking(false); wasThinkingRef.current = false
    setReconnecting(false)
    reconnectingTaskRef.current = null
    try { localStorage.removeItem('crucible_active_task') } catch {}
  }

  // ── PWA push: register the service worker, and subscribe on a user gesture ──
  useEffect(() => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
  }, [])

  const ensurePushSubscription = async () => {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return
      if (Notification.permission === 'denied') return
      const reg = await navigator.serviceWorker.ready
      let perm: NotificationPermission = Notification.permission
      if (perm === 'default') perm = await Notification.requestPermission()
      if (perm !== 'granted') return
      let sub = await reg.pushManager.getSubscription()
      if (!sub) {
        const { key } = await apiFetch(`${API_BASE}/api/push/vapid-public`).then(r => r.json())
        if (!key) return
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) as BufferSource })
      }
      await apiFetch(`${API_BASE}/api/push/subscribe`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub }),
      })
    } catch {}
  }

  // Reconnect on first load (after auth resolves) and every time the tab becomes visible.
  useEffect(() => { void reconnectActiveTask() }, [authUser])
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'visible') void reconnectActiveTask() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [sessionId, authUser])

  // Track thinking state for reconnect decisions
  useEffect(() => { wasThinkingRef.current = thinking }, [thinking])

  // ── Poll for resumable checkpoints on mount ────────────────────────────────
  useEffect(() => {
    apiFetch(`${API_BASE}/api/checkpoint`)
      .then(r => r.json())
      .then(({ checkpoints }) => {
        if (!checkpoints?.length) return
        const cp = checkpoints[0]
        const age = Date.now() - (cp.savedAt ?? 0)
        // Auto-resume silently if checkpoint is fresh (within 90s grace window)
        if (age < 90_000) {
          console.log('[Resume] Fresh checkpoint detected, auto-resuming...')
          continueFromCheckpointData(cp)
          return
        }
        setResumeOffer({
          goal: cp.goal,
          projectPath: cp.projectPath,
          stepIntent: cp.stepIntent,
          stepIndex: cp.stepIndex,
          stepTotal: cp.stepTotal,
          iter: cp.iter,
          maxIters: cp.maxIters,
          savedAt: cp.savedAt,
        })
      })
      .catch(() => {})
  }, [])
  // Session J — drive /api/research and render its research_step / research_done events
  // into the round's synthesis. Isolated from the main SSE consumer to keep risk low.
  const runResearch = async (message: string, roundId: string) => {
    let res: Response
    try {
      res = await apiFetch(`${API_BASE}/api/research`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: abortRef.current?.signal,
      })
    } catch (e: any) {
      if (e?.name !== 'AbortError') setRounds(prev => prev.map(r => r.id === roundId ? { ...r, synthesis: 'Research failed to start.', synthesisDone: true } : r))
      return
    }
    if (!res.body) return
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n'); buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const p = line.slice(6); if (p.trim() === '[DONE]') continue
          try {
            const ev = JSON.parse(p)
            if (ev.type === 'research_step') {
              const status = `Researching… ${ev.phase}${ev.sources != null ? ` · ${ev.sources} sources` : ''}`
              setRounds(prev => prev.map(r => r.id === roundId && !r.synthesisDone ? { ...r, synthesis: status } : r))
            } else if (ev.type === 'research_done') {
              setRounds(prev => prev.map(r => r.id === roundId ? { ...r, synthesis: ev.text || '', synthesisDone: true } : r))
            } else if (ev.type === 'research_error') {
              setRounds(prev => prev.map(r => r.id === roundId ? { ...r, synthesis: ev.text || 'Research error.', synthesisDone: true } : r))
            }
          } catch { /* ignore partial */ }
        }
      }
    } catch (e: any) {
      // Network drop mid-research — surface gracefully instead of an unhandled rejection.
      if (e?.name !== 'AbortError') setRounds(prev => prev.map(r => r.id === roundId && !r.synthesisDone ? { ...r, synthesis: 'Research interrupted.', synthesisDone: true } : r))
    }
  }

  const send = async (overrideMessage?: string, modeOverride?: string, ensembleConfirmed = false) => {
    // In Remote Brain mode every send goes straight to the Mac agent loop.
    if (remoteBrain && !modeOverride) modeOverride = 'agent'
    if (thinking) return
    const userMessage = (overrideMessage ?? input).trim()
    if (!userMessage || userMessage.length < 4) return
    // ── Ensemble opt-in + BYOK gate ───────────────────────────────────────────
    // The external pipeline ('quorum') is never entered without the user's own key AND an
    // explicit go-ahead. Local modes (code/seeker/research/agent) are unaffected.
    const effectiveMode = modeOverride ?? mode
    if (effectiveMode === 'quorum') {
      if (!ensemble.hasAnyKey) {
        setEnsembleConfirm({ message: userMessage, noKeys: true }) // inline "add keys" card
        return
      }
      if (!ensembleConfirmed) {
        setEnsembleConfirm({ message: userMessage })              // always ask before fanning out
        return
      }
    }
    const roundId = Date.now().toString()
    setLiveRoundId(roundId)
    localStorage.setItem('crucible_has_sent', '1')
    setInput(''); setThinking(true); scrollLockedRef.current = false; setShowScrollBtn(false); haptic('medium')
    setAgentStartTime(Date.now()); setAgentElapsed(0); setAgentProgress(null)
    prewarmTokenRef.current = null
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    const nextRounds = [...rounds, emptyRound(roundId, userMessage)]
    setRounds(nextRounds)
    // Record this as the active server-owned task so that if the tab is backgrounded /
    // reloaded mid-run, we can reconnect to its buffered stream and replay on return.
    try { localStorage.setItem('crucible_active_task', JSON.stringify({ taskId: roundId, userMessage, ts: Date.now() })) } catch {}
    // First send is a user gesture — a good moment to enable "answer ready" push.
    void ensurePushSubscription()
    // Persist the new turn IMMEDIATELY (non-debounced) so closing the tab before the
    // pipeline even starts still resumes the question + full prior thread. Saving []
    // here used to blank the conversation for the entire deliberation window.
    apiFetch(`${API_BASE}/api/session/save`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rounds: nextRounds, mode, timestamp: Date.now() }),
    }).catch(() => {})
    // Archive into the grouped conversation store immediately so a brand-new chat shows
    // up in history the moment the first message is sent (not only after it finishes).
    apiFetch(`${API_BASE}/api/conversations/save`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: conversationIdRef.current, mode, rounds: nextRounds }),
    }).catch(() => {})

    abortRef.current = new AbortController()

    // Session J: autonomous research mode streams from a dedicated endpoint with its own
    // event shape — handled separately so the shared SSE consumer stays untouched.
    if ((modeOverride ?? mode) === 'research' && !remoteBrain) {
      await runResearch(userMessage, roundId)
      setThinking(false); setAgentStartTime(null); setAgentProgress(null)
      try { localStorage.removeItem('crucible_active_task') } catch {}
      return
    }

    let res: Response
    try {
      res = await apiFetch(`${API_BASE}/api/chat`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage,
          mode: modeOverride ?? mode,
          sessionId,
          conversationId,  // groups this round into the current conversation thread
          roundId,  // lets the server patch the finished answer into THIS round if we disconnect
          prewarmToken: prewarmTokenRef.current,
          device: /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "mobile" : "desktop",
          // BYOK: user-supplied provider keys, sent only when actually running ensemble.
          // The server uses these INSTEAD of any bundled/env key for the external fan-out.
          byokKeys: (modeOverride ?? mode) === 'quorum' ? ensemble.keyPayload : undefined,
          history: rounds.slice(-6).filter(r => r.synthesis).map(r => ({
            user: r.userMessage,
            assistant: r.synthesis
          }))
        }),
        signal: abortRef.current.signal,
      })
    } catch (err: any) {
      if (err.name === 'AbortError') { setThinking(false); return }
      console.error('[send] fetch failed:', err)
      haptic('heavy')
      setThinking(false); return
    }
    const reader = res.body!.getReader()
    await consumeStream(reader, roundId, userMessage)
    setThinking(false)
    setAgentStartTime(null); setAgentProgress(null)
    try { localStorage.removeItem('crucible_active_task') } catch {}
  }

  // Item 5: `send` closes over `input` and other per-keystroke state, so it's a fresh
  // reference every render — passing it directly to the memoized MessageList below would
  // defeat the memoization. sendRef always holds the latest `send`; sendStable is a
  // permanently stable wrapper that reads it, safe to pass as a prop.
  const sendRef = useRef(send)
  sendRef.current = send
  const sendStable = useCallback((text?: string) => sendRef.current(text), [])

  // Shared SSE consumer — used by the live send loop AND by reconnect/replay (below), so a
  // backgrounded task's buffered events rebuild the exact same UI state when the user returns.
  const consumeStream = async (reader: ReadableStreamDefaultReader<Uint8Array>, roundId: string, userMessage: string) => {
    const decoder = new TextDecoder()
    let sseBuf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // Buffer across chunks: SSE events (esp. agent diffs/output) can span reads.
      sseBuf += decoder.decode(value, { stream: true })
      const chunkLines = sseBuf.split('\n')
      sseBuf = chunkLines.pop() ?? ''
      const lines = chunkLines.filter(l => l.startsWith('data: '))
      for (const line of lines) {
        const raw = line.slice(6)
        if (raw === '[DONE]') break
        try {
          const parsed = JSON.parse(raw)

          // ── Agent loop events (Section 7) — fold through one reducer ────────
          if (AGENT_EVENT_TYPES.has(parsed.type)) {
            setRounds(prev => prev.map(r => r.id !== roundId ? r : { ...r, agent: agentReducer(r.agent, parsed) }))
            if (parsed.type === 'final') {
              // Agent's final summary doubles as the round's synthesis text — EXCEPT when
              // this turn stopped for a clarification: the server sends the clarification
              // question itself as `finalText` (loop.ts's done() has one text slot for both),
              // and the ClarificationCard above already renders that question. Without this
              // guard the same sentence shows up twice: once as the MC card, once as a fake
              // "0 models · 0% confident" synthesis bubble underneath it.
              setRounds(prev => prev.map(r => r.id !== roundId ? r : r.agent?.clarification ? r : { ...r, synthesis: parsed.text ?? r.synthesis, synthesisDone: true }))
              // Session L: in Remote Brain mode the Mac speaks the answer back. (A clarification
              // still gets read aloud — the question is real content, just not a synthesis bubble.)
              if (remoteBrain && parsed.text) {
                apiFetch(`${API_BASE}/api/tts`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ text: parsed.text }),
                }).catch(() => {})
              }
            }
            continue
          }

          // ── Model selection (first event) ──────────────────────────────────
          if (parsed.type === 'semantic_cache') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, semanticSim: parsed.similarity, semanticMatch: parsed.matchedQuery } : r))
            continue
          }
          if (parsed.type === 'model_selection') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, complexity: parsed.complexity ?? 'complex' } : r))
            const coloredModels = assignColors(parsed.models)
            const emptyResponses: Record<string, string>  = {}
            const emptyDone: Record<string, boolean>      = {}
            const emptyScores: Record<string, number|null> = {}
            const emptyCritiques: Record<string, Record<string, Critique>> = {}
            const emptyRevisions: Record<string, string>  = {}
            const emptyRevDone: Record<string, boolean>   = {}
            for (const m of coloredModels) {
              emptyResponses[m.id]  = ''
              emptyDone[m.id]       = false
              emptyScores[m.id]     = null
              emptyCritiques[m.id]  = {}
              emptyRevisions[m.id]  = ''
              emptyRevDone[m.id]    = false
            }
            setRounds(prev => prev.map(r => r.id !== roundId ? r : {
              ...r,
              models: coloredModels,
              synthesisModelId: parsed.synthesisModelId,
              promptType: parsed.promptType,
              complexity: parsed.complexity ?? 'complex',
              cached: parsed.cached === true,
              responses: emptyResponses,
              done: emptyDone,
              scores: emptyScores,
              critiques: emptyCritiques,
              revisions: emptyRevisions,
              revisionsDone: emptyRevDone,
            }))
            continue
          }

          // ── Layer 1 responses ──────────────────────────────────────────────
          if (!parsed.type || parsed.type === 'layer1') {
            const { modelId, text, done: modelDone, score, remediated, newText } = parsed
            setRounds(prev => prev.map(r => {
              if (r.id !== roundId) return r
              // If remediation fired, replace the response entirely
              const updatedText = remediated && newText
                ? newText
                : (r.responses[modelId] ?? '') + (text || '')
              return {
                ...r,
                responses: { ...r.responses, [modelId]: updatedText },
                scores: { ...r.scores, [modelId]: (typeof score === 'number' ? score : score?.compositeScore) ?? r.scores[modelId] },
                done: { ...r.done, [modelId]: modelDone || r.done[modelId] },
                remediated: { ...(r.remediated ?? {}), [modelId]: remediated ? true : (r.remediated?.[modelId] ?? false) },
              }
            }))
            continue
          }

          // ── Linter gate events ─────────────────────────────────────────────
          if (parsed.type === 'linter') {
            const { modelId, status, score: linterScore } = parsed
            setRounds(prev => prev.map(r => {
              if (r.id !== roundId) return r
              return {
                ...r,
                linterStatus: {
                  ...(r.linterStatus ?? {}),
                  [modelId]: { status, score: linterScore },
                },
                activityFeed: [...(r.activityFeed ?? []), { ts: Date.now(), type: 'linter', modelId, message: status === 'passed' ? 'Quality check passed' : status === 'failed' ? 'Quality check failed' : status === 'remediated' ? 'Auto-corrected and accepted' : 'No changes needed' }],
              }
            }))
            continue
          }

          // ── Contract event ─────────────────────────────────────────────────
          if (parsed.type === 'contract') {
            setRounds(prev => prev.map(r => {
              if (r.id !== roundId) return r
              return {
                ...r,
                activityFeed: [...(r.activityFeed ?? []), { ts: Date.now(), type: 'contract', message: `Response format set for ${parsed.promptType ?? 'this query'}` }],
              }
            }))
            continue
          }
          // ── Rollback event ─────────────────────────────────────────────────
          if (parsed.type === 'rollback') {
            const quarantined: Array<{ id: string; reason: string }> = parsed.quarantined ?? []
            setRounds(prev => prev.map(r => {
              if (r.id !== roundId) return r
              const entries = quarantined.map(q => ({ ts: Date.now(), type: 'rollback', modelId: q.id, message: q.reason === 'error' ? 'Model dropped — returned an error' : q.reason === 'empty' ? 'Model dropped — no response' : 'Model dropped — low quality' }))
              return { ...r, activityFeed: [...(r.activityFeed ?? []), ...entries] }
            }))
            continue
          }
          // ── Stage transitions ──────────────────────────────────────────────

          // ── Scores map (stage 2) ───────────────────────────────────────────
          if (parsed.type === 'scores') {
            setRounds(prev => prev.map(r => {
              if (r.id !== roundId) return r
              const merged = { ...r.scores }
              for (const [mid, val] of Object.entries(parsed.scores as Record<string, number>)) {
                merged[mid] = val
              }
              return { ...r, scores: merged }
            }))
            continue
          }

          if (parsed.type === 'stage') {
            if (parsed.stage === 2 && parsed.status === 'done')
              setRounds(prev => prev.map(r => r.id === roundId ? { ...r, stage2Done: true, avgScores: parsed.avgScores ?? {} } : r))
            if (parsed.stage === 3 && parsed.status === 'start')
              setRounds(prev => prev.map(r => r.id === roundId ? { ...r, stage3Started: true } : r))
            if (parsed.stage === 3 && parsed.status === 'done')
              setRounds(prev => prev.map(r => r.id === roundId ? { ...r, stage3Done: true } : r))
            if (parsed.stage === 4 && parsed.status === 'start')
              setRounds(prev => prev.map(r => r.id === roundId ? { ...r, stage4Started: true } : r))
            if (parsed.stage === 4 && parsed.status === 'done')
              setRounds(prev => prev.map(r => r.id === roundId ? { ...r, stage4Done: true } : r))
            setRounds(prev => prev.map(r => {
              if (r.id !== roundId) return r
              const stageLabels: Record<string, string> = { '1': 'Models thinking', '2': 'Grading responses', '3': 'Models debating', '4': 'Models self-correcting', '5': 'Writing final answer' }
              const label = stageLabels[String(parsed.stage)] ?? `Stage ${parsed.stage}`
              return { ...r, activityFeed: [...(r.activityFeed ?? []), { ts: Date.now(), type: 'stage', message: parsed.status === 'start' ? `Starting: ${label}` : `Done: ${label}` }] }
            }))
            if (parsed.stage === 5 && parsed.status === 'done') {
              setRounds(prev => prev.map(r => r.id === roundId ? { ...r, synthesisDone: true } : r))
              setThinking(false)
              const synthText = synthesisRef.current[roundId] ?? ''
              if (synthText) {
                setTimeout(() => runVerify(roundId, synthText, userMessage), 200)
              }


            }
            continue
          }

          // ── Critiques ──────────────────────────────────────────────────────
          if (parsed.type === 'critique') {
            if (parsed.criticId && parsed.targetId && parsed.text) {
              setRounds(prev => prev.map(r => r.id !== roundId ? r : {
                ...r,
                critiques: {
                  ...r.critiques,
                  [parsed.criticId]: {
                    ...(r.critiques?.[parsed.criticId] ?? {}),
                    [parsed.targetId]: { text: (r.critiques?.[parsed.criticId]?.[parsed.targetId]?.text ?? '') + parsed.text }
                  }
                }
              }))
            }
            const { criticId, targetId, text, done: critDone } = parsed
            setRounds(prev => prev.map(r => {
              if (r.id !== roundId) return r
              const existing = r.critiques[criticId]?.[targetId]?.text ?? ''
              return {
                ...r,
                critiques: {
                  ...r.critiques,
                  [criticId]: {
                    ...r.critiques[criticId],
                    [targetId]: { text: existing + (text || ''), done: critDone ?? false },
                  },
                },
              }
            }))
            continue
          }

          // ── Self-revisions ─────────────────────────────────────────────────
          if (parsed.type === 'revision') {
            const { modelId, text } = parsed
            setRounds(prev => prev.map(r => {
              if (r.id !== roundId) return r
              return {
                ...r,
                revisions: { ...r.revisions, [modelId]: text || r.revisions[modelId] },
              }
            }))
            continue
          }

          // ── Instant first token ───────────────────────────────────────────
          if (parsed.type === 'thinking') {
            continue
          }

          // ── SSE keepalive — connection is alive, nothing to render ─────────
          if (parsed.type === 'keepalive') {
            continue
          }

          // ── Live agent iteration progress ──────────────────────────────────
          if (parsed.type === 'iter_progress') {
            setAgentProgress({
              stepIndex: parsed.stepIndex ?? 0,
              stepTotal: parsed.stepTotal ?? 1,
              stepIntent: parsed.stepIntent ?? '',
              iter: parsed.iter ?? 1,
              maxIters: parsed.maxIters ?? 32,
            })
            continue
          }

          // ── Streaming synthesis tokens ─────────────────────────────────────
          if (parsed.type === 'synthesis_token') {
            const { text } = parsed
            if (text) {
              synthesisRef.current[roundId] = (synthesisRef.current[roundId] ?? '') + text
              setRounds(prev => prev.map(r => {
                if (r.id !== roundId) return r
                return { ...r, synthesis: r.synthesis + text, synthStreaming: true }
              }))
            }
            continue
          }

          // ── Synthesis (final polished result — replaces streamed draft) ────
          if (parsed.type === 'confidence') {
            setRounds(prev => prev.map(r => r.id !== roundId ? r : {
              ...r,
              confidence: {
                overallTier: parsed.overallTier,
                overallScore: parsed.overallScore,
                summary: parsed.summary,
                flaggedClaims: parsed.flaggedClaims ?? [],
                fragilityAssumption: parsed.fragilityAssumption,
                frontierQuestion: parsed.frontierQuestion,
              },
            }))
            continue
          }

          // Genealogy — contribution rates per model in final synthesis
          if (parsed.type === 'genealogy') {
            setRounds(prev => prev.map(r => r.id !== roundId ? r : {
              ...r,
              genealogy: parsed.contributionRates as Record<string, number>,
            }))
            continue
          }

          // I5 — adversarial critic findings (process trail only, never replaces synthesis)
          if (parsed.type === 'critic') {
            const problems: string[] = parsed.problems ?? []
            if (problems.length > 0) {
              setRounds(prev => prev.map(r => r.id === roundId ? { ...r, criticProblems: problems } : r))
            }
            continue
          }

          // Track P — MASTERPIECE SSE events
          if (parsed.type === 'masterpiece_gate') {
            if (parsed.gate?.shouldActivate) {
              setRounds(prev => prev.map(r => r.id === roundId
                ? { ...r, masterpiece: { active: true } }
                : r))
            }
            continue
          }
          if (parsed.type === 'masterpiece_shard') {
            setRounds(prev => prev.map(r => r.id === roundId ? {
              ...r,
              masterpiece: { ...r.masterpiece, active: true, shardCount: parsed.shardCount, shards: parsed.shards }
            } : r))
            continue
          }
          if (parsed.type === 'masterpiece_abductive') {
            setRounds(prev => prev.map(r => r.id === roundId ? {
              ...r,
              masterpiece: { ...r.masterpiece, active: true, connectionsFound: parsed.connectionsFound, connectionsSurvived: parsed.connectionsSurvived, domains: parsed.domains }
            } : r))
            continue
          }
          if (parsed.type === 'masterpiece_triadic') {
            setRounds(prev => prev.map(r => r.id === roundId ? {
              ...r,
              masterpiece: { ...r.masterpiece, active: true, resonancesFound: parsed.resonancesFound, patterns: parsed.patterns }
            } : r))
            continue
          }
          if (parsed.type === 'masterpiece_escalation') {
            setRounds(prev => prev.map(r => r.id === roundId ? {
              ...r,
              masterpiece: { ...r.masterpiece, active: true, escalatedCount: parsed.escalated, tiers: parsed.tiers }
            } : r))
            continue
          }
          if (parsed.type === 'masterpiece_moe') {
            setRounds(prev => prev.map(r => r.id === roundId ? {
              ...r,
              masterpiece: { ...r.masterpiece, active: true, specialists: parsed.specialists }
            } : r))
            continue
          }
          if (parsed.type === 'masterpiece_complete') {
            setRounds(prev => prev.map(r => r.id === roundId ? {
              ...r,
              masterpiece: {
                ...r.masterpiece,
                active: false,
                shardCount: parsed.shardCount,
                connectionsFound: parsed.abductiveConnectionsFound,
                connectionsSurvived: parsed.abductiveConnectionsSurvived,
                resonancesFound: parsed.structuralResonancesFound,
                escalatedCount: parsed.escalatedShardCount,
                elapsedMs: parsed.elapsedMs,
              }
            } : r))
            continue
          }
          // P12 — live shard progress: update the in-progress count so the UI shows
          // "N/M shards analyzed" while deep mode is running.
          if (parsed.type === 'masterpiece_shard_progress') {
            setRounds(prev => prev.map(r => r.id === roundId ? {
              ...r,
              masterpiece: { ...r.masterpiece, active: true, shardsCompleted: parsed.completed, shardsTotal: parsed.total }
            } : r))
            continue
          }
          if (parsed.type === 'masterpiece_assemble' || parsed.type === 'masterpiece_start') {
            continue  // no state update needed — progress visible via shard/abductive events
          }
          // Confidence-gated response commitment — surface what would resolve uncertainty.
          if (parsed.type === 'uncertain_commitment') {
            setRounds(prev => prev.map(r => r.id === roundId
              ? { ...r, uncertainCommitment: { overallScore: parsed.overallScore, resolvingStep: parsed.resolvingStep } }
              : r))
            continue
          }
          // Track P — light-mode cross-domain connection (novelty > 0.6 only)
          if (parsed.type === 'masterpiece_light') {
            setRounds(prev => prev.map(r => r.id === roundId
              ? { ...r, crossDomainConnection: parsed.connection }
              : r))
            continue
          }
          // Track U — ANIMA transparency entries (the synthesis text renders the answer;
          // these power a structured list view)
          if (parsed.type === 'anima_transparency') {
            setRounds(prev => prev.map(r => r.id === roundId
              ? { ...r, animaTruths: parsed.entries }
              : r))
            continue
          }

          // M3 — proactive ambient suggestion
          if (parsed.type === 'proactive_suggestion') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, proactiveSuggestion: parsed.text } : r))
            continue
          }

          if (parsed.type === 'synthesis') {
            const { text, done: synthDone, replace } = parsed
            if (replace) {
              // Polish completed — replace the streamed draft with the final polished text
              if (text) synthesisRef.current[roundId] = text
              setRounds(prev => prev.map(r => {
                if (r.id !== roundId) return r
                return {
                  ...r,
                  synthesis: text || r.synthesis,
                  synthStreaming: false,
                  synthesisDone: synthDone ?? r.synthesisDone,
                }
              }))
            } else {
              // Legacy path (agent streaming, cache replay) — append
              if (text) synthesisRef.current[roundId] = (synthesisRef.current[roundId] ?? '') + text
              setRounds(prev => prev.map(r => {
                if (r.id !== roundId) return r
                return {
                  ...r,
                  synthesis: r.synthesis + (text || ''),
                  synthesisDone: synthDone ?? r.synthesisDone,
                }
              }))
            }
            continue
          }

        } catch (e) { console.error('parse error', e) }
      }
    }
  }

  const runVerify = async (roundId: string, code: string, originalPrompt: string) => {
    setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyStatus: 'running', verifyMessage: 'Running verification...' } : r))
    let res: Response
    try {
      res = await apiFetch(`${API_BASE}/api/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, originalPrompt }),
      })
    } catch (fetchErr) {
      console.error('[runVerify] fetch FAILED:', fetchErr)
      return
    }
    if (!res.body) { console.error('[runVerify] no body'); return }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6)
        if (payload.trim() === '[DONE]') continue
        try {
          const parsed = JSON.parse(payload)
          if (parsed.type === 'verify_status') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyMessage: parsed.message } : r))
          } else if (parsed.type === 'verify_clean') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyStatus: 'clean', verifyMessage: '✓ Executed successfully' } : r))
          } else if (parsed.type === 'verify_static') {
            // Real static verification (syntax + types) — runtime skipped only because the
            // offline sandbox lacks the imported deps. Honest badge, code left intact.
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyStatus: 'clean', verifyMessage: parsed.message ?? '✓ Syntax & types verified' } : r))
          } else if (parsed.type === 'verify_fixed') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyStatus: 'fixed', verifyMessage: '✓ Fixed and verified', synthesis: parsed.code ? applyFixedCode(r.synthesis, parsed.code) : r.synthesis } : r))
          } else if (parsed.type === 'analysis_fixed') {
            // Pipeline fixed it — splice the fix into the original answer's code block
            setRounds(prev => prev.map(r => r.id === roundId ? {
              ...r,
              verifyStatus: 'fixed',
              verifyMessage: parsed.message ?? '✓ Fixed by analysis pipeline',
              synthesis: parsed.code ? applyFixedCode(r.synthesis, parsed.code) : r.synthesis,
            } : r))
          } else if (parsed.type === 'analysis_start' || parsed.type === 'analysis_status' || parsed.type === 'analysis_deepening') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyMessage: parsed.message ?? 'Deep analysis...' } : r))
          } else if (parsed.type === 'attack_start') {
            setRounds(prev => prev.map(r => r.id === roundId ? {
              ...r, verifyMessage: `Analyzing: ${parsed.lens} (${parsed.attempt}/${parsed.totalAttempts})`
            } : r))
          } else if (parsed.type === 'candidate_tested') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyMessage: parsed.message ?? '' } : r))
          } else if (parsed.type === 'synthesis_start') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyMessage: parsed.message ?? 'Synthesizing...' } : r))
          } else if (parsed.type === 'verify_needs_model') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyStatus: 'needs_model', verifyMessage: 'Applying surgical fix...' } : r))
            await streamSurgicalFix(roundId, parsed.surgicalPrompt)
          } else if (parsed.type === 'analysis_failed' || parsed.type === 'verify_failed') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyStatus: 'failed', verifyMessage: parsed.error ?? 'Verification failed' } : r))
          }
        } catch (e) { console.error('verify parse error', e) }
      }
    }
  }

  const streamSurgicalFix = async (roundId: string, surgicalPrompt: string) => {
    const res = await apiFetch(`${API_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: surgicalPrompt, isSurgical: true }),
    })
    if (!res.body) return
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let newSynthesis = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6)
        if (payload.trim() === '[DONE]') continue
        try {
          const parsed = JSON.parse(payload)
          if (parsed.type === 'synthesis') {
            newSynthesis += parsed.text || ''
            const isSurgicalDone = parsed.done ?? false
            setRounds(prev => prev.map(r => r.id === roundId ? {
              ...r,
              synthesis: newSynthesis,
              ...(isSurgicalDone ? { verifyStatus: 'fixed', verifyMessage: '✓ Fixed and verified' } : {})
            } : r))
          }
        } catch (e) {}
      }
    }
    setRounds(prev => prev.map(r => r.id === roundId ? { ...r, verifyStatus: 'fixed', verifyMessage: '✓ Fixed and verified' } : r))
  }

  // Verify is triggered directly in the stage-5-done SSE handler above


  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!thinking) send() }
  }
  const dismissResume = () => {
    if (resumeOffer) {
      apiFetch(`${API_BASE}/api/checkpoint`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: resumeOffer.projectPath }),
      }).catch(() => {})
    }
    setResumeOffer(null)
  }

  const continueFromCheckpointData = async (offer: { goal: string; projectPath: string; stepIntent?: string; stepIndex?: number; stepTotal?: number; iter?: number; maxIters?: number; savedAt?: number }) => {
    setResumeOffer(null)
    const roundId = Date.now().toString()
    setThinking(true)
    setAgentStartTime(Date.now()); setAgentElapsed(0)
    setRounds(prev => [...prev, emptyRound(roundId, offer.goal)])
    abortRef.current = new AbortController()
    let res: Response
    try {
      res = await apiFetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortRef.current.signal,
        body: JSON.stringify({
          message: offer.goal,
          mode: 'agent',
          projectPath: offer.projectPath,
          resumeFromCheckpoint: true,
        }),
      })
    } catch { setThinking(false); setAgentStartTime(null); return }
    if (!res.body) { setThinking(false); setAgentStartTime(null); return }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (raw === '[DONE]') break
        try {
          const parsed = JSON.parse(raw)
          if (parsed.type === 'final') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, synthesis: parsed.text ?? '', synthesisDone: true } : r))
          }
          if (parsed.type === 'agent_done') {
            setRounds(prev => prev.map(r => r.id === roundId ? { ...r, agent: { ...r.agent, active: false } as any } : r))
          }
          if (AGENT_EVENT_TYPES.has(parsed.type)) {
            setRounds(prev => prev.map(r => r.id !== roundId ? r : { ...r, agent: agentReducer(r.agent, parsed) }))
          }
        } catch {}
      }
    }
    setThinking(false); setAgentStartTime(null); setAgentProgress(null)
  }

  const continueFromCheckpoint = async () => {
    if (!resumeOffer) return
    const offer = resumeOffer
    setResumeOffer(null)
    const roundId = Date.now().toString()
    setThinking(true)
    setAgentStartTime(Date.now()); setAgentElapsed(0)
    setRounds(prev => [...prev, emptyRound(roundId, offer.goal)])
    abortRef.current = new AbortController()
    let res: Response
    try {
      res = await apiFetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortRef.current.signal,
        body: JSON.stringify({
          message: offer.goal,
          mode: 'agent',
          projectPath: offer.projectPath,
          resumeFromCheckpoint: true,
        }),
      })
    } catch { setThinking(false); setAgentStartTime(null); return }
    // Reuse the same SSE parse loop that `send()` uses — delegate by calling send
    // with the pre-built res. Not worth duplicating; just set up the stream directly.
    if (!res.body) { setThinking(false); setAgentStartTime(null); return }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (raw === '[DONE]') break
        try {
          const parsed = JSON.parse(raw)
          if (parsed.type === 'final') {
            setRounds(prev => prev.map(r => r.id === roundId
              ? { ...r, synthesis: parsed.text ?? '', synthesisDone: true }
              : r))
          }
          if (parsed.type === 'agent_done') {
            setRounds(prev => prev.map(r => r.id === roundId
              ? { ...r, agent: { ...r.agent, active: false } as any }
              : r))
          }
        } catch {}
      }
    }
    setThinking(false); setAgentStartTime(null); setAgentProgress(null)
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setInput(val)
    const ta = e.target
    requestAnimationFrame(() => {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
    })
    if (minLengthTimer.current) clearTimeout(minLengthTimer.current)
    if (val.trim().length > 0 && val.trim().length < 4) {
      minLengthTimer.current = setTimeout(() => setShowMinLengthTip(true), 800)
    } else {
      setShowMinLengthTip(false)
    }

    // ── Predictive pre-warm — ensemble runs ONLY. Warming spins up EXTERNAL models
    // (Groq/OpenRouter), so in the default local mode typing must trigger zero
    // external traffic (v3 "0 external calls" rule).
    if (prewarmDebounceRef.current) clearTimeout(prewarmDebounceRef.current)
    const wordCount = val.trim().split(/\s+/).filter(Boolean).length
    if (mode === 'quorum' && wordCount >= 4 && !thinking) {
      prewarmDebounceRef.current = setTimeout(() => {
        const token = Date.now().toString()
        prewarmTokenRef.current = token
        apiFetch(`${API_BASE}/api/prewarm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: val.trim(), token }),
        }).catch(() => {})
      }, 400)
    }
  }
  const stop = () => {
    if (abortRef.current) abortRef.current.abort()
    setThinking(false)
  }

  // Item 5: only depends on the stable setRounds setter, so this can be a truly stable
  // callback — required for MessageList's memoization to hold across keystrokes.
  const toggleCritique = useCallback((roundId: string, critic: string, target: string) => {
    setRounds(prev => prev.map(r => {
      if (r.id !== roundId) return r
      const same = r.expandedCritique?.critic === critic && r.expandedCritique?.target === target
      return { ...r, expandedCritique: same ? null : { critic, target } }
    }))
  }, [])

  const latestRound = rounds[rounds.length - 1] ?? null
  const activeModels = latestRound?.models ?? []

  // Show auth screen while loading or not authenticated
  if (authUser === 'loading') return null
  if (!authUser) return <AuthScreen onAuth={user => setAuthUser(user)} />

  return (
    <div className="crucible-root" style={{
      height: '100dvh', background: '#101016',
      marginLeft: 0,
      transition: 'margin-left 0.38s cubic-bezier(0.22,1,0.36,1)', width: '100vw',
      display: 'flex', flexDirection: 'column',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      color: '#e4e4ee', position: 'relative', overflow: 'hidden', userSelect: 'none',
    }}>
      {/* Ambient animated backdrop (Crucible v2 design) — sits behind all content */}
      <BackgroundBlobs working={thinking} />
      {/* Ensemble key management lives in the Settings tab; the per-query confirm is an
          inline card above the composer (v3) — no modals. */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative', zIndex: 1 }}>
        <NavRail tab={tab} setTab={setTab} agentsOpen={agentsOpen} onToggleAgents={() => setAgentsOpen(o => !o)} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
      {/* Global keyframes + shared rules live in index.css (design-token sheet). */}

      {/* Item 18: agents/history/settings render as an overlay ON TOP of chat, not a tab
          swap that unmounts it — the conversation underneath stays alive and scrolled to
          where the user left it, so opening an agent/tool never navigates them away. */}
      {tab !== 'chat' && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 30, background: '#101016',
          display: 'flex', flexDirection: 'column', animation: 'panelUp 0.22s cubic-bezier(0.22,1,0.36,1)',
        }}>
          <button
            onClick={() => setTab('chat')}
            title="Back to chat"
            style={{
              position: 'absolute', top: 14, right: 18, zIndex: 31, width: 30, height: 30, borderRadius: 9,
              border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.04)',
              color: '#9797ab', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
      {tab === 'history' && <HistoryTabView onRestore={summary => {
        apiFetch(`${API_BASE}/api/conversations/${summary.id}`, { credentials: 'include' })
          .then(r => r.json())
          .then(({ conversation }) => {
            if (!conversation?.rounds) return
            setConversationId(conversation.id)
            // Deliberately do NOT adopt the stored conversation.mode — restoring an old
            // ensemble ('quorum') thread must never silently re-arm the external pipeline.
            // Crucible-local is always the mode a restored thread continues in.
            setRounds(conversation.rounds)
            setTab('chat')
          })
          .catch(() => {})
      }} />}
      {tab === 'settings' && (
        <SettingsTabView
          ensemble={ensemble}
          advanced={
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              {/* System drawers relocated from the old chat topbar — each renders its own
                  trigger icon + anchored panel. */}
              <HistoryBinder onRestore={summary => {
                apiFetch(`${API_BASE}/api/conversations/${summary.id}`, { credentials: 'include' })
                  .then(r => r.json())
                  .then(({ conversation }) => {
                    if (!conversation?.rounds) return
                    setConversationId(conversation.id)
                    setRounds(conversation.rounds)
                    setTab('chat')
                  })
                  .catch(() => {})
              }} />
              <TasksBinder onResume={goal => { setTab('chat'); void send(goal) }} />
              <IntegrationsBinder draft={input} />
              <LibraryBinder onBuild={text => { setTab('chat'); void send(text) }} />
              <SelfRepairBinder />
              <SelfPatcherBinder />
              <button
                onClick={() => {
                  apiFetch(`${API_BASE}/api/governance`).then(r => r.json()).then((d: any[]) => {
                    setGovRequests(d)
                    setGovPending(d.filter((x: any) => x.status === 'pending').length)
                  }).catch(() => {})
                  setGovPanelOpen(o => !o)
                }}
                title="Infrastructure requests"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: govPending > 0 ? 'rgba(255,180,80,0.85)' : '#555', padding: '6px 8px', borderRadius: 8,
                  display: 'flex', alignItems: 'center', gap: 5,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 1.5l1.8 3.2 3.7.54-2.68 2.6.63 3.66L8 9.7l-3.45 1.8.63-3.66L2.5 5.24l3.7-.54z"/>
                </svg>
                {govPending > 0 && (
                  <span style={{ fontSize: 9, fontWeight: 700, color: 'rgba(255,180,80,0.9)' }}>{govPending}</span>
                )}
              </button>
            </div>
          }
        />
      )}
        </div>
      )}

      {/* Items 18/19: Agents & capabilities is an inline drawer anchored to the chat panel,
          not a tab swap — the conversation underneath stays mounted the entire time this is
          open (unlike History/Settings above, which still fully cover the chat while open,
          this is a right-edge drawer over a dimmed scrim so the chat is still visible behind
          it, matching the LibraryBinder drawer pattern used elsewhere in this app). */}
      {agentsOpen && (
        <>
          <div onClick={() => setAgentsOpen(false)} style={{
            position: 'absolute', inset: 0, zIndex: 28,
            background: 'rgba(0,0,0,0.4)', animation: 'fadeIn 0.2s ease',
          }} />
          <div style={{
            position: 'absolute', top: 0, right: 0, bottom: inputBarHeight, zIndex: 29,
            width: 'min(560px, 94vw)',
            background: 'rgba(14,14,20,0.88)', backdropFilter: 'blur(40px) saturate(1.5)', WebkitBackdropFilter: 'blur(40px) saturate(1.5)',
            borderLeft: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '-24px 0 80px rgba(0,0,0,0.5), inset 1px 0 0 rgba(255,255,255,0.05)',
            animation: 'panelUp 0.22s cubic-bezier(0.22,1,0.36,1)',
            display: 'flex', flexDirection: 'column',
          }}>
            <AgentsTabView
              onBuild={text => { setAgentsOpen(false); void send(text) }}
              onClose={() => setAgentsOpen(false)}
              onInsert={text => {
                setAgentsOpen(false)
                setInput(text)
                requestAnimationFrame(() => textareaRef.current?.focus())
              }}
            />
          </div>
        </>
      )}

      <>
      <ShimmerBg thinking={thinking} mode={mode} />

      {/* ── Step 9: Remote Brain overlay — canvas only, stops above the normal input bar ── */}
      {/* The regular chat input at the bottom is the command interface — no separate bar. */}
      {/* ── Remote Brain overlay ────────────────────────────────────────────────
           Portrait: canvas fills top region, input bar floats over bottom.
           Landscape: split — canvas left 62%, chat history + input bar right 38%.
           The canvas lives here regardless of layout so the SSE stream ref is stable.
           The input bar is always rendered by its normal slot below; we only control
           the canvas area here. pointerEvents: 'none' on the canvas div means taps
           fall through to chat content and the input bar naturally — no interference.
      ─────────────────────────────────────────────────────────────────────────── */}
      {remoteBrain && isMobile && (
        <>
          {/* PiP draggable window — position updated via direct DOM ref during drag
              (no setState on touchMove) to avoid 60fps React re-renders that were
              causing the stream canvas RAF loop to stutter and appear laggy. */}
          <div ref={pipDivRef} style={{
            position: 'fixed',
            left: pipPos.x,
            top: visualVpOffsetTop + pipPos.y,
            width: '88vw',
            zIndex: 200,
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            pointerEvents: 'auto',
            touchAction: 'none',
            transition: 'top 0.3s cubic-bezier(0.22,1,0.36,1), left 0.3s cubic-bezier(0.22,1,0.36,1)',
          }}
            onTouchStart={e => {
              const t = e.touches[0]
              pipDragRef.current = { startX: t.clientX, startY: t.clientY, startPipX: pipPosRef.current.x, startPipY: pipPosRef.current.y }
              if (pipDivRef.current) pipDivRef.current.style.transition = 'none'
            }}
            onTouchMove={e => {
              if (!pipDragRef.current) return
              const t = e.touches[0]
              const dx = t.clientX - pipDragRef.current.startX
              const dy = t.clientY - pipDragRef.current.startY
              const next = { x: pipDragRef.current.startPipX + dx, y: pipDragRef.current.startPipY + dy }
              pipPosRef.current = next
              // Direct DOM update — zero React re-renders during drag
              if (pipDivRef.current) {
                pipDivRef.current.style.left = next.x + 'px'
                pipDivRef.current.style.top = (visualVpOffsetTopRef.current + next.y) + 'px'
              }
            }}
            onTouchEnd={() => {
              pipDragRef.current = null
              if (pipDivRef.current) pipDivRef.current.style.transition = 'top 0.3s cubic-bezier(0.22,1,0.36,1), left 0.3s cubic-bezier(0.22,1,0.36,1)'
              // Sync React state once at drag end (one re-render vs 60fps re-renders)
              setPipPos({ ...pipPosRef.current })
            }}
          >
            <canvas
              ref={screenCanvasRef}
              style={{
                width: '100%', height: 'auto', display: 'block',
                opacity: streamStatus === 'live' ? 1 : 0,
                transition: 'opacity 0.4s ease',
              }}
            />

            {/* Connecting / error — centered in canvas pane */}
            {streamStatus !== 'live' && (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 12,
                pointerEvents: 'auto',
              }}>
                {streamStatus === 'connecting' ? (
                  <>
                    <div style={{
                      width: 26, height: 26, borderRadius: '50%',
                      border: '2px solid rgba(255,255,255,0.07)',
                      borderTop: '2px solid rgba(124,124,248,0.75)',
                      animation: 'spin 0.85s linear infinite',
                    }} />
                    <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.28)', letterSpacing: '0.07em' }}>connecting…</span>
                  </>
                ) : (
                  <>
                    <span style={{ fontSize: 11, color: 'rgba(248,113,113,0.55)' }}>stream unavailable</span>
                    {/* On the same network the tunnel can resolve to the screenless cloud
                        origin — loading the app straight from the Mac fixes it for good. */}
                    {remoteLanOrigin && (
                      <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.3)', textAlign: 'center', maxWidth: 200, lineHeight: 1.5 }}>
                        On the same Wi-Fi as your Mac? Open Crucible locally:
                      </span>
                    )}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={() => { setRemoteBrain(false); setTimeout(() => setRemoteBrain(true), 100) }}
                        style={{
                          background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                          color: '#ccc', borderRadius: 7, padding: '5px 12px', fontSize: 11, cursor: 'pointer',
                        }}
                      >retry</button>
                      {remoteLanOrigin && (
                        <button
                          onClick={() => { window.location.href = remoteLanOrigin }}
                          style={{
                            background: 'rgba(124,124,248,0.16)', border: '1px solid rgba(124,124,248,0.3)',
                            color: '#a5a5ff', borderRadius: 7, padding: '5px 12px', fontSize: 11, cursor: 'pointer',
                          }}
                        >open on local network</button>
                      )}
                      {/* Session L: away from the Mac's network → open a quick tunnel that
                          points straight at the Mac, then reload onto it (wss screen stream). */}
                      <button
                        onClick={async () => {
                          try {
                            const r = await apiFetch(`${API_BASE}/api/remote-brain/tunnel/start`, { method: 'POST' })
                            const j = await r.json()
                            if (j?.url) window.location.href = j.url
                          } catch { /* stay on the error screen */ }
                        }}
                        style={{
                          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
                          color: 'rgba(255,255,255,0.6)', borderRadius: 7, padding: '5px 12px', fontSize: 11, cursor: 'pointer',
                        }}
                      >connect via tunnel</button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* HUD: top-left fps + top-right live badge + exit */}
            <div style={{
              position: 'absolute', top: 8, left: 0, right: 0,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '0 8px', pointerEvents: 'auto',
            }}>
              {/* fps — only when live */}
              {streamStatus === 'live' && streamFps > 0 ? (
                <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.2)', fontVariantNumeric: 'tabular-nums', letterSpacing: '0.05em' }}>
                  {streamFps} fps
                </span>
              ) : <span />}

              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {/* LIVE badge */}
                {streamStatus === 'live' && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    background: 'rgba(0,0,0,0.55)', borderRadius: 5, padding: '3px 7px',
                    backdropFilter: 'blur(4px)',
                  }}>
                    <div style={{
                      width: 5, height: 5, borderRadius: '50%',
                      background: '#4ade80', boxShadow: '0 0 6px #4ade80',
                      animation: 'dotpulse 2s ease-in-out infinite',
                    }} />
                    <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.5)', letterSpacing: '0.12em', fontWeight: 700 }}>LIVE</span>
                  </div>
                )}
                {/* Exit */}
                <button
                  onClick={() => setRemoteBrain(false)}
                  style={{
                    background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.1)',
                    backdropFilter: 'blur(4px)',
                    color: 'rgba(255,255,255,0.65)', borderRadius: 7, padding: '4px 10px',
                    fontSize: 10, fontWeight: 600, cursor: 'pointer', letterSpacing: '0.03em',
                  }}
                >Exit</button>
              </div>
            </div>
          </div>

          {/* In landscape: right-side backdrop so chat is readable over page content */}
          {isLandscape && (
            <div style={{
              position: 'fixed', top: 0, right: 0, width: '38%', bottom: 0,
              zIndex: 48, background: 'rgba(13,13,21,0.97)',
              borderLeft: '1px solid rgba(255,255,255,0.06)',
              pointerEvents: 'none',
            }} />
          )}
        </>
      )}

      {/* ── Top bar — v3: slim, reference-style. Wordmark + on-device badge on the left,
          live working status + New chat on the right. All feature navigation lives in the
          left rail; the old binder/menu icon cluster is gone (binders now live in Settings). */}
      <div className="crucible-topbar" style={{
        height: 48, flexShrink: 0, display: 'flex', alignItems: 'center',
        // Electron (hiddenInset titlebar): the macOS traffic lights spill ~16px past the
        // 56px nav rail into this bar — inset the wordmark so they never overlap it.
        padding: `0 18px 0 ${window.electronIPC ? 44 : 18}px`, gap: 12, zIndex: 10, position: 'relative',
        WebkitAppRegion: 'drag',
      } as any}>
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '-0.01em', color: '#e4e4ee' }}>Crucible</span>
        {/* Top-bar overlap fix: on mobile widths this pill's full label plus the New Chat
            button and agent-progress text had no wrap/shrink handling and could crowd/
            overlap at the right edge — the dot alone still shows mode at a glance. */}
        <span style={{
          display: 'flex', alignItems: 'center', gap: 5,
          fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', color: '#66667a',
          background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.07)',
          padding: '2px 8px', borderRadius: 999, flexShrink: 0,
        }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: mode === 'quorum' ? '#7c7cf8' : '#4db89e', flexShrink: 0 }} />
          {!isMobile && (mode === 'quorum' ? 'ENSEMBLE · YOUR KEYS' : 'ON-DEVICE')}
        </span>
        <div style={{ flex: 1, minWidth: 8 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, WebkitAppRegion: 'no-drag' } as any}>
          {thinking && latestRound && (() => {
            const secs = Math.floor(agentElapsed / 1000)
            const mm = String(Math.floor(secs / 60)).padStart(2, '0')
            const ss = String(secs % 60).padStart(2, '0')
            const r = latestRound
            const stageLabel = agentProgress
              ? `iter ${agentProgress.iter}/${agentProgress.maxIters}${agentProgress.stepTotal > 1 ? ` · step ${agentProgress.stepIndex + 1}/${agentProgress.stepTotal}` : ''}`
              : !r.synthesis.length ? 'thinking…'
              : r.synthesisDone ? 'settling…'
              : 'pouring…'
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, animation: 'fadeIn 0.3s', flexShrink: 0 }}>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 10.5, color: '#55556a', fontWeight: 500 }}>{mm}:{ss}</span>
                {!isMobile && <span style={{ fontSize: 10.5, color: '#77778c', letterSpacing: '0.05em' }}>{stageLabel}</span>}
              </div>
            )
          })()}
          {reconnecting && (
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
              color: 'rgba(245,158,11,0.8)', textTransform: 'uppercase',
              animation: 'pulse 1.4s ease infinite',
            }}>reconnecting…</span>
          )}
          <button
            onClick={() => {
              setRounds([])
              setConversationId('conv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8))
            }}
            title="New chat"
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', flexShrink: 0,
              borderRadius: 10, border: '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(255,255,255,0.04)', color: '#b8b8cc',
              fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            {!isMobile && 'New chat'}
          </button>
        </div>
      </div>

      {/* N1 — Governance panel */}
      {govPanelOpen && (
        <div style={{
          position: 'fixed', top: 50, right: 16, zIndex: 200, width: 340, maxHeight: '70vh',
          background: '#111114', border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12, boxShadow: '0 16px 48px rgba(0,0,0,0.7)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div style={{ padding: '12px 14px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, letterSpacing: '0.08em', color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase' as const }}>Infrastructure requests</span>
            <button onClick={() => setGovPanelOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.3)', fontSize: 14, lineHeight: 1 }}>×</button>
          </div>
          <div style={{ overflowY: 'auto' as const, flex: 1, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {govRequests.length === 0 && (
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)', padding: '12px 4px' }}>No infrastructure requests yet.</div>
            )}
            {[...govRequests].reverse().map((r: any) => (
              <div key={r.id} style={{
                background: r.status === 'pending' ? 'rgba(255,180,80,0.04)' : 'rgba(255,255,255,0.02)',
                border: `1px solid ${r.status === 'pending' ? 'rgba(255,180,80,0.2)' : r.status === 'approved' ? 'rgba(77,220,160,0.15)' : 'rgba(248,124,124,0.15)'}`,
                borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.75)' }}>{r.title}</span>
                  <span style={{
                    fontSize: 8, letterSpacing: '0.07em', textTransform: 'uppercase' as const, padding: '2px 6px', borderRadius: 4,
                    color: r.status === 'pending' ? 'rgba(255,180,80,0.8)' : r.status === 'approved' ? 'rgba(77,220,160,0.8)' : 'rgba(248,124,124,0.7)',
                    border: `1px solid ${r.status === 'pending' ? 'rgba(255,180,80,0.3)' : r.status === 'approved' ? 'rgba(77,220,160,0.3)' : 'rgba(248,124,124,0.3)'}`,
                  }}>{r.status}</span>
                </div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', lineHeight: 1.5 }}><b style={{ color: 'rgba(255,255,255,0.4)' }}>What:</b> {r.what}</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', lineHeight: 1.5 }}><b style={{ color: 'rgba(255,255,255,0.4)' }}>Why:</b> {r.why}</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', lineHeight: 1.5 }}><b style={{ color: 'rgba(255,255,255,0.4)' }}>Impact:</b> {r.impact}</div>
                {r.status === 'pending' && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                    <button onClick={() => {
                      apiFetch(`${API_BASE}/api/governance/${r.id}/approve`, { method: 'POST' })
                        .then(res => res.json())
                        .then(() => { setGovRequests(prev => prev.map((x: any) => x.id === r.id ? { ...x, status: 'approved' } : x)); setGovPending(p => Math.max(0, p - 1)) })
                        .catch(() => {})
                    }} style={{
                      flex: 1, padding: '5px 0', background: 'rgba(77,220,160,0.1)', border: '1px solid rgba(77,220,160,0.25)',
                      borderRadius: 5, cursor: 'pointer', color: 'rgba(77,220,160,0.8)', fontSize: 10, letterSpacing: '0.05em',
                    }}>Approve</button>
                    <button onClick={() => {
                      apiFetch(`${API_BASE}/api/governance/${r.id}/reject`, { method: 'POST' })
                        .then(res => res.json())
                        .then(() => { setGovRequests(prev => prev.map((x: any) => x.id === r.id ? { ...x, status: 'rejected' } : x)); setGovPending(p => Math.max(0, p - 1)) })
                        .catch(() => {})
                    }} style={{
                      flex: 1, padding: '5px 0', background: 'rgba(248,124,124,0.07)', border: '1px solid rgba(248,124,124,0.2)',
                      borderRadius: 5, cursor: 'pointer', color: 'rgba(248,124,124,0.7)', fontSize: 10, letterSpacing: '0.05em',
                    }}>Reject</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Resume offer banner ── */}
      {resumeOffer && (
        <div className="crucible-resume-banner" style={{
          position: 'fixed', bottom: 155, left: '50%', transform: 'translateX(-50%)',
          zIndex: 50, animation: 'panelUp 0.3s cubic-bezier(0.22,1,0.36,1)',
          background: 'rgba(18,18,28,0.96)', backdropFilter: 'blur(20px)',
          border: '1px solid rgba(124,124,248,0.25)',
          borderRadius: 14, padding: '14px 18px',
          display: 'flex', alignItems: 'center', gap: 14,
          boxShadow: '0 8px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(124,124,248,0.08)',
          maxWidth: 540,
        }}>
          {/* Pulse dot */}
          <div style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            background: '#7c7cf8',
            boxShadow: '0 0 8px rgba(124,124,248,0.7)',
            animation: 'dotpulse 1.2s ease-in-out infinite',
          }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#c8c8e8', marginBottom: 3,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
              Paused at step {resumeOffer.stepIndex + 1}/{resumeOffer.stepTotal}, iteration {resumeOffer.iter}/{resumeOffer.maxIters}
            </div>
            <div style={{ fontSize: 10, color: '#444', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
              {resumeOffer.stepIntent || resumeOffer.goal.slice(0, 80)}
            </div>
          </div>
          <button
            onClick={continueFromCheckpoint}
            style={{
              padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(124,124,248,0.4)',
              background: 'rgba(124,124,248,0.12)', color: '#a0a0f8',
              fontSize: 11, fontWeight: 600, cursor: 'pointer', letterSpacing: '0.04em',
              flexShrink: 0, outline: 'none',
            }}
          >Continue</button>
          <button
            onClick={dismissResume}
            style={{
              padding: '6px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)',
              background: 'transparent', color: '#333',
              fontSize: 11, cursor: 'pointer', flexShrink: 0, outline: 'none',
            }}
          >Dismiss</button>
        </div>
      )}

      {/* ── Message history ── */}
      <MessageList
        rounds={rounds} setRounds={setRounds} send={sendStable} toggleCritique={toggleCritique}
        inputBarHeight={inputBarHeight} liveRoundId={liveRoundId} thinking={thinking}
        scrollRef={scrollRef} bottomRef={bottomRef}
        handleScroll={handleScroll} handleWheel={handleWheel}
        handleTouchStart={handleTouchStart} handleTouchMove={handleTouchMove}
      />


      {/* ── Progressive blur veil — frosted glass that deepens toward the bottom ──
          Two stacked masked backdrop-blur layers. Each mask fades the blur IN from
          the top, so content scrolling down gets progressively more blurred the lower
          it goes — dissolving into a soft frosted ghost behind the model cards. No
          solid background, so it never reads as a dark bar; the blobs stay visible. */}
      <div style={{
        position: 'fixed', bottom: 0,
        left: remoteBrain && isMobile && isLandscape ? '62%' : 0,
        right: 0,
        height: inputBarHeight - 4, pointerEvents: 'none', zIndex: 8, background: remoteBrain && isMobile ? 'rgba(13,13,21,0.55)' : 'transparent',
        backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0px, black 64px)',
        maskImage: 'linear-gradient(to bottom, transparent 0px, black 64px)',
      }} />
      <div style={{
        position: 'fixed', bottom: 0,
        left: remoteBrain && isMobile && isLandscape ? '62%' : 0,
        right: 0,
        height: inputBarHeight - 28, pointerEvents: 'none', zIndex: 9,
        backdropFilter: 'blur(44px)', WebkitBackdropFilter: 'blur(44px)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0px, black 44px)',
        maskImage: 'linear-gradient(to bottom, transparent 0px, black 44px)',
      }} />

      {/* ── Scroll-to-bottom button (visible only when the user scrolled up) ── */}
      {showScrollBtn && rounds.length > 0 && (
        <button
          aria-label="Scroll to bottom"
          onClick={() => { scrollToBottom(); haptic('light') }}
          style={{
            position: 'fixed', left: '50%', transform: 'translateX(-50%)',
            bottom: inputBarHeight + 8, zIndex: 11,
            width: 32, height: 32, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 6, cursor: 'pointer', outline: 'none',
            background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)',
            backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
            color: 'rgba(255,255,255,0.7)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
            transition: 'opacity 0.2s ease',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 2.5v9M3 7.5l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      )}

      {/* ── Input bar ── */}
      <div ref={inputBarRef} className="crucible-inputbar-wrap" style={{
        position: 'fixed', padding: '8px 12px 18px',
        // In portrait Remote Brain, push the bar above the software keyboard using
        // visualViewport. On iOS, position:fixed;bottom:0 lands behind the keyboard —
        // we have to offset by the keyboard height (innerHeight − visualVpHeight).
        bottom: remoteBrain && isMobile && !isLandscape
          ? Math.max(0, window.innerHeight - visualVpOffsetTop - visualVpHeight)
          : 0,
        // In landscape Remote Brain: anchor to the right 38% panel so it sits below chat.
        // In portrait Remote Brain: full width, above the canvas (zIndex 60).
        // Normal: full width, normal stacking.
        left: remoteBrain && isMobile && isLandscape ? '62%' : 0,
        right: 0,
        zIndex: remoteBrain && isMobile ? 60 : 10,
        // Remote Brain portrait: frosted glass so the stream bleeds through.
        background: remoteBrain && isMobile && !isLandscape
          ? 'rgba(13,13,21,0.55)'
          : remoteBrain && isMobile && isLandscape
            ? 'rgba(13,13,21,0.97)'
            : 'transparent',
        backdropFilter: remoteBrain && isMobile && !isLandscape ? 'blur(16px)' : undefined,
        WebkitBackdropFilter: remoteBrain && isMobile && !isLandscape ? 'blur(16px)' : undefined,
        borderTop: remoteBrain && isMobile ? '1px solid rgba(255,255,255,0.07)' : undefined,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        transition: 'left 0.3s ease, bottom 0.25s ease',
      }}>
        {/* ── "/" slash-command palette — same tool list as the Agents drawer, but
            reachable by typing "/" directly, matching Claude/OpenAI's completion UX. ── */}
        {slashResults.length > 0 && (
          <div style={{
            position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
            width: 'min(420px, calc(100% - 24px))', marginBottom: 6,
            background: 'rgba(18,18,24,0.96)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
            border: '1px solid rgba(255,255,255,0.09)', borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
            overflow: 'hidden', animation: 'panelUp 0.16s cubic-bezier(0.22,1,0.36,1)',
          }}>
            {slashResults.map((t, i) => (
              <div
                key={t.name}
                onClick={() => { setInput(`/${t.name} `); requestAnimationFrame(() => textareaRef.current?.focus()) }}
                style={{
                  padding: '9px 14px', cursor: 'pointer',
                  borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.05)',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                <div style={{ fontSize: 11.5, fontWeight: 600, color: '#d0d0e8', fontFamily: 'ui-monospace, monospace' }}>/{t.name}</div>
                <div style={{ fontSize: 10.5, color: '#8a8a9e', marginTop: 1, lineHeight: 1.4 }}>{t.description}</div>
              </div>
            ))}
          </div>
        )}
        {/* ── Active-model cards — above the chat bar, dynamic width ── */}
        {activeModels.length > 0 && (
          <div className="crucible-model-cards" style={{ display: 'flex', gap: 5, width: '100%', maxWidth: 680, marginBottom: 8, paddingLeft: 14, paddingRight: 10, boxSizing: 'border-box' }}>
            {activeModels.map(model => {
              const isDone       = latestRound ? latestRound.done[model.id] : false

              const isActive     = thinking && !isDone
              const collapsed    = isDone && !thinking  // compact after reply
              const score        = latestRound?.stage2Done ? latestRound.avgScores[model.id] : undefined
              return (
                <div key={model.id} style={{
                  flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' as const,
                  gap: collapsed ? 0 : 4,
                  padding: collapsed ? '4px 7px' : '8px 10px',
                  borderRadius: 10,
                  // Frosted opaque base (dark glass) so scrolling text behind the card can
                  // never bleed through and become unreadable — the model tint rides on top
                  // of a near-solid backdrop, and backdropFilter frosts anything in the gaps.
                  background: `linear-gradient(0deg, rgba(${model.rgb},${isActive ? 0.13 : collapsed ? 0.05 : 0.09}), rgba(${model.rgb},${isActive ? 0.13 : collapsed ? 0.05 : 0.09})), rgba(13,13,21,0.86)`,
                  backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
                  border: `1px solid ${isActive ? `rgba(${model.rgb},0.4)` : collapsed ? 'rgba(255,255,255,0.06)' : `rgba(${model.rgb},0.22)`}`,
                  boxShadow: isActive ? `0 0 14px rgba(${model.rgb},0.15)` : '0 2px 12px rgba(0,0,0,0.3)',
                  transition: 'all 0.4s ease',
                  overflow: 'hidden',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                    <span style={{
                      width: collapsed ? 5 : 6, height: collapsed ? 5 : 6,
                      borderRadius: '50%', flexShrink: 0,
                      background: isActive ? model.color : collapsed ? `rgba(${model.rgb},0.4)` : model.color,
                      boxShadow: isActive ? `0 0 8px ${model.color}` : 'none',
                      animation: isActive ? 'dotpulse 1.2s ease-in-out infinite' : 'none',
                      transition: 'all 0.3s',
                    }} />
                    <span style={{
                      fontSize: collapsed ? 9.5 : 11, fontWeight: 600, letterSpacing: '0.02em',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, flex: 1,
                      color: collapsed ? 'rgba(255,255,255,0.25)' : isActive ? '#e2e2ea' : model.color,
                      transition: 'all 0.3s',
                    }}>
                      {model.label}
                    </span>
                    {score !== undefined && (
                      <span style={{
                        fontSize: collapsed ? 8.5 : 9.5, fontWeight: 700, flexShrink: 0,
                        color: collapsed ? 'rgba(255,255,255,0.2)' : score >= 0.70 ? '#4db89e' : score >= 0.50 ? '#c084fc' : '#f87171',
                        transition: 'all 0.3s',
                      }}>{(score * 100).toFixed(0)}</span>
                    )}
                  </div>
                  {/* progress sliver — hide when collapsed */}
                  {!collapsed && (
                    <div style={{ height: 2, borderRadius: 2, background: 'rgba(255,255,255,0.05)', overflow: 'hidden', marginTop: 2 }}>
                      <div style={{
                        height: '100%', borderRadius: 2,
                        width: isDone ? '100%' : isActive ? '60%' : '0%',
                        background: model.color, opacity: 0.6,
                        transition: 'width 0.6s ease',
                      }} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {/* ── Per-query ensemble confirm — inline card above the composer (v3), not a modal ── */}
        {ensembleConfirm && !ensembleConfirm.noKeys && (
          <div style={{
            width: '100%', maxWidth: 680, marginBottom: 10, padding: '14px 16px', borderRadius: 16,
            background: 'rgba(124,124,248,0.07)', border: '1px solid rgba(124,124,248,0.25)',
            backdropFilter: 'blur(28px)', WebkitBackdropFilter: 'blur(28px)',
            display: 'flex', flexDirection: 'column', gap: 10, animation: 'slideUp 0.25s ease',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#7c7cf8', boxShadow: '0 0 8px rgba(124,124,248,0.7)' }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: '#c8c8f0' }}>Use ensemble for this?</span>
            </div>
            <span style={{ fontSize: 11.5, lineHeight: 1.55, color: '#8a8a9e' }}>
              This fans out to {Object.keys(ensemble.keys).length || ensemble.namedKeys.length} external endpoint{(Object.keys(ensemble.keys).length || ensemble.namedKeys.length) === 1 ? '' : 's'} using your API keys, then cross-examines the drafts. Nothing leaves this device otherwise.
            </span>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  const pending = ensembleConfirm.message
                  setEnsembleConfirm(null)
                  setMode('code')
                  if (pending) void send(pending, 'code')
                }}
                style={{ padding: '6px 14px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: '#b8b8cc', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
              >Crucible only</button>
              <button
                onClick={() => {
                  const pending = ensembleConfirm.message
                  setEnsembleConfirm(null)
                  if (pending) void send(pending, 'quorum', true)
                }}
                style={{ padding: '6px 14px', borderRadius: 999, border: '1px solid rgba(124,124,248,0.4)', background: 'rgba(124,124,248,0.15)', color: '#b0b0ff', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
              >Run ensemble</button>
            </div>
          </div>
        )}
        {ensembleConfirm?.noKeys && (
          <div style={{
            width: '100%', maxWidth: 680, marginBottom: 10, padding: '14px 16px', borderRadius: 16,
            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
            backdropFilter: 'blur(28px)', WebkitBackdropFilter: 'blur(28px)',
            display: 'flex', alignItems: 'center', gap: 12, animation: 'slideUp 0.25s ease',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#d8d8e8' }}>Ensemble needs your own API keys</span>
              <span style={{ fontSize: 11.5, color: '#8a8a9e' }}>No endpoints configured. Add keys in Settings — Crucible ships with zero external calls.</span>
            </div>
            <button
              onClick={() => {
                const pending = ensembleConfirm.message
                setEnsembleConfirm(null)
                setMode('code')
                if (pending) void send(pending, 'code')
              }}
              style={{ padding: '6px 14px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: '#b8b8cc', fontSize: 11, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}
            >Crucible only</button>
            <button
              onClick={() => { setEnsembleConfirm(null); setTab('settings') }}
              style={{ padding: '6px 14px', borderRadius: 999, border: '1px solid rgba(124,124,248,0.4)', background: 'rgba(124,124,248,0.15)', color: '#b0b0ff', fontSize: 11, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}
            >Add keys</button>
          </div>
        )}

        <div className="crucible-inputbox" style={{
          display: 'flex', flexDirection: 'column',
          background: 'rgba(255,255,255,0.045)',
          border: '1px solid rgba(255,255,255,0.09)',
          borderRadius: 20, padding: '12px 12px 10px 14px',
          width: '100%', maxWidth: 680,
          backdropFilter: 'blur(32px)', WebkitBackdropFilter: 'blur(32px)',
          boxShadow: '0 8px 40px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06)',
          position: 'relative',
        }}>
          {showMinLengthTip && (
            <div style={{
              position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
              marginBottom: 8, padding: '6px 12px', borderRadius: 8,
              background: 'rgba(30,30,40,0.95)', border: '1px solid rgba(255,255,255,0.08)',
              fontSize: 11, color: 'rgba(255,255,255,0.5)', whiteSpace: 'nowrap' as const,
              pointerEvents: 'none' as const, animation: 'fadeIn 0.2s',
            }}>
              Type at least 4 characters to send
            </div>
          )}
          {/* ── Row 1: crucible glyph + textarea + send ── */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <svg width="20" height="20" viewBox="0 0 48 48" fill="none" style={{ flexShrink: 0, opacity: 0.4 }}>
              <path d="M10 14h28M10 14l6 22M38 14l-6 22M16 36q8 8 16 0" stroke="#e4e4ee" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKey}
              placeholder="Message Crucible"
              rows={1}
              className="crucible-textarea"
              style={{
                flex: 1, background: 'none', border: 'none', color: '#e4e4ee',
                fontSize: 13.5, resize: 'none', outline: 'none', fontFamily: 'inherit',
                lineHeight: 1.5, maxHeight: 160, overflowY: 'auto',
                userSelect: 'text', paddingBottom: 2,
              }}
            />
            <button
              className="crucible-send-btn"
              onClick={thinking ? stop : () => send()}
              disabled={!thinking && input.trim().length < 4}
              title={thinking ? 'Stop' : 'Send'}
              style={{
                width: 32, height: 32, borderRadius: '50%', border: 'none',
                background: thinking ? 'rgba(255,110,26,0.12)' : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, cursor: (thinking || input.trim().length >= 4) ? 'pointer' : 'default',
                opacity: (thinking || input.trim().length >= 4) ? 1 : 0.35,
                outline: `1px solid ${thinking ? 'rgba(255,110,26,0.4)' : 'rgba(255,255,255,0.09)'}`,
                transition: 'background 0.3s, opacity 0.3s',
              }}
            >
              {thinking ? (
                <span style={{ width: 9, height: 9, borderRadius: 2, background: '#ff8a3d' }} />
              ) : (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M7 11V3M3.5 6.5L7 3L10.5 6.5" stroke={input.trim().length >= 4 ? '#9d9dfa' : '#55556a'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>

          {/* ── Row 2: (+) expander → Ensemble / Models / Remote Brain bubbles ──
              Previously the Ensemble pill sat here permanently, taking up chat-bar
              real estate at all times for a feature most turns don't touch. Now a
              small nested (+) toggle reveals the same actions (plus a Models entry
              that jumps to the local-model picker in Settings) as a slide-out row,
              and rotates into an "×" while open. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0 0 32px' }}>
            <button
              onClick={() => setComposerExpandOpen(o => !o)}
              title={composerExpandOpen ? 'Close' : 'More: Ensemble, Models, Remote Brain'}
              aria-expanded={composerExpandOpen}
              style={{
                width: 22, height: 22, borderRadius: '50%', flexShrink: 0, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: `1px solid ${composerExpandOpen ? 'rgba(124,124,248,0.4)' : 'rgba(255,255,255,0.09)'}`,
                background: composerExpandOpen ? 'rgba(124,124,248,0.14)' : 'rgba(255,255,255,0.04)',
                transition: 'background 0.2s, border-color 0.2s, transform 0.22s cubic-bezier(0.22,1,0.36,1)',
                transform: composerExpandOpen ? 'rotate(45deg)' : 'none',
              }}
            >
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path d="M5.5 1v9M1 5.5h9" stroke={composerExpandOpen ? '#b0b0f8' : '#77778c'} strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>

            {composerExpandOpen && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, animation: 'panelUp 0.18s cubic-bezier(0.22,1,0.36,1)' }}>
                <button
                  onClick={() => {
                    if (mode === 'quorum') { setMode('code'); ensemble.setOn(false); return }
                    if (!ensemble.hasAnyKey) { setTab('settings'); return }
                    setMode('quorum'); ensemble.setOn(true)
                  }}
                  title={ensemble.hasAnyKey ? 'Ensemble — external multi-model pipeline on your own API keys' : 'Ensemble needs your own API keys — opens Settings'}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
                    border: `1px solid ${mode === 'quorum' ? 'rgba(124,124,248,0.4)' : 'rgba(255,255,255,0.07)'}`,
                    background: mode === 'quorum' ? 'rgba(124,124,248,0.12)' : 'transparent',
                    transition: 'background 0.2s, border-color 0.2s',
                  }}
                >
                  <span style={{
                    width: 5, height: 5, borderRadius: '50%',
                    background: mode === 'quorum' ? '#7c7cf8' : '#3a3a4c',
                    boxShadow: mode === 'quorum' ? '0 0 6px rgba(124,124,248,0.6)' : 'none',
                  }} />
                  <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', color: mode === 'quorum' ? '#9d9dfa' : '#55556a' }}>
                    Ensemble
                  </span>
                </button>

                <button
                  onClick={() => { setComposerExpandOpen(false); setTab('settings') }}
                  title="Pick which downloaded local model handles this chat"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
                    border: '1px solid rgba(255,255,255,0.07)', background: 'transparent',
                    fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', color: '#55556a',
                    transition: 'background 0.2s, border-color 0.2s',
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <circle cx="5" cy="5" r="3.6" stroke="currentColor" strokeWidth="1.2" />
                    <circle cx="5" cy="5" r="1" fill="currentColor" />
                  </svg>
                  Models
                </button>

                {/* Step 9: Remote Brain — phone only */}
                {isMobile && (
                  <button
                    onClick={() => { setComposerExpandOpen(false); setRemoteBrain(r => !r) }}
                    title="Remote Brain — control your Mac from this phone"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      padding: '4px 9px', borderRadius: 8, border: 'none', cursor: 'pointer',
                      background: remoteBrain ? 'rgba(124,124,248,0.18)' : 'rgba(255,255,255,0.05)',
                      color: remoteBrain ? '#a5a5ff' : 'rgba(255,255,255,0.45)',
                      fontSize: 10, fontWeight: 600, letterSpacing: '0.05em',
                      transition: 'background 0.2s, color 0.2s',
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                      <rect x="1" y="1" width="9" height="6.5" rx="1.2" stroke="currentColor" strokeWidth="1.2"/>
                      <path d="M3.5 10h4M5.5 7.5V10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                    </svg>
                    Brain
                  </button>
                )}
              </div>
            )}

            <div style={{ flex: 1 }} />
            {mode === 'quorum' && (
              <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '0.05em', color: '#7c7cf8' }}>ENSEMBLE ON</span>
            )}
          </div>
        </div>
      </div>
      </>
        </div>
      </div>
    </div>
  )
}

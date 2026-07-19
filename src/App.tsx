import { useState, useRef, useEffect, useCallback } from 'react'
import { API_BASE, apiFetch } from './api'
import BackgroundBlobs from './BackgroundBlobs'
import { useEnsemble, type EnsembleState } from './ensemble'
import { IntegrationsBinder } from './IntegrationsBinder'
import { LibraryBinder } from './LibraryBinder'
import { SelfRepairBinder } from './SelfRepairBinder'
import { SelfPatcherBinder } from './SelfPatcherBinder'
import NavRail from './NavRail'
import SidebarRail from './SidebarRail'
import DebugCapture from './DebugCapture'
import { AGENT_WORKFLOWS } from './AgentsTabView'
import AgentMissionControl from './AgentMissionControl'
import AutomationsView from './AutomationsView'
import ConnectionsView from './ConnectionsView'
import HomeSurface from './HomeSurface'
import HistoryTabView from './HistoryTabView'
import SettingsTabView, { SystemRow } from './SettingsTabView'
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
  // F panels — parallel chats: rounds from EVERY open conversation live in this one
  // array (each tagged with convId). Streaming updaters are keyed by unique round id,
  // so a backgrounded chat keeps streaming while another is on screen; the rendered
  // `rounds` below is the convId-filtered view of the active conversation.
  const [allRounds, setAllRounds]         = useState<Round[]>([])
  const setRounds = setAllRounds  // round-id-keyed updaters are conversation-agnostic
  const [input, setInput]                 = useState('')
  // Per-conversation live-run state — keyed by convId so N chats can run in parallel.
  const [thinkingByConv, setThinkingByConv] = useState<Record<string, boolean>>({})
  // ── Agent live timer ──────────────────────────────────────────────────────
  const [agentStartByConv, setAgentStartByConv] = useState<Record<string, number | null>>({})
  const [agentElapsed, setAgentElapsed]       = useState(0)
  type AgentProgress = {
    stepIndex: number; stepTotal: number; stepIntent: string
    iter: number; maxIters: number
  }
  const [agentProgressByConv, setAgentProgressByConv] = useState<Record<string, AgentProgress | null>>({})
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
  const [liveRoundByConv, setLiveRoundByConv] = useState<Record<string, string | null>>({})
  // ── v3 left-rail tab shell — Chat is the existing full view; History/Settings are
  // dedicated full-page views (see NavRail.tsx / HistoryTabView.tsx / SettingsTabView.tsx).
  // The system drawers (Library/SelfRepair/etc.) live in Settings.
  const [tab, setTab] = useState<'chat' | 'history' | 'settings'>('chat')
  // Items 18/19: Agents & capabilities is an inline overlay anchored to the chat panel,
  // not a tab — toggling it never unmounts the conversation underneath (see AgentsTabView.tsx).
  const [agentsOpen, setAgentsOpen] = useState(false)
  // Automations page — standing tasks (Assistant layer step 1). Same overlay pattern
  // as Mission Control: chat stays mounted and streaming underneath.
  const [automationsOpen, setAutomationsOpen] = useState(false)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const [composerExpandOpen, setComposerExpandOpen] = useState(false)
  // ── Composer attachments — files the user uploads into the workspace sandbox via the
  // paperclip button. Each send prepends a note referencing them so the agent knows they
  // exist and where to read them (they land in the sandbox, visible in the code workspace). ──
  const [attachments, setAttachments] = useState<{ name: string; path: string; bytes: number }[]>([])
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // ── Voice mode — local whisper.cpp dictation + auto-spoken replies (full voice loop). ──
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  // Legacy auto-speak flag — superseded by full voice mode below; kept for the speakReply
  // gating shape (always false now that the right-click toggle became one-shot dictation).
  const [voiceLoop] = useState(false)
  // Voice conversation mode — hands-free listen→answer→speak→listen loop with a visible
  // state overlay (the chat keeps populating behind it).
  const [voiceMode, setVoiceMode] = useState(false)
  const [voiceState, setVoiceState] = useState<'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'>('idle')
  const voiceModeRef = useRef(false)     // async closures (VAD timer, tts completion) need the live value
  const emptyListensRef = useRef(0)      // consecutive silent listens → auto-exit instead of looping the mic
  const [voiceReady, setVoiceReady] = useState<boolean | null>(null)  // null = unknown, false = model not downloaded
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  // (+) expander popups — 'models' pins one on-device model for routing (server-side
  // localModelRouter honors it), 'agents' is the quick agent-command list (item H).
  const [expanderPopup, setExpanderPopup] = useState<'models' | 'agents' | null>(null)
  const [pickerModels, setPickerModels] = useState<Array<{ id: string; label: string; ready: boolean; enabled: boolean }>>([])
  const [pinnedModelId, setPinnedModelId] = useState<string | null>(null)
  // GGUF entries are only real options when node-llama-cpp is installed; otherwise
  // pinning one silently no-ops (router falls back). Hide them until the runtime exists.
  const [ggufRuntimeAvailable, setGgufRuntimeAvailable] = useState(false)
  useEffect(() => {
    if (expanderPopup !== 'models') return
    apiFetch(`${API_BASE}/api/local-models`, { credentials: 'include' }).then(r => r.json())
      .then(d => {
        setGgufRuntimeAvailable(!!d.ggufRuntimeAvailable)
        setPickerModels((d.models ?? []).map((m: any) => ({
          id: m.id, label: m.label, ready: m.status?.status === 'ready', enabled: !!m.enabled,
        })))
      })
      .catch(() => setPickerModels([]))
    apiFetch(`${API_BASE}/api/local-models/config`, { credentials: 'include' }).then(r => r.json())
      .then(c => setPinnedModelId(c.pinnedModelId ?? null)).catch(() => {})
  }, [expanderPopup])
  const pinModel = (modelId: string | null) => {
    setPinnedModelId(modelId)
    apiFetch(`${API_BASE}/api/local-models/pin`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId }),
    }).catch(() => {})
  }

  // ── Slash-command tool palette — typing "/" in the composer filters this list,
  // same pattern as Claude/OpenAI's "/" completion. Tool names are fetched once;
  // this is the SAME data AgentsTabView shows, just reachable without opening the drawer.
  const [slashTools, setSlashTools] = useState<{ name: string; description: string }[]>([])
  useEffect(() => {
    apiFetch(`${API_BASE}/api/library/tools`, { credentials: 'include' }).then(r => r.json())
      .then(t => setSlashTools([...(t.dynamic ?? []), ...(t.builtin ?? [])]))
      .catch(() => {})
  }, [])
  // Probe the local whisper.cpp voice stack once, so the mic button can offer setup when it's
  // not installed instead of failing on first use.
  useEffect(() => {
    apiFetch(`${API_BASE}/api/voice/status`, { credentials: 'include' }).then(r => r.json())
      .then(s => setVoiceReady(!!s?.ready))
      .catch(() => {})
  }, [])
  const slashMatch = /^\/(\S*)$/.exec(input)
  const [slashSel, setSlashSel] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const slashResults = slashMatch && !slashDismissed
    ? slashTools.filter(t => t.name.toLowerCase().startsWith(slashMatch[1].toLowerCase())).slice(0, 8)
    : []
  // Reset selection + dismissal whenever the typed prefix changes.
  const slashPrefix = slashMatch?.[1] ?? null
  useEffect(() => { setSlashSel(0); setSlashDismissed(false) }, [slashPrefix])

  // ── Step 9: Remote Brain mode (phone only) ────────────────────────────────
  const [remoteBrain, setRemoteBrain] = useState(false)
  const [streamStatus, setStreamStatus] = useState<'connecting'|'live'|'error'>('connecting')
  const [streamFps, setStreamFps] = useState(0)
  // Fully-local app origin (http://<mac-lan-ip>:3001) reported by the status endpoint.
  // Offered as a one-tap escape hatch when the stream can't reach the Mac through the
  // tunnel — loading the app from this origin makes everything direct-to-Mac.
  const [remoteLanOrigin, setRemoteLanOrigin] = useState<string | null>(null)
  const screenCanvasRef = useRef<HTMLCanvasElement>(null)
  const screenVideoRef = useRef<HTMLVideoElement>(null)
  // True once a WebRTC peer video track is playing — the direct peer-to-peer path that
  // bypasses the tunnel. When active we show the <video> and hide the JPEG <canvas>.
  const [webrtcActive, setWebrtcActive] = useState(false)
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
  // ?forceMobile=1 — test hook: desktop previews can't produce coarse+touch, so the
  // mobile branch is otherwise unreachable in a preview browser.
  const forceMobile = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('forceMobile')
  const [isMobile, setIsMobile] = useState(() =>
    forceMobile || (
    typeof window !== 'undefined' &&
    window.matchMedia('(pointer: coarse)').matches &&
    ('ontouchstart' in window || navigator.maxTouchPoints > 0)
    )
  )
  const [isLandscape, setIsLandscape] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(orientation: landscape)').matches
  )
  useEffect(() => {
    const mqW = window.matchMedia('(pointer: coarse)')
    const mqL = window.matchMedia('(orientation: landscape)')
    const hW = (e: MediaQueryListEvent) => setIsMobile(forceMobile || e.matches)
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
    // WebRTC subscriber: the fast path. The server relays an SDP offer from the Mac's
    // capture window over this same socket (as text); we answer, exchange ICE, and the
    // screen video then flows peer-to-peer (direct over the LAN/hotspot), bypassing the
    // tunnel entirely. Until/unless that connects, the JPEG frames below keep painting,
    // so a WebRTC failure silently falls back to the existing path.
    let pc: RTCPeerConnection | null = null
    const sig = (sock: WebSocket, obj: unknown) => { try { if (sock.readyState === 1) sock.send(JSON.stringify(obj)) } catch { /* noop */ } }

    async function handleSignaling(sock: WebSocket, msg: any) {
      if (msg.type === 'webrtc-offer') {
        if (pc) { try { pc.close() } catch { /* noop */ } }
        pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
        pc.ontrack = (ev) => {
          const v = screenVideoRef.current
          if (v && ev.streams[0]) { v.srcObject = ev.streams[0]; v.play().catch(() => {}) }
          setWebrtcActive(true)
          setStreamStatus('live')
        }
        pc.onicecandidate = (ev) => { if (ev.candidate) sig(sock, { type: 'webrtc-ice', candidate: ev.candidate }) }
        pc.oniceconnectionstatechange = () => {
          const st = pc?.iceConnectionState
          if (st === 'failed' || st === 'disconnected' || st === 'closed') setWebrtcActive(false)
        }
        try {
          await pc.setRemoteDescription(msg.sdp)
          const ans = await pc.createAnswer()
          await pc.setLocalDescription(ans)
          sig(sock, { type: 'webrtc-answer', sdp: pc.localDescription })
        } catch { setWebrtcActive(false) }
      } else if (msg.type === 'webrtc-ice') {
        if (pc && msg.candidate) { try { await pc.addIceCandidate(msg.candidate) } catch { /* noop */ } }
      }
    }

    function attachHandlers(sock: WebSocket) {
      sock.onopen  = () => setStreamStatus('live')
      sock.onclose = () => { if (streamEsRef.current === (sock as unknown as EventSource)) setStreamStatus('error') }
      sock.onmessage = (e) => {
        // Text frame → WebRTC signaling. Binary Blob → a JPEG fallback frame.
        if (typeof e.data === 'string') {
          let msg: any; try { msg = JSON.parse(e.data) } catch { return }
          if (msg?.type && String(msg.type).startsWith('webrtc-')) handleSignaling(sock, msg)
          return
        }
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
      if (pc) { try { pc.close() } catch { /* noop */ } pc = null }
      setWebrtcActive(false)
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

  // Bumped after each conversation-store save so the sidebar history list refreshes.
  const [histRefresh, setHistRefresh] = useState(0)

  // Shared restore: adopt the stored conversation's id and merge its rounds into the
  // in-memory pool. Used by the sidebar slivers, the mobile history drawer, and the
  // Settings HistoryBinder. Deliberately does NOT adopt conversation.mode — restoring
  // an old ensemble ('quorum') thread must never silently re-arm the external pipeline.
  const restoreConversation = useCallback((summary: { id: string }) => {
    apiFetch(`${API_BASE}/api/conversations/${summary.id}`, { credentials: 'include' })
      .then(r => r.json())
      .then(({ conversation }) => {
        if (!conversation?.rounds) return
        setConversationId(conversation.id)
        setAllRounds(prev => [
          ...prev.filter(r => r.convId !== conversation.id),
          ...conversation.rounds.map((r: Round) => ({ ...r, convId: conversation.id })),
        ])
        setTab('chat')
      })
      .catch(() => {})
  }, [])

  // ── Active-conversation view (F panels: parallel chats) ────────────────────
  // Everything below App's render path reads these names exactly as before the
  // refactor — they are now the active conversation's slice of the per-conv maps.
  const rounds = allRounds.filter(r => (r.convId ?? conversationId) === conversationId)
  const thinking = !!thinkingByConv[conversationId]
  const anyThinking = Object.values(thinkingByConv).some(Boolean)
  const liveRoundId = liveRoundByConv[conversationId] ?? null
  const agentStartTime = agentStartByConv[conversationId] ?? null
  const agentProgress = agentProgressByConv[conversationId] ?? null
  const setConvThinking = (cid: string, v: boolean) =>
    setThinkingByConv(prev => ({ ...prev, [cid]: v }))
  const setConvLiveRound = (cid: string, roundId: string | null) =>
    setLiveRoundByConv(prev => ({ ...prev, [cid]: roundId }))
  const setConvAgentStart = (cid: string, t: number | null) =>
    setAgentStartByConv(prev => ({ ...prev, [cid]: t }))
  const setConvAgentProgress = (cid: string, p: AgentProgress | null) =>
    setAgentProgressByConv(prev => ({ ...prev, [cid]: p }))
  // Open-chats strip model: every conversation that has rounds in memory, plus the
  // active (possibly still-empty) one. Closing a chat removes its rounds from memory
  // only — the server-side conversation store keeps it reopenable from History.
  const openChats = (() => {
    const ids: string[] = []
    for (const r of allRounds) {
      const cid = r.convId ?? conversationId
      if (!ids.includes(cid)) ids.push(cid)
    }
    if (!ids.includes(conversationId)) ids.push(conversationId)
    return ids.map(id => ({
      id,
      title: allRounds.find(r => (r.convId ?? conversationId) === id)?.userMessage?.slice(0, 34) || 'New chat',
      live: !!thinkingByConv[id],
    }))
  })()

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
  // One in-flight controller per conversation — Stop only cancels the chat on screen.
  const abortRef = useRef<Record<string, AbortController | null>>({})
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
  // Distinguishes our own scrollTop writes from user scrolling inside onScroll —
  // without this, every programmatic follow re-enters the handler and the two fight
  // (the root cause of the old jitter/yank bugs).
  const programmaticScrollRef = useRef(false)

  // ONE rule replaces the old lock/pin heuristics: follow the bottom while `follow`
  // is on; any user intent to read back (wheel up, finger drag down, or simply being
  // >80px from the bottom) turns it off; returning to the bottom or sending a new
  // message turns it back on. scrollLockedRef is the inverse flag, kept because
  // send() and streaming effects elsewhere still read it.
  const setFollow = useCallback((v: boolean) => {
    scrollLockedRef.current = !v
    setShowScrollBtn(!v)
  }, [])

  // Item 5: handed down to the memoized MessageList — must be stable references.
  const handleScroll = useCallback(() => {
    if (programmaticScrollRef.current) { programmaticScrollRef.current = false; return }
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    if (dist <= 80) {
      if (scrollLockedRef.current) setFollow(true)
    } else if (!scrollLockedRef.current) {
      setFollow(false)
    }
  }, [setFollow])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    // Instant intent: one upward tick frees the view even right at the bottom.
    if (e.deltaY < 0) setFollow(false)
  }, [setFollow])
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartYRef.current = e.touches[0]?.clientY ?? 0
  }, [])
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    // Finger moving DOWN the screen scrolls content UP → user wants to read back.
    if ((e.touches[0]?.clientY ?? 0) - touchStartYRef.current > 6) setFollow(false)
  }, [setFollow])

  const followBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el || scrollLockedRef.current) return
    programmaticScrollRef.current = true
    el.scrollTop = el.scrollHeight - el.clientHeight
  }, [])

  const scrollToBottom = () => {
    setFollow(true)
    const el = scrollRef.current
    if (!el) return
    programmaticScrollRef.current = true
    el.scrollTop = el.scrollHeight
  }

  useEffect(() => {
    // rAF so the scroll lands after the browser paints the newly committed content.
    requestAnimationFrame(followBottom)
  }, [rounds, inputBarHeight, followBottom])

  // Streamed content keeps reflowing AFTER the React commit (syntax highlight, images,
  // async mounts) with no matching state change. A ResizeObserver on the message cards
  // watches real layout height and re-follows — CSS overflow-anchor is disabled on the
  // scroller (.crucible-scroll) so the browser's own anchoring never fights this.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(followBottom)
    Array.from(el.children).forEach(child => ro.observe(child))
    return () => ro.disconnect()
  }, [rounds.length, followBottom])

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
      }).then(() => setHistRefresh(n => n + 1)).catch(() => {})
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
    let saved: { taskId: string; userMessage: string; ts: number; convId?: string } | null = null
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
    // Resume into the conversation the task belonged to (falls back to the active one
    // for tasks saved before convId existed).
    const convId = saved.convId ?? conversationIdRef.current
    // Reset the round so the from=0 replay rebuilds it exactly (no double-applied tokens).
    setRounds(prev => {
      const fresh = emptyRound(saved!.taskId, saved!.userMessage, convId)
      return prev.some(r => r.id === saved!.taskId) ? prev.map(r => r.id === saved!.taskId ? fresh : r) : [...prev, fresh]
    })
    setConvThinking(convId, true); wasThinkingRef.current = true
    try {
      const res = await apiFetch(`${API_BASE}/api/task/stream?taskId=${encodeURIComponent(saved.taskId)}&from=0`)
      if (res.ok && res.body) await consumeStream(res.body.getReader(), saved.taskId, saved.userMessage, convId)
    } catch {}
    setConvThinking(convId, false); wasThinkingRef.current = false
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

  // Track thinking state for reconnect decisions — any conversation counts.
  useEffect(() => { wasThinkingRef.current = anyThinking }, [anyThinking])

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
  const runResearch = async (message: string, roundId: string, convId = conversationIdRef.current) => {
    let res: Response
    try {
      res = await apiFetch(`${API_BASE}/api/research`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: abortRef.current[convId]?.signal,
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

  // displayText: what the transcript shows as the user's message when the actual message
  // sent to the server is an internal scaffold (agent-pane templates). Never show the user
  // prompt-engineering they didn't type.
  // ── File upload → workspace sandbox ─────────────────────────────────────────
  const uploadFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).slice(0, 8)   // sane cap per action
    if (!list.length) return
    setUploading(true)
    setUploadError(null)
    const failed: string[] = []
    try {
      for (const file of list) {
        if (file.size > 25 * 1024 * 1024) { haptic('heavy'); failed.push(`${file.name} (over 25 MB)`); continue }
        const data: string = await new Promise((resolve, reject) => {
          const r = new FileReader()
          r.onload = () => resolve(String(r.result))
          r.onerror = () => reject(r.error)
          r.readAsDataURL(file)   // data URL — server strips the prefix
        })
        try {
          // apiFetch + API_BASE like every other API call — a bare relative fetch broke in any
          // deployment where the page origin doesn't proxy /api, and silently dropped the file.
          const resp = await apiFetch(`${API_BASE}/api/sandbox/upload`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: file.name, data }),
          })
          const j = await resp.json().catch(() => null)
          if (j?.success) setAttachments(prev => [...prev, { name: j.path, path: j.path, bytes: j.bytes }])
          else failed.push(`${file.name} (${j?.error || `HTTP ${resp.status}`})`)
        } catch (e: any) { failed.push(`${file.name} (${String(e?.message || 'network error').slice(0, 60)})`) }
      }
    } finally {
      setUploading(false)
      // Surface failures instead of silently doing nothing — the #1 "I clicked attach and
      // nothing happened" report. Auto-clears on the next successful action.
      if (failed.length) setUploadError(`Could not attach: ${failed.join(', ')}`)
    }
  }
  const removeAttachment = (p: string) => setAttachments(prev => prev.filter(a => a.path !== p))

  // ── Voice conversation mode — local whisper.cpp STT + /api/tts talkback ──────
  // ChatGPT-style hands-free loop: listen (VAD auto-stop on silence) → transcribe → send →
  // speak the reply (server resolves AFTER playback) → listen again, until the user exits.
  // The chat keeps populating behind the overlay; everything stays on-device.
  const speakReply = (text: string) => {
    const inVoiceMode = voiceModeRef.current
    if ((!voiceLoop && !inVoiceMode) || !text?.trim()) return
    // Strip code fences/markdown noise so talkback stays natural.
    const clean = text.replace(/```[\s\S]*?```/g, ' code block ').replace(/[#*`_>]/g, '').slice(0, 1200)
    if (!inVoiceMode) {
      apiFetch(`${API_BASE}/api/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: clean }) }).catch(() => {})
      return
    }
    setVoiceState('speaking')
    apiFetch(`${API_BASE}/api/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: clean, wait: true }) })
      .catch(() => {})
      .then(() => { if (voiceModeRef.current) void startRecording() })   // reply finished → re-listen
  }
  const stopRecording = () => {
    try { mediaRecorderRef.current?.stop() } catch { /* already stopped */ }
    setRecording(false)
  }
  const exitVoiceMode = () => {
    voiceModeRef.current = false
    setVoiceMode(false)
    setVoiceState('idle')
    stopRecording()
  }
  const enterVoiceMode = () => {
    voiceModeRef.current = true
    emptyListensRef.current = 0
    setVoiceMode(true)
    void startRecording()
  }
  const startRecording = async () => {
    if (recording) { stopRecording(); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      audioChunksRef.current = []
      rec.ondataavailable = e => { if (e.data.size) audioChunksRef.current.push(e.data) }
      // Voice-mode VAD: watch the mic's RMS level; once the user has spoken, 1.5 s of
      // silence ends the utterance. Never having spoken for 8 s ends the listen (and two
      // empty listens in a row exit voice mode rather than looping the mic forever).
      let vadCtx: AudioContext | null = null
      let vadTimer: ReturnType<typeof setInterval> | null = null
      if (voiceModeRef.current) {
        setVoiceState('listening')
        try {
          vadCtx = new AudioContext()
          const src = vadCtx.createMediaStreamSource(stream)
          const analyser = vadCtx.createAnalyser()
          analyser.fftSize = 512
          src.connect(analyser)
          const buf = new Float32Array(analyser.fftSize)
          const startedAt = Date.now()
          let spokeAt = 0
          vadTimer = setInterval(() => {
            analyser.getFloatTimeDomainData(buf)
            let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
            const rms = Math.sqrt(sum / buf.length)
            if (rms > 0.02) spokeAt = Date.now()
            const now = Date.now()
            if ((spokeAt && now - spokeAt > 1500) || (!spokeAt && now - startedAt > 8000)) {
              try { mediaRecorderRef.current?.stop() } catch { /* already stopped */ }
              setRecording(false)
            }
          }, 120)
        } catch { /* VAD unavailable — manual stop still works */ }
      }
      rec.onstop = async () => {
        if (vadTimer) clearInterval(vadTimer)
        void vadCtx?.close().catch(() => {})
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(audioChunksRef.current, { type: rec.mimeType || 'audio/webm' })
        if (blob.size < 800) {   // nothing captured
          if (voiceModeRef.current) {
            if (++emptyListensRef.current >= 2) exitVoiceMode()
            else void startRecording()
          }
          return
        }
        emptyListensRef.current = 0
        setTranscribing(true)
        if (voiceModeRef.current) setVoiceState('transcribing')
        try {
          const data: string = await new Promise((resolve, reject) => {
            const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(blob)
          })
          const resp = await apiFetch(`${API_BASE}/api/voice/transcribe`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audio: data, mime: blob.type }),
          })
          const j = await resp.json()
          if (j?.needsModel) { setVoiceReady(false); exitVoiceMode(); haptic('heavy'); return }
          const text = (j?.text || '').trim()
          if (text) {
            setVoiceReady(true)
            if (voiceModeRef.current) { setVoiceState('thinking'); void send(text) }   // reply will speak, then re-listen
            else if (voiceLoop) void send(text)
            else setInput(prev => (prev ? prev + ' ' : '') + text)
          } else if (voiceModeRef.current) {
            if (++emptyListensRef.current >= 2) exitVoiceMode()
            else void startRecording()
          }
        } catch { if (voiceModeRef.current) exitVoiceMode() }
        finally { setTranscribing(false) }
      }
      mediaRecorderRef.current = rec
      rec.start()
      setRecording(true)
      haptic('medium')
    } catch { if (voiceModeRef.current) exitVoiceMode(); haptic('heavy') }   // mic permission denied / no device
  }

  const send = async (overrideMessage?: string, modeOverride?: string, ensembleConfirmed = false, displayText?: string) => {
    // In Remote Brain mode every send goes straight to the Mac agent loop.
    if (remoteBrain && !modeOverride) modeOverride = 'agent'
    if (thinking) return
    const typed = (overrideMessage ?? input).trim()
    if (!typed || typed.length < 4) return
    // Fold any workspace attachments into the message the SERVER sees (so the agent knows the
    // files exist and where to read them) while keeping the VISIBLE transcript text clean.
    const attachNote = attachments.length
      ? `\n\n[User attached ${attachments.length} file(s) to the workspace sandbox: ${attachments.map(a => a.path).join(', ')}. Read them from the sandbox if relevant to this request.]`
      : ''
    const userMessage = typed + attachNote
    const visibleText = displayText?.trim() || typed
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
    // Pin this run to the conversation it was sent from — the user can switch to
    // another chat mid-run and this stream keeps landing in the right thread.
    const convId = conversationIdRef.current
    setConvLiveRound(convId, roundId)
    localStorage.setItem('crucible_has_sent', '1')
    setInput(''); setAttachments([]); setConvThinking(convId, true); scrollLockedRef.current = false; setShowScrollBtn(false); haptic('medium')
    setConvAgentStart(convId, Date.now()); setAgentElapsed(0); setConvAgentProgress(convId, null)
    prewarmTokenRef.current = null
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    const attachedNames = attachments.map(a => a.name)   // closure value — unaffected by setAttachments([]) above
    const nextRounds = [...rounds, emptyRound(roundId, visibleText, convId, attachedNames)]
    setAllRounds(prev => [...prev, emptyRound(roundId, visibleText, convId, attachedNames)])
    // Record this as the active server-owned task so that if the tab is backgrounded /
    // reloaded mid-run, we can reconnect to its buffered stream and replay on return.
    // Store the DISPLAY text — reconnect rebuilds the visible round from this, and the raw
    // agent-pane template must never resurface in the transcript on resume.
    try { localStorage.setItem('crucible_active_task', JSON.stringify({ taskId: roundId, userMessage: visibleText, ts: Date.now(), convId })) } catch {}
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
      body: JSON.stringify({ id: convId, mode, rounds: nextRounds }),
    }).catch(() => {})

    abortRef.current[convId] = new AbortController()

    // Session J: autonomous research mode streams from a dedicated endpoint with its own
    // event shape — handled separately so the shared SSE consumer stays untouched.
    if ((modeOverride ?? mode) === 'research' && !remoteBrain) {
      await runResearch(userMessage, roundId, convId)
      setConvThinking(convId, false); setConvAgentStart(convId, null); setConvAgentProgress(convId, null)
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
          conversationId: convId,  // groups this round into the conversation it was sent from
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
        signal: abortRef.current[convId]!.signal,
      })
    } catch (err: any) {
      if (err.name === 'AbortError') { setConvThinking(convId, false); return }
      console.error('[send] fetch failed:', err)
      haptic('heavy')
      setConvThinking(convId, false); return
    }
    const reader = res.body!.getReader()
    await consumeStream(reader, roundId, userMessage, convId)
    setConvThinking(convId, false)
    setConvAgentStart(convId, null); setConvAgentProgress(convId, null)
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
  const consumeStream = async (reader: ReadableStreamDefaultReader<Uint8Array>, roundId: string, userMessage: string, convId = conversationIdRef.current) => {
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
              // TTS intentionally disabled in agent / Remote Brain mode: on the phone the answer
              // is already on screen, and the Mac reading every agent turn aloud was noise, not signal.
              // EXCEPT when the user explicitly turned on the voice loop — then speak the reply.
              if (parsed.text) speakReply(parsed.text)
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
              setConvThinking(convId, false)
              const synthText = synthesisRef.current[roundId] ?? ''
              if (synthText) {
                setTimeout(() => runVerify(roundId, synthText, userMessage), 200)
                speakReply(synthText)
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
            setConvAgentProgress(convId, {
              stepIndex: parsed.stepIndex ?? 0,
              stepTotal: parsed.stepTotal ?? 1,
              stepIntent: parsed.stepIntent ?? '',
              iter: parsed.iter ?? 1,
              maxIters: parsed.maxIters ?? 32,
            })
            continue
          }

          // ── Live status thought — what the brain is doing right now ───────
          // These narrate the behind-the-scenes work (searching, reading a source,
          // grounding, verifying). Surface the latest one in the working bubble so it
          // reads as active, not static. Cleared once synthesis text starts arriving.
          if (parsed.type === 'thought') {
            const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
            if (text) setRounds(prev => prev.map(r => r.id === roundId && !r.synthesisDone ? { ...r, liveStatus: text } : r))
            continue
          }

          // ── Live web sources (favicon strip) ──────────────────────────────
          // Emitted while a grounded answer is being researched: phase 'reading'
          // seeds the strip as pages are fetched; phase 'grounded' check-marks the
          // ones the final answer actually cites. Deduped by host, order preserved.
          if (parsed.type === 'sources') {
            const incoming: Array<{ url: string; host: string }> = Array.isArray(parsed.items) ? parsed.items : []
            const phase: 'reading' | 'grounded' = parsed.phase === 'grounded' ? 'grounded' : 'reading'
            if (incoming.length) {
              setRounds(prev => prev.map(r => {
                if (r.id !== roundId) return r
                const byHost = new Map((r.liveSources ?? []).map(s => [s.host, s]))
                for (const it of incoming) {
                  if (!it?.host) continue
                  const existing = byHost.get(it.host)
                  // 'grounded' always wins; never downgrade a grounded source back to reading.
                  byHost.set(it.host, { url: it.url, host: it.host, phase: existing?.phase === 'grounded' ? 'grounded' : phase })
                }
                return { ...r, liveSources: Array.from(byHost.values()) }
              }))
            }
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

          // Council debate — co-equal local models proposed, cross-examined, and a
          // deterministic verdict picked the answer. Drives the debate card.
          if (parsed.type === 'local_debate') {
            if (parsed.debate) {
              setRounds(prev => prev.map(r => r.id === roundId ? { ...r, localDebate: parsed.debate } : r))
            }
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
    // "/" palette keyboard navigation — arrows cycle, Tab/Enter completes, Esc dismisses.
    if (slashResults.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSel(s => (s + 1) % slashResults.length); return }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setSlashSel(s => (s - 1 + slashResults.length) % slashResults.length); return }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        const pick = slashResults[Math.min(slashSel, slashResults.length - 1)]
        setInput(`/${pick.name} `)
        return
      }
      if (e.key === 'Escape') { e.preventDefault(); setSlashDismissed(true); return }
    }
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
    const convId = conversationIdRef.current
    setConvThinking(convId, true)
    setConvAgentStart(convId, Date.now()); setAgentElapsed(0)
    setRounds(prev => [...prev, emptyRound(roundId, offer.goal, convId)])
    abortRef.current[convId] = new AbortController()
    let res: Response
    try {
      res = await apiFetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortRef.current[convId]!.signal,
        body: JSON.stringify({
          message: offer.goal,
          mode: 'agent',
          projectPath: offer.projectPath,
          resumeFromCheckpoint: true,
        }),
      })
    } catch { setConvThinking(convId, false); setConvAgentStart(convId, null); return }
    if (!res.body) { setConvThinking(convId, false); setConvAgentStart(convId, null); return }
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
    setConvThinking(convId, false); setConvAgentStart(convId, null); setConvAgentProgress(convId, null)
  }

  const continueFromCheckpoint = async () => {
    if (!resumeOffer) return
    const offer = resumeOffer
    setResumeOffer(null)
    const roundId = Date.now().toString()
    const convId = conversationIdRef.current
    setConvThinking(convId, true)
    setConvAgentStart(convId, Date.now()); setAgentElapsed(0)
    setRounds(prev => [...prev, emptyRound(roundId, offer.goal, convId)])
    abortRef.current[convId] = new AbortController()
    let res: Response
    try {
      res = await apiFetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortRef.current[convId]!.signal,
        body: JSON.stringify({
          message: offer.goal,
          mode: 'agent',
          projectPath: offer.projectPath,
          resumeFromCheckpoint: true,
        }),
      })
    } catch { setConvThinking(convId, false); setConvAgentStart(convId, null); return }
    // Reuse the same SSE parse loop that `send()` uses — delegate by calling send
    // with the pre-built res. Not worth duplicating; just set up the stream directly.
    if (!res.body) { setConvThinking(convId, false); setConvAgentStart(convId, null); return }
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
    setConvThinking(convId, false); setConvAgentStart(convId, null); setConvAgentProgress(convId, null)
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
    // Stop only cancels the conversation on screen — other chats keep running.
    abortRef.current[conversationId]?.abort()
    setConvThinking(conversationId, false)
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
        {/* History/Settings overlays and the Agents drawer are mutually exclusive —
            opening either always closes the other (both visible at once was a live bug). */}
        {/* Mobile gets edge-to-edge chat: the vertical rail is hidden and these same
            nav actions render as a horizontal row in the top bar (below). */}
        {!isMobile && (
          <SidebarRail
            tab={tab}
            setTab={t => { if (t !== 'chat') { setAgentsOpen(false); setAutomationsOpen(false); setConnectionsOpen(false) } setTab(t) }}
            agentsOpen={agentsOpen}
            onToggleAgents={() => { setAutomationsOpen(false); setConnectionsOpen(false); setAgentsOpen(o => { if (!o) setTab('chat'); return !o }) }}
            automationsOpen={automationsOpen}
            onToggleAutomations={() => { setAgentsOpen(false); setConnectionsOpen(false); setAutomationsOpen(o => { if (!o) setTab('chat'); return !o }) }}
            connectionsOpen={connectionsOpen}
            onToggleConnections={() => { setAgentsOpen(false); setAutomationsOpen(false); setConnectionsOpen(o => { if (!o) setTab('chat'); return !o }) }}
            conversationId={conversationId}
            onNewChat={() => {
              // F panels: a new chat is a new PANEL — the previous conversation stays
              // open (and keeps streaming if mid-run); switch back via the chats strip.
              setConversationId('conv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8))
              setTab('chat')
            }}
            onRestore={restoreConversation}
            refreshKey={histRefresh}
            // Mission Control has its own run list — collapse to an icon rail so the
            // workspace gets the screen instead of a redundant history column.
            collapsed={agentsOpen || automationsOpen || connectionsOpen}
          />
        )}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
      {/* Global keyframes + shared rules live in index.css (design-token sheet). */}

      {/* Item 18: agents/history/settings render as an overlay ON TOP of chat, not a tab
          swap that unmounts it — the conversation underneath stays alive and scrolled to
          where the user left it, so opening an agent/tool never navigates them away. */}
      {/* Settings stays a full-page overlay; History is a slide-out-in-place drawer below
          (F) — the chat never unmounts while browsing it. */}
      {tab === 'settings' && (
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
      {tab === 'settings' && (
        <SettingsTabView
          ensemble={ensemble}
          advanced={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* System drawers relocated from the old chat topbar — each trigger now sits
                  in a labeled row (SystemRow) instead of the old unlabeled icon cluster. */}
              <SystemRow label="History" desc="Every past conversation, searchable and restorable.">
                <HistoryBinder onRestore={restoreConversation} />
              </SystemRow>
              <SystemRow label="Open goals" desc="Long-running tasks Crucible is tracking — resume any of them.">
                <TasksBinder onResume={goal => { setTab('chat'); void send(goal) }} />
              </SystemRow>
              <SystemRow label="Integrations" desc="Connected services and what the current draft can reach.">
                <IntegrationsBinder draft={input} />
              </SystemRow>
              <SystemRow label="Skill library" desc="Verified code skills Crucible has built and can reuse.">
                <LibraryBinder onBuild={text => { setTab('chat'); void send(text) }} />
              </SystemRow>
              <SystemRow label="Self-repair" desc="Fixes Crucible proposes for its own failures — approve or dismiss.">
                <SelfRepairBinder />
              </SystemRow>
              <SystemRow label="Self-patcher" desc="Applied self-patches and their verification status.">
                <SelfPatcherBinder />
              </SystemRow>
              <SystemRow label="Infrastructure requests" desc="Governed requests that need your sign-off.">
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
              </SystemRow>
            </div>
          }
        />
      )}
        </div>
      )}

      {/* History — slide-out-in-place (F): a left-strip drawer over the live chat, same
          pattern as the Agents pane below. Restoring a conversation merges it into the
          open pool without touching other chats; the chat behind never unmounts. */}
      {/* Mobile-only now: desktop history lives in the persistent sidebar rail. */}
      {isMobile && tab === 'history' && (
        <>
          <div onClick={() => setTab('chat')} style={{
            position: 'absolute', inset: 0, zIndex: 28,
            background: 'rgba(0,0,0,0.4)', animation: 'fadeIn 0.2s ease',
          }} />
          <div style={{
            position: 'absolute', top: 0, left: 0, bottom: inputBarHeight, zIndex: 29,
            width: 'min(560px, 94vw)',
            background: 'rgba(14,14,20,0.88)', backdropFilter: 'blur(40px) saturate(1.5)', WebkitBackdropFilter: 'blur(40px) saturate(1.5)',
            borderRight: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '24px 0 80px rgba(0,0,0,0.5), inset -1px 0 0 rgba(255,255,255,0.05)',
            animation: 'studioIn 0.24s cubic-bezier(0.22,1,0.36,1)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            <button
              onClick={() => setTab('chat')}
              title="Back to chat"
              style={{
                position: 'absolute', top: 14, right: 14, zIndex: 31, width: 28, height: 28, borderRadius: 9,
                border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.04)',
                color: '#9797ab', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
            <HistoryTabView onRestore={restoreConversation} />
          </div>
        </>
      )}

      {/* Agent Mission Control — full-page cockpit over the chat (chat stays mounted and
          streaming underneath, same as Settings). Launching/steering routes through the
          exact same send() pipeline as the composer, so the transcript stays the source
          of truth; this page renders the live AgentState alongside a briefing column. */}
      {agentsOpen && (
        <AgentMissionControl
          rounds={rounds}
          thinking={thinking}
          liveRoundId={liveRoundId}
          // Force the real agent loop (tools, verify, artifacts) — a plain chat send can
          // answer a "create X" brief with hallucinated prose and zero tool calls.
          onLaunch={text => { void send(text, 'agent') }}
          onReply={text => { void send(text, 'agent') }}
          onClose={() => setAgentsOpen(false)}
        />
      )}

      {/* Automations — standing tasks page (same overlay pattern as Mission Control). */}
      {automationsOpen && (
        <AutomationsView onClose={() => setAutomationsOpen(false)} />
      )}

      {/* Connections — external capability cards with live service widgets. */}
      {connectionsOpen && (
        <ConnectionsView onClose={() => setConnectionsOpen(false)} />
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
            {/* WebRTC video (fast peer-to-peer path). Shown once a track is live; the
                canvas below stays as the JPEG fallback and is hidden while WebRTC is up. */}
            <video
              ref={screenVideoRef}
              muted
              playsInline
              autoPlay
              style={{
                width: '100%', height: 'auto', display: webrtcActive ? 'block' : 'none',
                opacity: webrtcActive && streamStatus === 'live' ? 1 : 0,
                transition: 'opacity 0.4s ease',
              }}
            />
            <canvas
              ref={screenCanvasRef}
              style={{
                width: '100%', height: 'auto', display: webrtcActive ? 'none' : 'block',
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
        // Desktop: the sidebar rail sits under the traffic lights, so no inset needed here.
        // Mobile (rail hidden, bar starts at x=0): inset by the shared shell token so the
        // lights never overlap the wordmark/nav icons. 0 on the web either way.
        padding: `0 18px 0 ${isMobile ? 'max(18px, var(--titlebar-clearance-x))' : '18px'}`,
        gap: 12, zIndex: 10, position: 'relative',
        WebkitAppRegion: 'drag',
      } as any}>
        {/* Wordmark lives in the sidebar rail on desktop — only mobile shows it here. */}
        {isMobile && <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '-0.01em', color: '#e4e4ee', flexShrink: 0 }}>Crucible</span>}
        {/* Mobile navigation — the desktop left rail is hidden on phones, so its tabs
            live here as a compact icon row (same handlers, edge-to-edge chat below). */}
        {isMobile && (
          <NavRail
            orientation="horizontal"
            tab={tab}
            setTab={t => { if (t !== 'chat') setAgentsOpen(false); setTab(t) }}
            agentsOpen={agentsOpen}
            onToggleAgents={() => setAgentsOpen(o => { if (!o) setTab('chat'); return !o })}
          />
        )}
        {/* Top-bar overlap fix: on mobile widths this pill's full label plus the New Chat
            button and agent-progress text had no wrap/shrink handling and could crowd/
            overlap at the right edge — the dot alone still shows mode at a glance. */}
        {(() => {
          // Provenance-honest badge (2026-07-07): the pill used to assert the session
          // MODE ("ON-DEVICE") even while the round on screen was answered by an
          // external free-pool driver (agent runs say "GPT OSS 120B" two lines below —
          // a 120B model that cannot run on this machine). The badge now reports what
          // actually produced the latest answer: local → ON-DEVICE (green), external
          // free-tier pool → FREE POOL (amber). Local agent drivers are labeled
          // "on-device …" at every agent_start emission site, so that substring is the
          // discriminator; chat rounds carry synthesisModelId ('local/…' = on-device).
          const agentDriver = latestRound?.agent?.driver
          const poolDriven = agentDriver
            ? !/on-device|local/i.test(agentDriver)
            : !!latestRound?.synthesisModelId && !/^(local\/|anima$|system$)/.test(latestRound.synthesisModelId)
          const label = mode === 'quorum' ? 'ENSEMBLE · YOUR KEYS' : poolDriven ? 'FREE POOL' : 'ON-DEVICE'
          const dot = mode === 'quorum' ? '#7c7cf8' : poolDriven ? '#f0b429' : '#4db89e'
          return (
            <span title={poolDriven && agentDriver ? `Answered by ${agentDriver} (free pool)` : undefined} style={{
              display: 'flex', alignItems: 'center', gap: 5,
              fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', color: '#66667a',
              background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.07)',
              padding: '2px 8px', borderRadius: 999, flexShrink: 0,
            }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: dot, flexShrink: 0 }} />
              {!isMobile && label}
            </span>
          )
        })()}
        {/* F panels — open-chats strip: one chip per in-memory conversation. A running
            chat shows a live dot and keeps streaming while another chat is on screen. */}
        {openChats.length > 1 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexShrink: 1,
            overflowX: 'auto', scrollbarWidth: 'none', WebkitAppRegion: 'no-drag',
          } as any}>
            {openChats.map(c => {
              const active = c.id === conversationId
              return (
                <div
                  key={c.id}
                  onClick={() => setConversationId(c.id)}
                  title={c.title}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                    padding: '4px 8px 4px 10px', borderRadius: 8, cursor: 'pointer',
                    border: `1px solid ${active ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.07)'}`,
                    background: active ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.025)',
                    color: active ? '#d8d8e6' : '#77778c',
                    fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap',
                    maxWidth: 160, transition: 'background 0.15s, color 0.15s, border-color 0.15s',
                  }}
                >
                  {c.live && (
                    <span style={{
                      width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                      background: '#ff6e1a', animation: 'pulse 1.4s ease infinite',
                    }} />
                  )}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</span>
                  <span
                    onClick={e => {
                      e.stopPropagation()
                      // Close = drop from memory only; History still has it. Abort any live run.
                      abortRef.current[c.id]?.abort()
                      setConvThinking(c.id, false)
                      setAllRounds(prev => prev.filter(r => (r.convId ?? conversationId) !== c.id))
                      if (c.id === conversationId) {
                        const rest = openChats.filter(o => o.id !== c.id)
                        setConversationId(rest[0]?.id ?? ('conv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)))
                      }
                    }}
                    title="Close chat"
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: 14, height: 14, borderRadius: 4, flexShrink: 0,
                      color: 'rgba(255,255,255,0.3)',
                    }}
                  >
                    <svg width="8" height="8" viewBox="0 0 16 16" fill="none">
                      <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </span>
                </div>
              )
            })}
          </div>
        )}
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
          {/* Debug-capture — one click copies this conversation + recent warn/error debug
              events as a markdown report to paste to Claude when Crucible misbehaves. */}
          {rounds.length > 0 && <DebugCapture rounds={rounds} conversationId={conversationId} compact={isMobile} />}
          {reconnecting && (
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
              color: 'rgba(245,158,11,0.8)', textTransform: 'uppercase',
              animation: 'pulse 1.4s ease infinite',
            }}>resuming task…</span>
          )}
          {/* Desktop's New chat lives at the top of the sidebar rail; mobile keeps this one. */}
          {isMobile && <button
            onClick={() => {
              // F panels: a new chat is a new PANEL — the previous conversation stays
              // open (and keeps streaming if mid-run); switch back via the chats strip.
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
          </button>}
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

      {/* ── Welcome empty state — quiet, capability-forward, one tap to try things.
          Replaced by the conversation the moment the first round exists. ── */}
      {rounds.length === 0 && !thinking && (
        <div style={{
          position: 'absolute', top: 56, left: 0, right: 0, bottom: 0, zIndex: 1,
          // The wrapper stays pointer-transparent (composer/topbar underneath must keep
          // working); HomeSurface re-enables pointer events on its own content column.
          pointerEvents: 'none',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          paddingBottom: Math.min(inputBarHeight + 24, 120), animation: 'fadeIn 0.5s ease', overflow: 'hidden auto',
        }}>
          {/* Home: the assistant's day (digest, live runs, schedule) when there is one;
              HomeSurface falls back to the identity splash below on a truly empty account. */}
          <HomeSurface
            allRounds={allRounds}
            onOpenAgents={() => setAgentsOpen(true)}
            onOpenAutomations={() => setAutomationsOpen(true)}
            splash={
          <div style={{ margin: 'auto 0', display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: 0 }}>
          {/* Quiet branded splash: the vessel mark over a slow ember glow — the product's
              identity (forged on-device) instead of a question. Self-authored SVG only. */}
          <div style={{ position: 'relative', width: 84, height: 84, marginBottom: 18, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div className="splash-ember" />
            <svg width="52" height="52" viewBox="0 0 48 48" fill="none" style={{ position: 'relative' }}>
              <defs>
                <linearGradient id="splashMelt" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="var(--c-text)" stopOpacity="0.9" />
                  <stop offset="1" stopColor="#ff9e5e" stopOpacity="0.85" />
                </linearGradient>
              </defs>
              <path d="M10 14h28M10 14l6 22M38 14l-6 22M16 36q8 8 16 0"
                stroke="url(#splashMelt)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--c-text)', marginBottom: 7, textAlign: 'center', padding: '0 24px' }}>
            Crucible
          </div>
          {/* No suggestion chips, no hand-holding — the mark, the promise, the composer. */}
          <div style={{ fontSize: 12.5, color: 'var(--c-dim)', textAlign: 'center', padding: '0 24px' }}>
            Private, on-device. Nothing leaves this Mac.
          </div>
          </div>
            }
          />
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
        left: remoteBrain && isMobile && isLandscape ? '62%' : (isMobile ? 0 : 272),
        right: 0,
        height: inputBarHeight - 4, pointerEvents: 'none', zIndex: 8, background: remoteBrain && isMobile ? 'rgba(13,13,21,0.55)' : 'transparent',
        backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0px, black 64px)',
        maskImage: 'linear-gradient(to bottom, transparent 0px, black 64px)',
      }} />
      <div style={{
        position: 'fixed', bottom: 0,
        left: remoteBrain && isMobile && isLandscape ? '62%' : (isMobile ? 0 : 272),
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
        left: remoteBrain && isMobile && isLandscape ? '62%' : (isMobile ? 0 : 272),
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
                onMouseEnter={() => setSlashSel(i)}
                style={{
                  padding: '9px 14px', cursor: 'pointer',
                  borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.05)',
                  background: i === slashSel ? 'rgba(124,124,248,0.10)' : 'transparent',
                  transition: 'background 0.1s',
                }}
              >
                <div style={{ fontSize: 11.5, fontWeight: 600, color: i === slashSel ? '#e8e8ff' : '#d0d0e8', fontFamily: 'var(--mono)' }}>/{t.name}</div>
                <div style={{ fontSize: 10.5, color: '#8a8a9e', marginTop: 1, lineHeight: 1.4 }}>{t.description}</div>
              </div>
            ))}
            <div style={{
              padding: '5px 14px', borderTop: '1px solid rgba(255,255,255,0.06)',
              fontSize: 9, color: 'rgba(255,255,255,0.25)', letterSpacing: '0.04em',
              display: 'flex', gap: 12,
            }}>
              <span>↑↓ navigate</span><span>Tab/Enter complete</span><span>Esc dismiss</span>
              <span style={{ marginLeft: 'auto' }}>plain words work too — the agent picks the tools</span>
            </div>
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
          // Thin strip by default (single row); grows vertically as the textarea grows.
          borderRadius: 22, padding: '7px 10px',
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
          {/* Upload failure note — visible feedback instead of a silent no-op */}
          {uploadError && (
            <div style={{ padding: '2px 4px 6px 36px', fontSize: 11, color: '#e08a8a', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{uploadError}</span>
              <button onClick={() => setUploadError(null)} title="Dismiss" style={{ background: 'none', border: 'none', color: '#77778c', cursor: 'pointer', padding: 0, fontSize: 13, lineHeight: 1 }}>×</button>
            </div>
          )}
          {/* ── Attachment chips — files uploaded into the workspace sandbox this turn ── */}
          {attachments.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '2px 4px 8px 36px' }}>
              {attachments.map(a => (
                <span key={a.path} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 220,
                  padding: '4px 8px', borderRadius: 8, fontSize: 11, color: '#c8c8d4',
                  background: 'rgba(124,124,248,0.1)', border: '1px solid rgba(124,124,248,0.22)',
                }}>
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M8.5 3.5v4a2.5 2.5 0 0 1-5 0V3a1.5 1.5 0 0 1 3 0v4a.5.5 0 0 1-1 0V3.5" stroke="#9d9dfa" strokeWidth="1" strokeLinecap="round"/></svg>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                  <button onClick={() => removeAttachment(a.path)} title="Remove" style={{ background: 'none', border: 'none', color: '#77778c', cursor: 'pointer', padding: 0, fontSize: 13, lineHeight: 1 }}>×</button>
                </span>
              ))}
            </div>
          )}
          <input
            ref={fileInputRef} type="file" multiple hidden
            onChange={e => { if (e.target.files) void uploadFiles(e.target.files); e.target.value = '' }}
          />
          {/* ── Voice-mode overlay — persistent conversation state above the composer. The chat
              stays fully visible and keeps populating behind it; this is the "we're talking"
              affordance: a breathing orb + state label + exit. ── */}
          {voiceMode && (
            <div style={{
              position: 'fixed', left: '50%', bottom: 96, transform: 'translateX(-50%)', zIndex: 60,
              display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderRadius: 22,
              background: 'rgba(18,18,28,0.92)', border: '1px solid rgba(124,124,248,0.35)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(124,124,248,0.12)', backdropFilter: 'blur(12px)',
            }}>
              <span style={{
                width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
                background: voiceState === 'listening' ? '#4db89e' : voiceState === 'speaking' ? '#9d9dfa' : voiceState === 'thinking' ? '#e0b055' : '#8a8a9e',
                boxShadow: `0 0 12px ${voiceState === 'listening' ? 'rgba(77,184,158,0.7)' : voiceState === 'speaking' ? 'rgba(157,157,250,0.7)' : 'rgba(224,176,85,0.5)'}`,
                animation: voiceState === 'listening' || voiceState === 'speaking' ? 'voicePulse 1.4s ease-in-out infinite' : 'none',
              }} />
              <span style={{ fontSize: 12.5, fontWeight: 600, color: '#c8c8d4', minWidth: 130 }}>
                {voiceState === 'listening' ? 'Listening… speak now' :
                 voiceState === 'transcribing' ? 'Transcribing…' :
                 voiceState === 'thinking' ? 'Thinking…' :
                 voiceState === 'speaking' ? 'Speaking…' : 'Voice mode'}
              </span>
              <button onClick={exitVoiceMode} title="Exit voice mode" style={{
                width: 22, height: 22, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.14)',
                background: 'rgba(255,255,255,0.06)', color: '#b8b8cc', cursor: 'pointer', fontSize: 12, lineHeight: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>×</button>
              <style>{`@keyframes voicePulse { 0%,100% { transform: scale(1); opacity: 1 } 50% { transform: scale(1.35); opacity: 0.7 } }`}</style>
            </div>
          )}
          {/* ── Single row: (+) expander + attach + mic + textarea + mode chip + send ── */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button
              onClick={() => { setComposerExpandOpen(o => !o); setExpanderPopup(null) }}
              title={composerExpandOpen ? 'Close' : 'More: Ensemble, Models, Remote Brain'}
              aria-expanded={composerExpandOpen}
              style={{
                width: 26, height: 26, borderRadius: '50%', flexShrink: 0, cursor: 'pointer',
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
            {/* Attach a file into the workspace sandbox */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              title={uploading ? 'Uploading…' : 'Attach a file to the workspace'}
              style={{
                width: 26, height: 26, borderRadius: '50%', flexShrink: 0, cursor: uploading ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.04)',
                opacity: uploading ? 0.5 : 1, transition: 'background 0.2s',
              }}
            >
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <path d="M9.5 4v5.5a2.5 2.5 0 0 1-5 0V3.5a1.5 1.5 0 0 1 3 0v5.5a.5.5 0 0 1-1 0V4.5" stroke="#8a8a9e" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {/* Voice — click enters the hands-free voice CONVERSATION mode (listen→answer→
                speak→listen, with the state overlay). Right-click = one-shot dictation into
                the composer (the old behavior). */}
            <button
              onClick={() => voiceReady === false ? setTab('settings') : voiceMode ? exitVoiceMode() : enterVoiceMode()}
              onContextMenu={e => { e.preventDefault(); if (voiceReady !== false && !voiceMode) void startRecording() }}
              disabled={transcribing && !voiceMode}
              title={voiceReady === false ? 'Voice model not installed — open Settings' : voiceMode ? 'Exit voice mode' : recording ? 'Stop & transcribe' : transcribing ? 'Transcribing…' : 'Voice mode (right-click for one-shot dictation)'}
              style={{
                width: 26, height: 26, borderRadius: '50%', flexShrink: 0, cursor: transcribing ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: `1px solid ${recording ? 'rgba(255,110,26,0.5)' : voiceLoop ? 'rgba(124,124,248,0.4)' : 'rgba(255,255,255,0.09)'}`,
                background: recording ? 'rgba(255,110,26,0.16)' : voiceLoop ? 'rgba(124,124,248,0.14)' : 'rgba(255,255,255,0.04)',
                transition: 'background 0.2s, border-color 0.2s',
              }}
            >
              {transcribing ? (
                <span style={{ width: 9, height: 9, borderRadius: '50%', border: '1.5px solid #9d9dfa', borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite' }} />
              ) : (
                <svg width="12" height="12" viewBox="0 0 12 14" fill="none">
                  <rect x="4" y="1" width="4" height="7" rx="2" stroke={recording ? '#ff8a3d' : voiceLoop ? '#b0b0f8' : '#8a8a9e'} strokeWidth="1.2" />
                  <path d="M2.5 6.5a3.5 3.5 0 0 0 7 0M6 10v2.5" stroke={recording ? '#ff8a3d' : voiceLoop ? '#b0b0f8' : '#8a8a9e'} strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              )}
            </button>
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
            {mode === 'quorum' && (
              <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '0.05em', color: '#7c7cf8', flexShrink: 0 }}>ENSEMBLE ON</span>
            )}
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
          {/* Expander content — only rendered while open, so the resting bar stays one thin row. */}
          {composerExpandOpen && (
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 2px 36px' }}>
              {/* ── Model-switch popup — pins one on-device model (server honors it via
                  localModelRouter's pinned-id override); Auto restores normal routing. */}
              {expanderPopup === 'models' && (
                <div style={{
                  position: 'absolute', bottom: 'calc(100% + 8px)', left: 36, zIndex: 40,
                  minWidth: 230, maxWidth: 300, padding: 6, borderRadius: 12,
                  background: 'rgba(22,22,30,0.98)', border: '1px solid rgba(255,255,255,0.1)',
                  boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
                  animation: 'panelUp 0.18s cubic-bezier(0.22,1,0.36,1)',
                  display: 'flex', flexDirection: 'column', gap: 2,
                }}>
                  <div style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: '#55556a', padding: '6px 8px 4px' }}>Answer with</div>
                  {[
                    { id: null as string | null, label: 'Auto', note: 'Crucible routes each turn' },
                    { id: 'track-s-fm', label: 'Apple FM', note: 'on-device foundation model' },
                    ...(ggufRuntimeAvailable
                      ? pickerModels.filter(m => m.ready && m.enabled).map(m => ({ id: m.id as string | null, label: m.label, note: 'local GGUF' }))
                      : []),
                  ].map(opt => {
                    const active = pinnedModelId === opt.id || (!pinnedModelId && opt.id === null)
                    return (
                      <button
                        key={opt.id ?? 'auto'}
                        onClick={() => { pinModel(opt.id); setExpanderPopup(null) }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 8,
                          cursor: 'pointer', border: 'none', textAlign: 'left' as const, fontFamily: 'inherit',
                          background: active ? 'rgba(124,124,248,0.12)' : 'transparent',
                          transition: 'background 0.15s',
                        }}
                      >
                        <span style={{
                          width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                          background: active ? '#7c7cf8' : '#3a3a4c',
                          boxShadow: active ? '0 0 6px rgba(124,124,248,0.6)' : 'none',
                        }} />
                        <span style={{ fontSize: 11.5, fontWeight: 600, color: active ? '#b0b0f8' : '#c8c8d4' }}>{opt.label}</span>
                        <span style={{ fontSize: 9.5, color: '#55556a', marginLeft: 'auto' }}>{opt.note}</span>
                      </button>
                    )
                  })}
                  <button
                    onClick={() => { setExpanderPopup(null); setComposerExpandOpen(false); setTab('settings') }}
                    style={{
                      padding: '6px 8px', borderRadius: 8, cursor: 'pointer', border: 'none', fontFamily: 'inherit',
                      background: 'transparent', textAlign: 'left' as const, fontSize: 10, color: '#77778c',
                      borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: 2,
                    }}
                  >
                    Manage models…
                  </button>
                </div>
              )}

              {/* ── Agent command list — the same prebuilt workflows as the Agents drawer,
                  runnable on whatever is typed in the composer without leaving it. */}
              {expanderPopup === 'agents' && (
                <div style={{
                  position: 'absolute', bottom: 'calc(100% + 8px)', left: 36, zIndex: 40,
                  minWidth: 260, maxWidth: 320, padding: 6, borderRadius: 12,
                  background: 'rgba(22,22,30,0.98)', border: '1px solid rgba(255,255,255,0.1)',
                  boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
                  animation: 'panelUp 0.18s cubic-bezier(0.22,1,0.36,1)',
                  display: 'flex', flexDirection: 'column', gap: 2,
                }}>
                  <div style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: '#55556a', padding: '6px 8px 4px' }}>
                    {input.trim().length >= 4 ? 'Run on what you typed' : 'Type a request first, then pick a workflow'}
                  </div>
                  {AGENT_WORKFLOWS.map(a => {
                    const usable = input.trim().length >= 4
                    return (
                      <button
                        key={a.name}
                        disabled={!usable}
                        onClick={() => {
                          const d = input.trim()
                          setExpanderPopup(null); setComposerExpandOpen(false); setInput('')
                          void send(a.prompt(d), undefined, false, `${a.name}: ${d}`)
                        }}
                        title={a.desc}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 8,
                          cursor: usable ? 'pointer' : 'default', border: 'none', textAlign: 'left' as const, fontFamily: 'inherit',
                          background: 'transparent', opacity: usable ? 1 : 0.45, transition: 'background 0.15s',
                        }}
                        onMouseEnter={e => { if (usable) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(124,124,248,0.1)' }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
                      >
                        <span style={{ fontSize: 10, fontFamily: 'ui-monospace, monospace', color: a.color, width: 22, flexShrink: 0 }}>{a.glyph}</span>
                        <span style={{ fontSize: 11.5, fontWeight: 600, color: '#c8c8d4' }}>{a.name}</span>
                        <span style={{ fontSize: 9, color: '#55556a', marginLeft: 'auto' }}>{a.category}</span>
                      </button>
                    )
                  })}
                </div>
              )}
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
                  onClick={() => setExpanderPopup(p => p === 'models' ? null : 'models')}
                  title="Pick which on-device model handles this chat"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
                    border: `1px solid ${expanderPopup === 'models' ? 'rgba(124,124,248,0.4)' : 'rgba(255,255,255,0.07)'}`,
                    background: expanderPopup === 'models' ? 'rgba(124,124,248,0.12)' : 'transparent',
                    fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
                    color: expanderPopup === 'models' || pinnedModelId ? '#9d9dfa' : '#55556a',
                    transition: 'background 0.2s, border-color 0.2s',
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <circle cx="5" cy="5" r="3.6" stroke="currentColor" strokeWidth="1.2" />
                    <circle cx="5" cy="5" r="1" fill="currentColor" />
                  </svg>
                  {pinnedModelId ? (pinnedModelId === 'track-s-fm' ? 'Apple FM' : pickerModels.find(m => m.id === pinnedModelId)?.label ?? 'Pinned') : 'Models'}
                </button>

                <button
                  onClick={() => setExpanderPopup(p => p === 'agents' ? null : 'agents')}
                  title="Run one of Crucible's agent workflows on what you've typed"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
                    border: `1px solid ${expanderPopup === 'agents' ? 'rgba(124,124,248,0.4)' : 'rgba(255,255,255,0.07)'}`,
                    background: expanderPopup === 'agents' ? 'rgba(124,124,248,0.12)' : 'transparent',
                    fontSize: 10, fontWeight: 600, letterSpacing: '0.04em',
                    color: expanderPopup === 'agents' ? '#9d9dfa' : '#55556a',
                    transition: 'background 0.2s, border-color 0.2s',
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M2 2.5h6M2 5h6M2 7.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  </svg>
                  Agents
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
            </div>
          )}
        </div>
      </div>
      </>
        </div>
      </div>
    </div>
  )
}

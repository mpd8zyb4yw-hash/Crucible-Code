import { useCallback, useEffect, useRef, useState } from 'react'
import { css } from './css'
import { listProviders, think, tell, addTrack, say, enablePush, type Need, type ThinkResult } from './api'
import Home from './Home'
import Report, { type Msg } from './Report'
import Settings from './Settings'

type View = string | null

export default function App() {
  const [view, setView] = useState<View>(null)
  const [showQuiet, setShowQuiet] = useState(false)
  /**
   * Conversations outlive the cards they were opened from. Synthesis mints new
   * card ids every pass, so a reply — which triggers a re-think — used to
   * orphan the very thread it came from, and a reload lost the lot. Persisted
   * so that going back and returning finds the conversation still there.
   */
  const [threads, setThreads] = useState<Record<string, Msg[]>>(() => {
    try { return JSON.parse(localStorage.getItem('cru:threads') ?? '{}') } catch { return {} }
  })

  useEffect(() => {
    try { localStorage.setItem('cru:threads', JSON.stringify(threads)) } catch { /* private mode */ }
  }, [threads])
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set())
  const [hasBrain, setHasBrain] = useState<boolean | null>(null)
  const [needsSignIn, setNeedsSignIn] = useState(false)
  const [result, setResult] = useState<ThinkResult | null>(null)
  const [thinking, setThinking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // StrictMode mounts twice in dev; a second synthesis burns free-tier quota
  // for an identical answer, so in-flight calls are coalesced.
  const inFlight = useRef(false)
  // Asked for once, after the app has actually shown him something worth being
  // notified about — a permission prompt on first paint is how people say no.
  const askedPush = useRef(false)

  const reconsider = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setThinking(true)
    setError(null)
    try {
      setResult(await think())
      if (!askedPush.current) {
        askedPush.current = true
        void enablePush()
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setThinking(false)
      inFlight.current = false
    }
  }, [])

  const checkBrain = useCallback(async () => {
    try {
      const r = await listProviders()
      setNeedsSignIn(false)
      const ok = r.providers.some((p) => p.configured)
      setHasBrain(ok)
      if (ok) void reconsider()
    } catch (e) {
      // Hosted, the first failure is almost always "no session" — saying
      // "connect a model" there would send him to fix something that is not
      // broken. Tell him which of the two it actually is.
      if (/not signed in/i.test((e as Error).message)) setNeedsSignIn(true)
      setHasBrain(false)
    }
  }, [reconsider])

  useEffect(() => { void checkBrain() }, [checkBrain])

  const needs = result?.needs ?? []

  /**
   * The composer opens as a Report like everything else — the design has one
   * way to open a thing, and the ask card is not an exception to it. It isn't
   * a need the model raised, so it's assembled here from the ask block.
   */
  const askNeed: Need = {
    id: 'ask', tier: 'quiet', heat: 'quiet', heatLabel: 'ask me anything',
    title: 'Crucible', sub: '',
    // Deliberately NOT gated on a successful think. If synthesis failed — rate
    // limited, offline, nothing known yet — being unable to ask what happened
    // is the worst possible moment to lose the composer.
    status: result?.readLine ?? '',
    opening: result?.ask?.opening ?? 'What’s on your mind?',
    stats: null, chips: result?.ask?.chips ?? [],
    action: null, proposes: null, basis: [], asks: false,
    gauges: null, meter: null, glyph: null, accent: null,
  }

  const open = (view === 'ask' ? askNeed : needs.find((n) => n.id === view)) ?? null

  /**
   * Anything he says — typed, or tapped as a chip. His words land in the thread
   * immediately, the model answers with the card and the whole world model in
   * view, and because what he said is now evidence, a statement (rather than a
   * question) re-runs synthesis — telling it something can visibly change the
   * feed. Chips come through here too: they are his words, not a script.
   */
  const onSay = async (need: Need, text: string) => {
    setThreads((p) => ({ ...p, [need.id]: [...(p[need.id] || []), { who: 'me', text }] }))
    try {
      const r = await say(
        text,
        need.id === 'ask' ? null : { title: need.title, status: need.status, asks: need.asks },
        threads[need.id] || []
      )
      setThreads((p) => ({
        ...p,
        [need.id]: [
          ...(p[need.id] || []),
          { who: 'ai', text: r.reply },
          // What it actually did, as its own line — the difference between
          // "I'll check" and having checked is the whole point.
          ...(r.did ? [{ who: 'ai' as const, text: r.did }] : []),
        ],
      }))
      if (r.learned) void reconsider()
    } catch (e) {
      setThreads((p) => ({ ...p, [need.id]: [...(p[need.id] || []), { who: 'ai', text: (e as Error).message }] }))
    }
  }

  /**
   * The card's primary action. When the card offered to watch something,
   * accepting it is what creates the standing interest — this is the whole
   * "design a card with the agent" path, and it costs him one tap.
   */
  const onAct = async (need: Need) => {
    // The "I can't think right now" card is the one card whose action is not a
    // thing to record — it is a door to the place the problem is fixable.
    if (need.id === 'notice-brain') { setView('settings'); return }
    setDoneIds((p) => new Set(p).add(need.id))
    if (need.proposes) {
      try {
        await addTrack({ ...need.proposes, by: 'agent' })
        await tell(`Agreed to track: ${need.proposes.what} — ${need.proposes.why}`, need.title)
        await reconsider()
        return
      } catch { /* fall through to the plain record below */ }
    }
    void tell(`Acted on "${need.title}": ${need.action?.label ?? 'done'}`, need.title).catch(() => {})
  }

  return (
    <div className="cru-device" style={css('width:390px; height:844px; position:relative; overflow:hidden; border-radius:40px; box-shadow:0 60px 120px rgba(0,0,0,.9), 0 0 0 1px rgba(237,238,241,.10);')}>
      <div style={css('position:absolute; inset:0; background:linear-gradient(168deg,#131210 0%,#0B0A0C 48%,#0D0C11 100%);')} />
      <div style={css('position:absolute; left:0; right:0; top:0; height:34%; background:radial-gradient(70% 100% at 50% 0%, rgba(240,175,120,.06), rgba(240,175,120,0) 72%);')} />

      <div style={css('position:relative; height:100%; display:flex; flex-direction:column;')}>
        <div style={css('height:46px; flex:none; display:flex; align-items:flex-end; justify-content:space-between; padding:0 26px 6px; font-size:13px; font-weight:600; color:rgba(237,238,241,.48);')}>
          {/* His clock, not the machine's locale. */}
          <div>{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: (result?.clock ?? '12h') === '12h' })}</div>
          <div style={css('display:flex; gap:5px; align-items:center;')}>
            <div style={css('width:15px; height:7px; background:rgba(237,238,241,.18);')} />
            <div style={css('width:20px; height:8px; background:rgba(237,238,241,.34);')} />
          </div>
        </div>

        {view === null && (
          <Home
            dateLabel={result?.dateLabel ?? ''}
            place={result?.place ?? null}
            readLine={error ? error : result?.readLine ?? ''}
            needs={needs}
            quietLog={result?.quietLog ?? []}
            showQuiet={showQuiet}
            needsBrain={hasBrain === false}
            needsSignIn={needsSignIn}
            thinking={thinking}
            doneIds={doneIds}
            onToggleQuiet={() => setShowQuiet((q) => !q)}
            onOpen={(id) => setView(id === 'notice-brain' ? 'settings' : id)}
            onOpenSettings={() => setView('settings')}
            onAct={onAct}
          />
        )}

        {view === 'settings' && (
          <Settings onClose={() => setView(null)} onChanged={() => void checkBrain()} />
        )}

        {open && (
          <Report
            need={open}
            thread={threads[open.id] || []}
            done={doneIds.has(open.id)}
            onSay={onSay}
            onClose={() => setView(null)}
          />
        )}
      </div>
    </div>
  )
}

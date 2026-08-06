import { useEffect, useState } from 'react'
import { css, cssv } from './css'
import {
  listProviders, saveKey, removeKey, setActive, setRouting, getHealth,
  googleStatus, googleSync, googleDisconnect,
  getSources, putSources, listTracks, addTrack, removeTrack,
  type ProviderInfo, type Track, type Rested,
} from './api'

/**
 * Settings is not a new visual idiom — it is a Report. Same grab-handle
 * header, same tap-the-top-to-close, same row treatment as the quiet group.
 * The design has one way to show a surface and this uses it.
 */
export default function Settings({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [list, setList] = useState<ProviderInfo[]>([])
  const [active, setActiveId] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Models this key was refused, by provider — the provider's reason, verbatim. */
  const [rejected, setRejected] = useState<Record<string, Record<string, string>>>({})
  /** Who chooses the model for each piece of work. */
  const [routeMode, setRouteMode] = useState<'auto' | 'pinned'>('auto')
  /** What the router last learned about which models are resting, and why. */
  const [rested, setRested] = useState<Record<string, Rested[]>>({})
  const [loaded, setLoaded] = useState(false)

  const refresh = async () => {
    try {
      const r = await listProviders()
      setList(r.providers)
      setActiveId(r.active)
      setRouteMode(r.routing ?? 'auto')
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoaded(true)
    }
    // Never fatal: knowing which models are resting is a nicety on top of the
    // list, not a precondition for showing it.
    try {
      const h = await getHealth()
      setRested(Object.fromEntries(h.providers.map((p) => [p.providerId, p.rested])))
    } catch { /* leave whatever we last knew */ }
  }

  const switchRouting = async (m: 'auto' | 'pinned') => {
    setRouteMode(m)
    try {
      await setRouting(m)
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => { void refresh() }, [])

  const connect = async (id: string) => {
    if (!draft.trim()) return
    setBusy(id)
    setError(null)
    try {
      await saveKey(id, draft.trim())
      setDraft('')
      setOpen(null)
      await refresh()
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async (id: string) => {
    setBusy(id)
    try {
      await removeKey(id)
      await refresh()
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  /**
   * Choosing a model. The server proves it answers on this key before it saves
   * it, so a model the plan does not include is refused here — with the
   * provider's own reason, against the model he tapped — instead of being
   * accepted and taking the home feed down on the next synthesis.
   */
  const use = async (id: string, model?: string) => {
    setBusy(id)
    try {
      await setActive(id, model)
      if (model) setRejected((p) => ({ ...p, [id]: { ...p[id], [model]: '' } }))
      await refresh()
      onChanged()
    } catch (e) {
      const why = (e as Error).message
      if (model) setRejected((p) => ({ ...p, [id]: { ...p[id], [model]: why } }))
      else setError(why)
    } finally {
      setBusy(null)
    }
  }

  const connectedCount = list.filter((p) => p.configured).length
  const status = !loaded
    ? 'Checking what you’ve connected…'
    : connectedCount === 0
      ? 'Nothing connected yet. Add a key from any provider — a free tier is enough to start — and I’ll start thinking.'
      : `${connectedCount} connected. I think with the one marked in use; switch any time to compare how sharp they are.`

  return (
    <div style={css('flex:1; display:flex; flex-direction:column; animation:cruExpand .3s cubic-bezier(.2,.7,.2,1); min-height:0;')}>

      <div onClick={onClose} style={css('flex:none; padding:12px 20px 15px; cursor:pointer; background:linear-gradient(160deg, rgba(38,30,22,.4), rgba(16,14,12,0)); box-shadow:inset 0 -1px 0 rgba(255,255,255,.06);')}>
        <div style={css('width:40px; height:4px; border-radius:999px; background:rgba(237,238,241,.24); margin:0 auto 13px;')} />
        <div style={css('display:flex; align-items:center; justify-content:space-between;')}>
          <div style={css('display:flex; align-items:center; gap:8px; font-size:11px; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:rgba(237,238,241,.6);')}>
            <div style={css('width:6px; height:6px; border-radius:999px; background:#F0A56B;')} />
            the brain
          </div>
          <div style={css('display:flex; align-items:center; gap:6px; font-size:11.5px; color:rgba(237,238,241,.42);')}>
            close <span style={css('font-size:14px;')}>⌃</span>
          </div>
        </div>
        <div style={css('margin-top:11px; font-size:25px; font-weight:600; letter-spacing:-.03em;')}>What I think with</div>
        <div style={css('margin-top:6px; font-size:14px; line-height:1.5; color:rgba(237,238,241,.6); text-wrap:pretty;')}>{status}</div>
      </div>

      <div style={css('flex:1; overflow-y:auto; padding:14px 18px 10px; display:flex; flex-direction:column; min-height:0;')}>
        {error && (
          <div style={css('margin-bottom:12px; padding:11px 14px; border-radius:14px; background:rgba(52,32,28,.5); box-shadow:inset 0 0 0 1px rgba(240,115,107,.28); font-size:13px; line-height:1.45; color:#F0938B;')}>{error}</div>
        )}

        {/* Who chooses the model. Auto is the whole point of having several
            keys: synthesis, a one-line reply and turning a search result into
            a fact are different jobs, and the model that is scarcest is rarely
            the one the small job needs. Pinned exists so a comparison between
            two models is actually a comparison. */}
        <div style={css('margin-bottom:6px; padding:14px; border-radius:16px; background:rgba(255,255,255,.04); box-shadow:inset 0 0 0 1px rgba(255,255,255,.07);')}>
          <div style={css('font-size:15px; font-weight:500;')}>Who picks the model</div>
          <div style={css('margin-top:3px; font-size:12.5px; line-height:1.45; color:rgba(237,238,241,.5);')}>
            {routeMode === 'auto'
              ? 'I choose per task, from whichever models are answering right now — and step around any that are out of budget.'
              : 'I always start with the model you chose, and only fall back if it won’t answer.'}
          </div>
          <div style={css('margin-top:11px; display:flex; gap:8px;')}>
            {([['auto', 'Crucible picks'], ['pinned', 'Always my model']] as const).map(([m, label]) => (
              <div
                key={m}
                onClick={() => void switchRouting(m)}
                style={cssv`padding:9px 14px; border-radius:999px; font-size:12.5px; cursor:pointer; background:${routeMode === m ? 'rgba(237,238,241,.92)' : 'rgba(255,255,255,.06)'}; color:${routeMode === m ? '#101012' : 'rgba(237,238,241,.82)'}; box-shadow:inset 0 0 0 1px rgba(255,255,255,.14);`}
              >{label}</div>
            ))}
          </div>
        </div>

        {list.map((p) => {
          const isActive = p.id === active
          const isOpen = open === p.id
          return (
            <div key={p.id} style={css('box-shadow:inset 0 -1px 0 rgba(255,255,255,.06);')}>
              <div
                onClick={() => { setOpen(isOpen ? null : p.id); setDraft(''); setError(null) }}
                style={css('padding:15px 4px; cursor:pointer; display:flex; align-items:center; gap:14px;')}
              >
                <div style={cssv`width:40px; height:40px; flex:none; border-radius:11px; background:rgba(255,255,255,.04); display:flex; align-items:center; justify-content:center; font-size:15px; font-weight:600; color:${p.configured ? '#5FC9A6' : 'rgba(237,238,241,.35)'};`}>
                  {p.label.slice(0, 1)}
                </div>
                <div style={css('flex:1;')}>
                  <div style={css('display:flex; align-items:center; gap:8px;')}>
                    <div style={css('font-size:15px; font-weight:500;')}>{p.label}</div>
                    {p.free && (
                      <div style={css('padding:2px 7px; border-radius:999px; font-size:10px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; color:#A6CE82; background:rgba(166,206,130,.12);')}>free tier</div>
                    )}
                    {isActive && (
                      <div style={css('padding:2px 7px; border-radius:999px; font-size:10px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; color:#0B0B0D; background:rgba(237,238,241,.9);')}>in use</div>
                    )}
                  </div>
                  <div style={css('margin-top:2px; font-size:12.5px; color:rgba(237,238,241,.48);')}>
                    {busy === p.id ? 'Checking…' : p.configured ? p.model : p.hint}
                  </div>
                </div>
                <div style={css('font-size:16px; color:rgba(237,238,241,.28);')}>{isOpen ? '⌃' : '›'}</div>
              </div>

              {isOpen && (
                <div style={css('padding:0 4px 15px; display:flex; flex-direction:column; gap:10px;')}>
                  {!p.configured ? (
                    <>
                      <div style={css('padding:11px 15px; border-radius:22px; background:rgba(30,32,37,.55); box-shadow:inset 0 1px 0 rgba(255,255,255,.16), inset 0 0 0 1px rgba(255,255,255,.09); display:flex; align-items:center; gap:11px;')}>
                        <input
                          type="password"
                          value={draft}
                          autoFocus
                          placeholder={`Paste your ${p.label} key…`}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') void connect(p.id) }}
                          style={css('flex:1; background:transparent; border:0; outline:0; font-family:inherit; font-size:14px; color:rgba(237,238,241,.92);')}
                        />
                        <div
                          onClick={() => void connect(p.id)}
                          style={css('width:30px; height:30px; flex:none; border-radius:999px; background:rgba(237,238,241,.9); display:flex; align-items:center; justify-content:center; color:#0B0B0D; font-size:15px; cursor:pointer;')}
                        >↑</div>
                      </div>
                      <div style={css('font-size:12px; line-height:1.45; color:rgba(237,238,241,.38); padding:0 2px;')}>
                        Stored in your macOS keychain, never in the app. I’ll test it before saving.
                      </div>
                    </>
                  ) : (
                    <>
                      <Models
                        provider={p}
                        busy={busy === p.id}
                        isActive={isActive}
                        rejected={rejected[p.id] ?? {}}
                        rested={rested[p.id] ?? []}
                        onPick={(m) => void use(p.id, m)}
                      />
                      <div style={css('display:flex; gap:9px; align-items:center; padding-top:2px;')}>
                        {!isActive && (
                          <div onClick={() => void use(p.id)} style={css('padding:10px 15px; border-radius:12px; background:rgba(237,238,241,.92); color:#0B0B0D; font-size:13px; font-weight:600; cursor:pointer;')}>Think with this</div>
                        )}
                        <div onClick={() => void disconnect(p.id)} style={css('font-size:12.5px; color:rgba(240,115,107,.75); cursor:pointer;')}>Remove key</div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}

        <Sight onChanged={onChanged} />
      </div>
    </div>
  )
}

/**
 * A provider's refusal, cut down to something that fits under a row. Gemini's
 * quota error is six hundred characters of metric names and URLs; the first
 * sentence of it is the part he can act on.
 */
/** "33m", "2h", "45s" — the same shape the router uses server-side. */
function shortMs(ms: number): string {
  if (ms < 90_000) return `${Math.round(ms / 1000)}s`
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}

function gist(message: string): string {
  const first = message.split('\n')[0].split(/(?<=\.)\s/)[0].trim()
  return first.length > 120 ? `${first.slice(0, 117)}…` : first
}

/**
 * Which model this provider thinks with.
 *
 * This was a wrapping cloud of every model a key can reach — forty near-identical
 * pills for Gemini alone, no order, no way to see which one was in use without
 * reading all of them. It is now the same row idiom as the rest of the app:
 * closed, it says the one thing that matters, which model is in use; opened, the
 * rest are a short grouped list you scroll rather than a wall you decode.
 */
function Models({
  provider, busy, isActive, rejected, rested, onPick,
}: {
  provider: ProviderInfo
  busy: boolean
  isActive: boolean
  rejected: Record<string, string>
  rested: Rested[]
  onPick: (model: string) => void
}) {
  const resting = new Map(rested.map((r) => [r.model, r]))
  const [open, setOpen] = useState(false)

  // Group by family so twelve gemini-2.5-* rows read as one thing with variants.
  const groups: [string, string[]][] = []
  for (const m of provider.models) {
    const family = m.includes('/') ? m.slice(0, m.indexOf('/')) : m.split('-')[0]
    const last = groups[groups.length - 1]
    if (last && last[0] === family) last[1].push(m)
    else groups.push([family, [m]])
  }

  return (
    <div style={css('border-radius:14px; background:rgba(255,255,255,.04); box-shadow:inset 0 0 0 1px rgba(255,255,255,.07); overflow:hidden;')}>
      <div onClick={() => setOpen((o) => !o)} style={css('padding:12px 14px; display:flex; align-items:center; gap:12px; cursor:pointer;')}>
        <div style={css('flex:1; min-width:0;')}>
          <div style={css('font-size:11px; color:rgba(237,238,241,.42);')}>{isActive ? 'thinking with' : 'would think with'}</div>
          <div style={css('margin-top:3px; font-size:14px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;')}>
            {busy ? 'Checking…' : provider.model}
          </div>
        </div>
        <div style={css('font-size:12px; color:rgba(237,238,241,.42); white-space:nowrap;')}>
          {open ? 'done' : `${provider.models.length} available ›`}
        </div>
      </div>

      {open && (
        <div style={css('max-height:232px; overflow-y:auto; box-shadow:inset 0 1px 0 rgba(255,255,255,.06);')}>
          {groups.map(([family, models]) => (
            <div key={family}>
              <div style={css('padding:9px 14px 4px; font-size:10px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:rgba(237,238,241,.26);')}>{family}</div>
              {models.map((m) => {
                // A refusal from just now, or one the router already recorded.
                const rest = resting.get(m)
                const why = rejected[m] || (rest ? `${rest.why} · back in ${shortMs(rest.backInMs)}` : '')
                const current = m === provider.model
                return (
                  <div
                    key={m}
                    onClick={() => { if (!current && !busy) onPick(m) }}
                    style={cssv`padding:9px 14px; display:flex; align-items:center; gap:10px; cursor:${current ? 'default' : 'pointer'};`}
                  >
                    <div style={css('flex:1; min-width:0;')}>
                      <div style={cssv`font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:rgba(237,238,241,${why ? '.32' : current ? '.95' : '.75'});`}>{m}</div>
                      {/* The provider's own words. "Not available on your plan"
                          beside the model beats a red banner above the list. */}
                      {why && (
                        <div style={css('margin-top:2px; font-size:11px; line-height:1.4; color:rgba(240,147,139,.72);')}>{gist(why)}</div>
                      )}
                    </div>
                    {current && <div style={css('font-size:12px; color:#5FC9A6;')}>✓</div>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const SOURCE_LABEL: Record<string, string> = {
  calendar: 'Calendar', email: 'Mail', health: 'Activity', youtube: 'YouTube',
}

/**
 * What it can see, and who decides what reaches the screen.
 *
 * One Google sign-in, then he says source by source what it may read, and
 * whether the feed is his to curate or mine. Below that, the standing
 * interests — anything answerable, named by him, with no list of supported
 * subjects anywhere behind it.
 */
function Sight({ onChanged }: { onChanged: () => void }) {
  const [g, setG] = useState<{ configured: boolean; connected: boolean } | null>(null)
  const [sources, setSources] = useState<{ id: string; on: boolean }[]>([])
  const [curation, setCuration] = useState<'auto' | 'manual'>('auto')
  const [tracks, setTracks] = useState<Track[]>([])
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState<string | null>(null)

  const refresh = async () => {
    const [gs, sr, tr] = await Promise.all([
      googleStatus().catch(() => null),
      getSources().catch(() => null),
      listTracks().catch(() => null),
    ])
    if (gs) setG(gs)
    if (sr) { setSources(sr.sources); setCuration(sr.curation) }
    if (tr) setTracks(tr.tracks)
  }
  useEffect(() => { void refresh() }, [])

  /**
   * Turning a source on used to change a flag and nothing else: the pill lit
   * up, the home feed stayed exactly as it was, and there was no way to tell
   * whether it had worked. A source is only read on a sync, so enabling one
   * runs that sync now — what you just switched on is what you want to see.
   */
  const toggle = async (id: string, on: boolean) => {
    if (!g?.connected) return
    setSources((p) => p.map((s) => (s.id === id ? { ...s, on } : s)))
    await putSources({ sources: { [id]: on } })
    if (on) {
      setNote(`Reading your ${(SOURCE_LABEL[id] ?? id).toLowerCase()}…`)
      try {
        const r = await googleSync()
        setNote(r.added ? `Pulled ${r.added} things` : 'Nothing new to read there yet')
      } catch (e) {
        setNote((e as Error).message)
      }
    }
    onChanged()
  }

  const setMode = async (m: 'auto' | 'manual') => {
    setCuration(m)
    await putSources({ curation: m })
    onChanged()
  }

  const sync = async () => {
    setNote('Pulling…')
    try {
      const r = await googleSync()
      setNote(`Pulled ${r.added} things${r.errors.length ? ` · ${r.errors.length} source(s) errored` : ''}`)
      onChanged()
    } catch (e) {
      setNote((e as Error).message)
    }
  }

  const add = async () => {
    const what = draft.trim()
    if (!what) return
    setDraft('')
    // He names the subject in his own words; the question it searches on is
    // the same words until the assistant sharpens it. Nothing is enumerated.
    try {
      await addTrack({ what, why: 'he asked for this', question: what, everyHours: 24, by: 'user' })
      await refresh()
      onChanged()
    } catch (e) {
      setNote((e as Error).message)
    }
  }

  return (
    <>
      <div style={css('padding:22px 4px 8px; font-size:11px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:rgba(237,238,241,.3);')}>what I can see</div>

      <div style={css('box-shadow:inset 0 -1px 0 rgba(255,255,255,.06); padding:15px 4px; display:flex; align-items:center; gap:14px;')}>
        <div style={cssv`width:40px; height:40px; flex:none; border-radius:11px; background:rgba(255,255,255,.04); display:flex; align-items:center; justify-content:center; font-size:15px; font-weight:600; color:${g?.connected ? '#5FC9A6' : 'rgba(237,238,241,.35)'};`}>G</div>
        <div style={css('flex:1;')}>
          <div style={css('font-size:15px; font-weight:500;')}>Google</div>
          <div style={css('margin-top:2px; font-size:12.5px; color:rgba(237,238,241,.48);')}>
            {!g ? 'Checking…' : g.connected ? 'Signed in' : g.configured ? 'One sign-in, then choose what it reads' : 'No client credentials configured'}
          </div>
        </div>
        {g?.connected ? (
          <div style={css('display:flex; gap:10px; align-items:center;')}>
            <div onClick={() => void sync()} style={css('font-size:12.5px; color:rgba(237,238,241,.7); cursor:pointer;')}>Sync</div>
            <div onClick={async () => { await googleDisconnect(); await refresh(); onChanged() }} style={css('font-size:12.5px; color:rgba(240,115,107,.75); cursor:pointer;')}>Sign out</div>
          </div>
        ) : (
          <a href="/api/google/connect" target="_blank" rel="noreferrer" style={css('padding:10px 15px; border-radius:12px; background:rgba(237,238,241,.92); color:#0B0B0D; font-size:13px; font-weight:600;')}>Sign in</a>
        )}
      </div>

      {/* Deterministic, per source. Signing in is not blanket consent.
          Until he has signed in these read nothing at all, so they are shown
          plainly as inert rather than lit up and lying — a pill that looks on
          while its source is unreachable is why "I selected Calendar and
          nothing appeared" was the only possible outcome. */}
      <div style={css('padding:13px 4px 15px; box-shadow:inset 0 -1px 0 rgba(255,255,255,.06);')}>
        <div style={css('display:flex; gap:8px; flex-wrap:wrap;')}>
          {sources.map((s) => {
            const live = !!g?.connected && s.on
            return (
              <div
                key={s.id}
                onClick={() => void toggle(s.id, !s.on)}
                style={cssv`padding:9px 14px; border-radius:999px; font-size:12.5px; cursor:${g?.connected ? 'pointer' : 'default'}; white-space:nowrap; background:${live ? 'rgba(237,238,241,.92)' : 'rgba(255,255,255,.06)'}; color:${live ? '#101012' : `rgba(237,238,241,${g?.connected ? '.6' : '.3'})`}; box-shadow:inset 0 0 0 1px rgba(255,255,255,${g?.connected ? '.14' : '.07'});`}
              >{SOURCE_LABEL[s.id] ?? s.id}</div>
            )
          })}
        </div>
        {!g?.connected && (
          <div style={css('margin-top:10px; font-size:12px; line-height:1.45; color:rgba(237,238,241,.38);')}>
            These stay dark until you sign in — there’s nothing behind them to read yet.
          </div>
        )}
      </div>

      <div style={css('padding:15px 4px; box-shadow:inset 0 -1px 0 rgba(255,255,255,.06);')}>
        <div style={css('font-size:15px; font-weight:500;')}>Who decides what you see</div>
        <div style={css('margin-top:2px; font-size:12.5px; line-height:1.45; color:rgba(237,238,241,.48);')}>
          {curation === 'auto'
            ? 'I pick what’s worth surfacing, from everything I can see.'
            : 'Only the things you’ve asked me to watch reach the screen.'}
        </div>
        {/* These read "You curate" and "I curate" — two labels a glance apart,
            and no way to tell which one you were on. Say who does the work. */}
        <div style={css('margin-top:11px; display:flex; gap:8px;')}>
          {([['auto', 'Crucible picks'], ['manual', 'You pick']] as const).map(([m, label]) => (
            <div
              key={m}
              onClick={() => void setMode(m)}
              style={cssv`padding:9px 14px; border-radius:999px; font-size:12.5px; cursor:pointer; background:${curation === m ? 'rgba(237,238,241,.92)' : 'rgba(255,255,255,.06)'}; color:${curation === m ? '#101012' : 'rgba(237,238,241,.82)'}; box-shadow:inset 0 0 0 1px rgba(255,255,255,.14);`}
            >{label}</div>
          ))}
        </div>
      </div>

      <div style={css('padding:22px 4px 8px; font-size:11px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:rgba(237,238,241,.3);')}>what I’m watching for you</div>

      {tracks.map((t) => (
        <div key={t.id} style={css('padding:15px 4px; display:flex; align-items:center; gap:14px; box-shadow:inset 0 -1px 0 rgba(255,255,255,.06);')}>
          <div style={cssv`width:40px; height:40px; flex:none; border-radius:11px; background:rgba(255,255,255,.04); display:flex; align-items:center; justify-content:center;`}>
            <div style={cssv`width:7px; height:7px; border-radius:999px; background:${t.active ? '#A98FE0' : 'rgba(237,238,241,.24)'};`} />
          </div>
          <div style={css('flex:1;')}>
            <div style={css('font-size:15px; font-weight:500;')}>{t.what}</div>
            <div style={css('margin-top:2px; font-size:12.5px; color:rgba(237,238,241,.48);')}>
              {t.by === 'agent' ? 'I offered this · ' : ''}every {t.everyHours}h
            </div>
          </div>
          <div onClick={async () => { await removeTrack(t.id); await refresh(); onChanged() }} style={css('font-size:12.5px; color:rgba(240,115,107,.75); cursor:pointer;')}>Stop</div>
        </div>
      ))}

      <div style={css('margin:13px 0 6px; padding:11px 15px; border-radius:22px; background:rgba(30,32,37,.55); box-shadow:inset 0 1px 0 rgba(255,255,255,.16), inset 0 0 0 1px rgba(255,255,255,.09); display:flex; align-items:center; gap:11px;')}>
        <input
          value={draft}
          placeholder="Watch something for me…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
          style={css('flex:1; background:transparent; border:0; outline:0; font-family:inherit; font-size:14px; color:rgba(237,238,241,.92);')}
        />
        <div onClick={() => void add()} style={css('width:30px; height:30px; flex:none; border-radius:999px; background:rgba(237,238,241,.9); display:flex; align-items:center; justify-content:center; color:#0B0B0D; font-size:15px; cursor:pointer;')}>↑</div>
      </div>
      <div style={css('font-size:12px; line-height:1.45; color:rgba(237,238,241,.38); padding:0 2px 8px;')}>
        {note ?? 'Anything answerable — the weather where you walk, a flight, whether that place is open. There’s no list.'}
      </div>
    </>
  )
}

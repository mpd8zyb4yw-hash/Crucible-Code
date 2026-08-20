import { useEffect, useState } from 'react'
import { css, cssv } from './css'
import { INSET } from './tokens'
import { SYSTEM_APPS } from './home/lanes'
import { hideApp, reorderApps, useHomeState } from './home/homeState'
import { failIfPoisoned } from './poison'
import {
  listProviders, saveKey, removeKey, setActive, setRouting, getHealth,
  googleStatus, googleSync, googleDisconnect,
  getSources, putSources, listTracks, addTrack, removeTrack,
  getShelf, arrangeShelf, toggleShelf,
  getPreferences, correct, getDataHealth, applyCorrection,
  type ProviderInfo, type Track, type Rested, type Shelf, type ShelfItem,
  type PreferenceSlot, type DataHealth, type Known,
} from './api'

/**
 * Settings is not a new visual idiom — it is a Report. Same grab-handle
 * header, same tap-the-top-to-close, same row treatment as the quiet group.
 * The design has one way to show a surface and this uses it.
 */
export default function Settings({
  onClose, onChanged, onLayoutChanged,
}: {
  onClose: () => void
  onChanged: () => void
  /**
   * Rearranging is not a reason to think again.
   *
   * Separate from `onChanged` because that one re-runs synthesis: connecting a
   * model or a source genuinely changes what there is to say. Moving a card
   * does not, and on a free tier spending the day's last call on it is how the
   * app comes to be rate limited by its own settings screen.
   */
  onLayoutChanged: () => void
}) {
  const [list, setList] = useState<ProviderInfo[]>([])
  const [active, setActiveId] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  /** Is the provider list showing at all? Closed by default — see `brain-list`. */
  const [brainOpen, setBrainOpen] = useState(false)
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

  // Settings is the screen someone opens BECAUSE something is wrong; it taking
  // the app down with it is the worst possible time for that to happen.
  failIfPoisoned('settings')

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
    <div data-frame="settings" style={css('flex:1; display:flex; flex-direction:column; animation:cruExpand .3s cubic-bezier(.2,.7,.2,1); min-height:0;')}>

      <div data-edge="settings-header" onClick={onClose} style={cssv`flex:none; padding:12px ${INSET.page}px 15px; cursor:pointer; background:linear-gradient(160deg, rgba(38,30,22,.4), rgba(16,14,12,0)); box-shadow:inset 0 -1px 0 rgba(255,255,255,.06);`}>
        <div style={css('width:40px; height:4px; border-radius:999px; background:rgba(237,238,241,.24); margin:0 auto 13px;')} />
        <div style={css('display:flex; align-items:center; justify-content:space-between;')}>
          <div style={css('display:flex; align-items:center; gap:8px; font-size:11px; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:rgba(237,238,241,.6);')}>
            <div style={css('width:6px; height:6px; border-radius:999px; background:#F0A56B;')} />
            the brain
          </div>
          {/*
            ONE EXIT, DRAWN ONCE.

            There were three, stacked: the grab handle above, the word "close",
            and a `⌃` chevron beside it. All three were inside the SAME clickable
            header, so it was never three controls — it was one control wearing
            three hats, which reads as a screen that is unsure how you leave it.

            The handle stays, because it is the idiom that says "this sheet
            dismisses" and it is what a thumb reaches for. The chevron goes: it
            says nothing the word beside it does not. What is left is a real
            button with an accessible name, which is also the first time this
            exit has had one.
          */}
          <button
            type="button"
            data-role="settings-close"
            aria-label="Close settings"
            onClick={onClose}
            style={css(`border:0; background:transparent; padding:0; cursor:pointer; font-family:inherit;
              font-size:11.5px; color:rgba(237,238,241,.42);`)}
          >close</button>
        </div>
        <div style={css('margin-top:11px; font-size:25px; font-weight:600; letter-spacing:-.03em;')}>What I think with</div>
        <div style={css('margin-top:6px; font-size:14px; line-height:1.5; color:rgba(237,238,241,.6); text-wrap:pretty;')}>{status}</div>
      </div>

      {/*
        Settings obeys the same fixed-workspace rule as every application: a
        compact header that does not move, and content that scrolls INSIDE the
        frame. An expanded provider accordion grows this scroller and nothing
        else — it may not resize the application shell.
      */}
      <div data-role="settings-scroll" style={cssv`flex:1; overflow-y:auto; overscroll-behavior:contain; padding:14px ${INSET.page}px 10px; display:flex; flex-direction:column; min-height:0;`}>
        {error && (
          <div style={css('margin-bottom:12px; padding:11px 14px; border-radius:14px; background:rgba(52,32,28,.5); box-shadow:inset 0 0 0 1px rgba(240,115,107,.28); font-size:13px; line-height:1.45; color:#F0938B;')}>{error}</div>
        )}

        {/*
          THE WHOLE BRAIN SECTION IS ONE ROW UNTIL HE ASKS FOR IT.

          Each provider was already an accordion and each provider's models were
          already behind a disclosure — and the screen still opened on six
          provider rows plus the routing card, about 950px before anything else
          in Settings got a pixel. The nesting was one level short: the LIST was
          always expanded, so everything under it was pushed off the screen.

          Closed, it says the two things worth knowing without opening anything —
          which model is thinking, and how many keys are connected. That is the
          same idiom as `Models` one level down, which is what this is: the rule
          applied to the level above it.
        */}
        <div
          data-role="brain-list"
          onClick={() => setBrainOpen((o) => !o)}
          style={css('margin-bottom:6px; padding:14px; border-radius:16px; cursor:pointer; background:rgba(255,255,255,.04); box-shadow:inset 0 0 0 1px rgba(255,255,255,.07); display:flex; align-items:center; gap:12px;')}
        >
          <div style={css('flex:1; min-width:0;')}>
            {/* Not "What I think with" — that is the screen's own title three
                rows above, and a row repeating its page header is a row that
                looks like a bug. */}
            <div style={css('font-size:15px; font-weight:500;')}>Models and keys</div>
            <div style={css('margin-top:3px; font-size:12.5px; color:rgba(237,238,241,.5); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>
              {list.find((p) => p.id === active)?.model ?? 'nothing connected yet'}
              {` · ${list.filter((p) => p.configured).length} connected`}
            </div>
          </div>
          <div style={css('font-size:16px; color:rgba(237,238,241,.28);')}>{brainOpen ? '⌃' : '›'}</div>
        </div>

        {brainOpen && (<>
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
                data-role="provider"
                data-provider={p.id}
                onClick={() => { setOpen(isOpen ? null : p.id); setDraft(''); setError(null) }}
                style={css('padding:15px 0; cursor:pointer; display:flex; align-items:center; gap:14px;')}
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
                <div style={css('padding:0 0 15px; display:flex; flex-direction:column; gap:10px;')}>
                  {!p.configured ? (
                    <>
                      <div style={css('padding:11px 15px; border-radius:22px; background:rgba(30,32,37,.55); box-shadow:inset 0 1px 0 rgba(255,255,255,.16), inset 0 0 0 1px rgba(255,255,255,.09); display:flex; align-items:center; gap:11px;')}>
                        {/*
                          NO autoFocus. It was here, and it is why tapping a
                          provider row summoned the keyboard: expanding an
                          unconnected provider immediately focused this field,
                          iOS shrank the visual viewport by ~340px, and the
                          whole app relaid out around a keyboard he had not
                          asked for — from a tap on what is, to the hand, a
                          disclosure triangle.

                          A provider row is a button. The keyboard belongs to
                          the person who taps the field, and to nobody else.
                        */}
                        <input
                          type="password"
                          value={draft}
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
        </>)}

        <Apps />

        <HowIWork onChanged={onChanged} />

        <Layout onChanged={onLayoutChanged} />

        <Knowledge onChanged={onChanged} />

        <Sight onChanged={onChanged} />
      </div>
    </div>
  )
}

/**
 * HOW MUCH IT SPEAKS, AND WHETHER IT ASKS OR ASSUMES.
 *
 * These two preferences existed as fields the ranker obeyed and the person they
 * described could not reach. `assistant.proactivity` has been read by `fitOf` since
 * the attention model landed, and the only way to set it was to POST to the
 * correction endpoint by hand — so "this app talks too much" was a complaint with
 * nowhere to go, about behaviour the app was fully capable of changing.
 *
 * They are ALSO asked as questions, at the moment they would change something: the
 * insight pass demands `assistant.proactivity` once the ranking has visibly held
 * things back. This section is the other half — the place someone looks when they
 * want to change it without waiting to be asked, which is how people actually reach
 * for a setting like this.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE: no option is pre-selected. "You have not said"
 * and "you chose the middle one" are different states, and only the first should
 * still be askable — so nothing is highlighted until he has actually chosen, and the
 * default behaviour is described in words instead.
 */
function HowIWork({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [slots, setSlots] = useState<PreferenceSlot[]>([])
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = async () => {
    const r = await getPreferences().catch(() => null)
    // Shape-checked rather than null-checked, for the reason `Sight` gives: a
    // half-written response reaching `.map` takes down the one screen someone
    // opens because something is wrong.
    if (r && Array.isArray(r.slots)) setSlots(r.slots)
  }
  useEffect(() => { void refresh() }, [])

  const choose = async (key: string, value: string, label: string) => {
    setBusy(key)
    try {
      /**
       * The same `set-preference` correction a tapped chip on Home sends.
       *
       * Not a settings-specific endpoint, and that matters: one write path means one
       * set of guarantees. It lands as `by: 'user'`, which `mayReplace` treats as
       * permanent, so the next synthesis pass cannot quietly re-infer over it.
       */
      const out = await correct({ verb: 'set-preference', label, key, value })
      setNote(out.said)
      await refresh()
      // Re-rank the feed: this changes what reaches Home, not just what is stored.
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  const sections = [...new Set(slots.map((s) => s.section))]

  return (
    <div style={css('box-shadow:inset 0 -1px 0 rgba(255,255,255,.06);')}>
      <div onClick={() => setOpen((o) => !o)} style={css('padding:15px 0; cursor:pointer; display:flex; align-items:center; gap:14px;')}>
        <div style={css('width:40px; height:40px; flex:none; border-radius:11px; background:rgba(255,255,255,.04); display:flex; align-items:center; justify-content:center; font-size:17px;')}>
          ◐
        </div>
        <div style={css('flex:1; min-width:0;')}>
          <div style={css('font-size:14px; font-weight:600; color:rgba(237,238,241,.92);')}>How I work</div>
          <div style={css('font-size:12px; color:rgba(237,238,241,.45); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>
            {slots.filter((s) => s.value !== null).length
              ? slots.filter((s) => s.value !== null).map((s) => `${s.label}: ${String(s.value)}`).join(' · ')
              : 'How much I raise, and whether I ask or guess'}
          </div>
        </div>
        <div style={css('flex:none; color:rgba(237,238,241,.35); font-size:13px;')}>{open ? '⌃' : '⌄'}</div>
      </div>

      {open && (
        <div style={css('padding:0 0 16px; display:flex; flex-direction:column; gap:16px;')}>
          {!slots.length && (
            <div style={css('font-size:12.5px; color:rgba(237,238,241,.45);')}>Nothing to set yet.</div>
          )}
          {sections.map((section) => (
            <div key={section} style={css('display:flex; flex-direction:column; gap:12px;')}>
              {slots
                .filter((s) => s.section === section)
                .map((s) => (
                  <div key={s.key} style={css('display:flex; flex-direction:column; gap:7px;')}>
                    <div style={css('font-size:12.5px; color:rgba(237,238,241,.8);')}>{s.question}</div>
                    <div style={css('font-size:11.5px; color:rgba(237,238,241,.4);')}>
                      {/* What answering buys him, in his terms. A setting that does
                          not say what it changes is a setting nobody touches. */}
                      {s.unlocks}
                    </div>
                    <div style={css('display:flex; gap:6px; flex-wrap:wrap;')}>
                      {s.options.map((o) => {
                        const on = s.value === o.value
                        return (
                          <button
                            key={o.value}
                            disabled={busy === s.key}
                            onClick={() => choose(s.key, o.value, o.label)}
                            style={cssv`appearance:none; border:1px solid rgba(255,255,255,${on ? '.28' : '.1'}); background:rgba(255,255,255,${on ? '.12' : '.03'}); color:rgba(237,238,241,${on ? '.95' : '.65'}); font-size:12px; font-weight:${on ? '600' : '500'}; padding:6px 11px; border-radius:999px; cursor:pointer;`}
                          >
                            {o.label}
                          </button>
                        )
                      })}
                    </div>
                    {s.value === null && (
                      <div style={css('font-size:11.5px; color:rgba(237,238,241,.34);')}>
                        {/* Stated rather than shown as a selected chip — see the
                            comment on this component about not pre-selecting. */}
                        You have not said. I am using a middle setting until you do.
                      </div>
                    )}
                  </div>
                ))}
            </div>
          ))}
          {note && <div style={css('font-size:12px; color:rgba(143,224,174,.85);')}>{note}</div>}
        </div>
      )}
    </div>
  )
}

/**
 * His home screen: what is on it, in what order.
 *
 * Up and down rather than drag-and-drop, deliberately. Dragging inside a
 * scrolling column on a touch screen is the interaction people get wrong most
 * often, and it fails silently — the list scrolls instead of the row moving and
 * there is nothing to tell you which one you did. Two taps is slower and always
 * works.
 *
 * Every change here is written straight through to the server, so it survives a
 * reload and follows him to his phone. Nothing is staged and there is no save
 * button: a layout that needed confirming would be a layout he could lose.
 */
/**
 * THE SYSTEM APPS — his order, and what he hid.
 *
 * These are the permanent first-class capabilities. They cannot be deleted;
 * they can be hidden, and they can be reordered, and once he has expressed an
 * order nothing else touches it. Relevance changes what an app's card SAYS on
 * Home; it never changes where the app sits, because a row of capabilities that
 * reshuffles daily is a row the hand cannot learn.
 *
 * This is separate from "Home screen" below on purpose. That answers what may
 * appear on the splash at all; this answers where the permanent apps sit within
 * their own lane, which is a different question with a different lifetime.
 */
function Apps() {
  const [open, setOpen] = useState(false)
  const { durable } = useHomeState()

  const order = [
    ...durable.systemOrder.filter((id) => SYSTEM_APPS.some((a) => a.id === id)),
    ...SYSTEM_APPS.map((a) => a.id).filter((id) => !durable.systemOrder.includes(id)),
  ]
  const hidden = new Set(durable.hiddenApps)

  const move = (i: number, by: -1 | 1) => {
    const j = i + by
    if (j < 0 || j >= order.length) return
    const next = [...order]
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    reorderApps(next)
  }

  return (
    <div style={css('box-shadow:inset 0 -1px 0 rgba(255,255,255,.06);')}>
      <div onClick={() => setOpen((o) => !o)} style={css('padding:15px 0; cursor:pointer; display:flex; align-items:center; gap:14px;')}>
        <div style={css('width:40px; height:40px; flex:none; border-radius:11px; background:rgba(255,255,255,.04); display:grid; grid-template-columns:1fr 1fr; gap:3px; padding:10px;')}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={cssv`border-radius:3px; background:rgba(237,238,241,${i ? '.22' : '.7'});`} />
          ))}
        </div>
        <div style={css('flex:1;')}>
          <div style={css('font-size:15px; font-weight:500;')}>What stays in the deck</div>
          <div style={css('margin-top:2px; font-size:12.5px; color:rgba(237,238,241,.48);')}>
            {`${order.length - hidden.size} in the deck${hidden.size ? `, ${hidden.size} off` : ''} · your order`}
          </div>
        </div>
        <div style={css('font-size:16px; color:rgba(237,238,241,.28);')}>{open ? '⌃' : '›'}</div>
      </div>

      {open && (
        <div style={css('padding:0 0 15px; display:flex; flex-direction:column; gap:6px;')}>
          {order.map((id, i) => {
            const app = SYSTEM_APPS.find((a) => a.id === id)!
            const on = !hidden.has(id)
            return (
              <div
                key={id}
                style={cssv`display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:13px;
                  background:rgba(255,255,255,${on ? '.05' : '.02'}); box-shadow:inset 0 0 0 1px rgba(255,255,255,.06);`}
              >
                <div style={css('display:flex; flex-direction:column; gap:2px;')}>
                  <div
                    onClick={() => move(i, -1)}
                    style={cssv`width:22px; height:17px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:11px; background:rgba(255,255,255,.06); color:rgba(237,238,241,${i === 0 ? '.16' : '.6'}); cursor:${i === 0 ? 'default' : 'pointer'};`}
                  >▲</div>
                  <div
                    onClick={() => move(i, 1)}
                    style={cssv`width:22px; height:17px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:11px; background:rgba(255,255,255,.06); color:rgba(237,238,241,${i === order.length - 1 ? '.16' : '.6'}); cursor:${i === order.length - 1 ? 'default' : 'pointer'};`}
                  >▼</div>
                </div>
                <div style={cssv`flex:1; min-width:0; font-size:13.5px; font-weight:500; color:rgba(237,238,241,${on ? '.92' : '.4'});`}>
                  {app.label}
                </div>
                {/* Hide, never delete. A first-class capability he switched off
                    is still a capability; the switch says so by staying here. */}
                {/* The design's switch, to the pixel: 38×22, an 18px knob, and
                    green for on — the same green the rest of the app uses for
                    "this is live" rather than the accent, which means "time". */}
                <div
                  onClick={() => hideApp(id, on)}
                  style={cssv`width:38px; height:22px; flex:none; border-radius:999px; cursor:pointer; padding:2px;
                    box-sizing:border-box; display:flex; justify-content:${on ? 'flex-end' : 'flex-start'};
                    background:${on ? 'rgba(95,201,166,.55)' : 'rgba(255,255,255,.1)'};`}
                >
                  <div style={cssv`width:18px; height:18px; border-radius:999px; background:${on ? '#0B0B0D' : 'rgba(237,238,241,.42)'};`} />
                </div>
              </div>
            )
          })}
          {/*
            THE ONE THING THAT CAN TAKE A DOMAIN OUT OF THE DECK.

            A domain that is on keeps its place whether or not it has news — a
            quiet one just gets a quieter widget. Ranking chooses which widget he
            LANDS on; it never chooses which ones exist, and it never touches an
            order he has expressed here.
          */}
          <div style={css('font-size:11.5px; line-height:1.45; color:rgba(237,238,241,.34); padding:4px 2px 0;')}>
            A domain that is on keeps its place in the deck whether or not it has news. Turning it off
            here is the only thing that removes it — and I never reorder them for you.
          </div>
        </div>
      )}
    </div>
  )
}

function Layout({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<ShelfItem[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    try {
      setItems((await getShelf()).items)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => { if (open) void load() }, [open])

  /** Optimistic, then reconciled with what the server actually stored. */
  const commit = async (next: ShelfItem[], write: () => Promise<Shelf>) => {
    setItems(next)
    setBusy(true)
    try {
      setItems((await write()).items)
      onChanged()
      setError(null)
    } catch (e) {
      setError((e as Error).message)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const move = (i: number, by: -1 | 1) => {
    const j = i + by
    if (j < 0 || j >= items.length) return
    const next = [...items]
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    void commit(next, () => arrangeShelf(next.map((x) => x.id)))
  }

  const flip = (item: ShelfItem) =>
    void commit(
      items.map((x) => (x.id === item.id ? { ...x, on: !x.on, by: 'user' } : x)),
      () => toggleShelf(item.id, !item.on)
    )

  const hidden = items.filter((i) => !i.on).length

  return (
    <div style={css('box-shadow:inset 0 -1px 0 rgba(255,255,255,.06);')}>
      <div onClick={() => setOpen((o) => !o)} style={css('padding:15px 0; cursor:pointer; display:flex; align-items:center; gap:14px;')}>
        <div style={css('width:40px; height:40px; flex:none; border-radius:11px; background:rgba(255,255,255,.04); display:flex; flex-direction:column; justify-content:center; gap:3px; padding:0 10px;')}>
          <div style={css('height:3px; border-radius:2px; background:#F0A56B;')} />
          <div style={css('height:3px; border-radius:2px; width:70%; background:rgba(237,238,241,.26);')} />
          <div style={css('height:3px; border-radius:2px; width:45%; background:rgba(237,238,241,.26);')} />
        </div>
        <div style={css('flex:1;')}>
          <div style={css('font-size:15px; font-weight:500;')}>Home screen</div>
          <div style={css('margin-top:2px; font-size:12.5px; color:rgba(237,238,241,.48);')}>
            {items.length
              ? `${items.length - hidden} showing${hidden ? `, ${hidden} hidden` : ''} · drag-free reordering`
              : 'What’s on it, and in what order'}
          </div>
        </div>
        <div style={css('font-size:16px; color:rgba(237,238,241,.28);')}>{open ? '⌃' : '›'}</div>
      </div>

      {open && (
        <div style={css('padding:0 0 15px; display:flex; flex-direction:column; gap:6px;')}>
          {error && <div style={css('font-size:12.5px; color:rgba(240,115,107,.8); padding:0 2px 4px;')}>{error}</div>}
          {!items.length && (
            <div style={css('font-size:12.5px; line-height:1.45; color:rgba(237,238,241,.38); padding:2px;')}>
              Nothing to arrange yet. Connect something, or ask for a pane, and it’ll appear here.
            </div>
          )}
          {items.map((item, i) => (
            <div
              key={item.id}
              style={cssv`display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:13px; background:rgba(255,255,255,${item.on ? '.05' : '.02'}); box-shadow:inset 0 0 0 1px rgba(255,255,255,.06);${busy ? ' opacity:.6;' : ''}`}
            >
              <div style={css('display:flex; flex-direction:column; gap:2px;')}>
                <div
                  onClick={() => move(i, -1)}
                  style={cssv`width:22px; height:17px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:11px; background:rgba(255,255,255,.06); color:rgba(237,238,241,${i === 0 ? '.16' : '.6'}); cursor:${i === 0 ? 'default' : 'pointer'};`}
                >▲</div>
                <div
                  onClick={() => move(i, 1)}
                  style={cssv`width:22px; height:17px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:11px; background:rgba(255,255,255,.06); color:rgba(237,238,241,${i === items.length - 1 ? '.16' : '.6'}); cursor:${i === items.length - 1 ? 'default' : 'pointer'};`}
                >▼</div>
              </div>
              <div style={css('flex:1; min-width:0;')}>
                <div style={cssv`font-size:13.5px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:rgba(237,238,241,${item.on ? '.92' : '.4'});`}>
                  {item.label}
                </div>
                <div style={css('margin-top:1px; font-size:11px; color:rgba(237,238,241,.34);')}>
                  {item.kind === 'synthesis' ? 'what I think needs you' : item.kind === 'pane' ? 'a pane you asked for' : 'a connected source'}
                  {/* Whose decision this row's place is. The one thing that
                      makes "customizable by user or AI" unambiguous. */}
                  {item.by === 'user' ? ' · your placement' : ''}
                </div>
              </div>
              <div
                onClick={() => flip(item)}
                style={cssv`width:40px; height:24px; flex:none; border-radius:999px; cursor:pointer; padding:3px; display:flex; justify-content:${item.on ? 'flex-end' : 'flex-start'}; background:${item.on ? 'rgba(240,165,107,.55)' : 'rgba(255,255,255,.09)'};`}
              >
                <div style={css('width:18px; height:18px; border-radius:999px; background:rgba(237,238,241,.92);')} />
              </div>
            </div>
          ))}
          {items.length > 0 && (
            <div style={css('font-size:11.5px; line-height:1.45; color:rgba(237,238,241,.34); padding:4px 2px 0;')}>
              Anything you move or switch off stays where you put it — I add new things at the bottom and leave the rest alone.
            </div>
          )}
        </div>
      )}
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
  failIfPoisoned('provider')
  const resting = new Map(rested.map((r) => [r.model, r]))
  const [open, setOpen] = useState(false)
  /** The one model whose detail is expanded. Nested inside the provider row. */
  const [detail, setDetail] = useState<string | null>(null)

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
      <div data-role="models" onClick={() => setOpen((o) => !o)} style={css('padding:12px 14px; display:flex; align-items:center; gap:12px; cursor:pointer;')}>
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
                const shown = detail === m
                return (
                  <div key={m}>
                    {/*
                      THE THIRD LEVEL.

                      Tapping a model opens its detail inline rather than
                      switching to it. Selecting a model is a real change — it
                      decides what thinks about his life — and a list where a
                      mis-tap silently reassigns that is a list nobody can browse.
                      Open, read why it is resting or refused, then choose.
                    */}
                    <div
                      data-model={m}
                      onClick={() => setDetail(shown ? null : m)}
                      style={css('padding:9px 14px; display:flex; align-items:center; gap:10px; cursor:pointer;')}
                    >
                      <div style={css('flex:1; min-width:0;')}>
                        <div style={cssv`font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:rgba(237,238,241,${why ? '.32' : current ? '.95' : '.75'});`}>{m}</div>
                        {/* The provider's own words. "Not available on your plan"
                            beside the model beats a red banner above the list. */}
                        {why && !shown && (
                          <div style={css('margin-top:2px; font-size:11px; line-height:1.4; color:rgba(240,147,139,.72);')}>{gist(why)}</div>
                        )}
                      </div>
                      {current && <div style={css('font-size:12px; color:#5FC9A6;')}>✓</div>}
                      <div style={css('font-size:12px; color:rgba(237,238,241,.26);')}>{shown ? '⌃' : '›'}</div>
                    </div>

                    {shown && (
                      <div style={css('padding:0 14px 12px; display:flex; flex-direction:column; gap:8px;')}>
                        {why && (
                          <div style={css('font-size:11.5px; line-height:1.45; color:rgba(240,147,139,.75);')}>{gist(why)}</div>
                        )}
                        <div style={css('font-size:11.5px; line-height:1.45; color:rgba(237,238,241,.4);')}>
                          {current
                            ? 'This is the model this key thinks with.'
                            : rest
                              ? `Resting — ${rest.why}. It comes back on its own.`
                              : 'Available. Crucible can still route around it when it’s out of budget.'}
                        </div>
                        {!current && (
                          <div
                            onClick={() => { if (!busy) onPick(m) }}
                            style={css('align-self:flex-start; padding:8px 13px; border-radius:11px; background:rgba(237,238,241,.9); color:#0B0B0D; font-size:12.5px; font-weight:600; cursor:pointer;')}
                          >Think with this model</div>
                        )}
                      </div>
                    )}
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
/**
 * WHAT I KNOW, WHERE IT CAME FROM, AND WHAT IS ROTTING.
 *
 * The product rule this screen exists to make checkable: no intelligent card may
 * contain information that cannot be traced back to a typed fact, a
 * deterministic computation, or an explicitly marked inference — and every
 * important inference must be inspectable and correctable from the interface
 * that displays it.
 *
 * "Why this?" answers that question one card at a time. This answers it for the
 * whole model at once, which is a different and necessary thing: a wrong belief
 * is cheapest to catch BEFORE it turns up wearing a confident sentence on his
 * home screen, and until now the only way to look was to read the stored JSON.
 *
 * WHAT IS DELIBERATELY ABSENT. There is no health score. A single percentage
 * over four incommensurable things — facts, sources, disagreements, questions —
 * would be a number nobody could act on, and this codebase has already lost a
 * session to one invented figure. What is shown instead are counts of named
 * states, each of which opens.
 *
 * The unresolved things come FIRST, before the inventory. A screen that led with
 * "47 things known" and buried "two sources disagree and you have not ruled"
 * would be flattering itself.
 */
function Knowledge({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [h, setH] = useState<DataHealth | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Which of the two inventories is showing. Facts by default; sources on tap. */
  const [tab, setTab] = useState<'facts' | 'sources'>('facts')
  const [said, setSaid] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const got = await getDataHealth()
      /**
       * SHAPE-CHECKED, NOT JUST NULL-CHECKED.
       *
       * The same rule `Sight` below learned the hard way: a degraded or
       * half-written response reaches `.map` as `undefined` and takes down the
       * one screen someone opens BECAUSE something is wrong. A report this
       * screen cannot read is an error to state, not an exception to throw.
       */
      if (!got || !Array.isArray(got.known) || !got.unresolved || !got.counts) {
        setError('I could not read my own records just now.')
        return
      }
      setH({
        ...got,
        sources: Array.isArray(got.sources) ? got.sources : [],
        unresolved: {
          disagreements: got.unresolved.disagreements ?? [],
          questions: got.unresolved.questions ?? [],
          decayed: got.unresolved.decayed ?? [],
        },
      })
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => { if (open && !h) void refresh() }, [open])

  /**
   * FORGETTING SOMETHING FROM HERE IS THE SAME VERB AS FORGETTING IT FROM A CARD.
   *
   * `forget` against the fact's own key — the closed correction set, the one
   * implementation, the same `by: 'user'` record. A settings screen with its own
   * private deletion path would be a second way to change the model, and the
   * second way is always the one that forgets to record who did it.
   */
  const forget = async (k: Known) => {
    setSaid('…')
    const out = await applyCorrection({
      verb: 'forget',
      label: `Forget ${k.key}`,
      target: { kind: k.bag === 'identity' ? 'fact' : 'preference', id: k.key },
    })
    setSaid(out.said)
    await refresh()
    onChanged()
  }

  const trouble = h
    ? h.unresolved.disagreements.length + h.unresolved.questions.length + h.unresolved.decayed.length
    : 0

  return (
    <div style={css('box-shadow:inset 0 -1px 0 rgba(255,255,255,.06);')}>
      <div onClick={() => setOpen((o) => !o)} style={css('padding:15px 0; cursor:pointer; display:flex; align-items:center; gap:14px;')}>
        <div style={css('width:40px; height:40px; flex:none; border-radius:11px; background:rgba(255,255,255,.04); display:flex; align-items:center; justify-content:center; font-size:17px;')}>◍</div>
        <div style={css('flex:1;')}>
          <div style={css('font-size:15px; font-weight:500;')}>What I know</div>
          <div style={css('margin-top:2px; font-size:12.5px; color:rgba(237,238,241,.48);')}>
            {h
              ? `${h.counts.known} things · ${h.counts.fromHim} from you${trouble ? ` · ${trouble} unresolved` : ''}`
              : 'Everything I believe, and where it came from'}
          </div>
        </div>
        <div style={css('font-size:16px; color:rgba(237,238,241,.28);')}>{open ? '⌃' : '›'}</div>
      </div>

      {open && (
        <div style={css('padding:0 0 15px; display:flex; flex-direction:column; gap:10px;')}>
          {error && <div style={css('font-size:12.5px; color:rgba(240,115,107,.8);')}>{error}</div>}
          {!h && !error && <div style={css('font-size:12.5px; color:rgba(237,238,241,.4);')}>Reading…</div>}

          {h && (
            <>
              {/* ── WHAT IS ACTUALLY WRONG ─────────────────────────────────── */}
              {trouble === 0 ? (
                <div style={css('font-size:12.5px; line-height:1.5; color:rgba(143,224,174,.8);')}>
                  Nothing is in dispute, nothing is waiting on you, and nothing I believe has outlived its evidence.
                </div>
              ) : (
                <div style={css('display:flex; flex-direction:column; gap:7px;')}>
                  {h.unresolved.disagreements.map((d) => (
                    <Trouble
                      key={`${d.metric}-${d.scope}`}
                      tone="rgba(240,165,107,.85)"
                      head={`Two sources disagree about ${d.metric}`}
                      /* The numbers themselves, not a characterisation of them.
                         "They disagree" is not something he can rule on. */
                      body={`${d.readings.map((r) => `${r.source} says ${r.value.toLocaleString()}`).join(' · ')} — ${d.differencePercent}% apart, for ${d.scopeLabel || d.scope}. I will not report a figure until you say which to trust.`}
                    />
                  ))}
                  {h.unresolved.questions.map((q) => (
                    <Trouble
                      key={q.key}
                      tone="rgba(169,143,224,.85)"
                      head={`I do not know: ${q.key}`}
                      body={`${q.why}. ${q.wanted} thing${q.wanted === 1 ? '' : 's'} have wanted it${q.asked ? `; I have asked ${q.asked} time${q.asked === 1 ? '' : 's'}` : ' and I have not asked yet'}.`}
                    />
                  ))}
                  {h.unresolved.decayed.map((b) => (
                    <Trouble
                      key={b.id}
                      tone="rgba(237,238,241,.5)"
                      head={b.statement}
                      body={
                        b.contested
                          ? `The evidence under this moved: ${b.contested}`
                          : `Last confirmed ${b.confirmedLabel}. I no longer trust it enough to use it.`
                      }
                    />
                  ))}
                </div>
              )}

              {/* ── THE INVENTORY ──────────────────────────────────────────── */}
              <div style={css('display:flex; gap:6px;')}>
                {(['facts', 'sources'] as const).map((t) => (
                  <div
                    key={t}
                    onClick={() => setTab(t)}
                    style={cssv`padding:6px 12px; border-radius:999px; cursor:pointer; font-size:12px;
                      background:rgba(255,255,255,${tab === t ? '.10' : '.04'});
                      color:rgba(237,238,241,${tab === t ? '.85' : '.45'});`}
                  >{t === 'facts' ? `${h.counts.known} things I hold` : `${h.sources.length} sources`}</div>
                ))}
              </div>

              {tab === 'facts' && h.known.map((k) => (
                <div
                  key={`${k.bag}:${k.key}`}
                  style={css('display:flex; flex-direction:column; gap:3px; padding:9px 10px; border-radius:13px; background:rgba(255,255,255,.035); box-shadow:inset 0 0 0 1px rgba(255,255,255,.05);')}
                >
                  <div style={css('display:flex; align-items:baseline; gap:8px;')}>
                    <div style={css('flex:1; min-width:0; font-size:13px; color:rgba(237,238,241,.9); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;')}>{k.value}</div>
                    {/*
                      WHO PUT IT THERE, at a glance, in colour.

                      The single most useful field on this screen: "you told me"
                      and "I worked it out" carry completely different authority,
                      and a reader who cannot tell them apart cannot know which
                      lines are worth arguing with.
                    */}
                    <div style={cssv`flex:none; font-size:10.5px; font-weight:600; letter-spacing:.05em; text-transform:uppercase;
                      color:${k.by === 'user' ? 'rgba(143,224,174,.85)' : k.by === 'connector' ? 'rgba(127,179,213,.8)' : 'rgba(240,165,107,.8)'};`}>
                      {k.by === 'user' ? 'you said' : k.by === 'connector' ? k.source : 'I worked it out'}
                    </div>
                  </div>
                  <div style={css('font-size:11px; color:rgba(237,238,241,.35);')}>
                    {k.key} · {k.atLabel}
                    {k.freshness === 'stale' ? ' · not seen in months' : k.freshness === 'ageing' ? ' · getting old' : ''}
                    {k.disputed ? ' · in dispute' : ''}
                  </div>
                  {/* A thing he said is his to withdraw; a thing I worked out is
                      his to reject. One verb, and it says what it did. */}
                  <div style={css('display:flex; gap:6px; padding-top:3px;')}>
                    <div
                      onClick={() => void forget(k)}
                      style={css('font-size:11px; padding:4px 10px; border-radius:999px; cursor:pointer; background:rgba(255,255,255,.05); color:rgba(237,238,241,.55);')}
                    >{k.by === 'user' ? 'I did not say that' : 'That’s wrong'}</div>
                  </div>
                </div>
              ))}

              {tab === 'sources' && h.sources.map((s) => (
                <div
                  key={s.id}
                  style={css('display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:13px; background:rgba(255,255,255,.035); box-shadow:inset 0 0 0 1px rgba(255,255,255,.05);')}
                >
                  <div style={cssv`width:6px; height:6px; flex:none; border-radius:999px;
                    background:${s.freshness === 'live' || s.freshness === 'recent' ? 'rgba(143,224,174,.9)' : s.freshness === 'ageing' ? 'rgba(240,165,107,.9)' : 'rgba(240,115,107,.9)'};`} />
                  <div style={css('flex:1; min-width:0;')}>
                    <div style={css('font-size:13px; color:rgba(237,238,241,.9);')}>{s.id}</div>
                    <div style={css('font-size:11px; color:rgba(237,238,241,.35);')}>
                      {s.records.toLocaleString()} records · newest {s.newestLabel ?? 'never'}
                      {s.authoritativeFor.length ? ` · you trust it for ${s.authoritativeFor.join(', ')}` : ''}
                    </div>
                  </div>
                </div>
              ))}

              {said && (
                <div style={css('font-size:12px; line-height:1.45; color:rgba(255,220,170,.9);')}>{said}</div>
              )}

              <div style={css('font-size:11.5px; line-height:1.45; color:rgba(237,238,241,.34); padding:2px 2px 0;')}>
                Everything on my home screen traces back to something on this page. If a card is wrong, the thing it stands on is here.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** One unresolved thing. Deliberately plain: this is not a notification. */
function Trouble({ tone, head, body }: { tone: string; head: string; body: string }) {
  return (
    <div style={css('display:flex; gap:9px; padding:9px 10px; border-radius:13px; background:rgba(255,255,255,.035);')}>
      <div style={cssv`width:3px; flex:none; border-radius:2px; background:${tone};`} />
      <div style={css('flex:1; min-width:0;')}>
        <div style={cssv`font-size:13px; color:${tone};`}>{head}</div>
        <div style={css('margin-top:3px; font-size:11.5px; line-height:1.45; color:rgba(237,238,241,.5);')}>{body}</div>
      </div>
    </div>
  )
}

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
    // Shape-checked, not just null-checked. A degraded or half-written response
    // used to reach `.map` as `undefined` and take the whole settings screen
    // down with it — the one screen someone opens BECAUSE something is wrong.
    if (sr && Array.isArray(sr.sources)) { setSources(sr.sources); setCuration(sr.curation ?? 'auto') }
    if (tr && Array.isArray(tr.tracks)) setTracks(tr.tracks)
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
      <div style={css('padding:22px 0 8px; font-size:11px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:rgba(237,238,241,.3);')}>what I can see</div>

      <div style={css('box-shadow:inset 0 -1px 0 rgba(255,255,255,.06); padding:15px 0; display:flex; align-items:center; gap:14px;')}>
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
      <div style={css('padding:13px 0 15px; box-shadow:inset 0 -1px 0 rgba(255,255,255,.06);')}>
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

      <div style={css('padding:15px 0; box-shadow:inset 0 -1px 0 rgba(255,255,255,.06);')}>
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

      <div style={css('padding:22px 0 8px; font-size:11px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:rgba(237,238,241,.3);')}>what I’m watching for you</div>

      {tracks.map((t) => (
        <div key={t.id} style={css('padding:15px 0; display:flex; align-items:center; gap:14px; box-shadow:inset 0 -1px 0 rgba(255,255,255,.06);')}>
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

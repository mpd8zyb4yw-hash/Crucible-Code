import { useState } from 'react'
import { css, cssv } from './css'
import { accentOf, askSkin, skinOf } from './heat'
import Widgets from './Widgets'
import type { Need, WidgetAction } from './api'

export interface Msg { who: 'me' | 'ai'; text: string }

interface Props {
  need: Need
  thread: Msg[]
  done: boolean
  onSay: (need: Need, text: string) => Promise<void>
  onClose: () => void
  /** Perform a widget action. Throws to surface the failure inside the widget. */
  onAction: (need: Need, action: WidgetAction) => Promise<void>
}

export default function Report({ need, thread, done, onSay, onClose, onAction }: Props) {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  /**
   * One way in. A chip used to paste a pre-written answer straight into the
   * thread without the model ever seeing it, so tapping "Sync it now" replied
   * with a canned line and synced nothing — three taps, three identical dead
   * replies. A chip is his words now, and goes the same way typing them does.
   */
  const send = async (what?: string) => {
    const text = (what ?? draft).trim()
    if (!text || sending) return
    if (what === undefined) setDraft('')
    setSending(true)
    try {
      await onSay(need, text)
    } finally {
      setSending(false)
    }
  }

  // The ask card is the composer opened up, not a need the model raised, so it
  // carries its own skin rather than a heat.
  const s = need.id === 'ask' ? askSkin : skinOf(done ? 'handled' : need.heat)
  const raw: Msg[] = [{ who: 'ai', text: need.opening }, ...thread]

  return (
    <div style={css('flex:1; display:flex; flex-direction:column; animation:cruExpand .3s cubic-bezier(.2,.7,.2,1); min-height:0;')}>
      <div onClick={onClose} style={cssv`flex:none; padding:12px 20px 15px; cursor:pointer; background:${s.headerBg}; box-shadow:inset 0 -1px 0 rgba(255,255,255,.06);`}>
        <div style={css('width:40px; height:4px; border-radius:999px; background:rgba(237,238,241,.24); margin:0 auto 13px;')} />
        <div style={css('display:flex; align-items:center; justify-content:space-between;')}>
          <div style={cssv`display:flex; align-items:center; gap:8px; font-size:11px; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:${s.labelColor};`}>
            <div style={cssv`width:6px; height:6px; border-radius:999px; background:${s.dot};`} />
            {done ? 'handled' : need.heatLabel}
          </div>
          <div style={css('display:flex; align-items:center; gap:6px; font-size:11.5px; color:rgba(237,238,241,.42);')}>
            close <span style={css('font-size:14px;')}>⌃</span>
          </div>
        </div>
        <div style={css('margin-top:11px; font-size:25px; font-weight:600; letter-spacing:-.03em;')}>{need.title}</div>
        <div style={css('margin-top:6px; font-size:14px; line-height:1.5; color:rgba(237,238,241,.6); text-wrap:pretty;')}>{need.status}</div>
      </div>

      <div style={css('flex:1; overflow-y:auto; padding:14px 18px 10px; display:flex; flex-direction:column; gap:14px; min-height:0;')}>
        {need.stats && (
          <div style={css('display:flex; gap:9px;')}>
            {need.stats.map((st, i) => (
              <div key={i} style={css('flex:1; padding:12px 13px; border-radius:15px; background:rgba(255,255,255,.05); box-shadow:inset 0 0 0 1px rgba(255,255,255,.07);')}>
                <div style={css('font-size:11px; color:rgba(237,238,241,.48);')}>{st.l}</div>
                <div style={st.accent
                  ? cssv`margin-top:5px; font-size:18px; font-weight:600; letter-spacing:-.02em; color:${accentOf(st.accent, need.heat)};`
                  : css('margin-top:5px; font-size:18px; font-weight:600; letter-spacing:-.02em;')}>{st.v}</div>
              </div>
            ))}
          </div>
        )}

        {/* The card opens into the THING, above the conversation about it.
            Mail is a list of messages you can read and reply to; a calendar is
            an agenda you can RSVP from. The thread stays underneath rather than
            being replaced — it is still the place to ask about what you see. */}
        {need.panes?.length ? (
          <Widgets panes={need.panes} heat={need.heat} onAction={(a) => onAction(need, a)} />
        ) : null}

        <div style={css('display:flex; flex-direction:column; gap:10px; padding-top:2px;')}>
          {raw.map((m, i) => {
            const b = m.who === 'ai'
              ? { justify: 'flex-start', radius: '16px 16px 16px 5px', bg: 'rgba(255,255,255,.06)', fg: 'rgba(237,238,241,.92)', shadow: 'inset 0 0 0 1px rgba(255,255,255,.05)' }
              : { justify: 'flex-end', radius: '16px 16px 5px 16px', bg: 'rgba(237,238,241,.92)', fg: '#101012', shadow: 'none' }
            return (
              <div key={i} style={cssv`display:flex; justify-content:${b.justify}; animation:cruRise .3s ease;`}>
                <div style={cssv`max-width:82%; padding:11px 14px; border-radius:${b.radius}; background:${b.bg}; color:${b.fg}; font-size:13.5px; line-height:1.5; box-shadow:${b.shadow}; text-wrap:pretty;`}>{m.text}</div>
              </div>
            )
          })}
        </div>

        {/* What this rests on. The design shows conclusions; this makes them checkable. */}
        {need.basis.length > 0 && (
          <div style={css('padding:2px 2px 6px; font-size:11px; line-height:1.5; color:rgba(237,238,241,.26);')}>
            {need.asks ? 'asking because I don’t know yet' : `from ${need.basis.length} thing${need.basis.length > 1 ? 's' : ''} I’ve seen`}
          </div>
        )}
      </div>

      <div style={css('flex:none; padding:8px 16px; display:flex; gap:8px; overflow-x:auto;')}>
        {need.chips.map((c, i) => (
          <div
            key={i}
            onClick={() => void send(c)}
            style={cssv`flex:none; padding:9px 14px; border-radius:999px; background:rgba(255,255,255,.06); box-shadow:inset 0 0 0 1px rgba(255,255,255,.14); font-size:12.5px; color:rgba(237,238,241,${sending ? '.36' : '.82'}); cursor:pointer; white-space:nowrap;`}
          >{c}</div>
        ))}
      </div>

      {/* A real composer. This was a placeholder div in the design mock, which
          meant the one thing the whole app is premised on — answering it in
          your own words — could not be done at all. */}
      <div style={css('flex:none; margin:0 16px 20px; padding:11px 15px; border-radius:22px; background:rgba(30,32,37,.55); box-shadow:inset 0 1px 0 rgba(255,255,255,.16), inset 0 0 0 1px rgba(255,255,255,.09); display:flex; align-items:center; gap:11px;')}>
        <input
          value={draft}
          disabled={sending}
          placeholder={sending ? 'Thinking…' : 'Message Crucible…'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
          style={css('flex:1; min-width:0; background:transparent; border:0; outline:0; font-family:inherit; font-size:14px; color:rgba(237,238,241,.92);')}
        />
        <div
          onClick={() => void send()}
          style={cssv`width:30px; height:30px; flex:none; border-radius:999px; background:rgba(237,238,241,${draft.trim() && !sending ? '.9' : '.35'}); display:flex; align-items:center; justify-content:center; color:#0B0B0D; font-size:15px; cursor:pointer;`}
        >↑</div>
      </div>
    </div>
  )
}

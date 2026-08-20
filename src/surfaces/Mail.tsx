import { useMemo, useState } from 'react'
import { css, cssv } from '../css'
import type { MailMessage, WidgetAction } from '../api'
import { useSurface, useSurfaceState, put } from '../surface/store'
import type { SurfaceObject } from '../surface/types'
import { Actions, CARD, Chip, Segments, Toolbar, shortWhen } from './kit'
import { TYPE } from '../tokens'

/**
 * A mailbox.
 *
 * The list primitive could show messages, and did; what it could not do is hold
 * a selection, know what unread means, or put a draft anywhere. "Select these
 * three and archive them" needs a surface where selection is state rather than
 * a hover effect, and "draft a shorter reply" needs a composer that something
 * other than his thumb can write into.
 *
 * The composer is the boundary this file is most careful about. A model can put
 * text INTO it and can do nothing else with it — the draft appears where a
 * draft he typed would appear, marked as not his, and it goes nowhere until he
 * presses send and confirms. There is no code path from a model deciding
 * something to a message leaving the account.
 */

interface Props {
  surfaceKey: string
  title: string
  messages: MailMessage[]
  empty?: string
  onAction: (a: WidgetAction) => Promise<void>
}

const nameOf = (m: MailMessage) => m.fromName ?? (m.from.replace(/<.*>/, '').trim() || m.from)

export default function Mail({ surfaceKey, title, messages, empty, onAction }: Props) {
  const [seed] = useState(() => ({ view: 'list', sort: 'at:desc' }))

  // Sorting and filtering happen before publishing, so "the third one" means
  // the third one HE can see, not the third in an array he has never looked at.
  const preliminary = useSurfaceState(surfaceKey, 'mail', seed)

  const visible = useMemo(() => {
    const f = preliminary.filters
    const q = preliminary.query.trim().toLowerCase()
    let out = messages.filter((m) => {
      if (f.unread === true && !m.unread) return false
      if (typeof f.sender === 'string' && !`${nameOf(m)} ${m.from}`.toLowerCase().includes(f.sender.toLowerCase())) return false
      if (typeof f.label === 'string' && !(m.labels ?? []).some((l) => l.toLowerCase() === String(f.label).toLowerCase())) return false
      if (typeof f.only === 'string' && !f.only.split(',').includes(m.id)) return false
      if (q && !`${m.subject} ${nameOf(m)} ${m.snippet ?? ''}`.toLowerCase().includes(q)) return false
      return true
    })
    const [by = 'at', dir = 'desc'] = (preliminary.sort ?? 'at:desc').split(':')
    out = [...out].sort((a, b) => {
      const cmp =
        by === 'sender' ? nameOf(a).localeCompare(nameOf(b))
        : by === 'subject' ? a.subject.localeCompare(b.subject)
        : a.at.localeCompare(b.at)
      return dir === 'asc' ? cmp : -cmp
    })
    return out
  }, [messages, preliminary.filters, preliminary.query, preliminary.sort])

  const objects: SurfaceObject[] = useMemo(
    () => visible.map((m) => ({
      id: m.id,
      label: m.subject,
      sub: nameOf(m),
      at: m.at,
      unread: m.unread,
      tags: m.labels,
    })),
    [visible]
  )

  const [state, send] = useSurface(surfaceKey, 'mail', title, objects, seed)
  const mode = state.mode ?? 'browse'
  const reading = mode === 'read' && state.focus ? messages.find((m) => m.id === state.focus) ?? null : null

  const senders = useMemo(
    () => [...new Set(messages.map(nameOf))].slice(0, 8),
    [messages]
  )
  const unread = messages.filter((m) => m.unread).length
  const selected = new Set(state.selected)

  // No top-level empty return: an empty mailbox is still Mail. The chrome and
  // its controls stay on screen and the emptiness is reported inside them,
  // because a surface that vanishes when it has nothing to show cannot be
  // navigated back to something worth showing.

  /**
   * Everything selected, acted on at once.
   *
   * Fired sequentially rather than in parallel: these are writes to his real
   * mailbox and a burst of them is the shape that trips rate limits, which
   * would leave half the selection archived and no record of which half.
   */
  const bulk = async (kind: string, label: string) => {
    for (const id of state.selected) {
      const m = messages.find((x) => x.id === id)
      const a = m?.actions?.find((x) => x.kind === kind)
      if (a) await onAction(a)
    }
    put(surfaceKey, { selected: [] }, `${label} ${state.selected.length}.`)
  }

  const scope: 'all' | 'unread' = state.filters.unread === true ? 'unread' : 'all'

  /**
   * READING REPLACES THE MAILBOX.
   *
   * What this replaces: the message expanded IN the list, so the body was a
   * 150px internally-scrolling box between two other messages, and replying
   * opened a drawer over the top of all of it. Three contexts — list, message,
   * reply — sharing one 400px column, which is the shape §19 is about.
   *
   * Reading is now its own mode and takes the frame. The list is not unmounted,
   * so its scroll position and selection are exactly where he left them when he
   * comes back; it is simply not what the surface is doing right now.
   */
  if (reading) {
    return (
      <Reader
        message={reading}
        onAction={onAction}
        onBack={() => send({ op: 'mode', args: { to: 'browse' } })}
        onReply={() => put(
          surfaceKey,
          /*
            ONE `Re:`, NOT TWO.

            Replying to "Re: Odelia — Saturday" produced "Re: Re: Odelia —
            Saturday" in the composer's header, which is the reply prefix applied
            to a subject that already had one. Found by replying to a reply,
            which is what most replies are.
          */
          { draft: { text: '', to: reading.from, subject: replySubject(reading.subject), replyTo: reading.id, byModel: false } },
          `Replying to ${nameOf(reading)}.`,
        )}
        replying={state.draft?.replyTo === reading.id}
      />
    )
  }

  return (
    /*
      THE WHOLE FRAME IS MAIL.

      This surface used to open with two stacked rows of chrome — a filter bar
      that scrolled sideways through every sender in the mailbox, then a note
      line, then a selection bar — before the first message. On a 375px screen
      that is most of the frame spent on controls for a list nobody has read
      yet. Everything above is now one 34px toolbar; senders live behind the
      overflow, the note shares a line with the emptiness, and the selection
      bar is an overlay rather than a block that pushes the list down.
    */
    <div style={css('position:relative; height:100%; min-height:0; display:flex; flex-direction:column; gap:6px; padding:8px 14px 6px; box-sizing:border-box;')}>
      <Toolbar
        left={
          <>
            <Segments
              value={scope}
              options={[{ v: 'all', label: 'All' }, { v: 'unread', label: unread ? `Unread ${unread}` : 'Unread' }]}
              onChange={(v) => send({ op: 'filter', args: { unread: v === 'unread' ? true : null } })}
            />
            {/* The sender filter IS the heading when one is active — it was a
                lit chip in a row of eight, which said the same thing louder. */}
            <div style={cssv`min-width:0; font-size:12.5px; font-weight:600; letter-spacing:-.01em; color:rgba(237,238,241,.9); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>
              {typeof state.filters.sender === 'string' ? state.filters.sender : ''}
            </div>
          </>
        }
        /*
          THE SORT TOGGLE IS GONE, AND IT WORKED PERFECTLY.

          It was an icon button that read `↓` or `A` and swapped the list between
          newest-first and by-sender. Nothing about either glyph predicts "sort by
          sender"; the only explanation was a `title` tooltip, which on the device
          this app is used on can never be seen. So the honest description is a
          two-state control, permanently on the toolbar, whose current state and
          purpose are both unreadable — and the answer to §26's "do I need this
          often enough to justify its location" is no.

          What it was FOR is still here and is more precise: the sender filter in
          the overflow shows one person's mail by name, which is what somebody
          hunting through a mailbox by sender actually wants. Sorting the whole
          list by sender is the blunter version of the same intent, and it kept
          the sharper one company on the screen.

          The `sort` operation itself is untouched — the reducer still accepts it,
          so the assistant can still be asked to sort. This deletes a control, not
          a capability.
        */
        more={
          <>
            <Chip label="All senders" on={!state.filters.sender} onClick={() => send({ op: 'filter', args: { sender: null } })} />
            {senders.map((s) => (
              <Chip
                key={s}
                label={s}
                on={state.filters.sender === s}
                onClick={() => send({ op: 'filter', args: { sender: state.filters.sender === s ? null : s } })}
              />
            ))}
          </>
        }
      />

      {/* One status line: note, emptiness, or nothing at all. Three separate
          blocks each reserving vertical space is three messages' worth. */}
      {!visible.length && (
        <div style={cssv`flex:none; padding:0 2px; font-size:${TYPE.small}; line-height:1.35; color:rgba(240,165,107,.7); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>
          {messages.length ? 'Nothing matches that.' : empty ?? 'Nothing here.'}
        </div>
      )}

      {/* THE APPLICATION. Everything above is one 34px row; this gets the rest,
          and scrolls INSIDE the frame rather than pushing chat off the screen. */}
      <div style={css('flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch; display:flex; flex-direction:column; gap:4px; padding-bottom:4px;')}>
        {visible.map((m) => {
          const picked = selected.has(m.id)
          return (
            /* `flex:none` is load-bearing: in a flex column scroller the rows
               are flex items, and without it a full mailbox shrinks every row
               to fit instead of scrolling. */
            <div key={m.id} data-object={m.id} style={cssv`flex:none; ${CARD} overflow:hidden; ${state.marks.includes(m.id) ? 'box-shadow:inset 0 0 0 1px rgba(240,165,107,.5);' : ''}`}>
              <div style={css('padding:8px 10px; display:flex; gap:9px; align-items:flex-start;')}>
                {/* The initial doubles as the checkbox. A phone has no room for
                    a separate select column, and a long-press is undiscoverable. */}
                <div
                  data-role="pick"
                  onClick={() => send({ op: picked ? 'deselect' : 'select', args: { id: m.id } })}
                  style={cssv`flex:none; width:22px; height:22px; margin-top:1px; border-radius:999px; display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:10.5px; font-weight:600; background:${picked ? 'rgba(237,238,241,.9)' : 'rgba(255,255,255,.07)'}; color:${picked ? '#101012' : 'rgba(237,238,241,.6)'}; box-shadow:inset 0 0 0 1px rgba(255,255,255,.1);`}
                >
                  {picked ? '✓' : nameOf(m).slice(0, 1).toUpperCase()}
                </div>

                <div
                  data-role="open"
                  /* One tap, one destination. It used to toggle an inline
                     expansion, so the same gesture both opened and closed
                     something, and what it opened was a preview of the thing
                     rather than the thing. */
                  onClick={() => send({ op: 'mode', args: { to: 'read', id: m.id } })}
                  style={css('flex:1; min-width:0; cursor:pointer;')}
                >
                  <div style={css('display:flex; gap:6px; align-items:baseline;')}>
                    {m.unread && <div style={css('width:5px; height:5px; flex:none; border-radius:999px; background:#E7B24C;')} />}
                    <div style={cssv`flex:1; min-width:0; font-size:${TYPE.body}; font-weight:${m.unread ? '600' : '500'}; color:rgba(237,238,241,${m.unread ? '.95' : '.8'}); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`}>
                      {m.subject}
                    </div>
                    <div style={cssv`flex:none; font-size:${TYPE.micro}; color:rgba(237,238,241,.36);`}>{shortWhen(m.at)}</div>
                  </div>
                  {/* Sender and snippet share ONE line. They were two, and the
                      second was the same 11.5px grey saying less. */}
                  <div style={cssv`margin-top:2px; font-size:${TYPE.small}; color:rgba(237,238,241,.46); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`}>
                    <span style={css('color:rgba(237,238,241,.62);')}>{nameOf(m)}</span>{m.snippet ? ` — ${m.snippet}` : ''}
                  </div>
                </div>
              </div>

            </div>
          )
        })}
      </div>

      {/*
        Selection is an OVERLAY inside the frame, not a row appended to the
        column. Appended, it shortened the list by its own height at exactly the
        moment the list mattered most — you select in order to act on what you
        can still see.
      */}
      {state.selected.length > 0 && !state.draft && (
        <div style={css('position:absolute; left:0; right:0; bottom:0; z-index:5; padding:0 14px 8px; pointer-events:none;')}>
          <div style={cssv`pointer-events:auto; display:flex; align-items:center; gap:7px; padding:7px 10px; border-radius:14px; background:rgba(28,24,20,.94); box-shadow:inset 0 0 0 1px rgba(240,165,107,.28), 0 6px 22px rgba(0,0,0,.45);`}>
            <div style={cssv`flex:1; min-width:0; font-size:${TYPE.small}; color:rgba(255,220,170,.9);`}>
              {state.selected.length} selected
            </div>
            <Chip label="Archive" onClick={() => void bulk('mail.archive', 'Archived')} />
            <Chip label="Read" onClick={() => void bulk('mail.read', 'Marked read')} />
            <Chip label="Clear" onClick={() => send({ op: 'clearSelection' })} />
          </div>
        </div>
      )}

      {/*
        THE REPLY IS NOT HERE ANY MORE, AND THAT IS THE POINT.

        A draft used to open a bounded drawer over the mailbox — a second text
        area, with its own send button, on a screen that already had a composer
        at the bottom for talking to Crucible. Two places to type, one of which
        sent mail and one of which did not, eight millimetres apart.

        There is one composition region now and it changes MODE: the workspace's
        composer becomes the reply. See `ReplyComposer` in Report.tsx, and §21.
      */}
    </div>
  )
}

/**
 * ONE MESSAGE, READ.
 *
 * The whole frame, the whole body, and no cap on its height — the body scrolls
 * because the frame does, not because a `max-height:150px` was needed to stop it
 * pushing the buttons off the bottom of a card.
 *
 * Reply is the primary control and it does one thing: it puts a draft in surface
 * state. It does not open anything here. What draws the draft is the shared
 * composer, which is a different region of the screen with a different owner,
 * and that separation is what makes "one composer, several modes" true rather
 * than aspirational.
 */
/**
 * The reply subject: prefixed once, however many rounds it has been through.
 *
 * Case-insensitive and tolerant of the space, because a subject arriving from
 * another mailer is whatever that mailer wrote. Only the leading prefix is
 * touched — "Re: Re-roofing the shed" keeps the word that is part of its title.
 */
export const replySubject = (subject: string): string =>
  /^re\s*:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`

function Reader({
  message, onAction, onBack, onReply, replying,
}: {
  message: MailMessage
  onAction: (a: WidgetAction) => Promise<void>
  onBack: () => void
  onReply: () => void
  replying: boolean
}) {
  return (
    <div
      data-role="reader"
      style={css('height:100%; min-height:0; display:flex; flex-direction:column; gap:9px; padding:8px 14px 6px; box-sizing:border-box;')}
    >
      <div style={css('flex:none; display:flex; align-items:center; gap:8px;')}>
        <div
          data-role="reader-back"
          onClick={onBack}
          style={cssv`flex:none; padding:5px 11px; border-radius:999px; cursor:pointer;
            background:rgba(255,255,255,.06); font-size:${TYPE.small}; color:rgba(237,238,241,.7);`}
        >‹ Mail</div>
        <div style={css('flex:1;')} />
        <div style={cssv`flex:none; font-size:${TYPE.micro}; color:rgba(237,238,241,.36);`}>{shortWhen(message.at)}</div>
      </div>

      {/* The subject WRAPS. It is what tells one message from another, which
          puts it on the never-truncate side of §25. */}
      <div style={cssv`flex:none; font-size:16px; font-weight:600; letter-spacing:-.02em; line-height:1.25;
        color:rgba(237,238,241,.95); text-wrap:pretty;`}>
        {message.subject}
      </div>
      <div style={cssv`flex:none; font-size:${TYPE.small}; color:rgba(237,238,241,.5);
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>
        {nameOf(message)}{message.from.includes('<') || message.fromName ? ` · ${message.from.replace(/.*<|>.*/g, '')}` : ''}
      </div>

      {/*
        WHO THIS IS, IN THE ONE PLACE THE QUESTION IS ACTUALLY BEING ASKED.

        A message open on screen answers "who" and "what" by itself; the third
        thing §14 asks Mail for — why it matters — is the one a mailbox cannot
        know. "You are seeing Bernardo on Saturday at 12:30" is that, and it is
        the reason to have resolved the sender to a person at all.

        Directly under the sender because it is ABOUT the sender, above the body
        because it changes how the body reads, and drawn only with its grounds —
        the same rule `CalEvent.note` has always had. It is one line and it is
        never a panel: Mail does not become a contact record because a person was
        recognised.
      */}
      {message.note?.says && message.note.grounds ? (
        <div
          data-role="message-note"
          style={cssv`flex:none; display:flex; align-items:baseline; gap:7px; font-size:${TYPE.small};
            line-height:1.4; color:rgba(237,238,241,.72);`}
        >
          <span style={css('flex:none; width:4px; height:4px; border-radius:999px; background:rgba(214,163,110,.85); transform:translateY(-2px);')} />
          <span style={css('min-width:0;')}>
            {message.note.says}
            <span style={css('color:rgba(237,238,241,.34);')}>{` ${message.note.grounds}.`}</span>
          </span>
        </div>
      ) : null}

      <div style={css('flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch; font-size:13px; line-height:1.6; color:rgba(237,238,241,.78); white-space:pre-wrap;')}>
        {message.body ?? message.snippet ?? 'Nothing in the body of this one.'}
      </div>

      <div style={css('flex:none; display:flex; gap:7px; flex-wrap:wrap; align-items:center; padding-bottom:2px;')}>
        <div data-role="reply">
          <Chip label={replying ? 'Replying…' : 'Reply'} on={replying} onClick={onReply} />
        </div>
        {message.actions?.length ? <Actions actions={message.actions} onAction={onAction} /> : null}
      </div>
    </div>
  )
}

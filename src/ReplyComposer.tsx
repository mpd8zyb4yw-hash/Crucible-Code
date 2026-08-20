import { useState } from 'react'
import { css, cssv } from './css'
import { INSET, TYPE } from './tokens'
import { put } from './surface/store'
import type { Draft } from './surface/types'
import type { WidgetAction } from './api'

/**
 * ONE COMPOSITION REGION, IN MAIL-REPLY MODE.
 *
 * The screen had two places to type eight millimetres apart: a reply textarea
 * inside a drawer over the mailbox, and the assistant's composer under it. Two
 * send buttons, one of which sent mail. That is the ambiguity §21 removes and
 * §22 refuses to let a heuristic decide.
 *
 * SO THE MODE IS EXPLICIT AND SO IS EVERY CONSEQUENCE OF IT.
 *
 *   · The header says who this is going to and what it is about, and carries the
 *     ✕ that leaves the mode. It is always present while the mode is: a reply
 *     you cannot see the recipient of is a reply you can send to the wrong
 *     person.
 *   · The primary control SENDS THE EMAIL. Not sometimes, not depending on what
 *     the text looks like. It confirms once, because sending is irreversible and
 *     visible to someone else, and the exact text that will leave is on screen
 *     while it confirms.
 *   · Asking Crucible for help is a SEPARATE, EXPLICIT submode. Typing in Draft
 *     never reaches a model; typing in Ask never reaches the recipient. There is
 *     no classifier deciding which of those two things a sentence was, because
 *     the cost of being wrong is unequal in a way no accuracy figure can fix:
 *     one mistake is a missed rewrite, the other is "make this more polite" sent
 *     to his bank.
 *
 * WHAT THE MODEL MAY DO. It may write into the draft — that is the `draft`
 * capability, and it lands here, marked as not his, exactly where his own typing
 * lands. It may not send. There is no code path in this file from a model's
 * output to `mail.send`; the send call is behind a two-press human gesture and
 * always has been.
 */

/** Which half of the mode has the keyboard. Never inferred from the text. */
type Half = 'draft' | 'ask'

export function ReplyComposer({
  surfaceKey, draft, onAction, onAsk, thinking,
}: {
  surfaceKey: string
  draft: Draft
  /** Performs the real action. Throws, so a failure is shown rather than assumed. */
  onAction: (a: WidgetAction) => Promise<void>
  /**
   * "Make it shorter" — his instruction ABOUT the draft.
   *
   * Handed up rather than performed here: it is an ordinary turn of the
   * conversation, with the draft as its subject, and it comes back through the
   * same `draft` capability the model already has. This file does not talk to a
   * model.
   */
  onAsk: (instruction: string, draft: Draft) => Promise<void>
  thinking: boolean
}) {
  const [half, setHalf] = useState<Half>('draft')
  const [instruction, setInstruction] = useState('')
  const [sure, setSure] = useState(false)
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const text = draft.text

  const setText = (t: string) => {
    // Editing a model's draft makes it his. The badge goes because the claim it
    // makes has stopped being true.
    put(surfaceKey, { draft: { ...draft, text: t, byModel: false } }, '', 'me')
    setSure(false)
  }

  const close = () => put(surfaceKey, { draft: null }, 'Closed the reply.')

  const send = async () => {
    if (!text.trim() || sending) return
    if (!sure) { setSure(true); return }
    setSending(true)
    setFailed(null)
    try {
      await onAction({
        kind: 'mail.send',
        label: 'Send',
        irreversible: true,
        params: { messageId: draft.replyTo ?? null, to: draft.to ?? null, subject: draft.subject ?? null, text },
      })
      put(surfaceKey, { draft: null }, 'Sent.')
    } catch (e) {
      setFailed((e as Error).message)
    } finally {
      setSending(false)
      setSure(false)
    }
  }

  const ask = async () => {
    const said = instruction.trim()
    if (!said || thinking) return
    setInstruction('')
    setFailed(null)
    try {
      await onAsk(said, draft)
    } catch (e) {
      setFailed((e as Error).message)
    }
  }

  return (
    <div
      data-frame="composer"
      data-mode="mail-reply"
      style={cssv`flex:none; margin:0 ${INSET.page}px 12px; padding:9px 11px 10px; border-radius:20px;
        background:rgba(30,32,37,.72); box-shadow:inset 0 1px 0 rgba(255,255,255,.16), inset 0 0 0 1px rgba(240,165,107,.28);
        display:flex; flex-direction:column; gap:8px;`}
    >
      {/* WHO THIS IS GOING TO. The mode is unmistakable or it is not a mode. */}
      <div style={css('display:flex; align-items:center; gap:8px; min-width:0;')}>
        <div style={cssv`flex:none; width:5px; height:5px; border-radius:999px; background:#F0A56B;`} />
        <div style={css('flex:1; min-width:0;')}>
          <div style={cssv`font-size:${TYPE.micro}; font-weight:600; letter-spacing:.06em; text-transform:uppercase;
            color:rgba(240,165,107,.9);`}>
            Replying to {draft.to?.replace(/.*</, '').replace(/>.*/, '') || 'them'}
          </div>
          <div style={cssv`margin-top:1px; font-size:${TYPE.micro}; color:rgba(237,238,241,.44);
            white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>
            {draft.subject ?? 'No subject'}
          </div>
        </div>
        <div
          data-role="reply-close"
          onClick={close}
          style={cssv`flex:none; padding:3px 8px; border-radius:999px; cursor:pointer; font-size:${TYPE.micro};
            background:rgba(255,255,255,.07); color:rgba(237,238,241,.6);`}
        >✕</div>
      </div>

      {/*
        THE TWO HALVES, NAMED.

        A segmented control rather than an icon, because the thing it selects is
        what the send button will DO, and that is not something to express with a
        glyph and hope.
      */}
      <div style={css('display:flex; gap:1px; padding:2px; border-radius:999px; background:rgba(0,0,0,.25); align-self:flex-start;')}>
        {(['draft', 'ask'] as Half[]).map((h) => (
          <div
            key={h}
            data-half={h}
            onClick={() => { setHalf(h); setSure(false) }}
            style={cssv`padding:4px 12px; border-radius:999px; font-size:11px; cursor:pointer; white-space:nowrap;
              background:${half === h ? 'rgba(255,255,255,.14)' : 'transparent'};
              color:rgba(237,238,241,${half === h ? '.95' : '.5'});`}
          >{h === 'draft' ? 'Write' : 'Ask Crucible'}</div>
        ))}
        {draft.byModel && (
          <div style={cssv`align-self:center; margin-left:8px; padding:0 8px; font-size:10px; font-weight:600;
            letter-spacing:.05em; text-transform:uppercase; color:rgba(240,165,107,.85);`}>
            drafted for you
          </div>
        )}
      </div>

      {half === 'draft' ? (
        <>
          <textarea
            data-role="draft"
            /* NOT `data-editor="frame"`. The whole-frame editing mode is for a
               field inside the SURFACE; this is the composer, and collapsing the
               application to make room for it would leave the message he is
               replying to unreachable — which is the context §22 says must stay
               available while he writes. */
            value={text}
            rows={3}
            placeholder="Write your reply…"
            onChange={(e) => setText(e.target.value)}
            style={css('display:block; width:100%; box-sizing:border-box; resize:none; max-height:180px; background:rgba(0,0,0,.22); border:0; outline:0; border-radius:12px; padding:10px 12px; font-family:inherit; font-size:13.5px; line-height:1.5; color:rgba(237,238,241,.92); box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);')}
          />
          <div style={css('display:flex; align-items:center; gap:9px;')}>
            <div
              data-role="send"
              onClick={() => void send()}
              style={cssv`padding:8px 16px; border-radius:999px; cursor:pointer; font-size:12.5px; font-weight:600;
                background:rgba(237,238,241,${text.trim() && !sending ? '.92' : '.35'}); color:#101012;`}
            >
              {sending ? 'Sending…' : sure ? 'Tap again to send' : 'Send email'}
            </div>
            {sure && (
              <div style={cssv`font-size:11.5px; color:rgba(237,238,241,.5);`}>this leaves your account</div>
            )}
            <div style={css('flex:1;')} />
            <div
              onClick={close}
              style={css('font-size:11.5px; color:rgba(237,238,241,.4); cursor:pointer;')}
            >discard</div>
          </div>
        </>
      ) : (
        <>
          {/* The draft is still visible while he asks about it — an instruction
              about text you cannot see is an instruction given blind. */}
          <div style={css('max-height:76px; overflow-y:auto; overscroll-behavior:contain; padding:8px 11px; border-radius:11px; background:rgba(0,0,0,.22); font-size:12px; line-height:1.5; color:rgba(237,238,241,.6); white-space:pre-wrap;')}>
            {text.trim() || 'Nothing written yet — ask for a first draft.'}
          </div>
          <div style={css('display:flex; align-items:center; gap:9px;')}>
            <input
              data-role="ask"
              value={instruction}
              disabled={thinking}
              placeholder={thinking ? 'Working…' : 'Make it shorter, more polite…'}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void ask() } }}
              style={css('flex:1; min-width:0; background:transparent; border:0; outline:0; font-family:inherit; font-size:13.5px; color:rgba(237,238,241,.92);')}
            />
            <div
              data-role="ask-send"
              onClick={() => void ask()}
              style={cssv`width:30px; height:30px; flex:none; border-radius:999px; display:flex; align-items:center;
                justify-content:center; cursor:pointer; color:#0B0B0D; font-size:15px;
                background:rgba(237,238,241,${instruction.trim() && !thinking ? '.9' : '.35'});`}
            >↑</div>
          </div>
          {/* Three things people actually ask for, as one tap each. They go
              through the same path a typed instruction does. */}
          <div style={css('display:flex; gap:6px; flex-wrap:wrap;')}>
            {['Make it shorter', 'More polite', 'Say I didn’t authorise this'].map((s) => (
              <div
                key={s}
                onClick={() => { setInstruction(''); void onAsk(s, draft) }}
                style={cssv`padding:5px 11px; border-radius:999px; cursor:pointer; font-size:11.5px;
                  background:rgba(255,255,255,.06); box-shadow:inset 0 0 0 1px rgba(255,255,255,.1);
                  color:rgba(237,238,241,.7); white-space:nowrap;`}
              >{s}</div>
            ))}
          </div>
        </>
      )}

      {failed && (
        <div style={css('font-size:11.5px; line-height:1.45; color:rgba(255,170,170,.85);')}>{failed}</div>
      )}
    </div>
  )
}

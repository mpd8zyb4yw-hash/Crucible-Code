import { useEffect, useState } from 'react'

/**
 * IS HE TYPING INTO THE APPLICATION RIGHT NOW?
 *
 * Not "is a keyboard up" — that is a fact about the window. This is a fact
 * about intent: something inside the domain surface has focus, so he is in the
 * middle of one task and everything that is not that task is in the way.
 *
 * WHAT IT IS FOR, MEASURED.
 *
 * Typing a reply on a 874px phone with the keyboard up left 538px of usable
 * screen. Of that, the textarea he was actually typing in got 118px — 22%. The
 * other 420px was the workspace header, the mailbox behind the drawer, the
 * drawer's own chrome, the chat handle, a row of suggestion chips and a second
 * composer for talking to the assistant, none of which he can use while writing
 * an email and all of which he is paying for in the one moment the screen is
 * smallest.
 *
 * So this drives a mode. While it is true the workspace shows the surface and
 * nothing else, and the surface shows the editor and nothing else.
 *
 * COALESCED ACROSS A FRAME, deliberately. `focusout` fires before the matching
 * `focusin` when focus moves between two fields, so reading synchronously
 * flickers the whole layout off and back on between the subject line and the
 * body. One frame of coalescing makes a field-to-field move invisible.
 */

const editable = (el: Element | null): boolean =>
  !!el && (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    (el as HTMLElement).isContentEditable === true
  )

/**
 * THE FIELD ASKS FOR THE FRAME. IT IS NOT INFERRED FROM BEING A FIELD.
 *
 * This used to be "any editable inside `[data-frame="surface"]`", and being
 * inside the surface is not the same question as being worth the whole screen.
 * Maps' search box is a 28px pill in the toolbar; focusing it collapsed the
 * header, the seam, the chat and the composer — and the header is where `close`
 * lives, so typing a place name removed the only way out of Maps. Nothing on
 * screen said so, and nothing could put it back except blurring a field the
 * person had deliberately focused. YouTube's search box did the same.
 *
 * So the rule is opt-in, and the thing it opts into is a real obligation: a
 * field may take the frame only if what it is inside PROVIDES ITS OWN WAY OUT.
 * Both current cases do — the mail composer sits in a drawer with ✕, Send and
 * discard; an editable row has ✓ and ✕ and sits in a drawer with ✕. A toolbar
 * filter has none, which is exactly why it must not have the frame.
 *
 * `data-editor="frame"` is that declaration. Marking a new field is one
 * attribute; forgetting to mark one costs nothing, because the default is the
 * layout that was already correct.
 *
 * The chat composer is excluded for a second, independent reason: it is outside
 * `[data-frame="surface"]` entirely. Talking to the assistant is a different
 * task from filling in a field, and collapsing the application to make room for
 * a chat box would be the inversion this whole layout exists to prevent.
 */
/**
 * A SURFACE CAN ALSO BE IN A MODE WHOSE WHOLE JOB IS EDITING.
 *
 * Focus is the right trigger for a field he happens to tap inside a browsing
 * surface — the mail composer, an editable row. It is the wrong trigger for the
 * event editor, which he ENTERED deliberately: before he touches a field the
 * workspace was still drawing its header, its seam, the conversation and a
 * composer for talking to the assistant, underneath a screen whose only job is
 * three fields and a Save button. That is §16's "no competing chat composer",
 * and no amount of focus handling reaches it, because nothing is focused yet.
 *
 * So a MODE may claim the frame by being present, and it carries the same
 * obligation a field does: `data-mode="frame"` says "I provide my own way out",
 * and the editor does — ‹ Event, Cancel and Save are all inside it.
 */
const MODE = '[data-frame="surface"] [data-mode="frame"]'

export function useEditingInSurface(): boolean {
  const [on, setOn] = useState(false)

  useEffect(() => {
    let raf = 0
    const read = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const a = document.activeElement
        setOn(
          !!document.querySelector(MODE) ||
          (editable(a) &&
            !!a?.closest('[data-frame="surface"]') &&
            !!a?.closest('[data-editor="frame"]')),
        )
      })
    }
    read()
    document.addEventListener('focusin', read, true)
    document.addEventListener('focusout', read, true)
    /*
      A mode arrives and leaves by RENDER, not by focus, so focus events alone
      would never notice it. Observing the subtree is what makes entering and
      leaving the editor symmetrical — without the second half, the workspace
      would collapse on entry and never come back.
    */
    const mo = new MutationObserver(read)
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-mode'] })
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('focusin', read, true)
      document.removeEventListener('focusout', read, true)
      mo.disconnect()
    }
  }, [])

  return on
}

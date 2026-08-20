import { useEffect, type ReactNode } from 'react'
import { cssv } from './css'
import { ViewportContext, useResolvedViewport, useViewport } from './viewport'

export { useViewport } from './viewport'

/**
 * A REGION THAT HAS TO GET OUT OF THE KEYBOARD'S WAY.
 *
 * An opened application and Settings both end in a composer or a control that
 * must stay reachable while something is being typed, and both are full-height
 * columns, so the honest move is to shorten the column — the application stays
 * visible, its internal scrollers absorb the loss, and the composer ends up on
 * top of the keys.
 *
 * Home deliberately does NOT use this. There the keyboard belongs to a
 * foreground panel that is already covering Home, and shortening Home would
 * re-shuffle four lanes nobody can see and shuffle them back on dismiss.
 *
 * It exists as a shared component rather than a `padding-bottom` each surface
 * remembers, because "every child compensating for the platform on its own" is
 * the exact habit that produced the dead band in the first place. There is one
 * number, it comes from the resolver, and this is the only thing that spends it.
 */
export function AboveKeyboard({ children }: { children: ReactNode }) {
  const v = useViewport()
  return (
    <div
      data-frame="above-keyboard"
      style={cssv`flex:1; min-height:0; display:flex; flex-direction:column;
        padding-bottom:${v.lift}px;
        transition:padding-bottom .2s cubic-bezier(.25,.8,.3,1);`}
    >
      {children}
    </div>
  )
}

/**
 * THE OUTERMOST BOX — AND IT IS THE VIEWPORT RATHER THAN A COPY OF IT.
 *
 * `position:fixed; inset:0` on a phone. That is the whole mechanism, and it is
 * deliberately not clever: a fixed box with all four offsets at zero is exactly
 * the layout viewport, resolved by the browser, in every mode this app runs in
 * — Safari with its toolbar, Safari with the toolbar collapsed, a Home Screen
 * launch, mid-rotation, with the keyboard up.
 *
 * WHAT THIS REPLACED, AND WHY IT COULD NOT BE PATCHED.
 *
 * It used to be a static box given `width`/`height` in pixels from
 * `visualViewport`, and offset by the safe-area insets with margins. Every
 * number in that sentence was a measurement of one rectangle applied to a box
 * living in a different one. On a Home Screen launch iOS reports the visual
 * viewport as the unobscured region (812px) and lays the document out in the
 * full screen (874px), so the shell was 62px short of its own document, plus a
 * 34px indicator reserve — and the 96px difference painted as black under the
 * composer. No amount of adjusting those numbers fixes that, because the fault
 * was not in the arithmetic, it was in there being arithmetic at all.
 *
 * Now `shell.bottom === documentElement.clientHeight` is not something the gate
 * verifies about the layout — it is a property of `position:fixed`. The gate
 * checks it anyway, because a regression here is the one that costs an inch of
 * his screen.
 *
 * THE INSETS ARE PADDING ON THIS BOX AND NOWHERE ELSE.
 *
 * Padding, not position and size: the shell PAINTS edge to edge — the gradient
 * runs under the status bar and behind the home indicator, which is what
 * `black-translucent` is for — while its content box is the usable rectangle.
 * A child measuring `100%` of this box measures usable pixels, so a child that
 * added its own inset would be paying for the same gap twice. None may.
 *
 * THE KEYBOARD CHANGES NOTHING HERE.
 *
 * This box is the same rectangle with the keyboard up as with it down. What
 * moves is the handful of layers that sit ON the bottom — the Home chat
 * overlay, an opened application's composer — and they move by `v.lift`, which
 * already accounts for the home-indicator reserve this box is holding back. The
 * alternative, shrinking the shell, relaid out Home behind a panel that was
 * covering it and made "did everything come back" a question with four answers.
 *

 * On a desktop window big enough for it the design's 390×844 device is
 * presented instead, centred by `#root`, with the platform insets belonging to
 * the page around it rather than to the app.
 */
export function ViewportShell({ children }: { children: ReactNode }) {
  const v = useResolvedViewport()

  useEffect(() => {
    const root = document.documentElement
    root.dataset.standalone = v.mode === 'standalone' ? 'yes' : 'no'
    root.dataset.keyboard = v.keyboard ? 'yes' : 'no'
    root.dataset.bezel = v.bezel ? 'yes' : 'no'
  }, [v.mode, v.keyboard, v.bezel])

  /*
    THE DOCUMENT MUST NOT SCROLL, AND ESPECIALLY NOT ON iOS.

    A fixed shell cannot make the page taller, but a stray scroll — iOS pulling
    a focused field into view, a rubber-band flick — moves the visual viewport
    under it, which reads exactly like the app having slipped off the bottom of
    the screen. There is nothing to scroll to, so any scroll is put back.
  */
  useEffect(() => {
    if (v.bezel) return
    const pin = () => {
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0)
    }
    pin()
    window.addEventListener('scroll', pin, { passive: true })
    return () => window.removeEventListener('scroll', pin)
  }, [v.bezel, v.keyboard])

  const box = v.bezel
    ? `position:relative; width:390px; height:844px; border-radius:40px;
       box-shadow:0 60px 120px rgba(0,0,0,.9), 0 0 0 1px rgba(237,238,241,.10);`
    : /*
        The one rectangle. Nothing here is measured — the four zeros ARE the
        measurement, and the padding is the only thing the resolver decides.
      */
      `position:fixed; top:0; right:0; bottom:0; left:0;
       padding:${v.safeTop}px ${v.safeRight}px ${v.safeBottom}px ${v.safeLeft}px;`

  return (
    <ViewportContext.Provider value={v}>
      <div
        className="cru-device"
        data-frame="shell"
        data-mode={v.mode}
        style={cssv`overflow:hidden; box-sizing:border-box;
          background:linear-gradient(168deg,#131210 0%,#0B0A0C 48%,#0D0C11 100%); ${box}`}
      >
        {/* Full-bleed, above the padding: the warm cast has to reach the top of
            the screen, not stop at the bottom of the status bar. */}
        <div
          aria-hidden="true"
          style={cssv`position:absolute; left:0; right:0; top:0; height:34%; pointer-events:none;
            background:radial-gradient(70% 100% at 50% 0%, rgba(240,175,120,.06), rgba(240,175,120,0) 72%);`}
        />

        {/*
          THE CONTENT BOX, as its own element.

          `data-frame="shell"` is the viewport and is what the gate measures
          against `clientHeight`; this is the usable rectangle inside it. They
          were the same element once, which meant nothing could assert the
          difference between "the app fills the screen" and "the app's contents
          fill the app" — and the second was where the dead band actually lived.
        */}
        <div
          data-frame="usable"
          style={cssv`position:relative; width:100%; height:100%; min-height:0; overflow:hidden;
            display:flex; flex-direction:column;`}
        >
          {children}
        </div>
      </div>
    </ViewportContext.Provider>
  )
}

import { createContext, useContext, useEffect, useState } from 'react'

/**
 * THE ONE RESOLVED VIEWPORT.
 *
 * Every environment this app has to survive reports its window differently, and
 * for months each part of the UI compensated for that on its own — the shell
 * subtracted browser chrome, the composer added a safe-area inset, a surface
 * added another. So there is exactly one place that answers "how much room do I
 * have". Nothing else may read `100dvh`, `window.innerHeight`,
 * `env(safe-area-inset-*)` or `navigator.standalone`.
 *
 * WHAT THE PREVIOUS VERSION GOT WRONG, MEASURED RATHER THAN GUESSED.
 *
 * It sized the shell from `visualViewport.height` and then placed that shell in
 * a document that lays out against the LAYOUT viewport. On a desktop browser
 * those are the same rectangle and everything looked right. On a Home Screen
 * launch they are not: iOS reports the visual viewport as the UNOBSCURED region
 * and the layout viewport as the whole screen. The app was therefore ~62px
 * shorter than the document it lived in, plus a 34px home-indicator reserve on
 * top of that, and the difference painted as ~96px of black under the composer.
 * That is the inch of dead space, and `scripts/_geometry.mjs` reproduces it:
 *
 *   innerH=874 clientH=874 vv.height=812  →  shell 62..778 in an 874px document
 *   >>> DEAD BAND BELOW APP: 96px
 *
 * THE RULE THAT REPLACES IT: the app is not SIZED to the viewport, it IS the
 * viewport. `ViewportShell` is `position:fixed; inset:0`, so its rectangle is
 * whatever the browser says the layout viewport is — in Safari, in standalone,
 * with the toolbar collapsed, after a rotation. `shell.bottom === clientHeight`
 * stops being an assertion that can fail and becomes a structural identity.
 * There is no subtraction left to get wrong.
 *
 * The numbers below therefore size CONTENT, never the shell. If one of them is
 * wrong a panel is the wrong proportion of the screen — annoying, and visible —
 * but it can no longer open a band of black at the bottom, because nothing's
 * position depends on it any more.
 *
 * Two deliberate refusals, both kept:
 *
 * The home-indicator inset is dropped while the keyboard is up. The keyboard
 * covers the indicator; reserving 34px for it there pushes the composer up for
 * nothing, at the exact moment the composer is the only thing being looked at.
 *
 * The keyboard is measured as an OCCLUSION of the layout viewport rather than
 * as a height, and against a calibrated resting divergence — see `occlusion`.
 */

export type ViewportMode = 'browser' | 'standalone'

export interface UsableViewport {
  /** Usable content size: insets and keyboard already removed. */
  width: number
  height: number
  /** The full layout viewport, before insets. What the shell's box actually is. */
  frameWidth: number
  frameHeight: number
  /** Reserved at the top for the status bar / notch. */
  safeTop: number
  safeLeft: number
  safeRight: number
  /** Reserved at the bottom for the home indicator. */
  safeBottom: number
  /** How much of the LAYOUT viewport's bottom the keyboard covers. 0 when closed. */
  keyboard: number
  /**
   * How far a bottom-anchored layer must rise to sit on top of the keyboard.
   *
   * The shell already holds back `safeBottom`, and the keyboard covers the home
   * indicator, so the two overlap: lifting by the whole keyboard would leave a
   * 34px gap between the composer and the keys. This is the difference, and it
   * is 0 whenever there is no keyboard — which is what makes the resting layout
   * bit-identical before and after one appears.
   */
  lift: number
  mode: ViewportMode
  /** True on a window large enough to present the design's device bezel. */
  bezel: boolean
}

/**
 * Safe-area insets, read from the platform rather than guessed.
 *
 * `env()` is only usable from CSS, so a zero-sized probe carries the four values
 * into JS as pixel lengths. Re-measured on every sync, because a rotation swaps
 * left and right and changes top and bottom.
 *
 * The `var(--cru-safe-*)` layer in front of each `env()` is a test seam, and it
 * is the reason the dead band is now reproducible off a phone: Chromium has no
 * notch and no way to fake one, so a gate that could only read `env()` could
 * only ever measure zero. `scripts/_geometry.mjs` sets these four variables and
 * gets a notched device. Nothing in the app ever sets them.
 */
let probe: HTMLDivElement | null = null

interface Insets { top: number; bottom: number; left: number; right: number }

function insets(): Insets {
  if (typeof document === 'undefined') return { top: 0, bottom: 0, left: 0, right: 0 }
  if (!probe || !probe.isConnected) {
    probe = document.createElement('div')
    probe.setAttribute('aria-hidden', 'true')
    probe.dataset.role = 'safe-area-probe'
    probe.style.cssText =
      'position:fixed; top:0; left:0; width:0; height:0; visibility:hidden; pointer-events:none;' +
      'padding-top:var(--cru-safe-top, env(safe-area-inset-top, 0px));' +
      'padding-bottom:var(--cru-safe-bottom, env(safe-area-inset-bottom, 0px));' +
      'padding-left:var(--cru-safe-left, env(safe-area-inset-left, 0px));' +
      'padding-right:var(--cru-safe-right, env(safe-area-inset-right, 0px));'
    document.body.appendChild(probe)
  }
  const s = getComputedStyle(probe)
  const n = (v: string) => Math.round(parseFloat(v) || 0)
  return { top: n(s.paddingTop), bottom: n(s.paddingBottom), left: n(s.paddingLeft), right: n(s.paddingRight) }
}

function detectMode(): ViewportMode {
  if (typeof window === 'undefined') return 'browser'
  // `navigator.standalone` is the iOS-specific signal and predates the media
  // query; both are checked because iOS only began answering the query reliably
  // in recent versions and this has to be right on older phones too.
  const legacy = (window.navigator as unknown as { standalone?: boolean }).standalone === true
  const modern = ['standalone', 'fullscreen', 'minimal-ui'].some(
    (m) => window.matchMedia?.(`(display-mode: ${m})`).matches,
  )
  return legacy || modern ? 'standalone' : 'browser'
}

/**
 * THE LAYOUT VIEWPORT — the rectangle the document is actually laid out in, and
 * the one `position:fixed; inset:0` resolves against.
 *
 * `documentElement.clientHeight` rather than `innerHeight`: in standards mode it
 * IS the initial containing block, which is the definition needed here.
 * `innerHeight` is a different measurement that happens to agree on a desktop.
 */
function frame(): { w: number; h: number } {
  if (typeof document === 'undefined') return { w: 375, h: 812 }
  const el = document.documentElement
  return {
    w: Math.round(el.clientWidth || window.innerWidth),
    h: Math.round(el.clientHeight || window.innerHeight),
  }
}

/**
 * IS SOMETHING THE PERSON TYPES INTO FOCUSED?
 *
 * The keyboard's cause, not its symptom. A viewport that shrank while nothing
 * editable has focus did not shrink because of a keyboard, and treating it as
 * one is how a reserve gets stuck open after the keyboard has gone.
 */
function editableFocused(): boolean {
  if (typeof document === 'undefined') return false
  const a = document.activeElement as HTMLElement | null
  if (!a) return false
  return a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable === true
}

/**
 * THE KEYBOARD, MEASURED AS AN OCCLUSION AND CALIBRATED AT REST.
 *
 * How much of the layout viewport the visual viewport does not cover. On a
 * desktop that is 0 and the keyboard is the whole of it. On iOS it is NOT: a
 * Home Screen launch reports a resting divergence of ~62px with no keyboard
 * anywhere, and reading that as one — or, as the previous version did, reading
 * the visual viewport as the app's height — is the whole bug.
 *
 * So the resting divergence is calibrated whenever nothing editable has focus,
 * which is a state the app returns to constantly, and only what exceeds it
 * counts. That makes the measurement self-healing: any stale value is corrected
 * the moment the field is blurred, so a keyboard reserve cannot outlive its
 * keyboard.
 */
let resting = 0
/** The layout height `resting` was measured against. A new one invalidates it. */
let restingFor = -1
/** Exposed for the on-device readout only — see Diagnostics.tsx. */
export const restingDivergence = () => resting

function keyboard(layoutH: number): number {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  if (!vv) return 0
  const divergence = Math.max(0, Math.round(layoutH - (vv.height + vv.offsetTop)))

  // A different window entirely — a rotation, Safari's toolbar collapsing. The
  // old resting value describes a window that no longer exists.
  if (restingFor !== layoutH) {
    restingFor = layoutH
    resting = divergence
  }

  if (!editableFocused()) {
    /*
      THE FLOOR, NOT THE LATEST READING.

      Recalibrating to whatever the divergence happens to be while nothing is
      focused looks equivalent and is not: iOS blurs the field BEFORE the
      keyboard finishes sliding away, so there is a window of a few frames in
      which nothing is focused and 336px of keyboard is still on screen.
      Assigning there records a 336px "resting" divergence, and the next real
      keyboard measures as zero — the app then leaves the composer behind the
      keys and looks, from the outside, exactly like the keyboard support having
      been removed.

      A keyboard only ever ADDS to the divergence. So the smallest value ever
      seen for this window is the truth, and a larger one with nothing focused
      is a keyboard on its way out rather than a new resting state.
    */
    resting = Math.min(resting, divergence)
    return 0
  }

  const over = divergence - resting
  // Below ~90px this is a rounding artefact or a floating accessory bar, not a
  // keyboard, and treating it as one makes the whole layout twitch.
  return over > 90 ? over : 0
}

export function resolveViewport(): UsableViewport {
  const f = frame()
  const inset = insets()
  const mode = detectMode()
  const bezel = f.w > 460 && f.h > 900

  // On a window wide enough for the device presentation the design's own size
  // applies and the platform insets belong to the page around it, not to the app.
  if (bezel) {
    return {
      width: 390, height: 844, frameWidth: 390, frameHeight: 844,
      safeTop: 0, safeBottom: 0, safeLeft: 0, safeRight: 0,
      keyboard: 0, lift: 0, mode, bezel: true,
    }
  }

  /*
    THE KEYBOARD DOES NOT RESIZE THE APP. IT RAISES WHAT SITS ON THE BOTTOM.

    Making the shell shorter for the keyboard was the obvious thing and it was
    wrong twice over. On Home it relaid the four lanes into 440px — they hit
    their floor, the last one clipped, and the whole screen visibly re-shuffled
    behind the chat glass and shuffled back on dismiss, for a keyboard that was
    covering it anyway. And it made every resting number a function of the
    keyboard, so "did the geometry come back" was a question about four
    quantities instead of none.

    So the usable rectangle is keyboard-independent, and `lift` is published for
    the two things that genuinely have to move: the Home chat overlay, and an
    opened application's composer. Home itself does not move, which is what the
    contract asks for — it is context behind a foreground panel, not a
    participant in the keyboard.
  */
  const kb = keyboard(f.h)
  return {
    frameWidth: f.w,
    frameHeight: f.h,
    width: Math.max(0, f.w - inset.left - inset.right),
    height: Math.max(0, f.h - inset.top - inset.bottom),
    safeTop: inset.top,
    safeLeft: inset.left,
    safeRight: inset.right,
    safeBottom: inset.bottom,
    keyboard: kb,
    lift: Math.max(0, kb - inset.bottom),
    mode,
    bezel: false,
  }
}

const same = (a: UsableViewport, b: UsableViewport): boolean =>
  a.width === b.width && a.height === b.height &&
  a.frameWidth === b.frameWidth && a.frameHeight === b.frameHeight &&
  a.safeTop === b.safeTop && a.safeBottom === b.safeBottom &&
  a.safeLeft === b.safeLeft && a.safeRight === b.safeRight &&
  a.keyboard === b.keyboard && a.lift === b.lift && a.mode === b.mode && a.bezel === b.bezel

/**
 * The resolved viewport, kept current.
 *
 * Only the shell calls this. Everything else reads the context below, so there
 * is one subscription and one source of truth rather than one per component
 * that happened to care about the keyboard.
 */
export function useResolvedViewport(): UsableViewport {
  const [v, setV] = useState<UsableViewport>(resolveViewport)

  useEffect(() => {
    let raf = 0
    const sync = () => {
      cancelAnimationFrame(raf)
      // iOS reports intermediate sizes through the whole keyboard animation;
      // coalescing to a frame stops that becoming a re-layout per frame of it.
      raf = requestAnimationFrame(() => {
        setV((prev) => {
          const next = resolveViewport()
          return same(prev, next) ? prev : next
        })
      })
    }
    const vv = window.visualViewport
    vv?.addEventListener('resize', sync)
    vv?.addEventListener('scroll', sync)
    window.addEventListener('orientationchange', sync)
    window.addEventListener('resize', sync)
    /*
      FOCUS IS PART OF THE GEOMETRY.

      The keyboard is gated on something editable having focus, so focus changes
      have to re-resolve — otherwise blurring a field leaves the reserve open
      until something else happens to fire a resize, which on iOS can be never.
      Capture phase, because focus/blur do not bubble.
    */
    document.addEventListener('focusin', sync, true)
    document.addEventListener('focusout', sync, true)
    // The insets are only correct once the document has a body and the platform
    // has settled; one deferred pass catches a first paint taken too early.
    const settle = window.setTimeout(sync, 0)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(settle)
      vv?.removeEventListener('resize', sync)
      vv?.removeEventListener('scroll', sync)
      window.removeEventListener('orientationchange', sync)
      window.removeEventListener('resize', sync)
      document.removeEventListener('focusin', sync, true)
      document.removeEventListener('focusout', sync, true)
    }
  }, [])

  return v
}

const FALLBACK: UsableViewport = {
  width: 375, height: 812, frameWidth: 375, frameHeight: 812,
  safeTop: 0, safeBottom: 0, safeLeft: 0, safeRight: 0,
  keyboard: 0, lift: 0, mode: 'browser', bezel: false,
}

export const ViewportContext = createContext<UsableViewport>(FALLBACK)

/** The resolved viewport, for any component that needs to size against it. */
export const useViewport = (): UsableViewport => useContext(ViewportContext)

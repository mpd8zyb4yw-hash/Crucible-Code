import { useEffect, useState } from 'react'
import { css, cssv } from './css'
import { BOTTOM } from './tokens'
import { restingDivergence, useViewport } from './viewport'

/**
 * THE GEOMETRY READOUT, ON THE DEVICE THAT HAS THE PROBLEM.
 *
 * Every layout bug in this app has been reported from a phone and diagnosed on
 * a laptop, and the gap between those two is where the dead band lived for
 * months: a desktop browser reports one rectangle for the layout viewport, the
 * visual viewport and the window, so an app that confuses them is correct on
 * every machine anyone could inspect it on. The numbers that would have settled
 * it in a second — `innerHeight` next to `clientHeight` next to
 * `visualViewport.height` — were never once looked at on the phone.
 *
 * So they are on the phone now. Open `/#diag` and this is the whole picture:
 * what the platform says, what the app resolved from it, where every layout
 * landmark actually is, and — the part that matters — whether the invariants
 * hold RIGHT NOW, on this device, in this launch mode, with the keyboard in
 * whatever state it is in.
 *
 * It re-measures on every frame that could change any of it, so raising the
 * keyboard, rotating, or collapsing Safari's toolbar can be watched live rather
 * than reasoned about.
 *
 * It is not a debug console and must not become one: it renders measurements
 * and nothing else, it has no side effects on the layout it is measuring
 * (`position:fixed`, its own stacking context, no reflow of anything beneath),
 * and it is reachable only from a URL fragment nobody types by accident.
 */

interface Rect { top: number; bottom: number; left: number; right: number; w: number; h: number }

interface Reading {
  innerH: number
  innerW: number
  clientH: number
  clientW: number
  vvH: number | null
  vvW: number | null
  vvOffsetTop: number | null
  vvScale: number | null
  docScrollH: number
  bodyScrollH: number
  scrollY: number
  standalone: boolean
  displayMode: string
  dpr: number
  rects: Record<string, Rect | null>
  /** Every bottom offset the composer's ancestors contribute, outermost last. */
  ancestry: { name: string; position: string; pad: number; margin: number; bottom: string }[]
  activeElement: string
}

const rectOf = (el: Element | null): Rect | null => {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return {
    top: Math.round(r.top), bottom: Math.round(r.bottom),
    left: Math.round(r.left), right: Math.round(r.right),
    w: Math.round(r.width), h: Math.round(r.height),
  }
}

function read(): Reading {
  const doc = document.documentElement
  const vv = window.visualViewport
  const px = (v: string) => Math.round(parseFloat(v) || 0)

  const ancestry: Reading['ancestry'] = []
  for (let el = document.querySelector('[data-frame="composer"]'); el && el !== doc; el = el.parentElement) {
    const s = getComputedStyle(el)
    ancestry.push({
      name: el.getAttribute('data-frame') ?? el.getAttribute('data-role') ?? el.tagName.toLowerCase(),
      position: s.position,
      pad: px(s.paddingBottom),
      margin: px(s.marginBottom),
      bottom: s.position === 'static' ? '—' : s.bottom,
    })
  }

  return {
    innerH: window.innerHeight,
    innerW: window.innerWidth,
    clientH: doc.clientHeight,
    clientW: doc.clientWidth,
    vvH: vv ? Math.round(vv.height) : null,
    vvW: vv ? Math.round(vv.width) : null,
    vvOffsetTop: vv ? Math.round(vv.offsetTop) : null,
    vvScale: vv ? Math.round(vv.scale * 100) / 100 : null,
    docScrollH: doc.scrollHeight,
    bodyScrollH: document.body.scrollHeight,
    scrollY: Math.round(window.scrollY),
    standalone: (window.navigator as unknown as { standalone?: boolean }).standalone === true,
    displayMode: ['standalone', 'fullscreen', 'minimal-ui', 'browser']
      .find((m) => window.matchMedia(`(display-mode: ${m})`).matches) ?? 'unknown',
    dpr: window.devicePixelRatio,
    rects: {
      root: rectOf(document.getElementById('root')),
      shell: rectOf(document.querySelector('[data-frame="shell"]')),
      usable: rectOf(document.querySelector('[data-frame="usable"]')),
      home: rectOf(document.querySelector('[data-frame="home"]')),
      surface: rectOf(document.querySelector('[data-frame="surface"]')),
      chat: rectOf(document.querySelector('[data-frame="chat"]')),
      settings: rectOf(document.querySelector('[data-frame="settings"]')),
      composer: rectOf(document.querySelector('[data-frame="composer"]')),
    },
    ancestry: ancestry.slice(0, 8),
    activeElement: document.activeElement
      ? `${document.activeElement.tagName.toLowerCase()}${
          (document.activeElement as HTMLElement).isContentEditable ? '[editable]' : ''}`
      : 'none',
  }
}

export function Diagnostics({ onClose }: { onClose: () => void }) {
  const v = useViewport()
  const [r, setR] = useState<Reading>(read)

  useEffect(() => {
    let raf = 0
    const sync = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setR(read()))
    }
    const vv = window.visualViewport
    vv?.addEventListener('resize', sync)
    vv?.addEventListener('scroll', sync)
    window.addEventListener('resize', sync)
    window.addEventListener('orientationchange', sync)
    window.addEventListener('scroll', sync)
    document.addEventListener('focusin', sync, true)
    document.addEventListener('focusout', sync, true)
    // Layout settles a frame or two after a keyboard animation; a slow tick
    // catches anything the events above missed rather than showing a stale rect.
    const tick = window.setInterval(sync, 500)
    return () => {
      cancelAnimationFrame(raf)
      window.clearInterval(tick)
      vv?.removeEventListener('resize', sync)
      vv?.removeEventListener('scroll', sync)
      window.removeEventListener('resize', sync)
      window.removeEventListener('orientationchange', sync)
      window.removeEventListener('scroll', sync)
      document.removeEventListener('focusin', sync, true)
      document.removeEventListener('focusout', sync, true)
    }
  }, [])

  /**
   * THE INVARIANTS, EVALUATED ON THIS DEVICE.
   *
   * The same statements `scripts/geometry.mjs` fails the build over. A green
   * column here and a green build are the same claim measured in two places,
   * which is the only way to know the simulation is honest about the phone.
   */
  const { shell, usable, composer } = r.rects
  const floor = v.keyboard > 0 ? r.clientH - v.keyboard : usable?.bottom ?? 0
  const checks: { label: string; ok: boolean; detail: string }[] = [
    {
      label: 'shell IS the layout viewport',
      ok: !!shell && Math.abs(shell.h - r.clientH) <= 1 && shell.top === 0,
      detail: shell ? `${shell.top}…${shell.bottom} of ${r.clientH}` : 'no shell',
    },
    {
      label: 'app stops one indicator inset above the bottom',
      ok: !!usable && Math.abs((r.clientH - usable.bottom) - v.safeBottom) <= 1,
      detail: usable ? `${r.clientH - usable.bottom}px reserved, inset is ${v.safeBottom}px` : 'no usable rect',
    },
    {
      label: 'composer sits on the bottom edge',
      ok: !composer || (floor - composer.bottom <= BOTTOM.margin + BOTTOM.slack && floor - composer.bottom >= -1),
      detail: composer
        ? `${floor - composer.bottom}px above ${v.keyboard ? 'the keys' : 'the bottom'} ` +
          `(≤ ${BOTTOM.margin + BOTTOM.slack})`
        : 'no composer on screen',
    },
    {
      label: 'the document does not scroll',
      ok: r.docScrollH <= r.clientH + 1 && r.scrollY === 0,
      detail: `scrollHeight ${r.docScrollH} vs ${r.clientH}, scrolled to ${r.scrollY}`,
    },
    {
      label: 'no keyboard reserve without a focused field',
      ok: v.keyboard === 0 || /input|textarea|editable/.test(r.activeElement),
      detail: `keyboard ${v.keyboard}px, focus on ${r.activeElement}`,
    },
  ]
  const failed = checks.filter((c) => !c.ok).length

  const Row = ({ k, val }: { k: string; val: string }) => (
    <div style={css('display:flex; gap:8px; justify-content:space-between; padding:1px 0;')}>
      <span style={css('color:rgba(237,238,241,.42); white-space:nowrap;')}>{k}</span>
      <span style={css('color:rgba(237,238,241,.9); text-align:right;')}>{val}</span>
    </div>
  )

  const Head = ({ children }: { children: React.ReactNode }) => (
    <div style={css('margin:11px 0 3px; font-size:9.5px; font-weight:600; letter-spacing:.09em; text-transform:uppercase; color:#F0A56B;')}>
      {children}
    </div>
  )

  const fmt = (b: Rect | null) => (b ? `${b.top}…${b.bottom}  ${b.w}×${b.h}` : '—')

  return (
    <div
      data-frame="diagnostics"
      style={css(
        'position:fixed; inset:0; z-index:999; overflow-y:auto; -webkit-overflow-scrolling:touch;' +
        'background:rgba(6,6,8,.95); backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px);' +
        'font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10.5px; line-height:1.5;' +
        'padding:calc(env(safe-area-inset-top, 0px) + 12px) 14px calc(env(safe-area-inset-bottom, 0px) + 24px);',
      )}
    >
      <div style={css('display:flex; align-items:center; justify-content:space-between; gap:10px;')}>
        <div style={cssv`font-size:13px; font-weight:600; color:${failed ? '#F0736B' : '#5FC9A6'};`}>
          {failed ? `${failed} INVARIANT${failed > 1 ? 'S' : ''} BROKEN` : 'GEOMETRY OK'}
        </div>
        <button
          type="button"
          onClick={onClose}
          style={css('border:0; padding:7px 13px; border-radius:999px; background:rgba(237,238,241,.9); color:#0B0B0D; font-family:inherit; font-size:11px; font-weight:600; cursor:pointer;')}
        >close</button>
      </div>

      <Head>invariants</Head>
      {checks.map((c) => (
        <div key={c.label} style={css('padding:3px 0; display:flex; gap:7px; align-items:flex-start;')}>
          <span style={cssv`flex:none; color:${c.ok ? '#5FC9A6' : '#F0736B'};`}>{c.ok ? '✓' : '✗'}</span>
          <span style={css('flex:1;')}>
            <span style={cssv`color:rgba(237,238,241,${c.ok ? '.72' : '1'});`}>{c.label}</span>
            <span style={css('display:block; color:rgba(237,238,241,.38);')}>{c.detail}</span>
          </span>
        </div>
      ))}

      <Head>what the platform reports</Head>
      <Row k="window.innerHeight" val={`${r.innerH}`} />
      <Row k="documentElement.clientHeight" val={`${r.clientH}`} />
      <Row k="visualViewport.height" val={r.vvH === null ? 'unsupported' : `${r.vvH}`} />
      <Row k="visualViewport.offsetTop" val={r.vvOffsetTop === null ? '—' : `${r.vvOffsetTop}`} />
      <Row k="visualViewport.scale" val={r.vvScale === null ? '—' : `${r.vvScale}`} />
      <Row k="innerWidth / clientWidth" val={`${r.innerW} / ${r.clientW}`} />
      <Row k="document.scrollHeight" val={`${r.docScrollH}`} />
      <Row k="body.scrollHeight" val={`${r.bodyScrollH}`} />
      <Row k="window.scrollY" val={`${r.scrollY}`} />
      <Row k="devicePixelRatio" val={`${r.dpr}`} />
      <Row k="navigator.standalone" val={String(r.standalone)} />
      <Row k="display-mode" val={r.displayMode} />
      <Row k="document.activeElement" val={r.activeElement} />

      <Head>safe areas, as env() reports them</Head>
      <Row k="top" val={`${v.safeTop}`} />
      <Row k="bottom" val={`${v.safeBottom}`} />
      <Row k="left / right" val={`${v.safeLeft} / ${v.safeRight}`} />

      <Head>what the app resolved</Head>
      <Row k="mode" val={v.mode} />
      <Row k="frame (layout viewport)" val={`${v.frameWidth}×${v.frameHeight}`} />
      <Row k="usable content" val={`${v.width}×${v.height}`} />
      <Row k="resting divergence" val={`${restingDivergence()}`} />
      <Row k="keyboard" val={`${v.keyboard}`} />
      <Row k="lift (bottom layers rise by)" val={`${v.lift}`} />
      <Row k="bezel" val={String(v.bezel)} />

      <Head>where things actually are — top…bottom, w×h</Head>
      {Object.entries(r.rects).map(([k, b]) => <Row key={k} k={k} val={fmt(b)} />)}

      <Head>every bottom offset above the composer</Head>
      {r.ancestry.length === 0 && <Row k="—" val="no composer on screen" />}
      {r.ancestry.map((a, i) => (
        <Row
          key={i}
          k={a.name}
          val={`${a.position}  pad ${a.pad}  margin ${a.margin}  bottom ${a.bottom}`}
        />
      ))}
    </div>
  )
}

/**
 * Is the readout being asked for?
 *
 * A fragment rather than a query string, so opening it costs no reload and
 * closing it leaves no trace in a URL that gets added to a Home Screen. A
 * launched icon carrying `?diag=1` forever would be a very slow-burning way to
 * ship a debug panel to production.
 */
export const wantsDiagnostics = (): boolean =>
  typeof window !== 'undefined' && /(^|[#&])diag\b/.test(window.location.hash)

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { css, cssv } from '../css'
import { accentOf } from '../heat'
import type { WidgetPlace } from '../api'
import { cancelOperation, runOperation, useSurface, put } from '../surface/store'
import type { SurfaceObject } from '../surface/types'
import { CARD, Chip, IconButton, Op, Toolbar } from './kit'
import { ageSeconds, locationState, probePermission, requestLocation, useLocation } from '../surface/location'
import { CHROME } from '../tokens'

/**
 * A map you can actually move.
 *
 * The previous one framed its pins and that was the whole interaction: it
 * computed a bounding box, drew tiles, and there was nothing to do. You could
 * not look at what was next door, which is most of what a map is for.
 *
 * Tiles and routing stay keyless — OpenStreetMap, Nominatim, OSRM — for the
 * reasons they always were: the hosted app runs under a strict CSP with no
 * external scripts, so a mapping library is not an option, and a slippy map is
 * a grid of 256px PNGs at computed coordinates. That part is arithmetic.
 *
 * What is new is that the viewport is surface state rather than a derived
 * value. That single change is what makes "take me to Rome" and dragging with a
 * thumb the same operation, and it is why the model can be told where he is
 * looking without anyone having to invent a way to ask the map.
 */

const TILE = 256
/** Fallbacks only; the real size is measured below. */
const W0 = 343
const H0 = 230

/**
 * A LEVEL IS FETCHED FOR MORE GROUND THAN THE CANVAS SHOWS.
 *
 * The grid used to stop exactly at the canvas rect, which is right for exactly
 * one situation: a level drawn at 1:1 and not moving. The two moments that
 * matter most are neither. A live pinch-in scales the whole plane down about
 * the fingers — as far as 0.25 — so a grid cut to the canvas becomes a postage
 * stamp in the middle of bare panel; and after a zoom-out the outgoing level is
 * drawn at s=0.5, covering a quarter of the frame with the rest empty.
 *
 * Half a tile of bleed on every side, and not more, because every tile is a
 * request to a volunteer-run service: this is roughly one extra column and one
 * extra row, it covers the s=0.5 fallback for any canvas up to ~512px in that
 * axis, and the destination level requested DURING the gesture (see `landing`)
 * covers the deep pinch-in that no affordable margin ever could.
 */
const MARGIN = TILE / 2
/**
 * How many zoom levels stay mounted at once. Three is the level he is on plus
 * two fallbacks under it — enough for a pinch that crosses two levels — and it
 * is a cap rather than a policy: retained layers are dropped the moment the
 * current one covers the frame, and this only bounds the pathological case
 * where it never does (a tile that will not load).
 */
const KEEP = 3
/**
 * A fallback more than two levels away is a 4x smear, and at eight levels it is
 * a 256px PNG asked to fill 65,000px — geography nobody can read and a texture
 * the compositor has to carry. Past this distance there is nothing to retain.
 */
const REACH = 2

/** Shallow list equality, so a layer set that did not change keeps its identity. */
const sameList = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i])

const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * Math.pow(2, z)
const latToY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z)
}
const xToLon = (x: number, z: number) => (x / Math.pow(2, z)) * 360 - 180
const yToLat = (y: number, z: number) => {
  const n = Math.PI - 2 * Math.PI * (y / Math.pow(2, z))
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

interface Props {
  surfaceKey: string
  title: string
  places: WidgetPlace[]
  follow?: boolean
  searchable?: boolean
  route?: 'walk' | 'drive' | 'cycle'
  zoom?: number
  heat: string
}

export default function MapSurface({ surfaceKey, title, places, searchable, heat, zoom }: Props) {
  /**
   * The canvas measures itself.
   *
   * Tile coverage used to be computed from two constants while the element was
   * laid out by flexbox. The moment the canvas stopped being exactly 343×230 —
   * which is what filling the frame means — the tile grid was computed for a
   * box that no longer existed and the map rendered nothing at all. A
   * container-responsive surface has to derive its geometry from its ACTUAL
   * size, not from the size it was first designed at.
   */
  const canvasRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: W0, h: H0 })
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      const w = Math.max(1, Math.round(e.contentRect.width))
      const h = Math.max(1, Math.round(e.contentRect.height))
      setBox((p) => (Math.abs(p.w - w) < 2 && Math.abs(p.h - h) < 2 ? p : { w, h }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const W = box.w
  const H = box.h

  const [found, setFound] = useState<WidgetPlace[] | null>(null)
  const [route, setRoute] = useState<{ lat: number; lon: number }[] | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null)
  const from = useRef<{ x: number; y: number } | null>(null)
  const moved = useRef(false)

  const all = found ?? places

  const objects: SurfaceObject[] = useMemo(
    () => all.map((p) => ({ id: p.id, label: p.label, sub: p.sub })),
    [all]
  )

  // The first viewport frames everything there is. After that it is his, and
  // adding a pin must not yank the map out from under him.
  const seed = useMemo(() => {
    if (!places.length) return { viewport: { lat: 41.9028, lon: 12.4964, zoom: zoom ?? 11 } }
    const lats = places.map((p) => p.lat)
    const lons = places.map((p) => p.lon)
    const spanLon = Math.max(...lons) - Math.min(...lons) || 1e-4
    const spanLat = Math.max(...lats) - Math.min(...lats) || 1e-4
    const z = places.length > 1
      ? Math.max(2, Math.min(17, Math.floor(Math.min(
          Math.log2((360 * W) / (TILE * spanLon)),
          Math.log2((180 * H) / (TILE * spanLat))
        )) - 1))
      : (zoom ?? 13)
    return {
      viewport: {
        lat: (Math.min(...lats) + Math.max(...lats)) / 2,
        lon: (Math.min(...lons) + Math.max(...lons)) / 2,
        zoom: z,
      },
    }
  }, [places, zoom])

  const [state, send] = useSurface(surfaceKey, 'map', title, objects, seed)
  const vp = state.viewport ?? seed.viewport

  /**
   * Location is asked for, never assumed.
   *
   * This used to call `watchPosition` on mount whenever `follow` was set,
   * which puts a permission dialog in front of him unprompted — the reliable
   * way to get a permanent denial. Now it only probes what the browser already
   * knows (no dialog), and a fix is requested from the control he taps.
   */
  const loc = useLocation()
  useEffect(() => { void probePermission() }, [])

  const me = loc.fix ? { lat: loc.fix.lat, lon: loc.fix.lon } : null

  const locate = async () => {
    const fix = await runOperation(
      surfaceKey,
      { kind: 'locate', provider: 'device', timeoutMs: 15_000 },
      async () => {
        const f = await requestLocation()
        if (!f) {
          return {
            failure: locationState().permission === 'denied' ? ('unsupported' as const) : ('timeout' as const),
            reason: [locationState().error, locationState().recovery].filter(Boolean).join(' '),
          }
        }
        return { value: f, resultCount: 1 }
      },
    )
    const f = fix?.value as { lat: number; lon: number } | undefined
    if (f) send({ op: 'viewport', args: { lat: f.lat, lon: f.lon, zoom: 15 } })
  }

  const z = vp.zoom
  // While a drag is in flight the centre moves in pixels; it is committed to
  // surface state on release, so an interrupted drag never leaves the model
  // reading a coordinate that was mid-gesture.
  const centreX = lonToX(vp.lon, z) - (drag?.dx ?? 0) / TILE
  const centreY = latToY(vp.lat, z) - (drag?.dy ?? 0) / TILE
  const originX = centreX * TILE - W / 2
  const originY = centreY * TILE - H / 2
  const toPx = (lat: number, lon: number) => ({
    x: lonToX(lon, z) * TILE - originX,
    y: latToY(lat, z) * TILE - originY,
  })

  /**
   * The tiles a given zoom level needs to cover this canvas, with bleed.
   *
   * Taken as a function of z rather than closing over it, because the retained
   * layers below have to compute their own coverage at their own level. The
   * geographic centre is shared: every level is framed on the same point, so
   * scaling one into another's place is a pure transform.
   *
   * THE KEY NO LONGER USES THE WRAPPED COLUMN. It was `${z}/${wx}/${y}` while
   * `left` used the unwrapped `x`, so on a canvas wider than the world — which
   * the z=2 clamp reaches on any wide viewport — two tiles shared one key with
   * different positions, React dropped one, and a column of map went missing.
   * The URL still uses `wx`, which is the part the server needs.
   */
  const tilesFor = useCallback(
    (level: number) => {
      const cx = lonToX(vp.lon, level) - (drag?.dx ?? 0) / TILE / 2 ** (z - level)
      const cy = latToY(vp.lat, level) - (drag?.dy ?? 0) / TILE / 2 ** (z - level)
      const ox = cx * TILE - W / 2
      const oy = cy * TILE - H / 2
      const out: { key: string; url: string; left: number; top: number }[] = []
      const n = Math.pow(2, level)
      for (let x = Math.floor((ox - MARGIN) / TILE); x <= Math.floor((ox + W + MARGIN) / TILE); x++) {
        for (let y = Math.floor((oy - MARGIN) / TILE); y <= Math.floor((oy + H + MARGIN) / TILE); y++) {
          if (y < 0 || y >= n) continue
          const wx = ((x % n) + n) % n
          out.push({
            key: `${level}/${x}/${y}`,
            url: `https://tile.openstreetmap.org/${level}/${wx}/${y}.png`,
            left: x * TILE - ox,
            top: y * TILE - oy,
          })
        }
      }
      return { tiles: out, ox, oy }
    },
    [vp.lat, vp.lon, z, W, H, drag]
  )

  const current = useMemo(() => tilesFor(z), [tilesFor, z])
  const tiles = current.tiles

  /**
   * RETAINED LAYERS: the fix for the blank.
   *
   * What was here before tried to keep ONE previous layer in a ref and decide,
   * during render, whether to draw it — by comparing a ref (immediate) against
   * a state counter (one render behind). Two effects then raced over that pair
   * on every zoom change: `setReady(0)` and the promote-to-good effect ran in
   * the same flush, in declaration order, with no render between them, so the
   * promote effect saw the PREVIOUS level's `ready` count, concluded the new
   * level was already good, and overwrote the fallback with a layer that had
   * loaded nothing. From then on `prev.z === z` and the fallback was never
   * drawn again. The stale-while-revalidate mechanism the comment described was
   * dead code on the one path it existed for.
   *
   * Three changes make the blank structurally impossible rather than merely
   * unlikely:
   *
   *   Layers STAY MOUNTED. A zoom no longer unmounts anything; the outgoing
   *   level keeps its <img> elements, so its decoded bitmaps are still in the
   *   compositor and it can be shown instantly, at any moment, at no cost.
   *   Returning to a level visited two pinches ago costs nothing either.
   *
   *   Coverage is tracked PER TILE, not by a counter. `ready` could exceed
   *   `tiles.length` after a pan (edge tiles push it up and only a zoom reset
   *   it), so the one comparison the old logic rested on was already false
   *   before a pinch started. A keyed set answers "is this level covered?"
   *   exactly, and answers it for every retained level independently.
   *
   *   Failures are counted SEPARATELY. `onError` incremented the same counter
   *   as `onLoad`, so a level whose tiles all 404'd reached full "readiness",
   *   suppressed the fallback, and left a permanently empty rectangle with no
   *   message. A level is covered only by tiles that actually painted; a level
   *   that has finished trying and failed says so instead.
   */
  const [painted, setPainted] = useState<Record<string, 'ok' | 'fail'>>({})
  const notePaint = useCallback(
    (key: string, how: 'ok' | 'fail') =>
      setPainted((p) => (p[key] === how ? p : { ...p, [key]: how })),
    []
  )

  const covers = useCallback(
    (t: { key: string }[]) => t.length > 0 && t.every((x) => painted[x.key] === 'ok'),
    [painted]
  )

  /**
   * Which levels are on screen, newest last.
   *
   * State, not a ref, so a change is batched with the paint that caused it and
   * render never compares two values that describe different moments. `z` is
   * appended the instant it becomes current and older levels are dropped only
   * once `z` genuinely covers the frame — never on a timer, and never as a side
   * effect of an unrelated render.
   */
  const [layers, setLayers] = useState<number[]>([z])

  useEffect(() => {
    setLayers((held) => {
      const withCurrent = held.includes(z) ? held : [...held, z]
      // Only levels close enough to be readable when stretched are worth
      // keeping: at four levels away a 256px tile is asked to fill 4096px.
      const near = withCurrent.filter((l) => l === z || Math.abs(l - z) <= REACH)
      const settled = covers(current.tiles)
      const kept = settled ? [z] : near.slice(-KEEP)
      return sameList(kept, held) ? held : kept
    })
  }, [z, covers, current.tiles])

  /**
   * The one level that is definitely showing something, for the failure notice.
   * A frame with no covered layer at all and nothing still loading is a genuine
   * tile failure, which the surface says out loud rather than drawing nothing.
   */
  const anyCovered = layers.some((l) => (l === z ? covers(current.tiles) : true))
  const currentFailed =
    tiles.length > 0 && tiles.every((t) => painted[t.key]) && tiles.some((t) => painted[t.key] === 'fail')

  const commit = () => {
    if (!drag) return
    const lat = yToLat(centreY, z)
    const lon = xToLon(centreX, z)
    setDrag(null)
    from.current = null
    put(surfaceKey, { viewport: { lat, lon, zoom: z } }, 'Moved the map.')
  }

  /**
   * PINCH-TO-ZOOM, AS A GESTURE RATHER THAN A SEQUENCE OF DECISIONS.
   *
   * The first version tracked both fingers correctly and then did three things
   * that are each individually why it did not feel like a map:
   *
   *   · IT QUANTISED WHILE THE FINGERS WERE STILL MOVING. `Math.round` on every
   *     move meant the map sat still, jumped a whole power of two, sat still.
   *     Measured on a slow spread it went 7 → 8 → 8 → 8 → 9: three visible
   *     steps for a continuous gesture.
   *   · IT ZOOMED ABOUT THE CENTRE OF THE CANVAS, not about the fingers. Pinch
   *     on a town near the edge and the town slides away from you — which is
   *     the single clearest tell that a map is not a real one.
   *   · IT WROTE SURFACE STATE ON EVERY STEP. Each `put` pushes an UNDO ENTRY
   *     and a localStorage write and rebuilds the whole tile grid, so one pinch
   *     left three "Zoomed the map." entries in a 60-deep history — "undo"
   *     after a pinch undid a third of it — and re-fetched tiles mid-gesture.
   *
   * So the gesture is now live and local: a continuous scale about the fingers'
   * own midpoint, applied to the painted layer as a transform, committed ONCE on
   * release as a single zoom level and a focal-point-corrected centre. One
   * gesture, one state change, one undo entry, one tile fetch.
   *
   * `touch-action:none` on the canvas (below) is what makes this reliable: it
   * tells Safari not to claim the touch for scrolling or its own page zoom
   * first, which is the usual reason a map inside a scrolling page feels dead.
   */
  const pinch = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchFrom = useRef<{ gap: number; zoom: number; lat: number; lon: number; fx: number; fy: number } | null>(null)
  /** Live scale while two fingers are down. `null` when the viewport governs. */
  const [live, setLive] = useState<{ scale: number; fx: number; fy: number } | null>(null)

  /** Finger positions in CANVAS coordinates — the focal point has to be local. */
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }

  const two = () => [...pinch.current.values()]
  const gap = () => {
    const [a, b] = two()
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }
  const midpoint = () => {
    const [a, b] = two()
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: W / 2, y: H / 2 }
  }

  const onDown = (e: React.PointerEvent) => {
    pinch.current.set(e.pointerId, local(e))
    // Capture keeps a finger that slides off the canvas still driving the map.
    // It is an enhancement, not a precondition: it throws for any pointer the
    // browser is not already tracking, and an exception here used to abort the
    // handler before the pinch baseline below was ever recorded — killing the
    // whole gesture. Never let it decide whether the map responds.
    try { (e.target as Element).setPointerCapture?.(e.pointerId) } catch { /* not tracked */ }
    if (pinch.current.size === 2) {
      // Second finger down: stop panning and start scaling from here. The
      // baseline records where the map WAS, so the whole gesture is measured
      // against one origin rather than against its own last frame.
      const m = midpoint()
      pinchFrom.current = { gap: gap(), zoom: z, lat: vp.lat, lon: vp.lon, fx: m.x, fy: m.y }
      from.current = null
      setDrag(null)
      setLive({ scale: 1, fx: m.x, fy: m.y })
      return
    }
    from.current = { x: e.clientX, y: e.clientY }
    moved.current = false
  }

  const onMove = (e: React.PointerEvent) => {
    if (pinch.current.has(e.pointerId)) pinch.current.set(e.pointerId, local(e))

    if (pinch.current.size >= 2 && pinchFrom.current) {
      const g = gap()
      if (!g || !pinchFrom.current.gap) return
      moved.current = true
      // Bounded so a two-finger sweep cannot magnify one tile to fill the
      // screen before the fresh ones are asked for on release.
      const scale = Math.max(0.25, Math.min(4, g / pinchFrom.current.gap))
      setLive({ scale, fx: pinchFrom.current.fx, fy: pinchFrom.current.fy })
      return
    }

    if (!from.current) return
    const dx = e.clientX - from.current.x
    const dy = e.clientY - from.current.y
    // A few pixels of travel is a tap on a phone, not a drag. Without the
    // threshold, selecting a pin is nearly impossible with a thumb.
    if (Math.abs(dx) + Math.abs(dy) > 4) moved.current = true
    setDrag({ dx, dy })
  }

  /**
   * Land the pinch: one zoom level, and the point under the fingers stays put.
   *
   * The correction is the whole reason this is worth arithmetic. Zooming keeps
   * the CENTRE fixed unless something moves it, and what the hand expects is for
   * the thing between its fingers to stay between its fingers. So the focal
   * point is converted to world coordinates at the old level, scaled to the new
   * one, and the centre is placed wherever leaves it at the same screen offset.
   */
  const landPinch = () => {
    const base = pinchFrom.current
    const l = live
    pinchFrom.current = null
    setLive(null)
    if (!base || !l) return
    const zoom = Math.max(2, Math.min(18, Math.round(base.zoom + Math.log2(l.scale))))
    if (zoom === base.zoom) return
    const k = Math.pow(2, zoom - base.zoom)
    // Focal offset from the canvas centre, in tiles.
    const ox = (base.fx - W / 2) / TILE
    const oy = (base.fy - H / 2) / TILE
    const focalX = (lonToX(base.lon, base.zoom) + ox) * k
    const focalY = (latToY(base.lat, base.zoom) + oy) * k
    put(
      surfaceKey,
      { viewport: { lat: yToLat(focalY - oy, zoom), lon: xToLon(focalX - ox, zoom), zoom } },
      'Zoomed the map.',
    )
  }

  const onUp = (e: React.PointerEvent) => {
    pinch.current.delete(e.pointerId)
    // The gesture ends when the SECOND finger leaves, and it commits exactly
    // once. Lifting one finger of a pinch must not commit a pan of the whole
    // gesture, and must not leave a live scale painted with nothing driving it.
    if (pinch.current.size < 2 && pinchFrom.current) landPinch()
    if (pinch.current.size === 0) commit()
    else from.current = null
  }

  const onCancel = (e: React.PointerEvent) => {
    // A cancelled pointer is not a completed gesture: drop the live scale
    // rather than committing a zoom nobody finished asking for.
    pinch.current.delete(e.pointerId)
    if (pinch.current.size < 2) { pinchFrom.current = null; setLive(null) }
    if (pinch.current.size === 0) { setDrag(null); from.current = null }
  }

  const search = async (q: string) => {
    if (!q.trim() || busy) return
    setBusy('Searching…')
    setFailed(null)
    try {
      const r = await fetch(`/api/map/search?q=${encodeURIComponent(q)}`)
      const b = await r.json()
      if (!r.ok) throw new Error(b?.error ?? 'Search failed')
      if (!b.places?.length) { setFailed(`Nothing found for “${q}”.`); return }
      setFound(b.places as WidgetPlace[])
      setRoute(null)
      setSummary(null)
      const first = b.places[0] as WidgetPlace
      put(surfaceKey, { viewport: { lat: first.lat, lon: first.lon, zoom: 13 }, focus: null }, `Found ${b.places.length} for “${q}”.`)
    } catch (e) {
      setFailed((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const draw = async (mode: 'walk' | 'drive' | 'cycle') => {
    const a = me ?? all.find((p) => p.id === state.focus) ?? all[0]
    const b = all.find((p) => p.id === state.focus && p !== a) ?? all[all.length - 1]
    if (!a || !b || a === b) { setFailed('I need two places to draw a route between.'); return }
    setBusy('Routing…')
    setFailed(null)
    try {
      const r = await fetch(`/api/map/route?from=${a.lat},${a.lon}&to=${b.lat},${b.lon}&mode=${mode}`)
      const body = await r.json()
      if (!r.ok) throw new Error(body?.error ?? 'Routing failed')
      setRoute(body.points ?? [])
      setSummary(body.summary ?? null)
    } catch (e) {
      setFailed((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const pins = me ? [...all, { id: '__me', label: 'You', lat: me.lat, lon: me.lon, self: true }] : all
  const focused = all.find((p) => p.id === state.focus) ?? null

  return (
    /*
      THE FRAME IS THE MAP.

      Route modes, the location control, its permission explanation, the note
      line and the operation strip were five stacked rows below the canvas, so
      on a phone the map got a slot and its controls got the rest — and the
      location button ended up below the fold of its own surface. All of it is
      now one toolbar plus overlays ON the canvas, and the map takes the frame.
    */
    <div style={css('height:100%; min-height:0; display:flex; flex-direction:column; gap:6px; padding:8px 14px 6px; box-sizing:border-box;')}>
      <Toolbar
        left={
          searchable ? (
            <input
              value={state.query}
              placeholder="Search for a place…"
              onChange={(e) => send({ op: 'search', args: { query: e.target.value } })}
              onKeyDown={(e) => { if (e.key === 'Enter') void search(state.query) }}
              style={cssv`flex:1; min-width:0; height:${CHROME.control}px; padding:0 12px; border-radius:999px;
                border:0; outline:0; font-family:inherit; font-size:11.5px; color:rgba(237,238,241,.9); ${CARD}`}
            />
          ) : (
            <div style={css('font-size:12.5px; font-weight:600; color:rgba(237,238,241,.9);')}>{title}</div>
          )
        }
        right={
          <IconButton
            glyph={loc.requesting ? '·' : '◎'}
            title={me ? 'Recentre on me' : 'Use my location'}
            onClick={() => void locate()}
          />
        }
        more={
          <>
            {(['walk', 'cycle', 'drive'] as const).map((m) => (
              <Chip key={m} label={busy === 'Routing…' ? '…' : m} onClick={() => void draw(m)} />
            ))}
            {found && <Chip label="back to mine" onClick={() => { setFound(null); send({ op: 'clear' }) }} />}
            {me && loc.fix && (
              <Chip
                dim
                label={`${loc.fix.provenance === 'live-device' ? 'live' : loc.fix.provenance}${loc.fix.accuracy != null ? ` ±${loc.fix.accuracy}m` : ''}${ageSeconds(loc.fix) != null ? ` · ${ageSeconds(loc.fix)}s` : ''}`}
              />
            )}
          </>
        }
      />

      {/*
        ONE ROW, CARRYING THE CAUSE AND THE WAY OUT.

        It was one NOWRAP line reading `${error ?? 'No location.'} ${recovery}`,
        and both halves failed at once: the probe never set `error`, so the
        fallback "No location." was what actually appeared — a problem announced
        with no cause — and had the real text been there, `text-overflow:ellipsis`
        would have eaten the recovery, which is the half he can act on.
        "Something is wrong and I won't say what" is worse than saying nothing.

        Two clamped lines, only ever in a state that IS a fault. `prompt` is not
        a fault and draws nothing: he simply has not been asked yet, and the ◎
        in the toolbar is the asking.
      */}
      {(loc.permission === 'denied' || loc.permission === 'unsupported' || failed || (currentFailed && !anyCovered)) && (
        <div
          data-role="location-note"
          style={css('flex:none; padding:0 2px; font-size:11px; line-height:1.35; color:rgba(240,165,107,.7); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;')}
        >
          {/*
            A TILE FAILURE IS SAID OUT LOUD.

            It used to be indistinguishable from empty terrain: `onError` and
            `onLoad` incremented the same counter, so a level whose tiles all
            failed counted as fully painted, suppressed the fallback, and left a
            dark rectangle that looks exactly like a map of nowhere. Only
            reported when nothing else is covering the frame — a failed level
            under a working fallback is not something he needs to hear about.
          */}
          {failed ?? (currentFailed && !anyCovered ? 'The map tiles would not load. The map is still where you left it.' : null) ?? loc.error ?? 'No location.'}
          {!failed && loc.recovery ? <span style={css('color:rgba(237,238,241,.42);')}> {loc.recovery}</span> : null}
        </div>
      )}

      <div
        ref={canvasRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onCancel}
        /* Declared, not inferred: the tile layer extends past this box by
           design and is reached by DRAGGING rather than by scrolling. The
           visual gate exempts anything inside a pannable region for exactly
           that reason — and refuses to exempt anything that has not said so. */
        data-pannable="map"
        style={cssv`position:relative; flex:1; min-height:0; border-radius:15px; overflow:hidden; background:#1b1d22; box-shadow:inset 0 0 0 1px rgba(255,255,255,.07); touch-action:none; cursor:${drag ? 'grabbing' : 'grab'};`}
      >
        {/*
          THE GEOGRAPHY, AND THE LIVE PINCH APPLIED TO ALL OF IT AT ONCE.

          Tiles, route and pins scale together about the fingers' midpoint while
          two fingers are down, so the whole map moves as one thing under the
          hand instead of the tiles jumping a level while the pins stay put. The
          zoom buttons and the attribution are deliberately OUTSIDE this: a
          control that grows with the map is a control that moves away from the
          thumb pressing it.

          Zero cost when nothing is pinching — `live` is null and no transform
          is written at all, so the resting paint is bit-identical.
        */}
        <div
          data-role="map-plane"
          style={live
            ? cssv`position:absolute; inset:0; will-change:transform;
                transform-origin:${live.fx}px ${live.fy}px; transform:scale(${live.scale.toFixed(4)});`
            : css('position:absolute; inset:0;')}
        >
        {/* The dark treatment used to be grayscale(.82) brightness(.44), which
            over sparse terrain rendered the map as a uniform dark rectangle —
            the tiles loaded, decoded and drew, and the surface still read as an
            empty panel. A map nobody can see is not a map, so this is tuned to
            stay legible against the panel rather than to blend into it. */}
        {/*
          EVERY RETAINED LEVEL, DEEPEST FIRST, EACH SCALED INTO THIS FRAME.

          `layers` is ordered oldest-first, so the current level paints last and
          therefore on top; the ones under it are the fallback and are only
          reached where the top layer has not painted yet. Nothing is unmounted
          on a zoom change, which is the whole point — an element that stays
          mounted keeps its decoded bitmap, so the layer beneath is available on
          the very frame the zoom commits, with no fetch and no decode.

          The transform is the same arithmetic the old single fallback used, now
          applied per level: scale by the level difference and translate by the
          difference in origins, which puts each level's tiles exactly where the
          same ground is on the current one. Pins and the route are OUTSIDE this
          block and positioned by `toPx` at the current level, so they line up
          with the top layer at every scale.
        */}
        {layers.map((level) => {
          const layer = level === z ? current : tilesFor(level)
          const s = 2 ** (z - level)
          return (
            <div
              key={`layer-${level}`}
              aria-hidden={level !== z}
              style={cssv`position:absolute; left:0; top:0; transform-origin:0 0;
                transform:translate(${(s * layer.ox - originX).toFixed(2)}px, ${(s * layer.oy - originY).toFixed(2)}px) scale(${s});`}
            >
              {layer.tiles.map((t) => (
                <img
                  key={t.key}
                  src={t.url}
                  alt=""
                  /* Not lazy: these are the visible viewport, and deferring them
                     is exactly what leaves the panel empty. */
                  draggable={false}
                  referrerPolicy="no-referrer"
                  /* Counted separately so a level that failed cannot pass as a
                     level that painted — which is how a dead tile used to
                     suppress the fallback and leave an empty rectangle. */
                  onLoad={() => notePaint(t.key, 'ok')}
                  onError={() => notePaint(t.key, 'fail')}
                  /*
                    THE SAME PLATE AS THE PLACES WIDGET.

                    This was `grayscale(.7) brightness(.92)` — a barely-touched
                    light-mode raster, so opening Places from a dark widget put
                    a white rectangle on the screen and the two depths of one
                    domain did not look like the same product. Desaturate, then
                    invert, then dim: the order matters, because inverting OSM's
                    colour directly turns its landcover olive and its roads pink.
                  */
                  style={cssv`position:absolute; width:${TILE}px; height:${TILE}px; left:${t.left}px; top:${t.top}px; filter:grayscale(1) invert(1) brightness(.62) contrast(1.02); opacity:.72; pointer-events:none;`}
                />
              ))}
            </div>
          )
        })}

        {route && route.length > 1 && (
          <svg width={W} height={H} style={css('position:absolute; left:0; top:0; pointer-events:none;')}>
            <path
              d={route.map((p, i) => { const q = toPx(p.lat, p.lon); return `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}` }).join(' ')}
              fill="none"
              stroke={accentOf('teal', heat)}
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.95"
            />
          </svg>
        )}

        {pins.map((p) => {
          const q = toPx(p.lat, p.lon)
          if (q.x < -30 || q.x > W + 30 || q.y < -30 || q.y > H + 30) return null
          const self = 'self' in p && p.self
          const on = state.focus === p.id || state.selected.includes(p.id)
          return (
            <div
              key={p.id}
              onClick={() => { if (!moved.current && !self) send({ op: 'focus', args: { id: p.id } }) }}
              style={cssv`position:absolute; left:${q.x}px; top:${q.y}px; transform:translate(-50%,-50%); display:flex; flex-direction:column; align-items:center; gap:3px; cursor:pointer; z-index:${on ? '4' : '2'};`}
            >
              <div style={cssv`width:${self ? '13' : on ? '15' : '11'}px; height:${self ? '13' : on ? '15' : '11'}px; border-radius:999px; background:${self ? '#7CD9C0' : accentOf('rose', heat)}; box-shadow:0 0 0 ${on ? '3.5' : '3'}px rgba(11,11,13,.65), 0 1px 5px rgba(0,0,0,.5)${on ? ', 0 0 0 5px rgba(237,238,241,.55)' : ''};`} />
              {!self && (
                <div style={cssv`max-width:110px; padding:2px 6px; border-radius:6px; background:rgba(11,11,13,${on ? '.92' : '.78'}); font-size:9.5px; line-height:1.3; color:rgba(237,238,241,${on ? '1' : '.9'}); text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`}>
                  {p.label}
                </div>
              )}
            </div>
          )
        })}

        </div>

        <div style={css('position:absolute; right:6px; top:6px; display:flex; flex-direction:column; gap:5px; z-index:5;')}>
          {([['+', 1], ['−', -1]] as const).map(([glyph, d]) => (
            <div
              key={glyph}
              onClick={(e) => { e.stopPropagation(); send({ op: 'viewport', args: { lat: vp.lat, lon: vp.lon, zoom: Math.max(2, Math.min(18, z + d)) } }) }}
              style={css('width:26px; height:26px; border-radius:8px; background:rgba(11,11,13,.72); box-shadow:inset 0 0 0 1px rgba(255,255,255,.14); display:flex; align-items:center; justify-content:center; font-size:14px; color:rgba(237,238,241,.85); cursor:pointer;')}
            >
              {glyph}
            </div>
          ))}
        </div>

        {/* OpenStreetMap's licence requires attribution wherever its tiles are shown. */}
        <div style={css('position:absolute; right:5px; bottom:4px; font-size:8.5px; color:rgba(237,238,241,.42); background:rgba(11,11,13,.5); padding:1px 5px; border-radius:4px; z-index:5;')}>
          © OpenStreetMap
        </div>
      </div>

      {focused && (
        <div style={cssv`padding:11px 12px; display:flex; gap:10px; align-items:flex-start; ${CARD}`}>
          <div style={css('flex:1; min-width:0;')}>
            <div style={css('font-size:13px; font-weight:600; color:rgba(237,238,241,.92); text-wrap:pretty;')}>{focused.label}</div>
            {focused.sub && <div style={css('margin-top:3px; font-size:11.5px; color:rgba(237,238,241,.5); text-wrap:pretty;')}>{focused.sub}</div>}
            <div style={css('margin-top:3px; font-size:10.5px; color:rgba(237,238,241,.3); font-variant-numeric:tabular-nums;')}>
              {focused.lat.toFixed(4)}, {focused.lon.toFixed(4)}
            </div>
          </div>
          <div onClick={() => send({ op: 'clear' })} style={css('flex:none; font-size:13px; color:rgba(237,238,241,.35); cursor:pointer;')}>✕</div>
        </div>
      )}

      {summary && <div style={css('font-size:12px; color:rgba(237,238,241,.6);')}>{summary}</div>}

      {/* Route modes, the location control and its explanation all moved into
          the toolbar and the status line above. They are not repeated here. */}

      <Op op={state.operation} onCancel={() => cancelOperation(surfaceKey)} onRetry={() => void locate()} />
    </div>
  )
}

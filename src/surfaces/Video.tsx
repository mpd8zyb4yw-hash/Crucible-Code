import { useMemo, useState } from 'react'
import { css, cssv } from '../css'
import type { VideoObject, WidgetAction } from '../api'
import { cancelOperation, runOperation, useSurface, useSurfaceState } from '../surface/store'
import type { SurfaceObject } from '../surface/types'
import { Actions, CARD, Chip, IconButton, Op, Toolbar, runtime, shortWhen } from './kit'
import { CHROME, TYPE } from '../tokens'
import {
  DESTINATIONS, openAt, preferredDestination, rememberDestination,
  type DestinationId,
} from '../externalOpen'

/**
 * Video results.
 *
 * The media primitive drew a picture and a title, which is most of what a video
 * needs and none of what it needs to be OPERATED. "Only the ones over thirty
 * minutes" is not expressible against a caption; it needs the runtime as a
 * number, which is now carried from the same `videos.list` record as the title
 * and the thumbnail rather than being re-derived from a string.
 *
 * "Keep these two and replace the rest" splits cleanly along the line this
 * whole app is built on: keeping is UI state and happens here, instantly;
 * replacing is a new query against the source and belongs to the pane's plan,
 * so it goes back to the server as a refinement and comes back as a revision.
 */

interface Props {
  surfaceKey: string
  title: string
  videos: VideoObject[]
  empty?: string
  onAction: (a: WidgetAction) => Promise<void>
  /** Ask the source for something new. Absent when this surface has no plan. */
  onRefine?: (intent: string) => Promise<void>
}

const LENGTHS: { label: string; args: Record<string, number | null> }[] = [
  { label: 'any length', args: { minMinutes: null, maxMinutes: null } },
  { label: 'under 5 min', args: { minMinutes: null, maxMinutes: 5 } },
  { label: 'over 20 min', args: { minMinutes: 20, maxMinutes: null } },
  { label: 'over 30 min', args: { minMinutes: 30, maxMinutes: null } },
]

/** Where results may be retrieved from. Personal signal is optional, not required. */
type Scope = 'open' | 'subscriptions' | 'likes'
const SCOPE_LABEL: Record<Scope, string> = {
  open: 'all of YouTube', subscriptions: 'subscriptions', likes: 'likes',
}
const SCOPE_PHASE: Record<Scope, string> = {
  open: 'across YouTube', subscriptions: 'your subscriptions', likes: 'your likes',
}

export default function Video({ surfaceKey, title, videos, empty, onAction, onRefine }: Props) {
  const [seed] = useState(() => ({ view: 'grid', sort: 'at:desc' }))
  const pre = useSurfaceState(surfaceKey, 'video', seed)
  const [refining, setRefining] = useState(false)

  /**
   * Results retrieved by this surface itself, as opposed to the synced library
   * passed in as `videos`. When a search has run, what it found IS the library
   * for as long as he is looking at it — the same surface fills in, rather than
   * results appearing somewhere else while YouTube still says it is empty.
   */
  /**
   * WHERE a video opens is a separate decision from WHICH video it is.
   *
   * `null` means he has never chosen, so the first Watch offers the choice
   * instead of guessing. After that the button goes straight to his
   * destination and the picker stays reachable by long-press — one tap for the
   * common case, without taking the choice away.
   */
  const [destination, setDestination] = useState<DestinationId | null>(() => preferredDestination())
  const [picking, setPicking] = useState<VideoObject | null>(null)
  const [openNote, setOpenNote] = useState<string | null>(null)

  /** A video with no server-verified URL cannot be opened, and says so. */
  const openable = (v: VideoObject) => typeof v.url === 'string' && v.url.length > 0

  /**
   * A DESTINATION THAT DID NOT ANSWER, AND WHAT IS OFFERED INSTEAD.
   *
   * Held as state rather than announced in a note, because the honest response
   * to "I could not tell whether Brave opened" is a choice, and a choice needs
   * somewhere to live. `openAt` no longer substitutes a browser on its own —
   * see the note there — so this is where the substitution becomes his.
   */
  const [stalled, setStalled] = useState<{ video: VideoObject; tried: DestinationId } | null>(null)

  const openVideo = async (v: VideoObject) => {
    if (!openable(v)) return
    if (!destination) { setPicking(v); return }
    const how = await openAt(v.url!, destination)
    if (how === 'not-opened') { setStalled({ video: v, tried: destination }); setOpenNote(null); return }
    setStalled(null)
    // Only ever reports what actually happened. "Opened" is never claimed for a
    // custom scheme nothing answered.
    setOpenNote(
      how === 'copied' ? 'Link copied.'
      : how === 'blocked' ? 'Your browser blocked the pop-up.'
      : null
    )
  }

  const chooseDestination = async (id: DestinationId, andOpen: VideoObject | null) => {
    setDestination(id)
    rememberDestination(id)
    setPicking(null)
    // Told to the server too, so the assistant can reason about it and answer
    // "why does this open in Brave?" — the local copy is what the button uses.
    void fetch('/api/person/correct', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'set-preference', label: id, key: 'video.destination', value: id }),
    }).catch(() => null)
    if (andOpen?.url) {
      const how = await openAt(andOpen.url, id)
      if (how === 'not-opened') setStalled({ video: andOpen, tried: id })
      else { setStalled(null); setOpenNote(null) }
    }
  }

  const [found, setFound] = useState<VideoObject[] | null>(null)
  const [provenance, setProvenance] = useState<string | null>(null)
  const [scope, setScope] = useState<Scope>('open')
  const [box, setBox] = useState('')
  const source = found ?? videos

  const visible = useMemo(() => {
    const f = pre.filters
    const q = pre.query.trim().toLowerCase()
    let out = source.filter((v) => {
      // A video whose runtime nobody knows is not silently dropped by a length
      // filter — it is shown, and its missing duration is visible on the card.
      // Hiding it would be claiming knowledge the app does not have.
      if (typeof f.minMinutes === 'number' && v.seconds !== undefined && v.seconds < f.minMinutes * 60) return false
      if (typeof f.maxMinutes === 'number' && v.seconds !== undefined && v.seconds > f.maxMinutes * 60) return false
      if (typeof f.channel === 'string' && !(v.channel ?? '').toLowerCase().includes(f.channel.toLowerCase())) return false
      if (typeof f.only === 'string' && !f.only.split(',').includes(v.id)) return false
      if (q && !`${v.title} ${v.channel ?? ''}`.toLowerCase().includes(q)) return false
      return true
    })
    const [by = 'at', dir = 'desc'] = (pre.sort ?? 'at:desc').split(':')
    out = [...out].sort((a, b) => {
      const cmp =
        by === 'duration' ? (a.seconds ?? 0) - (b.seconds ?? 0)
        : by === 'title' ? a.title.localeCompare(b.title)
        : (a.publishedAt ?? '').localeCompare(b.publishedAt ?? '')
      return dir === 'asc' ? cmp : -cmp
    })
    return out
  }, [source, pre.filters, pre.query, pre.sort])

  const objects: SurfaceObject[] = useMemo(
    () => visible.map((v) => ({
      id: v.id,
      label: v.title,
      sub: v.channel,
      at: v.publishedAt,
      seconds: v.seconds,
    })),
    [visible]
  )

  const [state, send] = useSurface(surfaceKey, 'video', title, objects, seed)
  const selected = new Set(state.selected)

  // No top-level empty return: an empty library is still YouTube. The chrome and
  // its controls stay on screen and the emptiness is reported inside them,
  // because a surface that vanishes when it has nothing to show cannot be
  // navigated back to something worth showing.

  const activeLength = LENGTHS.find((l) =>
    (l.args.minMinutes ?? null) === (typeof state.filters.minMinutes === 'number' ? state.filters.minMinutes : null) &&
    (l.args.maxMinutes ?? null) === (typeof state.filters.maxMinutes === 'number' ? state.filters.maxMinutes : null)
  )

  /**
   * Open YouTube search, from the surface.
   *
   * The point of the scope selector is that "Nothing watched recently." was
   * never a fact about YouTube — it was a fact about one Google account. This
   * account may not be the one he watches on, so `open` reaches public YouTube
   * with no personal signal required and is the default for a fresh query.
   *
   * Results land in `found`, which takes precedence over the synced library
   * below, so the surface he is already looking at fills in rather than a new
   * card appearing somewhere else.
   */
  const runSearch = async (q: string, scope: Scope = 'open') => {
    const query = q.trim()
    if (!query && scope === 'open') return
    setScope(scope)
    const r = await runOperation(
      surfaceKey,
      { kind: 'search', provider: 'youtube', phase: SCOPE_PHASE[scope] },
      async ({ signal }) => {
        const res = await fetch(
          `/api/youtube/search?scope=${scope}&limit=24&q=${encodeURIComponent(query)}`,
          { signal },
        )
        const b = await res.json().catch(() => ({}))
        // The server names its own failure; pass it through rather than
        // re-deriving one from the status code.
        if (!res.ok) return { failure: b.failure ?? 'provider', reason: b.reason ?? `YouTube returned ${res.status}.` }
        return { value: b, resultCount: Array.isArray(b.videos) ? b.videos.length : 0 }
      },
    )
    const body = r?.value as { videos?: VideoObject[]; provenance?: string } | undefined
    if (body?.videos) {
      setFound(body.videos)
      setProvenance(body.provenance ?? null)
    }
  }

  const replaceRest = async () => {
    if (!onRefine || !state.selected.length) return
    const kept = visible.filter((v) => selected.has(v.id)).map((v) => v.title)
    setRefining(true)
    try {
      await onRefine(`Keep these and find different ones instead of the rest: ${kept.join('; ')}`)
    } finally {
      setRefining(false)
    }
  }

  /**
   * The status line, ranked. Only one of these is ever the most important
   * thing, and each used to occupy its own permanent row above the results.
   */
  const status =
    (!visible.length && !state.operation
      ? (source.length ? 'Nothing that length.'
        : found ? 'That search came back empty.'
        // An empty library is not an empty YouTube. When nothing has synced and
        // no search has run, the honest state is "this account has no history —
        // search anyway", not "Nothing watched recently." full stop.
        : `${empty ?? 'Nothing synced from this account.'} Search all of YouTube above.`)
      : null)
    ?? [
      provenance ?? SCOPE_LABEL[scope],
      activeLength && activeLength.label !== 'any length' ? activeLength.label : null,
      state.sort === 'duration:desc' ? 'longest' : 'newest',
    ].filter(Boolean).join(' · ')

  /**
   * THE GRID.
   *
   * This was a horizontal rail, on the theory that a wider thumbnail is easier
   * to choose from. What it actually produced on the phone was two cards
   * stretched to the full height of the frame with their 16:9 stills cropped
   * into vertical slivers — the thumbnail was the one thing you could not see —
   * and everything past the second card hidden off the right edge.
   *
   * Two columns of compact cards instead: the whole still at the shape it was
   * made in, the title, the channel, the age, the runtime and a way to watch
   * it, all inside a card small enough that four fit above the fold. Expanding
   * a video still leaves the grid — a description needs the full frame.
   */
  /**
   * THE GRID IS A PROPERTY OF THE VIEW, NOT OF WHETHER ONE CARD IS OPEN.
   *
   * This was `state.view !== 'list' && !state.expanded`, so opening a single
   * video's description re-laid out ALL SIX into full-width single-column cards
   * — 388×301 each, one and a bit on screen, five of the six thumbnails gone.
   * The comment above already says what was meant ("expanding a video still
   * leaves the grid"); the `&& !state.expanded` is the opposite of it.
   *
   * It is not a state you can back out of casually either: `expanded` persists,
   * and arriving from a Home card SETS it (`takeArrival`), so tapping a video on
   * Home opened YouTube permanently in the broken layout.
   *
   * The opened card spans both columns instead — `grid-column: 1 / -1` — which
   * gives a description the full frame without taking the grid away from the
   * five videos he did not open.
   */
  const railed = state.view !== 'list'

  return (
    /*
      THE WHOLE FRAME IS YOUTUBE.

      Four stacked rows of chrome opened this surface — length chips, sort,
      view, a search field, then three scope chips — above any actual video.
      Results are the product; filters are supporting chrome, so everything
      secondary lives behind the toolbar overflow and the line below says what
      is active in one sentence instead of six lit controls.
    */
    <div style={css('position:relative; height:100%; min-height:0; display:flex; flex-direction:column; gap:6px; padding:8px 14px 6px; box-sizing:border-box;')}>
      <Toolbar
        left={
          <input
            value={box}
            placeholder="Search YouTube…"
            onChange={(e) => setBox(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(box, scope) }}
            style={cssv`flex:1; min-width:0; height:${CHROME.control}px; padding:0 12px; border-radius:999px;
              border:0; outline:0; font-family:inherit; font-size:${TYPE.small}; color:rgba(237,238,241,.92); ${CARD}`}
          />
        }
        right={
          <>
            <IconButton glyph="→" title="Search" onClick={() => void runSearch(box, scope)} />
            <IconButton
              glyph={state.view === 'list' ? '▤' : '▦'}
              title={state.view === 'list' ? 'Rail' : 'List'}
              onClick={() => send({ op: 'setView', args: { view: state.view === 'list' ? 'grid' : 'list' } })}
            />
          </>
        }
        more={
          <>
            {(['open', 'subscriptions', 'likes'] as Scope[]).map((sc) => (
              <Chip key={sc} label={SCOPE_LABEL[sc]} on={scope === sc} onClick={() => void runSearch(box, sc)} />
            ))}
            {LENGTHS.map((l) => (
              <Chip key={l.label} label={l.label} on={activeLength?.label === l.label} onClick={() => send({ op: 'filter', args: l.args })} />
            ))}
            <Chip
              label={state.sort === 'duration:desc' ? 'longest' : 'newest'}
              onClick={() => send({ op: 'sort', args: { by: state.sort === 'duration:desc' ? 'at' : 'duration', dir: 'desc' } })}
            />
            {found && <Chip label="clear" dim onClick={() => { setFound(null); setProvenance(null) }} />}
          </>
        }
      />

      {state.operation ? (
        <Op
          op={state.operation}
          onCancel={() => cancelOperation(surfaceKey)}
          onRetry={() => void runSearch(box, scope)}
        />
      ) : (
        <div style={cssv`flex:none; padding:0 2px; font-size:${TYPE.micro};
          color:rgba(${state.note ? '240,165,107,.72' : '237,238,241,.38'});
          white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`}>
          {status}
        </div>
      )}

      {/* THE APPLICATION. A rail scrolls sideways; a list and an opened video
          scroll down. Either way the scroll is INSIDE the frame. */}
      <div style={railed
        /*
          `align-items:flex-start`, NOT `stretch`.

          Stretched, every rail card grew to the full height of the frame, the
          thumbnail inside it was told `height:100%`, and `object-fit:cover`
          then cropped a 16:9 still into a tall vertical sliver — a picture of
          the middle of the picture. Four of those down a phone is what "the
          thumbnails don't show the thumbnail" means. Cards size to their
          contents now, and the still keeps the shape it was made in.
        */
        /*
          `grid-auto-rows:max-content` IS LOAD-BEARING, and its absence is why
          the thumbnails still did not show the thumbnail.

          This box is two things at once: a flex child with a definite height,
          and the grid that sizes the rows. With `auto` rows the second one
          treats the first one's height as the budget — four rows of 203px of
          card competed for 498px of frame and were resolved to 116px each. The
          cards have `overflow:hidden`, so their automatic minimum is zero and
          nothing objected: every title was sliced through the middle of its
          letters, and the channel, the age and the Watch control were simply
          not drawn. `overflow-y:auto` never engaged because, as far as the
          grid was concerned, everything fitted.

          `max-content` makes a row exactly as tall as the card in it. The rows
          then genuinely overflow, and the scroller does what it is for.
        */
        ? css('flex:1; min-height:0; display:grid; grid-template-columns:1fr 1fr; grid-auto-rows:max-content; align-content:start; gap:9px; overflow-y:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch; padding-bottom:4px;')
        : css('flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch; display:flex; flex-direction:column; gap:8px; padding-bottom:4px;')}>
        {visible.map((v) => {
          const open = state.expanded === v.id
          const picked = selected.has(v.id)
          const wide = open || state.view === 'list'
          return (
            <div
              key={v.id}
              data-object={v.id}
              style={railed
                /* The opened card takes the width of the grid rather than the
                   grid's shape from the rest of them. */
                ? cssv`${CARD} overflow:hidden; display:flex; flex-direction:column; min-width:0;
                    ${open ? 'grid-column:1 / -1;' : ''} ${picked ? 'box-shadow:inset 0 0 0 1.5px rgba(237,238,241,.75);' : ''}`
                : cssv`flex:none; ${CARD} overflow:hidden; display:flex; flex-direction:${state.view === 'list' && !open ? 'row' : 'column'}; ${picked ? 'box-shadow:inset 0 0 0 1.5px rgba(237,238,241,.75);' : ''}`}
            >
              {/*
                THE PICTURE PLAYS IT. THE WORDS OPEN IT UP.

                It used to be the other way round by omission: the thumbnail
                expanded the card, and watching — the thing anybody came to this
                surface to do — was a white pill under the title, repeated on
                every card, and the loudest element on the screen by some
                distance. Three of them, louder than the videos they were about.

                §25's rule is that if the object can naturally perform the
                action, it should: a thumbnail is the universal "play this"
                target, so it opens the video, the pill is gone, and expanding —
                which is the secondary thing — moves onto the text where a tap
                means "tell me more about this one".

                A video with no canonical URL cannot be opened at all, so its
                picture expands instead of promising something it cannot do.
                See `openable`.
              */}
              <div
                data-role={openable(v) ? 'play' : undefined}
                onClick={() => (openable(v) ? openVideo(v) : send({ op: open ? 'collapse' : 'expand', args: { id: v.id } }))}
                /* In the rail the picture absorbs the card's spare height
                   instead of leaving a dead band under the title — the
                   thumbnail is the thing you are choosing between. */
                style={cssv`position:relative; cursor:pointer; overflow:hidden; flex:none; min-height:0; width:${state.view === 'list' && !open ? '38%' : '100%'};`}
              >
                {v.thumbnail ? (
                  <img
                    src={v.thumbnail}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    style={css('width:100%; aspect-ratio:16/9; object-fit:cover; display:block; background:rgba(255,255,255,.04);')}
                  />
                ) : (
                  <div style={css('width:100%; aspect-ratio:16/9; background:rgba(255,255,255,.04); display:flex; align-items:center; justify-content:center; font-size:10px; color:rgba(237,238,241,.3);')}>
                    no thumbnail
                  </div>
                )}
                {/* The runtime, over the corner of the picture, where every
                    video service in the world has trained people to look. */}
                {v.seconds ? (
                  <div style={css('position:absolute; right:5px; bottom:5px; padding:1px 5px; border-radius:4px; background:rgba(11,11,13,.82); font-size:9.5px; font-variant-numeric:tabular-nums; color:rgba(237,238,241,.92);')}>
                    {runtime(v.seconds)}
                  </div>
                ) : null}
                {/*
                  A SELECTION CONTROL, WHICH IS WHAT IT ALWAYS WAS.

                  It drew `i + 1` when nothing was picked — a rank badge reading
                  1, 2, 3, 4 over a four-item grid, which conveys nothing anybody
                  can act on and looks like an ordering that means something. The
                  control's actual job is selection, so it now looks like a
                  checkbox in both states instead of like a leaderboard in one of
                  them.
                */}
                <div
                  data-role="select"
                  aria-label={picked ? 'Selected' : 'Select'}
                  onClick={(e) => { e.stopPropagation(); send({ op: picked ? 'deselect' : 'select', args: { id: v.id } }) }}
                  style={cssv`position:absolute; left:5px; top:5px; width:20px; height:20px; border-radius:999px; display:flex; align-items:center; justify-content:center; font-size:11px; cursor:pointer; background:${picked ? 'rgba(237,238,241,.94)' : 'rgba(11,11,13,.45)'}; color:${picked ? '#101012' : 'rgba(237,238,241,.75)'}; box-shadow:inset 0 0 0 1px rgba(255,255,255,${picked ? '.25' : '.35'});`}
                >
                  {picked ? '✓' : ''}
                </div>
              </div>

              <div style={cssv`${railed ? 'flex:none;' : 'flex:1;'} min-width:0; padding:8px 10px 10px;`}>
                {/*
                  THE SUMMARY ROWS ARE THE EXPAND TARGET — NOT THE WHOLE BLOCK.

                  The first version put the handler on the container, which also
                  contains the EXPANDED detail and its action buttons. So every
                  action inside an opened card sat within a region whose job is to
                  close that card, and the hit-test sweep said so: two controls
                  "covered by role=open-destination". Tapping an action would have
                  worked and then collapsed the thing it acted on.

                  The target is the title, channel and age — the part that reads
                  as "this video, in summary", which is what a tap meaning "tell
                  me more" should be on. The expansion below is content, and
                  content is not a button.
                */}
                <div
                  data-role="expand"
                  onClick={() => send({ op: open ? 'collapse' : 'expand', args: { id: v.id } })}
                  style={css('cursor:pointer;')}
                >
                <div style={cssv`font-size:12.5px; font-weight:500; line-height:1.35; color:rgba(237,238,241,.9); display:-webkit-box; -webkit-line-clamp:${wide ? '4' : '2'}; -webkit-box-orient:vertical; overflow:hidden;`}>
                  {v.title}
                </div>
                <div style={css('margin-top:4px; display:flex; gap:6px; align-items:baseline; font-size:11px; color:rgba(237,238,241,.45);')}>
                  {v.channel && <div style={css('flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;')}>{v.channel}</div>}
                  {v.publishedAt && <div style={css('flex:none; color:rgba(237,238,241,.35);')}>{shortWhen(v.publishedAt)}</div>}
                </div>
                {v.provenance && (
                  <div style={cssv`margin-top:3px; font-size:10.5px; color:rgba(237,238,241,${v.origin === 'retrieved' || v.origin === 'enriched' ? '.3' : '.42'}); ${v.origin === 'retrieved' || v.origin === 'enriched' ? '' : 'font-style:italic;'}`}>
                    {v.provenance}
                  </div>
                )}
                </div>

                {/*
                  WATCHING HAPPENS WHERE IT CAN ACTUALLY BE WATCHED.

                  Not embedded here, and that is a decision rather than an
                  omission: an inline YouTube iframe still serves ads and iOS
                  stops its audio the moment the screen locks, and those were
                  the two conditions for playing in-app. Neither can be met, so
                  the honest thing is to hand the video to the browser that
                  handles youtube.com — Brave, on his phone — which keeps
                  playing with the screen off.

                  THE URL IS NO LONGER BUILT HERE. It used to be
                  `watch?v=${v.id}`, and `v.id` is `undefined` for everything
                  returned by search — the API's records call it `videoId` and
                  nothing mapped the two. Every other field name happened to
                  match, so the card looked completely real and the link went to
                  a blank YouTube page. Identity is the one field that cannot be
                  approximately right, so it is verified on the server and the
                  canonical URL travels with the record.

                  No URL means the app cannot identify the video, and the
                  control is simply not offered. A disabled-looking button would
                  be worse: it invites a tap that can never work.
                */}
                {!openable(v) && (
                  <div style={cssv`margin-top:7px; font-size:${TYPE.small}; color:rgba(237,238,241,.35); font-style:italic;`}>
                    I can’t identify this video, so I can’t open it.
                  </div>
                )}

                {open && (
                  <div style={css('margin-top:9px; display:flex; flex-direction:column; gap:9px;')}>
                    {v.description && (
                      /* NO SCROLLER. The server hands over a synopsis, not a description —
                         a box with its own scrollbar was the ladder's rung zero. */
                      <div style={css('font-size:12px; line-height:1.5; color:rgba(237,238,241,.62); white-space:pre-wrap;')}>
                        {v.description}
                      </div>
                    )}
                    {/*
                      NOT THE ONE THE CARD ALREADY HAS.

                      Every video carries a `media.open` action labelled
                      "Watch", and the card draws its own Watch control above —
                      so an opened video showed two identical buttons, six
                      pixels apart, one of which went to the browser and one of
                      which went through the server. Two controls for one verb
                      is a question about which is the real one.
                    */}
                    {(() => {
                      const rest = (v.actions ?? []).filter((a) => a.kind !== 'media.open')
                      return rest.length ? <Actions actions={rest} onAction={onAction} /> : null
                    })()}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/*
        WHERE IT OPENS, ASKED ONCE.

        An overlay for the same reason selection is one: as a block in the
        column it would push the list down at the moment he is choosing from
        it. Each destination states what it can actually guarantee, because a
        choice between four options is only meaningful if their differences
        are — and on iOS the differences are real: only the default browser can
        be relied on, and the other two fall back when nothing answers.
      */}
      {picking && (
        <div data-role="open-picker" style={css('position:absolute; left:0; right:0; bottom:0; z-index:6; padding:0 14px 8px;')}>
          <div style={cssv`display:flex; flex-direction:column; gap:6px; padding:10px 12px; border-radius:14px; background:rgba(24,25,29,.97); box-shadow:inset 0 0 0 1px rgba(237,238,241,.12), 0 8px 28px rgba(0,0,0,.5);`}>
            <div style={cssv`font-size:${TYPE.small}; color:rgba(237,238,241,.62);`}>Where should videos open?</div>
            {DESTINATIONS.map((d) => (
              <div
                key={d.id}
                data-role="open-destination"
                onClick={() => void chooseDestination(d.id, picking)}
                style={css('display:flex; flex-direction:column; gap:2px; padding:7px 9px; border-radius:10px; background:rgba(237,238,241,.06); cursor:pointer;')}
              >
                <div style={cssv`font-size:12.5px; font-weight:600; color:rgba(237,238,241,.9);`}>{d.label}</div>
                <div style={cssv`font-size:11px; line-height:1.35; color:rgba(237,238,241,.42);`}>{d.note}</div>
              </div>
            ))}
            <div
              data-role="open-cancel"
              onClick={() => setPicking(null)}
              style={cssv`align-self:flex-start; margin-top:2px; font-size:${TYPE.small}; color:rgba(237,238,241,.42); cursor:pointer;`}
            >Not now</div>
          </div>
        </div>
      )}

      {/*
        THE DESTINATION DID NOT ANSWER, SO HE DECIDES WHAT HAPPENS NEXT.

        This is what replaces silently opening Safari. Three options, all of
        them his, and the app stays exactly where it was until he picks one —
        which is the correct behaviour for "I could not tell whether that
        worked", and the one thing the 900ms timer could never do.
      */}
      {stalled && (
        <div
          data-role="open-stalled"
          style={css('position:absolute; left:14px; right:14px; bottom:8px; z-index:8; padding:10px 12px; border-radius:12px; background:rgba(28,24,20,.97); box-shadow:inset 0 0 0 1px rgba(240,165,107,.28), 0 6px 22px rgba(0,0,0,.45);')}
        >
          <div style={cssv`font-size:11.5px; line-height:1.35; color:rgba(255,220,170,.9);`}>
            {DESTINATIONS.find((d) => d.id === stalled.tried)?.label ?? 'That app'} didn’t answer.
          </div>
          <div style={css('display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;')}>
            <button
              data-role="open-retry"
              onClick={() => { const v = stalled.video; setStalled(null); void openVideo(v) }}
              style={css('padding:6px 10px; border:0; border-radius:10px; background:rgba(240,165,107,.22); color:rgba(255,220,170,.95); font-size:11.5px; cursor:pointer;')}
            >Try again</button>
            <button
              data-role="open-in-browser"
              onClick={async () => {
                const v = stalled.video
                setStalled(null)
                // HIS choice, made explicitly, so this one really is a browser open.
                const how = await openAt(v.url!, 'browser')
                setOpenNote(how === 'blocked' ? 'Your browser blocked the pop-up.' : null)
              }}
              style={css('padding:6px 10px; border:0; border-radius:10px; background:rgba(255,255,255,.08); color:rgba(237,238,241,.9); font-size:11.5px; cursor:pointer;')}
            >Open in browser</button>
            <button
              data-role="open-choose"
              onClick={() => { const v = stalled.video; setStalled(null); setPicking(v) }}
              style={css('padding:6px 10px; border:0; border-radius:10px; background:rgba(255,255,255,.08); color:rgba(237,238,241,.9); font-size:11.5px; cursor:pointer;')}
            >Choose another</button>
          </div>
        </div>
      )}

      {/* What actually happened, when it was not simply "it opened". */}
      {openNote && (
        <div
          data-role="open-note"
          onClick={() => setOpenNote(null)}
          style={css('position:absolute; left:14px; right:14px; bottom:8px; z-index:7; padding:8px 11px; border-radius:12px; background:rgba(28,24,20,.96); font-size:11.5px; line-height:1.35; color:rgba(255,220,170,.9); cursor:pointer;')}
        >{openNote}</div>
      )}

      {/* Selection is an OVERLAY. As a block in the column it pushed the rail
          down by its own height at the moment you were choosing from it. */}
      {state.selected.length > 0 && (
        <div style={css('position:absolute; left:0; right:0; bottom:0; z-index:5; padding:0 14px 8px;')}>
          <div style={cssv`display:flex; align-items:center; gap:7px; padding:7px 10px; border-radius:14px; background:rgba(28,24,20,.94); box-shadow:inset 0 0 0 1px rgba(240,165,107,.28), 0 6px 22px rgba(0,0,0,.45);`}>
            <div style={cssv`flex:1; min-width:0; font-size:${TYPE.small}; color:rgba(255,220,170,.9);`}>{state.selected.length} selected</div>
            <Chip label="Keep only" onClick={() => send({ op: 'keepOnly', args: { ids: state.selected } })} />
            {onRefine && <Chip label={refining ? 'Finding…' : 'Replace rest'} onClick={() => void replaceRest()} />}
            <Chip label="Clear" onClick={() => send({ op: 'clearSelection' })} />
          </div>
        </div>
      )}
    </div>
  )
}

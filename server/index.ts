import express from 'express'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getKey, setKey, deleteKey } from './secrets.js'
import { installNodeRuntime } from './node-runtime.js'
import { providers, byId, chat, listModels, canSearch, probe } from './providers.js'
import { mutateWorld, readWorld, addObservations, noteTimeZone, type World } from './world.js'
import { personRoute } from './personRoutes.js'
import { think } from './think.js'
import { sourcePanes, noticePane } from './panes.js'
import { say } from './say.js'
import { proposeGaps, researchGap } from './research.js'
import { listTracks, addTrack, updateTrack, removeTrack, runDueTracks, runTrack } from './tracks.js'
import { route, health, candidates, setModelPrefs, wake, budgets } from './router.js'
import { hunt, ensureVerified, snapshot, usable as usableModels } from './models.js'
import { searchPlaces, routeBetween } from './maps.js'
import { leaveBy } from './leaveby.js'
import { forgetSource } from './objects.js'
import { resolveRefs } from './widgets.js'
import {
  quotaLedger, installYouTubeSource, presentable,
  search, fromSubscriptions, likedVideos, type Video as YTVideo,
} from './youtube.js'
import { installGoogleSources } from './googleSources.js'
import { sanitisePlan, type RefreshPolicy } from './ir.js'
import { compile, compileLocally } from './compile.js'
import { ask } from './ask.js'
import { installReasoner } from './reasoner.js'
import { buildFeed, freshen, readSnapshot } from './feed.js'
import { arrange, forget, readShelf, toggle } from './shelf.js'
import { readHome, writeHome } from './home.js'
import { sourceCatalogue } from './execute.js'
import { perform, registerAction, history as actionHistory, undoAction, type Authoriser } from './actions.js'
import * as panes from './protocol.js'
import { parseWatchHistory, rememberWatchHistory, channelsByWatchCount } from './takeout.js'
import { installCapabilities } from './capabilities.js'
import { authUrl, exchangeCode, accessToken, loadTokens, clearTokens, saveTokens, pullObservations, serverBase, callbackPath, GOOGLE_SOURCES } from './google.js'

const PORT = Number(process.env.PORT ?? 3001)
const CONFIG_DIR = join(homedir(), '.crucible')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

interface Config {
  /** Which provider the brain currently thinks with. */
  activeProvider?: string
  /** Model per provider, so switching back and forth remembers your choice. */
  models?: Record<string, string>
  /** Whether the router picks per task, or always starts with his choice. */
  routing?: 'auto' | 'pinned'
}

async function readConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
  } catch {
    return {}
  }
}

async function writeConfig(c: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n')
}

installNodeRuntime()
// The router decides which model runs each task; without this it cannot see
// which one he chose, and "think with this" changes nothing.
setModelPrefs(readConfig)
// Connectors announce themselves to the plan layer. This is the only thing the
// general pane/revision code ever learns about YouTube, and adding Gmail or
// Calendar means another line here rather than an edit to any of it.
installYouTubeSource()
installGoogleSources()
// The model, for the two plan nodes that need one. Injected here rather than
// imported by the executor, so everything that was verifiable without a
// provider key still is — uninstall this line and the deterministic half of
// every hybrid plan runs exactly as before, and says where it stopped.
installReasoner()

const app = express()
app.use(express.json({ limit: '4mb' }))

/**
 * Provider list with configured-state. Deliberately never returns key
 * material — the renderer only ever learns WHETHER a provider is set up.
 */
/**
 * What the picker is allowed to offer.
 *
 * This used to hand back the provider's raw catalogue, which is how the app
 * came to list a hundred models of which most could not be thought with — a
 * paid tier a free key cannot touch, a withdrawn preview, and in one case a
 * prompt-injection classifier that was actually selected and made every pass
 * fail. Offering something broken is worse than offering less: he cannot tell
 * from the name which is which, and the app only finds out at the moment it
 * needed to think.
 *
 * So the picker sees the verified set and nothing else. Quarantined models are
 * still returned, separately and with the provider's own reason attached, but
 * nothing in the UI lists them — they are there so the assistant can answer for
 * them when asked (see /api/self).
 */
app.get('/api/providers', async (_req, res) => {
  const cfg = await readConfig()
  const list = await Promise.all(
    providers.map(async (p) => {
      const key = await getKey(p.id)
      // A key with an empty registry has never been hunted. Do it now, once,
      // rather than showing him an empty picker and no way to fill it.
      const verified = key ? await ensureVerified(p.id) : []
      const all = key ? (await snapshot()).models.filter((m) => m.providerId === p.id) : []
      const now = Date.now()
      return {
        id: p.id,
        label: p.label,
        hint: p.hint,
        free: p.free,
        models: verified.map((m) => m.model),
        // Enough for the picker to say WHY one model is a better choice than
        // another, instead of presenting a flat list of opaque names.
        detail: verified.map((m) => ({
          model: m.model,
          label: m.label,
          quality: m.quality,
          measured: m.measured,
          latencyMs: m.latencyMs,
          aptitude: m.aptitude ?? null,
        })),
        quarantined: all
          .filter((m) => m.verdict === 'quarantined' && (m.until ?? 0) > now)
          .map((m) => ({ model: m.model, reason: m.reason ?? 'would not answer', until: m.until ?? 0 })),
        model: cfg.models?.[p.id] ?? verified[0]?.model ?? p.defaultModel,
        configured: key !== null,
      }
    })
  )
  res.json({ providers: list, active: cfg.activeProvider ?? null, routing: cfg.routing ?? 'auto' })
})

/**
 * Go looking for models that work, on demand.
 *
 * Hunting is otherwise lazy — it happens when a provider has never been looked
 * at, and production traffic keeps the registry honest for free after that.
 * This is the manual pull for when a provider has plainly changed underneath
 * us and waiting six hours for the next window is not acceptable.
 */
/**
 * What is left, per model, right now.
 *
 * Costs nothing to produce: the measured half rides in on headers from calls
 * the app already made, and the modelled half is arithmetic over our own
 * counters. Every row states which of the two it is, so a number that is our
 * estimate can never be read as the provider's promise.
 */
app.get('/api/budgets', async (_req, res) => {
  res.json({ budgets: await budgets() })
})

/**
 * Perform a widget action.
 *
 * One endpoint, a fixed table of named intents. The client posts a NAME and
 * parameters; it never posts a URL, a method or a body to forward. That is the
 * whole security property: widget specs can be authored by a model reading
 * untrusted content — an email is untrusted content — and the worst a
 * hallucinated or injected action can do is name an intent that does not exist,
 * or pass a message id that does not resolve.
 *
 * Actions that leave the device or cannot be undone are confirmed by him in the
 * UI before they arrive here, and the model's own grammar has no word for them
 * (see MODEL_SAFE_ACTIONS in widgets.ts) — only panes the server built from
 * real records can offer one.
 */
/**
 * Place search and routing, proxied rather than called from the page.
 *
 * The browser could hit Nominatim directly, but then the rate limiting and the
 * User-Agent both live on the client, where a re-render can turn one search
 * into ten and a volunteer service gets hammered from his phone. Going through
 * the server means one polite caller and one cache for both hosts.
 */
app.get('/api/map/search', async (req, res) => {
  try {
    const near = parsePoint(String(req.query.near ?? ''))
    const places = await searchPlaces(String(req.query.q ?? ''), near ?? undefined)
    res.json({ places })
  } catch (e) {
    res.status(502).json({ error: (e as Error).message })
  }
})

app.get('/api/map/route', async (req, res) => {
  const from = parsePoint(String(req.query.from ?? ''))
  const to = parsePoint(String(req.query.to ?? ''))
  if (!from || !to) return res.status(400).json({ error: 'I need two points to route between.' })
  try {
    res.json(await routeBetween(from, to, String(req.query.mode ?? 'walk')))
  } catch (e) {
    res.status(502).json({ error: (e as Error).message })
  }
})

/** "44.13,11.11" → a point, or null if it is not one. */
function parsePoint(s: string): { lat: number; lon: number } | null {
  const [a, b] = s.split(',')
  const lat = Number(a)
  const lon = Number(b)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  return { lat, lon }
}

/**
 * The action handlers.
 *
 * Registered rather than switched on, for the same reason source adapters are:
 * the general layer must not contain a list of the things Google happens to
 * offer. Each one declares whether it can be taken back, and how — `perform`
 * refuses an irreversible action that nobody confirmed, and writes down every
 * attempt including the refusals.
 */
{
  const str = (p: Record<string, unknown>, k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '')
  const google = async () => {
    const t = await accessToken(G_ID, G_SECRET)
    if (!t) throw new Error('Google is not connected.')
    return t
  }

  // Reading and organising. Reversible from Gmail, and reversible here: the
  // undo is the opposite label change, recorded with the action that made it.
  /*
    EVERY ACTION, FROM ONE TABLE.

    This block was ~130 lines here and the same ~130 lines in
    `worker/index.ts`, differing only in how each host reaches a Google token.
    That fork is why `calendar.update` did not exist: adding a verb meant
    remembering a second file, with nothing to catch you when you did not. See
    server/capabilities.ts.
  */
  installCapabilities({
    google,
    searchKeys: async () => ({
      brave: (await getKey('brave')) ?? undefined,
      tavily: (await getKey('tavily')) ?? undefined,
    }),
  })
}

/**
 * Perform a widget action.
 *
 * One endpoint, a table of named intents. The client posts a NAME and
 * parameters; it never posts a URL, a method or a body to forward. That is the
 * whole security property: widget specs can be authored by a model reading
 * untrusted content — an email is untrusted content — and the worst a
 * hallucinated or injected action can do is name an intent that does not exist,
 * or pass a message id that does not resolve.
 *
 * What is new is that the authorisation is now part of the request and part of
 * the record. "He tapped it, having seen this revision of this pane" is
 * different from "a standing rule did it at 4am", and both are different from
 * "the app decided to" — and until it was written down, all three arrived here
 * looking identical.
 */
app.post('/api/act', async (req, res) => {
  const kind = String(req.body?.kind ?? '')
  const params = (req.body?.params ?? {}) as Record<string, unknown>
  const authorisedBy: Authoriser = {
    by: 'user',
    paneId: typeof req.body?.paneId === 'string' ? req.body.paneId : undefined,
    revisionId: typeof req.body?.revisionId === 'string' ? req.body.revisionId : undefined,
    confirmed: req.body?.confirmed === true,
  }

  const record = await perform(kind, params, authorisedBy)
  if (record.outcome === 'ok') return res.json({ ok: true, id: record.result, action: record.id, undoable: !!record.undo })
  res.status(record.outcome === 'refused' ? 400 : 502).json({ error: record.error, action: record.id })
})

// ── Panes ─────────────────────────────────────────────────────────────────
/**
 * The pane protocol.
 *
 * Every route here is the same shape: work out which pane, do one thing to it,
 * hand back the pane's new state. None of them can destroy a revision, and the
 * two that go to the network say what they cost.
 *
 * The auth blob is assembled once and passed into execution rather than read
 * inside it: a plan names a source and a route, never a credential, so the only
 * place a token can enter is here.
 */
async function planAuth(): Promise<Record<string, string>> {
  const token = await accessToken(G_ID, G_SECRET).catch(() => null)
  return token ? { youtubeToken: token, googleToken: token } : {}
}

app.get('/api/panes', async (req, res) => {
  res.json({ panes: await panes.all(req.query.closed === '1') })
})

app.get('/api/panes/:id', async (req, res) => {
  const v = await panes.open_(req.params.id)
  if (!v) return res.status(404).json({ error: 'No such pane.' })
  res.json(v)
})

/**
 * Create a pane from a compiled plan.
 *
 * The plan is untrusted input — sanitised exactly like a widget spec, and it
 * cannot name a URL, a credential or an action. `intent` is kept verbatim
 * beside it whatever the plan turned out to be.
 */
app.post('/api/panes', async (req, res) => {
  /**
   * A plan is now OPTIONAL here.
   *
   * Send one and it is sanitised and run, exactly as before — that path is what
   * the verification harness drives and it has not moved. Send only `intent`
   * and the compiler writes the plan, which is the same journey his words take
   * through `/api/ask`. Both end at the same `panes.open`, because a compiled
   * plan is not a privileged kind of plan.
   */
  if (!req.body?.plan) {
    const words = String(req.body?.intent ?? '').trim()
    if (!words) return res.status(400).json({ error: 'That is not a plan I can run.' })
    try {
      return res.json(await ask(words, { fresh: true, onShelf: req.body?.onShelf !== false, auth: await planAuth() }))
    } catch (e) {
      return res.status(502).json({ error: (e as Error).message })
    }
  }

  const plan = sanitisePlan(req.body.plan, String(req.body?.intent ?? ''))
  if (!plan) return res.status(400).json({ error: 'That is not a plan I can run.' })
  try {
    const out = await panes.open(plan, {
      title: req.body?.title,
      pin: req.body?.pin === 'content' || req.body?.pin === 'intent' ? req.body.pin : undefined,
      auth: await planAuth(),
    })
    res.json(out)
  } catch (e) {
    res.status(502).json({ error: (e as Error).message })
  }
})

/**
 * Which pane does this sentence mean?
 *
 * Exposed on its own so the client can ask before acting, and so an ambiguous
 * answer can be turned into a question to him rather than a guess. Consequential
 * requests refuse the weakest layers — see `addressing.ts`.
 */
app.post('/api/panes/resolve', async (req, res) => {
  res.json(
    await panes.whichPane(req.body?.ref, req.body?.context ?? {}, { consequential: req.body?.consequential === true })
  )
})

/** "Actually, three from 60 Minutes instead." A new revision, or a branch. */
app.post('/api/panes/:id/refine', async (req, res) => {
  const plan = sanitisePlan(req.body?.plan, String(req.body?.intent ?? ''))
  if (!plan) return res.status(400).json({ error: 'That is not a plan I can run.' })
  const out = await panes.refine(req.params.id, plan, { from: req.body?.from, auth: await planAuth() })
  if (!out) return res.status(404).json({ error: 'No such pane or revision.' })
  res.json(out)
})

/** "Same thing, but ten." Deterministic where the plan was. */
app.post('/api/panes/:id/parameters', async (req, res) => {
  const edits = Array.isArray(req.body?.edits) ? req.body.edits : []
  const out = await panes.reparameterise(req.params.id, edits, { auth: await planAuth() })
  if (!out) return res.status(404).json({ error: 'No such pane.' })
  res.json(out)
})

app.post('/api/panes/:id/refresh', async (req, res) => {
  const out = await panes.refresh(req.params.id, { auth: await planAuth() })
  if (!out) return res.status(404).json({ error: 'No such pane.' })
  res.json(out)
})

/** Take the revision that was waiting behind a content pin. */
app.post('/api/panes/:id/accept', async (req, res) => {
  const v = await panes.accept(req.params.id)
  if (!v) return res.status(404).json({ error: 'Nothing waiting on that pane.' })
  res.json(v)
})

app.post('/api/panes/:id/undo', async (req, res) => {
  const v = await panes.stepBack(req.params.id)
  if (!v) return res.status(400).json({ error: 'Nothing to go back to.' })
  res.json(v)
})

app.post('/api/panes/:id/redo', async (req, res) => {
  const v = await panes.stepForward(req.params.id)
  if (!v) return res.status(400).json({ error: 'Nothing to go forward to.' })
  res.json(v)
})

/**
 * Pinning. Two operations, not a boolean — see `revisions.ts`.
 * 'content' keeps exactly these; 'intent' keeps a pane here matching this.
 */
app.put('/api/panes/:id/pin', async (req, res) => {
  const mode = req.body?.mode
  const v = await panes.pin(req.params.id, mode === 'content' || mode === 'intent' ? mode : null)
  if (!v) return res.status(404).json({ error: 'No such pane.' })
  res.json(v)
})

app.put('/api/panes/:id/refresh-policy', async (req, res) => {
  const v = await panes.schedule(req.params.id, req.body?.policy as RefreshPolicy)
  if (!v) return res.status(404).json({ error: 'No such pane.' })
  res.json(v)
})

app.post('/api/panes/:id/close', async (req, res) => {
  const v = await panes.close(req.params.id)
  if (!v) return res.status(404).json({ error: 'No such pane.' })
  // Closing gives up the place on the splash but keeps every revision, so
  // reopening restores the exact state he left — it simply comes back at the
  // end rather than in the gap it used to occupy.
  await forget(req.params.id).catch(() => null)
  res.json(v)
})

app.post('/api/panes/:id/reopen', async (req, res) => {
  const v = await panes.reopen(req.params.id)
  if (!v) return res.status(404).json({ error: 'No such pane.' })
  res.json(v)
})

/** Every state this pane has been in, and what changed between two of them. */
app.get('/api/panes/:id/history', async (req, res) => {
  res.json({ revisions: await panes.history(req.params.id) })
})

app.get('/api/panes/:id/diff', async (req, res) => {
  const d = await panes.compare(String(req.query.from ?? ''), String(req.query.to ?? ''))
  if (!d) return res.status(404).json({ error: 'I don’t have both of those revisions.' })
  res.json(d)
})

// ── His words ─────────────────────────────────────────────────────────────
/**
 * Compile an instruction, without running it.
 *
 * Separate from `/api/ask` so a plan can be looked at before it is trusted,
 * which is the honest way to introduce a compiler. It is also what answers
 * "why does this pane do that" — the plan is the answer, and it is readable.
 */
app.post('/api/compile', async (req, res) => {
  const words = String(req.body?.intent ?? '').trim()
  if (!words) return res.status(400).json({ error: 'Nothing to compile.' })
  // `model:false` asks for the free compilation or nothing — never a silent
  // upgrade to a paid call on a key that may have three left today.
  if (req.body?.model === false) {
    const local = compileLocally(words)
    return local
      ? res.json({ plan: local, planClass: 'deterministic', by: 'local', unknown: [], unresolved: [] })
      : res.status(422).json({ error: 'That one needs a model to compile.' })
  }
  try {
    res.json({ ...(await compile(words, { context: req.body?.context })), by: 'model' })
  } catch (e) {
    res.status(502).json({ error: (e as Error).message })
  }
})

/**
 * WHEN TO SET OFF.
 *
 * Its own route rather than a branch of `/api/ask`, because it is its own
 * computation with its own prerequisites: `ask` compiles words into a pane, and
 * a departure time is not a pane. Every input arrives already resolved — the
 * client's ladder does that against what is on his screen — so this route never
 * guesses and never asks. It computes, or it says which input it could not
 * honour. See server/leaveby.ts.
 */
app.post('/api/leaveby', async (req, res) => {
  const b = req.body ?? {}
  const need = ['destination', 'eventStart', 'origin', 'transportMode'].filter((k) => !String(b[k] ?? '').trim())
  if (need.length) return res.status(400).json({ error: `Missing ${need.join(', ')}.` })
  try {
    const w = await readWorld()
    res.json(await leaveBy({
      destination: String(b.destination),
      eventStart: String(b.eventStart),
      origin: String(b.origin),
      transportMode: String(b.transportMode),
    }, w.timeZone))
  } catch (e) {
    res.status(502).json({ error: (e as Error).message })
  }
})

/**
 * Say something, get a pane.
 *
 * The route the whole layer was built toward: no plan in the request, no widget
 * spec he has to trust in the response, and no id he has to know. It either
 * hands back a pane or asks him which one he meant.
 */
app.post('/api/ask', async (req, res) => {
  const words = String(req.body?.intent ?? req.body?.text ?? '').trim()
  if (!words) return res.status(400).json({ error: 'Nothing to do.' })
  try {
    res.json(
      await ask(words, {
        paneId: typeof req.body?.paneId === 'string' ? req.body.paneId : undefined,
        ref: req.body?.ref,
        ctx: req.body?.context ?? {},
        fresh: req.body?.fresh === true,
        onShelf: req.body?.onShelf !== false,
        auth: await planAuth(),
      })
    )
  } catch (e) {
    res.status(502).json({ error: (e as Error).message })
  }
})

// ── The splash ────────────────────────────────────────────────────────────
/**
 * Everything on the home screen, in his order.
 *
 * `?cached=1` returns the last assembled feed without thinking — what the
 * client paints in the first frame. Without it, this rebuilds: refreshing
 * whatever asked to be refreshed on open, then synthesising over the result.
 * The two are the same shape on purpose, so the client swaps one for the other
 * and nothing about the screen changes except how current it is.
 */
app.get('/api/feed', async (req, res) => {
  // The zone the machine showing the screen is standing in, which outranks
  // anything a connector reports. See `World.timeZoneBy`.
  const world = await noteClientZone(typeof req.query.tz === 'string' ? req.query.tz : '')
  if (req.query.cached === '1') {
    // The world is passed so the deterministic rows are re-derived against now
    // rather than served as they were computed. See `readSnapshot`.
    const snap = await readSnapshot(world)
    if (snap) return res.json(snap)
  }
  const auth = await planAuth()
  // On-open refreshes first, so synthesis reasons over what the panes show now
  // rather than over what they showed before he opened the app.
  await freshen({ arriving: true, auth }).catch(() => null)
  res.json(await buildFeed(await readWorld(), { nudge: typeof req.query.nudge === 'string' ? req.query.nudge : undefined }))
})

/**
 * Bring everything up to date without a model.
 *
 * The unattended path, and the client's fallback when synthesis is rate
 * limited: his panes and his sources come back current, the model's cards are
 * simply absent, and the feed says so rather than pretending.
 */
app.post('/api/feed/refresh', async (_req, res) => {
  const auth = await planAuth()
  const r = await freshen({ arriving: false, auth })
  res.json({ ...r, feed: await buildFeed(await readWorld(), { withoutModel: true }) })
})

/** His arrangement: what is on the splash, in what order, and what is hidden. */
app.get('/api/shelf', async (_req, res) => {
  res.json(await readShelf())
})

app.put('/api/shelf', async (req, res) => {
  const body = req.body ?? {}
  let shelf = await readShelf()
  if (Array.isArray(body.order)) shelf = await arrange(body.order.map(String))
  if (body.toggle && typeof body.toggle.id === 'string') shelf = await toggle(body.toggle.id, body.toggle.on !== false)
  if (typeof body.forget === 'string') shelf = await forget(body.forget)
  res.json(shelf)
})

/**
 * The durable half of Home: his order, what he hid, what he saved.
 *
 * Device-local state — which card of each deck is in front, chat snap state,
 * scroll positions — deliberately never reaches here. Syncing it would let one
 * device silently repage another, which is the same failure as the agent doing
 * it.
 */
app.get('/api/home', async (_req, res) => {
  res.json(await readHome())
})

app.patch('/api/home', async (req, res) => {
  res.json(await writeHome(req.body ?? {}))
})

/** What a plan is allowed to name right now. Derived from the registry. */
app.get('/api/catalogue', (_req, res) => {
  res.json({ sources: sourceCatalogue() })
})

/** What it has done, on whose authority, and what can still be taken back. */
app.get('/api/actions', async (_req, res) => {
  res.json({ actions: await actionHistory() })
})

app.post('/api/actions/:id/undo', async (req, res) => {
  const done = await undoAction(req.params.id, { by: 'user', confirmed: true })
  if (!done) return res.status(400).json({ error: 'That one can’t be taken back.' })
  res.json(done)
})

app.post('/api/models/hunt', async (req, res) => {
  try {
    const report = await hunt({ providerId: req.body?.provider, force: true })
    res.json(report)
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

/** Store a key, then immediately prove it works. A key that fails is rejected. */
app.put('/api/providers/:id/key', async (req, res) => {
  const p = byId(req.params.id)
  if (!p) return res.status(404).json({ error: 'Unknown provider' })
  const key = String(req.body?.key ?? '').trim()
  if (!key) return res.status(400).json({ error: 'No key provided' })

  const cfg = await readConfig()
  const model = cfg.models?.[p.id] ?? p.defaultModel
  try {
    await chat({ providerId: p.id, model, key, prompt: 'Reply with the single word: ok', maxTokens: 16 })
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message })
  }

  await setKey(p.id, key)
  // First working provider becomes active, so the app is usable immediately.
  if (!cfg.activeProvider) {
    cfg.activeProvider = p.id
    await writeConfig(cfg)
  }
  res.json({ ok: true, active: cfg.activeProvider })
})

app.delete('/api/providers/:id/key', async (req, res) => {
  const p = byId(req.params.id)
  if (!p) return res.status(404).json({ error: 'Unknown provider' })
  await deleteKey(p.id)
  const cfg = await readConfig()
  if (cfg.activeProvider === p.id) {
    // Fall back to any other provider that still has a key.
    const next = await firstConfigured(p.id)
    cfg.activeProvider = next ?? undefined
    await writeConfig(cfg)
  }
  res.json({ ok: true, active: (await readConfig()).activeProvider ?? null })
})

/**
 * Who chooses the model: Crucible per task, or the one he pinned.
 * Its own route because the toggle is not about any single provider — asking
 * for a providerId to set it would be the tail wagging the dog.
 */
app.put('/api/routing', async (req, res) => {
  const r = req.body?.routing
  if (r !== 'auto' && r !== 'pinned') return res.status(400).json({ error: 'routing must be auto or pinned' })
  const cfg = await readConfig()
  cfg.routing = r
  await writeConfig(cfg)
  res.json({ ok: true, routing: r })
})

/** Choose the active provider and/or its model. */
app.post('/api/active', async (req, res) => {
  const id = String(req.body?.providerId ?? '')
  const p = byId(id)
  if (!p) return res.status(404).json({ error: 'Unknown provider' })
  if ((await getKey(id)) === null) return res.status(400).json({ error: 'No key for that provider' })

  const cfg = await readConfig()
  cfg.activeProvider = id
  if (req.body?.model) {
    // Validate against what the provider actually offers this key, not the
    // static fallback list — otherwise picking a live model gets rejected.
    const key = await getKey(id)
    const live = key ? await listModels(id, key) : null
    const allowed = live?.length ? live : p.models
    if (!allowed.includes(req.body.model)) return res.status(400).json({ error: 'Unknown model' })
    // Being listed is not being allowed. Prove it answers before the whole app
    // starts depending on it.
    const why = key ? await probe(id, req.body.model, key) : 'No key for that provider'
    if (why) return res.status(400).json({ error: why })
    // It just answered, so whatever rest it was serving is out of date.
    await wake(id, req.body.model)
    cfg.models = { ...cfg.models, [id]: req.body.model }
  }
  await writeConfig(cfg)
  res.json({ ok: true, active: id, model: cfg.models?.[id] ?? p.defaultModel, routing: cfg.routing ?? 'auto' })
})

/** The brain's one way to think. Keys never leave this process. */
/**
 * A raw call, routed like every other call.
 *
 * This used to reach for `chat()` directly with the active provider and its
 * configured model, which quietly opted the whole endpoint out of everything
 * the router does. No fallback, so a rate-limited model returned an error where
 * a step down to the sibling model on the same key would have answered. No
 * `note()`, so the budget headers on the response were dropped and the tracker
 * could not see usage that had definitely happened. And no registry evidence,
 * so a model proving itself here still looked unproven.
 *
 * There is no reason for a second path to the providers. Routing a chat as
 * `chat` costs nothing and makes this endpoint behave like the rest of the app.
 */
app.post('/api/chat', async (req, res) => {
  try {
    const out = await route(
      'chat',
      {
        system: req.body?.system,
        prompt: String(req.body?.prompt ?? ''),
        json: !!req.body?.json,
        maxTokens: req.body?.maxTokens,
      },
      { preferred: req.body?.provider }
    )
    res.json(out)
  } catch (err) {
    res.status(502).json({ error: (err as Error).message })
  }
})

/** Everything the assistant knows. Seeded by connectors; readable for debugging. */
app.get('/api/world', async (_req, res) => {
  res.json(await readWorld())
})

/** Connectors (and, for now, seeding) push observations in here. */
app.post('/api/world/observations', async (req, res) => {
  const obs = Array.isArray(req.body?.observations) ? req.body.observations : []
  const w = await addObservations(obs)
  res.json({ ok: true, observations: w.observations.length })
})

/**
 * He tells it something — answering a question it asked, or volunteering a
 * fact. This is the other half of the loop: without it the assistant can ask
 * but never learn, which is worse than not asking.
 */
/**
 * KEPT AS A PATH, REIMPLEMENTED AS A TYPED WRITE.
 *
 * This appended a sentence to the observation list and nothing else — the
 * "observation graveyard" path this whole change is about. Answering "Do you
 * drive?" with "No" left no queryable fact anywhere, so the router still had to
 * guess a travel mode and the question stayed askable forever; his real world model
 * contains that exact sentence twice for precisely that reason.
 *
 * It now delegates to `tell`, which writes the typed field FIRST and produces the
 * sentence as secondary history, in one transaction. Same URL, because clients call
 * it, and both hosts now run the same implementation.
 */
app.post('/api/world/tell', async (req, res) => {
  const out = await personRoute('/api/person/tell', 'POST', req.body)
  res.status(out?.status ?? 500).json(out?.value ?? { ok: false })
})

app.put('/api/world/profile', async (req, res) => {
  const profile = String(req.body?.profile ?? '')
  // Transactional, so writing his own account of himself cannot be lost to a build
  // that happens to be running — and cannot take the rest of the document with it.
  await mutateWorld((w) => { w.profile = profile }, { label: 'your profile' })
  res.json({ ok: true })
})

/**
 * The typed personal model. One handler, shared with the Worker.
 *
 * Mounted as a catch-all over `/api/person/*` rather than as five routes, so
 * adding a sixth means editing `personRoutes.ts` alone and BOTH hosts get it.
 * The alternative is what already happened to `/api/world/profile`: written for
 * the Mac, never added to the edge, and quietly 404ing on the phone.
 */
app.all(['/api/person', '/api/person/*splat', '/api/focus'], async (req, res) => {
  const out = await personRoute(req.path, req.method, req.body)
  if (!out) return res.status(404).json({ error: 'No such person route' })
  res.status(out.status).json(out.value)
})


// ── Google ────────────────────────────────────────────────────────────────
// Both https://crucible.cam and http://localhost:3001 are already registered
// against this client, so the same code path works locally and in production.
const G_ID = process.env.GOOGLE_CLIENT_ID ?? ''
const G_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? ''

app.get('/api/google/status', async (_req, res) => {
  const t = await loadTokens()
  res.json({
    configured: !!(G_ID && G_SECRET),
    connected: !!t?.access_token,
    scopes: t?.scope ? t.scope.split(' ').map((s) => s.split('/').pop()) : [],
  })
})

app.get('/api/google/connect', (req, res) => {
  if (!G_ID) return res.status(400).send('GOOGLE_CLIENT_ID is not set')
  res.redirect(authUrl(G_ID, `${serverBase(req as any)}${callbackPath}`))
})

app.get(callbackPath, async (req, res) => {
  const code = String(req.query.code ?? '')
  if (!code) return res.status(400).send(String(req.query.error ?? 'No code returned'))
  try {
    const tokens = await exchangeCode(code, G_ID, G_SECRET, `${serverBase(req as any)}${callbackPath}`)
    await saveTokens(tokens)
    // Pull straight away so the feed has real data by the time he looks.
    const token = await accessToken(G_ID, G_SECRET)
    let added = 0
    if (token) {
      const w0 = await readWorld()
      const { observations, timeZone, coverage } = await pullObservations(token, w0.sources, w0.timeZone)
      if (observations.length || timeZone || coverage.length) await addObservations(observations, new Date(), { timeZone, coverage })
      added = observations.length
    }
    res.send(`<body style="background:#0B0A0C;color:#EDEEF1;font:15px -apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:20px;font-weight:600">Google connected</div><div style="opacity:.6;margin-top:8px">Pulled ${added} things. You can close this tab.</div></div></body>`)
  } catch (err) {
    res.status(400).send(`Google connect failed: ${(err as Error).message}`)
  }
})

/** Re-pull. Cheap, deterministic, costs no model tokens. */
app.post('/api/google/sync', async (_req, res) => {
  const token = await accessToken(G_ID, G_SECRET)
  if (!token) return res.status(400).json({ error: 'Google is not connected' })
  const w0 = await readWorld()
  const { observations, errors, timeZone, coverage } = await pullObservations(token, w0.sources, w0.timeZone)
  if (observations.length || timeZone || coverage.length) await addObservations(observations, new Date(), { timeZone, coverage })
  res.json({ added: observations.length, bySource: observations.reduce((a: Record<string, number>, o) => ({ ...a, [o.source]: (a[o.source] ?? 0) + 1 }), {}), errors })
})

/**
 * What he lets it read, and who decides what reaches the screen. Signing in is
 * one step; this is where he says source by source what it may use, and
 * whether the assistant curates the feed or he does.
 */
app.get('/api/sources', async (_req, res) => {
  const w = await readWorld()
  res.json({
    sources: GOOGLE_SOURCES.map((id) => ({ id, on: w.sources?.[id] !== false })),
    curation: w.curation ?? 'auto',
  })
})

app.put('/api/sources', async (req, res) => {
  const { world } = await mutateWorld((w) => {
    w.sources = w.sources ?? {}
    for (const [id, on] of Object.entries(req.body?.sources ?? {})) w.sources[id] = on === true
    if (req.body?.curation === 'auto' || req.body?.curation === 'manual') w.curation = req.body.curation
  }, { label: 'which sources I may read' })
  res.json({ ok: true, sources: world.sources, curation: world.curation })
})

app.post('/api/google/disconnect', async (_req, res) => {
  await clearTokens()
  // Disconnecting an account means the app stops holding its data, not just
  // that it stops asking for more.
  await forgetSource('youtube')
  res.json({ ok: true })
})

/**
 * Import a Google Takeout watch history.
 *
 * The only route to what he has actually watched — YouTube's API has never
 * served it. Everything imported is marked `historical` and stamped with the
 * export's own newest event, so a file from March says March however long it
 * sits here, and nothing in the app can quietly present it as current.
 *
 * The body is the raw `watch-history.json`, which runs to tens of megabytes;
 * the JSON body limit is raised for this route alone rather than globally.
 */
app.post('/api/youtube/takeout', express.json({ limit: '256mb' }), async (req, res) => {
  try {
    const history = parseWatchHistory(Array.isArray(req.body) ? req.body : String(req.body ?? ''))
    const stored = await rememberWatchHistory(history)
    const { tallies, since, until } = channelsByWatchCount(history, 15)
    res.json({
      imported: stored.length,
      events: history.events.length,
      skipped: history.skipped,
      covers: { since, until },
      // Labelled at the point of production: this is a count, not something
      // YouTube asserted, and it is only true for the window above.
      topChannels: tallies.map((t) => ({ ...t, basis: 'counted from watch events' })),
    })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

/**
 * YouTube retrieval, by explicit scope.
 *
 * "Pull some scary stories" used to reach nothing at all: the surface was fed
 * only from synced watch-history observations, so an account he does not watch
 * YouTube on made the entire application look empty, and the request died as a
 * sentence in chat. Open search existed in `youtube.ts` the whole time — there
 * was simply no route to it.
 *
 * Watch history is therefore NOT the boundary of this surface. The scopes are
 * separate on purpose, because they answer different questions and cost
 * different amounts (a list call is 1 unit, a search is 100):
 *
 *   open          — public YouTube. Works with no personal signal whatsoever.
 *   subscriptions — recent uploads from channels he follows.
 *   likes         — what he has liked.
 *
 * Weak personal signal lowers personalisation CONFIDENCE. It must never lower
 * retrieval REACH, which is what "Nothing watched recently." was doing.
 */
app.get('/api/youtube/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim()
  const scope = String(req.query.scope ?? 'open')
  const limit = Math.min(50, Number(req.query.limit) || 12)
  const { youtubeToken } = await planAuth()

  if (!youtubeToken) {
    return res.status(401).json({ failure: 'auth', reason: 'YouTube isn’t connected — sign in with Google to search it.' })
  }
  if (scope === 'open' && !q) {
    return res.status(400).json({ failure: 'unsupported', reason: 'Searching YouTube needs something to search for.' })
  }

  try {
    let videos: YTVideo[] = []
    let provenance = ''
    if (scope === 'subscriptions') {
      videos = (await fromSubscriptions(youtubeToken, { limit })).videos
      provenance = 'From your subscriptions'
      // A query alongside a personal scope narrows what came back rather than
      // reaching further; it is a filter, not a second search.
      if (q) {
        const n = q.toLowerCase()
        videos = videos.filter((v) => `${v.title} ${v.channel ?? ''}`.toLowerCase().includes(n))
      }
    } else if (scope === 'likes') {
      videos = await likedVideos(youtubeToken, limit)
      provenance = 'From your likes'
      if (q) {
        const n = q.toLowerCase()
        videos = videos.filter((v) => `${v.title} ${v.channel ?? ''}`.toLowerCase().includes(n))
      }
    } else {
      videos = await search(youtubeToken, q, { limit })
      provenance = 'Across YouTube'
    }
    /**
     * Mapped, not passed through. See `presentable` — handing this module's
     * `Video` shape straight to a client that reads `.id` is what produced
     * `watch?v=undefined` on every searched video.
     */
    const shown = presentable(videos)
    res.json({
      videos: shown.videos,
      scope,
      query: q,
      provenance,
      resultCount: shown.videos.length,
      // Never a silently shorter list: if YouTube returned something this app
      // cannot identify, that is stated rather than hidden.
      unidentified: shown.rejected,
      quota: quotaLedger(),
      at: new Date().toISOString(),
    })
  } catch (e) {
    // Say WHICH failure. Quota means wait, auth means reconnect, and a generic
    // "couldn't search" collapses two different recoveries into none.
    const msg = String((e as Error)?.message ?? e)
    const code = /\b(\d{3})\b/.exec(msg)?.[1]
    const failure =
      code === '403' && /quota/i.test(msg) ? 'quota'
      : code === '401' || code === '403' ? 'auth'
      : code && Number(code) >= 500 ? 'provider'
      : 'provider'
    res.status(502).json({
      failure,
      reason:
        failure === 'quota' ? 'YouTube’s daily search quota is used up. It resets at midnight Pacific.'
        : failure === 'auth' ? 'YouTube refused the account — it needs reconnecting.'
        : `YouTube returned an error: ${msg}`,
      quota: quotaLedger(),
    })
  }
})

/** What the YouTube quota has cost us today. Modelled from our own calls. */
app.get('/api/youtube/quota', (_req, res) => res.json(quotaLedger()))

/** Search-API keys (Brave / Tavily), stored like any other key. */
app.put('/api/search-key/:id', async (req, res) => {
  const id = req.params.id
  if (id !== 'brave' && id !== 'tavily') return res.status(404).json({ error: 'Unknown search provider' })
  const key = String(req.body?.key ?? '').trim()
  if (!key) return res.status(400).json({ error: 'No key provided' })
  await setKey(id, key)
  res.json({ ok: true })
})

/**
 * One curiosity cycle: work out what it most needs to know, look up whatever
 * the web can answer, and hand back the questions only he can answer so the
 * next think() can put them to him as cards.
 */
/**
 * Standing interests. Nothing here knows what a subject IS — a track is a
 * question, an intent and a cadence, so adding "track my flights" costs the
 * same as adding anything else: one row.
 */
app.get('/api/tracks', async (_req, res) => {
  res.json({ tracks: await listTracks() })
})

app.post('/api/tracks', async (req, res) => {
  const t = await addTrack(req.body ?? {}, req.body?.by === 'agent' ? 'agent' : 'user')
  if (!t) return res.status(400).json({ error: 'needs a "what", and must not duplicate an existing track' })
  res.json({ ok: true, track: t })
})

app.patch('/api/tracks/:id', async (req, res) => {
  const t = await updateTrack(req.params.id, req.body ?? {})
  if (!t) return res.status(404).json({ error: 'no such track' })
  res.json({ ok: true, track: t })
})

app.delete('/api/tracks/:id', async (req, res) => {
  if (!(await removeTrack(req.params.id))) return res.status(404).json({ error: 'no such track' })
  res.json({ ok: true })
})

app.post('/api/tracks/run', async (_req, res) => {
  const searchKeys = { brave: (await getKey('brave')) ?? undefined, tavily: (await getKey('tavily')) ?? undefined }
  res.json(await runDueTracks(searchKeys))
})

app.post('/api/learn', async (_req, res) => {
  const world = await readWorld()
  try {
    // What he asked to be watched comes first — his stated interests outrank
    // whatever the model happens to be curious about this pass.
    const searchKeysForTracks = { brave: (await getKey('brave')) ?? undefined, tavily: (await getKey('tavily')) ?? undefined }
    const tracked = await runDueTracks(searchKeysForTracks)

    const gaps = await proposeGaps(world)
    const worldGaps = gaps.filter((g) => g.who === 'world')
    const userGaps = gaps.filter((g) => g.who === 'user')

    // Researched in parallel; a gap that cannot be answered is simply dropped.
    const searchKeys = { brave: (await getKey('brave')) ?? undefined, tavily: (await getKey('tavily')) ?? undefined }
    const found = (await Promise.all(worldGaps.map((g) => researchGap(g, world, undefined, searchKeys).catch(() => null))))
      .filter((o): o is NonNullable<typeof o> => o !== null)

    if (found.length) await addObservations(found)

    res.json({
      tracked: tracked.ran,
      asked: worldGaps.map((g) => g.question),
      learned: [...tracked.learned, ...found.map((o) => o.text)],
      unanswered: worldGaps.length - found.length,
      forHim: userGaps,
      // Honest about capability: grounding on a free Gemini key returns 429,
      // so say whether anything can actually search rather than implying it.
      searchable: true,
    })
  } catch (err) {
    res.status(502).json({ error: (err as Error).message })
  }
})

/** Free-text conversation. The composer's other end. */
app.post('/api/say', async (req, res) => {
  const text = String(req.body?.text ?? '').trim()
  if (!text) return res.status(400).json({ error: 'Nothing said' })
  try {
    res.json(await say(
      await readWorld(),
      text,
      req.body?.card ?? null,
      req.body?.thread ?? [],
      sayDeps(),
      // What he is looking at. Sent by the client because the client is where
      // it lives — the server holds the pane's CONTENTS, but which day is on
      // screen and which three messages are selected are facts about the
      // browser and nowhere else.
      Array.isArray(req.body?.surfaces) ? req.body.surfaces : []
    ))
  } catch (err) {
    res.status(502).json({ error: (err as Error).message })
  }
})

/**
 * The synthesis pass: look at the whole life at once and decide what deserves
 * his attention. Belief updates the model proposes are merged back in, so the
 * world model sharpens each time it thinks.
 */
app.post('/api/think', async (req, res) => {
  const world = await readWorld()
  try {
    const result = await think(world, req.body?.nudge)

    if (result.beliefUpdates.length) {
      const byIdMap = new Map(world.beliefs.map((b) => [b.id, b]))
      for (const b of result.beliefUpdates) {
        // Confidence 0 is retirement, not a weak belief: his life moved on and
        // this claim is now false. Drop it rather than carry a contradiction
        // forward into every future prompt.
        if (b.confidence === 0) byIdMap.delete(b.id)
        else byIdMap.set(b.id, b)
      }
      world.beliefs = [...byIdMap.values()]
      /**
       * BELIEFS ONLY. `world` here was read before the model call, which takes as long
       * as a model takes — so writing it whole would restore a pre-synthesis `person`
       * over any correction he made while it was thinking.
       */
      await mutateWorld((fresh) => { fresh.beliefs = world.beliefs }, { label: 'the beliefs from this pass' })
    }

    // Synthesis leads; the connected sources sit under it. Merged rather than
    // replaced, and de-duplicated by id so a re-think never doubles a pane.
    const panes = sourcePanes(world)
    // Deterministic panes carry refs too, so they pick up the same "where this
    // came from, and how old" line the model-authored ones get. Their images
    // are already their own and are left alone.
    await resolveRefs(panes.flatMap((p) => p.panes ?? []))
    const have = new Set(result.needs.map((n) => n.id))
    res.json({ ...result, needs: [...result.needs, ...panes.filter((p) => !have.has(p.id))] })
  } catch (err) {
    // The brain failing is not the app failing. Everything the connectors know
    // is still true and still worth showing, so the feed renders from the world
    // model alone, with one card saying what is wrong and how to fix it.
    const panes = sourcePanes(world)
    await resolveRefs(panes.flatMap((p) => p.panes ?? []))
    const message = (err as Error).message
    res.status(200).json({
      dateLabel: new Date().toLocaleDateString(),
      clock: '12h',
      place: null,
      readLine: panes.length ? 'Here’s what I already know.' : '',
      needs: [noticePane(message), ...panes],
      ask: { opening: 'What’s on your mind?', chips: [] },
      quietLog: [],
      beliefUpdates: [],
      dropped: [],
      degraded: message,
    })
  }
})

/** Who is connected, who is resting, what it has cost today. */
app.get('/api/health', async (_req, res) => {
  res.json({ providers: await health(), synthesis: await candidates('synthesis') })
})

/** The provider/model/key currently in use, or why there isn't one. */
async function activeCreds(): Promise<{ providerId: string; model: string; key: string } | { error: string }> {
  const cfg = await readConfig()
  const id = cfg.activeProvider
  if (!id) return { error: 'No model connected' }
  const p = byId(id)
  if (!p) return { error: 'Active provider is no longer available' }
  const key = await getKey(id)
  if (!key) return { error: 'No key for the active provider' }
  return { providerId: id, model: cfg.models?.[id] ?? p.defaultModel, key }
}

async function firstConfigured(exclude?: string): Promise<string | null> {
  for (const p of providers) {
    if (p.id === exclude) continue
    if ((await getKey(p.id)) !== null) return p.id
  }
  return null
}

/** The same hands the Worker gives `say`, backed by the local host. */
function sayDeps() {
  return {
    sync: async () => {
      const token = await accessToken(G_ID, G_SECRET)
      if (!token) throw new Error('Google is not connected')
      const w = await readWorld()
      const { observations, timeZone, coverage } = await pullObservations(token, w.sources, w.timeZone)
      if (observations.length || timeZone || coverage.length) await addObservations(observations, new Date(), { timeZone, coverage })
      return { added: observations.length }
    },
    research: async (question: string) => {
      const w = await readWorld()
      const keys = { brave: (await getKey('brave')) ?? undefined, tavily: (await getKey('tavily')) ?? undefined }
      const obs = await researchGap({ question, who: 'world', why: 'he asked' }, w, undefined as any, keys)
      if (!obs) return null
      await addObservations([obs])
      return obs.text
    },
    /**
     * "Show me…" said in the composer, compiled and put on his splash.
     *
     * The last mile of the compiler: he never sees a plan, never names a pane
     * and never learns an id — he says a sentence and a pane exists. What comes
     * back is only enough for the assistant to describe what it did honestly,
     * including the parts of his instruction it could not express.
     */
    build: async (intent: string) => {
      const r = await ask(intent, { fresh: true, auth: await planAuth() })
      if (r.kind !== 'pane') throw new Error('I wasn’t sure which one you meant.')
      return {
        title: r.view.pane.title || intent,
        count: r.view.revision.refs.length,
        unresolved: r.compiled.unresolved,
      }
    },
  }
}

app.listen(PORT, () => {
  console.log(`crucible brain on http://localhost:${PORT}`)
})

/**
 * Record the client's zone, if it sent one, and hand back the world.
 *
 * Every feed request carries it, so this runs constantly and must be almost
 * free: `noteTimeZone` returns false unless something actually changed, and
 * only then is anything written.
 */
async function noteClientZone(tz: string): Promise<World | undefined> {
  try {
    /**
     * `noteTimeZone` returns false unless something actually changed, so the common
     * case is a plain read and no transaction at all — which matters, because every
     * feed request carries a zone and this runs constantly.
     */
    const w = await readWorld()
    if (!tz || !noteTimeZone(w, tz, 'device')) return w
    const { world } = await mutateWorld((fresh) => { noteTimeZone(fresh, tz, 'device') }, { label: 'your time zone' })
    return world
  } catch {
    return undefined
  }
}

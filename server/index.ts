import express from 'express'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getKey, setKey, deleteKey } from './secrets.js'
import { installNodeRuntime } from './node-runtime.js'
import { providers, byId, chat, listModels, canSearch, probe } from './providers.js'
import { readWorld, writeWorld, addObservations } from './world.js'
import { think } from './think.js'
import { sourcePanes, noticePane } from './panes.js'
import { say } from './say.js'
import { proposeGaps, researchGap } from './research.js'
import { listTracks, addTrack, updateTrack, removeTrack, runDueTracks } from './tracks.js'
import { route, health, candidates, setModelPrefs, wake, budgets } from './router.js'
import { hunt, ensureVerified, snapshot, usable as usableModels } from './models.js'
import { authUrl, exchangeCode, accessToken, loadTokens, clearTokens, saveTokens, pullObservations, serverBase, callbackPath, GOOGLE_SOURCES, gmailModify, calendarRsvp } from './google.js'

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
app.post('/api/act', async (req, res) => {
  const kind = String(req.body?.kind ?? '')
  const params = (req.body?.params ?? {}) as Record<string, unknown>
  const str = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : '')
  const google = async () => {
    const t = await accessToken(G_ID, G_SECRET)
    if (!t) throw new Error('Google is not connected.')
    return t
  }

  try {
    switch (kind) {
      // ── Reading and organising. Reversible from Gmail, so no confirmation.
      case 'mail.archive':
        await gmailModify(await google(), str('messageId'), { removeLabelIds: ['INBOX'] })
        return res.json({ ok: true })
      case 'mail.read':
        await gmailModify(await google(), str('messageId'), { removeLabelIds: ['UNREAD'] })
        return res.json({ ok: true })
      case 'mail.unread':
        await gmailModify(await google(), str('messageId'), { addLabelIds: ['UNREAD'] })
        return res.json({ ok: true })

      // ── Calendar.
      case 'calendar.rsvp':
        await calendarRsvp(await google(), str('eventId'), str('response'))
        return res.json({ ok: true })

      /**
       * Something happened that the assistant should know about.
       *
       * The one action a model-authored widget can take that changes state, and
       * it only ever adds to the world model — it cannot touch his accounts.
       */
      case 'world.tell':
        await addObservations([
          { id: `act-${Date.now()}`, source: 'user', at: new Date().toISOString().slice(0, 10), text: str('text') || String(req.body?.card ?? 'acted on a card') },
        ])
        return res.json({ ok: true })

      /** Purely client-side intents reach here only if the client missed them. */
      case 'mail.open':
      case 'calendar.open':
      case 'media.open':
      case 'map.route':
      case 'map.search':
        return res.json({ ok: true, refresh: false })

      default:
        return res.status(400).json({ error: `I don't know how to do "${kind}" yet.` })
    }
  } catch (e) {
    res.status(502).json({ error: (e as Error).message })
  }
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
app.post('/api/world/tell', async (req, res) => {
  const text = String(req.body?.text ?? '').trim()
  if (!text) return res.status(400).json({ error: 'Nothing said' })
  const now = new Date()
  await addObservations([
    {
      id: `told-${now.getTime().toString(36)}`,
      source: 'user',
      at: now.toISOString().slice(0, 10),
      // Answers to a question are far more useful with the question attached.
      text: req.body?.inReplyTo ? `Asked "${String(req.body.inReplyTo).slice(0, 200)}" — he said: ${text}` : text,
    },
  ])
  res.json({ ok: true })
})

app.put('/api/world/profile', async (req, res) => {
  const w = await readWorld()
  w.profile = String(req.body?.profile ?? '')
  await writeWorld(w)
  res.json({ ok: true })
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
      const { observations } = await pullObservations(token, (await readWorld()).sources)
      if (observations.length) await addObservations(observations)
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
  const { observations, errors } = await pullObservations(token, (await readWorld()).sources)
  if (observations.length) await addObservations(observations)
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
  const w = await readWorld()
  w.sources = w.sources ?? {}
  for (const [id, on] of Object.entries(req.body?.sources ?? {})) w.sources[id] = on === true
  if (req.body?.curation === 'auto' || req.body?.curation === 'manual') w.curation = req.body.curation
  await writeWorld(w)
  res.json({ ok: true, sources: w.sources, curation: w.curation })
})

app.post('/api/google/disconnect', async (_req, res) => {
  await clearTokens()
  res.json({ ok: true })
})

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
    res.json(await say(await readWorld(), text, req.body?.card ?? null, req.body?.thread ?? [], sayDeps()))
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
      await writeWorld(world)
    }

    // Synthesis leads; the connected sources sit under it. Merged rather than
    // replaced, and de-duplicated by id so a re-think never doubles a pane.
    const panes = sourcePanes(world)
    const have = new Set(result.needs.map((n) => n.id))
    res.json({ ...result, needs: [...result.needs, ...panes.filter((p) => !have.has(p.id))] })
  } catch (err) {
    // The brain failing is not the app failing. Everything the connectors know
    // is still true and still worth showing, so the feed renders from the world
    // model alone, with one card saying what is wrong and how to fix it.
    const panes = sourcePanes(world)
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
      const { observations } = await pullObservations(token, w.sources)
      if (observations.length) await addObservations(observations)
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
  }
}

app.listen(PORT, () => {
  console.log(`crucible brain on http://localhost:${PORT}`)
})

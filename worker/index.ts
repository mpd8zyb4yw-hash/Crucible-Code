import { setKeyStore, kvKeyStore, setKey, deleteKey } from '../server/secrets.js'
import { notify, type PushSub } from '../server/push.js'
import { setWorldStore, kvWorldStore } from '../server/store.js'
import { setModelPrefs, setRouterStore, kvRouterStore, wake } from '../server/router.js'
import { setRegistryStore, kvRegistryStore } from '../server/models.js'
import { readWorld, writeWorld, addObservations } from '../server/world.js'
import { think } from '../server/think.js'
import { sourcePanes, noticePane } from '../server/panes.js'
import { say } from '../server/say.js'
import { proposeGaps, researchGap } from '../server/research.js'
import { listTracks, addTrack, updateTrack, removeTrack, runDueTracks } from '../server/tracks.js'
import { providers, byId, listModels, chat, probe } from '../server/providers.js'
import { getKey } from '../server/secrets.js'
import {
  authUrl, exchangeCode, pullObservations, GOOGLE_SOURCES, callbackPath,
  type Tokens,
} from '../server/google.js'

/**
 * Crucible on the edge.
 *
 * The whole point of this file is that it is thin. Synthesis, curiosity,
 * tracks, routing and the Google connector are the SAME modules the Mac runs;
 * only the two host-shaped things differ — where keys come from (Worker
 * secrets) and where the world model lives (KV) — and both are injected at the
 * top of every request. That is what makes the product standalone: nothing
 * here needs a laptop to be awake.
 *
 * It is single-tenant on purpose. One person's world model, one Google
 * account allowed in. Everything under /api is refused without a valid session
 * cookie, because this world model is his calendar, his mail, his health and
 * his location, sitting on a public hostname.
 */

export interface Env {
  CRUCIBLE: KVNamespace
  ASSETS: Fetcher
  JWT_SECRET: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  /** The one Google account allowed to sign in. Everyone else is refused. */
  ALLOWED_EMAIL: string
  GEMINI_API_KEY?: string
  GROQ_API_KEY?: string
  OPENROUTER_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  OPENAI_API_KEY?: string
  XAI_API_KEY?: string
  MISTRAL_API_KEY?: string
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
  BRAVE_API_KEY?: string
  TAVILY_API_KEY?: string
}

/** Provider id → the secret that carries its key. */
const KEY_MAP: Record<string, string> = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  xai: 'XAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  brave: 'BRAVE_API_KEY',
  tavily: 'TAVILY_API_KEY',
}

const TOKENS_KEY = 'google-tokens'
const COOKIE = 'cru_session'
const enc = new TextEncoder()

// ── session ───────────────────────────────────────────────────────────────
const b64url = (b: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function hmac(data: string, secret: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(data)))
}

async function sign(payload: Record<string, unknown>, secret: string): Promise<string> {
  const h = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const p = b64url(enc.encode(JSON.stringify(payload)))
  return `${h}.${p}.${await hmac(`${h}.${p}`, secret)}`
}

async function verify(token: string | null, secret: string): Promise<Record<string, any> | null> {
  if (!token) return null
  const [h, p, s] = token.split('.')
  if (!h || !p || !s) return null
  if ((await hmac(`${h}.${p}`, secret)) !== s) return null
  try {
    const claims = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')))
    if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return null
    return claims
  } catch {
    return null
  }
}

const cookie = (req: Request, name: string): string | null => {
  const raw = req.headers.get('cookie') ?? ''
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return null
}

/**
 * `no-store` is not decoration. Without it the edge cached API replies — a
 * stale "not configured" 503 kept being served after the secrets were set,
 * and the same mechanism would happily serve one person's feed to the next.
 */
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })

// ── google tokens, in KV instead of a dotfile ─────────────────────────────
async function loadTokens(env: Env): Promise<Tokens | null> {
  const raw = await env.CRUCIBLE.get(TOKENS_KEY)
  return raw ? (JSON.parse(raw) as Tokens) : null
}

async function saveTokens(env: Env, t: Tokens): Promise<void> {
  await env.CRUCIBLE.put(TOKENS_KEY, JSON.stringify(t))
}

/** A live Google access token, refreshed if it has expired. */
async function googleToken(env: Env): Promise<string | null> {
  const t = await loadTokens(env)
  if (!t?.access_token) return null
  if (t.expiry - 60_000 > Date.now()) return t.access_token
  if (!t.refresh_token) return null

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: t.refresh_token,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  })
  const b: any = await r.json()
  if (!r.ok) return null
  const next: Tokens = {
    access_token: b.access_token,
    refresh_token: b.refresh_token ?? t.refresh_token,
    expiry: Date.now() + (Number(b.expires_in) || 3600) * 1000,
    scope: b.scope ?? t.scope,
  }
  await saveTokens(env, next)
  return next.access_token
}

const searchKeys = async () => ({
  brave: (await getKey('brave')) ?? undefined,
  tavily: (await getKey('tavily')) ?? undefined,
})

const SUBS_KEY = 'push:subs'

async function loadSubs(env: Env): Promise<PushSub[]> {
  try { return JSON.parse((await env.CRUCIBLE.get(SUBS_KEY)) ?? '[]') } catch { return [] }
}

async function saveSubs(env: Env, subs: PushSub[]): Promise<void> {
  await env.CRUCIBLE.put(SUBS_KEY, JSON.stringify(subs))
}

/**
 * Ring only for a track that actually fired. Calendar and mail refresh on
 * nearly every pass, so notifying on "new observations" would buzz him every
 * three hours forever; a track is something he explicitly agreed to be told
 * about, which is the only thing that has earned an interruption.
 */
async function ringIfWorthIt(env: Env, learned: string[]): Promise<void> {
  if (!learned.length) return
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = env
  if (!publicKey || !privateKey || !subject) return
  const subs = await loadSubs(env)
  if (!subs.length) return
  const r = await notify(subs, { publicKey, privateKey, subject })
  // A push service that says the subscription is gone is telling the truth;
  // keeping it would mean retrying a dead endpoint on every pass forever.
  if (r.expired.length) await saveSubs(env, subs.filter((s) => !r.expired.includes(s.endpoint)))
}

/**
 * One unattended pass: refresh what Google can see, then let any standing
 * interest that has come due do its own looking. Each half is wrapped
 * separately — a revoked Google token must not stop tracks from running, and
 * a track that throws must not lose the observations already pulled.
 */
async function gather(env: Env): Promise<void> {
  try {
    const token = await googleToken(env)
    if (token) {
      const w = await readWorld()
      const { observations } = await pullObservations(token, w.sources)
      if (observations.length) await addObservations(observations)
    }
  } catch {
    /* a dead token is tomorrow's problem, not this run's */
  }
  try {
    const { learned } = await runDueTracks(await searchKeys())
    await ringIfWorthIt(env, learned)
  } catch {
    /* one bad track must not poison the pass */
  }
}

export default {
  /**
   * Work that happens while he is not looking.
   *
   * The product promises "things handled without you today", and until this
   * existed that could only ever be true if he had the app open — every pull
   * and every track ran off a request he made. This is the half that makes the
   * claim honest.
   *
   * Deliberately GATHERING only, never synthesis. Pulling Google and running
   * due tracks is cheap, deterministic, and mostly keyless; a scheduled
   * think() would burn the free tier's daily allowance on an answer nobody is
   * reading, and leave none for the moment he actually opens it. Synthesis
   * stays on-demand, over whatever this has collected.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    setKeyStore(kvKeyStore(env.CRUCIBLE, env as unknown as Record<string, unknown>, KEY_MAP))
    setWorldStore(kvWorldStore(env.CRUCIBLE))
    setModelPrefs(async () => JSON.parse((await env.CRUCIBLE.get('prefs')) ?? '{}'))
    setRouterStore(kvRouterStore(env.CRUCIBLE))
    setRegistryStore(kvRegistryStore(env.CRUCIBLE))
    ctx.waitUntil(gather(env))
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    // Host drivers first: every downstream module reads keys and the world
    // through these, and neither exists until this runs.
    setKeyStore(kvKeyStore(env.CRUCIBLE, env as unknown as Record<string, unknown>, KEY_MAP))
    setWorldStore(kvWorldStore(env.CRUCIBLE))
    setModelPrefs(async () => JSON.parse((await env.CRUCIBLE.get('prefs')) ?? '{}'))
    setRouterStore(kvRouterStore(env.CRUCIBLE))
    setRegistryStore(kvRegistryStore(env.CRUCIBLE))

    const url = new URL(req.url)
    const path = url.pathname
    const origin = url.origin

    /**
     * Fail closed. An unset JWT_SECRET would otherwise hash against the string
     * "undefined" — a secret anyone can guess — and an unset ALLOWED_EMAIL
     * would let the allowlist check throw instead of refuse. Neither is a
     * state this should serve traffic in, so it refuses everything but the
     * static shell until the secrets exist.
     */
    const missing = (['JWT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'ALLOWED_EMAIL'] as const)
      .filter((k) => !env[k])
    if (missing.length && (path.startsWith('/api/') || path.startsWith('/auth/'))) {
      return json({ error: `Not configured yet — missing ${missing.join(', ')}` }, 503)
    }

    // ── auth: one Google sign-in, allowlisted to a single account ─────────
    if (path === '/auth/login') {
      return Response.redirect(authUrl(env.GOOGLE_CLIENT_ID, `${origin}${callbackPath}`), 302)
    }

    if (path === callbackPath) {
      const code = url.searchParams.get('code')
      if (!code) return new Response('No code', { status: 400 })
      try {
        const tokens = await exchangeCode(code, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, `${origin}${callbackPath}`)
        const me: any = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        }).then((r) => r.json())

        // The allowlist is the whole access-control model. Anyone else who
        // completes Google's flow still gets nothing.
        if (!me?.email || me.email.toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase()) {
          // Name the address that was presented — the person reading this owns
          // it, so it leaks nothing, and "not an account this Crucible serves"
          // with no address is impossible to act on. The allowed address is
          // NOT echoed; that one would be a leak.
          return new Response(
            `Not an account this Crucible serves.\n\nYou signed in as: ${me?.email ?? '(no email on the account)'}\n\nSet ALLOWED_EMAIL to that address to let it in:\n  npx wrangler secret put ALLOWED_EMAIL\n  npx wrangler deploy`,
            { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } }
          )
        }

        await saveTokens(env, tokens)
        const session = await sign({ sub: me.sub, email: me.email, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 }, env.JWT_SECRET)
        return new Response(null, {
          status: 302,
          headers: {
            location: '/',
            'set-cookie': `${COOKIE}=${session}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`,
          },
        })
      } catch (e) {
        return new Response(`Sign-in failed: ${(e as Error).message}`, { status: 400 })
      }
    }

    if (path === '/auth/logout') {
      return new Response(null, {
        status: 302,
        headers: { location: '/', 'set-cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` },
      })
    }

    /**
     * The one /api path that must work WITHOUT a session: it only starts the
     * sign-in flow. Gating it would mean needing a session to get a session,
     * and the app's own "Sign in" button points here.
     */
    if (path === '/api/google/connect') {
      return Response.redirect(`${origin}/auth/login`, 302)
    }

    // ── everything else under /api requires a session ────────────────────
    if (path.startsWith('/api/')) {
      const claims = await verify(cookie(req, COOKIE), env.JWT_SECRET)
      if (!claims) return json({ error: 'Not signed in', signIn: '/auth/login' }, 401)

      try {
        return await api(req, env, path, origin)
      } catch (e) {
        return json({ error: (e as Error).message }, 502)
      }
    }

    // ── the app itself ───────────────────────────────────────────────────
    return env.ASSETS.fetch(req)
  },
}

async function api(req: Request, env: Env, path: string, origin: string): Promise<Response> {
  const method = req.method
  const body = method === 'POST' || method === 'PUT' || method === 'PATCH'
    ? await req.json().catch(() => ({} as any))
    : ({} as any)

  if (path === '/api/providers' && method === 'GET') {
    const list = await Promise.all(
      providers.map(async (p) => {
        const key = await getKey(p.id)
        const live = key ? await listModels(p.id, key).catch(() => null) : null
        return {
          id: p.id, label: p.label, hint: p.hint, free: p.free,
          models: live?.length ? live : p.models,
          model: p.defaultModel,
          configured: key !== null,
        }
      })
    )
    const prefs = JSON.parse((await env.CRUCIBLE.get('prefs')) ?? '{}')
    const active = prefs.activeProvider && list.some((p) => p.id === prefs.activeProvider && p.configured)
      ? prefs.activeProvider
      : list.find((p) => p.configured)?.id ?? null
    return json({
      providers: list.map((p) => ({ ...p, model: prefs.models?.[p.id] ?? p.model })),
      routing: prefs.routing ?? 'auto',
      active,
    })
  }

  // A key pasted in the app. Proven before it is stored, exactly as on the Mac:
  // a key that cannot answer is a worse state than no key at all.
  const keyMatch = /^\/api\/providers\/([^/]+)\/key$/.exec(path)
  if (keyMatch && (method === 'PUT' || method === 'DELETE')) {
    const p = byId(keyMatch[1]) ?? (['brave', 'tavily'].includes(keyMatch[1]) ? { id: keyMatch[1], defaultModel: '' } as any : null)
    if (!p) return json({ error: 'Unknown provider' }, 404)
    if (method === 'DELETE') {
      await deleteKey(p.id)
      return json({ ok: true })
    }
    const key = String(body?.key ?? '').trim()
    if (!key) return json({ error: 'No key provided' }, 400)
    if (p.defaultModel) {
      try {
        await chat({ providerId: p.id, model: p.defaultModel, key, prompt: 'Reply with the single word: ok', maxTokens: 16 })
      } catch (err) {
        return json({ error: (err as Error).message }, 400)
      }
    }
    await setKey(p.id, key)
    return json({ ok: true, active: p.id })
  }

  // Who chooses the model: Crucible per task, or the one he pinned.
  if (path === '/api/routing' && method === 'PUT') {
    const r = body?.routing
    if (r !== 'auto' && r !== 'pinned') return json({ error: 'routing must be auto or pinned' }, 400)
    const prefs = JSON.parse((await env.CRUCIBLE.get('prefs')) ?? '{}')
    prefs.routing = r
    await env.CRUCIBLE.put('prefs', JSON.stringify(prefs))
    return json({ ok: true, routing: r })
  }

  // Which provider to lean on. The router still chooses per task; this only
  // nudges its preference, and is stored per-user rather than in a config file.
  if (path === '/api/active' && method === 'POST') {
    const id = String(body?.providerId ?? '')
    const p = byId(id)
    if (!p) return json({ error: 'Unknown provider' }, 404)
    if ((await getKey(id)) === null) return json({ error: 'No key for that provider' }, 400)
    const prefs = JSON.parse((await env.CRUCIBLE.get('prefs')) ?? '{}')
    prefs.activeProvider = id
    if (body?.model) {
      // Being listed is not being allowed: providers list their paid tiers to
      // every key, so without this a free key can select a pro model here and
      // the next home-feed synthesis fails with a quota error for a screen.
      const key = await getKey(id)
      const why = key ? await probe(id, String(body.model), key) : 'No key for that provider'
      if (why) return json({ error: why }, 400)
      // It just answered, so whatever rest it was serving is out of date.
      await wake(id, String(body.model))
      prefs.models = { ...(prefs.models ?? {}), [id]: String(body.model) }
    }
    await env.CRUCIBLE.put('prefs', JSON.stringify(prefs))
    return json({ ok: true, active: id, model: prefs.models?.[id] ?? p.defaultModel })
  }

  if (path === '/api/push/vapid-public' && method === 'GET') {
    return json({ key: env.VAPID_PUBLIC_KEY ?? null })
  }

  if (path === '/api/push/subscribe' && method === 'POST') {
    const sub = body?.subscription as PushSub | undefined
    if (!sub?.endpoint) return json({ error: 'invalid subscription' }, 400)
    const subs = await loadSubs(env)
    // One device, one entry — re-subscribing must not stack duplicates.
    await saveSubs(env, [...subs.filter((s) => s.endpoint !== sub.endpoint), sub])
    return json({ ok: true })
  }

  if (path === '/api/world' && method === 'GET') return json(await readWorld())

  if (path === '/api/world/tell' && method === 'POST') {
    const text = String(body?.text ?? '').trim()
    if (!text) return json({ error: 'Nothing said' }, 400)
    const now = new Date()
    await addObservations([{
      id: `told-${now.getTime().toString(36)}`,
      source: 'user',
      at: now.toISOString().slice(0, 10),
      text: body?.inReplyTo ? `Asked "${String(body.inReplyTo).slice(0, 200)}" — he said: ${text}` : text,
    }])
    return json({ ok: true })
  }

  if (path === '/api/say' && method === 'POST') {
    const text = String(body?.text ?? '').trim()
    if (!text) return json({ error: 'Nothing said' }, 400)
    const w = await readWorld()
    // The hands. Without these `say` can only describe doing things.
    return json(await say(w, text, body?.card ?? null, body?.thread ?? [], {
      sync: async () => {
        const token = await googleToken(env)
        if (!token) throw new Error('Google is not connected')
        const { observations } = await pullObservations(token, w.sources)
        if (observations.length) await addObservations(observations)
        return { added: observations.length }
      },
      research: async (question) => {
        const obs = await researchGap({ question, who: 'world', why: 'he asked' }, w, undefined as any, await searchKeys())
        if (!obs) return null
        await addObservations([obs])
        return obs.text
      },
    }))
  }

  if (path === '/api/think' && method === 'POST') {
    const world = await readWorld()
    // Same contract as the Mac: what the connectors know renders with or
    // without a model, and a brain that cannot answer is one card, not a
    // blank screen. See server/panes.ts for why this is not synthesis's job.
    let result
    try {
      result = await think(world, body?.nudge)
    } catch (err) {
      const panes = sourcePanes(world)
      const message = (err as Error).message
      return json({
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
    if (result.beliefUpdates.length) {
      const byIdMap = new Map(world.beliefs.map((b) => [b.id, b]))
      for (const b of result.beliefUpdates) {
        if (b.confidence === 0) byIdMap.delete(b.id)
        else byIdMap.set(b.id, b)
      }
      world.beliefs = [...byIdMap.values()]
      await writeWorld(world)
    }
    const panes = sourcePanes(world)
    const have = new Set(result.needs.map((n) => n.id))
    return json({ ...result, needs: [...result.needs, ...panes.filter((p) => !have.has(p.id))] })
  }

  if (path === '/api/learn' && method === 'POST') {
    const keys = await searchKeys()
    const tracked = await runDueTracks(keys)
    const world = await readWorld()
    const gaps = await proposeGaps(world)
    const worldGaps = gaps.filter((g) => g.who === 'world')
    const found = (await Promise.all(worldGaps.map((g) => researchGap(g, world, undefined, keys).catch(() => null))))
      .filter((o): o is NonNullable<typeof o> => o !== null)
    if (found.length) await addObservations(found)
    return json({
      tracked: tracked.ran,
      asked: worldGaps.map((g) => g.question),
      learned: [...tracked.learned, ...found.map((o) => o.text)],
      unanswered: worldGaps.length - found.length,
      forHim: gaps.filter((g) => g.who === 'user'),
    })
  }

  // ── tracks ──────────────────────────────────────────────────────────────
  if (path === '/api/tracks' && method === 'GET') return json({ tracks: await listTracks() })

  if (path === '/api/tracks' && method === 'POST') {
    const t = await addTrack(body ?? {}, body?.by === 'agent' ? 'agent' : 'user')
    return t ? json({ ok: true, track: t }) : json({ error: 'needs a "what", and must not duplicate an existing track' }, 400)
  }

  if (path === '/api/tracks/run' && method === 'POST') return json(await runDueTracks(await searchKeys()))

  const trackId = path.startsWith('/api/tracks/') ? path.slice('/api/tracks/'.length) : null
  if (trackId && method === 'PATCH') {
    const t = await updateTrack(trackId, body ?? {})
    return t ? json({ ok: true, track: t }) : json({ error: 'no such track' }, 404)
  }
  if (trackId && method === 'DELETE') {
    return (await removeTrack(trackId)) ? json({ ok: true }) : json({ error: 'no such track' }, 404)
  }

  // ── what it may see ─────────────────────────────────────────────────────
  if (path === '/api/sources' && method === 'GET') {
    const w = await readWorld()
    return json({
      sources: GOOGLE_SOURCES.map((id) => ({ id, on: w.sources?.[id] !== false })),
      curation: w.curation ?? 'auto',
    })
  }

  if (path === '/api/sources' && method === 'PUT') {
    const w = await readWorld()
    w.sources = w.sources ?? {}
    for (const [id, on] of Object.entries(body?.sources ?? {})) w.sources[id] = on === true
    if (body?.curation === 'auto' || body?.curation === 'manual') w.curation = body.curation
    await writeWorld(w)
    return json({ ok: true, sources: w.sources, curation: w.curation })
  }

  // ── google ──────────────────────────────────────────────────────────────
  if (path === '/api/google/status' && method === 'GET') {
    const t = await loadTokens(env)
    return json({ configured: !!env.GOOGLE_CLIENT_ID, connected: !!t?.access_token, scopes: t?.scope?.split(' ') ?? [] })
  }

  if (path === '/api/google/connect' && method === 'GET') {
    // Signing in IS connecting here — one flow, one consent screen.
    return Response.redirect(`${origin}/auth/login`, 302)
  }

  if (path === '/api/google/sync' && method === 'POST') {
    const token = await googleToken(env)
    if (!token) return json({ error: 'Google is not connected' }, 400)
    const w = await readWorld()
    const { observations, errors } = await pullObservations(token, w.sources)
    if (observations.length) await addObservations(observations)
    return json({ added: observations.length, errors, bySource: observations.reduce((a: Record<string, number>, o) => ({ ...a, [o.source]: (a[o.source] ?? 0) + 1 }), {}) })
  }

  if (path === '/api/google/disconnect' && method === 'POST') {
    await env.CRUCIBLE.delete(TOKENS_KEY)
    return json({ ok: true })
  }

  return json({ error: 'Not found' }, 404)
}

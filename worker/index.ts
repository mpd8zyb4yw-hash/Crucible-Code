// Crucible API proxy — stateless Cloudflare Worker.
//
// Single job: receive a normalised model-call request from the Crucible server,
// validate the internal JWT, attach the correct provider API key (held only here
// as a Worker secret), forward to the provider, and stream the response straight
// back. No pipeline, no corpus, no state — a transparent key pipe.
//
// This is what removes the need for API keys to live on an always-on server, which
// is what lets Crucible run off the Fly box. Cloudflare's free tier is 100k
// requests/day with no idle clock between requests.
//
// Every provider is reached through its OpenAI chat-completions-compatible endpoint,
// so the request and response shapes are uniform (OpenAI JSON, or SSE deltas when
// streaming). The Crucible server already parses exactly this shape.

export interface Env {
  JWT_SECRET: string
  // Provider keys — names match the Crucible server's .env.local exactly so the same
  // values can be lifted straight into `wrangler secret put`.
  VITE_GROQ_API_KEY: string
  VITE_OPENROUTER_API_KEY: string
  VITE_GEMINI_API_KEY: string
  VITE_HF_API_KEY: string
  VITE_MISTRAL_API_KEY: string
  CLOUDFLARE_API_KEY: string
  CLOUDFLARE_ACCOUNT_ID: string
  // Optional OpenAI-compatible providers — only function if their secret is set.
  TOGETHER_API_KEY?: string
  CEREBRAS_API_KEY?: string
  COHERE_API_KEY?: string
  FIREWORKS_API_KEY?: string
  DEEPINFRA_TOKEN?: string
  // ── Session B: OAuth (login moves off Fly to here) ──
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  // Where to send the browser back to after login, with ?token=<jwt>. Default crucible.cam.
  FRONTEND_URL?: string
  // KV namespace holding user identities (keyed by provider:providerId). Optional —
  // without it the Worker derives a stable deterministic user id so login still works.
  CRUCIBLE_USERS?: KVNamespace
}

// Minimal KV typing so this file is self-contained without @cloudflare/workers-types.
interface KVNamespace {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

// Browsers that may hit the Worker directly (the VS Code extension / dashboard land
// here later). The Crucible server calls server-to-server with no Origin, which is
// allowed unconditionally.
const ALLOWED_ORIGINS = new Set([
  'https://crucible.cam',
  'http://localhost:5180',
  'http://localhost:5173',
])

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://crucible.cam'
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  }
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  })
}

// ── JWT (HS256) — must match the server's signJwt/verifyJwt scheme exactly ──────
// Node signs with crypto.createHmac('sha256', secret).digest('base64url') (unpadded);
// we recompute the same here with Web Crypto and compare in (near) constant time.
function b64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
}

// Sign a JWT byte-identically to the server's signJwt (HS256, unpadded base64url).
// A token signed here verifies in the Mac server's verifyJwt and vice-versa.
async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const h = bytesToB64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const b = bytesToB64url(enc.encode(JSON.stringify(payload)))
  const sigBuf = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${h}.${b}`))
  return `${h}.${b}.${bytesToB64url(new Uint8Array(sigBuf))}`
}

async function verifyJwt(token: string, secret: string): Promise<Record<string, any> | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [h, b, s] = parts
    const sigBuf = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(`${h}.${b}`))
    const expected = bytesToB64url(new Uint8Array(sigBuf))
    if (expected.length !== s.length) return null
    let diff = 0
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ s.charCodeAt(i)
    if (diff !== 0) return null
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(b)))
    if (typeof payload.exp === 'number' && payload.exp < Date.now() / 1000) return null
    return payload
  } catch {
    return null
  }
}

// ── Provider routing — each provider's OpenAI-compatible chat endpoint ──────────
function resolveUpstream(provider: string, env: Env): { url: string; headers: Record<string, string> } | null {
  switch (provider) {
    case 'groq':
      return { url: 'https://api.groq.com/openai/v1/chat/completions', headers: { Authorization: `Bearer ${env.VITE_GROQ_API_KEY}` } }
    case 'openrouter':
      return {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        headers: { Authorization: `Bearer ${env.VITE_OPENROUTER_API_KEY}`, 'HTTP-Referer': 'https://crucible.cam', 'X-Title': 'Crucible' },
      }
    case 'gemini':
      // Google's OpenAI-compatible surface — lets gemini ride the same path as the rest.
      return { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', headers: { Authorization: `Bearer ${env.VITE_GEMINI_API_KEY}` } }
    case 'huggingface':
      return { url: 'https://router.huggingface.co/novita/v3/openai/chat/completions', headers: { Authorization: `Bearer ${env.VITE_HF_API_KEY}` } }
    case 'mistral':
      return { url: 'https://api.mistral.ai/v1/chat/completions', headers: { Authorization: `Bearer ${env.VITE_MISTRAL_API_KEY}` } }
    case 'cloudflare':
      // Workers AI OpenAI-compatible endpoint (account-scoped).
      return { url: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`, headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_KEY}` } }
    case 'together':
      return { url: 'https://api.together.ai/v1/chat/completions', headers: { Authorization: `Bearer ${env.TOGETHER_API_KEY ?? ''}` } }
    case 'cerebras':
      return { url: 'https://api.cerebras.ai/v1/chat/completions', headers: { Authorization: `Bearer ${env.CEREBRAS_API_KEY ?? ''}` } }
    case 'cohere':
      return { url: 'https://api.cohere.ai/compatibility/v1/chat/completions', headers: { Authorization: `Bearer ${env.COHERE_API_KEY ?? ''}` } }
    case 'fireworks':
      return { url: 'https://api.fireworks.ai/inference/v1/chat/completions', headers: { Authorization: `Bearer ${env.FIREWORKS_API_KEY ?? ''}` } }
    case 'deepinfra':
      return { url: 'https://api.deepinfra.com/v1/openai/chat/completions', headers: { Authorization: `Bearer ${env.DEEPINFRA_TOKEN ?? ''}` } }
    default:
      return null
  }
}

interface ProxyBody {
  provider?: string
  model?: string
  messages?: { role: string; content: string }[]
  stream?: boolean
  max_tokens?: number
  extra?: Record<string, unknown>
}

// ── Session B: OAuth (Google + GitHub) — moved here so Fly can be shut down ──────
// Identity-only login: exchange the provider code, resolve {id,email}, sign a session
// JWT with the SAME scheme/secret the Mac server uses, and bounce the browser back to
// the app with ?token=<jwt>. State is a short-lived signed token (stateless — no server
// memory), so this works across Cloudflare's edge with no KV roundtrip for CSRF.
const GOOGLE_SCOPES = 'openid email profile'

function frontendUrl(env: Env): string {
  return (env.FRONTEND_URL ?? 'https://crucible.cam').replace(/\/$/, '')
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

interface WorkerUser { id: string; email: string; provider: string; providerId: string; createdAt: number }

// Resolve a stable user identity. Uses KV when bound; otherwise derives a deterministic
// id from provider:providerId so login still issues a valid session without KV.
async function upsertUser(env: Env, provider: string, providerId: string, email: string): Promise<WorkerUser> {
  const key = `user:${provider}:${providerId}`
  if (env.CRUCIBLE_USERS) {
    const existing = await env.CRUCIBLE_USERS.get(key)
    if (existing) { try { return JSON.parse(existing) as WorkerUser } catch { /* fall through to recreate */ } }
    const user: WorkerUser = { id: crypto.randomUUID(), email, provider, providerId, createdAt: Date.now() }
    await env.CRUCIBLE_USERS.put(key, JSON.stringify(user))
    return user
  }
  const id = `${provider}-${(await sha256Hex(`${provider}:${providerId}`)).slice(0, 24)}`
  return { id, email, provider, providerId, createdAt: Date.now() }
}

async function makeState(provider: string, secret: string): Promise<string> {
  return signJwt({ k: 'oauth', p: provider, exp: Math.floor(Date.now() / 1000) + 600 }, secret)
}
async function checkState(state: string, provider: string, secret: string): Promise<boolean> {
  const p = await verifyJwt(state, secret)
  return !!p && p.k === 'oauth' && p.p === provider
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } })
}

async function handleAuth(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname
  const selfOrigin = url.origin                       // e.g. https://proxy.crucible.cam
  const fe = frontendUrl(env)

  // ── Login redirects ──
  if (path === '/auth/login/google') {
    if (!env.GOOGLE_CLIENT_ID) return new Response('GOOGLE_CLIENT_ID not configured', { status: 503 })
    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: `${selfOrigin}/auth/callback/google`,
      response_type: 'code',
      scope: GOOGLE_SCOPES,
      state: await makeState('google', env.JWT_SECRET),
    })
    return redirectTo(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
  }
  if (path === '/auth/login/github') {
    if (!env.GITHUB_CLIENT_ID) return new Response('GITHUB_CLIENT_ID not configured', { status: 503 })
    const params = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      redirect_uri: `${selfOrigin}/auth/callback/github`,
      scope: 'user:email',
      state: await makeState('github', env.JWT_SECRET),
    })
    return redirectTo(`https://github.com/login/oauth/authorize?${params}`)
  }

  // ── Callbacks ──
  if (path === '/auth/callback/google') {
    const code = url.searchParams.get('code') ?? ''
    const state = url.searchParams.get('state') ?? ''
    const err = url.searchParams.get('error')
    if (err) return redirectTo(`${fe}/?auth_error=${encodeURIComponent(err)}`)
    if (!(await checkState(state, 'google', env.JWT_SECRET))) return redirectTo(`${fe}/?auth_error=invalid_state`)
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!,
          redirect_uri: `${selfOrigin}/auth/callback/google`, grant_type: 'authorization_code',
        }),
      })
      const tokens: any = await tokenRes.json()
      if (!tokenRes.ok) throw new Error(tokens.error_description ?? 'token exchange failed')
      const profRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      const profile: any = await profRes.json()
      const user = await upsertUser(env, 'google', String(profile.id), profile.email ?? '')
      const jwt = await signJwt({ id: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 30 * 86400 }, env.JWT_SECRET)
      return redirectTo(`${fe}/?token=${encodeURIComponent(jwt)}`)
    } catch (e) {
      return redirectTo(`${fe}/?auth_error=${encodeURIComponent('Google sign-in failed')}`)
    }
  }
  if (path === '/auth/callback/github') {
    const code = url.searchParams.get('code') ?? ''
    const state = url.searchParams.get('state') ?? ''
    const err = url.searchParams.get('error')
    if (err) return redirectTo(`${fe}/?auth_error=${encodeURIComponent(err)}`)
    if (!(await checkState(state, 'github', env.JWT_SECRET))) return redirectTo(`${fe}/?auth_error=invalid_state`)
    try {
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET,
          code, redirect_uri: `${selfOrigin}/auth/callback/github`,
        }),
      })
      const tokens: any = await tokenRes.json()
      if (tokens.error) throw new Error(tokens.error_description ?? tokens.error)
      const profRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${tokens.access_token}`, 'User-Agent': 'Crucible' },
      })
      const profile: any = await profRes.json()
      let email: string = profile.email ?? ''
      if (!email) {
        const emailRes = await fetch('https://api.github.com/user/emails', {
          headers: { Authorization: `Bearer ${tokens.access_token}`, 'User-Agent': 'Crucible' },
        })
        const emails: any[] = await emailRes.json()
        email = emails.find(e => e.primary)?.email ?? emails[0]?.email ?? ''
      }
      const user = await upsertUser(env, 'github', String(profile.id), email)
      const jwt = await signJwt({ id: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 30 * 86400 }, env.JWT_SECRET)
      return redirectTo(`${fe}/?token=${encodeURIComponent(jwt)}`)
    } catch (e) {
      return redirectTo(`${fe}/?auth_error=${encodeURIComponent('GitHub sign-in failed')}`)
    }
  }

  return null  // not an auth route
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin')

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }

    // Session B: OAuth login/callback are top-level browser navigations (GET) — handle
    // before the proxy auth gate (they have no JWT yet; they MINT one).
    if (request.method === 'GET' && url.pathname.startsWith('/auth/')) {
      const authRes = await handleAuth(request, env, url)
      if (authRes) return authRes
    }

    // ── Session N: public benchmark dashboard ──────────────────────────────────
    // POST /api/benchmarks/publish — JWT-authed (same Bearer check as /proxy/chat).
    // Stores the latest boot smoke-suite result in KV under 'bench:latest'. The
    // improvement daemon should POST here weekly with the smoke-last.json payload.
    if (url.pathname === '/api/benchmarks/publish' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') ?? ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      const payload = await verifyJwt(token, env.JWT_SECRET)
      if (!payload) return json({ error: 'Unauthorized' }, 401, origin)
      let raw: string
      try { raw = await request.text(); JSON.parse(raw) } catch { return json({ error: 'Invalid JSON body' }, 400, origin) }
      if (!env.CRUCIBLE_USERS) return json({ ok: false, error: 'KV not bound' }, 200, origin)
      await env.CRUCIBLE_USERS.put('bench:latest', raw, { expirationTtl: 60 * 60 * 24 * 30 })
      return json({ ok: true }, 200, origin)
    }

    // GET /api/benchmarks/public — NO auth. Returns the latest stored benchmark so the
    // static dashboard page can fetch it cross-origin (CORS *). Friendly default when
    // there is no data yet (or no KV bound).
    if (url.pathname === '/api/benchmarks/public' && request.method === 'GET') {
      const publicCors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      const fallback = JSON.stringify({ ts: 0, passed: false, note: 'no benchmark data yet' })
      let out = fallback
      if (env.CRUCIBLE_USERS) {
        const stored = await env.CRUCIBLE_USERS.get('bench:latest')
        if (stored) {
          try { JSON.parse(stored); out = stored } catch { out = fallback }
        }
      }
      return new Response(out, { status: 200, headers: publicCors })
    }

    if (url.pathname !== '/proxy/chat' || request.method !== 'POST') {
      return json({ error: 'Not found' }, 404, origin)
    }

    // Auth — internal JWT minted by the Crucible server (same JWT_SECRET).
    const auth = request.headers.get('Authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const payload = await verifyJwt(token, env.JWT_SECRET)
    if (!payload) return json({ error: 'Unauthorized' }, 401, origin)

    let body: ProxyBody
    try { body = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400, origin) }

    const { provider, model, messages, stream, max_tokens, extra } = body
    if (!provider || !model || !Array.isArray(messages)) {
      return json({ error: 'Missing provider, model, or messages' }, 400, origin)
    }

    const up = resolveUpstream(provider, env)
    if (!up) return json({ error: `Unknown provider: ${provider}` }, 400, origin)

    // The Crucible registry id is provider-prefixed (e.g. "groq/llama-3.3-70b",
    // "openrouter/openai/gpt-oss-120b"). Strip the first segment to get the upstream id.
    const upstreamModel = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model

    // Canonical fields win over `extra` so a caller can add params (reasoning_effort)
    // but never clobber model/messages/stream.
    const upstreamBody: Record<string, unknown> = {
      ...(extra && typeof extra === 'object' ? extra : {}),
      model: upstreamModel,
      messages,
      stream: !!stream,
    }
    if (typeof max_tokens === 'number') upstreamBody.max_tokens = max_tokens

    let upstreamRes: Response
    try {
      upstreamRes = await fetch(up.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...up.headers },
        body: JSON.stringify(upstreamBody),
      })
    } catch (e) {
      return json({ error: `Upstream fetch failed: ${(e as Error).message}` }, 502, origin)
    }

    // Transparent pass-through of the upstream body (SSE stream or JSON), with CORS.
    const headers = new Headers(corsHeaders(origin))
    const ct = upstreamRes.headers.get('Content-Type')
    if (ct) headers.set('Content-Type', ct)
    return new Response(upstreamRes.body, { status: upstreamRes.status, headers })
  },
}

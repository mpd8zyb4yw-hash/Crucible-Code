export interface ProviderInfo {
  id: string
  label: string
  hint: string
  free: boolean
  models: string[]
  model: string
  configured: boolean
}

export interface ProvidersResponse {
  providers: ProviderInfo[]
  active: string | null
  /** Who chooses the model: Crucible per task, or the one he pinned. */
  routing: 'auto' | 'pinned'
}

async function j<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error((body as any)?.error ?? `HTTP ${res.status}`)
  return body as T
}

export const listProviders = () => fetch('/api/providers').then(j<ProvidersResponse>)

export const saveKey = (id: string, key: string) =>
  fetch(`/api/providers/${id}/key`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  }).then(j<{ ok: true; active: string }>)

export const removeKey = (id: string) =>
  fetch(`/api/providers/${id}/key`, { method: 'DELETE' }).then(j<{ ok: true; active: string | null }>)

export const setRouting = (routing: 'auto' | 'pinned') =>
  fetch('/api/routing', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ routing }),
  }).then(j<{ ok: true; routing: 'auto' | 'pinned' }>)

export interface Rested {
  model: string
  why: string
  backInMs: number
}

export interface ProviderHealth {
  providerId: string
  callsToday: number
  tokensIn: number
  tokensOut: number
  restingModels: string[]
  rested: Rested[]
}

/** What the router currently knows: who is answering, who is resting and why. */
export const getHealth = () =>
  fetch('/api/health').then(j<{ providers: ProviderHealth[]; synthesis: unknown[] }>)

export const setActive = (providerId: string, model?: string) =>
  fetch('/api/active', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId, model }),
  }).then(j<{ ok: true; active: string; model: string }>)


export interface Need {
  id: string
  tier: 'hero' | 'ember' | 'quiet'
  heat: 'hot' | 'warm' | 'quiet' | 'handled'
  heatLabel: string
  title: string
  sub: string
  status: string
  opening: string
  stats: { l: string; v: string; accent?: string }[] | null
  chips: string[]
  /** Hero card: up to two supply vessels, 0–1 full. */
  gauges: { fill: number; accent?: string }[] | null
  /** Ember card: the progress track and the line under it. */
  meter: { fill: number; left: string; right: string } | null
  /** Quiet row: the 40px glyph tile. */
  glyph: { kind: 'dots' | 'lines' | 'bars'; values: number[] } | null
  accent: string | null
  action: { label: string; done: string } | null
  /** A standing interest the card offers to start watching. */
  proposes: { what: string; why: string; question: string | null; everyHours: number } | null
  basis: string[]
  asks: boolean
}

export interface ThinkResult {
  dateLabel: string
  clock: '12h' | '24h'
  place: string | null
  readLine: string
  needs: Need[]
  ask: { opening: string; chips: string[] }
  quietLog: string[]
  provider: string
  model: string
  fellBackFrom: string[]
}

export const think = () =>
  fetch('/api/think', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(j<ThinkResult>)

export const tell = (text: string, inReplyTo?: string) =>
  fetch('/api/world/tell', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, inReplyTo }),
  }).then(j<{ ok: true }>)

export interface Track {
  id: string
  what: string
  why: string
  question: string | null
  everyHours: number
  lastRunAt: string | null
  active: boolean
  by: 'user' | 'agent'
}

export const listTracks = () => fetch('/api/tracks').then(j<{ tracks: Track[] }>)

export const addTrack = (t: Partial<Track> & { by?: 'user' | 'agent' }) =>
  fetch('/api/tracks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(t),
  }).then(j<{ ok: true; track: Track }>)

export const removeTrack = (id: string) =>
  fetch(`/api/tracks/${id}`, { method: 'DELETE' }).then(j<{ ok: true }>)

export const googleStatus = () =>
  fetch('/api/google/status').then(j<{ configured: boolean; connected: boolean; scopes: string[] }>)

export const googleSync = () =>
  fetch('/api/google/sync', { method: 'POST' }).then(j<{ added: number; bySource: Record<string, number>; errors: string[] }>)

export const googleDisconnect = () =>
  fetch('/api/google/disconnect', { method: 'POST' }).then(j<{ ok: true }>)

export interface SourcesResponse {
  sources: { id: string; on: boolean }[]
  curation: 'auto' | 'manual'
}

export const getSources = () => fetch('/api/sources').then(j<SourcesResponse>)

export const putSources = (body: { sources?: Record<string, boolean>; curation?: 'auto' | 'manual' }) =>
  fetch('/api/sources', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(j<{ ok: true }>)

export const say = (
  text: string,
  card?: { title: string; status: string; asks?: boolean } | null,
  thread?: { who: 'me' | 'ai'; text: string }[]
) =>
  fetch('/api/say', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, card, thread }),
  }).then(j<{ reply: string; learned: boolean; did: string | null }>)

export const learn = () =>
  fetch('/api/learn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    .then(j<{ asked: string[]; learned: string[]; unanswered: number; forHim: unknown[] }>)

/**
 * Turn on notifications. Safe to call on every load: the browser returns the
 * existing subscription if there is one, and the server de-dupes by endpoint.
 * Every step is allowed to fail quietly — push is a nicety, and a browser
 * without it (or a permission he declined) must not break the app.
 */
export async function enablePush(): Promise<'on' | 'denied' | 'unsupported'> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported'
  try {
    const reg = await navigator.serviceWorker.register('/sw.js')
    const { key } = await fetch('/api/push/vapid-public').then(j<{ key: string | null }>)
    if (!key) return 'unsupported'
    // Only ask once the app is worth notifying about — never on first paint.
    if (Notification.permission === 'default' && (await Notification.requestPermission()) !== 'granted') return 'denied'
    if (Notification.permission !== 'granted') return 'denied'

    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(key) }))

    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    })
    return 'on'
  } catch {
    return 'unsupported'
  }
}

function urlB64ToBytes(s: string): ArrayBuffer {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(pad)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

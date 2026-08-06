import type { World } from './world.js'

/**
 * Where the world model is kept — decided by the host, not by the brain.
 *
 * A JSON file under ~/.crucible on the Mac; a KV value on Cloudflare. The
 * synthesis, curiosity and track code never learns which, so the same brain
 * runs in both places and the app does not need a Mac to be awake.
 */
export interface WorldStore {
  read(): Promise<World | null>
  write(w: World): Promise<void>
}

let store: WorldStore | null = null

export function setWorldStore(s: WorldStore): void {
  store = s
}

export function worldStore(): WorldStore {
  if (!store) throw new Error('No world store installed')
  return store
}

/** The world model in a single KV key. One user, one document, one read. */
export function kvWorldStore(kv: KVNamespace, key = 'world'): WorldStore {
  return {
    async read() {
      const raw = await kv.get(key)
      return raw ? (JSON.parse(raw) as World) : null
    },
    async write(w) {
      await kv.put(key, JSON.stringify(w))
    },
  }
}

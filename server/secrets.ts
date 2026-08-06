/**
 * Where API keys come from — decided by the host, not by the brain.
 *
 * On the Mac they live in the macOS keychain. On Cloudflare there is no
 * keychain, so they are Worker secrets injected as env. Every module that
 * needs a key asks here, so neither the router nor any provider has to know
 * which of the two it is running on.
 */
export interface KeyStore {
  get(account: string): Promise<string | null>
  set(account: string, key: string): Promise<void>
  del(account: string): Promise<boolean>
}

const unset: KeyStore = {
  async get() { return null },
  async set() { throw new Error('No key store installed') },
  async del() { return false },
}

let store: KeyStore = unset

export function setKeyStore(s: KeyStore): void {
  store = s
}

export const getKey = (account: string): Promise<string | null> => store.get(account)
export const setKey = (account: string, key: string): Promise<void> => store.set(account, key)
export const deleteKey = (account: string): Promise<boolean> => store.del(account)

/**
 * Keys held as Worker secrets. Read-only by nature: a secret is set with
 * `wrangler secret put`, never by the running app, so writes are refused
 * loudly rather than silently doing nothing.
 */
export function envKeyStore(env: Record<string, unknown>, map: Record<string, string>): KeyStore {
  return {
    async get(account) {
      const name = map[account]
      const v = name ? env[name] : undefined
      return typeof v === 'string' && v.length ? v : null
    },
    async set() {
      throw new Error('Keys are Worker secrets here — set them with `wrangler secret put`')
    },
    async del() {
      return false
    },
  }
}

/**
 * Keys on the edge: KV in front, Worker secrets behind.
 *
 * A secret can only be set from a terminal, which would mean the hosted app is
 * the one place he cannot add a key — exactly backwards, since the phone is
 * the device he actually carries and the Mac keychain is unreachable from it.
 * So a key added in the app is written to KV and shadows the secret of the
 * same name; removing it falls back to the secret rather than leaving nothing.
 */
export function kvKeyStore(
  kv: { get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void>; delete(k: string): Promise<void> },
  env: Record<string, unknown>,
  map: Record<string, string>,
  prefix = 'key:'
): KeyStore {
  const fallback = envKeyStore(env, map)
  return {
    async get(account) {
      const own = await kv.get(prefix + account)
      if (typeof own === 'string' && own.length) return own
      return fallback.get(account)
    },
    async set(account, key) {
      await kv.put(prefix + account, key)
    },
    async del(account) {
      await kv.delete(prefix + account)
      // Only truly gone if no secret is standing behind it.
      return (await fallback.get(account)) === null
    },
  }
}

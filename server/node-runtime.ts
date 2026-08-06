import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setKeyStore } from './secrets.js'
import { setWorldStore } from './store.js'
import { setRouterStore, type RouterState } from './router.js'
import * as keychain from './keychain.js'
import type { World } from './world.js'

/**
 * The Mac's drivers: keys in the macOS keychain, world model in ~/.crucible.
 *
 * Everything Node-only lives behind this one call, which is why the same
 * brain also runs on Cloudflare — the Worker installs its own pair and never
 * imports this file, so `node:fs` never reaches the edge bundle.
 */
const DIR = join(homedir(), '.crucible')
const PATH = join(DIR, 'world.json')
const ROUTER_PATH = join(DIR, 'router.json')

export function installNodeRuntime(): void {
  setKeyStore({
    get: keychain.getKey,
    set: keychain.setKey,
    del: keychain.deleteKey,
  })

  setWorldStore({
    async read() {
      try {
        return JSON.parse(await readFile(PATH, 'utf8')) as World
      } catch {
        return null
      }
    },
    async write(w) {
      await mkdir(DIR, { recursive: true })
      // Pretty-printed because this file is meant to be readable by hand —
      // it is the whole of what the assistant knows about him.
      await writeFile(PATH, JSON.stringify(w, null, 2) + '\n')
    },
  })

  // Which models are rested, and what today has cost. Beside the world model
  // because it is the same kind of thing: state the brain keeps about itself.
  setRouterStore({
    async read(): Promise<RouterState | null> {
      try {
        return JSON.parse(await readFile(ROUTER_PATH, 'utf8')) as RouterState
      } catch {
        return null
      }
    },
    async write(s) {
      await mkdir(DIR, { recursive: true })
      await writeFile(ROUTER_PATH, JSON.stringify(s, null, 2) + '\n')
    },
  })
}

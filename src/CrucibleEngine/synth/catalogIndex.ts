// ============================================================================
// catalogIndex — single merged source of truth for ALL catalog entries.
//
// Merges the hand-written catalog.ts with every JSON batch dropped into
// catalogs/*.json (authored by the skill-author workflow). JSON batches are
// pure data (impl/tests as strings) so there are zero escaping pitfalls, and a
// malformed batch is skipped rather than breaking the whole library.
//
// generate.ts and prove-all.ts both import THIS, so a new batch = drop a JSON
// file in catalogs/ and run `npm run generate:skills && npm run prove:all`.
// ============================================================================

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import BASE, { type CatalogEntry } from './catalog'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BATCH_DIR = path.join(HERE, 'catalogs')

const batches: CatalogEntry[] = []
if (fs.existsSync(BATCH_DIR)) {
  for (const f of fs.readdirSync(BATCH_DIR).filter(f => f.endsWith('.json')).sort()) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(BATCH_DIR, f), 'utf8'))
      if (Array.isArray(arr)) batches.push(...arr)
    } catch (err) {
      console.error(`[catalogIndex] skipping malformed batch ${f}: ${(err as Error).message}`)
    }
  }
}

// Dedupe by id/filename (first definition wins — hand-written catalog.ts takes priority).
const seen = new Set<string>()
const ALL: CatalogEntry[] = []
for (const entry of [...BASE, ...batches]) {
  if (seen.has(entry.id) || seen.has(entry.filename)) continue
  seen.add(entry.id)
  seen.add(entry.filename)
  ALL.push(entry)
}

export type { CatalogEntry }
export default ALL

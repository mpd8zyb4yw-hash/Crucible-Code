// Track C — LIVING CORPUS · deliberate-curation acquisition driver
// Pulls real cross-domain content from approved, key-free sources and feeds it
// through the ingestion pipeline. Deliberate (curated manifest per the domain
// allocation), not organic — the corpus starts toward its target shape; the
// lifecycle system refines from there.
//
// Key-free connectors implemented: Project Gutenberg (plain text classics),
// RFC editor (distributed-systems standards), arXiv API (cross-domain abstracts),
// Stanford Encyclopedia of Philosophy (peer-reviewed reasoning, HTML-stripped).
// Sources requiring bulk archives / API keys (SO dump, NASA NTRS, PubMed bulk)
// are intentionally out of scope for the key-free driver and noted in the manifest.

import { ingestDocument, type IngestDeps, type SourceDoc } from './ingest.js'
import { logGovernance } from './db.js'

const UA = { 'User-Agent': 'CrucibleLivingCorpus/1.0 (research; contact: local)' }

async function fetchText(url: string, timeoutMs = 20000): Promise<string | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(url, { headers: UA, signal: ctrl.signal }).finally(() => clearTimeout(t))
    if (!res.ok) return null
    return await res.text()
  } catch { return null }
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'", mdash: '—', ndash: '–',
  hellip: '…', copy: '(c)', reg: '(r)', trade: '(tm)', deg: '°', times: '×', minus: '-',
}

function decodeEntities(s: string): string {
  return s
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? ' ')
    .replace(/&#(\d+);/g, (_m, n) => { try { return String.fromCodePoint(parseInt(n, 10)) } catch { return ' ' } })
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => { try { return String.fromCodePoint(parseInt(n, 16)) } catch { return ' ' } })
}

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

// ── Connectors ────────────────────────────────────────────────────────────────
export async function fetchGutenberg(id: number): Promise<string | null> {
  // Try the common plain-text layouts.
  for (const url of [
    `https://www.gutenberg.org/files/${id}/${id}-0.txt`,
    `https://www.gutenberg.org/files/${id}/${id}.txt`,
    `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,
  ]) {
    const txt = await fetchText(url)
    if (txt && txt.length > 2000) {
      // Strip Gutenberg license header/footer.
      const start = txt.search(/\*\*\* START OF (?:THE|THIS) PROJECT GUTENBERG/i)
      const end = txt.search(/\*\*\* END OF (?:THE|THIS) PROJECT GUTENBERG/i)
      const body = txt.slice(start >= 0 ? txt.indexOf('\n', start) + 1 : 0, end >= 0 ? end : undefined)
      return body.trim()
    }
  }
  return null
}

export async function fetchRFC(n: number): Promise<string | null> {
  const txt = await fetchText(`https://www.rfc-editor.org/rfc/rfc${n}.txt`)
  if (!txt || txt.length < 1000) return null
  // Strip form-feed page breaks + page headers/footers.
  return txt.replace(/\f/g, '\n').replace(/^.*\[Page \d+\]\s*$/gim, '').trim()
}

export async function fetchArxiv(category: string, max = 20): Promise<Array<{ title: string; abstract: string }>> {
  const url = `http://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(category)}&start=0&max_results=${max}&sortBy=submittedDate&sortOrder=descending`
  const xml = await fetchText(url)
  if (!xml) return []
  const entries: Array<{ title: string; abstract: string }> = []
  const re = /<entry>([\s\S]*?)<\/entry>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const block = m[1]
    const title = (block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').replace(/\s+/g, ' ').trim()
    const abstract = (block.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? '').replace(/\s+/g, ' ').trim()
    if (abstract.length > 200) entries.push({ title, abstract })
  }
  return entries
}

export async function fetchSEP(slug: string): Promise<string | null> {
  const html = await fetchText(`https://plato.stanford.edu/entries/${slug}/`)
  if (!html) return null
  // The article body lives in #main-text; fall back to whole-page strip.
  const main = html.match(/<div id="main-text">([\s\S]*?)<div id="bibliography"/i)?.[1] ?? html
  const text = stripHtml(main)
  return text.length > 2000 ? text : null
}

// ── Programming-domain connector ──────────────────────────────────────────────
// Fetches MDN reference pages, TypeScript handbook, Node.js docs, and npm README
// bodies — all key-free, direct HTTPS. Strips boilerplate before ingest.

export async function fetchMdnPage(slug: string): Promise<string | null> {
  // MDN serves JSON: https://developer.mozilla.org/en-US/docs/Web/<slug>/index.json
  // slug should NOT include the leading "Web/" — it is injected here.
  const prefix = slug.startsWith('Web/') ? '' : 'Web/'
  const json = await fetchText(`https://developer.mozilla.org/en-US/docs/${prefix}${slug}/index.json`)
  if (!json) return null
  try {
    const obj = JSON.parse(json)
    // doc.body is an array of sections: { type, value: { content: '<html>' } }
    const html = (obj.doc?.body ?? []).map((b: any) => b.value?.content ?? b.value ?? '').join(' ')
    const text = stripHtml(html)
    return text.length > 500 ? text : null
  } catch { return null }
}

export async function fetchNpmReadme(pkg: string): Promise<string | null> {
  // registry.npmjs.org/<pkg> returns the full package metadata JSON (readme field)
  const json = await fetchText(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`)
  if (!json) return null
  try {
    const obj = JSON.parse(json)
    const readme: string = obj.readme ?? ''
    // Strip markdown header fences and badges, keep prose + code
    const stripped = readme
      .replace(/!\[.*?\]\(.*?\)/g, '')        // remove image links
      .replace(/\[!\[.*?\]\(.*?\)\]\(.*?\)/g, '') // remove badge links
      .replace(/^\s*#+\s*/gm, '')             // remove markdown headings
      .replace(/`{3,}[\s\S]*?`{3,}/g, m => m.slice(0, 800)) // truncate long code blocks
    return stripped.length > 300 ? stripped.slice(0, 8000) : null
  } catch { return null }
}

export async function fetchRawUrl(url: string): Promise<string | null> {
  const text = await fetchText(url)
  if (!text || text.length < 500) return null
  // If it looks like HTML, strip tags; otherwise return as-is (markdown, plain text)
  if (text.trimStart().startsWith('<')) return stripHtml(text)
  // Strip markdown badge lines and trim
  return text.replace(/^\[!\[.*$/gm, '').trim()
}

// ── Deliberate curation manifest ──────────────────────────────────────────────
// Maps the spec's priority allocation to concrete, key-free fetches. Each entry's
// reliability + staleness class are set per source type.
interface ManifestEntry {
  kind: 'gutenberg' | 'rfc' | 'arxiv' | 'sep' | 'mdn' | 'npm' | 'raw'
  domain: string
  reliability: number
  staleness: SourceDoc['stalenessClass']
  ids?: number[]            // gutenberg ids / rfc numbers
  arxivCats?: string[]      // arxiv categories
  sepSlugs?: string[]       // SEP entry slugs
  mdnSlugs?: string[]       // MDN /en-US/docs/<slug>
  npmPkgs?: string[]        // npm package names
  rawUrls?: Array<{ url: string; label: string }>  // raw markdown/text URLs
}

export const CURATION_MANIFEST: ManifestEntry[] = [
  // Priority 1 — human experience & thought
  { kind: 'sep', domain: 'philosophy', reliability: 0.9, staleness: 'permanent',
    sepSlugs: ['consciousness', 'free-will', 'epistemology', 'ethics-virtue', 'identity-personal', 'time', 'causation-metaphysics', 'emergent-properties', 'scientific-method', 'rationality-historicist'] },
  { kind: 'gutenberg', domain: 'philosophy', reliability: 0.75, staleness: 'permanent',
    ids: [1497 /* Republic */, 3207 /* Leviathan */, 4280 /* Critique of Pure Reason */, 5827 /* Problems of Philosophy */, 2130 /* Nicomachean Ethics */] },
  { kind: 'gutenberg', domain: 'history', reliability: 0.7, staleness: 'permanent',
    ids: [2591 /* Grimm */, 1404 /* Federalist Papers */, 3300 /* Wealth of Nations */] },
  // Priority 2 — cross-domain scientific (abstracts)
  { kind: 'arxiv', domain: 'physics', reliability: 0.7, staleness: 'scientific', arxivCats: ['hep-th', 'quant-ph', 'cond-mat.stat-mech'] },
  { kind: 'arxiv', domain: 'mathematics', reliability: 0.7, staleness: 'permanent', arxivCats: ['math.CO', 'math.NT', 'math.AG'] },
  { kind: 'arxiv', domain: 'biology', reliability: 0.7, staleness: 'scientific', arxivCats: ['q-bio.PE', 'q-bio.NC'] },
  { kind: 'arxiv', domain: 'economics', reliability: 0.7, staleness: 'scientific', arxivCats: ['econ.GN'] },
  { kind: 'arxiv', domain: 'complex-systems', reliability: 0.7, staleness: 'scientific', arxivCats: ['nlin.AO'] },
  // Priority 3/4 — formal reasoning & systems
  { kind: 'rfc', domain: 'networking', reliability: 0.85, staleness: 'engineering',
    ids: [791 /* IP */, 793 /* TCP */, 1122 /* host requirements */, 2616 /* HTTP/1.1 */, 5246 /* TLS */, 6455 /* WebSocket */, 7540 /* HTTP/2 */, 8446 /* TLS 1.3 */] },

  // Priority 5 — programming / CS (new 2026-06-30)
  // MDN Web Docs: JavaScript language reference (key APIs, always-fresh source of truth)
  { kind: 'mdn', domain: 'programming', reliability: 0.95, staleness: 'engineering',
    mdnSlugs: [
      'JavaScript/Reference/Global_Objects/Array',
      'JavaScript/Reference/Global_Objects/Array/map',
      'JavaScript/Reference/Global_Objects/Array/filter',
      'JavaScript/Reference/Global_Objects/Array/reduce',
      'JavaScript/Reference/Global_Objects/Array/sort',
      'JavaScript/Reference/Global_Objects/Array/flat',
      'JavaScript/Reference/Global_Objects/Array/flatMap',
      'JavaScript/Reference/Global_Objects/Array/find',
      'JavaScript/Reference/Global_Objects/Array/findIndex',
      'JavaScript/Reference/Global_Objects/Array/every',
      'JavaScript/Reference/Global_Objects/Array/some',
      'JavaScript/Reference/Global_Objects/Array/includes',
      'JavaScript/Reference/Global_Objects/Promise',
      'JavaScript/Reference/Global_Objects/Promise/all',
      'JavaScript/Reference/Global_Objects/Promise/allSettled',
      'JavaScript/Reference/Global_Objects/Promise/race',
      'JavaScript/Reference/Global_Objects/Map',
      'JavaScript/Reference/Global_Objects/Set',
      'JavaScript/Reference/Global_Objects/Object/assign',
      'JavaScript/Reference/Global_Objects/Object/entries',
      'JavaScript/Reference/Global_Objects/Object/keys',
      'JavaScript/Reference/Global_Objects/Object/fromEntries',
      'JavaScript/Reference/Global_Objects/String/split',
      'JavaScript/Reference/Global_Objects/String/replace',
      'JavaScript/Reference/Global_Objects/String/replaceAll',
      'JavaScript/Reference/Global_Objects/String/trim',
      'JavaScript/Reference/Global_Objects/String/padStart',
      'JavaScript/Reference/Global_Objects/RegExp',
      'JavaScript/Reference/Operators/Destructuring_assignment',
      'JavaScript/Reference/Operators/Spread_syntax',
      'JavaScript/Reference/Functions/Arrow_functions',
      'JavaScript/Reference/Statements/async_function',
      'JavaScript/Reference/Operators/await',
    ],
  },
  // TypeScript handbook chapters (raw markdown from GitHub)
  { kind: 'raw', domain: 'programming', reliability: 0.95, staleness: 'engineering',
    rawUrls: [
      { url: 'https://raw.githubusercontent.com/microsoft/TypeScript-Website/v2/packages/documentation/copy/en/handbook-v2/Basics.md', label: 'ts-handbook-basics' },
      { url: 'https://raw.githubusercontent.com/microsoft/TypeScript-Website/v2/packages/documentation/copy/en/handbook-v2/Everyday%20Types.md', label: 'ts-handbook-everyday-types' },
      { url: 'https://raw.githubusercontent.com/microsoft/TypeScript-Website/v2/packages/documentation/copy/en/handbook-v2/Narrowing.md', label: 'ts-handbook-narrowing' },
      { url: 'https://raw.githubusercontent.com/microsoft/TypeScript-Website/v2/packages/documentation/copy/en/handbook-v2/More%20on%20Functions.md', label: 'ts-handbook-functions' },
      { url: 'https://raw.githubusercontent.com/microsoft/TypeScript-Website/v2/packages/documentation/copy/en/handbook-v2/Object%20Types.md', label: 'ts-handbook-object-types' },
      { url: 'https://raw.githubusercontent.com/microsoft/TypeScript-Website/v2/packages/documentation/copy/en/handbook-v2/Type%20Manipulation/Generics.md', label: 'ts-handbook-generics' },
      { url: 'https://raw.githubusercontent.com/microsoft/TypeScript-Website/v2/packages/documentation/copy/en/handbook-v2/Type%20Manipulation/Utility%20Types.md', label: 'ts-handbook-utility-types' },
      { url: 'https://raw.githubusercontent.com/microsoft/TypeScript-Website/v2/packages/documentation/copy/en/handbook-v2/Type%20Manipulation/Conditional%20Types.md', label: 'ts-handbook-conditional-types' },
      { url: 'https://raw.githubusercontent.com/microsoft/TypeScript-Website/v2/packages/documentation/copy/en/handbook-v2/Type%20Manipulation/Mapped%20Types.md', label: 'ts-handbook-mapped-types' },
      { url: 'https://raw.githubusercontent.com/microsoft/TypeScript-Website/v2/packages/documentation/copy/en/handbook-v2/Classes.md', label: 'ts-handbook-classes' },
    ],
  },
  // npm top-library READMEs (rich API surface, widely-referenced patterns)
  { kind: 'npm', domain: 'programming', reliability: 0.85, staleness: 'engineering',
    npmPkgs: [
      'lodash', 'ramda', 'rxjs', 'zod', 'yup', 'express', 'fastify', 'axios',
      'date-fns', 'dayjs', 'uuid', 'nanoid', 'commander', 'yargs', 'chalk',
      'dotenv', 'joi', 'prisma', 'typeorm', 'drizzle-orm', 'kysely',
      'openai', 'stripe', 'nodemailer', 'ws', 'socket.io',
      'jest', 'vitest', 'mocha', 'sinon', 'supertest',
      'webpack', 'esbuild', 'vite', 'rollup', 'tsup',
      'react', 'vue', 'svelte', 'solid-js', 'preact',
      'next', 'nuxt', 'remix', 'astro',
      'tailwindcss', 'clsx', 'classnames',
      'immer', 'zustand', 'jotai', 'recoil', 'mobx',
      'graphql', 'apollo-server', 'trpc', 'hono',
      'better-sqlite3', 'pg', 'mysql2', 'mongoose', 'redis',
      'mime', 'ms', 'semver', 'cross-spawn', 'execa',
    ],
  },
  // Node.js API docs (raw markdown from GitHub — stable versioned source)
  { kind: 'raw', domain: 'programming', reliability: 0.9, staleness: 'engineering',
    rawUrls: [
      { url: 'https://raw.githubusercontent.com/nodejs/node/main/doc/api/fs.md', label: 'nodejs-fs' },
      { url: 'https://raw.githubusercontent.com/nodejs/node/main/doc/api/path.md', label: 'nodejs-path' },
      { url: 'https://raw.githubusercontent.com/nodejs/node/main/doc/api/http.md', label: 'nodejs-http' },
      { url: 'https://raw.githubusercontent.com/nodejs/node/main/doc/api/stream.md', label: 'nodejs-stream' },
      { url: 'https://raw.githubusercontent.com/nodejs/node/main/doc/api/crypto.md', label: 'nodejs-crypto' },
      { url: 'https://raw.githubusercontent.com/nodejs/node/main/doc/api/events.md', label: 'nodejs-events' },
      { url: 'https://raw.githubusercontent.com/nodejs/node/main/doc/api/child_process.md', label: 'nodejs-child-process' },
      { url: 'https://raw.githubusercontent.com/nodejs/node/main/doc/api/worker_threads.md', label: 'nodejs-workers' },
      { url: 'https://raw.githubusercontent.com/nodejs/node/main/doc/api/url.md', label: 'nodejs-url' },
      { url: 'https://raw.githubusercontent.com/nodejs/node/main/doc/api/buffer.md', label: 'nodejs-buffer' },
    ],
  },
]

// ── Driver ────────────────────────────────────────────────────────────────────
export interface AcquireOptions {
  byteBudget?: number          // stop after this many ingested bytes (default 50MB this run)
  relationshipBudget?: number  // total relationship-extraction model calls allowed
  onProgress?: (msg: string) => void
}

export async function acquireDeliberately(deps: IngestDeps, opts: AcquireOptions = {}): Promise<{ ingested: number; bytes: number; deduped: number; quarantined: number; relationships: number }> {
  const byteBudget = opts.byteBudget ?? 50 * 1_048_576
  let relBudget = opts.relationshipBudget ?? 200
  const log = opts.onProgress ?? ((m: string) => console.log(m))
  const totals = { ingested: 0, bytes: 0, deduped: 0, quarantined: 0, relationships: 0 }

  for (const entry of CURATION_MANIFEST) {
    if (totals.bytes >= byteBudget) break

    const docs: SourceDoc[] = []
    try {
      if (entry.kind === 'gutenberg') {
        for (const id of entry.ids ?? []) {
          const text = await fetchGutenberg(id)
          if (text) docs.push({ text, domain: entry.domain, source: `gutenberg:${id}`, sourceReliability: entry.reliability, stalenessClass: entry.staleness })
        }
      } else if (entry.kind === 'rfc') {
        for (const n of entry.ids ?? []) {
          const text = await fetchRFC(n)
          if (text) docs.push({ text, domain: entry.domain, source: `rfc:${n}`, sourceReliability: entry.reliability, stalenessClass: entry.staleness })
        }
      } else if (entry.kind === 'sep') {
        for (const slug of entry.sepSlugs ?? []) {
          const text = await fetchSEP(slug)
          if (text) docs.push({ text, domain: entry.domain, source: `sep:${slug}`, sourceReliability: entry.reliability, stalenessClass: entry.staleness })
        }
      } else if (entry.kind === 'arxiv') {
        for (const cat of entry.arxivCats ?? []) {
          const papers = await fetchArxiv(cat, 25)
          for (const p of papers) docs.push({ text: `${p.title}. ${p.abstract}`, domain: entry.domain, source: `arxiv:${cat}`, sourceReliability: entry.reliability, stalenessClass: entry.staleness })
        }
      } else if (entry.kind === 'mdn') {
        for (const slug of entry.mdnSlugs ?? []) {
          const text = await fetchMdnPage(slug)
          if (text) docs.push({ text, domain: entry.domain, source: `mdn:${slug}`, sourceReliability: entry.reliability, stalenessClass: entry.staleness })
        }
      } else if (entry.kind === 'npm') {
        for (const pkg of entry.npmPkgs ?? []) {
          const text = await fetchNpmReadme(pkg)
          if (text) docs.push({ text, domain: entry.domain, source: `npm:${pkg}`, sourceReliability: entry.reliability, stalenessClass: entry.staleness })
        }
      } else if (entry.kind === 'raw') {
        for (const { url, label } of entry.rawUrls ?? []) {
          const text = await fetchRawUrl(url)
          if (text) docs.push({ text, domain: entry.domain, source: `raw:${label}`, sourceReliability: entry.reliability, stalenessClass: entry.staleness })
        }
      }
    } catch (e: any) {
      log(`[CORPUS] acquire: source ${entry.kind}/${entry.domain} failed: ${e?.message}`)
      continue
    }

    for (const doc of docs) {
      if (totals.bytes >= byteBudget) break
      const r = await ingestDocument(doc, deps, { relationshipBudget: Math.min(relBudget, 10) })
      totals.ingested += r.ingested; totals.bytes += r.bytes; totals.deduped += r.deduped
      totals.quarantined += r.quarantined; totals.relationships += r.relationships
      relBudget = Math.max(0, relBudget - r.relationships)
      if (r.ingested) log(`[CORPUS] +${r.ingested} chunks (${(r.bytes / 1024).toFixed(0)}KB) from ${doc.source} [${doc.domain}]`)
    }
  }

  logGovernance('acquire', null, `deliberate acquisition cycle: +${totals.ingested} chunks, ${(totals.bytes / 1_048_576).toFixed(2)}MB, ${totals.deduped} deduped, ${totals.quarantined} quarantined`)
  log(`[CORPUS] Acquisition cycle complete — ${totals.ingested} chunks, ${(totals.bytes / 1_048_576).toFixed(2)}MB ingested, ${totals.relationships} relationships, ${totals.deduped} deduped, ${totals.quarantined} quarantined`)
  return totals
}

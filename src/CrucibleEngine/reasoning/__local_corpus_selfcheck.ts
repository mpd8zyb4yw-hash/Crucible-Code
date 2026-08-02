// ═══════════════════════════════════════════════════════════════════════════════
// SELFCHECK for the offline retrieval shelf (localCorpusGround). No model, no network.
// Run:  npx tsx src/CrucibleEngine/reasoning/__local_corpus_selfcheck.ts
// ═══════════════════════════════════════════════════════════════════════════════
//
// A retriever that silently returns nothing is indistinguishable from a retriever that is not
// wired up — and this repo has already paid a session for a mechanism that looked live and was
// dark. These checks run against a PURPOSE-BUILT temp shelf so the assertions are exact, plus one
// check against the REAL node_modules so "it works on a toy tree" is never mistaken for "it works".

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeLocalCorpusGround, queryKeywords, describeCorpus } from './localCorpusGround'

let passed = 0, failed = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

function makeShelf(): string {
  const root = mkdtempSync(join(tmpdir(), 'crucible-shelf-'))
  const pkg = (name: string, file: string, body: string): void => {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, file), body)
  }
  pkg('quote-utils', 'index.js',
    'function stripQuotes(s) {\n  if (s[0] === \'"\' && s[s.length-1] === \'"\') return s.slice(1,-1).replace(/""/g, \'"\')\n  return s\n}\nmodule.exports = { stripQuotes }\n')
  pkg('logger', 'index.js', 'function logLine(line) { console.log(line) }\nmodule.exports = { logLine }\n')
  pkg('bundled', 'thing.min.js', 'var quote,split,comma,field;'.repeat(50))
  pkg('typed', 'index.d.ts', 'export declare function splitQuotedComma(line: string): string[]\n')
  return root
}

async function main(): Promise<void> {
  console.log('# local corpus retrieval shelf — selfcheck\n')

  // 1) KEYWORDS. The rung goal is an English sentence; the retriever must key on its domain words
  // and must split camelCase, or a corpus that names things differently can never match.
  const kw = queryKeywords('Write splitCsvLine(line: string): string[] splitting a line on commas outside double quotes')
  check('camelCase identifier is split into parts', kw.includes('split') && kw.includes('csv') && kw.includes('line'), kw.join(','))
  check('domain words survive', kw.includes('commas') && kw.includes('quotes'), kw.join(','))
  check('stopwords and types are dropped', !kw.includes('write') && !kw.includes('string') && !kw.includes('the'), kw.join(','))

  const root = makeShelf()
  try {
    const ground = makeLocalCorpusGround({ root, maxFiles: 3 })

    // 2) IT RETURNS SOURCE. The whole audit finding was a retriever that returns nothing.
    const blobs = await ground('strip surrounding quotes from a quoted field and unescape doubled quotes')
    check('returns per-file blobs for an on-topic query', Array.isArray(blobs) && blobs.length > 0, String(blobs && blobs.length))
    check('the on-topic file is among them', !!blobs?.some(b => b.includes('stripQuotes')))

    // 3) IT RANKS. Retrieval that returns the whole shelf is not retrieval — the off-topic logger
    // must lose to the on-topic module, which is what makes the top-N cap safe to apply.
    const top1 = await makeLocalCorpusGround({ root, maxFiles: 1 })('unescape doubled quotes in a quoted field')
    check('off-topic file is ranked out at maxFiles=1', !!top1 && top1.length === 1 && top1[0].includes('stripQuotes'),
      top1?.[0]?.slice(0, 40))

    // 4) EXCLUSIONS. Minified bundles keyword-match beautifully and are useless as proposer context;
    // .d.ts declarations name the right function and contain no implementation to extract. Both
    // would score well and teach the loop nothing, so both must be unreachable.
    const all = await makeLocalCorpusGround({ root, maxFiles: 10 })('split quote comma field line')
    check('minified bundle is never returned', !all?.some(b => b.includes('var quote,split')))
    check('.d.ts declaration is never returned', !all?.some(b => b.includes('splitQuotedComma')))

    // 5) HONEST EMPTY. A query the shelf cannot serve must return null, not a plausible-looking
    // irrelevant file — the loop treats "no source" and "wrong source" very differently.
    check('unservable query returns null', (await ground('kubernetes ingress controller reconciliation')) === null)
    check('too-thin query returns null', (await ground('do it')) === null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  // 6) THE REAL SHELF. A toy tree proves the ranking, not the plumbing; this proves the plumbing
  // and simultaneously prints the contamination check that any retrieval number depends on.
  const realRoot = join(process.cwd(), 'node_modules')
  const desc = describeCorpus(realRoot, /csv|papa|tsv|delimit/i)
  console.log(`\n  corpus: ${desc.packages} installed package(s)`)
  console.log(`  packages matching /csv|papa|tsv|delimit/: ${desc.matches.length ? desc.matches.join(', ') : 'NONE'}`)
  check('the real shelf is non-empty', desc.packages > 0, String(desc.packages))
  check('the real shelf ships NO csv parser (so a csv retrieval number is not the answer being handed over)',
    desc.matches.length === 0, desc.matches.join(','))
  const realBlobs = await makeLocalCorpusGround({ root: realRoot, maxFiles: 2, maxFilesScanned: 4000 })(
    'split a line on commas that are outside double quotes')
  console.log(`  real-shelf query returned ${realBlobs ? realBlobs.length : 0} blob(s)`)

  console.log(`\n${failed === 0 ? '✅' : '❌'} local corpus: ${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
}

main().catch(e => { console.error('local corpus selfcheck failed:', e); process.exit(1) })

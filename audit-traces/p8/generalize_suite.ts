// ═══════════════════════════════════════════════════════════════════════════════
// GENERALIZATION suite (cont.89) — does the library-docs chain work beyond the ONE
// zod/ipv4 fixture everything was tuned on?
//   Run: CRUCIBLE_FORCE_SEARCH_EMPTY=1 npx tsx audit-traces/p8/generalize_suite.ts
// ═══════════════════════════════════════════════════════════════════════════════
//
// THE ORACLE MUST EXECUTE. The first cut of this file scored with hand-written regexes
// (`/axios\.get\(/`, `/\.uuid\(/`) and produced TWO FALSE FAILURES:
//   - "zod schema for a uuid string" → `import { guid } from 'zod'; guid()`. VERIFIED by running
//     it: guid() accepts a real UUID and rejects garbage. A correct answer, scored FAIL.
//   - "http get with axios" → `axios({ method: 'GET', url })`. Valid axios. Scored FAIL.
// It reported 2/6 when the truth was 4/6 — and I nearly "fixed" a non-bug because of it. That is
// crucible-verifier-cannot-be-regex applied to my own measurement harness: a name-check cannot
// tell a working API call from a DIFFERENT working API call.
//
// So each task carries a probe that RUNS the answer's code against the REAL package. Where the
// package is absent or execution would hit the network, the task says so and falls back to the
// weaker "calls an identifier the evidence documents" — reported separately, never blurred.

import { answerWithWebGrounding, selectRelevantPassages } from '../../src/CrucibleEngine/answer/groundedAnswer'
import { verifyEvidenceUsage, answerCodeBlocks } from '../../src/CrucibleEngine/reasoning/apiFaithfulness'
import { fetchLibraryApiForQuery } from '../../src/CrucibleEngine/retrieval/retrievalLayer'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')

interface Task {
  id: string
  q: string
  pkg: string
  /** Runs after the answer's code; prints __OK__ only if the API genuinely worked. */
  probe?: string
  /** Why this task cannot be executed (network / not installed). */
  noExec?: string
}

const TASKS: Task[] = [
  { id: 'zod-ipv4', q: 'zod schema to validate an ipv4 address', pkg: 'zod',
    probe: `if (S.safeParse('1.2.3.4').success && !S.safeParse('999.1.1.1').success) console.log('__OK__')` },
  { id: 'zod-email', q: 'write a zod schema that validates an email address', pkg: 'zod',
    probe: `if (S.safeParse('a@b.com').success && !S.safeParse('nope').success) console.log('__OK__')` },
  { id: 'zod-uuid', q: 'zod schema for a uuid string', pkg: 'zod',
    probe: `if (S.safeParse('550e8400-e29b-41d4-a716-446655440000').success && !S.safeParse('x').success) console.log('__OK__')` },
  { id: 'nanoid', q: 'generate a short unique id with nanoid', pkg: 'nanoid',
    probe: `if (typeof S === 'string' && S.length > 5) console.log('__OK__')` },
  { id: 'date-fns', q: 'format a date as yyyy-mm-dd with date-fns', pkg: 'date-fns', noExec: 'date-fns not installed' },
  { id: 'axios-get', q: 'make an http get request with axios', pkg: 'axios', noExec: 'would make a live network request' },
]

/**
 * Run the answer's code, then try the probe against EVERY top-level binding it created — we
 * cannot know the author's variable name, and demanding one would be a name-check by the back
 * door. Any binding satisfying the probe means the API really worked.
 */
function executes(answer: string, task: Task): boolean {
  if (!task.probe) return false
  const blocks = answerCodeBlocks(answer)
  for (let i = 0; i < blocks.length; i++) {
    // REWRITE the answer's imports onto the real package rather than deleting them. Deleting
    // them and injecting only `z` made `import { guid } from 'zod'` leave `guid` undefined — the
    // suite's own self-test caught that as a false FAIL on a VERIFIED-correct answer. Honouring
    // whatever binding the answer actually chose is the whole point: we must not require it to
    // spell the API our way.
    const body = blocks[i]
      .split('\n')
      .map(l => l
        .replace(/^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"][^'"]+['"];?\s*$/, 'const $1: any = __ns')
        .replace(/^\s*import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]*)\}\s*from\s+['"][^'"]+['"];?\s*$/, 'const $1: any = __ns.default ?? __ns; const {$2} = __ns as any')
        .replace(/^\s*import\s+\{([^}]*)\}\s*from\s+['"][^'"]+['"];?\s*$/, 'const {$1} = __ns as any')
        .replace(/^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s+['"][^'"]+['"];?\s*$/, 'const $1: any = __ns.default ?? __ns')
        .replace(/^\s*(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\([^)]*\);?\s*$/, 'const {$1} = __ns as any')
        .replace(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\([^)]*\);?\s*$/, 'const $1: any = __ns.default ?? __ns'))
      .filter(l => !/^\s*import\s/.test(l) && !/\brequire\s*\(/.test(l))
      .map(l => l.replace(/^\s*export\s+(default\s+)?/, ''))
      .join('\n')
    const names = [...new Set([...body.matchAll(/(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]))]
    if (!names.length) continue
    // Pre-bind common namespace handles ONLY when the body did not already declare them via a
    // rewritten import — declaring `const z` here AND `const {z}=__ns` in the body is a redeclare
    // conflict. `z` covers zod answers that write `z.ipv4()` after `import { z }`.
    const declares = (n: string) => new RegExp(`\\b(?:const|let|var|function)\\s+\\{?[^}=]*\\b${n}\\b`).test(body)
    const pre: string[] = []
    if (!declares('z')) pre.push('const z: any = __ns.z ?? __ns.default ?? __ns')
    if (task.pkg === 'nanoid' && !declares('nanoid')) pre.push('const nanoid: any = __ns.nanoid ?? __ns.default')
    if (task.pkg === 'axios' && !declares('axios')) pre.push('const axios: any = __ns.default ?? __ns')
    const src = `
import * as __m from '${task.pkg}'
const __ns: any = __m as any
${pre.join('\n')}
${body}
for (const S of [${names.join(',')}] as any[]) {
  try { ${task.probe} } catch {}
}
`
    const f = join(HERE, `.gen-probe-${task.id}-${i}.ts`)
    writeFileSync(f, src)
    try {
      const out = execFileSync('npx', ['tsx', f], { cwd: REPO, encoding: 'utf8', timeout: 45_000, stdio: ['ignore', 'pipe', 'pipe'] })
      if (out.includes('__OK__')) return true
    } catch { /* try the next block */ }
  }
  return false
}

async function main() {
  const rows: any[] = []
  for (const t of TASKS) {
    const t0 = Date.now()
    let repaired = false, pkgFound = ''
    let r: any = null
    try {
      r = await answerWithWebGrounding(t.q, {
        budgetMs: 90_000,
        emit: (e: any) => {
          const s = String(e.text ?? '')
          if (/rewrite it against the real API/.test(s)) repaired = true
          const m = s.match(/Found ([\w@/.-]+)@[\d.]+ type definitions/); if (m) pkgFound = m[1]
        },
      })
    } catch { /* recorded as fail */ }
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    const text = r?.text ?? ''
    writeFileSync(join(HERE, `gen-${t.id}.md`), text)

    // Weaker check, for the tasks we cannot run: did it CALL something the evidence documents?
    let usedApi = false
    try {
      const d = await fetchLibraryApiForQuery(t.q)
      if (d) {
        const ev = `[S1] ${d.title} — ${d.url}\n${selectRelevantPassages(d.text, t.q, 1200)}`
        usedApi = answerCodeBlocks(text).length > 0 && verifyEvidenceUsage(text, ev).status !== 'violations'
      }
    } catch { /* leave false */ }

    const ran = t.probe ? executes(text, t) : null
    const verdict = ran === null ? (usedApi ? 'USES-API' : 'FAIL') : ran ? 'EXECUTES' : 'FAIL'
    rows.push({ id: t.id, verdict, ran, usedApi, pkg: pkgFound, repaired, secs })
    console.log(
      `${verdict.padEnd(9)} ${t.id.padEnd(10)} pkg=${(pkgFound || 'none').padEnd(9)} repaired=${String(repaired).padEnd(5)} ` +
      `${secs.padStart(6)}s${t.noExec ? `  (not executed: ${t.noExec})` : ''}`,
    )
  }
  const exec = rows.filter(r => r.ran !== null)
  console.log(`\nEXECUTES (the real bar): ${exec.filter(r => r.ran).length}/${exec.length}`)
  console.log(`calls a documented API : ${rows.filter(r => r.usedApi).length}/${rows.length}`)
  console.log(`resolved the right pkg : ${rows.filter(r => r.pkg === TASKS.find(t => t.id === r.id)!.pkg).length}/${rows.length}`)
}
if (!process.env.SUITE_SELFTEST) main().then(() => process.exit(0))
export { executes, TASKS }

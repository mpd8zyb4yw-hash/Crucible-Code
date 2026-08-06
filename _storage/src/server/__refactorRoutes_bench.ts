// ============================================================================
// Committed bench for src/server/refactorRoutes.ts — planRefactor(), the pure
// deterministic-refactor router extracted from server.ts. Proves each refactor
// kind produces the right normalized outcome (writes, terminal-ness, refusal),
// and that non-refactor input / parse-misses fall through correctly. The
// underlying plan* logic is covered by vgr:bench; here we prove the ROUTING +
// outcome shape the server driver consumes.
// Run: npx tsx src/server/__refactorRoutes_bench.ts
// ============================================================================
import { planRefactor } from './refactorRoutes'

const checks: Array<{ name: string; pass: boolean }> = []
const ok = (name: string, pass: boolean) => checks.push({ name, pass })

async function main() {
  // A plain question is not a refactor.
  ok('non-refactor input → null', (await planRefactor('what is the capital of France', {})) === null)

  // Move a self-contained function (named source + dest).
  const files = {
    'src/strings.ts': "export function pad(s: string, w: number) { return ' '.repeat(w) + s }\nexport function trim(s: string){ return s.trim() }\n",
    'src/app.ts': "import { pad } from './strings'\nexport const b = pad('x', 3)\n",
  }
  const mv = await planRefactor('move pad from src/strings.ts to src/pad.ts', files)
  ok('move → terminal, writes dest+source+importer, verify passes',
    !!mv && mv.kind === 'move' && mv.terminal && mv.verify?.passed === true
    && mv.writes.some(w => w.rel === 'src/pad.ts') && mv.writes.some(w => w.rel === 'src/app.ts'))

  // Source-less move infers the source and narrates it.
  const mvInfer = await planRefactor('move pad to src/pad.ts', files)
  ok('source-less move infers the source (thought) and plans it',
    !!mvInfer && mvInfer.kind === 'move' && mvInfer.terminal && mvInfer.thoughts.some(t => /defined uniquely/.test(t)))

  // Rename infers the file when unnamed.
  const rn = await planRefactor('rename pad to padLeft', files)
  ok('path-less rename infers the file, rewrites def+importer',
    !!rn && rn.kind === 'rename' && rn.terminal && rn.verify?.passed === true
    && rn.writes.some(w => w.rel === 'src/strings.ts' && w.content.includes('padLeft')))

  // Delete of a USED symbol → honest refusal (terminal, verify fails, no writes).
  const delUsed = await planRefactor('remove pad from src/strings.ts', files)
  ok('delete of a used symbol → refusal (terminal, no writes, verify fails)',
    !!delUsed && delUsed.kind === 'delete' && delUsed.terminal && delUsed.writes.length === 0
    && delUsed.verify?.passed === false && (delUsed.meta as any).refused === true)

  // Delete of a genuinely dead symbol → applied.
  const deadFiles = { 'src/a.ts': "export function keep(x:number){return x}\nexport function dead(y:number){return y}\n" }
  const delDead = await planRefactor('remove dead from src/a.ts', deadFiles)
  ok('delete of a dead symbol → applied write that drops it',
    !!delDead && delDead.terminal && delDead.writes.some(w => w.rel === 'src/a.ts' && !w.content.includes('dead')))

  // Move a whole file → writes new + delete old + repoint importer.
  const mvf = await planRefactor('move src/strings.ts to src/lib/strings.ts', files)
  ok('move-file → create dest, delete old (mode delete), repoint importer',
    !!mvf && mvf.kind === 'move-file' && mvf.terminal
    && mvf.writes.some(w => w.rel === 'src/strings.ts' && w.mode === 'delete')
    && mvf.writes.some(w => w.rel === 'src/lib/strings.ts' && w.mode === 'create')
    && mvf.writes.some(w => w.rel === 'src/app.ts'))

  // Single-file prune.
  const pr = await planRefactor('remove unused imports from src/one.ts',
    { 'src/one.ts': "import { used, dead } from './x'\nexport const y = used(1)\n" })
  ok('single-file prune → drops the unused specifier',
    !!pr && pr.kind === 'prune' && pr.terminal && pr.writes[0]?.content.includes('import { used }') && !pr.writes[0]!.content.includes('dead'))

  // Project-wide prune sweeps every file.
  const prAll = await planRefactor('remove all unused imports', {
    'src/one.ts': "import { used, dead } from './x'\nexport const y = used(1)\n",
    'src/two.ts': "import lodash from 'lodash'\nexport const z = 2\n",
    'src/clean.ts': "export const c = 1\n",
  })
  ok('project-wide prune → writes only the files that change',
    !!prAll && prAll.kind === 'prune-all' && prAll.terminal && prAll.writes.length === 2
    && !prAll.writes.some(w => w.rel === 'src/clean.ts'))

  // Parse-miss (symbol not defined anywhere) → fallthrough (non-terminal).
  const miss = await planRefactor('rename nonexistent to somethingElse', files)
  ok('rename of an undefined symbol → null (no unique definer to infer)', miss === null)

  const pass = checks.filter(c => c.pass).length
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} — ${c.name}`)
  console.log(`\n${pass}/${checks.length} passed`)
  if (pass !== checks.length) process.exit(1)
}

main()

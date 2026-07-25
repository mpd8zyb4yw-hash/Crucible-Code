// Bench for the write-time node-`assert` shim (assertShim.ts) — pure, no model, no network.
//
// Locks the repair that flipped tagSetModule RED→GREEN (offline harness, 2026-07-26): a generated
// module with correct logic failed to COMPILE solely because it self-tested via node's `assert`
// in a project with no @types/node. The shim must fix that case and, just as importantly, must
// NOT touch anything else — this file is the regression net for both directions.
//
// Run: npx tsx src/CrucibleEngine/synth/__assertShim_bench.ts
import { shimNodeAssert } from './assertShim'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log('== node-assert imports are replaced by the local shim (the measured tagSetModule RED) ==')
{
  // The EXACT shape the head emitted for tagSetModule.
  const real = `import { strict as assert } from 'assert';

export function unionTags(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])]
}

assert.deepEqual(unionTags([], []), []);
assert.deepEqual(unionTags(['t1'], ['t2']), ['t1', 't2']);
`
  const out = shimNodeAssert(real)
  check('the node import is gone', !/from\s+['"]assert['"]/.test(out), out.slice(0, 120))
  check('a local assert shim is injected', /const assert = \{/.test(out))
  check('the self-test assertions are PRESERVED verbatim', /assert\.deepEqual\(unionTags\(\[\], \[\]\), \[\]\);/.test(out))
  check('the implementation is preserved', /export function unionTags/.test(out))
  check('no node type dependency remains', !/require\(|node:assert/.test(out))
}

console.log('\n== every node-assert import spelling is handled ==')
for (const imp of [
  "import assert from 'assert'",
  "import { strict as assert } from 'assert';",
  'import assert from "node:assert";',
  "import { strict as assert } from 'node:assert/strict'",
  "const assert = require('assert');",
  "const { strict: assert } = require('node:assert')",
]) {
  const out = shimNodeAssert(`${imp}\nexport const f = () => 1\nassert.ok(f() === 1)\n`)
  check(`"${imp.slice(0, 44)}…" → shimmed`, /const assert = \{/.test(out) && !/require\(|from ['"](?:node:)?assert/.test(out), out.slice(0, 100))
}

console.log('\n== conservative: files with nothing to repair are returned UNCHANGED ==')
for (const [label, src] of [
  ['plain module, no assert at all', 'export function add(a: number, b: number) { return a + b }\n'],
  ['imports another module named in prose', "import { z } from './zod'\nexport const s = 'assert this'\n"],
  ['already uses its OWN assert helper', "function assert(c: boolean) { if (!c) throw new Error('x') }\nassert(true)\n"],
  ['empty file', ''],
] as Array<[string, string]>) {
  check(`${label} → unchanged`, shimNodeAssert(src) === src, 'file was modified when it should not have been')
}

console.log('\n== a file that declares its own assert is never shadowed ==')
{
  // Has BOTH a node import and its own declaration — injecting the shim would be a redeclaration
  // (a NEW compile error). Removing the import is safe; adding a second `assert` is not.
  const src = "import assert from 'assert'\nconst assert2 = 1\nfunction assert(c: boolean) {}\nassert.ok\n"
  const out = shimNodeAssert(src)
  check('no duplicate assert declaration injected', !/const assert = \{/.test(out))
}

console.log('\n== a DEAD assert import is simply dropped (no unused shim injected) ==')
{
  const src = "import assert from 'assert'\nexport const add = (a: number, b: number) => a + b\n"
  const out = shimNodeAssert(src)
  check('import removed', !/from ['"]assert['"]/.test(out))
  check('no unused shim added', !/const assert = \{/.test(out))
  check('implementation intact', /export const add/.test(out))
}

// The shimmed output must both COMPILE standalone (the whole point of the repair) and still
// behave like node's assert. Verify by writing the real shimmed TS to disk and running it under
// tsx — no hand-rolled type-stripping, so this tests exactly what gets written to a project.
async function behaviorProbe() {
  console.log('\n== the shimmed output compiles standalone AND assertions still throw ==')
  const fs = await import('fs')
  const os = await import('os')
  const path = await import('path')
  const { execFileSync } = await import('child_process')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-assertshim-'))
  const file = path.join(dir, 'probe.ts')
  // A module in the tagSetModule shape: node-assert self-test over correct logic.
  const shimmed = shimNodeAssert(
    "import { strict as assert } from 'assert';\n" +
    'export function unionTags(a: string[], b: string[]): string[] { return [...new Set([...a, ...b])] }\n' +
    "assert.deepEqual(unionTags(['t1'], ['t2']), ['t1', 't2']);\n",
  )
  // Append negative probes: a shim that silently passed everything would turn every generated
  // self-test into a no-op and hide real bugs, so prove failures still throw.
  const probe = shimmed + `
let deepThrew = false
try { assert.deepEqual([1, 2], [1, 3]) } catch { deepThrew = true }
let okThrew = false
try { assert.ok(false) } catch { okThrew = true }
let throwsCaught = false
try { assert.throws(() => 1) } catch { throwsCaught = true }
if (!deepThrew) throw new Error('FAILING deepEqual did NOT throw')
if (!okThrew) throw new Error('FAILING ok did NOT throw')
if (!throwsCaught) throw new Error('assert.throws did NOT flag a non-throwing fn')
console.log('BEHAVIOR_OK')
`
  fs.writeFileSync(file, probe, 'utf-8')
  try {
    const out = execFileSync('npx', ['tsx', file], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    check('shimmed module runs; passing assertions pass and failing ones throw', /BEHAVIOR_OK/.test(out), out.slice(0, 300))
  } catch (e: any) {
    check('shimmed module runs; passing assertions pass and failing ones throw', false, String(e?.stderr ?? e?.message ?? e).slice(0, 400))
  }
  // Typecheck it in isolation with NO @types/node — the exact condition that produced the RED.
  try {
    // Run from the temp dir (which has no tsconfig and no @types/node) so this reproduces a bare
    // bench project exactly; the repo's own tsconfig must not leak in and mask the failure.
    const tsc = path.join(process.cwd(), 'node_modules', '.bin', 'tsc')
    execFileSync(tsc, ['--noEmit', '--strict', '--target', 'es2020', '--moduleResolution', 'bundler', '--module', 'esnext', 'probe.ts'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], cwd: dir })
    check('shimmed module typechecks with NO @types/node (the RED condition)', true)
  } catch (e: any) {
    check('shimmed module typechecks with NO @types/node (the RED condition)', false, String(e?.stdout ?? e?.message ?? e).slice(0, 400))
  }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

behaviorProbe().then(() => {
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
})

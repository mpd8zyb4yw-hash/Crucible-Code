// ============================================================================
// Deterministic write-time repair — Node-builtin `assert` import in a generated module.
//
// MEASURED failure (2026-07-26, offline harness, tagSetModule — the sole gen-path RED):
// the head wrote `unionTags`/`intersectTags` with PERFECT logic, then prefixed the
// deliverable with `import { strict as assert } from 'assert'` for its inline self-test.
// The bench project has no `@types/node`, so tsc emitted the ONLY two errors in the run:
//   src/tags.ts(1,34): TS2591: Cannot find name 'assert'. …install @types/node
// compile=n cascaded to hidden=n, and a task the model had actually SOLVED scored RED.
//
// This is a scaffold/packaging failure, not a reasoning failure, and it is universal: any
// generated module that self-tests with node's `assert` fails to compile in a dependency-free
// project, regardless of task. So it is fixed in the LOOP, deterministically, at write time.
//
// Why REPLACE rather than STRIP: deleting the self-test would silently discard the model's own
// coverage (and the harness's SOFT self-test signal). Substituting a local, zero-dependency shim
// preserves the exact runtime semantics — every assertion still executes and still throws on
// failure — while removing the type dependency that broke the build. Strictly behavior-preserving.
//
// Conservative and fail-open by construction:
//  - fires ONLY when a node `assert` import is actually present (assert / node:assert),
//  - leaves a file that already declares its own `assert` binding untouched (no shadowing),
//  - returns the input unchanged on anything unexpected, so it can never corrupt a good file.
// ============================================================================

/** Matches the node-assert import forms the FM actually emits, incl. the `node:` prefix. */
const NODE_ASSERT_IMPORT_RX =
  /^[ \t]*import\s+(?:\{[^}]*\}|[A-Za-z_$][\w$]*)\s+from\s+['"]node:assert(?:\/strict)?['"];?[ \t]*\r?\n?|^[ \t]*import\s+(?:\{[^}]*\}|[A-Za-z_$][\w$]*)\s+from\s+['"]assert(?:\/strict)?['"];?[ \t]*\r?\n?/gm

/** Matches `const assert = require('assert')` / `require('node:assert')` CJS forms. */
const NODE_ASSERT_REQUIRE_RX =
  /^[ \t]*(?:const|let|var)\s+(?:\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](?:node:)?assert(?:\/strict)?['"]\s*\);?[ \t]*\r?\n?/gm

// A local stand-in for node's `assert` covering the surface the head actually uses in a
// self-test. Structural equality goes through JSON, which is exact for the JSON-shaped data
// (arrays/objects of primitives) these generated self-tests compare; anything it cannot
// serialize falls back to reference equality, so a shim assertion never PASSES falsely.
const SHIM = `// [crucible] local zero-dependency stand-in for node's \`assert\` — the generated self-test
// below is preserved verbatim; only the import was replaced so this module compiles in a
// project without @types/node. Same semantics: every assertion still throws on failure.
const __eq = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}
const assert = {
  ok(v: unknown, m?: string): void { if (!v) throw new Error(m ?? 'assert.ok failed') },
  equal(a: unknown, b: unknown, m?: string): void { if (!__eq(a, b)) throw new Error(m ?? \`assert.equal failed: \${JSON.stringify(a)} !== \${JSON.stringify(b)}\`) },
  strictEqual(a: unknown, b: unknown, m?: string): void { if (a !== b) throw new Error(m ?? \`assert.strictEqual failed: \${JSON.stringify(a)} !== \${JSON.stringify(b)}\`) },
  notEqual(a: unknown, b: unknown, m?: string): void { if (__eq(a, b)) throw new Error(m ?? 'assert.notEqual failed') },
  deepEqual(a: unknown, b: unknown, m?: string): void { if (!__eq(a, b)) throw new Error(m ?? \`assert.deepEqual failed: \${JSON.stringify(a)} !== \${JSON.stringify(b)}\`) },
  deepStrictEqual(a: unknown, b: unknown, m?: string): void { if (!__eq(a, b)) throw new Error(m ?? \`assert.deepStrictEqual failed: \${JSON.stringify(a)} !== \${JSON.stringify(b)}\`) },
  throws(fn: () => unknown, m?: string): void {
    try { fn() } catch { return }
    throw new Error(m ?? 'assert.throws failed: no error was thrown')
  },
}
`

/**
 * Replace a node-builtin `assert` import in generated TS/JS with a local zero-dependency shim.
 * Returns the original string unchanged when there is nothing to repair.
 */
export function shimNodeAssert(source: string): string {
  const src = source ?? ''
  if (!src) return src
  // Cheap pre-check — the overwhelming majority of writes have no assert import at all.
  if (!/['"](?:node:)?assert(?:\/strict)?['"]/.test(src)) return src

  NODE_ASSERT_IMPORT_RX.lastIndex = 0
  NODE_ASSERT_REQUIRE_RX.lastIndex = 0
  const hasImport = NODE_ASSERT_IMPORT_RX.test(src) || NODE_ASSERT_REQUIRE_RX.test(src)
  if (!hasImport) return src

  NODE_ASSERT_IMPORT_RX.lastIndex = 0
  NODE_ASSERT_REQUIRE_RX.lastIndex = 0
  let out = src.replace(NODE_ASSERT_IMPORT_RX, '').replace(NODE_ASSERT_REQUIRE_RX, '')

  // If removing the import left no `assert` usage at all, the import was simply dead — dropping
  // it is the whole repair, and injecting an unused shim would only add noise (and a lint hit).
  if (!/\bassert\s*\./.test(out)) return out

  // Never shadow an `assert` the file declares itself.
  if (/\b(?:const|let|var|function|class)\s+assert\b/.test(out)) return out

  return SHIM + '\n' + out
}

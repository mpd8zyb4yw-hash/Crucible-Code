// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE HYGIENE — a raw control byte in source silently disables `grep`
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS (2026-07-27). `solve.ts` used a raw NUL byte as a delimiter inside a template
// literal (`rungSpecKey`). A single 0x00 makes `file(1)` classify the whole file as `data`, and
// GNU/BSD `grep` then treats it as BINARY and prints NOTHING — no match, no warning, exit 1.
//
// That matters here more than in most repos, because CLAUDE.md's non-negotiable is:
//
//     "Verify, never guess — confirm a feature is actually wired in (GREP FOR CALLERS)
//      before marking it done or assuming it's missing."
//
// So one stray byte turns the project's own verification idiom into a silent false-negative
// machine. It cost a session two confidently WRONG conclusions in a row — that `traceCarve.ts`
// was never wired into the product path (it is, solve.ts:23 and :803) and that the
// `CRUCIBLE_CARVE_PROBE` kill switch didn't exist (it does, solve.ts:797). Both "findings" were
// grep returning empty on a file it had decided was binary.
//
// The fix is not "remember to pass grep -a". It is: never let the byte into the file. A delimiter
// written as the ESCAPE `'\x00'` produces a byte-identical string at runtime while leaving the
// SOURCE plain text — same semantics, greppable file. This bench enforces that mechanically.
//
// Doctrine framing: this is the loop applied to the repo itself. "Correct" is formalized as a
// deterministic, executable check rather than a rule someone has to remember.
//
// Run: npm run hygiene:bench
// ═══════════════════════════════════════════════════════════════════════════════

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/** Bytes that are legal in a text source file: tab, LF, CR. Everything below 0x20 plus DEL is not. */
function isForbiddenByte(b: number): boolean {
  if (b === 0x09 || b === 0x0a || b === 0x0d) return false
  return b < 0x20 || b === 0x7f
}

export interface ControlByteHit {
  file: string
  line: number
  byte: number
}

/** Every raw control byte in `file`, with the 1-indexed line it sits on. Pure over the buffer. */
export function scanForControlBytes(file: string, buf: Buffer): ControlByteHit[] {
  const hits: ControlByteHit[] = []
  let line = 1
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (b === 0x0a) { line++; continue }
    if (isForbiddenByte(b)) hits.push({ file, line, byte: b })
  }
  return hits
}

/** Recursively collect .ts/.tsx files under `dir`, skipping dependency and build trees. */
export function collectSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build') continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) collectSources(p, out)
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(p)
  }
  return out
}

/**
 * Every TRACKED .ts/.tsx in the repo — asked of git rather than walked from `src/`.
 *
 * FOUND 2026-07-28: the walk started at `<root>/src`, so every root-level file was invisible to a
 * gate whose own headline claims to cover "tracked TypeScript". `server.ts` — the largest file in
 * the repo — was never scanned, and it was carrying a raw NUL at the time this was written. The
 * bench reported "1080 file(s) scanned, zero raw control bytes" while the defect sat one directory
 * above where it was looking. A gate that is blind to a whole directory level is worse than none,
 * because its green tick is read as proof.
 *
 * `git ls-files` is also the correct authority on the word "tracked": a walk counts build output
 * and untracked scratch files, which is how a scanner starts reporting failures nobody can fix.
 */
function trackedSources(root: string): string[] {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '*.ts', '*.tsx'], { encoding: 'buffer' })
  return String(out)
    .split('\0')
    .filter(Boolean)
    .map(f => join(root, f))
    .filter(p => { try { return statSync(p).isFile() } catch { return false } })
}

function main(): void {
  const root = new URL('../../..', import.meta.url).pathname

  console.log('\n── source hygiene: no raw control bytes in tracked TypeScript ──\n')

  const files = trackedSources(root)
  const hits: ControlByteHit[] = []
  for (const f of files) hits.push(...scanForControlBytes(f, readFileSync(f)))

  let passed = 0
  let failed = 0

  // 1) The property itself, across the whole tree.
  if (hits.length === 0) {
    console.log(`  ✓ ${files.length} file(s) scanned, zero raw control bytes`)
    passed++
  } else {
    failed++
    console.log(`  ✗ ${hits.length} raw control byte(s) found — these files are BINARY to grep:\n`)
    for (const h of hits) {
      const rel = h.file.startsWith(root) ? h.file.slice(root.length) : h.file
      console.log(`      ${rel}:${h.line}  byte 0x${h.byte.toString(16).padStart(2, '0')}`)
    }
    console.log(`\n    FIX: write the byte as an ESCAPE, not a literal. In a string or template`)
    console.log(`    literal, '\\x00' is the same character at runtime but leaves the source as`)
    console.log(`    plain text, so grep keeps working. See the header of this file.`)
  }

  // 2) Regression pins for the two sites that actually had this, so a revert is caught by name
  //    rather than only by the tree-wide count.
  for (const [rel, what] of [
    ['src/CrucibleEngine/reasoning/solve.ts', 'rungSpecKey delimiter'],
    ['src/CrucibleEngine/reasoning/multiFile.ts', 'fingerprintFiles join separator'],
  ] as const) {
    const p = join(root, rel)
    const n = scanForControlBytes(p, readFileSync(p)).length
    if (n === 0) { console.log(`  ✓ ${rel} clean (${what})`); passed++ }
    else { console.log(`  ✗ ${rel} reintroduced ${n} raw control byte(s) (${what})`); failed++ }
  }

  // 3) The scanner must actually detect the thing (a check that always passes is worthless).
  const synthetic = scanForControlBytes('<synthetic>', Buffer.from('ok\nbad\x00here\nfine\n', 'binary'))
  if (synthetic.length === 1 && synthetic[0].line === 2 && synthetic[0].byte === 0) {
    console.log('  ✓ scanner detects an injected NUL on the correct line')
    passed++
  } else {
    console.log(`  ✗ scanner failed its own positive control: ${JSON.stringify(synthetic)}`)
    failed++
  }

  // 4) Tab/LF/CR must NOT trip it, or every file in the repo fails.
  const benign = scanForControlBytes('<synthetic>', Buffer.from('a\tb\r\nc\n', 'binary'))
  if (benign.length === 0) { console.log('  ✓ tab/CR/LF are not flagged'); passed++ }
  else { console.log(`  ✗ benign whitespace flagged: ${JSON.stringify(benign)}`); failed++ }

  console.log(`\n${failed === 0 ? '✅' : '❌'} source hygiene: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

main()

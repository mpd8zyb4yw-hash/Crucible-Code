// Execution-driven verification — runs the project's real check (test/compile/run)
// and turns failures into structured hints via error-intelligence.
// Anti-thrash: a per-session failure-fingerprint set; the same error signature
// twice → escalate (stop healing, report honestly) instead of burning iterations.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { registry } from '../tools/registry'
import { parseError } from '../error-intelligence'
import { harvestExplicitExamples } from '../reasoning/specExtractor'
import { verifyMultiFileCode, type CandidateFile } from '../reasoning/codeVerifier'
import type { ExecutionResult, ErrorType, Language } from '../sandbox'
import type { ToolCtx } from '../tools/protocol'
import type { VerifyResult } from './loop'
import { runtimeVerifyHtml, runtimeVerifyApp } from './htmlRuntimeVerify'
import { classifyHtmlGoal } from './htmlGoalKind'

/**
 * The project's own entry HTML document, if it has one. Prefers index.html, then the shallowest
 * / largest candidate — a build with one page has exactly one answer, and a build with several
 * has an index. Returns null for anything that isn't a full document (fragments/partials have
 * no runtime of their own).
 */
function findHtmlDocument(root: string): { file: string; html: string } | null {
  // Its own walk: collectSourceFiles is scoped to JS/TS for the example gate, and widening it
  // would feed HTML into a bundler that cannot run it.
  const found: { file: string; html: string; depth: number }[] = []
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.crucible', 'out', 'coverage', '.next', '__derived__'])
  const walk = (dir: string, depth: number) => {
    if (found.length >= 20 || depth > 6) return
    let ents: fs.Dirent[]
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) walk(abs, depth + 1)
      else if (/\.html?$/i.test(e.name)) {
        try { found.push({ file: abs, html: fs.readFileSync(abs, 'utf-8'), depth }) } catch { /* skip */ }
      }
    }
  }
  walk(root, 0)
  const docs = found.filter(d => /<html[\s>]|<body[\s>]/i.test(d.html))
  if (!docs.length) return null
  const index = docs.find(d => /(^|[\\/])index\.html?$/i.test(d.file))
  if (index) return index
  docs.sort((a, b) => a.depth - b.depth || b.html.length - a.html.length)
  return docs[0]
}

export interface Verifier {
  verify: (finalText: string, ctx: ToolCtx) => Promise<VerifyResult & { escalate?: boolean }>
  healAttempts: () => number
}

const MAX_HEAL_ATTEMPTS = 5

/** Gather the project's source files (bounded) as {path, source} for the example gate. */
function collectSourceFiles(root: string, cap = 60): CandidateFile[] {
  const out: CandidateFile[] = []
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.crucible', 'out', 'coverage', '.next', '__derived__'])
  const walk = (dir: string) => {
    if (out.length >= cap) return
    let ents: fs.Dirent[]
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (out.length >= cap) return
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
        try { out.push({ path: path.relative(root, abs), source: fs.readFileSync(abs, 'utf-8') }) } catch { /* skip */ }
      }
    }
  }
  walk(root)
  return out
}

/**
 * Behavioral gate for projects with NO runnable check (a fresh generated tree has no test
 * script). When the request states worked examples ("add(2,3) returns 5"), execute them against
 * the files the agent actually wrote — bundling the import graph via verifyMultiFileCode — instead
 * of shipping an honest-but-blind `unverified`. Returns null when the request has no examples to
 * check (→ caller keeps the unverified path) or the project has no source to run.
 */
async function exampleGate(goal: string, projectPath: string): Promise<VerifyResult | null> {
  if (!goal.trim()) return null
  const h = harvestExplicitExamples(goal)
  if (!h.cases.length) return null
  const files = collectSourceFiles(projectPath)
  if (!files.length) return null
  const verdict = await verifyMultiFileCode(files, { entry: h.entry, entries: h.entries, cases: h.cases } as any)
  if (verdict.pass) {
    return { passed: true, signal: 'test', report: `Behavioral gate: ${h.cases.length} stated example(s) executed against the written files — ${verdict.signals.join('; ')}` }
  }
  return { passed: false, signal: 'test', report: `Stated examples do not hold against the written code:\n- ${verdict.signals.join('\n- ')}`, hints: verdict.signals.slice(0, 6) }
}

export function makeVerifier(opts: { command?: string; goal?: string } = {}): Verifier {
  const fingerprints = new Set<string>()
  let attempts = 0
  let runSeq = 0

  return {
    healAttempts: () => attempts,
    async verify(_finalText, ctx) {
      const plan = opts.command
        ? { command: opts.command, signal: 'test' as const }
        : detectCheck(ctx.projectPath)
      const staticPlan = detectStaticAnalysis(ctx.projectPath)
      if (staticPlan && staticPlan.command !== plan?.command) {
        const lint = await registry.exec(
          { id: `verify_lint_${runSeq++}`, name: 'run', args: { command: staticPlan.command, timeoutMs: 90_000 } },
          { ...ctx, allowMutation: true },
        )
        if (!lint.ok) {
          attempts++
          const fp = fingerprint(lint.output)
          const escalate = fingerprints.has(fp) || attempts >= MAX_HEAL_ATTEMPTS
          fingerprints.add(fp)
          return {
            passed: false,
            signal: 'lint',
            report: `$ ${staticPlan.command}\n${lint.output}`,
            hints: extractHints(lint.output, ctx.projectPath),
            escalate,
          }
        }
        if (!plan) return { passed: true, signal: 'lint', report: lint.output.slice(0, 2000) }
      }
      if (!plan) {
        // No project check exists — but if the request stated worked examples, execute them
        // against the written files rather than shipping blind. A failure heals like any other.
        const gate = opts.goal ? await exampleGate(opts.goal, ctx.projectPath) : null
        if (gate) {
          if (!gate.passed) {
            attempts++
            const fp = fingerprint(gate.report)
            const escalate = fingerprints.has(fp) || attempts >= MAX_HEAL_ATTEMPTS
            fingerprints.add(fp)
            return { ...gate, escalate }
          }
          return gate
        }
        // Still nothing to run — but a single-page HTML build IS runnable, and the behavioral
        // gate that drives it already exists (runtimeVerifyApp/Html). It was only ever reachable
        // from the synth route, so the same prompt shipped verified or blind depending on which
        // route happened to build it: the cont.97 suite shipped 6/6 broken web apps through here,
        // every one via "No runnable check detected". Whoever wrote the file, the artifact gets
        // judged.
        const doc = findHtmlDocument(ctx.projectPath)
        if (doc) {
          const kind = classifyHtmlGoal(opts.goal ?? '')
          const problem = kind === 'game'
            ? await runtimeVerifyHtml(doc.html, opts.goal ?? '')
            : await runtimeVerifyApp(doc.html, opts.goal ?? '')
          if (problem) {
            attempts++
            const fp = fingerprint(problem)
            const escalate = fingerprints.has(fp) || attempts >= MAX_HEAL_ATTEMPTS
            fingerprints.add(fp)
            return {
              passed: false, signal: 'test', escalate,
              report: `Behavioral gate drove ${path.relative(ctx.projectPath, doc.file)} in a real browser and it failed: ${problem}`,
              hints: [problem],
            }
          }
          return { passed: true, signal: 'test', report: `Behavioral gate drove ${path.relative(ctx.projectPath, doc.file)} in a real browser — loads clean and its controls change the page.` }
        }
        return { passed: true, signal: 'none', report: 'No runnable check detected.', unverified: true }
      }

      // For TS projects, ALSO typecheck FIRST — with a generated LENIENT config (the exact
      // options the coding audit uses), NOT the agent's own (often strict tsc --init) one.
      // This catches type-unsound branches the run/test never executes (the gap that let
      // bad code reach the external audit) WITHOUT the strict-config-fighting spiral that
      // made us drop typechecking before. Run it as a SEPARATE step so we can tell a REAL
      // type error from missing-@types infra noise (e.g. `fs` unresolved because the
      // project never `npm install`ed @types/node) — the latter must never wedge correct
      // code, so we skip it and fall through to actually running the code.
      const isTs = fs.existsSync(path.join(ctx.projectPath, 'tsconfig.json')) && !/tsc\s+--noEmit/.test(plan.command)
      if (isTs) {
        const cfg = writeLenientTsconfig(ctx.projectPath)
        if (cfg) {
          const tc = await registry.exec(
            { id: `verify_tc_${runSeq++}`, name: 'run', args: { command: `npx tsc --noEmit -p ${JSON.stringify(cfg)}`, timeoutMs: 90_000 } },
            { ...ctx, allowMutation: true },
          )
          if (!tc.ok && hasRealTypeError(tc.output)) {
            attempts++
            const fp = fingerprint(tc.output)
            const escalate = fingerprints.has(fp) || attempts >= MAX_HEAL_ATTEMPTS
            fingerprints.add(fp)
            return {
              passed: false, signal: 'compile',
              report: `$ npx tsc --noEmit\n${tc.output}`,
              hints: extractHints(tc.output, ctx.projectPath),
              escalate,
            }
          }
        }
      }

      const command = plan.command
      const result = await registry.exec(
        { id: `verify_${runSeq++}`, name: 'run', args: { command, timeoutMs: 90_000 } },
        { ...ctx, allowMutation: true },
      )
      if (result.ok) return { passed: true, signal: plan.signal, report: result.output.slice(0, 2000) }

      attempts++
      const stderr = result.output
      const hints = extractHints(stderr, ctx.projectPath)
      const fp = fingerprint(stderr)
      const repeated = fingerprints.has(fp)
      fingerprints.add(fp)
      const escalate = repeated || attempts >= MAX_HEAL_ATTEMPTS
      return {
        passed: false,
        signal: plan.signal,
        report: `$ ${command}\n${stderr}`,
        hints,
        escalate,
      }
    },
  }
}

/**
 * Write a LENIENT tsconfig (the same options the coding audit proves work on every task —
 * strict off so correct code isn't failed on implicit-any pedantry, but real type errors
 * are still caught) under .crucible/ and return its path. typeRoots/types pin @types/node
 * from THIS project's node_modules so `fs`/`path` resolve. Returns null on any write error
 * (so verification falls back to running the code rather than wedging). Lives outside the
 * project's own tsconfig graph, so the agent's strict config is never touched.
 */
function writeLenientTsconfig(projectPath: string): string | null {
  try {
    const dir = path.join(projectPath, '.crucible')
    fs.mkdirSync(dir, { recursive: true })
    const cfgPath = path.join(dir, 'verify-tsconfig.json')
    const typeRoots = [path.join(projectPath, 'node_modules', '@types')]
    fs.writeFileSync(cfgPath, JSON.stringify({
      compilerOptions: {
        noEmit: true, skipLibCheck: true, esModuleInterop: true, module: 'commonjs',
        target: 'es2020', moduleResolution: 'node10', ignoreDeprecations: '6.0',
        strict: false, noImplicitAny: false, typeRoots, types: ['node'],
      },
      include: [path.join(projectPath, 'src', '**', '*.ts'), path.join(projectPath, '*.ts')],
    }, null, 2))
    return cfgPath
  } catch { return null }
}

/**
 * True if the tsc output contains a GENUINE type error — i.e. at least one `error TS…`
 * line that is NOT merely missing @types/node or unresolved node globals (which mean the
 * project didn't `npm install @types/node`, an infra issue, not a code bug). We must not
 * fail correct code on infra; a real type mismatch (TS2322/TS2345/TS2339/…) still blocks.
 */
function hasRealTypeError(output: string): boolean {
  const errorLines = output.split('\n').filter(l => /error TS\d+/.test(l))
  if (!errorLines.length) return false
  // Lines attributable purely to a missing @types/node install / node globals.
  const NODE_BUILTINS = `fs|path|os|crypto|util|events|stream|http|https|net|child_process|url|zlib|buffer|process|assert|readline|tty|module`
  const infra = new RegExp(
    `error TS2688|` +                                                  // cannot find type definition file ('node')
    `error TS2307: Cannot find module '(?:node:)?(?:${NODE_BUILTINS})'|` + // unresolved node builtin
    `error TS2580|error TS2591|` +                                     // 'require'/'module'/'process' need @types/node
    `error TS2304: Cannot find name '(?:require|module|process|Buffer|__dirname|__filename|global|console|exports)'`,
  )
  return errorLines.some(l => !infra.test(l))
}

/** Figure out how to check this project: test cmd? compile? just run the entry? */
export function detectCheck(projectPath: string): { command: string; signal: VerifyResult['signal'] } | null {
  const pkgPath = path.join(projectPath, 'package.json')
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
      const hasTsconfig = fs.existsSync(path.join(projectPath, 'tsconfig.json'))
      // Verify by RUNNING the code (tests/entry) — the strongest signal. We deliberately do
      // NOT chain `tsc --noEmit` here: with the agent's own (often strict, tsc --init) config
      // it sends the model into a tsconfig-fighting spiral that burns its iteration budget on
      // free models. Type-cleanliness is enforced independently at audit time (the coding
      // harness compiles the produced module under lenient settings). tsx surfaces real
      // load-time errors anyway.
      const test = pkg.scripts?.test
      if (test && !/no test specified/i.test(test)) return { command: 'npm test --silent', signal: 'test' }
      if (hasTsconfig) {
        // Find entry point — prefer src/index.ts, src/main.ts, or any single ts file in src/
        const srcDir = path.join(projectPath, 'src')
        let entry: string | null = null
        for (const candidate of ['index.ts', 'main.ts', 'testHarness.ts', 'app.ts']) {
          if (fs.existsSync(path.join(srcDir, candidate))) { entry = `src/${candidate}`; break }
          if (fs.existsSync(path.join(projectPath, candidate))) { entry = candidate; break }
        }
        if (entry) return { command: `npx tsx ${entry}`, signal: 'runtime' }
        return { command: 'npx tsc --noEmit', signal: 'compile' }
      }
    } catch { /* fall through */ }
  }
  let entries: string[] = []
  try { entries = fs.readdirSync(projectPath) } catch { return null }
  // -B: skip __pycache__ — sub-second same-size edits otherwise run stale bytecode.
  const pyTests = entries.filter(f => /^test_.*\.py$|_test\.py$/.test(f))
  if (pyTests.length) return { command: pyTests.map(f => `python3 -B ${f}`).join(' && '), signal: 'test' }
  if (entries.includes('pytest.ini') || entries.includes('conftest.py')) return { command: 'python3 -B -m pytest -q -p no:cacheprovider', signal: 'test' }
  const pyFiles = entries.filter(f => f.endsWith('.py'))
  if (pyFiles.length === 1) return { command: `python3 -B ${pyFiles[0]}`, signal: 'runtime' }
  const jsFiles = entries.filter(f => /\.(mjs|cjs|js)$/.test(f))
  if (jsFiles.length === 1) return { command: `node ${jsFiles[0]}`, signal: 'runtime' }
  return null
}

/**
 * Workstream 1 critic: when a project already defines static analysis, make it a
 * real verification gate instead of advisory output. This deliberately adds no
 * dependency and does not invent a linter for projects that have not chosen one.
 */
export function detectStaticAnalysis(projectPath: string): { command: string; signal: 'lint' } | null {
  const pkgPath = path.join(projectPath, 'package.json')
  if (!fs.existsSync(pkgPath)) return null
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    const lint = pkg.scripts?.lint
    if (typeof lint === 'string' && lint.trim() && !/no lint specified/i.test(lint)) {
      return { command: 'npm run lint --silent', signal: 'lint' }
    }
  } catch { /* ignore malformed package.json */ }
  return null
}

/** Stable signature of an error: type + symbol + first error line, not addresses/paths. */
export function fingerprint(stderr: string): string {
  const sig = stderr
    .split('\n')
    .filter(l => /error|Error|FAILED|assert|Exception|Traceback/i.test(l))
    .slice(0, 3)
    .join('|')
    .replace(/0x[0-9a-f]+/gi, '')
    .replace(/[/\\][\w./\\-]+/g, '')   // strip paths
    .replace(/\d+/g, 'N')              // strip line numbers / counts
  return crypto.createHash('sha1').update(sig || stderr.slice(0, 200)).digest('hex').slice(0, 12)
}

/** Run stderr through error-intelligence to produce actionable hints. */
export function extractHints(stderr: string, _projectPath: string): string[] {
  const synth: ExecutionResult = {
    success: false,
    output: '',
    error: stderr.slice(0, 4000),
    errorType: classifyStderr(stderr),
    errorLine: extractLine(stderr),
    errorColumn: null,
    executionMs: 0,
    language: guessLanguage(stderr),
  }
  const parsed = parseError(synth, '')
  const hints: string[] = []
  hints.push(`Error type: ${parsed.type}${parsed.symbol ? ` (symbol: ${parsed.symbol})` : ''}${parsed.line ? ` at line ${parsed.line}` : ''}`)
  if (parsed.fixStrategy && parsed.fixStrategy !== 'none') hints.push(`Suggested fix strategy: ${parsed.fixStrategy}`)
  if (parsed.type === 'IMPORT' && parsed.symbol) hints.push(`Missing module '${parsed.symbol}' — install it or remove the dependency.`)
  if (/AssertionError|FAILED/.test(stderr)) hints.push('A test assertion failed — read the expected vs actual values in the report and fix the logic, not the test.')
  return hints
}

function classifyStderr(stderr: string): ErrorType {
  if (/SyntaxError|IndentationError|Unexpected token|Unexpected end of input/.test(stderr)) return 'SYNTAX'
  if (/NameError|is not defined|ReferenceError/.test(stderr)) return 'REFERENCE'
  if (/ModuleNotFoundError|ImportError|Cannot find module/.test(stderr)) return 'IMPORT'
  if (/TypeError/.test(stderr)) return 'TYPE'
  if (/AssertionError|FAILED/.test(stderr)) return 'LOGIC'
  if (/timeout|timed out|killed/.test(stderr)) return 'TIMEOUT'
  return 'RUNTIME'
}

function extractLine(stderr: string): number | null {
  const m = stderr.match(/line (\d+)/) ?? stderr.match(/:(\d+):\d+/)
  return m ? parseInt(m[1], 10) : null
}

function guessLanguage(stderr: string): Language {
  if (/Traceback|\.py\b/.test(stderr)) return 'python'
  if (/at .*\.ts:|\.ts\b/.test(stderr)) return 'typescript'
  return 'javascript'
}

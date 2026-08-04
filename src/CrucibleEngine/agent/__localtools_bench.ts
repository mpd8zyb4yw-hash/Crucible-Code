// Bench for the local-filesystem routing gate (cont.118).
//
// WHY (measured live, 2026-07-28, agent mode). Brief: "List the files in the directory
// src/CrucibleEngine/answer and tell me what is there." Result: **0 tool calls**, and this,
// stamped `✓ verified`:
//
//     1. `answer.py`  — the main script that runs the engine
//     2. `answer.pyi` — the type stub for answer.py
//     3. `answer.json`— the output of the engine
//
// The directory holds twenty-odd `.ts` files and not one of those. `detectAgentTask` is a list
// of BUILD and MUTATE verbs — create, write, build, run, delete, move — and "list" is not one,
// so a question about this machine was answered out of the weights. Same shape as cont.104's
// "inbox is empty" with zero tool calls.
//
// Both directions are pinned (`crucible-verifier-two-failure-directions`): a router that only
// gets tested on what it SHOULD catch is the router that hijacks "what is a hash map".
//
// Run: npx tsx src/CrucibleEngine/agent/__localtools_bench.ts

import { resolveImplicitLocalTools, resolveImplicitPersonalTools } from './namedToolRouter'
import { registry } from '../tools/registry'

let pass = 0, fail = 0
const failures: string[] = []
function check(label: string, ok: boolean, detail = '') {
  if (ok) { pass++; return }
  fail++
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

// ── 1. THE LIVE FAILURE, and its family ──────────────────────────────────────
console.log('\n== filesystem questions reach a tool ==')

const MUST_ROUTE: Array<[string, string]> = [
  // The exact brief that fabricated.
  ['List the files in the directory src/CrucibleEngine/answer and tell me what is there.', 'list_dir'],
  ['list the files in src/CrucibleEngine', 'list_dir'],
  ['what files are in ~/Desktop', 'list_dir'],
  // "what's in X" is genuinely ambiguous between a file and a directory, and nothing short of
  // touching the disk can resolve it. The router guesses list_dir (no extension, no explicit
  // file verb) and `list_dir` is tolerant of being handed a file — it returns the file as a
  // one-entry listing carrying its real "Read file" action, rather than throwing ENOTDIR.
  ['show me what is in ./build', 'list_dir'],
  ['what\'s in /etc/hosts', 'list_dir'],
  ['how many files are in src/CrucibleEngine/answer', 'list_dir'],
  ['contents of package.json', 'read_file'],
  ['read src/api.ts', 'read_file'],
  ['look in the directory src/chat', 'list_dir'],
  ['what files are in this folder', 'list_dir'],
  ['show me the contents of this directory', 'list_dir'],
  ['inspect src/CrucibleEngine/tools/entities.ts', 'read_file'],
]
for (const [msg, expectTool] of MUST_ROUTE) {
  const r = resolveImplicitLocalTools(msg)
  check(`"${msg.slice(0, 46)}…" routes`, !!r, 'NOT ROUTED — would be answered from the weights')
  if (r) {
    check(`  …to ${expectTool}`, r.calls[0]?.name === expectTool, `got ${r.calls[0]?.name}`)
    check('  …with a path argument', typeof r.calls[0]?.args?.path === 'string')
  }
}

// The path actually extracted matters — routing to list_dir on the wrong directory is its own
// species of wrong answer.
const listing = resolveImplicitLocalTools('List the files in the directory src/CrucibleEngine/answer and tell me what is there.')
check('extracts the stated path exactly',
  listing?.calls[0]?.args?.path === 'src/CrucibleEngine/answer',
  `got ${JSON.stringify(listing?.calls[0]?.args?.path)}`)
check('a bare folder ask defaults to the project root',
  resolveImplicitLocalTools('what files are in this folder')?.calls[0]?.args?.path === '.')

// ── 2. WHAT IT MUST NOT SWALLOW ──────────────────────────────────────────────
console.log('\n== ordinary asks are untouched ==')

const MUST_NOT_ROUTE = [
  // Conceptual questions — parametric memory is a legitimate source for these.
  'what is a hash map',
  'explain how photosynthesis works',
  'what is the capital of australia',
  'how do i reverse a linked list in python',
  // Creative / prose.
  'write me a poem about the sea',
  'list three ideas for dinner',
  'show me a joke',
  // Self questions — these belong to the self-model, not the filesystem.
  'are you made in china',
  'what can you do',
  // MUTATION — needs real planning and consent, never a bare-name fire.
  'create a file at src/foo.ts',
  'delete the files in ~/Downloads',
  'build me a snake game',
  'write a script to src/build.sh',
  'move the photos folder to the desktop',
  // Personal data — belongs to the personal-data twin.
  'show me my emails from last week',
  "what's on my calendar today",
  // A ratio/fraction is not a path.
  'what is 3/4 of 200',
  'the ratio is 16/9',
]
for (const msg of MUST_NOT_ROUTE) {
  const r = resolveImplicitLocalTools(msg)
  check(`"${msg.slice(0, 44)}" NOT routed`, r === null, `hijacked to ${r?.calls[0]?.name}`)
}

// ── 2b. ONE CALL CANNOT ANSWER A TWO-REFERENT QUESTION ───────────────────────
//
// MEASURED LIVE (2026-08-04, agent mode, `on-device (named tools)` driver). Brief:
// "Look at the files in ~/Desktop/agentprobe and tell me what is in notes.txt".
// This resolver fires exactly ONE call and the server ships that call's output as the
// answer — there is no loop behind it. `statedPath` takes the LONGEST path token, so
// `~/Desktop/agentprobe` beat `notes.txt`; "files in" set the listing intent; the run made
// one `list_dir` call and answered, in full:
//
//     notes.txt
//
// The file the user actually asked about was never opened. A shortcut that can only cover
// PART of the goal must decline the turn — fmReact carries list_dir AND read_file and can
// do both steps. Declining costs latency; answering the wrong question costs the answer.
console.log('\n== a shortcut that cannot cover the goal declines it ==')

const MULTI_REFERENT = [
  // The exact live brief.
  'Look at the files in ~/Desktop/agentprobe and tell me what is in notes.txt',
  'list the files in src/chat and read src/api.ts',
  'show me the contents of package.json and tsconfig.json',
  'read src/a.ts and src/b.ts',
]
for (const msg of MULTI_REFERENT) {
  const r = resolveImplicitLocalTools(msg)
  check(`"${msg.slice(0, 46)}…" declines (2+ referents)`, r === null,
    `took the turn with a single ${r?.calls[0]?.name}(${JSON.stringify(r?.calls[0]?.args?.path)}) — the rest of the goal is dropped`)
}

// The false-reject direction. Naming ONE referent more than once is still one referent, and
// a single call still answers it — over-declining here would push every ordinary filesystem
// question back onto the slow path for nothing.
const REPEATED_REFERENT: Array<[string, string]> = [
  ['read src/api.ts — what is in src/api.ts?', 'read_file'],
  ['what files are in ~/Desktop, list ~/Desktop for me', 'list_dir'],
]
for (const [msg, expectTool] of REPEATED_REFERENT) {
  const r = resolveImplicitLocalTools(msg)
  check(`"${msg.slice(0, 40)}…" still routes (one referent, named twice)`, !!r,
    'declined — the repeat was miscounted as a second referent')
  if (r) check(`  …to ${expectTool}`, r.calls[0]?.name === expectTool, `got ${r.calls[0]?.name}`)
}

// ── 3. THE TWO ROUTERS STAY DISJOINT ─────────────────────────────────────────
// The local router runs AFTER the personal one in server.ts, so an overlap would silently
// change which tool answers a mail question.
console.log('\n== local and personal routers do not collide ==')
for (const msg of ['show me my emails from last week', "what's on my calendar today", "what's on my plate"]) {
  const personal = resolveImplicitPersonalTools(msg)
  const local = resolveImplicitLocalTools(msg)
  check(`"${msg}" is personal-only`, personal !== null && local === null,
    `personal=${!!personal} local=${local?.calls[0]?.name}`)
}

// ── 4. SAFETY ────────────────────────────────────────────────────────────────
console.log('\n== the gate is read-only and names real tools ==')
const registered = new Set(registry.list().map(t => t.name))
for (const [msg] of MUST_ROUTE) {
  const r = resolveImplicitLocalTools(msg)
  if (!r) continue
  for (const c of r.calls) {
    check(`"${c.name}" exists in the registry`, registered.has(c.name))
    const def = registry.get(c.name)
    check(`"${c.name}" does not mutate`, def?.mutates !== true,
      'this gate fires without planning or consent — a mutating tool must never be reachable from it')
  }
}

// ── 5. TOTALITY ──────────────────────────────────────────────────────────────
console.log('\n== resolver is total ==')
for (const msg of ['', '   ', '/', '//', '~', '...', 'a'.repeat(5000), '日本語/テスト', '\n\n', 'src/']) {
  let ok = false, detail = ''
  try {
    const r = resolveImplicitLocalTools(msg)
    ok = r === null || (Array.isArray(r.calls) && r.calls.every(c => typeof c.name === 'string'))
    if (!ok) detail = JSON.stringify(r)
  } catch (e: any) { detail = `threw: ${e?.message}` }
  check(`resolves ${JSON.stringify(msg.slice(0, 16))}`, ok, detail)
}

// ── REPORT ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(62)}`)
console.log(`local-tools bench: ${pass}/${pass + fail} passed`)
if (failures.length) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log(`  ✗ ${f}`)
}
process.exit(fail === 0 ? 0 : 1)

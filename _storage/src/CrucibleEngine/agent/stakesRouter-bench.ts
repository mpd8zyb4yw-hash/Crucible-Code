// Characterization harness for the HITL stakes router (stakesRouter.ts). Pure + deterministic
// — no model, no filesystem. Run: npx tsx src/CrucibleEngine/agent/stakesRouter-bench.ts
import { assessStakes } from './stakesRouter'

interface Case {
  name: string
  tool: string
  args: Record<string, unknown>
  goal: string
  check: (r: ReturnType<typeof assessStakes>) => string | null // null = pass, string = failure reason
}

const CASES: Case[] = [
  {
    name: 'delete_folder with no explicit authorization in goal — high stakes, wide blast',
    tool: 'delete_folder', args: { path: '/Users/x/Desktop/old-project' },
    goal: 'organize my Desktop',
    check: (r) => {
      if (r.stakes !== 'high') return `expected high stakes, got ${r.stakes}`
      if (r.blastRadius !== 'wide') return `expected wide blast radius, got ${r.blastRadius}`
      if (!r.reason) return 'expected a plain-language reason'
      return null
    },
  },
  {
    name: 'delete_folder explicitly requested — low stakes (already authorized)',
    tool: 'delete_folder', args: { path: '/Users/x/Desktop/old-project' },
    goal: 'delete the old-project folder on my Desktop, I don\'t need it anymore',
    check: (r) => (r.stakes !== 'low' ? `expected low stakes (explicitly authorized), got ${r.stakes}` : null),
  },
  {
    name: 'delete_file with no mention of deleting anything — high stakes',
    tool: 'delete_file', args: { path: '/Users/x/Documents/report.docx' },
    goal: 'clean up my documents folder',
    check: (r) => {
      if (r.stakes !== 'high') return `expected high stakes, got ${r.stakes}`
      if (r.blastRadius !== 'narrow') return `expected narrow blast radius for a single file, got ${r.blastRadius}`
      return null
    },
  },
  {
    name: 'delete_file explicitly requested — low stakes',
    tool: 'delete_file', args: { path: '/Users/x/Documents/report.docx' },
    goal: 'delete report.docx from my Documents',
    check: (r) => (r.stakes !== 'low' ? `expected low stakes, got ${r.stakes}` : null),
  },
  {
    name: 'empty_trash never explicitly requested — high stakes',
    tool: 'empty_trash', args: {},
    goal: 'free up some disk space',
    check: (r) => (r.stakes !== 'high' ? `expected high stakes, got ${r.stakes}` : null),
  },
  {
    name: 'empty_trash explicitly requested — low stakes',
    tool: 'empty_trash', args: {},
    goal: 'empty the trash please',
    check: (r) => (r.stakes !== 'low' ? `expected low stakes, got ${r.stakes}` : null),
  },
  {
    name: 'run: rm -rf on an unrelated task — high stakes, wide blast',
    tool: 'run', args: { command: 'rm -rf /Users/x/Desktop/build' },
    goal: 'clean up the build output',
    check: (r) => {
      if (r.stakes !== 'high') return `expected high stakes, got ${r.stakes}`
      if (r.blastRadius !== 'wide') return `expected wide blast radius, got ${r.blastRadius}`
      return null
    },
  },
  {
    name: 'run: git push --force explicitly requested — low stakes',
    tool: 'run', args: { command: 'git push --force origin main' },
    goal: 'force-push my branch to origin main',
    check: (r) => (r.stakes !== 'low' ? `expected low stakes, got ${r.stakes}` : null),
  },
  {
    name: 'run: benign command — low stakes regardless of goal',
    tool: 'run', args: { command: 'npm test' },
    goal: 'run the test suite',
    check: (r) => (r.stakes !== 'low' ? `expected low stakes for a non-destructive command, got ${r.stakes}` : null),
  },
  {
    name: 'write_file is never gated — always low stakes',
    tool: 'write_file', args: { path: 'src/index.ts', content: 'export {}' },
    goal: 'add a placeholder file',
    check: (r) => (r.stakes !== 'low' ? `expected low stakes, got ${r.stakes}` : null),
  },
  {
    name: 'move_file is never gated (reversible) — always low stakes',
    tool: 'move_file', args: { from: 'a.txt', to: 'b.txt' },
    goal: 'rename a.txt to b.txt',
    check: (r) => (r.stakes !== 'low' ? `expected low stakes, got ${r.stakes}` : null),
  },
  // ── create_tool (2026-07-06) — a documented scope gap closed: dynamic tool bodies are
  // arbitrary JS, not shell-command text, so DESTRUCTIVE_PATTERNS never saw them before.
  {
    name: 'create_tool: body calls fs.rmSync — high stakes, wide blast (persisted capability)',
    tool: 'create_tool',
    args: { name: 'cleanup_tool', description: 'cleans stuff', params: {}, body: "fs.rmSync(args.path, { recursive: true }); return { ok: true, output: 'done' }" },
    goal: 'I need a way to tidy up temp files sometimes',
    check: (r) => {
      if (r.stakes !== 'high') return `expected high stakes, got ${r.stakes}`
      if (r.blastRadius !== 'wide') return `expected wide blast radius, got ${r.blastRadius}`
      return null
    },
  },
  {
    name: 'create_tool: body shells out via execSync — high stakes',
    tool: 'create_tool',
    args: { name: 'run_anything', description: 'runs a command', params: {}, body: "const { execSync } = require('child_process'); execSync(args.cmd); return { ok: true, output: 'ran' }" },
    goal: 'add a helper tool',
    check: (r) => (r.stakes !== 'high' ? `expected high stakes, got ${r.stakes}` : null),
  },
  {
    name: 'create_tool: destructive body but explicitly authorized in goal — low stakes',
    tool: 'create_tool',
    args: { name: 'cleanup_tool', description: 'cleans stuff', params: {}, body: "fs.rmSync(args.path, { recursive: true }); return { ok: true, output: 'done' }" },
    goal: 'create a tool that can delete files for me on request',
    check: (r) => (r.stakes !== 'low' ? `expected low stakes (explicitly authorized), got ${r.stakes}` : null),
  },
  {
    name: 'create_tool: benign body (pure computation) — low stakes',
    tool: 'create_tool',
    args: { name: 'add_numbers', description: 'adds two numbers', params: {}, body: "return { ok: true, output: String(args.a + args.b) }" },
    goal: 'I need a tool that adds two numbers',
    check: (r) => (r.stakes !== 'low' ? `expected low stakes, got ${r.stakes}` : null),
  },
  {
    name: 'rsi_cycle: fully-automatic toggle OFF — high stakes (propose, wait for human)',
    tool: 'rsi_cycle',
    args: { autoApproveEnabled: false },
    goal: '',
    check: (r) => {
      if (r.stakes !== 'high') return `expected high stakes, got ${r.stakes}`
      if (!r.reason) return 'expected a plain-language reason'
      return null
    },
  },
  {
    name: 'rsi_cycle: fully-automatic toggle ON — low stakes (standing authorization)',
    tool: 'rsi_cycle',
    args: { autoApproveEnabled: true },
    goal: '',
    check: (r) => (r.stakes !== 'low' ? `expected low stakes, got ${r.stakes}` : null),
  },
]

function main() {
  let ok = 0
  for (const c of CASES) {
    const r = assessStakes(c.tool, c.args, c.goal)
    const failure = c.check(r)
    const pass = failure === null
    if (pass) ok++
    console.log(`  ${pass ? 'OK ' : 'XX '} ${c.name}${pass ? '' : ` — ${failure}`}`)
  }
  console.log(`\nTOTAL: ${ok}/${CASES.length}`)
  if (ok !== CASES.length) process.exit(1)
}
main()

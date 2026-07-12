// ============================================================================
// Committed bench for the agent-loop EXAMPLE GATE (verify.ts exampleGate).
// When a project has no runnable check (a fresh generated tree has no test
// script), the loop used to ship an honest-but-blind `unverified`. The gate
// now executes the request's own worked examples against the files the agent
// wrote (bundling the import graph via verifyMultiFileCode), turning that into
// a real behavioral pass/fail. This bench proves: correct code passes with a
// 'test' signal, wrong code fails with case detail, and a request with NO
// stated examples still yields the honest `unverified` (nothing to check).
// Run: npx tsx src/CrucibleEngine/agent/__exampleGate_bench.ts
// ============================================================================
import fs from 'fs'
import os from 'os'
import path from 'path'
import { makeVerifier } from './verify'

interface Case {
  name: string
  goal: string
  files: Record<string, string>
  expect: { passed: boolean; unverified?: boolean }
}

const MATH_GOAL = "Create src/mathlib.ts exporting add(a, b) and square(x). For example add(2, 3) returns 5 and square(4) returns 16."

const CASES: Case[] = [
  {
    name: 'correct code → stated examples execute and PASS (real test signal, not unverified)',
    goal: MATH_GOAL,
    files: { 'src/mathlib.ts': 'export function add(a:number,b:number){return a+b}\nexport function square(x:number){return x*x}' },
    expect: { passed: true },
  },
  {
    name: 'wrong code → stated examples FAIL (loop gets case-level feedback to heal)',
    goal: MATH_GOAL,
    files: { 'src/mathlib.ts': 'export function add(a:number,b:number){return a-b}\nexport function square(x:number){return x+x}' },
    expect: { passed: false },
  },
  {
    name: 'examples split across files → cross-file import graph bundled + all pass',
    goal: "Create src/a.ts exporting inc(n) and src/b.ts exporting dbl(n). For example inc(4) returns 5 and dbl(4) returns 8.",
    files: {
      'src/a.ts': 'export function inc(n:number){return n+1}',
      'src/b.ts': 'export function dbl(n:number){return n*2}',
    },
    expect: { passed: true },
  },
  {
    name: 'no stated examples → honest unverified (nothing to check against)',
    goal: 'Create a module that does something useful',
    files: { 'src/x.ts': 'export const x = 1' },
    expect: { passed: true, unverified: true },
  },
]

async function main() {
  let pass = 0
  for (const c of CASES) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examplegate-'))
    try {
      for (const [rel, src] of Object.entries(c.files)) {
        const abs = path.join(dir, rel)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, src)
      }
      const r = await makeVerifier({ goal: c.goal }).verify('done', { projectPath: dir, allowMutation: false } as any)
      const unver = !!(r as any).unverified
      const ok = r.passed === c.expect.passed && (c.expect.unverified === undefined || unver === c.expect.unverified)
      if (ok) pass++
      console.log(`${ok ? 'PASS' : 'FAIL'} — ${c.name}`)
      if (!ok) console.log(`    got passed=${r.passed} unverified=${unver} signal=${r.signal} :: ${(r.report || '').slice(0, 120)}`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  console.log(`\n${pass}/${CASES.length} passed`)
  if (pass !== CASES.length) process.exit(1)
}

main()

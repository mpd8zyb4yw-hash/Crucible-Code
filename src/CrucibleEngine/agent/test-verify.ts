// Section 4 DONE-WHEN: a deliberately-buggy task is auto-fixed within the heal
// cap; an unfixable one stops cleanly with an honest report (no infinite loop).
// Deterministic: scripted DriveTurn, real tools + real python execution.
// Run: npx tsx src/CrucibleEngine/agent/test-verify.ts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { runAgentLoop } from './loop'
import { makeVerifier, fingerprint } from './verify'
import type { DriveTurn } from './loop'

let failures = 0
const check = (label: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${cond ? '' : ' :: ' + detail}`)
  if (!cond) failures++
}
const emit = () => {}

// ── Case 1: buggy code, scripted driver heals it on the fix turn ─────────────
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-heal-'))
  const turns: Array<Parameters<DriveTurn>[0] extends infer _ ? { calls?: any[]; text: string } : never> = [
    { calls: [{ id: 'c1', name: 'write_file', args: { path: 'calc.py', content: 'def add(a,b):\n    return a-b\n' } },
              { id: 'c2', name: 'write_file', args: { path: 'test_calc.py', content: 'from calc import add\nassert add(2,3)==5\nprint("ok")\n' } }], text: '' },
    { text: 'Done: wrote calc.py and its test.' },              // verify fails here, hints injected
    // Replacement is a different length on purpose: same-size + same-mtime-second
    // edits hit Python's stale __pycache__ (pyc invalidation = mtime seconds + size).
    { calls: [{ id: 'c3', name: 'edit_file', args: { path: 'calc.py', old: 'return a-b', new: 'return a + b' } }], text: 'fixing' },
    { text: 'Fixed the sign bug; tests pass.' },                // verify passes here
  ]
  let healPromptSeen = false
  let t = 0
  const driver: DriveTurn = async (messages) => {
    if (messages.some(m => String(m.content ?? '').includes('Verification failed'))) healPromptSeen = true
    const turn = turns[Math.min(t++, turns.length - 1)]
    return { text: turn.text, toolCalls: (turn.calls ?? []) as any }
  }
  const verifier = makeVerifier()
  const result = await runAgentLoop({ goal: 'add()', projectPath: work, driveTurn: driver, emit, verify: verifier.verify })
  check('buggy task auto-fixed within heal cap', result.ok && result.stopped === 'final', JSON.stringify(result))
  check('failure report + hints were fed back to driver', healPromptSeen)
  check('exactly one heal attempt used', verifier.healAttempts() === 1, String(verifier.healAttempts()))
  fs.rmSync(work, { recursive: true, force: true })
}

// ── Case 2: unfixable failure stops cleanly (fingerprint anti-thrash) ─────────
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-thrash-'))
  fs.writeFileSync(path.join(work, 'test_doom.py'), 'assert 1==2, "unfixable"\n')
  // Driver that never actually fixes anything — just keeps claiming done.
  const driver: DriveTurn = async () => ({ text: 'All done!', toolCalls: [] })
  const verifier = makeVerifier()
  const result = await runAgentLoop({ goal: 'doom', projectPath: work, driveTurn: driver, emit, verify: verifier.verify, maxIters: 20 })
  check('unfixable task stops via escalation, not max_iters', result.stopped === 'verify_failed', result.stopped)
  check('stops on 2nd occurrence of same fingerprint (<< heal cap of loop iters)', verifier.healAttempts() === 2, String(verifier.healAttempts()))
  check('honest report surfaces the failure', result.finalText.includes('unfixable') || result.finalText.includes('AssertionError'), result.finalText.slice(0, 200))
  fs.rmSync(work, { recursive: true, force: true })
}

// ── Fingerprint stability ─────────────────────────────────────────────────────
const a = fingerprint('Traceback...\n  File "/tmp/x/test.py", line 12\nAssertionError: unfixable')
const b = fingerprint('Traceback...\n  File "/tmp/y/test.py", line 99\nAssertionError: unfixable')
const c = fingerprint('TypeError: cannot add str and int')
check('fingerprint ignores paths/line numbers', a === b)
check('fingerprint distinguishes different errors', a !== c)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

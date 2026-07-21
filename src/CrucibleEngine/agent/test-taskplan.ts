// DONE-WHEN: a sloppy model-supplied plan is normalized into a well-formed one; a
// mid-run replan never loses completed work; and completion is detected so an
// unattended run stops instead of looping.
// Deterministic: pure functions + real tool exec against a temp project. No model calls.
// Run: npx tsx src/CrucibleEngine/agent/test-taskplan.ts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { registry } from '../tools/registry'
import {
  applyPlanUpdate, buildPlanContext, clearPlan, getPlan, mergePreservingProgress,
  normalizeSteps, planProgress, renderPlan,
} from './taskPlan'

let failures = 0
const check = (label: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${cond ? '' : ' :: ' + detail}`)
  if (!cond) failures++
}

// ── normalizeSteps: the invariants a weak model violates ────────────────────
{
  const s = normalizeSteps([
    { step: 'Read the file', status: 'in_progress' },
    { step: 'Write the fix', status: 'in_progress' },   // second active step
    { step: 'Run tests' },
  ])
  check('only one step stays in_progress', s.filter(x => x.status === 'in_progress').length === 1,
    JSON.stringify(s.map(x => x.status)))
  check('the first active step is the one kept', s[0].status === 'in_progress', s[0].status)
  check('later duplicate-active step demotes to pending', s[1].status === 'pending', s[1].status)
}
{
  const s = normalizeSteps([
    { step: 'Read the file' }, { step: '  ' }, { step: 'read the FILE!' }, { step: 'Run tests' },
  ])
  check('blank steps dropped', !s.some(x => !x.step.trim()))
  check('case/punctuation duplicates collapsed', s.length === 2, JSON.stringify(s.map(x => x.step)))
}
{
  const s = normalizeSteps([{ step: 'A' }, { step: 'B' }])
  check('with nothing active, first pending is promoted', s[0].status === 'in_progress', s[0].status)
}
{
  const s = normalizeSteps([{ step: 'A', status: 'completed' }, { step: 'B', status: 'completed' }])
  check('a fully-complete plan promotes nothing', s.every(x => x.status === 'completed'),
    JSON.stringify(s.map(x => x.status)))
  check('bogus status values fall back to pending',
    normalizeSteps([{ step: 'A', status: 'nonsense' as any }, { step: 'B', status: 'completed' }])[0].status === 'in_progress')
}

// ── mergePreservingProgress: a replan must not reset finished work ──────────
{
  const prev = normalizeSteps([
    { step: 'Read the file', status: 'completed' },
    { step: 'Write the fix', status: 'in_progress' },
  ])
  // Model replans and carelessly re-sends everything as pending.
  const next = mergePreservingProgress(prev, normalizeSteps([
    { step: 'Read the file' }, { step: 'Write the fix' }, { step: 'Run tests' },
  ]))
  check('completed step survives a careless replan', next[0].status === 'completed', next[0].status)
  check('new step is appended as pending', next[2].status === 'pending', next[2].status)
  check('in_progress step is not demoted by the replan', next[1].status === 'in_progress', next[1].status)
}
{
  const prev = normalizeSteps([{ step: 'Write the fix', status: 'in_progress' }])
  const next = mergePreservingProgress(prev, normalizeSteps([{ step: 'Write the fix', status: 'completed' }]))
  check('an explicit forward move to completed is honored', next[0].status === 'completed', next[0].status)
}
{
  const prev = normalizeSteps([{ step: 'Deploy', status: 'completed' }])
  const next = mergePreservingProgress(prev, normalizeSteps([{ step: 'Deploy', status: 'blocked', note: 'no creds' }]))
  check('a completed step can still be reopened as blocked', next[0].status === 'blocked', next[0].status)
}

// ── progress + completion signal ────────────────────────────────────────────
{
  const done = planProgress({ goal: 'g', updatedAt: 0, steps: normalizeSteps([
    { step: 'A', status: 'completed' }, { step: 'B', status: 'completed' }]) })
  check('done fires when every step is complete', done.done && done.completed === 2)
  check('rendered done-plan tells the model to stop calling tools',
    renderPlan({ goal: 'g', updatedAt: 0, steps: [{ step: 'A', status: 'completed' }] }).includes('do not call more tools'))

  const blocked = planProgress({ goal: 'g', updatedAt: 0, steps: [
    { step: 'A', status: 'completed' }, { step: 'B', status: 'blocked', note: 'no creds' }] })
  check('blocked-but-resolved still counts as done', blocked.done && blocked.blocked.length === 1)
  check('a blocked plan must not be reported as success',
    renderPlan({ goal: 'g', updatedAt: 0, steps: [
      { step: 'A', status: 'completed' }, { step: 'B', status: 'blocked' }] }).includes('do not claim success'))

  const open = planProgress({ goal: 'g', updatedAt: 0, steps: normalizeSteps([
    { step: 'A', status: 'completed' }, { step: 'B' }]) })
  check('done does not fire while work remains', !open.done && open.current?.step === 'B', String(open.current?.step))
  check('an empty plan is not "done"', !planProgress({ goal: '', updatedAt: 0, steps: [] }).done)
}

// ── the tool itself, end to end against a temp project ──────────────────────
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-plan-'))
  const emitted: Record<string, unknown>[] = []
  const ctx = { projectPath: work, allowMutation: false, emit: (e: Record<string, unknown>) => { emitted.push(e) } }
  const call = (id: string, args: Record<string, unknown>) => registry.exec({ id, name: 'update_plan', args }, ctx as any)

  const first = await call('c1', { goal: 'Fix the parser', steps: [{ step: 'Read parser.ts' }, { step: 'Patch it' }] })
  check('update_plan is registered and runs', first.ok, first.output)
  check('plan persists to disk', fs.existsSync(path.join(work, '.crucible', 'plan.json')))
  check('a plan event is emitted for the UI', emitted.some(e => e.type === 'plan'))

  // Read-only context must still be able to plan.
  check('planning is not blocked by allowMutation:false', !first.output.startsWith('Tool update_plan mutates'))

  const second = await call('c2', { steps: [{ step: 'Read parser.ts', status: 'completed' }, { step: 'Patch it', status: 'in_progress' }] })
  check('goal is retained when omitted on a later call', getPlan(work)?.goal === 'Fix the parser', String(getPlan(work)?.goal))
  check('progress is reflected back to the model', second.output.includes('1/2 complete'), second.output)

  const third = await call('c3', { steps: [{ step: 'Read parser.ts' }, { step: 'Patch it', status: 'completed' }] })
  check('completion is detected end to end', (third.meta as any)?.done === true, third.output)
  check('the careless pending on step 1 did not undo it', (third.meta as any)?.completed === 2, third.output)

  const bad = await call('c4', { steps: 'not-an-array' })
  check('a malformed steps argument fails cleanly', !bad.ok && bad.output.includes('requires a "steps" array'), bad.output)
  check('a malformed call does not destroy the existing plan', getPlan(work)?.steps.length === 2)

  const empty = await call('c5', { steps: [{ step: '   ' }] })
  check('an all-empty step list is rejected', !empty.ok, empty.output)

  clearPlan(work)
  check('clearPlan removes the plan', getPlan(work) === null)
  fs.rmSync(work, { recursive: true, force: true })
}

// ── persistence across a process restart (the unattended-run case) ──────────
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-plan-'))
  applyPlanUpdate(work, { goal: 'Long run', steps: [{ step: 'A', status: 'completed' }, { step: 'B' }] })
  clearPlan(work)  // drops the in-memory cache *and* the file
  check('cleared plan is gone', getPlan(work) === null)

  applyPlanUpdate(work, { goal: 'Long run', steps: [{ step: 'A', status: 'completed' }, { step: 'B' }] })
  const onDisk = JSON.parse(fs.readFileSync(path.join(work, '.crucible', 'plan.json'), 'utf-8'))
  check('on-disk plan carries statuses for a cold resume',
    onDisk.steps[0].status === 'completed' && onDisk.steps[1].status === 'in_progress',
    JSON.stringify(onDisk.steps))
  fs.rmSync(work, { recursive: true, force: true })
}

// ── preamble injection (this is what server.ts appends) ─────────────────────
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-plan-'))
  check('no plan yields empty context, so callers can append unconditionally',
    buildPlanContext(work) === '', JSON.stringify(buildPlanContext(work)))

  applyPlanUpdate(work, { goal: 'Ship the fix', steps: [{ step: 'Read parser.ts', status: 'completed' }, { step: 'Patch it' }] })
  const ctxText = buildPlanContext(work)
  check('plan context names the tool that maintains it', ctxText.includes('update_plan'), ctxText)
  check('plan context carries the goal and current step',
    ctxText.includes('Ship the fix') && ctxText.includes('Patch it'), ctxText)
  check('plan context shows completed work as completed', ctxText.includes('[x] Read parser.ts'), ctxText)
  fs.rmSync(work, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

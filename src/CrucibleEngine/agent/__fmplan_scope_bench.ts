// Pure, offline bench for Layer 2 (localFmPlan) scope guards. No model calls, no network —
// the fake synth RECORDS whether it was called, which is half the point: an out-of-scope goal
// must bail BEFORE the FM round-trip, not after.
// Run: npx tsx src/CrucibleEngine/agent/__fmplan_scope_bench.ts
//
// Guards the cont.96 regression: localFmPlan is a macOS AUTOMATION planner with no tool that can
// answer "what is 17 + 4", so when handed a pure-reasoning goal the weak on-device planner did
// not abstain — it reached for the nearest tool it could see. Live 2026-07-21, the automation
// brief "State the sum of 17 and 4, and nothing else" produced a shell_exec plan whose entire
// output was "exit 0", and that shipped as the answer. Same failure mode the GUI_CONTROL_TOOLS
// gate was added for, one tool over.
import { localFmPlan, stripPreamble } from './localFmPlanner'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

// A synth that would happily hand back the exact bad plan from the live repro.
function fakeSynth(record: { called: number }) {
  return async () => {
    record.called++
    return JSON.stringify({
      intent: 'short label',
      steps: [{ tool: 'shell_exec', args: { command: 'echo 21' } }],
      summary: 'computed',
    })
  }
}

const AUTOMATION_PREAMBLE =
  '[Standing automation "trace" — unattended scheduled run. Carry out the task autonomously.]'

console.log('== stripPreamble exposes the real request ==')
check('bracketed preamble removed', stripPreamble(`${AUTOMATION_PREAMBLE}\n\nState the sum.`) === 'State the sum.')
check('plain text untouched', stripPreamble('open finder') === 'open finder')
check('bracket mid-string untouched', stripPreamble('open [the] finder') === 'open [the] finder')

console.log('\n== pure-reasoning goals bail BEFORE the FM call ==')
for (const goal of [
  'State the sum of 17 and 4, and nothing else.',
  'What is 17 + 4?',
  'Calculate the total of 17 times 4.',
  'Explain how a red-black tree stays balanced.',
  'Who wrote the Aeneid?',
  'Why is the sky blue?',
  'Define idempotence.',
]) {
  const rec = { called: 0 }
  const out = await localFmPlan(goal, fakeSynth(rec))
  check(`null for ${JSON.stringify(goal.slice(0, 38))}`, out === null, JSON.stringify(out))
  check('  FM was not called', rec.called === 0, `called ${rec.called}x`)
}

console.log('\n== the live repro, WITH the automation preamble ==')
{
  const rec = { called: 0 }
  const out = await localFmPlan(`${AUTOMATION_PREAMBLE}\n\nState the sum of 17 and 4, and nothing else.`, fakeSynth(rec))
  check('preamble does not smuggle it past the guard', out === null, JSON.stringify(out))
  check('FM was not called', rec.called === 0, `called ${rec.called}x`)
}

console.log('\n== in-scope automation goals still plan ==')
for (const goal of [
  'screenshot the screen',            // matches neither ACTION_VERB nor DESKTOP_ACTION — must pass
  'open crucible project in Finder',
  'go to github.com/anthropics',
]) {
  const rec = { called: 0 }
  const out = await localFmPlan(goal, fakeSynth(rec))
  check(`plan produced for ${JSON.stringify(goal)}`, out !== null, JSON.stringify(out))
  check('  FM was consulted', rec.called === 1, `called ${rec.called}x`)
}

console.log('\n== a desktop QUESTION still reaches Layer 2 when desktop intent is declared ==')
{
  const rec = { called: 0 }
  const out = await localFmPlan("what's the frontmost app", fakeSynth(rec), { desktopIntent: true })
  check('desktopIntent overrides the reasoning guard', out !== null, JSON.stringify(out))
}
{
  // Without desktop intent the GUI tools are stripped anyway, so there is no tool that could
  // answer it here — bailing is correct rather than a regression.
  const rec = { called: 0 }
  const out = await localFmPlan("what's the frontmost app", fakeSynth(rec))
  check('and bails without it', out === null, JSON.stringify(out))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)

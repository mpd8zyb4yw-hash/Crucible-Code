// Bench for the desktop-intent gate on Layer 2's GUI-control tools (2026-07-20).
// The bug: a plain reasoning/math automation brief sometimes drew a get_ui_tree step
// out of the on-device planner, whose output during an unattended run is the Crucible
// app's own window ("APP: Claude\nWINDOW: …") — self-referential garbage shipped as the
// answer. The fix gates get_ui_tree/click_element/type_text behind desktopIntent.
//
// We drive localFmPlan with a STUB synth that always tries to emit a get_ui_tree plan.
// Without desktop intent the tool is not in the allowlist → the plan is rejected → null
// (planner passes, brief falls through to the reasoning path). With desktop intent the
// same plan validates.
//
// Run: npx tsx src/CrucibleEngine/agent/__guiIntent_bench.ts

import { localFmPlan } from './localFmPlanner'

let pass = 0
let fail = 0
const check = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}`) }
}

// Synth that always proposes a single get_ui_tree step, regardless of the request.
const uiTreeSynth = async () =>
  JSON.stringify({ intent: 'read screen', steps: [{ tool: 'get_ui_tree', args: {} }], summary: 'read the screen' })

// Synth that proposes a web search — a non-GUI tool, allowed in both modes.
const searchSynth = async () =>
  JSON.stringify({ intent: 'search', steps: [{ tool: 'search_web', args: { query: 'x' } }], summary: 'search' })

async function main() {
  // 1. A math/reasoning brief with NO desktop intent must NOT get a get_ui_tree plan.
  const mathPlan = await localFmPlan('What is 17 times 4?', uiTreeSynth, { desktopIntent: false })
  check('math brief rejects get_ui_tree plan (→ null)', mathPlan === null)

  // 2. Default (no opts) is non-desktop → same rejection. Guards accidental omission.
  const defaultPlan = await localFmPlan('Add up 45, 78 and 120.', uiTreeSynth)
  check('default (no desktopIntent) rejects get_ui_tree', defaultPlan === null)

  // 3. A genuine desktop-action goal DOES allow get_ui_tree.
  const desktopPlan = await localFmPlan('click the submit button on screen', uiTreeSynth, { desktopIntent: true })
  check('desktop-intent goal accepts get_ui_tree plan', desktopPlan !== null && desktopPlan.steps[0].tool === 'get_ui_tree')

  // 4. Non-GUI tools (search_web) stay available WITHOUT desktop intent — the gate is
  //    surgical to GUI-control tools, not a blanket Layer-2 shutdown.
  const searchPlan = await localFmPlan('look up the capital of France', searchSynth, { desktopIntent: false })
  check('non-desktop brief still allows search_web', searchPlan !== null && searchPlan.steps[0].tool === 'search_web')

  console.log(`\n${pass}/${pass + fail} passed`)
  if (fail) process.exit(1)
}

main()

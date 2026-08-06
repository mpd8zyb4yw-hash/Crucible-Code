// Bench for the page-interaction tools (cont.119, AGENTIC_WEB_OVERHAUL items 13-17).
// Drives the REAL registry against an offline fixture, so it asserts the whole path — tool
// definition, ref stamping, action dispatch, change detection — without depending on a live
// site. Run: npx tsx src/CrucibleEngine/tools/__webact_bench.ts
import fs from 'fs'
import os from 'os'
import path from 'path'

// A DEDICATED profile, set before anything imports the browser (profileDir reads this at call
// time). Two reasons, both found the hard way:
//   · chromium takes an exclusive lock on a user-data-dir, so this bench could not run at all
//     while the app was running — it failed with "profile is already in use", which looks exactly
//     like a code regression and is not one;
//   · without it the bench drives the USER'S REAL signed-in profile. A test has no business
//     touching the thing that holds someone's live sessions.
process.env.CRUCIBLE_BROWSER_PROFILE ??= path.join(os.tmpdir(), 'crucible-webact-bench-profile')

import { registry } from './registry'
import type { ToolCtx } from './protocol'

// Neither `__dirname` (this runs as ESM under tsx) nor `import.meta.url` (tsconfig.server.json is
// module:commonjs, so it is a TS1343 error anywhere under src/CrucibleEngine) is available here.
// The bench is invoked from the repo root, so cwd is the one anchor that satisfies both.
const ROOT = process.cwd()
const FIXTURE = `file://${path.join(ROOT, 'src', 'CrucibleEngine', 'tools', '__fixtures__', 'webact.html')}`

const ctx: ToolCtx = { projectPath: ROOT, allowMutation: true, userId: 'bench', goal: 'bench', sessionId: 'bench' }
const exec = (name: string, args: Record<string, unknown>) =>
  registry.exec({ id: `b${Math.abs(hash(name + JSON.stringify(args)))}`, name, args }, ctx)
function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return h }

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'OK ' : 'XX '} ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

async function main() {
  const open = await exec('web_open', { url: FIXTURE, maxChars: 2000 })
  check('web_open opens a local page', open.ok === true, String(open.output).slice(0, 200))
  const pageId = (open.meta as any)?.pageId as string
  check('returns a pageId', !!pageId, String(pageId))
  if (!open.ok || !pageId) { console.log(`\nTOTAL: ${pass}/${pass + fail}`); process.exit(1) }

  const out0 = String(open.output)
  check('stamps quotable refs', /\be\d+\s+\[/.test(out0), out0.slice(0, 200))
  check('finds the text input', /input:text/.test(out0))
  check('finds the select', /\[select\]/.test(out0))
  check('names controls accessibly', /Run search/.test(out0))
  // An invisible control is not an affordance — offering it invites actions that silently no-op.
  check('omits display:none controls', !/Hidden button/.test(out0))

  // fill -> select -> click, with state carried across three separate tool calls.
  const fill = await exec('web_act', { pageId, action: 'fill', target: 'Search query', value: 'otters', maxChars: 1200 })
  check('fill by accessible name', fill.ok === true, String(fill.output).slice(0, 160))
  check('fill is reflected in the control value', /= "otters"/.test(String(fill.output)), String(fill.output).slice(0, 300))

  const sel = await exec('web_act', { pageId, action: 'select', target: 'Colour', value: 'blue', maxChars: 1200 })
  check('select an option', sel.ok === true, String(sel.output).slice(0, 160))

  const click = await exec('web_act', { pageId, action: 'click', target: 'Run search', maxChars: 1500 })
  check('click runs the handler', click.ok === true, String(click.output).slice(0, 160))
  check('state carried across calls', /RESULT: otters \/ blue/.test(String(click.output)), String(click.output).slice(0, 400))
  // The click reveals a hidden div containing two more controls.
  check('reports newly appeared controls', ((click.meta as any)?.changed?.elementCount ?? 0) > 0,
    JSON.stringify((click.meta as any)?.changed))

  // Honesty: a control that does nothing must be reported as doing nothing.
  const dead = await exec('web_act', { pageId, action: 'click', target: 'Does nothing', maxChars: 400 })
  check('a no-op click is reported honestly, not as success',
    dead.ok === true && /NOTHING measurably changed/.test(String(dead.output)),
    String(dead.output).split('\n')[0])

  // Ref targeting must work as well as name targeting.
  const refMatch = out0.match(/(\be\d+)\s+\[input:text\]/)
  if (refMatch) {
    const byRef = await exec('web_act', { pageId, action: 'fill', target: refMatch[1], value: 'by-ref', maxChars: 800 })
    check('target by ref id', byRef.ok === true && /= "by-ref"/.test(String(byRef.output)), String(byRef.output).slice(0, 200))
  } else check('target by ref id', false, 'no input ref found to test')

  // A bad target must enumerate what IS available rather than failing blankly.
  const bad = await exec('web_act', { pageId, action: 'click', target: 'no-such-control-xyz' })
  check('unknown target lists the real controls',
    bad.ok === false && /Visible controls/.test(String(bad.output)), String(bad.output).slice(0, 160))

  const badAction = await exec('web_act', { pageId, action: 'teleport' })
  check('unknown action is refused clearly', badAction.ok === false && /Unknown action/.test(String(badAction.output)))

  const close = await exec('web_close', { pageId })
  check('web_close closes the page', close.ok === true && /Closed/.test(String(close.output)), String(close.output))

  const afterClose = await exec('web_act', { pageId, action: 'click', target: 'Run search' })
  check('acting on a closed page fails loudly', afterClose.ok === false && /No open page/.test(String(afterClose.output)),
    String(afterClose.output).slice(0, 160))

  // ── New tabs (cont.119, overhaul item 19) ──────────────────────────────────
  // A new tab is where the flow WENT — sign-in popups, "open in new tab" links and OAuth hops all
  // continue in a page the original handle never pointed at. Without adopting it, every later
  // action targets the abandoned tab and truthfully reports that nothing changed.
  const tabOpen = await exec('web_open', { url: FIXTURE, maxChars: 600 })
  const tId = (tabOpen.meta as any)?.pageId
  if (tId) {
    const popped = await exec('web_act', { pageId: tId, action: 'click', target: 'Open in a new tab', maxChars: 800 })
    check('a new tab is adopted under the same pageId', (popped.meta as any)?.navigated === true && /new tab/.test(String(popped.output)),
      String(popped.output).split('\n')[0])
    check('the new tab is what is now read', /Second Tab/.test(String(popped.output)), String(popped.output).slice(0, 200))
    // ...and the handle keeps working, now against the adopted tab.
    const inNew = await exec('web_act', { pageId: tId, action: 'read', maxChars: 600 })
    check('later acts target the adopted tab', /Second Tab/.test(String(inNew.output)), String(inNew.output).slice(0, 160))
    const closed = await exec('web_close', { pageId: tId })
    check('closing the flow closes both tabs', closed.ok === true, String(closed.output))
  } else check('a new tab is adopted under the same pageId', false, 'could not open the fixture')

  // ── Downloads (cont.119, overhaul item 20) ─────────────────────────────────
  // A flow that ends in a file is an ordinary thing to ask for, and without capture the file is
  // simply lost: the click "works", nothing on the page changes, and there is nothing to show.
  const dlOpen = await exec('web_open', { url: FIXTURE, maxChars: 600 })
  const dId = (dlOpen.meta as any)?.pageId
  if (dId) {
    const dl = await exec('web_act', { pageId: dId, action: 'click', target: 'Download the note', maxChars: 600 })
    const files: string[] = ((dl.meta as any)?.downloads ?? []) as string[]
    check('a download is captured', files.length === 1, JSON.stringify((dl.meta as any)?.downloads))
    check('the file exists on disk', files.length > 0 && fs.existsSync(files[0]), files[0] ?? '(none)')
    check('the file has the real content', files.length > 0 && fs.readFileSync(files[0], 'utf8').includes('hello from the fixture'),
      files[0] ? fs.readFileSync(files[0], 'utf8').slice(0, 40) : '(none)')
    check('the download is named in the output', /Downloaded 1 file/.test(String(dl.output)), String(dl.output).slice(0, 160))
    // Emitted as an entity so it can be opened and acted on — a file the user cannot find is the
    // same as no file (crucible-usefulness-overhaul).
    check('the download is emitted as a file entity', Array.isArray(dl.entities) && dl.entities.length === 1,
      JSON.stringify(dl.entities))
    // Drained per action: the next act must not re-report the same file.
    const after = await exec('web_act', { pageId: dId, action: 'read', maxChars: 400 })
    check('a download is reported once, not on every later act', (((after.meta as any)?.downloads ?? []) as string[]).length === 0,
      JSON.stringify((after.meta as any)?.downloads))
    for (const f of files) { try { fs.unlinkSync(f) } catch { /* best effort */ } }
    await exec('web_close', { pageId: dId })
  } else check('a download is captured', false, 'could not open the fixture')

  // ── `read`: re-read without acting (cont.119) ──────────────────────────────
  // The planner asked for this itself — it emitted web_act {action:"read"} and was refused with
  // "Unknown action". It was right to want it; the alternative was a no-op scroll to force a
  // re-read, which then reported "NOTHING measurably changed" as if something had gone wrong.
  const reopened = await exec('web_open', { url: FIXTURE, maxChars: 800 })
  const rId = (reopened.meta as any)?.pageId
  if (rId) {
    const read = await exec('web_act', { pageId: rId, action: 'read', maxChars: 800 })
    check('read re-reads the page', read.ok === true, String(read.output).slice(0, 160))
    check('read reports itself as a re-read, not a failed action',
      /re-read the page/.test(String(read.output)) && !/NOTHING measurably changed/.test(String(read.output)),
      String(read.output).split('\n')[0])
    check('read still returns the controls', /\be\d+\s+\[/.test(String(read.output)), String(read.output).slice(0, 200))
    await exec('web_close', { pageId: rId })
  } else check('read re-reads the page', false, 'could not reopen the fixture')

  // ── Quoted arguments (cont.119) ────────────────────────────────────────────
  // Models wrap values in their own quotes and the quotes survive into the arg: live, web_open
  // received "\"https://example.com\"" and navigated to https://"https//example.com%22,
  // failing with ERR_NAME_NOT_RESOLVED. A matched surrounding pair is stripped centrally.
  const quoted = await exec('web_open', { url: `"${FIXTURE}"`, maxChars: 400 })
  check('a double-quoted url still opens', quoted.ok === true, String(quoted.output).slice(0, 160))
  const qId = (quoted.meta as any)?.pageId
  if (qId) {
    const qAct = await exec('web_act', { pageId: `"${qId}"`, action: '"click"', target: '"Run search"', maxChars: 400 })
    check('quoted pageId/action/target still act', qAct.ok === true, String(qAct.output).slice(0, 160))
    await exec('web_close', { pageId: qId })
  } else check('quoted pageId/action/target still act', false, 'no pageId from the quoted open')

  console.log(`\nTOTAL: ${pass}/${pass + fail}`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error('bench crashed:', e); process.exit(1) })

// Bench for the page-interaction tools (cont.119, AGENTIC_WEB_OVERHAUL items 13-17).
// Drives the REAL registry against an offline fixture, so it asserts the whole path — tool
// definition, ref stamping, action dispatch, change detection — without depending on a live
// site. Run: npx tsx src/CrucibleEngine/tools/__webact_bench.ts
import path from 'path'
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

  console.log(`\nTOTAL: ${pass}/${pass + fail}`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error('bench crashed:', e); process.exit(1) })

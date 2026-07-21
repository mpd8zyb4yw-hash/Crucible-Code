// DONE-WHEN (W42.2): every git-mined task is proven sound through the REAL hermetic
// oracle BEFORE it may measure anything — and, unlike the authored corpus, proven
// DISCRIMINATING: the parent commit's buggy file must be REJECTED BY THE SUITE'S OWN
// ASSERTIONS (gate A clean, gate B red). A mined task whose suite passes the bug is
// vacuous — it would award a green for shipping the bug back unchanged — and vacuity
// is exactly the failure mode mining is prone to, because most benches predate the
// bugs their subsystems later grew (see DROPPED_COMMITS).
//
// Stages per task:
//   1. pin integrity     — full SHAs, parentSha IS the fix's recorded parent, both
//                          files exist at their pinned commits, the target actually changed
//   2. commit shape      — the fix touched NOTHING but targetPath (+ benchPath), so
//                          parent-tree + ref overlay ≡ fix-tree and the ref run is exact
//   3. prompt hygiene    — names the target, symptom-sized, and leaks NO added line of
//                          the fix diff (hard fail); overlap with bench-added lines is
//                          printed as a warning (test-input tells)
//   4. catalog freedom   — synthesize() must not claim it; near-catalog gray zone printed
//   5. scaffold sanity   — workspace starts from the buggy file at parent, plus 1-hop imports
//   6. REF certifies     — through verifyCandidate: tsc, lint, hermetic double-run Gate B
//   7. PARENT rejected   — behaviorally (ranAssertions=true, gateA=true, accepted=false)
//
// Deterministic, model-free, offline. Run:
//   npx tsx src/CrucibleEngine/coding-bench-ext/__minedcorpus_bench.ts
import { EXT_TASKS } from './index'
import { MINED_TASKS, DROPPED_COMMITS } from './tasks-mined'
import {
  addedDiffLines, gitChangedFiles, gitPathExists,
  minedParentContent, minedRefContent, minedScaffold, minedSuiteContent, runMinedCandidate, snapshotClosure,
} from './minedHarness'
import { spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { synthesize } from '../synth'
import { minDetectableDelta } from '../benchStats'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CODE_DIR = path.resolve(HERE, '../../..')

let failures = 0
const check = (label: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${cond ? '' : ' :: ' + detail.slice(0, 300)}`)
  if (!cond) failures++
}
const revParse = (ref: string): string | null => {
  const r = spawnSync('git', ['rev-parse', ref], { cwd: CODE_DIR, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

// ── corpus-wide hygiene ─────────────────────────────────────────────────────
{
  const ids = MINED_TASKS.map(t => t.id)
  check('mined task ids are unique', new Set(ids).size === ids.length)
  const extIds = new Set(EXT_TASKS.map(t => t.id))
  check('mined ids do not collide with the authored corpus', ids.every(id => !extIds.has(id)))
  check('every dropped commit records a reason', DROPPED_COMMITS.every(d => /^[0-9a-f]{40}$/.test(d.sha) && d.reason.length > 40))
  for (const d of DROPPED_COMMITS) console.log(`DROPPED — ${d.sha.slice(0, 12)}: ${d.reason}`)
}

// ── per-task certification ──────────────────────────────────────────────────
const NEAR_CATALOG_FLOOR = 0.35
const nearCatalog: string[] = []
let certified = 0
let discriminating = 0

for (const task of MINED_TASKS) {
  const t0 = Date.now()

  // 1. Pin integrity.
  check(`${task.id}: parentSha is the fix's recorded parent`, revParse(`${task.fixSha}^`) === task.parentSha)
  check(`${task.id}: target exists at parent and fix`, gitPathExists(task.parentSha, task.targetPath) && gitPathExists(task.fixSha, task.targetPath))
  check(`${task.id}: bench exists at fix`, gitPathExists(task.fixSha, task.benchPath))
  const parentContent = minedParentContent(task)
  const refContent = minedRefContent(task)
  check(`${task.id}: the fix actually changed the target`, parentContent !== refContent)

  // 2. Commit shape — guarantees parent-tree + ref overlay ≡ fix-tree, so the ref run
  //    below certifies the EXACT world the fix commit shipped.
  const changed = gitChangedFiles(task.parentSha, task.fixSha)
  const allowed = new Set([task.targetPath, task.benchPath])
  check(`${task.id}: fix commit touched nothing but target(+bench)`, changed.every(f => allowed.has(f)), changed.join(','))

  // 3. Prompt hygiene. The no-leak needles are the fix diff's substantial added lines —
  //    if any appears verbatim in the prompt, the prompt is dictating the patch, and the
  //    task measures transcription, not debugging.
  check(`${task.id}: prompt names the target path`, task.prompt.includes(task.targetPath))
  check(`${task.id}: prompt is a real report (>= 600 chars)`, task.prompt.length >= 600, String(task.prompt.length))
  const fixLeaks = addedDiffLines(task.parentSha, task.fixSha, task.targetPath).filter(l => task.prompt.includes(l))
  check(`${task.id}: prompt leaks no added line of the fix`, fixLeaks.length === 0, fixLeaks[0] ?? '')
  const benchTells = addedDiffLines(task.parentSha, task.fixSha, task.benchPath).filter(l => task.prompt.includes(l))
  if (benchTells.length) console.log(`WARN — ${task.id}: prompt contains ${benchTells.length} bench-added line(s) (test-input tell): ${benchTells[0].slice(0, 120)}`)

  // 4. Catalog freedom — a fix-this-file task should never be answerable from the skill
  //    catalog, but the gate that guards the authored corpus guards this one too.
  const match = synthesize(task.prompt)
  const top = match.ranking[0]
  check(`${task.id}: not catalog-solvable`, match.matched === null, `matched=${match.matched?.id}`)
  if (match.matched === null && top && top.score >= NEAR_CATALOG_FLOOR) {
    nearCatalog.push(`${task.id} (top=${top.id}:${top.score.toFixed(2)})`)
    console.log(`NEAR-CATALOG — ${task.id}: closest skill ${top.id} scores ${top.score.toFixed(2)}`)
  }

  // 5. Scaffold sanity — the workspace the agent starts from is the bug, verbatim.
  const scaffold = minedScaffold(task)
  check(`${task.id}: scaffold[0] is the buggy target at parent`, scaffold[0]?.path === task.targetPath && scaffold[0]?.content === parentContent)
  console.log(`  scaffold: ${scaffold.length} file(s) — ${scaffold.map(s => s.path.split('/').pop()).join(', ')}`)
  const suiteChecks = (minedSuiteContent(task).match(/\b(?:check|ok|throws\w*)\(\s*['"`]/g) ?? []).length
  const closure = snapshotClosure(task)
  console.log(`  suite: ${task.benchPath.split('/').pop()} @ ${task.fixSha.slice(0, 12)} — ${suiteChecks} assertion call(s); historical closure ${closure.length} file(s)`)
  check(`${task.id}: suite has real teeth (>= 10 assertions)`, suiteChecks >= 10, String(suiteChecks))

  // 6. The load-bearing accept: the REAL fix certifies against the pinned suite through
  //    the full oracle (tsc on the historical closure, lint, hermetic double-run Gate B).
  const refVerdict = runMinedCandidate(task, refContent)
  if (refVerdict.accepted) certified++
  check(`${task.id}: reference (the real fix) certifies hermetically`, refVerdict.accepted, refVerdict.detail)

  // 7. The load-bearing reject: the parent's buggy file must fail the suite's OWN
  //    ASSERTIONS. accepted ⇒ vacuous task; gateA=false ⇒ the rejection is a compile
  //    artifact, not behavioral discrimination — both are certification failures.
  const parentVerdict = runMinedCandidate(task, parentContent)
  const behavioral = !parentVerdict.accepted && parentVerdict.gateA && parentVerdict.ranAssertions
  if (behavioral) discriminating++
  check(`${task.id}: parent bug is rejected BEHAVIORALLY (non-vacuous)`, behavioral,
    parentVerdict.accepted ? 'VACUOUS — the suite passes the bug' : `gateA=${parentVerdict.gateA} ranAssertions=${parentVerdict.ranAssertions} :: ${parentVerdict.detail}`)
  if (behavioral) console.log(`  discrimination evidence: ${parentVerdict.detail.slice(0, 260)}`)

  console.log(`  [${task.id}: ${((Date.now() - t0) / 1000).toFixed(1)}s]`)
}

// ── the honest summary ──────────────────────────────────────────────────────
{
  const nAuthored = 10 + EXT_TASKS.length
  const nTotal = nAuthored + MINED_TASKS.length
  console.log('')
  console.log(`mined corpus: ${MINED_TASKS.length} task(s), ${certified} reference-certified, ${discriminating} discrimination-proven, ${DROPPED_COMMITS.length} dropped (visible above)`)
  console.log(nearCatalog.length ? `near-catalog gray zone: ${nearCatalog.join('; ')}` : 'near-catalog gray zone: none')
  console.log(`generated-path bench: n=${nAuthored} -> n=${nTotal}`)
  const pts = (x: number) => `±${Math.round(x * 100)}pts`
  console.log(`95% noise floor at ~50% pass rate: n=${nAuthored} ${pts(minDetectableDelta(nAuthored))} | n=${nTotal} ${pts(minDetectableDelta(nTotal))} | n=100 ${pts(minDetectableDelta(100))}`)
  console.log('mined tasks are DOUBLY certified: ref passes AND the original bug fails — the corpus grows only by tasks that provably tell the two apart.')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

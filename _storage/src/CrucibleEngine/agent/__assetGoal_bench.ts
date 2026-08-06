// Bench for the asset-collection gate. Run:
//   npx tsx src/CrucibleEngine/agent/__assetGoal_bench.ts
//
// THE LIVE CASE (2026-08-04, agent mode). Brief:
//   "Count how many lines are in notes.txt in ~/Desktop/agentprobe and write that number
//    into count.txt in the same folder"
//
// `isAssetCollectionGoal` returned TRUE, and the run did this:
//
//   write_file ~/Desktop/count-how-many-lines-are-txt-agentprobe-that/README.md
//   write_file ~/Desktop/count-how-many-lines-are-txt-agentprobe-that/overview.md
//     → "There are no lines in a text agent probe as it is a type of file format used for
//        storing agent information. It does not contain lines of text."
//   FINAL: "Wrote 2 document(s) to ~/Desktop/count-how-many-lines-are-txt-agentprobe-that"
//   agent_done ok:true · verify passed:true
//
// notes.txt was never opened, count.txt was never written, and the user got a junk folder of
// fabricated prose on their Desktop — reported as a success. Three tokens conspired:
//   · CREATION_RX  ← "write"
//   · CONTAINER_RX ← "notes", taken from the FILENAME `notes.txt`
//   · DESTINATION_RX ← "Desktop", taken from the PATH `~/Desktop/agentprobe`
//
// Two independent defects, fixed together:
//   1. A goal that names a SPECIFIC FILE is a file operation, never a collection build. This
//      is the same guard `specForGoal` already applies (see goalSpec.referencesFile) — it was
//      simply never applied here, so the two creation gates disagreed about the same message.
//   2. The container noun is read from PROSE. A directory called `notes` or `files` is
//      ordinary, and letting a path token supply the noun is the bug namedToolRouter's
//      `prose()` already fixed for the filesystem router.
//
// The destination is deliberately still read from the WHOLE message: "~/Desktop/collections"
// really does state a destination, and requiring the user to spell it in prose would break the
// goals this path exists to serve. Both directions are pinned below.

import { isAssetCollectionGoal } from './synthDriver'

let pass = 0, fail = 0
const failures: string[] = []
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) { pass++; return }
  fail++
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

// ── 1. WHAT IT MUST NOT SWALLOW ──────────────────────────────────────────────
console.log('\n== file operations are not collection builds ==')

const MUST_NOT_ROUTE = [
  // The exact live brief.
  'Count how many lines are in notes.txt in ~/Desktop/agentprobe and write that number into count.txt in the same folder',
  // The same shape, minus the counting.
  'write the total into ~/Desktop/results/count.txt',
  'read notes.txt on my desktop and write a summary into summary.txt in that folder',
  'create a file called report.md in ~/Documents/notes',
  // A filename supplies "files"/"notes" the same way; none of these want a researched folder.
  'generate config.yaml in ~/Desktop/deploy',
  'make data.csv in my downloads folder from the numbers above',
]
for (const goal of MUST_NOT_ROUTE) {
  check(`"${goal.slice(0, 52)}…" is NOT an asset collection`, isAssetCollectionGoal(goal) === false,
    'routed to the folder-of-documents builder — it will fabricate a README and never touch the named file')
}

// ── 2. THE FALSE-REJECT DIRECTION ────────────────────────────────────────────
// This path exists for these. Over-tightening it sends them back to the research solver, which
// answers a build request in prose ("I don't have the capability to create a folder").
console.log('\n== real collection goals still route ==')

const MUST_ROUTE = [
  // The canonical example from the gate's own docstring.
  'make a folder on my desktop with photos and descriptions of dog breeds from Italy',
  'create a folder in my documents with write-ups of the planets',
  'build a set of files on my desktop describing the roman emperors',
  // A destination stated as a PATH is still a destination — the user said where it goes.
  'make a folder in ~/Desktop/collections with photos and descriptions of cat breeds',
  'create dossiers about the apollo missions in ~/Documents',
]
for (const goal of MUST_ROUTE) {
  check(`"${goal.slice(0, 52)}…" still routes`, isAssetCollectionGoal(goal) === true,
    'declined — the collection builder is now unreachable for the goals it exists to serve')
}

// ── 3. A DIRECTORY NAMED `notes` OR `files` IS ORDINARY ──────────────────────
// The container noun comes from prose, so a path cannot smuggle one in.
console.log('\n== a path cannot supply the container noun ==')

const PATH_ONLY_NOUN = [
  // "files" and "notes" appear ONLY inside the path; the prose asks for one thing.
  'write the summary to ~/Desktop/files/out.md',
  'update ~/Desktop/notes/index.md on my desktop',
]
for (const goal of PATH_ONLY_NOUN) {
  check(`"${goal.slice(0, 46)}…" reads its nouns from prose`, isAssetCollectionGoal(goal) === false,
    'a directory name was read as the deliverable shape')
}

// ── 4. TOTALITY ──────────────────────────────────────────────────────────────
console.log('\n== the gate is total ==')
for (const goal of ['', '   ', '~', '/', 'a'.repeat(5000), '日本語', '\n\n', 'notes.txt']) {
  let ok = false, detail = ''
  try { ok = typeof isAssetCollectionGoal(goal) === 'boolean' }
  catch (e: any) { detail = `threw: ${e?.message}` }
  check(`handles ${JSON.stringify(goal.slice(0, 14))}`, ok, detail)
}

console.log(`\n${'─'.repeat(62)}`)
console.log(`asset-goal bench: ${pass}/${pass + fail} passed`)
if (failures.length) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log(`  ✗ ${f}`)
}
process.exit(fail === 0 ? 0 : 1)

// ═══════════════════════════════════════════════════════════════════════════════
// INTENT CLASSIFIER BENCH — is this message a TASK or is it CHAT?
// ═══════════════════════════════════════════════════════════════════════════════
//
// `classifyIntent` gates every request in server.ts, and until 2026-08-04 it had NO bench at
// all. The failure that prompted this one:
//
//   MEASURED (`npm run agent:workflow`, task `follow-up-turn`):
//     "Now add the word world to the end of that same file." -> conversational_reply
//
// A request to modify a file on disk was answered as conversation. No file-mutation verb —
// add, append, save, delete, rename — existed in ANY action-verb set in the classifier; they
// all described launching apps and browsing ("open", "play", "click"), the surface it was
// originally written for. Misrouting a mutation to chat is silent: the user is told something
// agreeable and nothing happens.
//
// The rule under test is deterministic: mutation verb + something to mutate = task.
// ═══════════════════════════════════════════════════════════════════════════════
import { classifyIntent } from './intentClassifier'

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}
const isTask = (m: string) => classifyIntent(m).intent !== 'conversational_reply'

// ── The measured regression ──────────────────────────────────────────────────────────
check('MEASURED (follow-up-turn): a back-referenced append is a TASK, not chat',
  isTask('Now add the word world to the end of that same file.'),
  JSON.stringify(classifyIntent('Now add the word world to the end of that same file.')))

// ── Mutation verbs the old action-verb sets all missed ───────────────────────────────
for (const m of [
  'append the line reviewed to log.txt',
  'save the results into total.txt',
  'delete config.json',
  'rename oldName to newName in a.js',
  'update the README.md with the new steps',
  'copy notes.md into the archive folder',
]) check(`mutation verb routes to a task: "${m}"`, isTask(m), JSON.stringify(classifyIntent(m)))

// ── The guard: a mutation verb with NOTHING to mutate is still chat ──────────────────
// Without this half the rule swallows ordinary conversation containing the word "add".
check('a mutation verb with no file is NOT forced into a task',
  !isTask('what would you add to make this better?'),
  JSON.stringify(classifyIntent('what would you add to make this better?')))
check('an opinion question mentioning a file extension is not a mutation',
  classifyIntent('do you think .csv or .json is the better format?').intent === 'conversational_reply',
  JSON.stringify(classifyIntent('do you think .csv or .json is the better format?')))

// ── Plain conversation is untouched ──────────────────────────────────────────────────
for (const m of ['thanks, that worked', 'what do you think about this approach?', 'why did that happen?']) {
  check(`plain conversation stays conversational: "${m}"`,
    classifyIntent(m).intent === 'conversational_reply', JSON.stringify(classifyIntent(m)))
}

console.log(`\nINTENT CLASSIFIER BENCH: ${pass}/${pass + fail}`)
if (fail) process.exit(1)

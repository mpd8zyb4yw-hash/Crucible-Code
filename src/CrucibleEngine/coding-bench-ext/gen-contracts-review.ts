// Generates CONTRACTS_REVIEW.md — the one-time HUMAN skim of every extended-corpus
// contract (user-requested). Machine checks prove ref/suite CONSISTENCY (corpus validator)
// and cross-formalism AGREEMENT (__refdiff_bench); neither can prove the intent was read
// correctly, because ref, suite, and oracles largely share an author. A human reading the
// contract and the suite's expectations side by side is the missing independent check.
//
// Generated from the shards so it cannot drift — never edit the .md by hand.
// Run: npx tsx src/CrucibleEngine/coding-bench-ext/gen-contracts-review.ts
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { EXT_TASKS } from './index'
import { MINED_TASKS } from './tasks-mined'
import { addedDiffLines } from './minedHarness'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(HERE, '../../../CONTRACTS_REVIEW.md')

const lines: string[] = []
lines.push('# Extended-corpus contract review (one-time human skim)')
lines.push('')
lines.push('> Why you are reading this: the reference solutions, hidden suites, and most of the')
lines.push('> differential oracles share an author (the same session). Machine checks prove they')
lines.push('> are CONSISTENT with each other; they cannot prove the task was UNDERSTOOD correctly.')
lines.push('> If a contract below reads wrong to you — semantics, error contract, or a suite')
lines.push('> expectation — edit the shard file (`src/CrucibleEngine/coding-bench-ext/tasks-*.ts`),')
lines.push('> then rerun `npm run taskcorpus:bench` and `npx tsx .../__refdiff_bench.ts`.')
lines.push('> Mark each task done by ticking its box. This file is GENERATED — edit shards, not this.')
lines.push('>')
lines.push('> For every task ALSO run the ADVERSARIAL READING: "what is the most reasonable')
lines.push('> implementation that would FAIL this suite?" If one exists, the contract is silent or')
lines.push('> self-contradictory at a boundary the suite tests — a correct-per-contract agent')
lines.push('> would be scored as a failure, which the machine checks structurally cannot see')
lines.push('> (ref, suite, and oracle share the same reading of the same prose). The 2026-07-21')
lines.push('> skim found all three corpus defects with exactly this question.')
lines.push('')
lines.push(`Corpus: ${EXT_TASKS.length} tasks. Review pass: [ ] not started / in progress / complete`)
lines.push('')

let i = 0
for (const t of EXT_TASKS) {
  i++
  lines.push(`---`)
  lines.push('')
  lines.push(`## ${i}. \`${t.id}\` — ${t.title}`)
  lines.push('')
  lines.push(`- [ ] semantics confirmed by a human`)
  lines.push(`- [ ] adversarial reading: no reasonable implementation of this contract fails this suite (or the boundary is now pinned in the prompt)`)
  lines.push('')
  lines.push('**Contract handed to the agent:**')
  lines.push('')
  lines.push('```')
  lines.push(t.prompt.trim())
  lines.push('```')
  lines.push('')
  lines.push('**What the hidden suite will hold it to:**')
  lines.push('')
  const labels = [...t.suite.matchAll(/(?:check|throws(?:Syn|Range|Type)?)\('([^']+)'/g)].map(m => m[1])
  for (const l of labels) lines.push(`- ${l}`)
  lines.push('')
}

// ── Mined tasks: the skim question is different — does the SYMPTOM PROMPT truthfully
// describe what the real commit fixed, without dictating the patch? Ref and suite are
// decorrelated by construction here (separate sessions, certified against live
// behavior), so the human check targets the one thing this session DID author: the
// prompt's reading of the historical bug.
lines.push('---')
lines.push('')
lines.push('# Git-mined tasks (W42.2) — prompt-vs-commit skim')
lines.push('')
lines.push('> For each task: read the symptom prompt, then the real fix commit it was derived')
lines.push('> from (command given per task). Confirm the prompt (a) states the symptom the diff')
lines.push('> actually fixes, (b) states the full expected contract the pinned bench enforces,')
lines.push('> and (c) never dictates the mechanism of the patch.')
lines.push('')
let j = 0
for (const t of MINED_TASKS) {
  j++
  const subject = spawnSync('git', ['log', '-1', '--format=%s', t.fixSha], { encoding: 'utf8' }).stdout.trim()
  lines.push('---')
  lines.push('')
  lines.push(`## M${j}. \`${t.id}\` — ${t.title}`)
  lines.push('')
  lines.push(`- [ ] prompt matches the commit, human-confirmed`)
  lines.push('')
  lines.push(`Real fix: \`${t.fixSha.slice(0, 12)}\` — “${subject}” (view: \`git show ${t.fixSha.slice(0, 12)}\`)`)
  lines.push('')
  lines.push('**Symptom prompt handed to the agent:**')
  lines.push('')
  lines.push('```')
  lines.push(t.prompt.trim())
  lines.push('```')
  lines.push('')
  lines.push('**Discriminating checks the fix commit added to the pinned bench:**')
  lines.push('')
  const added = addedDiffLines(t.parentSha, t.fixSha, t.benchPath)
  const labels = added.flatMap(l => [...l.matchAll(/\b(?:check|ok)\(\s*'([^']+)'/g)].map(m => m[1]))
  if (labels.length) for (const l of labels) lines.push(`- ${l}`)
  else lines.push('- (none added in-commit — discrimination proven by the certifier against the pre-existing suite)')
  lines.push('')
}

fs.writeFileSync(OUT, lines.join('\n'))
console.log(`wrote ${OUT} — ${EXT_TASKS.length} authored + ${MINED_TASKS.length} mined contracts, ready for the skim`)

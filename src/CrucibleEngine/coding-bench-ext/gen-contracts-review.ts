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
import { fileURLToPath } from 'url'
import { EXT_TASKS } from './index'

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

fs.writeFileSync(OUT, lines.join('\n'))
console.log(`wrote ${OUT} — ${EXT_TASKS.length} contracts, ready for the skim`)

// Extended coding-bench corpus barrel (W42).
//
// EXT_TASKS grows the GENERATED-path benchmark from n=10 to n=32 — the number that
// decides whether any measured improvement is real. Enrollment into the live harness is
// one additive line in coding-benchmarks.ts (Track A owns that file):
//
//   import { toBenchTasks } from './coding-bench-ext'
//   const TASKS: Task[] = [ ...existing, ...toBenchTasks() ]
//
// The hidden suites are synced to coding-bench/<id>.hidden.ts by the corpus validator
// (__taskcorpus_bench.ts) — the exact location the harness already reads — so until the
// line above lands, the new suites are inert files.

import type { ExtTask } from './tasks-strings'
import { STRING_TASKS } from './tasks-strings'
import { STRUCTURE_TASKS } from './tasks-structures'
import { LOGIC_TASKS } from './tasks-logic'
import { NUMERIC_TASKS } from './tasks-numeric'

export type { ExtTask }

export const EXT_TASKS: ExtTask[] = [
  ...STRING_TASKS,
  ...STRUCTURE_TASKS,
  ...LOGIC_TASKS,
  ...NUMERIC_TASKS,
]

/** The agent-facing shape used by coding-benchmarks.ts — ref and suite deliberately absent. */
export function toBenchTasks(): Array<{ id: string; title: string; modulePath: string; prompt: string }> {
  return EXT_TASKS.map(({ id, title, modulePath, prompt }) => ({ id, title, modulePath, prompt }))
}

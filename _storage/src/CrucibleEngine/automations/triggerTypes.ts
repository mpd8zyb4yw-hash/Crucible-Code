// ── The Trigger shape, and nothing else ────────────────────────────────────────
// Extracted from store.ts 2026-08-04c so the BROWSER can share it.
//
// store.ts opens `fs` and `path` at module scope. A type-only import does not emit a
// runtime require, but TypeScript still type-CHECKS the imported file — so the moment the
// Automations UI imported a Trigger from store.ts, the app build started failing on
// `Cannot find name 'fs'`. The alternative (declaring a second, structurally identical
// Trigger union in the UI) is exactly the kind of quiet duplication that drifts: the
// engine gained a 'weekdays' kind the UI never learned about, and an automation already
// on disk using it would have rendered a blank schedule.
//
// One declaration, imported by both sides. Pure types — this file must never gain a
// runtime import.

export type Trigger =
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily'; time: string }                 // 'HH:MM', server-local time
  | { kind: 'weekly'; day: number; time: string }   // day: 0=Sunday … 6=Saturday
  | { kind: 'weekdays'; time: string }              // Mon-Fri at 'HH:MM'
  | { kind: 'once'; at: number }                    // epoch ms

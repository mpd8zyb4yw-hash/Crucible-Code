// ============================================================================
// Gate-ran / gate-skipped telemetry for fail-open critics (open item 3, 2026-07-04).
//
// Motivation (see NEXT_SESSION.md §4 pattern): twice now a fail-open gate went dark
// with zero signal — Gate A2 silently skipping when its parser couldn't load looked
// identical, from the outside, to Gate A2 passing everything. A fail-open gate that
// never runs is indistinguishable from a working one unless it says so somewhere.
//
// Contract:
// - Every fail-open critic calls recordGate() at the moment it decides ran vs skipped.
// - Append-only JSONL at .crucible/gate-telemetry.jsonl, best-effort — telemetry must
//   never break the pipeline it observes (same discipline as fm-rounds.jsonl).
// - First skip per gate per process additionally console.warns, so a gate that is
//   dark for the whole session is visible in the server log, not just the ledger.
// ============================================================================
import fs from 'fs'
import path from 'path'

export interface GateRecord {
  gate: string            // stable id, e.g. 'gateA2_lint', 'grounding', 'harden'
  ran: boolean            // false = the critic skipped / failed open
  reason?: string         // why it skipped (or a short outcome note when it ran)
}

const warned = new Set<string>()

export function recordGate(rec: GateRecord): void {
  if (!rec.ran && !warned.has(rec.gate)) {
    warned.add(rec.gate)
    console.warn(`[gate-telemetry] fail-open gate '${rec.gate}' SKIPPED (${rec.reason ?? 'no reason given'}) — it is providing no protection this session`)
  }
  try {
    const dir = path.join(process.cwd(), '.crucible')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'gate-telemetry.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n')
  } catch { /* best-effort — never break the pipeline being observed */ }
}

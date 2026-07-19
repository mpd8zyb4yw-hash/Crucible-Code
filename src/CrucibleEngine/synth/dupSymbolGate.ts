// ============================================================================
// Gate A3 — cross-file duplicate exported-symbol critic.
//
// Found by READING the first tier-2 pass (cont.101, rename-field-across-layers). That run
// scored a mechanical TRUE — the rename was genuinely correct — but the artifact was bloated
// with whole duplicate copies of other modules' symbols: `src/types.ts` carried its own
// `isValidItem`, `renderItem` AND `Store`, and `src/report.ts` carried a second `Store` plus
// free functions referencing `this.items` at module scope. All of it tsc-legal, none of it
// imported by the test, so nothing in the stack rejected it.
//
// The de-loop guard (stripDegenerateRepetition) structurally CANNOT see this: those are
// distinct declarations within one emission, not a repeated line. This gate is the cross-file
// view that was missing — on a refactor, a symbol exported from two modules at once means the
// model copied a module instead of importing it, and module ownership is ambiguous.
//
// Design constraints, same as Gate A2 (lintGate):
// - Pure in-process line scan, no parser, no subprocess, no network.
// - Only EXPORTED declarations count. Two modules with a same-named private helper is
//   ordinary code; two modules EXPORTING the same name during a refactor is the copy bug.
// - Only fires when a CANDIDATE file is one of the duplicating parties. Pre-existing
//   duplication in untouched project context is not this candidate's fault and must not
//   block it — that would make the gate unreachable on any repo that already has some.
// - Fails OPEN on anything unexpected; Gate B still stands behind it.
//
// MEASURED BEFORE WIRING (cont.85 discipline — a verifier fails in two directions):
// run over all 16 corpus tasks in both the known-correct `sanity` variant and the `live`
// variant of run 33753 — 0 false positives on 32 clean artifacts, and it fired on exactly
// the one dirty artifact, naming all three duplications. See __dupSymbolGate_bench.ts.
// ============================================================================
import fs from 'fs'
import type { SynthFile } from './synthEngine'
import { recordGate } from '../debug/gateTelemetry'

export interface DupSymbolVerdict {
  ok: boolean
  detail: string        // '' when ok; the duplication formatted for the retry prompt otherwise
  ran: boolean
}

/** Exported top-level declarations, by name. Line-anchored: nested/indented decls don't count. */
const EXPORT_DECL = /^export\s+(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([A-Za-z_$][\w$]*)/

export function exportedDeclNames(src: string): Set<string> {
  const out = new Set<string>()
  for (const line of src.split('\n')) {
    const m = line.match(EXPORT_DECL)
    if (m) out.add(m[1])
  }
  return out
}

/**
 * Reject when a candidate file exports a top-level symbol that another file in the same
 * change-set also exports. `contextFiles` is the oracle's own `{ src, rel }` shape — `src`
 * is the absolute path on disk, `rel` the path it is staged at.
 */
export function checkDuplicateExports(
  files: SynthFile[],
  contextFiles?: Array<{ src: string; rel: string }>,
): DupSymbolVerdict {
  try {
    const candidatePaths = new Set(files.map(f => f.path))
    const owners = new Map<string, string[]>()
    const add = (p: string, src: string) => {
      for (const name of exportedDeclNames(src)) {
        const a = owners.get(name) ?? []
        if (!a.includes(p)) a.push(p)
        owners.set(name, a)
      }
    }
    for (const f of files) if (/\.tsx?$/.test(f.path)) add(f.path, f.content)
    for (const c of contextFiles ?? []) {
      // A candidate file SUPERSEDES its project version — scanning both would report every
      // in-place edit as a duplicate of itself.
      if (!/\.tsx?$/.test(c.rel) || candidatePaths.has(c.rel)) continue
      let content = ''
      try { content = fs.readFileSync(c.src, 'utf8') } catch { continue }
      add(c.rel, content)
    }

    for (const [name, where] of owners) {
      // Only a duplication the CANDIDATE participates in is this candidate's problem.
      if (where.length > 1 && where.some(p => candidatePaths.has(p))) {
        recordGate({ gate: 'gateA3_dupsymbol', ran: true, reason: `rejected: ${name}` })
        return {
          ok: false, ran: true,
          detail: `duplicate exported symbol '${name}' declared in ${where.join(' and ')} — `
            + `each symbol must live in exactly one module; import it from its owner instead of re-declaring it`,
        }
      }
    }
    recordGate({ gate: 'gateA3_dupsymbol', ran: true, reason: 'clean' })
    return { ok: true, detail: '', ran: true }
  } catch {
    // Fail OPEN — never let this gate break synthesis.
    recordGate({ gate: 'gateA3_dupsymbol', ran: false, reason: 'gate threw' })
    return { ok: true, detail: '', ran: false }
  }
}

// Deterministic-refactor router, extracted from server.ts so the detection + planning + messaging
// is testable in isolation (no fs, no SSE, no session state). planRefactor() takes the user's
// message and a snapshot of the project (project-relative path → content) and returns a normalized
// outcome the server applies: which files to write/delete, what to stream, and the final answer.
//
// Every refactor here is DETERMINISTIC (zero model calls), all-or-nothing, and esbuild-compile-
// verified inside the plan* functions. On a SAFETY abstain (the intent is real but can't be done
// safely) the outcome is a `refused` terminal — the server ends the turn honestly rather than
// letting the FM attempt a risky/destructive edit. On a parse-miss / symbol-not-found it is a
// non-terminal `fallthrough` (emit a diagnostic thought, let the normal pipeline continue).
import {
  detectDelete, detectMove, detectMoveFile, detectMoveToOnly, detectPruneImports,
  detectPruneImportsAll, detectRename, detectTargetPath, findDefiningFile,
  planDeleteTree, planMoveFileTree, planMoveTree, planPruneImports, planRenameTree,
} from '../CrucibleEngine/reasoning/emitPlan'

export interface RefactorWrite { rel: string; content: string; mode: 'create' | 'append' | 'modify' | 'delete'; detail: string }

export interface RefactorOutcome {
  /** Which refactor fired — 'move' | 'prune' | 'prune-all' | 'delete' | 'move-file' | 'rename'. */
  kind: string
  /** terminal → the server sets handled=true; !terminal → emit thoughts only and continue. */
  terminal: boolean
  /** Pre-emit narration (inference notes, hand-off diagnostics). */
  thoughts: string[]
  /** Files to write (mode create/modify) or remove (mode delete). Empty for refusals/noops. */
  writes: RefactorWrite[]
  /** Prefix for the per-write tool_call/tool_result event ids, e.g. 'vgr_move'. */
  toolIdPrefix: string
  /** Prefix for the tool_result output text, e.g. 'Move refactor'. */
  outputLabel: string
  /** The compile verify event, or null to skip (fallthrough). */
  verify: { passed: boolean; report: string } | null
  /** Final answer text, or null (fallthrough). */
  answer: string | null
  /** meta for the `final` event. */
  meta: Record<string, unknown>
  /** promptType for historyPush, or null to skip (noop / refusal-without-history). */
  historyType: string | null
}

/** Word-boundary presence test for an identifier that may contain regex metacharacters. */
function definesSymbol(content: string, id: string): boolean {
  return new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(content)
}

const fall = (thoughts: string[]): RefactorOutcome => ({
  kind: 'fallthrough', terminal: false, thoughts, writes: [], toolIdPrefix: '', outputLabel: '',
  verify: null, answer: null, meta: {}, historyType: null,
})

/**
 * Decide whether `message` is a deterministic refactor and, if so, plan it against `files` (a
 * project snapshot: project-relative path → content). Returns null when it isn't a refactor at all.
 * The checks run in the same order as the original server.ts blocks (move → prune → prune-all →
 * delete → move-file → rename); the first that matches wins.
 */
export async function planRefactor(
  message: string, files: Record<string, string>,
): Promise<RefactorOutcome | null> {
  const nl = message ?? ''
  const siblingsExcept = (...excluded: string[]) => {
    const out: Record<string, string> = {}
    for (const [rel, c] of Object.entries(files)) if (!excluded.includes(rel)) out[rel] = c
    return out
  }

  // ── MOVE a function (with optional source inference for the "move X to B" form) ──
  {
    let mov = detectMove(nl)
    const thoughts: string[] = []
    if (!mov) {
      const mto = detectMoveToOnly(nl)
      if (mto) {
        const src = findDefiningFile(mto.entry, files)
        if (src && src !== mto.toPath) {
          mov = { entry: mto.entry, fromPath: src, toPath: mto.toPath }
          thoughts.push(`No source named — ${mto.entry} is defined uniquely in ${src}; moving from there.`)
        }
      }
    }
    if (mov) {
      const fromExisting = files[mov.fromPath] ?? null
      if (fromExisting != null) {
        const toExisting = files[mov.toPath] ?? null
        const tree = await planMoveTree(mov.entry, mov.fromPath, mov.toPath, fromExisting, toExisting, siblingsExcept(mov.fromPath, mov.toPath))
        if (tree) {
          const writes = [tree.primary, ...tree.propagated]
          return {
            kind: 'move', terminal: true, thoughts, writes, toolIdPrefix: 'vgr_move', outputLabel: 'Move refactor',
            verify: { passed: true, report: `Move ${mov.entry}: ${mov.fromPath} → ${mov.toPath} across ${writes.length} file(s), each recompiles — ${tree.notes.join('; ')}` },
            answer: `Moved ${mov.entry} from ${mov.fromPath} to ${mov.toPath} across ${writes.length} file(s) — definition relocated, imports carried, and every importer repointed; each file recompiles. Zero model calls.`,
            meta: { moveRefactor: true, entry: mov.entry, from: mov.fromPath, to: mov.toPath, files: writes.map(w => w.rel), confidence: 1 },
            historyType: 'agent-move',
          }
        }
        if (definesSymbol(fromExisting, mov.entry)) {
          return {
            kind: 'move', terminal: true, thoughts, writes: [], toolIdPrefix: 'vgr_move', outputLabel: 'Move refactor',
            verify: { passed: false, report: `Move ${mov.entry} refused — not safely relocatable.` },
            answer: `I won't move ${mov.entry} from ${mov.fromPath} to ${mov.toPath}: it can't be relocated safely — it depends on a source-local declaration that wouldn't exist at the destination, the destination already defines that name, or the result wouldn't compile. Make ${mov.entry} self-contained (or resolve the collision) first.`,
            meta: { moveRefactor: true, refused: true, entry: mov.entry, from: mov.fromPath, to: mov.toPath, confidence: 1 },
            historyType: 'agent-move',
          }
        }
        return fall([...thoughts, `Move ${mov.entry} (${mov.fromPath} → ${mov.toPath}) could not be applied — ${mov.entry} isn't defined in ${mov.fromPath}; handing off.`])
      }
    }
  }

  // ── PRUNE unused imports from ONE named file ──
  {
    const prune = detectPruneImports(nl)
    if (prune) {
      const existing = files[prune.targetPath] ?? null
      if (existing != null) {
        const tree = await planPruneImports(prune.targetPath, existing)
        if (tree) {
          return {
            kind: 'prune', terminal: true, thoughts: [], writes: [tree.primary], toolIdPrefix: 'vgr_prune', outputLabel: 'Prune imports',
            verify: { passed: true, report: `${tree.notes.join('; ')}; file recompiles.` },
            answer: `${tree.primary.detail} — the file still compiles. Zero model calls.`,
            meta: { pruneImports: true, target: prune.targetPath, confidence: 1 },
            historyType: 'agent-prune-imports',
          }
        }
        return {
          kind: 'prune', terminal: true, thoughts: [], writes: [], toolIdPrefix: 'vgr_prune', outputLabel: 'Prune imports',
          verify: null,
          answer: `No unused imports to remove in ${prune.targetPath} — every import is referenced.`,
          meta: { pruneImports: true, target: prune.targetPath, noop: true, confidence: 1 },
          historyType: null,
        }
      }
    }
  }

  // ── PRUNE unused imports PROJECT-WIDE ──
  if (detectPruneImportsAll(nl)) {
    const writes: RefactorWrite[] = []
    let totalRemoved = 0
    for (const [rel, content] of Object.entries(files)) {
      const tree = await planPruneImports(rel, content)
      if (!tree) continue
      writes.push(tree.primary)
      totalRemoved += Number(/removed (\d+)/.exec(tree.primary.detail)?.[1] ?? 0)
    }
    const rels = writes.map(w => w.rel)
    return {
      kind: 'prune-all', terminal: true, thoughts: [], writes, toolIdPrefix: 'vgr_pruneall', outputLabel: 'Prune imports',
      verify: { passed: true, report: `Pruned unused imports across ${rels.length} file(s); each recompiles.` },
      answer: rels.length
        ? `Removed ${totalRemoved} unused import(s) across ${rels.length} file(s): ${rels.join(', ')}. Each file still compiles. Zero model calls.`
        : `No unused imports found anywhere in the project — nothing to remove.`,
      meta: { pruneImports: true, projectWide: true, files: rels, removed: totalRemoved, confidence: 1 },
      historyType: 'agent-prune-imports-all',
    }
  }

  // ── DELETE a dead export (safe: refuses if still used) ──
  {
    const del = detectDelete(nl)
    if (del) {
      const existing = files[del.targetPath] ?? null
      if (existing != null) {
        const tree = await planDeleteTree(del.entry, del.targetPath, existing, siblingsExcept(del.targetPath))
        if (tree) {
          const writes = [tree.primary, ...tree.propagated]
          return {
            kind: 'delete', terminal: true, thoughts: [], writes, toolIdPrefix: 'vgr_del', outputLabel: 'Delete refactor',
            verify: { passed: true, report: `Delete ${del.entry} from ${del.targetPath} across ${writes.length} file(s), each recompiles — ${tree.notes.join('; ')}` },
            answer: `Deleted ${del.entry} from ${del.targetPath}${writes.length > 1 ? ` and cleaned up ${writes.length - 1} dead import(s)` : ''} — verified unused first (no file references it), each file recompiles. Zero model calls.`,
            meta: { deleteRefactor: true, entry: del.entry, target: del.targetPath, files: writes.map(w => w.rel), confidence: 1 },
            historyType: 'agent-delete',
          }
        }
        if (definesSymbol(existing, del.entry)) {
          return {
            kind: 'delete', terminal: true, thoughts: [], writes: [], toolIdPrefix: 'vgr_del', outputLabel: 'Delete refactor',
            verify: { passed: false, report: `Delete ${del.entry} refused — symbol is still in use.` },
            answer: `I won't delete ${del.entry} from ${del.targetPath}: it's still referenced (used elsewhere in the file, imported and used by another module, or re-exported). Removing it would break those call sites. Remove or update the usages first, then delete it.`,
            meta: { deleteRefactor: true, refused: true, entry: del.entry, target: del.targetPath, confidence: 1 },
            historyType: 'agent-delete',
          }
        }
        return fall([`Delete ${del.entry} from ${del.targetPath} could not be applied (${del.entry} isn't defined there) — handing off.`])
      }
    }
  }

  // ── MOVE a whole FILE (re-path own imports + repoint importers + delete old) ──
  {
    const mvf = detectMoveFile(nl)
    if (mvf) {
      const existing = files[mvf.fromPath] ?? null
      const destExists = files[mvf.toPath] != null
      if (existing != null) {
        const tree = await planMoveFileTree(mvf.fromPath, mvf.toPath, existing, siblingsExcept(mvf.fromPath, mvf.toPath), destExists)
        if (tree) {
          const writes = [tree.primary, ...tree.propagated]
          return {
            kind: 'move-file', terminal: true, thoughts: [], writes, toolIdPrefix: 'vgr_mvf', outputLabel: 'Move-file refactor',
            verify: { passed: true, report: `Move file ${mvf.fromPath} → ${mvf.toPath} across ${writes.length} file(s), each recompiles — ${tree.notes.join('; ')}` },
            answer: `Moved ${mvf.fromPath} to ${mvf.toPath} — the file's own relative imports were re-pathed and every importer repointed (${writes.length} file(s) touched); each recompiles. Zero model calls.`,
            meta: { moveFileRefactor: true, from: mvf.fromPath, to: mvf.toPath, files: writes.map(w => w.rel), confidence: 1 },
            historyType: 'agent-move-file',
          }
        }
        if (destExists) {
          return {
            kind: 'move-file', terminal: true, thoughts: [], writes: [], toolIdPrefix: 'vgr_mvf', outputLabel: 'Move-file refactor',
            verify: { passed: false, report: `Move file refused — destination exists.` },
            answer: `I won't move ${mvf.fromPath} to ${mvf.toPath}: the destination already exists. Choose a path that doesn't, or delete the existing file first.`,
            meta: { moveFileRefactor: true, refused: true, from: mvf.fromPath, to: mvf.toPath, confidence: 1 },
            historyType: null,
          }
        }
        return fall([`Move file ${mvf.fromPath} → ${mvf.toPath} could not be applied safely (a self-referential import or a non-compiling result) — handing off.`])
      }
    }
  }

  // ── RENAME a symbol (with target inference when unnamed) ──
  {
    const ren = detectRename(nl)
    if (ren) {
      const named = detectTargetPath(nl)
      const renTarget = (named && files[named] != null && definesSymbol(files[named], ren.from))
        ? named : findDefiningFile(ren.from, files)
      const existing = renTarget ? files[renTarget] ?? null : null
      if (renTarget && existing != null) {
        const thoughts = named ? [] : [`No file named — ${ren.from} is defined uniquely in ${renTarget}; renaming there.`]
        const tree = await planRenameTree(ren.from, ren.to, renTarget, existing, siblingsExcept(renTarget))
        if (tree) {
          const writes = [tree.primary, ...tree.propagated]
          return {
            kind: 'rename', terminal: true, thoughts, writes, toolIdPrefix: 'vgr_rename', outputLabel: 'Rename refactor',
            verify: { passed: true, report: `Rename ${ren.from} → ${ren.to} across ${writes.length} file(s), each recompiles — ${tree.notes.join('; ')}` },
            answer: `Renamed ${ren.from} → ${ren.to} across ${writes.length} file(s) — definition, imports, and call sites updated (alias-preserving); every file recompiles. Zero model calls.`,
            meta: { renameRefactor: true, from: ren.from, to: ren.to, files: writes.map(w => w.rel), confidence: 1 },
            historyType: 'agent-rename',
          }
        }
        if (definesSymbol(existing, ren.from)) {
          return {
            kind: 'rename', terminal: true, thoughts, writes: [], toolIdPrefix: 'vgr_rename', outputLabel: 'Rename refactor',
            verify: { passed: false, report: `Rename ${ren.from} → ${ren.to} refused — an unsafe use or a name collision.` },
            answer: `I won't rename ${ren.from} → ${ren.to}: it can't be done safely — ${ren.from} appears in a position I can't rewrite with certainty (a bare value reference, object shorthand, a shadowing binding, a conflicting alias, or ${ren.to} already exists). Renaming would risk leaving call sites or importers dangling.`,
            meta: { renameRefactor: true, refused: true, from: ren.from, to: ren.to, confidence: 1 },
            historyType: 'agent-rename',
          }
        }
        return fall([...thoughts, `Rename ${ren.from} → ${ren.to} could not be applied — ${ren.from} isn't defined in ${renTarget}; handing off.`])
      }
    }
  }

  return null
}

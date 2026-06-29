// Tier 2.3 — Relevance-ranked context assembly.
//
// buildRepoContext (Phase C) ranks files by tf-cosine alone. That misses the
// structural truth the Tier 1.2 semantic index now knows: a file that IMPORTS the
// target, or DEFINES a type the target depends on, is relevant even when its bag of
// words barely overlaps the goal. This module fuses both signals — lexical (tf) and
// structural (import/type/call graph) — ranks the union, and assembles a single,
// budget-fit context block with the highest-value material first.
//
// Allocation discipline (a HARD char budget, never exceeded):
//   1. target file(s) current content      — always first, the thing being changed
//   2. structurally-related files           — content if small, else a symbol summary
//   3. retrieved internet grounding (1.3)    — whatever budget remains
//
// Pure + deterministic + no model. Operates on the two on-disk indexes; both are
// built/refreshed here so a caller only needs the project path.

import fs from 'fs'
import path from 'path'
import { ensureIndex, searchIndex } from './state/codebaseIndex'
import {
  ensureSemanticIndex, relatedFiles, importersOf, importsOf, symbolsInFile,
  typeChain, summarizeFile, findSymbol, type SemanticIndex,
} from './state/semanticIndex'

export type ContextReason = 'target' | 'tf-match' | 'imports-target' | 'imported-by-target' | 'type-dep' | 'related'
export type ContextKind = 'target' | 'related' | 'retrieved'

export interface ContextItem {
  rel: string
  score: number
  reasons: ContextReason[]
  kind: ContextKind
}

export interface AssembledContext {
  block: string
  items: ContextItem[]
  usedChars: number
}

export interface AssembleOptions {
  projectPath: string
  goal: string
  targetFiles?: string[]
  /** Pre-built semantic index; built from projectPath if omitted. */
  semanticIndex?: SemanticIndex
  /** Pre-processed internet grounding (Tier 1.3) to append within budget. */
  retrievalBlock?: string
  /** Hard ceiling on the assembled block, in chars. Default 6000. */
  budget?: number
  /** Max related files to include. Default 8. */
  maxRelated?: number
}

// Structural-proximity boosts, added on top of the tf-cosine base score.
const BOOST = {
  importsTarget: 0.40,     // candidate imports the target (will see its changes)
  importedByTarget: 0.35,  // target imports candidate (its contracts constrain the change)
  typeDep: 0.30,           // candidate defines a type the target depends on
  related: 0.15,           // generically graph-adjacent
}
const SMALL_FILE = 2500    // include full content below this size, else summarize

export function assembleContext(opts: AssembleOptions): AssembledContext {
  const root = path.resolve(opts.projectPath)
  const budget = opts.budget ?? 6000
  const maxRelated = opts.maxRelated ?? 8
  const targets = (opts.targetFiles ?? []).map(t => t.replace(/^\.\//, ''))
  const targetSet = new Set(targets)

  const fileIdx = ensureIndex(root)
  const semIdx = opts.semanticIndex ?? ensureSemanticIndex(root)

  // ── Score candidates: tf base + structural boosts ──────────────────────────────
  const scores = new Map<string, { score: number; reasons: Set<ContextReason> }>()
  const bump = (rel: string, delta: number, reason: ContextReason) => {
    if (targetSet.has(rel)) return  // targets are handled separately, never as "related"
    const e = scores.get(rel) ?? { score: 0, reasons: new Set<ContextReason>() }
    e.score += delta; e.reasons.add(reason); scores.set(rel, e)
  }

  // Lexical signal.
  for (const e of searchIndex(fileIdx, opts.goal, 12)) {
    const sim = Math.max(0, Math.min(1, /* cosine already in [0,1] */ scoreOf(fileIdx, e.rel, opts.goal)))
    bump(e.rel, sim, 'tf-match')
  }

  // Structural signal, anchored on each target.
  for (const t of targets) {
    for (const r of importersOf(semIdx, t)) bump(r, BOOST.importsTarget, 'imports-target')
    for (const r of importsOf(semIdx, t)) bump(r, BOOST.importedByTarget, 'imported-by-target')
    for (const r of relatedFiles(semIdx, t)) bump(r, BOOST.related, 'related')
    // Type-dependency: files defining a type the target's symbols reach.
    for (const s of symbolsInFile(semIdx, t)) {
      for (const dep of typeChain(semIdx, s.name)) {
        for (const loc of findSymbol(semIdx, dep)) bump(loc.rel, BOOST.typeDep, 'type-dep')
      }
    }
  }

  const ranked: ContextItem[] = [...scores.entries()]
    .map(([rel, e]) => ({ rel, score: +e.score.toFixed(4), reasons: [...e.reasons], kind: 'related' as ContextKind }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxRelated)

  // ── Assemble within budget ─────────────────────────────────────────────────────
  const items: ContextItem[] = []
  const parts: string[] = []
  let used = 0
  const room = () => budget - used
  const push = (text: string) => { parts.push(text); used += text.length }

  // 1. Targets first (highest priority).
  for (const t of targets) {
    const abs = path.join(root, t)
    let content: string | null = null
    try { content = fs.readFileSync(abs, 'utf-8') } catch { /* new file */ }
    items.push({ rel: t, score: Infinity, reasons: ['target'], kind: 'target' })
    if (content && room() > 200) {
      const slice = content.length > room() - 100 ? content.slice(0, Math.max(0, room() - 100)) + '\n// … (truncated)' : content
      push(`TARGET FILE (${t}):\n${slice}\n`)
    } else {
      push(`TARGET FILE (${t}): ${content ? '(omitted — budget)' : '(new file)'}\n`)
    }
  }

  // 2. Related files — content if small + budget allows, else a structural summary.
  for (const item of ranked) {
    if (room() < 150) break
    const abs = path.join(root, item.rel)
    let size = Infinity
    try { size = fs.statSync(abs).size } catch { /* may be missing */ }
    const why = item.reasons.join(',')
    if (size <= SMALL_FILE && size < room() - 120) {
      const content = fs.readFileSync(abs, 'utf-8')
      push(`RELATED (${item.rel}) [${why}, score ${item.score}]:\n${content.trimEnd()}\n`)
    } else {
      const summary = summarizeFile(semIdx, item.rel) || `${item.rel}`
      const block = `RELATED (${item.rel}) [${why}, score ${item.score}]:\n${summary}\n`
      if (block.length < room()) push(block)
    }
    items.push(item)
  }

  // 3. Retrieved internet grounding, whatever budget remains.
  if (opts.retrievalBlock && room() > 200) {
    const slice = opts.retrievalBlock.length > room() - 50
      ? opts.retrievalBlock.slice(0, room() - 50) + '\n… (truncated)'
      : opts.retrievalBlock
    push(slice + '\n')
    items.push({ rel: '(internet)', score: 0, reasons: ['related'], kind: 'retrieved' })
  }

  return { block: parts.join('\n'), items, usedChars: used }
}

// Cosine of the goal against a specific file entry's stored vector. Kept local so we
// don't re-tokenize the whole index — searchIndex already filtered to candidates.
function scoreOf(idx: ReturnType<typeof ensureIndex>, rel: string, goal: string): number {
  const entry = idx.entries.find(e => e.rel === rel)
  if (!entry) return 0
  // Reuse the index's own vector space via a tiny tf vector of the goal.
  const qv: Record<string, number> = {}
  const toks = (goal.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])
  for (const t of toks) qv[t] = (qv[t] ?? 0) + 1
  const total = toks.length || 1
  for (const k in qv) qv[k] /= total
  let dot = 0, na = 0, nb = 0
  for (const [k, w] of Object.entries(qv)) { na += w * w; if (entry.vec[k]) dot += w * entry.vec[k] }
  for (const w of Object.values(entry.vec)) nb += w * w
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

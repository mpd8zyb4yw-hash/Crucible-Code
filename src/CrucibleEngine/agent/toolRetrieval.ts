// ── Finding the right tool by MEANING, not by regex (cont.119) ────────────────
//
// This session hand-fixed FOUR enumerative gates, every one of which decided whether a request
// could reach a tool, and every one of which was a list of words:
//
//   · `isDesktopActionGoal` — `^(open|close|launch|…)`, so "take a screenshot of my screen" was
//     interrogated for a file to edit and got zero tool calls.
//   · `needsToolExecutor` — three special cases, so the only executor that calls tools was skipped
//     and a 1.5B model answered with instructions to press Win+Space on a Mac.
//   · `detectAgentTask` — ~25 regexes; "take a screenshot" matches none of them.
//   · `statedSubject` — four prepositions, and the request used a fifth.
//
// Each fix was correct and none of them is the ANSWER, because the answer cannot be a better list.
// The set of ways a person can ask for a screenshot is unbounded; the set of tools is not, and
// every tool already carries a description written as a trigger ("Use whenever the user asks to
// screenshot, capture, or grab an image of what is on screen"). Those descriptions are the
// intended semantics, sitting unused while regexes guess at the same thing.
//
// So: embed the descriptions once, embed the request, and rank. On-device MiniLM, no API, and it
// generalises to any tool added later without anyone editing a router.
//
// DELIBERATELY ADVISORY. This does not replace the existing gates and must not be wired as a
// silent override — a retrieval score is evidence, not a verdict, and the honest use is to OPEN a
// gate that would otherwise have stayed shut, never to close one that would have opened.

import { embed, cosineSimilarity } from '../masterpiece/corpus/embed'
import { registry } from '../tools/registry'
import type { ToolDef } from '../tools/protocol'

export interface ToolMatch {
  name: string
  score: number
}

/** Tool-name → embeddings of its trigger CLAUSES. Built once; tools register at import time. */
let index: Array<{ name: string; vecs: Float32Array[] }> | null = null
let building: Promise<void> | null = null

/**
 * The trigger CLAUSES of a tool, embedded separately.
 *
 * One vector per tool averages its whole description, and the average is what lost: "sign me in to
 * youtube" ranked `search_youtube` first, because several descriptions mention YouTube and the
 * mention diluted the one clause that was actually about signing in. Splitting on sentences and
 * scoring each independently lets a single precise clause win on its own merit.
 *
 * The name is included as its own clause with underscores stripped — snake_case tokenises badly
 * inside a sentence but "browser sign in" is a perfectly good short trigger by itself. Parameter
 * names are excluded: they describe the CALL, not the request, and including them pulled every
 * request toward whichever tool had the most parameters.
 */
function triggerClausesOf(def: ToolDef): string[] {
  const sentences = def.description
    .split(/(?<=[.!?])\s+/)
    .map(x => x.trim())
    .filter(x => x.length > 12)
  return [def.name.replace(/_/g, ' '), ...sentences].slice(0, 8)
}

export async function buildToolIndex(): Promise<void> {
  if (index) return
  if (building) return building
  building = (async () => {
    const defs = registry.list()
    const built: Array<{ name: string; vecs: Float32Array[] }> = []
    for (const def of defs) {
      try {
        const vecs: Float32Array[] = []
        for (const clause of triggerClausesOf(def)) vecs.push(await embed(clause))
        if (vecs.length) built.push({ name: def.name, vecs })
      } catch { /* one tool failing to embed must not sink the index */ }
    }
    index = built
  })()
  await building
  building = null
}

/**
 * Tools whose declared purpose most resembles this request, best first.
 *
 * Returns [] rather than throwing when the embedder is unavailable — every caller is expected to
 * treat an empty result as "no opinion" and fall back to whatever it did before.
 */
export async function retrieveTools(goal: string, k = 5): Promise<ToolMatch[]> {
  const g = (goal ?? '').trim()
  if (!g) return []
  try {
    await buildToolIndex()
    if (!index?.length) return []
    const q = await embed(g)
    // MAX over clauses, not mean: a tool is a match if ANY of the things it says it is for
    // matches the request. Averaging punishes a tool for also being good at something else.
    return index
      .map(t => ({ name: t.name, score: Math.max(...t.vecs.map(v => cosineSimilarity(q, v))) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
  } catch {
    return []
  }
}

/**
 * Read-only tools worth OFFERING alongside a hand-picked set, best first.
 *
 * MEASURED (`__toolretrieval_bench.ts`), and the numbers decide the shape of this:
 *   top-1 39%, top-3 89%, and a no-tool request can still score 0.32.
 * So this is a good CANDIDATE GENERATOR and a bad picker, and a worse binary gate. It must never
 * choose the tool or decide whether tools are needed — the executor picks from the candidates,
 * which is the job a model is actually good at.
 *
 * Two exclusions, both protecting a failure already paid for:
 *   · `mutates` tools are never added. A retrieval score is not consent to delete, send or buy;
 *     anything that changes the world stays on a path someone deliberately chose.
 *   · the caller's existing list wins — this only ever ADDS, so a curated set cannot be eroded.
 *     In particular GUI-control tools stay gated on desktop intent, since offering them to a
 *     non-GUI brief is what made the planner emit screen dumps (cont.105).
 */
export async function suggestReadOnlyTools(goal: string, exclude: Set<string>, max = 3): Promise<string[]> {
  const MIN_SCORE = 0.35   // above every no-tool score measured (max 0.32), with margin
  const hits = await retrieveTools(goal, 12)
  const out: string[] = []
  for (const h of hits) {
    if (out.length >= max) break
    if (h.score < MIN_SCORE) break
    if (exclude.has(h.name)) continue
    const def = registry.get(h.name)
    if (!def || def.mutates) continue
    out.push(h.name)
  }
  return out
}

/** Cleared so a bench can rebuild against a different registry state. */
export function resetToolIndex(): void {
  index = null
  building = null
}

// ═══════════════════════════════════════════════════════════════════════════════
// VGR — metamorphic-relation properties from SPEC TEXT (name-independent, un-foolable)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The property whitelist (propertyVerifier.ts) is gated on the function NAME: a sort
// certifies only if the export matches `/[Ss]ort/`. A request that describes the behavior
// in prose but names the function something custom — `arrange(items)` "in ascending order",
// `flipOrder(seq)` "reversed" — matches NO family and falls to a weaker path.
//
// This module detects the RELATION-CLASS from the SPEC TEXT (the description, not the name)
// and certifies against METAMORPHIC properties: relations that hold for EVERY correct
// implementation and are checked by EXECUTION with no expected value needed. We only certify
// via a relation set that is COMPLETE — it pins the function uniquely:
//
//   • sort  → {output is a permutation of the input} ∧ {output is ordered (asc|desc)}.
//     A permutation that is also ordered IS the sort — nothing else satisfies both.
//   • reverse → {output[i] === input[n-1-i] for all i} (implies involution + length).
//     The position map IS the definition of reverse.
//
// Why this is the tier ABOVE differential consensus (differentialSpec.ts): a metamorphic
// invariant is a TRUE property of the intended function, so — unlike value-agreement derived
// from sampled implementations — it CANNOT be satisfied by a systematically-wrong output that
// every sample happened to share. A sorter that returns the list DESCENDING when ascending was
// asked fails the ordered-ascending relation outright, even if all sampled impls made that same
// mistake. This is exactly the shared-systematic-bug hole differential documents as its limit.
//
// Assertions are executed by the same harness as propertyVerifier (verifyByProperty): the
// candidate's exported function is in scope by name; each `prop('label', <bool>)` runs against
// a self-contained input battery. Zero model in this file.
// ═══════════════════════════════════════════════════════════════════════════════

import { extractFeatures } from '../synth/index'

export interface MetamorphicSpec {
  entry: string
  family: string
  assertions: string[]
}

/** Best-effort entry-name extraction (feature exports, else first call-shaped token). */
function guessEntry(nl: string): string {
  const ex = extractFeatures(nl).exports[0]
  if (ex) return ex
  const m = /\b([a-zA-Z_$][\w$]*)\s*\(/.exec(nl)
  return m ? m[1] : ''
}

// ── Relation-class detection from the DESCRIPTION (name-independent) ─────────────────

/** Does the prose ask to REVERSE a sequence? Guards against non-sequence "reverse …" idioms. */
function detectsReverse(lower: string): boolean {
  // Exclude idioms that contain "reverse" but are not "reverse a collection".
  if (/reverse[\s-]?(engineer|proxy|dns|geocod|lookup|shell|mortgage)/.test(lower)) return false
  return /\breverse[ds]?\b/.test(lower) || /\bin reverse order\b/.test(lower) || /\bbackwards?\b/.test(lower)
}

/** Does the prose ask to SORT a collection, and in which direction? */
function detectsSort(lower: string): 'asc' | 'desc' | null {
  const hasSortWord =
    /\bsort(s|ed|ing)?\b/.test(lower) ||
    /\bascending\b/.test(lower) ||
    /\bdescending\b/.test(lower) ||
    /\b(increasing|decreasing)\s+order\b/.test(lower) ||
    /\b(smallest|largest|lowest|highest)\s+to\s+(largest|smallest|highest|lowest)\b/.test(lower) ||
    /\border(s|ed|ing)?\b[^.]*\b(array|list|numbers?|elements?|values?|items?)\b/.test(lower)
  if (!hasSortWord) return null
  // Topological / structural sorts are a different shape — never certify them as comparison sorts.
  if (/topolog|topo[\s_-]?sort|dependency|graph/.test(lower)) return null
  const desc =
    /\bdescending\b/.test(lower) ||
    /\bdecreasing\b/.test(lower) ||
    /\b(largest|highest)\s+to\s+(smallest|lowest)\b/.test(lower) ||
    /\bhigh(est)?\s+to\s+low/.test(lower) ||
    /\breverse\s+(sorted|order)\b/.test(lower)
  return desc ? 'desc' : 'asc'
}

// ── Assertion builders (self-contained, domain-agnostic over number|string arrays) ───
//
// Multiset equality via default `.sort()`: for identical multisets the default (lexicographic)
// sort yields identical sequences whatever the element type, so it is a valid permutation check
// that does NOT depend on the candidate's own comparator being correct. Ordering uses native
// `<=`/`>=`, which are a consistent total order on both numbers and strings.

const SORT_BATTERY =
  '[[3,1,2],[5,1,4,1,5],[],[9],[-3,0,7,-1],[2,2,2],[10,-10,5,0],["banana","apple","cherry"],["x"],["dog","ant","cat","bee"]]'
const REVERSE_BATTERY = '[[1,2,3,4],[1],[],[9,8,7],[5,5,6],"abcde","x","","racecar",[0,-1,-2]]'

function sortAssertions(E: string, dir: 'asc' | 'desc'): string[] {
  const cmp = dir === 'asc' ? '<=' : '>='
  return [
    // Permutation: output is a rearrangement of the input (no elements added/dropped/changed).
    `prop('${E} output is a permutation of input', (() => {
      const B = ${SORT_BATTERY};
      const done = B.filter(x => { try { const r = ${E}(x); return Array.isArray(r) } catch { return false } });
      if (done.length < 4) return false;
      return done.every(x => { const r = ${E}(x); return JSON.stringify([...r].sort()) === JSON.stringify([...x].sort()) });
    })())`,
    // Ordered: adjacent elements are non-decreasing (asc) / non-increasing (desc).
    `prop('${E} output is ${dir === 'asc' ? 'non-decreasing' : 'non-increasing'}', (() => {
      const B = ${SORT_BATTERY};
      const done = B.filter(x => { try { const r = ${E}(x); return Array.isArray(r) } catch { return false } });
      if (done.length < 4) return false;
      return done.every(x => { const r = ${E}(x); return r.every((v, i) => i === 0 || r[i-1] ${cmp} v) });
    })())`,
  ]
}

function reverseAssertions(E: string): string[] {
  return [
    // Position map r[i] === x[n-1-i] — the complete definition of reverse (⇒ involution & length).
    `prop('${E} maps position i to n-1-i (true reverse)', (() => {
      const B = ${REVERSE_BATTERY};
      const done = B.filter(x => { try { ${E}(x); return true } catch { return false } });
      if (done.length < 4) return false;
      return done.every(x => {
        const r = ${E}(x);
        if (r == null || r.length !== x.length) return false;
        for (let i = 0; i < x.length; i++) if (r[i] !== x[x.length - 1 - i]) return false;
        return true;
      });
    })())`,
    // Involution: reversing twice is the identity (independent corroboration of the map).
    `prop('${E} is an involution (twice = identity)', (() => {
      const B = ${REVERSE_BATTERY};
      const done = B.filter(x => { try { ${E}(x); return true } catch { return false } });
      if (done.length < 4) return false;
      return done.every(x => JSON.stringify(${E}(${E}(x))) === JSON.stringify(x));
    })())`,
  ]
}

/**
 * Derive a metamorphic property spec from the request's DESCRIPTION, name-independently.
 * Returns null when no COMPLETE relation-class is detected (→ caller falls through to
 * differential / model-consensus). Never certifies against an incomplete relation set
 * (e.g. bare "filter", which subset-preservation alone would not pin uniquely).
 */
export function deriveMetamorphicSpec(nl: string): MetamorphicSpec | null {
  const entry = guessEntry(nl)
  if (!entry) return null
  const lower = nl.toLowerCase()

  const dir = detectsSort(lower)
  if (dir) return { entry, family: `sort(${dir})`, assertions: sortAssertions(entry, dir) }

  if (detectsReverse(lower)) return { entry, family: 'reverse', assertions: reverseAssertions(entry) }

  return null
}

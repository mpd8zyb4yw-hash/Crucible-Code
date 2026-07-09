// ═══════════════════════════════════════════════════════════════════════════════
// VGR — spec extraction: natural language → a mechanically-checkable TaskSpec
// ═══════════════════════════════════════════════════════════════════════════════
//
// The loop is inert without a spec: it needs an entry function name and acceptance
// cases (input → expected) to verify against. This turns an NL coding request into
// that spec. It is the step DOCTRINE.md flags as decisive: "if we cannot state what
// correct means, we ABSTAIN — we do not guess."
//
// The danger: the model invents WRONG expected values, poisoning the ground truth.
// Mitigation, per doctrine (independent derivation over vote-counting): draw K
// independent samples and keep ONLY the acceptance cases whose (args → expected)
// mapping AGREES across a majority of samples. A case the model can't reproduce
// consistently is not trustworthy ground truth, so it is dropped. If too few cases
// survive, we abstain rather than verify against a spec we don't trust.
//
// The model here proposes the spec; the CONSENSUS FILTER is the deterministic check.
// ═══════════════════════════════════════════════════════════════════════════════

import { fmComplete } from '../agent/fmReact'
import { extractSpecExamples } from '../synth/derive'
import type { CodeCase } from './codeVerifier'

/** Injectable completer so the consensus/parse logic is testable without a live model. */
export type Completer = (
  messages: Array<{ role: string; content: string }>,
  opts?: { temperature?: number },
) => Promise<string>

export interface ExtractedSpec {
  entry: string
  cases: CodeCase[]
}

// Flat shape (not a discriminated union) so it narrows reliably even under the project's
// loose tsconfig: on success `spec`+`detail` are set; on abstain `reason` is set.
export interface ExtractResult {
  ok: boolean
  spec?: ExtractedSpec
  detail?: string
  reason?: string
}

interface RawSpec { entry?: unknown; cases?: unknown }

const SYSTEM = [
  'You convert a coding request into a MACHINE-CHECKABLE test specification. You are inside a',
  'verification system: the cases you emit become the ground truth an implementation is executed',
  'against, so they must be UNAMBIGUOUS and CORRECT. Only include cases whose expected output is',
  'fully determined by the request — never guess, never include an example you are unsure of.',
  '',
  'Output STRICT JSON and nothing else, shape:',
  '{ "entry": "<functionName>", "cases": [ { "args": [<json args>], "expected": <json value>, "name": "<short>" } ] }',
  '',
  '- `args` is the positional argument list applied to the function.',
  '- `expected` is the exact return value (JSON).',
  '- Include 3-6 cases covering normal, boundary, and edge inputs (empty, zero, negatives).',
  '- If the request is too vague to determine ANY concrete expected output, output {"entry":"","cases":[]}.',
].join('\n')

// ── Deterministic harvest of USER-PROVIDED examples (trusted ground truth) ─────────
// When the request itself contains "entry(args) === value" (or → / -> / returns), those
// are GOLD — the user stated them, not the model. We trust them without cross-sample
// consensus. This is strictly better ground truth than anything the model invents, and
// it's exactly what the deterministic synth path keys on too (f(x)===y worked examples).

const EXAMPLE_RX =
  /([A-Za-z_$][\w$]*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?:===|==|=|→|->|returns?|gives?|yields?|=>)\s*([^\n,;.]+)/gi

/** Evaluate a JS/JSON literal (from the user's own prompt) to a value, or throw. */
function evalLiteral(src: string): unknown {
  const s = src.trim().replace(/[.\s]+$/, '')
  try { return JSON.parse(s) } catch { /* fall through to JS-literal eval */ }
  // eslint-disable-next-line no-new-func — literal from the user's own request, strict mode, no scope access
  return Function('"use strict"; return (' + s + ')')()
}

export interface Harvested {
  /** Primary entry (the function with the most stated examples). */
  entry: string
  /** All exported functions the request states examples for (multi-function specs). */
  entries: string[]
  /** All cases across all entries, each tagged with its target `entry`. */
  cases: CodeCase[]
}

/** Parse a call expression "entry(argSrc)" → [entry, argSrc]; null if not a call. */
function parseCall(lhs: string): [string, string] | null {
  const m = /^([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)\s*$/.exec(lhs.trim())
  return m ? [m[1], m[2]] : null
}

/** Add one (name, argsSrc, rhs) example to the per-entry map, evaluating literals. */
function addExample(byEntry: Map<string, CodeCase[]>, name: string, argsSrc: string, rhs: unknown | string): void {
  let args: unknown[], expected: unknown
  try {
    args = evalLiteral('[' + argsSrc + ']') as unknown[]
    expected = typeof rhs === 'string' ? evalLiteral(rhs) : rhs
  } catch { return }  // not a clean literal pair → skip (never guess)
  if (!Array.isArray(args)) return
  const list = byEntry.get(name) ?? []
  const key = JSON.stringify(args)
  if (list.some(c => JSON.stringify(c.args) === key)) return  // dedup within an entry
  list.push({ args, expected, name: `${name}(${argsSrc.trim()})` })
  byEntry.set(name, list)
}

// Harvest USER-PROVIDED examples (trusted ground truth — the user stated them, not the model)
// from TWO deterministic sources unioned: (1) this module's own permissive regex, and (2) the
// synth path's `extractSpecExamples`, which uses extractFeatures to resolve the real exported
// name (so it catches examples my regex would miss, and stays consistent with what the L0/L1
// synth oracle keys on). Trusted → no model consensus required.
export function harvestExplicitExamples(nl: string): Harvested {
  const byEntry = new Map<string, CodeCase[]>()

  // Source 1 — permissive regex over the raw request text.
  for (const m of nl.matchAll(EXAMPLE_RX)) addExample(byEntry, m[1], m[2], m[3])

  // Source 2 — the synth path's example extractor (feature-aware entry resolution).
  try {
    for (const { lhs, rhs } of extractSpecExamples(nl)) {
      const call = parseCall(lhs)
      if (call) addExample(byEntry, call[0], call[1], rhs)
    }
  } catch { /* best-effort; regex source still applies */ }

  const entries = [...byEntry.keys()]
  if (!entries.length) return { entry: '', entries: [], cases: [] }
  // Primary = the entry with the most stated examples (the function the request centers on).
  const primary = entries.reduce((a, b) => ((byEntry.get(b)!.length > byEntry.get(a)!.length) ? b : a))
  // Flatten ALL entries' cases, tagging each with its target function so the verifier can
  // route it. This is what lets a single request certify several functions at once.
  const cases: CodeCase[] = []
  for (const [entry, cs] of byEntry) for (const c of cs) cases.push({ ...c, entry })
  return { entry: primary, entries, cases }
}

/** Parse the model's JSON (tolerating a ```json fence and surrounding prose). */
function parseRaw(text: string): RawSpec | null {
  if (!text) return null
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = (fence ? fence[1] : text).trim()
  // Grab the outermost object if the model added prose around it.
  const start = body.indexOf('{'); const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(body.slice(start, end + 1)) as RawSpec } catch { return null }
}

/** A stable key for a case's (args) so we can compare expected values across samples. */
function argsKey(args: unknown): string {
  try { return JSON.stringify(args ?? []) } catch { return String(args) }
}
function valKey(v: unknown): string {
  try { return JSON.stringify(v) } catch { return String(v) }
}

function normalizeCases(raw: RawSpec): { entry: string; cases: CodeCase[] } {
  const entry = typeof raw.entry === 'string' ? raw.entry.trim() : ''
  const cases: CodeCase[] = []
  if (Array.isArray(raw.cases)) {
    for (const c of raw.cases) {
      if (c && typeof c === 'object' && 'args' in c && 'expected' in c && Array.isArray((c as any).args)) {
        cases.push({ args: (c as any).args, expected: (c as any).expected, name: (c as any).name })
      }
    }
  }
  return { entry, cases }
}

/**
 * Extract a checkable spec from an NL request. Draws `samples` independent proposals and
 * keeps only cases whose (args → expected) agree across a majority — the consensus filter
 * is the deterministic guard against the model inventing wrong ground truth. Abstains
 * (ok:false) when the entry name or the surviving-case count is too weak to trust.
 */
export async function extractCodeSpec(
  nl: string,
  opts: { samples?: number; minCases?: number; complete?: Completer } = {},
): Promise<ExtractResult> {
  const samples = Math.max(1, opts.samples ?? 3)
  const minCases = opts.minCases ?? 2
  const complete = opts.complete ?? fmComplete

  // (0) TRUSTED: examples the user stated verbatim in the request. Gold — no consensus
  // needed. A single user-provided example is worth more than any number of model votes.
  const harvested = harvestExplicitExamples(nl)
  const trustedByArgs = new Set(harvested.cases.map(c => argsKey(c.args)))

  const proposals: Array<{ entry: string; cases: CodeCase[] }> = []
  for (let i = 0; i < samples; i++) {
    let raw: string
    try {
      raw = await complete(
        [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Request:\n${nl}` }],
        { temperature: i === 0 ? 0.1 : 0.5 },  // one low-temp anchor + diverse samples
      )
    } catch { continue }
    const parsed = parseRaw(raw)
    if (parsed) proposals.push(normalizeCases(parsed))
  }

  // With trusted user examples we can proceed even if the model returned nothing usable.
  if (!proposals.length && !harvested.cases.length) {
    return { ok: false, reason: 'no parseable spec proposal from the model and no user-provided examples' }
  }

  // Entry name: prefer the one the USER named in an explicit example; else majority vote.
  const entryVotes = new Map<string, number>()
  for (const p of proposals) if (p.entry) entryVotes.set(p.entry, (entryVotes.get(p.entry) ?? 0) + 1)
  const entry = harvested.entry || ([...entryVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '')
  if (!entry) return { ok: false, reason: 'could not name a concrete entry function (request too vague — abstaining)' }

  // Consensus over cases: group every proposed case by argsKey; for each arg-set, the
  // expected value must AGREE across a majority of the proposals that included it.
  const byArgs = new Map<string, { args: unknown[]; name?: string; expected: Map<string, { v: unknown; n: number }> }>()
  for (const p of proposals) {
    // dedupe within a single proposal so one sample can't outvote itself
    const seenInThis = new Set<string>()
    for (const c of p.cases) {
      const ak = argsKey(c.args)
      if (seenInThis.has(ak)) continue
      seenInThis.add(ak)
      const slot = byArgs.get(ak) ?? { args: c.args, name: c.name, expected: new Map() }
      const vk = valKey(c.expected)
      const ev = slot.expected.get(vk) ?? { v: c.expected, n: 0 }
      ev.n++; slot.expected.set(vk, ev)
      byArgs.set(ak, slot)
    }
  }

  const majority = samples === 1 ? 1 : Math.floor(samples / 2) + 1
  const agreed: CodeCase[] = []
  const dropped: string[] = []
  for (const [ak, slot] of byArgs) {
    if (trustedByArgs.has(ak)) continue  // user already pinned this input — trusted set wins
    const top = [...slot.expected.values()].sort((a, b) => b.n - a.n)[0]
    // With a single sample there's nothing to cross-check, so trust it (minCases still gates).
    if (top && (samples === 1 || top.n >= majority)) {
      agreed.push({ args: slot.args as unknown[], expected: top.v, name: slot.name })
    } else {
      dropped.push(argsKey(slot.args))
    }
  }

  // Final acceptance set. CRITICAL (DOCTRINE.md — vote-counting amplifies systematic bias):
  // a model-invented case can be confidently WRONG, which makes the spec UNSATISFIABLE and
  // forces the loop to exhaust on a task it could actually solve. So:
  //   • If the USER stated examples, they are the gold gate — certify against THOSE ONLY.
  //     Model-invented cases don't get to block a correct implementation.
  //   • Only when there are NO user examples do we fall back to model-consensus cases
  //     (accepting the bias risk, because some checkable spec beats none).
  const cases = harvested.cases.length >= 1 ? harvested.cases : agreed
  const enough = harvested.cases.length >= 1 || agreed.length >= minCases
  if (!cases.length || !enough) {
    return { ok: false, reason: `spec not trustworthy — ${harvested.cases.length} user example(s), ${agreed.length}/${minCases} consensus case(s); abstaining` }
  }
  const provenance = harvested.cases.length >= 1
    ? `${harvested.cases.length} user example(s) (gold gate; ${agreed.length} model case(s) held as advisory only)`
    : `${agreed.length} model-consensus case(s)${dropped.length ? `, ${dropped.length} dropped` : ''}`
  return { ok: true, spec: { entry, cases }, detail: `entry '${entry}', ${provenance}` }
}

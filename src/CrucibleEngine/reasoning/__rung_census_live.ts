// ═══════════════════════════════════════════════════════════════════════════════
// LIVE RUNG-LEVEL BENCHMARK + CAPABILITY CENSUS
//
// Run:  npx tsx src/CrucibleEngine/reasoning/__rung_census_live.ts        (live head :8080)
//   RC_RUNS=30            draws per rung (default 30 — see POWER below; 6 draws cannot see a 2x).
//   RC_TASK=wordWrap      restrict to one task's rungs (numberToWords|formatDuration|wordWrap|csvSelect).
//   RC_ONLY=packLines     restrict to one rung by name (comma-separated list allowed).
//   RC_WALL_MS=90000      per-DRAW wall ceiling (default 90s — the top of the target 20-90s band).
//   RC_CALLS=24           per-draw model-call purse (default 24).
//   RC_EPOCHS=6           per-draw epoch budget (default 6).
//   RC_DEPS=1             inject reference implementations of a rung's named dependencies (default 1).
//   RC_OUT=path.jsonl     append one JSON line per rung as it finishes (default scratchpad-bench/…).
//
// ─── WHY THIS EXISTS ───────────────────────────────────────────────────────────
//
// Every number this project has published on the hard set came from running the LADDER end to end:
// ~1 hour per data point, and 12 draws is the most anyone has ever collected. That resolution
// cannot see the effects being produced. `1/12 vs 0/12` is indistinguishable from zero; two
// results were published and retracted this session for exactly that reason.
//
// This harness measures the RUNG instead of the task. A rung is the unit the whole architecture
// actually rests on — a carve is only as good as its hardest rung — and it costs 20-90s rather
// than an hour, so 30+ draws per arm is routine instead of impossible.
//
// ─── WHAT IT MEASURES, AND WHY IT IS TWO NUMBERS AND NOT ONE ───────────────────
//
// For each rung, per draw:
//   CERTIFIED   — the same `iterate(spec, proposeCode, verifyCode)` production runs for a rung,
//                 against the same shown cases. This is what the system calls success today.
//   GENERALISES — the certified source re-run against HELD-OUT witnesses it never saw.
//
// Reporting only CERTIFIED would repeat the session's central mistake. Measured 2026-08-02c:
// 5 of 12 certified helpers failed held-out cases, and the correlation with whether the task
// solved was exact. A rung that certifies 30/30 and generalises 10/30 is NOT a reachable rung —
// it is a rung whose spec is under-determined, which is a different defect with a different fix.
// So REACHABLE here means certified AND generalised, and all three numbers are printed.
//
// ─── SOUNDNESS: THE WITNESSES ARE THEMSELVES VERIFIED ──────────────────────────
//
// A witness set that is wrong indicts a correct helper — worse than not checking at all, because
// it produces a confident false ceiling. Two mechanical guards run BEFORE any draw and abort the
// whole census on failure:
//   1. every rung carries a REFERENCE implementation, which must pass its own shown cases;
//   2. that same reference must pass every held-out witness.
// A witness the reference fails is a witness that encodes a rule the goal does not state.
//
// The second, harder rule is owed to the third instrumentation bug of 2026-08-02: witness every
// call the CALLER actually makes. A held-out set full of clever edge cases that misses the inputs
// the composition will really pass is a second opinion from the same blind spot — it reported
// GENERALISES twice for a helper that was demonstrably broken. Where a rung is scanned in a loop
// (`nextUnquotedComma`, `wordsFittingFrom`), the witnesses below walk the caller's actual
// trajectory: start at 0 on each gold line, then resume just past each hit.
//
// ─── POWER, stated up front so the result cannot be over-read ──────────────────
//
// At 30 draws per arm, a two-proportion comparison detects roughly a 2x difference in rate
// (e.g. 20% -> 40%) at conventional significance. It does NOT resolve 20% vs 28%. A rung at 0/30
// has a 95% upper bound near 10% — that is what licenses the word "unreachable"; a rung at 0/6
// licenses nothing at all, which is why RC_RUNS defaults to 30 and the printed verdict names the
// draw count in every row.
//
// ─── HOW TO READ THE CENSUS ────────────────────────────────────────────────────
//   ALL rungs reachable                → the 1.5B is SUFFICIENT for these tasks once carved; the
//                                        gap is the planner, and planner work is on the critical path.
//   SOME rung unreachable at 0/30      → that rung is the actual ceiling. No planner prompt, plan
//                                        sampling or budget recovers a task whose hardest rung the
//                                        head cannot fill. Shrink scope: carve finer, or drop the task.
//   certifies but does not generalise  → neither of the above. The rung's SPEC is under-determined;
//                                        the fix is upstream case derivation (rungCounterexample.ts),
//                                        not capability and not the planner.
// ═══════════════════════════════════════════════════════════════════════════════

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { fmComplete, headModelName } from '../agent/fmReact'
import { iterate } from './iterate'
import { proposeCode } from './codeProposer'
import { verifyCode, type CodeAcceptance, type CodeCase } from './codeVerifier'
import { mergeCodeAcceptance } from './codeResearch'
import type { TaskSpec } from './types'

/**
 * One rung of a hand carve, promoted to a measurable unit in its own right.
 *
 * `goal` and `cases` are written exactly the way `fmPlanner`'s contract asks for a helper spec —
 * a self-contained sentence naming the function, its signature and its semantics, with no
 * reference to the parent task — because that is how `solve.ts` grinds a rung: in isolation, with
 * only the helpers its goal NAMES supplied as context.
 */
interface Rung {
  /** Parent hard-set task, for the census grouping. */
  task: string
  name: string
  goal: string
  /** SHOWN cases: what the search is allowed to see. Kept to 5-6, as a planner would emit. */
  cases: CodeCase[]
  /** HELD-OUT cases: never shown. Must be consequences of `goal`, and the ref must pass them. */
  witnesses: CodeCase[]
  /** Reference implementation. Never shown to the search — it exists to validate the witnesses. */
  ref: string
  /**
   * Other rungs in this catalog whose NAME appears in `goal`. Their reference sources are injected
   * as context, mirroring `solve.ts`'s priorBlock: production grinds a rung with its already
   * certified dependencies in hand. Injecting the REFERENCE rather than a freshly ground one is
   * deliberate — it makes each rung's number independent of its neighbours' luck, which is the
   * whole point of a census.
   */
  deps?: string[]
  /**
   * The natural value this rung returns, for the design-law column. `planShape.ts` measured that
   * number-returning helpers certified 6/6 where marked-up intermediates certified 0-1/9; this
   * census is the first chance to test that law across four tasks instead of one.
   */
  returns: 'number' | 'string' | 'string[]' | 'number[]'
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CATALOG — all four hard-set tasks, hand-carved so that EVERY helper returns a natural value
// (a number, a plain string, a list of plain strings). No marked-up intermediates, no sentinels,
// no "keep the wrapping quotes" — those are the shapes measured to be anti-prior for this head.
// The carves are a human's, exactly as in `__handcarve_probe_live.ts`: the point of a census is to
// remove the planner from the experiment and ask what the HEAD can fill.
// ─────────────────────────────────────────────────────────────────────────────
const CATALOG: Rung[] = [
  // ── numberToWords ──────────────────────────────────────────────────────────
  {
    task: 'numberToWords',
    name: 'onesWord',
    returns: 'string',
    goal:
      'Write onesWord(n: number): string returning the lowercase English word for a whole number ' +
      'from 0 to 19: "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", ' +
      '"nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", ' +
      '"seventeen", "eighteen", "nineteen".',
    cases: [
      { args: [0], expected: 'zero' },
      { args: [7], expected: 'seven' },
      { args: [10], expected: 'ten' },
      { args: [13], expected: 'thirteen' },
      { args: [19], expected: 'nineteen' },
    ],
    witnesses: [
      { args: [1], expected: 'one' },
      { args: [11], expected: 'eleven' },
      { args: [12], expected: 'twelve' },
      { args: [15], expected: 'fifteen' },
      { args: [18], expected: 'eighteen' },
    ],
    ref: `export function onesWord(n) {
  return ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'][n]
}`,
  },
  {
    task: 'numberToWords',
    name: 'tensWord',
    returns: 'string',
    goal:
      'Write tensWord(t: number): string returning the lowercase English word for a multiple of ' +
      'ten, given t from 2 to 9 meaning the number t*10: 2 is "twenty", 3 is "thirty", 4 is ' +
      '"forty", 5 is "fifty", 6 is "sixty", 7 is "seventy", 8 is "eighty", 9 is "ninety".',
    cases: [
      { args: [2], expected: 'twenty' },
      { args: [4], expected: 'forty' },
      { args: [9], expected: 'ninety' },
    ],
    witnesses: [
      { args: [3], expected: 'thirty' },
      { args: [5], expected: 'fifty' },
      { args: [6], expected: 'sixty' },
      { args: [7], expected: 'seventy' },
      { args: [8], expected: 'eighty' },
    ],
    ref: `export function tensWord(t) {
  return ['twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'][t - 2]
}`,
  },
  {
    task: 'numberToWords',
    name: 'belowHundred',
    returns: 'string',
    deps: ['onesWord', 'tensWord'],
    goal:
      'Write belowHundred(n: number): string spelling a whole number from 0 to 99 in lowercase ' +
      'English words. Below 20, return onesWord(n). From 20 up, return tensWord of the tens digit, ' +
      'and if the ones digit is not zero append a single space and onesWord of the ones digit. ' +
      'Use no hyphens.',
    cases: [
      { args: [0], expected: 'zero' },
      { args: [13], expected: 'thirteen' },
      { args: [20], expected: 'twenty' },
      { args: [42], expected: 'forty two' },
      { args: [99], expected: 'ninety nine' },
    ],
    witnesses: [
      { args: [7], expected: 'seven' },
      { args: [19], expected: 'nineteen' },
      { args: [30], expected: 'thirty' },
      { args: [61], expected: 'sixty one' },
      { args: [90], expected: 'ninety' },
    ],
    ref: `export function belowHundred(n) {
  if (n < 20) return onesWord(n)
  const t = Math.floor(n / 10), o = n % 10
  return o === 0 ? tensWord(t) : tensWord(t) + ' ' + onesWord(o)
}`,
  },
  {
    task: 'numberToWords',
    name: 'belowThousand',
    returns: 'string',
    deps: ['onesWord', 'belowHundred'],
    goal:
      'Write belowThousand(n: number): string spelling a whole number from 0 to 999 in lowercase ' +
      'English words. Below 100, return belowHundred(n). From 100 up, return onesWord of the ' +
      'hundreds digit followed by a single space and the word "hundred", and if the remainder ' +
      'after the hundreds is not zero append a single space and belowHundred of that remainder. ' +
      'Do not use the word "and".',
    cases: [
      { args: [0], expected: 'zero' },
      { args: [42], expected: 'forty two' },
      { args: [100], expected: 'one hundred' },
      { args: [118], expected: 'one hundred eighteen' },
      { args: [999], expected: 'nine hundred ninety nine' },
    ],
    witnesses: [
      { args: [7], expected: 'seven' },
      { args: [99], expected: 'ninety nine' },
      { args: [200], expected: 'two hundred' },
      { args: [305], expected: 'three hundred five' },
      { args: [940], expected: 'nine hundred forty' },
    ],
    ref: `export function belowThousand(n) {
  if (n < 100) return belowHundred(n)
  const h = Math.floor(n / 100), r = n % 100
  return r === 0 ? onesWord(h) + ' hundred' : onesWord(h) + ' hundred ' + belowHundred(r)
}`,
  },

  // ── formatDuration ─────────────────────────────────────────────────────────
  {
    task: 'formatDuration',
    name: 'durationParts',
    returns: 'number[]',
    goal:
      'Write durationParts(seconds: number): number[] breaking a non-negative whole number of ' +
      'seconds into exactly four numbers in this order: whole days, then the remaining whole ' +
      'hours (0 to 23), then the remaining whole minutes (0 to 59), then the remaining seconds ' +
      '(0 to 59). Always return all four numbers, including any that are zero.',
    cases: [
      { args: [0], expected: [0, 0, 0, 0] },
      { args: [1], expected: [0, 0, 0, 1] },
      { args: [62], expected: [0, 0, 1, 2] },
      { args: [3600], expected: [0, 1, 0, 0] },
      { args: [90061], expected: [1, 1, 1, 1] },
    ],
    witnesses: [
      { args: [59], expected: [0, 0, 0, 59] },
      { args: [60], expected: [0, 0, 1, 0] },
      { args: [3599], expected: [0, 0, 59, 59] },
      { args: [86399], expected: [0, 23, 59, 59] },
      { args: [86400], expected: [1, 0, 0, 0] },
      { args: [172800], expected: [2, 0, 0, 0] },
    ],
    ref: `export function durationParts(seconds) {
  return [Math.floor(seconds / 86400), Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60]
}`,
  },
  {
    task: 'formatDuration',
    name: 'pluralUnit',
    returns: 'string',
    goal:
      'Write pluralUnit(count: number, unit: string): string returning the count, then a single ' +
      'space, then the unit name, with the letter "s" appended to the unit name unless the count ' +
      'is exactly 1.',
    cases: [
      { args: [1, 'hour'], expected: '1 hour' },
      { args: [2, 'hour'], expected: '2 hours' },
      { args: [0, 'second'], expected: '0 seconds' },
      { args: [1, 'day'], expected: '1 day' },
    ],
    witnesses: [
      { args: [1, 'second'], expected: '1 second' },
      { args: [2, 'minute'], expected: '2 minutes' },
      { args: [11, 'day'], expected: '11 days' },
      { args: [0, 'hour'], expected: '0 hours' },
    ],
    ref: `export function pluralUnit(count, unit) {
  return count + ' ' + unit + (count === 1 ? '' : 's')
}`,
  },
  {
    task: 'formatDuration',
    name: 'joinSerial',
    returns: 'string',
    goal:
      'Write joinSerial(parts: string[]): string joining strings into an English list. An empty ' +
      'array gives the empty string and a one-element array gives that element. Otherwise join ' +
      'every element except the last with ", ", then append " and " and the last element — there ' +
      'is no comma before "and".',
    cases: [
      { args: [[]], expected: '' },
      { args: [['1 second']], expected: '1 second' },
      { args: [['1 minute', '2 seconds']], expected: '1 minute and 2 seconds' },
      { args: [['1 hour', '1 minute', '2 seconds']], expected: '1 hour, 1 minute and 2 seconds' },
    ],
    witnesses: [
      { args: [['1 day', '1 hour', '1 minute', '1 second']], expected: '1 day, 1 hour, 1 minute and 1 second' },
      { args: [['a', 'b']], expected: 'a and b' },
      { args: [['a', 'b', 'c']], expected: 'a, b and c' },
      { args: [['only']], expected: 'only' },
    ],
    ref: `export function joinSerial(parts) {
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]
}`,
  },

  // ── wordWrap ───────────────────────────────────────────────────────────────
  {
    task: 'wordWrap',
    name: 'splitWords',
    returns: 'string[]',
    goal:
      'Write splitWords(text: string): string[] splitting a string on single spaces into its ' +
      'words. The empty string gives an empty array. No word is empty and nothing is trimmed ' +
      'beyond the split.',
    cases: [
      { args: [''], expected: [] },
      { args: ['abc'], expected: ['abc'] },
      { args: ['a b c'], expected: ['a', 'b', 'c'] },
      { args: ['the quick brown fox'], expected: ['the', 'quick', 'brown', 'fox'] },
    ],
    witnesses: [
      { args: ['hello world'], expected: ['hello', 'world'] },
      { args: ['extraordinary a'], expected: ['extraordinary', 'a'] },
      { args: ['x'], expected: ['x'] },
    ],
    ref: `export function splitWords(text) {
  return text === '' ? [] : text.split(' ')
}`,
  },
  {
    // The natural-value analogue of `nextUnquotedComma`: the greedy line-packing decision expressed
    // as a COUNT rather than as a packed array. This is the shape `rungCounterexample.ts` can force
    // from gold, so its reachability is worth more than one row of the census.
    task: 'wordWrap',
    name: 'wordsFittingFrom',
    returns: 'number',
    goal:
      'Write wordsFittingFrom(words: string[], from: number, width: number): number returning how ' +
      'many consecutive words starting at index `from` fit on one line of at most `width` ' +
      'characters when joined by single spaces. The first word is always taken even if it is ' +
      'longer than width, so the answer is at least 1 whenever `from` is a valid index. Return 0 ' +
      'if `from` is at or past the end of the array.',
    cases: [
      { args: [['a', 'b', 'c'], 0, 3], expected: 2 },
      { args: [['a', 'b', 'c'], 2, 3], expected: 1 },
      { args: [['hello', 'world'], 0, 5], expected: 1 },
      { args: [['the', 'quick', 'brown', 'fox'], 0, 10], expected: 2 },
      { args: [['extraordinary', 'a'], 0, 5], expected: 1 },
      { args: [['a'], 1, 5], expected: 0 },
    ],
    // The caller's real trajectory: start at 0, then resume just past each hit, on every gold line
    // of the parent task. A held-out set that misses those inputs is the same blind spot twice.
    witnesses: [
      { args: [['the', 'quick', 'brown', 'fox'], 2, 10], expected: 2 },
      { args: [['the', 'quick', 'brown', 'fox'], 3, 10], expected: 1 },
      { args: [['extraordinary', 'a'], 1, 5], expected: 1 },
      { args: [['hello', 'world'], 1, 5], expected: 1 },
      { args: [['abc'], 0, 5], expected: 1 },
      { args: [['a', 'b', 'c'], 1, 3], expected: 2 },
      { args: [['a', 'bb', 'c'], 0, 4], expected: 2 },
      { args: [[], 0, 5], expected: 0 },
    ],
    ref: `export function wordsFittingFrom(words, from, width) {
  if (from >= words.length) return 0
  let len = words[from].length, count = 1
  while (from + count < words.length && len + 1 + words[from + count].length <= width) {
    len += 1 + words[from + count].length
    count++
  }
  return count
}`,
  },
  {
    task: 'wordWrap',
    name: 'packLines',
    returns: 'string[]',
    deps: ['wordsFittingFrom'],
    goal:
      'Write packLines(words: string[], width: number): string[] packing words into lines. ' +
      'Starting at index 0, repeatedly call wordsFittingFrom(words, i, width) to learn how many ' +
      'words go on the next line, join exactly that many words from index i with single spaces to ' +
      'form the line, then advance i by that many. Stop when i reaches the end. An empty array of ' +
      'words gives an empty array of lines.',
    cases: [
      { args: [[], 5], expected: [] },
      { args: [['abc'], 5], expected: ['abc'] },
      { args: [['a', 'b', 'c'], 3], expected: ['a b', 'c'] },
      { args: [['hello', 'world'], 5], expected: ['hello', 'world'] },
      { args: [['the', 'quick', 'brown', 'fox'], 10], expected: ['the quick', 'brown fox'] },
    ],
    witnesses: [
      { args: [['extraordinary', 'a'], 5], expected: ['extraordinary', 'a'] },
      { args: [['a', 'b', 'c', 'd'], 3], expected: ['a b', 'c d'] },
      { args: [['x'], 1], expected: ['x'] },
    ],
    ref: `export function packLines(words, width) {
  const out = []
  let i = 0
  while (i < words.length) {
    const n = wordsFittingFrom(words, i, width)
    out.push(words.slice(i, i + n).join(' '))
    i += n
  }
  return out
}`,
  },

  // ── csvSelect ──────────────────────────────────────────────────────────────
  {
    task: 'csvSelect',
    name: 'csvLines',
    returns: 'string[]',
    goal:
      'Write csvLines(csv: string): string[] splitting a string into its newline-separated lines. ' +
      'A string with no newline yields a one-element array containing the whole string. No line ' +
      'is trimmed and empty lines are kept.',
    cases: [
      { args: ['a,b\nc,d'], expected: ['a,b', 'c,d'] },
      { args: ['a'], expected: ['a'] },
      { args: ['a\nb,c'], expected: ['a', 'b,c'] },
    ],
    witnesses: [
      { args: [''], expected: [''] },
      { args: ['a\n\nb'], expected: ['a', '', 'b'] },
      { args: ['"x,y",z'], expected: ['"x,y",z'] },
    ],
    ref: `export function csvLines(csv) {
  return csv.split('\\n')
}`,
  },
  {
    // The rung this session proved is the load-bearing one, carried over BYTE-IDENTICAL from
    // `__handcarve_probe_live.ts` (goal, shown cases and witnesses) so the census number is
    // directly comparable to the 8/12-vs-3/30 probe result rather than a friendlier restatement.
    task: 'csvSelect',
    name: 'nextUnquotedComma',
    returns: 'number',
    goal:
      'Write nextUnquotedComma(line: string, from: number): number returning the index of the ' +
      'first comma at or after position `from` that is NOT inside a double-quoted section, or ' +
      '-1 if there is no such comma. Scan forward one character at a time keeping a boolean ' +
      '"inside quotes" flag that flips on every double-quote character; a comma counts only ' +
      'while that flag is false.',
    cases: [
      { args: ['a,b', 0], expected: 1 },
      { args: ['a', 0], expected: -1 },
      { args: ['a,,b', 2], expected: 2 },
      { args: ['"x,y",z', 0], expected: 5 },
      { args: ['"he said ""hi""",z', 0], expected: 16 },
      { args: ['a,b', 2], expected: -1 },
    ],
    witnesses: [
      { args: [',a', 0], expected: 0 },
      { args: ['abc', 9], expected: -1 },
      { args: ['', 0], expected: -1 },
      { args: ['"ab",c', 0], expected: 4 },
      { args: ['a,"b,c",d', 2], expected: 7 },
      { args: ['a,b,c', 2], expected: 3 },
      // The five that caught the overfit helper the first witness set cleared twice.
      { args: ['a,,b', 0], expected: 1 },
      { args: ['a,,b', 3], expected: -1 },
      { args: ['"x,y",z', 6], expected: -1 },
      { args: ['"he said ""hi""",z', 0], expected: 16 },
    ],
    ref: `export function nextUnquotedComma(line, from) {
  let inQ = false
  for (let i = from; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQ = !inQ
    else if (c === ',' && !inQ) return i
  }
  return -1
}`,
  },
  {
    task: 'csvSelect',
    name: 'unquoteCsvField',
    returns: 'string',
    goal:
      'Write unquoteCsvField(field: string): string normalising ONE CSV field. If the field ' +
      'starts and ends with a double-quote character, remove those two outer characters and then ' +
      'replace every doubled double-quote ("") in what remains with a single double-quote ' +
      'character. A field not wrapped in double quotes is returned unchanged.',
    cases: [
      { args: ['a'], expected: 'a' },
      { args: [''], expected: '' },
      { args: ['"x,y"'], expected: 'x,y' },
      { args: ['"he said ""hi"""'], expected: 'he said "hi"' },
      { args: ['""'], expected: '' },
    ],
    witnesses: [
      { args: ['"a"'], expected: 'a' },
      { args: ['no quotes here'], expected: 'no quotes here' },
      { args: ['a"b'], expected: 'a"b' },
      { args: ['"x"'], expected: 'x' },
    ],
    ref: `export function unquoteCsvField(field) {
  if (field.length >= 2 && field[0] === '"' && field[field.length - 1] === '"') {
    return field.slice(1, -1).replace(/""/g, '"')
  }
  return field
}`,
  },
]

const s = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const a = [...xs].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2)
}

/**
 * Wilson 95% interval. Printed because the entire point of this harness is that a rate from 30
 * draws means something a rate from 6 draws does not — and the honest way to say that is an
 * interval, not a bare fraction. It is also what licenses the word "unreachable": 0/30 has an
 * upper bound near 10%, 0/6 has an upper bound near 40%.
 */
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1]
  const z = 1.96, p = k / n, d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)]
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`

/** TRAP 5 — a misconfigured head returns EMPTY completions and scores as a capability ceiling. */
async function preflightHead(): Promise<void> {
  const name = headModelName()
  console.log(`# head: ${name}`)
  if (/apple/i.test(name)) {
    console.error(`ABORT: head is '${name}', not the local GGUF (export CRUCIBLE_BONSAI_BIN/MODEL).`)
    process.exit(1)
  }
  const t0 = Date.now()
  const text = await fmComplete([{ role: 'user', content: 'Write a JS function add(a,b) that returns a+b. Code only.' }], { maxTokens: 64 })
  if (!text.trim()) {
    console.error(`ABORT: head returned an EMPTY completion (${Date.now() - t0}ms) — TRAP 5. Total -c must be PER_SLOT_CTX x SLOTS, and --jinja is required.`)
    process.exit(1)
  }
  console.log(`# head preflight ok (${text.trim().length} chars in ${Date.now() - t0}ms)\n`)
}

/** Run one source against one case set. Used for both the witness check and the ref guards. */
async function passes(name: string, source: string, cases: CodeCase[]): Promise<{ ok: boolean; failed: string[] }> {
  const verdict = await verifyCode(
    { value: source, fingerprint: `census:${name}:${cases.length}` },
    { goal: name, domain: 'code', acceptance: { entry: name, cases } satisfies CodeAcceptance as unknown as Record<string, unknown> },
  )
  return { ok: verdict.pass, failed: (verdict.signals ?? []).filter(sig => /^case /.test(sig)) }
}

/** Dependency reference sources, in catalog order so definitions precede their callers. */
function depBlock(rung: Rung, byName: Map<string, Rung>): string | undefined {
  if (!rung.deps?.length || process.env.RC_DEPS === '0') return undefined
  const seen = new Set<string>()
  const out: string[] = []
  const walk = (n: string): void => {
    if (seen.has(n)) return
    seen.add(n)
    const r = byName.get(n)
    if (!r) return
    for (const d of r.deps ?? []) walk(d)
    out.push(r.ref)
  }
  for (const d of rung.deps) walk(d)
  return out.join('\n\n')
}

interface RungResult {
  task: string
  name: string
  returns: string
  runs: number
  certified: number
  generalised: number
  callsMed: number
  wallMedS: number
  /** Distinct held-out failures, deduped — a repeated identical failure is a systematic defect. */
  overfitSignals: string[]
}

async function runRung(rung: Rung, runs: number, budget: { globalModelCalls: number; maxEpochs: number; wallClockMs: number }, byName: Map<string, Rung>): Promise<RungResult> {
  const context = depBlock(rung, byName)
  const spec: TaskSpec = {
    // Byte-for-byte the rung spec `solve.ts` builds (goal + the "Implement helper" line), so this
    // measures the production path and not a friendlier prompt.
    goal: `${rung.goal}\n\nImplement helper \`${rung.name}\`.`,
    domain: 'code',
    acceptance: { entry: rung.name, cases: rung.cases } satisfies CodeAcceptance as unknown as Record<string, unknown>,
    ...(context ? { context } : {}),
  }

  let certified = 0, generalised = 0
  const calls: number[] = [], walls: number[] = []
  const overfit = new Set<string>()

  for (let run = 0; run < runs; run++) {
    const t0 = Date.now()
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), budget.wallClockMs)
    const res = await iterate<string>(spec, proposeCode, verifyCode, {
      mergeAcceptance: mergeCodeAcceptance, ...budget, signal: ac.signal,
    })
    clearTimeout(timer)
    const wall = Date.now() - t0
    calls.push(res.modelCalls)
    walls.push(wall)

    // `solution` is a Candidate, not a string — the source lives on `.value`. Stringifying the
    // Candidate itself yields "[object Object]", which fails every witness with ZERO case-level
    // signals and reads exactly like a systematically overfit helper. That is the fourth
    // instrumentation bug of this line of work and the first one this harness caught on itself:
    // an OVERFIT verdict with no failing case is impossible, so it is asserted below.
    const source = res.status === 'solved' && res.solution ? res.solution.value : null
    let mark: string = res.status
    if (source) {
      certified++
      const w = await passes(rung.name, source, rung.witnesses)
      if (!w.ok && w.failed.length === 0) {
        console.error(`ABORT: \`${rung.name}\` failed its witnesses with NO failing case — that is an instrumentation fault (unrunnable source), not an overfit helper.`)
        process.exit(1)
      }
      if (w.ok) { generalised++; mark = 'CERTIFIED + GENERALISES' }
      else {
        mark = `CERTIFIED but OVERFIT (fails ${w.failed.length}/${rung.witnesses.length} held out)`
        for (const f of w.failed) overfit.add(f.slice(0, 140))
      }
    }
    // `bestScore` is the diagnosis for a FAILED draw only (near 1.0 = one counterexample short,
    // near 0 = never had the shape). On a solved draw it is not the measurement, so it is not shown.
    console.log(`     draw ${String(run + 1).padStart(2)}/${runs}  ${String(res.modelCalls).padStart(3)}c ${s(wall).padStart(7)}  ` +
      (source ? '' : `best ${Number.isFinite(res.bestScore) ? res.bestScore.toFixed(2) : '—'}  `) + mark)
  }

  return {
    task: rung.task, name: rung.name, returns: rung.returns, runs, certified, generalised,
    callsMed: median(calls), wallMedS: Math.round(median(walls) / 1000),
    overfitSignals: [...overfit].slice(0, 4),
  }
}

async function main(): Promise<void> {
  await preflightHead()

  const runs = Math.max(1, Number(process.env.RC_RUNS || 30))
  const budget = {
    globalModelCalls: Math.max(1, Number(process.env.RC_CALLS || 24)),
    maxEpochs: Math.max(1, Number(process.env.RC_EPOCHS || 6)),
    wallClockMs: Math.max(1000, Number(process.env.RC_WALL_MS || 90_000)),
  }
  const only = new Set((process.env.RC_ONLY ?? '').split(',').map(x => x.trim()).filter(Boolean))
  const task = process.env.RC_TASK
  const selected = CATALOG.filter(r => (!task || r.task === task) && (!only.size || only.has(r.name)))
  if (!selected.length) { console.error(`no rung matches RC_TASK=${task ?? ''} RC_ONLY=${[...only].join(',')}`); process.exit(1) }
  const byName = new Map(CATALOG.map(r => [r.name, r]))

  // ── SOUNDNESS GUARDS. Both run over the WHOLE selection before any draw, because a census that
  // gets halfway through and then discovers its witnesses were wrong has burned an hour for a
  // number that must be thrown away.
  console.log('# validating the catalog (reference implementations vs their own shown cases and held-out witnesses)')
  for (const r of selected) {
    const withDeps = [depBlock(r, byName), r.ref].filter(Boolean).join('\n\n')
    const shown = await passes(r.name, withDeps, r.cases)
    if (!shown.ok) {
      console.error(`ABORT: reference \`${r.name}\` fails its own SHOWN cases — the rung spec is wrong, not the head.`)
      for (const f of shown.failed) console.error(`   ${f.slice(0, 160)}`)
      process.exit(1)
    }
    const held = await passes(r.name, withDeps, r.witnesses)
    if (!held.ok) {
      console.error(`ABORT: reference \`${r.name}\` fails its own HELD-OUT witnesses — those witnesses encode a rule the goal does not state, and would indict a CORRECT helper.`)
      for (const f of held.failed) console.error(`   ${f.slice(0, 160)}`)
      process.exit(1)
    }
  }
  console.log(`# catalog ok — ${selected.length} rung(s), ${selected.reduce((n, r) => n + r.witnesses.length, 0)} held-out witnesses all satisfied by their references\n`)
  // RC_VALIDATE_ONLY=1 runs the guards and stops. This is the check to run after EDITING the
  // catalog — it costs seconds and zero model calls, and it is the difference between finding a
  // bad witness now and finding it after an hour of draws that have to be discarded.
  if (process.env.RC_VALIDATE_ONLY === '1') { console.log('# RC_VALIDATE_ONLY=1 — guards passed, no draws run'); return }

  const out = process.env.RC_OUT ?? join(process.cwd(), 'scratchpad-bench', 'rung-census.jsonl')
  mkdirSync(dirname(out), { recursive: true })

  console.log(`# RUNG CENSUS — ${selected.length} rung(s) x ${runs} draw(s), purse ${budget.globalModelCalls}c / ${budget.maxEpochs} epochs / ${s(budget.wallClockMs)} per draw`)
  console.log(`# rungs are ground in ISOLATION by the production path (iterate + proposeCode + verifyCode); dependencies are injected as REFERENCE sources`)
  console.log(`# per-rung results are appended to ${out} as they finish, so a killed run still leaves data\n`)

  const results: RungResult[] = []
  for (const r of selected) {
    console.log(`── ${r.task} / ${r.name}  (returns ${r.returns}${r.deps?.length ? `, deps: ${r.deps.join(', ')}` : ''})`)
    const res = await runRung(r, runs, budget, byName)
    results.push(res)
    const [lo, hi] = wilson(res.generalised, res.runs)
    console.log(`   → certified ${res.certified}/${res.runs}, GENERALISES ${res.generalised}/${res.runs} ` +
      `(95% CI ${pct(lo)}-${pct(hi)}), median ${res.callsMed}c / ${res.wallMedS}s`)
    for (const sig of res.overfitSignals) console.log(`     held-out failure: ${sig}`)
    console.log('')
    appendFileSync(out, JSON.stringify({ rungCensus: true, budget, ...res }) + '\n')
  }

  // ── THE CENSUS TABLE ───────────────────────────────────────────────────────
  console.log('\n# ── RUNG CAPABILITY CENSUS ────────────────────────────────────────────')
  console.log('  reachable   certified   returns    task / rung')
  for (const r of results) {
    const [lo, hi] = wilson(r.generalised, r.runs)
    console.log(`  ${`${r.generalised}/${r.runs}`.padStart(6)} ${`(${pct(lo)}-${pct(hi)})`.padEnd(11)} ${`${r.certified}/${r.runs}`.padStart(6)}   ` +
      `${r.returns.padEnd(9)}  ${r.task} / ${r.name}`)
  }

  // Per task, the census answer is decided by the WORST rung: a carve is exactly as reachable as
  // its hardest piece, so an average over rungs would hide the only fact that matters.
  console.log('\n# ── VERDICT PER TASK (a carve is as reachable as its WORST rung) ──────')
  const tasks = [...new Set(results.map(r => r.task))]
  let anyUnreachable = false, anyOverfitOnly = false
  for (const t of tasks) {
    const rs = results.filter(r => r.task === t)
    const worst = rs.reduce((a, b) => (b.generalised / b.runs < a.generalised / a.runs ? b : a))
    const rate = worst.generalised / worst.runs
    const [, hi] = wilson(worst.generalised, worst.runs)
    // SPEC-LIMITED is tested BEFORE unreachable, and that ordering is the whole diagnostic value of
    // the harness. A rung that certifies 30/30 and generalises 0/30 is NOT a capability ceiling —
    // the head wrote something that satisfies every case it was shown, every time. Calling that
    // "unreachable" would send the next session to shrink scope when the actual defect is an
    // under-determined rung spec, which `rungCounterexample.ts` already knows how to attack.
    const specLimited = worst.certified >= Math.max(3, worst.runs / 2) && worst.generalised * 2 < worst.certified
    const verdict =
      specLimited
        ? `SPEC-LIMITED — \`${worst.name}\` certifies ${worst.certified}/${worst.runs} but generalises only ${worst.generalised}/${worst.runs}. ` +
          `The head CAN write this rung; its shown cases do not pin down which function. Fix upstream (derived cases), not capability and not the planner.`
        : worst.generalised === 0
          ? `UNREACHABLE — \`${worst.name}\` never certified-and-generalised in ${worst.runs} draws (95% upper bound ${pct(hi)}), and did not certify often either (${worst.certified}/${worst.runs}). This rung is the ceiling; no planner work recovers it.`
          : rate >= 0.5
            ? `REACHABLE — worst rung \`${worst.name}\` at ${worst.generalised}/${worst.runs}. The head is sufficient once carved; the gap is the PLANNER.`
            : `MARGINAL — worst rung \`${worst.name}\` at ${worst.generalised}/${worst.runs} (95% CI up to ${pct(hi)}). Reachable but not reliably; a carve needing it will fail most draws.`
    if (!specLimited && worst.generalised === 0) anyUnreachable = true
    if (specLimited) anyOverfitOnly = true
    console.log(`  ${t.padEnd(16)} ${verdict}`)
  }

  console.log('\n# ── WHAT THIS LICENSES ────────────────────────────────────────────────')
  if (anyUnreachable) {
    console.log('  At least one hard task has a rung the head cannot fill even hand-carved and in isolation.')
    console.log('  SHRINK SCOPE on those tasks (carve finer, or retire the row) before any more planner tuning —')
    console.log('  planner work cannot convert a task whose hardest rung is unreachable.')
  } else {
    console.log('  Every hard task is reachable rung-by-rung. The 1.5B is SUFFICIENT for this set once carved,')
    console.log('  so the whole gap between 0/12 end-to-end and this census is PLANNING and COMPOSITION —')
    console.log('  which is where the next optimisation belongs.')
  }
  if (anyOverfitOnly) {
    console.log('  Separately: at least one rung certifies far more often than it generalises. That is the')
    console.log('  under-determined-spec defect (rungCounterexample.ts), not capability and not the planner.')
  }
  console.log(JSON.stringify({ rungCensusSummary: true, runs, budget, results }))
}

main().catch(e => { console.error('rung census failed:', e); process.exit(1) })

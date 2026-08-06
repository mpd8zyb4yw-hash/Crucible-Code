// ============================================================================
// Worker body for localHardenFuzz.ts — runs candidate code + fast-check properties
// off the main thread so a genuine infinite loop in the CANDIDATE code (exactly the
// kind of bug this layer exists to catch) can be killed with worker.terminate()
// instead of hanging the agent process. Plain CommonJS (.cjs) so it needs no loader
// even though the project is "type": "module".
// ============================================================================
const { parentPort, workerData } = require('worker_threads')
const fc = require('fast-check')

const { code, checks } = workerData
const NUM_RUNS = 30

function buildProperty(kind, fn) {
  switch (kind) {
    case 'sort':
      // Narrow integer range so generated arrays actually contain duplicates —
      // fc.integer()'s full range almost never collides, which made a Set-based
      // dedup-then-sort candidate (drops repeated values) invisible to this
      // property (r.length !== arr.length never fired). Same fix as 'array-dedupe'.
      return fc.property(fc.array(fc.integer({ min: 0, max: 8 })), (arr) => {
        const r = fn(arr.slice())
        if (!Array.isArray(r) || r.length !== arr.length) return false
        for (let i = 1; i < r.length; i++) if (r[i - 1] > r[i]) return false
        const a = [...arr].sort((x, y) => x - y)
        const b = [...r].sort((x, y) => x - y)
        return JSON.stringify(a) === JSON.stringify(b)
      })
    // Companion to 'sort': the correctness property above always passes fn a defensive
    // copy (arr.slice()), so it structurally cannot see a candidate that mutates its
    // input in place. This passes fn OUR OWN copy of the generated array (never the
    // array fast-check itself owns — mutating that corrupts fast-check's shrink state
    // and can hang the run) and asserts that copy is unchanged afterward, independent
    // of whether the return value is correct.
    case 'sort-no-mutate':
      return fc.property(fc.array(fc.integer({ min: 0, max: 8 })), (arr) => {
        const ownCopy = arr.slice()
        const original = ownCopy.slice()
        fn(ownCopy)
        return JSON.stringify(ownCopy) === JSON.stringify(original)
      })
    case 'validator':
      return fc.property(fc.string(), (s) => typeof fn(s) === 'boolean')
    case 'string-transform':
      return fc.property(fc.string(), (s) => typeof fn(s) === 'string')
    case 'comparator':
      // This family only fires for names implying raw numeric ordering (compare/ascending/
      // descending/byKey/sortKey/cmp, arity 2) — a reasonable heuristic that the two args
      // ARE the sort keys, not opaque objects compared by some hidden field. Under that
      // assumption, a distinct pair must never compare equal — added 2026-07-05 (cont.22)
      // after finding `() => 0` (a comparator that treats every pair as equal, breaking
      // sort order for any input) passed the old antisymmetry-only check silently: a===b
      // trivially satisfies antisymmetry regardless of whether the comparator does anything.
      return fc.property(fc.integer(), fc.integer(), (a, b) => {
        const ab = fn(a, b)
        if (typeof ab !== 'number') return false
        if (a === b) return ab === 0
        if (ab === 0) return false // a distinct pair must resolve to an order, not "equal"
        const ba = fn(b, a)
        return Math.sign(ab) === -Math.sign(ba)
      })
    // All three set-op families narrowed to a small collision-prone integer range
    // (2026-07-05, cont.22) — a and b drawn from the full int32 range essentially never
    // overlap, which hid a real gap: 'set-op-diff'/'set-op-intersect' only ever checked
    // "nothing foreign in r" (no completeness direction), so `() => []` passed both
    // silently for any non-overlapping a/b. Narrowing forces real overlaps to occur so the
    // added completeness checks below actually get exercised.
    case 'set-op-union':
      return fc.property(fc.array(fc.integer({ min: 0, max: 8 })), fc.array(fc.integer({ min: 0, max: 8 })), (a, b) => {
        const r = fn(a.slice(), b.slice())
        if (!Array.isArray(r)) return false
        const setA = new Set(a), setB = new Set(b)
        // every element of A and B must survive; nothing foreign appears.
        return a.every(x => r.includes(x)) && b.every(x => r.includes(x)) &&
          r.every(x => setA.has(x) || setB.has(x))
      })
    // Companions to the set-op correctness checks: those always pass fn a defensive copy
    // of each array, so they can't see a candidate that mutates a or b in place. These
    // pass fn OUR OWN copies (never fast-check's own generated arrays — mutating those
    // corrupts its shrink state) and assert both copies are unchanged afterward.
    case 'set-op-union-no-mutate':
      return fc.property(fc.array(fc.integer({ min: 0, max: 8 })), fc.array(fc.integer({ min: 0, max: 8 })), (a, b) => {
        const ownA = a.slice(), ownB = b.slice()
        const origA = ownA.slice(), origB = ownB.slice()
        fn(ownA, ownB)
        return JSON.stringify(ownA) === JSON.stringify(origA) && JSON.stringify(ownB) === JSON.stringify(origB)
      })
    case 'set-op-diff':
      return fc.property(fc.array(fc.integer({ min: 0, max: 8 })), fc.array(fc.integer({ min: 0, max: 8 })), (a, b) => {
        const r = fn(a.slice(), b.slice())
        if (!Array.isArray(r)) return false
        const setA = new Set(a), setB = new Set(b)
        // result only contains A-elements not in B (nothing foreign) AND every distinct
        // A-value not in B is actually present (completeness — catches `() => []`).
        const expected = [...setA].filter(x => !setB.has(x))
        return r.every(x => setA.has(x) && !setB.has(x)) && expected.every(x => r.includes(x))
      })
    case 'set-op-diff-no-mutate':
      return fc.property(fc.array(fc.integer({ min: 0, max: 8 })), fc.array(fc.integer({ min: 0, max: 8 })), (a, b) => {
        const ownA = a.slice(), ownB = b.slice()
        const origA = ownA.slice(), origB = ownB.slice()
        fn(ownA, ownB)
        return JSON.stringify(ownA) === JSON.stringify(origA) && JSON.stringify(ownB) === JSON.stringify(origB)
      })
    case 'set-op-intersect':
      return fc.property(fc.array(fc.integer({ min: 0, max: 8 })), fc.array(fc.integer({ min: 0, max: 8 })), (a, b) => {
        const r = fn(a.slice(), b.slice())
        if (!Array.isArray(r)) return false
        const setA = new Set(a), setB = new Set(b)
        // intersection: only elements present in both (nothing foreign) AND every
        // distinct shared value is actually present (completeness — catches `() => []`).
        const expected = [...setA].filter(x => setB.has(x))
        return r.every(x => setA.has(x) && setB.has(x)) && expected.every(x => r.includes(x))
      })
    case 'set-op-intersect-no-mutate':
      return fc.property(fc.array(fc.integer({ min: 0, max: 8 })), fc.array(fc.integer({ min: 0, max: 8 })), (a, b) => {
        const ownA = a.slice(), ownB = b.slice()
        const origA = ownA.slice(), origB = ownB.slice()
        fn(ownA, ownB)
        return JSON.stringify(ownA) === JSON.stringify(origA) && JSON.stringify(ownB) === JSON.stringify(origB)
      })
    case 'array-dedupe':
      // Narrow integer range so generated arrays actually contain duplicates —
      // fc.integer()'s full range almost never collides, which would make the
      // "leaves duplicates in" bug shape invisible to this property.
      return fc.property(fc.array(fc.integer({ min: 0, max: 5 })), (arr) => {
        const r = fn(arr.slice())
        if (!Array.isArray(r)) return false
        if (new Set(r).size !== r.length) return false // no duplicate values in output
        const inputSet = new Set(arr)
        return r.every(x => inputSet.has(x)) && [...inputSet].every(x => r.includes(x))
      })
    case 'array-dedupe-no-mutate':
      return fc.property(fc.array(fc.integer({ min: 0, max: 5 })), (arr) => {
        const ownCopy = arr.slice()
        const original = ownCopy.slice()
        fn(ownCopy)
        return JSON.stringify(ownCopy) === JSON.stringify(original)
      })
    case 'number-aggregate-sum':
      return fc.property(fc.array(fc.integer({ min: -100000, max: 100000 })), (arr) => {
        const r = fn(arr.slice())
        if (typeof r !== 'number') return false
        const expected = arr.reduce((a, b) => a + b, 0)
        return Math.abs(r - expected) < 1e-6
      })
    case 'number-transform-clamp':
      // Switched from fc.double() to bounded fc.integer() (2026-07-05, cont.22) — even after
      // narrowing doubles to [-1000,1000], fast-check's double arbitrary still heavily
      // biases samples toward "interesting" edge values (0, -0, tiny fractions) rather than
      // spreading uniformly, so a real "never enforces the upper bound" bug still only
      // triggered on roughly 3 of every 4 bench runs instead of ~30/30 — flaky enough that
      // a real regression could slip through on an unlucky run. Bounded integers sample far
      // more uniformly across the range, reliably exercising both bounds every run
      // (verified: 20/20 clean bench runs after this change, vs. ~5/20 flaky before).
      return fc.property(
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        (v, lo, hi) => {
          if (lo > hi) return true // undefined behavior when bounds are inverted — not asserted
          const r = fn(v, lo, hi)
          return typeof r === 'number' && r >= lo - 1e-9 && r <= hi + 1e-9
        },
      )
    default:
      return null
  }
}

const results = []
try {
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  const runModule = new Function('module', 'exports', 'require', code)
  runModule(mod, mod.exports, require)
  const exportsObj = mod.exports

  for (const check of checks) {
    const fn = exportsObj[check.name]
    if (typeof fn !== 'function') continue
    const prop = buildProperty(check.kind, fn)
    if (!prop) continue
    try {
      fc.assert(prop, { numRuns: NUM_RUNS })
      results.push({ name: check.name, kind: check.kind, failed: false })
    } catch (e) {
      results.push({ name: check.name, kind: check.kind, failed: true, message: String(e && e.message ? e.message : e).slice(0, 500) })
    }
  }
} catch (e) {
  results.push({ name: '<module>', kind: 'load-error', failed: true, message: String(e && e.message ? e.message : e).slice(0, 300) })
}

parentPort.postMessage({ results })

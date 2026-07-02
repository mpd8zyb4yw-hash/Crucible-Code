import { enumerate } from './src/CrucibleEngine/synth/proposers/enumerative'

function show(name: string, spec: string) {
  try {
    const o = enumerate(spec, { modulePath: `src/${name}.ts` })
    console.log(`\n=== ${name} === status: ${o.status}`)
    if (o.status === 'solved') console.log('  expr:', o.result.expr, '(size', o.result.size + ')')
    if (o.status === 'ambiguous') console.log('  candidates:', (o as any).candidates)
    if (o.status === 'none') console.log('  detail:', o.detail)
  } catch (e: any) {
    console.log(`\n=== ${name} === THREW: ${e?.message}`)
  }
}

// ===== OBS-EQUIV PRUNING vs AMBIGUITY GUARD =====
// Goal: two size-1 building blocks agree on examples (so one is pruned) but diverge unseen;
// each combines via the SAME size-(k) op into a distinct solution. Only the surviving rep
// yields a recorded solution; its twin solution is never generated -> guard never sees it.

// Candidate building blocks at size 1: param `n`, and constants 0,1,2,-1,10 plus spec literals.
// Two CONSTANTS can't be obs-equiv unless equal. The pruning collapse needs DERIVED size-k vals.
//
// Simplest: find a unary op u and inputs such that two size-2 intermediates have equal example
// vectors but different probe behavior, then a unary solution op s applied to both.

// Attempt: examples designed so that both `abs(n)` and `n` have the same vec (all inputs >=0),
// then solution = inc(abs(n)) vs inc(n). On examples n>=0 so abs(n)===n. Pruning keeps abs(n)
// OR n (whichever added first — `n` is size1 input, added before consts; abs(n) is size2).
// At size2 abs(n) vec === n vec => abs(n) is pruned (obs-equiv to the size-1 `n`).
// Solution at size... inc(n) is size2 and would be a solution if output = n+1 for n>=0.
// inc(abs(n)) is size3. Different sizes -> minimal-size break means inc(abs(n)) never recorded.
// That's CORRECT behavior (Occam): inc(n) is strictly simpler. Not a bug.
//
// The REAL danger: two solutions of the SAME minimal size where one's subtree got pruned.
// Need: solution A = op(X) size k, solution B = op(Y) size k, X and Y both size k-1, X obs-equiv Y
// on examples (so Y pruned), X and Y diverge on probes => op(X) and op(Y) diverge on probes.

// Construct with arrays. Building blocks size2: sortAsc(xs) and reverse(xs).
// If on every example xs is already ascending, then sortAsc(xs)===xs===reverse? no reverse flips.
// Need sortAsc(xs)===reverse(xs) on examples: xs ascending AND xs palindrome-ish. Hard.

// Use uniq vs identity: on examples with no dupes, uniq(xs) vec === xs vec (size1). uniq(xs) is
// size2 and pruned. Then solution sum(uniq(xs)) size3 vs sum(xs) size2: different sizes again.

// KEY realization: to get two SAME-SIZE solutions whose subtrees are obs-equiv twins, the twins
// must be the SAME size. e.g. sortAsc(xs) [size2] and sortDesc-reversed... both size2.
// reverse(reverse(xs)) is size3. Let's try sortAsc vs uniq where BOTH are size2 and obs-equiv
// on examples but diverge on probes, then wrap each in a size-3 solution op like `sum` (but sum
// of obs-equiv vectors is also equal so the solutions are obs-equiv too... still recorded sep?)
//
// Actually: if sortAsc(xs).vec === uniq(xs).vec on examples, the SECOND one added is pruned.
// Whichever survives, only sum(survivor) is generated as the size-3 solution. The twin
// sum(other) is never built. If sortAsc and uniq diverge on a probe (dup array), then
// sum(sortAsc) === sum(uniq) actually (sum ignores order AND dupes change sum!). sum diverges.
// But only ONE solution is generated, so guard sees 1 solution -> ships it. FALSE NEGATIVE.

// Make output a SUM so it's a scalar solution. examples: arrays w/o dupes, ascending or not.
show('sumUniq_vs_sumId_PRUNED', [
  'export function f(xs: number[]): number',
  'f([1,2,3]) === 6',     // no dupes: sum=6, sum(uniq)=6, sum(sort)=6 all agree
  'f([4,5]) === 9',
  'f([7]) === 7',
].join('\n'))
// Here sum(xs) is size2 (minimal). uniq/sort wrappers are size3 -> never minimal. Likely solved sum.

// Better target: force the minimal solution to REQUIRE a wrapper so twins are same size.
// f returns a SORTED-UNIQUE array. On no-dupe ascending inputs: xs===sortAsc(xs)===uniq(xs).
// Solutions of size2: sortAsc(xs), uniq(xs), reverse? Provide ascending no-dupe examples.
show('sortAsc_vs_uniq_arrayout', [
  'export function f(xs: number[]): number[]',
  'f([1,2,3]) === [1,2,3]',   // ascending, no dupes
  'f([2,5,9]) === [2,5,9]',
].join('\n'))
// identity xs also fits and is size1 -> short-circuit/crash. Hmm. Avoid identity: make output differ from input.

// Output reversed-sorted unique on inputs that are descending no-dupes so reverse===sortAsc? no.
// Let's just see what the no-identity sorted case does:
show('sortAsc_vs_uniq_nonId', [
  'export function f(xs: number[]): number[]',
  'f([3,1,2]) === [1,2,3]',   // sortAsc=[1,2,3]; uniq=[3,1,2] NO. uniq keeps order.
  'f([5,4]) === [4,5]',
].join('\n'))

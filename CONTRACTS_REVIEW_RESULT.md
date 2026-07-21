# Contract review — independent pass (cont.98, Opus)

> Reviewer is a DIFFERENT author from the session that wrote the contracts, references,
> suites, and oracles. That is the decorrelation the skim was for. Note the limit honestly:
> this is still a model reviewing a model. It is independent, not human.
>
> Method: each contract checked against its governing specification or against real runtime
> behavior, not against the reference implementation (which would re-correlate the check).
> Every finding below is reproduced with evidence, not asserted.

**Verdict: 17 of 22 clean. 3 real defects, 2 advisories. All 3 mined prompts (M1–M3) confirmed
faithful to their commits.**

None of the defects are wrong *semantics* — they are places where the contract is
under-determined or self-contradictory, so a correct-per-contract agent implementation can
fail the hidden suite. That failure mode is worse than a wrong contract: it converts real
capability into measured failure, silently, exactly what `__taskcorpus_bench` exists to
prevent but cannot see (ref and suite agree with each other in all three cases).

---

## D1 — `queryDecode` (#5): "never throw" is unsatisfiable as written  `[defect]`

Contract: *"An INVALID percent sequence (not followed by two hex digits) is left in the output
literally — never throw."*

The definition of invalid is **syntactic** (two hex digits), but the decode step is
**semantic** (UTF-8). A sequence can satisfy the contract's validity test and still be
undecodable:

```
decodeURIComponent("%C3%28")  →  URIError: URI malformed
```

`%C3%28` *is* followed by two hex digits, so the contract classifies it valid, then demands it
decode, then forbids throwing. An agent implementing the contract literally with
`decodeURIComponent` throws and fails. An agent that guards defensively passes. The suite tests
neither, so the reference's behavior here is arbitrary and untested.

**Fix:** state the byte-level rule explicitly — *"a percent-escape run that is not well-formed
UTF-8 is emitted literally, byte for byte; decoding never throws for any input"* — and add a
suite case for `%C3%28`.

---

## D2 — `retryDelays` (#13): exact float equality without specifying the computation  `[defect]`

Contract: *"attempt i waits baseMs * factor^i"* and *"Results are exact numbers (no rounding)"*,
with the suite comparing exact values.

`Math.pow(f, i)` and iterated multiplication are both faithful readings of `factor^i` and they
are **not bit-identical**. Measured across 6 factors × 4 bases × 12 attempts:

```
134 mismatches — e.g. base=1, factor=1.1, i=4:
  iterative = 1.4641000000000006
  Math.pow  = 1.4641000000000004
```

A correct implementation fails on `===` depending only on which form it chose. This is a
coin-flip failure with no relationship to capability.

**Fix (either):** pin the algorithm in the contract (*"computed as repeated multiplication from
the previous delay"*), or compare with a relative epsilon in the suite. Pinning is better — it
keeps the suite exact.

---

## D3 — `posixResolve` (#17): contract deliberately diverges from its own foreign oracle  `[defect]`

Contract: *"A trailing slash is dropped except for the root itself ('/a/' → '/a')."*

Node disagrees, and `path.posix.normalize` is listed in `__refdiff_bench.ts` as one of the
**strongest** (foreign-implementation) oracles for this task:

```
path.posix.normalize("/a/")   →  "/a/"     (preserved)
path.posix.normalize("/a/b/") →  "/a/b/"   (preserved)
path.posix.normalize("a/b/")  →  "a/b/"    (preserved)
```

The divergence is legitimate as a design choice, but it means the node oracle cannot be used
raw — it must be wrapped with a trailing-slash normalization step. If it is currently wrapped,
that wrapper is a hand-written adjustment authored by the same session, which **downgrades this
oracle from foreign-implementation strength to shadow strength**, and the bench header's
decorrelation ranking overstates it.

**Fix:** confirm the wrapper exists; if so, re-rank this oracle in the header. Better: change
the contract to preserve trailing slashes and match node exactly, recovering a genuinely
foreign oracle for free.

---

## A1 — `wordWrap` (#3): overlong-word-mid-line behavior is under-determined  `[advisory]`

Contract: *"A single word longer than width is hard-split into width-sized chunks"* — but not
whether the split begins at the current line's remaining space or on a fresh line.

Given `width=10`, `"ab supercalifragilistic"`, both readings are defensible:
- fill first: `"ab superca"` / `"lifragilis"` / `"tic"`
- fresh line: `"ab"` / `"supercalif"` / `"ragilistic"`

The suite has an `overlong word mid-text` case, so one was chosen — the contract just never
says which. Add one clause naming the intended behavior.

---

## A2 — `fractionAdd` (#20): exactness ceiling is unstated  `[advisory]`

`Fraction = [number, number]` with a promise of *exact* lowest-terms results. Cross-multiplying
two large coprime denominators exceeds `Number.MAX_SAFE_INTEGER` and exactness silently fails.
The suite's `large coprime denominators` case presumably stays under the ceiling. State the
supported magnitude, or move to `bigint`.

---

## Confirmed clean (17)

`templateExpand`, `csvLine`, `dedentText`, `intervalMerge`, `intervalSubtract`, `ringBuffer`,
`minStack`, `bitsetRange`, `slidingWindowMax`, `tableMachine`, `deepEqualCyc`, `jsonPointerGet`,
`runLength`, `bankersRound`, `baseConvert`, `dateRangeDays`, `matrixRotate`.

Spot-verifications performed against the governing spec rather than the reference:

- **`jsonPointerGet`** — `~1`-before-`~0` unescape order matches RFC 6901 §4; leading-zero and
  negative index rejection match §4's array rules; `""` → whole document correct.
- **`bankersRound`** — the post-fix shortest-representation semantics are right: `9.95` prints
  as `"9.95"`, a true half at 1 decimal, even neighbour `10`. `0.125` → `0.12`. Matches
  `Intl.NumberFormat` half-even. The earlier reversal was the correct call.
- **`intervalMerge`** — adjacency merging (`[1,2]`+`[3,4]`) is correct for inclusive integer
  endpoints, and `[1,2]`+`[4,5]` correctly does not merge.
- **`matrixRotate`** — `output[c][R-1-r] === input[r][c]` verified by hand on 2×2:
  `[[1,2],[3,4]]` → `[[3,1],[4,2]]`. Correct clockwise.
- **`dateRangeDays`** — `[01-01,01-10]` ∩ `[01-08,01-20]` = Jan 8,9,10 = 3. Correct inclusive.
- **`runLength`** — letters-only alphabet makes the count grammar unambiguous; round-trip law
  holds for all legal inputs.

---

## Mined tasks M1–M3 — all confirmed faithful

Checked each prompt against `git show` of its commit.

| task | commit | symptom accurate | contract complete | mechanism leaked |
|---|---|---|---|---|
| M1 aliased-import | `cfede63` | yes | yes (incl. shadowing carve-out) | no |
| M2 default/namespace import | `450cab6` | yes | yes (incl. no-false-abstain) | no |
| M3 apifaith vocabulary | `3265f94` | yes (both directions) | yes | no |

M1's prompt states the all-or-nothing guarantee and preserves the "both imports and shadows →
too ambiguous" refusal, matching the diff. M2's prompt correctly requires *no false abstain* on
unused imports, which is the half of the fix an agent would most likely miss. M3's prompt
captures the asymmetry reasoning (over-inclusion costs a missed check, under-inclusion costs a
false reject) without naming the tight-dot rule. None name the implementing function.

The mined tasks are the strongest in the corpus: reference and suite were authored months apart
by different sessions against live behavior, so they cannot share a blind spot by construction.
**Prioritize scaling these over authoring more synthetic tasks** — the decorrelation is free.

---

## One structural note

D1, D2 and D3 share a shape: the contract is precise about the *happy path* and silent or
self-contradictory at a boundary, and in each case the reference and suite agree with each other
so no machine check fires. That is the residual class the differential oracles were built for —
and it survived them, because the oracle encodes the same reading of the same ambiguous prose.

Cheap systemic mitigation: for each contract, ask *"what is the most reasonable implementation
that would FAIL this suite?"* and either add a case or tighten the wording. That question is
model-answerable and catches the entire class. It would have found all three.

# Extended-corpus contract review (one-time human skim)

> Why you are reading this: the reference solutions, hidden suites, and most of the
> differential oracles share an author (the same session). Machine checks prove they
> are CONSISTENT with each other; they cannot prove the task was UNDERSTOOD correctly.
> If a contract below reads wrong to you — semantics, error contract, or a suite
> expectation — edit the shard file (`src/CrucibleEngine/coding-bench-ext/tasks-*.ts`),
> then rerun `npm run taskcorpus:bench` and `npx tsx .../__refdiff_bench.ts`.
> Mark each task done by ticking its box. This file is GENERATED — edit shards, not this.

Corpus: 22 tasks. Review pass: [ ] not started / in progress / complete

---

## 1. `templateExpand` — Dot-path template expansion with escapes

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement a template expander in TypeScript at src/templateExpand.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export function expand(template: string, ctx: object): string

Semantics:
- Placeholders are written {path} where path is a dot-separated chain of property names,
  e.g. "Hello {user.name}" with { user: { name: "Ada" } } yields "Hello Ada".
- The resolved value is rendered with String(value).
- If any step of the path is missing, or the final value is undefined, the placeholder is
  left in the output verbatim (including its braces).
- A backslash escapes the next character: "\{" is a literal "{" and "\\" is a literal
  backslash; an escaped brace never starts a placeholder.
- An unterminated "{" (no closing "}") is not a placeholder — the rest of the string is
  literal output.
- Error contract: if ctx is null or not an object, throw a TypeError.
```

**What the hidden suite will hold it to:**

- simple replacement
- nested dot path
- missing path kept verbatim
- undefined value kept verbatim
- null renders as "null"
- boolean renders
- array index via dot
- escaped brace is literal
- escaped backslash
- unterminated brace is literal
- adjacent placeholders
- empty template
- null ctx throws TypeError
- string ctx throws TypeError

---

## 2. `csvLine` — Single-line CSV field parser with quoting

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement a CSV line parser in TypeScript at src/csvLine.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export function parseCsvLine(line: string): string[]

Semantics (RFC-4180 style, one line):
- Fields are separated by commas. An empty field is the empty string, including a trailing
  empty field after a trailing comma.
- A field wrapped in double quotes may contain commas and doubled quotes; "" inside a
  quoted field is a literal quote character.
- Whitespace is preserved exactly; no trimming.
- Error contract (throw SyntaxError): a quote character appearing inside an UNQUOTED field;
  characters after a closing quote that are not a comma or end of line; an unterminated
  quoted field; any carriage return or newline in the input.
```

**What the hidden suite will hold it to:**

- plain fields
- empty middle field
- trailing comma yields trailing empty
- single empty line is one empty field
- quoted comma
- doubled quote is literal
- whole-line quoted field
- empty quoted field
- whitespace preserved
- quoted field then empty
- unterminated quote throws
- quote inside unquoted throws
- junk after closing quote throws
- newline in input throws

---

## 3. `wordWrap` — Greedy word wrap with hard-break for overlong words

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement a word wrapper in TypeScript at src/wordWrap.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export function wrap(text: string, width: number): string

Semantics:
- Greedy fill: pack as many words onto a line as fit in width characters, counting the
  single spaces between them; break before the word that would overflow.
- Runs of spaces collapse to a single space; lines never begin or end with a space.
- A single word longer than width is hard-split into width-sized chunks.
- Existing newline characters in the input are hard breaks: each input line wraps
  independently, and empty input lines are preserved as empty output lines.
- Error contract: if width < 1 or not an integer, throw a RangeError.
```

**What the hidden suite will hold it to:**

- no wrap needed
- simple wrap
- exact fit boundary
- one over boundary wraps
- overlong word hard-split
- overlong word mid-text
- spaces collapse
- leading/trailing spaces dropped
- existing newlines are hard breaks
- empty input line preserved
- width 1 splits everything
- empty string stays empty
- lines never exceed width
- width 0 throws RangeError
- fractional width throws RangeError

---

## 4. `dedentText` — Common-indentation stripper

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement a dedenter in TypeScript at src/dedentText.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export function dedent(text: string): string

Semantics:
- Compute the minimum leading-whitespace length (spaces and tabs each count as one
  character) across all non-blank lines, then remove exactly that many leading characters
  from every non-blank line.
- Blank lines (empty or whitespace-only) become empty strings, and the line count is
  preserved exactly.
- If there are no non-blank lines, every line becomes empty.
- Relative indentation between lines is preserved.
```

**What the hidden suite will hold it to:**

- uniform indent stripped
- relative indent preserved
- min across lines wins
- no indent unchanged
- blank line becomes empty
- whitespace-only line becomes empty
- blank lines do not affect the minimum
- tabs count as one char each
- mixed tab/space by count
- line count preserved
- all-blank input becomes empties
- empty string stays empty
- single line

---

## 5. `queryDecode` — Query-string decoder with UTF-8 percent sequences

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement a query-string decoder in TypeScript at src/queryDecode.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export function parseQuery(qs: string): Record<string, string | string[]>

Semantics:
- An optional leading "?" is ignored. Pairs are separated by "&"; empty segments are
  skipped. The first "=" splits key from value; a segment with no "=" maps the key to "".
- "+" decodes to a space in both keys and values.
- Valid percent sequences decode as UTF-8 bytes (so multi-byte sequences like %C3%A9
  decode to a single character). An INVALID percent sequence (not followed by two hex
  digits) is left in the output literally — never throw.
- A key that appears once maps to its string; a key that appears multiple times maps to an
  array of its values in order of appearance.
- The empty string (or just "?") returns {}.
```

**What the hidden suite will hold it to:**

- basic pairs
- leading question mark ignored
- plus decodes to space
- plus in key too
- percent decodes
- multibyte utf8 sequence
- invalid percent left literal
- trailing lone percent literal
- repeated key becomes array in order
- no equals means empty value
- equals in value survives
- empty segments skipped
- empty string gives empty object
- just question mark gives empty object

---

## 6. `intervalMerge` — Merge overlapping and adjacent integer intervals

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement interval merging in TypeScript at src/intervalMerge.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]>

Semantics:
- Each interval is [start, end] with start <= end, endpoints inclusive.
- Input may be unsorted. Output is sorted by start, and contains the minimal set of
  disjoint intervals covering exactly the same points.
- Overlapping intervals merge; ADJACENT intervals ([1,2] and [3,4]) also merge, because
  with inclusive integer endpoints there is no gap between them. [1,2] and [4,5] do not.
- The input array and its tuples must not be mutated. Empty input returns [].
- Error contract: any interval with end < start throws a RangeError.
```

**What the hidden suite will hold it to:**

- disjoint stay disjoint
- overlap merges
- adjacent integers merge
- gap of one does not merge
- unsorted input handled
- containment collapses
- duplicate intervals
- point intervals
- negative coordinates
- empty input
- input array not mutated
- inverted interval throws RangeError

---

## 7. `intervalSubtract` — Subtract one set of intervals from another

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement interval subtraction in TypeScript at src/intervalSubtract.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export function subtractIntervals(
    base: Array<[number, number]>,
    remove: Array<[number, number]>,
  ): Array<[number, number]>

Semantics:
- Intervals are [start, end], start <= end, inclusive INTEGER endpoints.
- Result covers exactly the integer points covered by base but not by remove, as a minimal
  sorted list of disjoint intervals.
- Both inputs may be unsorted and may contain overlapping intervals themselves.
- Neither input is mutated. Removing everything (or an empty base) yields [].
- Error contract: any interval with end < start throws a RangeError.
```

**What the hidden suite will hold it to:**

- no removal returns base
- hole in the middle
- trim left edge
- trim right edge
- full cover removes interval
- exact cover removes interval
- single point removed
- multiple holes
- removal spanning two bases
- disjoint removal ignored
- unsorted overlapping inputs
- empty base
- negative coordinates
- inverted remove interval throws

---

## 8. `ringBuffer` — Fixed-capacity ring buffer that overwrites oldest

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement a ring buffer in TypeScript at src/ringBuffer.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export class RingBuffer<T> {
    constructor(capacity: number)
    push(item: T): void
    pop(): T            // removes and returns the OLDEST item
    peek(): T           // returns the oldest without removing
    toArray(): T[]      // oldest -> newest, does not modify the buffer
    get size(): number
    get capacity(): number
  }

Semantics:
- push on a full buffer overwrites the oldest item (size stays at capacity).
- pop and peek on an empty buffer throw an Error.
- toArray returns a fresh array each call.
- Error contract: constructor throws a RangeError unless capacity is an integer >= 1.
```

**What the hidden suite will hold it to:**

- starts empty
- size tracks pushes
- peek is oldest
- toArray oldest to newest
- overwrite drops oldest
- size capped at capacity
- pop returns oldest after wrap
- pop shrinks size
- interleaved push/pop order
- toArray is a fresh array
- capacity one always keeps newest
- pop on empty throws
- peek on empty throws
- zero capacity throws RangeError

---

## 9. `minStack` — Stack with O(1) minimum tracking

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement a min-tracking stack in TypeScript at src/minStack.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export class MinStack {
    push(value: number): void
    pop(): number
    top(): number
    min(): number
    get size(): number
  }

Semantics:
- Standard LIFO stack of numbers; min() returns the smallest value currently on the stack.
- All five operations run in O(1) — in particular min() must NOT scan the stack. The audit
  includes a large-input check that will time out a linear-scan min under the harness cap.
- Duplicates of the minimum are handled: pushing the same minimum twice and popping one
  must keep min() at that value.
- Error contract: pop, top, and min on an empty stack throw an Error.
```

**What the hidden suite will hold it to:**

- top is last pushed
- min through stack
- pop returns last
- min unchanged after popping non-min
- min recovers after popping the min
- duplicate minimum both counted
- one duplicate popped, min stays
- size tracks
- negative values
- negative min recovers
- large interleaved min/pop completes (O(1) min)
- pop empty throws
- min empty throws

---

## 10. `bitsetRange` — Fixed-size bitset over Uint32Array with range popcount

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement a bitset in TypeScript at src/bitsetRange.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export class BitSet {
    constructor(size: number)         // bits 0..size-1, all initially 0
    set(i: number): void
    clear(i: number): void
    get(i: number): boolean
    countRange(start: number, end: number): number  // set bits with start <= index < end
    get size(): number
  }

Semantics:
- Backed by a Uint32Array (one bit per position, 32 positions per word) — the audit
  includes a size that makes a boolean-array-per-bit implementation acceptable, but
  countRange over a large range must complete under the harness cap.
- countRange with start >= end returns 0.
- Error contract: constructor throws a RangeError unless size is an integer >= 1; set,
  clear, and get throw a RangeError for indexes outside 0..size-1; countRange throws a
  RangeError if start or end lies outside 0..size.
```

**What the hidden suite will hold it to:**

- starts clear
- set/get across word boundary
- unset stays false
- full-range count
- subrange excludes end
- subrange includes start
- interior empty range
- start equals end is zero
- start beyond end is zero
- clear works
- double set idempotent
- large range popcount correct
- large subrange popcount
- size 0 throws RangeError
- index at size throws
- negative index throws
- range end beyond size throws

---

## 11. `slidingWindowMax` — Sliding-window maximum via monotonic deque

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement sliding-window maximum in TypeScript at src/slidingWindowMax.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export function slidingWindowMax(values: number[], k: number): number[]

Semantics:
- Returns the maximum of each contiguous window of length k, left to right; for input
  length n the result has n - k + 1 entries.
- Must run in O(n) overall (monotonic-deque or equivalent) — the audit includes an input
  large enough that an O(n*k) rescan per window exceeds the harness cap.
- k equal to the input length returns a single maximum; k = 1 returns a copy of the input.
- Error contract: throw a RangeError if k is not an integer, k < 1, or k > values.length
  (including any k against an empty input).
```

**What the hidden suite will hold it to:**

- classic case
- k=1 is identity copy
- k=n single max
- descending input
- ascending input
- all equal values
- duplicates of max inside window
- negatives
- single element k=1
- large input completes (O(n) required)
- spot-check large windows against rescan
- k beyond length throws
- k=0 throws
- empty input throws

---

## 12. `tableMachine` — Table-driven finite state machine with history

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement a finite state machine in TypeScript at src/tableMachine.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export interface MachineDef {
    initial: string
    transitions: Record<string, Record<string, string>>  // state -> event -> next state
  }
  export class Machine {
    constructor(def: MachineDef)
    get state(): string
    can(event: string): boolean
    send(event: string): string      // returns the new state
    get history(): string[]          // states visited, oldest first, including initial
  }

Semantics:
- send(event) moves along the transition table; can(event) reports whether send would
  succeed from the current state without changing anything.
- history includes the initial state and every state entered by a successful send; a fresh
  copy is returned on each access.
- Self-transitions (state -> same state) are legal and are recorded in history.
- Error contract: the constructor throws an Error if def.initial has no entry in
  def.transitions; send throws an Error naming the current state and the event when the
  transition is undefined (the machine state must remain unchanged).
```

**What the hidden suite will hold it to:**

- starts at initial
- can on defined event
- can on undefined event
- can does not change state
- send returns new state
- state updated
- self-transition legal
- chained transitions
- full cycle back to idle
- history includes initial and every entry
- history is a fresh copy
- undefined transition throws
- error names the event
- error names the state
- failed send leaves state unchanged
- unknown initial state throws at construction

---

## 13. `retryDelays` — Deterministic exponential backoff schedule

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement a backoff-schedule calculator in TypeScript at src/retryDelays.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export function retryDelays(attempts: number, baseMs: number, capMs: number, factor: number): number[]

Semantics:
- Returns the delay before each retry: attempt i (0-based) waits baseMs * factor^i,
  capped at capMs. Purely deterministic — no randomness, no jitter.
- Results are exact numbers (no rounding); attempts = 0 returns [].
- Once the cap is reached every later entry equals capMs exactly.
- Error contract (throw RangeError): attempts not a non-negative integer; baseMs <= 0;
  capMs < baseMs; factor < 1.
```

**What the hidden suite will hold it to:**

- doubling sequence
- cap applies
- cap exact from then on
- factor 1 is constant
- zero attempts empty
- single attempt is base
- fractional factor allowed above 1
- cap equal to base collapses
- deterministic across calls
- negative attempts throws
- fractional attempts throws
- zero base throws
- cap below base throws
- factor below 1 throws

---

## 14. `deepEqualCyc` — Structural deep equality with cycle detection

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement structural equality in TypeScript at src/deepEqualCyc.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export function deepEqual(a: unknown, b: unknown): boolean

Semantics:
- Primitives compare with the SameValueZero rule: NaN equals NaN, +0 equals -0. All other
  primitives (and functions) compare by identity or strict equality.
- Plain objects compare by own enumerable string keys (order-independent) and recursively
  equal values; arrays compare by length and element-wise recursion. An array never equals
  a plain object.
- null equals only null; undefined equals only undefined.
- Objects of different prototypes beyond plain-object-vs-array need not be supported
  structurally EXCEPT Date (equal iff same timestamp) — everything else may fall back to
  reference equality.
- Error contract: if either input contains a reference cycle reachable during the
  comparison, throw a TypeError (do not hang).
```

**What the hidden suite will hold it to:**

- primitive equal
- primitive unequal
- NaN equals NaN
- plus and minus zero equal
- null only equals null
- nested objects equal
- key order irrelevant
- missing key unequal
- array length mismatch
- array vs object never equal
- nested difference found
- dates by timestamp
- date vs number unequal
- sibling references are not cycles
- repeated non-cyclic subtree ok
- cycle throws TypeError instead of hanging

---

## 15. `jsonPointerGet` — RFC 6901 JSON Pointer resolution

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement JSON Pointer lookup in TypeScript at src/jsonPointerGet.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export function getPointer(doc: unknown, pointer: string): unknown

Semantics (RFC 6901):
- "" (empty pointer) returns doc itself. A pointer is otherwise a sequence of /-prefixed
  reference tokens: "/a/b" resolves doc.a.b.
- In tokens, "~1" unescapes to "/" and "~0" to "~" (in that order of application).
- Array elements are addressed by decimal index tokens; an index with a leading zero
  (other than "0" itself), a negative index, or a non-numeric token applied to an array
  resolves to undefined.
- Any missing step resolves to undefined (never throws for absent paths). Empty-string
  keys are legal: "/" addresses the "" property of doc.
- Error contract: a non-empty pointer that does not start with "/" throws a SyntaxError.
```

**What the hidden suite will hold it to:**

- empty pointer is whole doc
- object property
- deep chain
- array by index
- array second element
- escaped slash ~1
- escaped tilde ~0
- empty-string key via "/"
- percent in key untouched
- missing key is undefined
- missing deep path is undefined
- array index out of range undefined
- leading-zero index rejected
- negative index rejected
- non-numeric token on array rejected
- index through primitive undefined
- missing leading slash throws SyntaxError

---

## 16. `runLength` — Run-length encode/decode with strict grammar

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement run-length coding in TypeScript at src/runLength.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export function rleEncode(s: string): string
  export function rleDecode(s: string): string

Semantics:
- Encoding: each maximal run of a repeated character becomes the character followed by its
  decimal count, count always present: "aaab" -> "a3b1". Empty string encodes to "".
- The alphabet is letters only (a-z, A-Z), case-sensitive.
- Decoding inverts encoding exactly: "a3b1" -> "aaab". Counts are positive decimal
  integers with no leading zeros and may be multi-digit ("a12" -> 12 a's).
- Error contract (throw SyntaxError): encoding input containing a non-letter; decoding
  input with a zero count, a leading-zero count, a letter with no count, a count with no
  preceding letter, or any non-alphanumeric character.
- Round-trip law: rleDecode(rleEncode(s)) === s for every legal input.
```

**What the hidden suite will hold it to:**

- basic encode
- single chars all count 1
- long run multi-digit count
- case sensitivity
- empty encodes empty
- re-run after gap counts separately
- basic decode
- multi-digit decode
- empty decodes empty
- round trip identity
- round trip on alternating
- encode rejects digit
- encode rejects space
- decode rejects zero count
- decode rejects leading zero
- decode rejects letter without count
- decode rejects count without letter
- decode rejects punctuation

---

## 17. `posixResolve` — POSIX path normalizer without the fs module

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement POSIX path normalization in TypeScript at src/posixResolve.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.
Do NOT import node's "path" or "fs" modules — this is a pure string algorithm.

Export exactly:
  export function normalizePath(p: string): string

Semantics:
- Collapse repeated slashes; resolve "." segments away; resolve ".." against the previous
  real segment.
- Absolute paths (leading "/"): ".." at the root is clamped ("/../a" -> "/a").
- Relative paths: leading ".." segments that cannot be resolved are preserved
  ("../../a" stays "../../a"; "a/../../b" -> "../b").
- A trailing slash is dropped except for the root itself ("/a/" -> "/a", "/" -> "/").
- The empty string and "." both normalize to "."; a relative path that fully cancels
  ("a/..") normalizes to ".".
```

**What the hidden suite will hold it to:**

- already normal
- collapse repeated slashes
- dot segments removed
- dotdot resolves
- dotdot chain
- root clamp
- root multi clamp
- relative preserved dotdot
- relative overflow becomes dotdot
- relative full cancel is dot
- empty is dot
- dot is dot
- trailing slash dropped
- root stays root
- relative trailing slash dropped
- dotdot after real segments
- mixed mess
- no path module used

---

## 18. `bankersRound` — Half-to-even (bankers) rounding at a decimal place

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement bankers rounding in TypeScript at src/bankersRound.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export function bankersRound(value: number, decimals: number): number

Semantics:
- Round value to the given number of decimal places using HALF-TO-EVEN: a value exactly
  halfway between two neighbours rounds to the neighbour whose last digit is even
  (2.5 -> 2, 3.5 -> 4 at decimals = 0).
- Non-halfway values round normally (2.6 -> 3). Negative values mirror positives
  (-2.5 -> -2). decimals may be 0 or positive.
- The value is interpreted through its SHORTEST decimal representation — exactly the
  digits String(value) prints (the same semantics as Intl.NumberFormat halfEven). So
  String(9.95) is "9.95", a true half at 1 decimal, and it rounds to the even neighbour
  10. String(0.125) is "0.125", a true half at 2 decimals, rounding to 0.12. Do NOT
  operate on the raw binary expansion (9.95 is stored as 9.9499...; that expansion is
  irrelevant here).
- Error contract: throw a RangeError unless decimals is an integer 0..12; throw a
  TypeError if value is NaN or not finite.
```

**What the hidden suite will hold it to:**

- half to even down
- half to even up
- half at zero
- half at one point five
- non-half rounds normally up
- non-half rounds normally down
- negative mirrors positive half
- negative non-half
- two decimals half to even
- two decimals half to even up
- shortest-repr: 24.6765 is a true half at 3 decimals
- two decimals normal
- integer passthrough
- already at precision
- shortest-repr: 9.95 is a true half, even neighbour is 10
- carry across digits
- zero stays zero
- negative decimals throws
- fractional decimals throws
- NaN throws TypeError
- Infinity throws TypeError

---

## 19. `baseConvert` — Arbitrary-length base conversion 2..36

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement base conversion in TypeScript at src/baseConvert.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export function convertBase(digits: string, fromBase: number, toBase: number): string

Semantics:
- digits is a number written in fromBase using 0-9 then a-z (case-insensitive on input);
  output uses lowercase. Result is the same number written in toBase.
- Must be correct far beyond Number.MAX_SAFE_INTEGER — the audit converts strings dozens
  of digits long (use BigInt or digit-array arithmetic).
- An optional leading "-" is preserved. "0" in any base converts to "0" (never "-0").
- No leading zeros in output; input MAY carry leading zeros, which are ignored.
- Error contract (throw RangeError): fromBase or toBase outside 2..36 or not an integer;
  empty digits (or just "-"); any digit not valid in fromBase.
```

**What the hidden suite will hold it to:**

- binary to decimal
- decimal to hex
- hex to binary
- uppercase input accepted
- output is lowercase
- identity same base
- zero in any base
- negative zero collapses
- leading zeros ignored
- negative preserved
- base 36 digits
- beyond MAX_SAFE_INTEGER round trip
- long binary round trip
- base 1 throws
- base 37 throws
- digit invalid for base throws
- letter beyond base throws
- empty digits throws
- bare minus throws

---

## 20. `fractionAdd` — Exact rational addition with normalization

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement exact fraction arithmetic in TypeScript at src/fractionAdd.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export type Fraction = [number, number]   // [numerator, denominator]
  export function addFractions(a: Fraction, b: Fraction): Fraction

Semantics:
- Returns the exact sum in LOWEST TERMS: addFractions([1,2],[1,3]) is [5,6].
- Normalized sign: the denominator of the result is always positive; a negative value
  carries its sign on the numerator ([1,-2] is the same number as [-1,2]).
- Zero normalizes to [0,1] regardless of the input denominators.
- Inputs are not mutated. Integer inputs only.
- Error contract: throw a RangeError if any denominator is 0; throw a TypeError if any
  entry is not an integer (this includes NaN and Infinity).
```

**What the hidden suite will hold it to:**

- halves plus thirds
- reduces to lowest terms
- whole number result
- zero normalizes
- zero plus zero
- negative numerator input
- negative denominator normalized
- both negative cancels
- double negative is positive
- result denominator always positive
- large coprime denominators
- inputs not mutated
- zero denominator throws RangeError
- float entry throws TypeError
- NaN entry throws TypeError

---

## 21. `dateRangeDays` — Inclusive overlap in days between two ISO date ranges

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement date-range overlap in TypeScript at src/dateRangeDays.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export function overlapDays(a: [string, string], b: [string, string]): number

Semantics:
- Each range is [startISO, endISO] with date-only ISO strings ("2024-02-28"), endpoints
  INCLUSIVE, interpreted as UTC calendar days (no timezones, no clock reads).
- Returns the number of whole days both ranges share: identical single-day ranges overlap
  1; ["2024-01-01","2024-01-10"] and ["2024-01-08","2024-01-20"] overlap 3.
- Disjoint ranges return 0. Ranges touching at one shared day return 1.
- Must be correct across month ends and the Feb-29 leap boundary.
- Error contract (throw TypeError): any string not matching strict YYYY-MM-DD, or naming
  an impossible calendar date ("2023-02-29", "2024-04-31"); (throw RangeError): a range
  whose end is before its start.
```

**What the hidden suite will hold it to:**

- partial overlap
- disjoint is zero
- touching single day
- containment
- identical single day
- identical ranges
- leap day counted
- non-leap february boundary
- across month end
- across year end
- adjacent but not touching
- malformed date throws TypeError
- impossible Feb 29 throws TypeError
- impossible Apr 31 throws TypeError
- datetime string throws TypeError
- inverted range throws RangeError

---

## 22. `matrixRotate` — Rotate a rectangular matrix 90 degrees clockwise

- [ ] semantics confirmed by a human

**Contract handed to the agent:**

```
Implement matrix rotation in TypeScript at src/matrixRotate.ts. Build the COMPLETE, production-quality implementation — no placeholders, no TODOs, no stub bodies. You MUST create the exact file path and export the exact API named below (an automated audit imports it verbatim). Verify it actually runs before reporting done.

Export exactly:
  export function rotate90<T>(matrix: T[][]): T[][]

Semantics:
- Returns a NEW matrix rotated 90 degrees clockwise; the input (rows and outer array) is
  not mutated. An R x C input produces a C x R output where
  output[c][R - 1 - r] === input[r][c].
- Works for non-square shapes: 1xN becomes Nx1 and vice versa.
- The empty matrix [] returns []. A matrix of empty rows ([[], []]) returns [].
- Error contract: ragged input (rows of differing lengths) throws a RangeError.
```

**What the hidden suite will hold it to:**

- 2x2 rotation
- 3x3 rotation
- 1xN becomes Nx1
- Nx1 becomes 1xN reversed
- 2x3 becomes 3x2
- single cell
- empty matrix
- rows of zero length
- four rotations restore square
- strings preserved
- input not mutated
- outer array not aliased
- ragged input throws RangeError

---

# Git-mined tasks (W42.2) — prompt-vs-commit skim

> For each task: read the symptom prompt, then the real fix commit it was derived
> from (command given per task). Confirm the prompt (a) states the symptom the diff
> actually fixes, (b) states the full expected contract the pinned bench enforces,
> and (c) never dictates the mechanism of the patch.

---

## M1. `mined-aliased-import-propagation` — Whole-tree signature propagation skips aliased importers (real bug, 2026-07-12)

- [ ] prompt matches the commit, human-confirmed

Real fix: `cfede63b463f` — “Fix aliased-import hole in whole-tree signature propagation” (view: `git show cfede63b463f`)

**Symptom prompt handed to the agent:**

```
Bug report for src/CrucibleEngine/reasoning/emitPlan.ts. This is a BUG-FIX task in an existing TypeScript codebase. The workspace already contains the target file plus its immediate imports. Fix the bug by EDITING the target file ONLY — do not create, rename, or modify any other file. Preserve the file's existing exports and all unrelated behavior: an automated audit runs the subsystem's full regression bench (which you cannot see) against your edited file, and it fails if anything else regressed.

SYMPTOM — whole-tree signature propagation silently ships broken aliased importers.
When planEmitTree propagates a changed function signature across the tree, a sibling
file that imports the entry function UNDER AN ALIAS is left untouched. Example: the
entry 'fmt' in src/fmt.ts gains a parameter, and a sibling reads

  import { fmt as f } from './fmt'
  export const banner = f('hi', 10)

Siblings importing { fmt } by its original name get their call sites reconciled to the
new signature, but the aliased sibling above comes back unchanged — reported as already
fitting — because its call sites are written f(...), and they were searched under the
name 'fmt'. The emitted tree is broken at exactly the aliased call sites. This violates
the planner's all-or-nothing guarantee: every importer is reconciled, or the whole edit
is refused with a note.

EXPECTED — a sibling that binds the entry under any local alias has those aliased call
sites found and reconciled exactly as if it imported the original name; when an aliased
call cannot absorb the new signature, the whole edit is refused, same as the non-aliased
path. A file importing the entry under several local names has all of them handled. A
sibling that both imports the entry and shadows it locally keeps its current
too-ambiguous refusal. Behavior for non-aliased importers must not change.
```

**Discriminating checks the fix commit added to the pinned bench:**

- aliased importer (`pad as p`) → call sites under the ALIAS are trimmed, not skipped
- aliased importer with an unabsorbable REQUIRED param → whole edit downgrades to fresh file

---

## M2. `mined-move-default-namespace-import` — Move refactor misses default/namespace import deps (real bug, 2026-07-13)

- [ ] prompt matches the commit, human-confirmed

Real fix: `450cab67e0f5` — “Fix silent-break hole in move refactor: detect default/namespace import use” (view: `git show 450cab67e0f5`)

**Symptom prompt handed to the agent:**

```
Bug report for src/CrucibleEngine/reasoning/emitPlan.ts. This is a BUG-FIX task in an existing TypeScript codebase. The workspace already contains the target file plus its immediate imports. Fix the bug by EDITING the target file ONLY — do not create, rename, or modify any other file. Preserve the file's existing exports and all unrelated behavior: an automated audit runs the subsystem's full regression bench (which you cannot see) against your edited file, and it fails if anything else regressed.

SYMPTOM — the move-function refactor silently breaks the destination when the moved
definition depends on a default or namespace import. planMoveTree must refuse to move
(abstain) when the definition is not self-contained — its body uses local bindings
introduced by the source file's import statements — unless the dependency is carried
along. That detection currently sees NAMED imports only. A definition using a default
import:

  import yaml from 'some-yaml-lib'
  export function readCfg(p: string) { return yaml.parse(p) }

or a namespace import:

  import * as os from 'os'
  export function tmpFor(name: string) { return os.tmpdir() + '/' + name }

is judged self-contained, so it is moved WITHOUT its dependency and the destination
file references a name that does not exist there — a silent break, invisible to the
transform because cross-file resolution is outside its view.

EXPECTED — the self-containment check sees every local binding an import statement
introduces: named bindings (including renamed ones), the default-import binding, and
the namespace binding. A moved definition using any of them is treated exactly like one
using a named import today (carried when possible, otherwise the move abstains).
Unrelated imports the definition never uses must NOT cause a false abstain: moving a
definition that touches no imported names still succeeds even when the source file has
default or namespace imports at the top.
```

**Discriminating checks the fix commit added to the pinned bench:**

- move ABSTAINS when the def uses a DEFAULT import (would lose it — transform cannot resolve)
- move ABSTAINS when the def uses a NAMESPACE import
- move does NOT falsely abstain on unrelated imports the def never uses

---

## M3. `mined-apifaith-vocabulary` — API-faithfulness vocabulary bug: false certify AND false reject (real bug, 2026-07-16)

- [ ] prompt matches the commit, human-confirmed

Real fix: `3265f947da14` — “Fix the prose-vocabulary bug: it false-CERTIFIED and false-REJECTED” (view: `git show 3265f947da14`)

**Symptom prompt handed to the agent:**

```
Bug report for src/CrucibleEngine/reasoning/apiFaithfulness.ts. This is a BUG-FIX task in an existing TypeScript codebase. The workspace already contains the target file plus its immediate imports. Fix the bug by EDITING the target file ONLY — do not create, rename, or modify any other file. Preserve the file's existing exports and all unrelated behavior: an automated audit runs the subsystem's full regression bench (which you cannot see) against your edited file, and it fails if anything else regressed.

CONTEXT — documentedIdentifiers(evidence) harvests the vocabulary of identifier names
that a retrieved documentation text actually documents; the faithfulness verifier then
flags generated code whose library identifiers are absent from that vocabulary as
fabricated. One vocabulary bug currently fires in BOTH directions:

FALSE REJECT (the worse direction) — the harvester refuses single-character
identifiers, so 'z' can never be documented. With evidence plainly containing
'const ipv4 = z.ipv4();', code that writes the canonical zod import of z is reported
as fabricating 'z', and the repair loop is told to fix correct code. Single-character
namespace bindings such as z, _ and $ are the norm for popular libraries, not noise.

FALSE CERTIFY — the member-access harvesting rule tolerates whitespace between the dot
and the following name, so a prose sentence boundary reads as member access. Evidence
prose ending one sentence with 'addresses.' and starting the next line with 'Zod v4'
admits 'Zod' into the vocabulary, and fabricated code importing Zod (capital Z, a name
the library never exports) certifies green. Real member access never separates the dot
from the member name with whitespace; prose sentence boundaries do.

EXPECTED — both directions close at the harvester, and every consumer of the shared
vocabulary inherits the fix. The single-character floor is gone: any identifier that
genuinely appears called, dotted, or imported in evidence is documentable regardless of
length. Prose across a sentence boundary no longer enters the vocabulary. Dotted usage
in evidence documents both sides of the dot (the namespace root and the member), and a
chained member call starting its own line — a dot-leading line continuing a builder
chain — still documents that member. Ambiguity resolves toward abstain-side safety:
harvest generously from real code shapes, exclude only what is provably prose.
```

**Discriminating checks the fix commit added to the pinned bench:**

- [REAL] fabricated `import { Zod }` → violations (was CERTIFIED)
- [REAL] names Zod as the offender
- [REAL] canonical `import { z } from zod` certifies (was REJECTED)
- sentence boundary `addresses.\\nZod` does not document Zod
- sentence boundary `instantly. Perfect` does not document Perfect
- namespace root `z` in `z.ipv4()` IS documented
- member `ipv4` in `z.ipv4()` IS documented
- chained `\\n  .min(` still documents min
- chained `.trim()` still documents trim
- chained evidence still documents the root z
- single-char namespace `_` (lodash) certifies

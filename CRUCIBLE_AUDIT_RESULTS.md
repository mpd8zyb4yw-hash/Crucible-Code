# Crucible Ground-Truth Audit — Results

Run 2026-07-16 on `crucible-northstar-sessions` @ `a79bb80`, macOS 26.4 (Darwin 25.4.0),
Node v26.4.0, Apple FM daemon live on :11435.

Every number below was produced by running something on this machine. Raw artifacts are in
`audit-traces/`. Where I formed a conclusion, the evidence is immediately next to it.

---

## THE ONE-PARAGRAPH VERSION

The verification machinery is real, well-engineered, and mostly live. The **benchmark suite that
gates every claim of progress does not exercise the model at all** — 968 of 971 checks pass with
the FM daemon pointed at a dead port, and the 3 that don't are written to pass on abstain. That
single fact explains the whole contradiction between "959/959 green" and what actually happens
when a user types a request: of 5 fresh real tasks through the real endpoint, **1 produced
working output, 1 failed honestly, and 3 shipped broken or fabricated results as successes**.
The doctrine's central promise — "abstain means abstain" — is violated in the live path by an
explicit fallback that ships raw unverified FM output after VGR abstains. On the same 5 tasks I
solved 5/5 correctly in a fraction of the wall-clock. The gap to Codex/Claude Code is not
primarily architecture; it is that the proposer is a ~3B model and **nothing in the test suite
has ever measured it**.

---

## 0. Setup sanity check

### Git state

```
$ git log --oneline -3
a79bb80 Phase 0: measure the agentic path — 44% gate inflation, real repo wedged
9c94f11 Fix the porting instruction that was CAUSING the empty-<form> failure
7140639 Break the repair loop's echo fixpoint: 83% of the attempt budget bought nothing

$ git branch --show-current
crucible-northstar-sessions

$ git status --porcelain
 M .crucible-checkpoints.json
```

Working tree is **effectively clean** — one modified file, `.crucible-checkpoints.json`, which is
a runtime state file the server writes, not source. `a79bb80` is my own Phase 0 commit from
earlier today. Note the server's own boot stamp reports `a79bb80+dirty` because of that file.

### `npm install` currency

```
$ npm install --dry-run
up to date in 516ms
236 packages are looking for funding
npm warn allow-scripts 7 packages have install scripts not yet covered by allowScripts:
npm warn allow-scripts   better-sqlite3@12.10.1 (install: node-gyp rebuild)
npm warn allow-scripts   node-llama-cpp@3.19.0 (postinstall: node ./dist/cli/cli.js postinstall)
npm warn allow-scripts   sharp@0.32.6 (install: node-gyp rebuild)
  … (esbuild, fsevents, protobufjs, electron-winstaller)
```

Deps are current. The `allow-scripts` warnings are advisory (npm 11 policy), not failures.

### `npm run dev` boot — both processes up

Full log: [`audit-traces/00-dev-boot.log`](audit-traces/00-dev-boot.log)

```
[1]   VITE v8.0.16  ready in 379 ms
[1]   ➜  Local:   http://localhost:5173/
[0] ◇ injected env (16) from .env.local
[0] [Crucible] running commit a79bb80+dirty (booted 2026-07-16T11:42:42.865Z)
[0] Crucible server running on port 3001
[0] [Sandbox] Python prewarmed
[0] [CORPUS] Living corpus: 5573 active chunks, 8.13MB, 9 domains
[0] [Local] Apple Foundation Models bridge up — on-device inference active
[0] [Integrations] 4 integration tool(s) registered
[0] [ModelRefresh] Free model check complete — +0 enabled, -3 disabled
[0] [Hunter] 14 candidate(s) to probe
[0] [Hunter] Probing: Poolside: Laguna XS 2.1 (free) (openrouter/poolside/laguna-xs-2.1:free)
[0] [Hunter] Failed: Poolside: Laguna XS 2.1 (free) (249ms)
  … 8 probes total
```

Both boot cleanly. Ports verified up:

```
5173 (vite) UP
3001 (server) UP
```

**Unprompted finding #1 — the server makes external model-API calls on boot.** `[Hunter] Probing`
fired **8 times** against `openrouter.ai` with no user action. See §4 claim 1.

### On-device model — verified with a raw call, not an assumption

```
$ curl -s http://127.0.0.1:11435/health
{"model":"apple-fm","provider":"apple-foundation-models","available":true,"detail":"ready","status":"ok"}

$ curl -s -X POST http://127.0.0.1:11435/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d '{"messages":[{"role":"user","content":"Reply with exactly the word BANANA and nothing else."}]}'
{"object":"chat.completion","model":"apple-fm",
 "choices":[{"message":{"content":"BANANA","role":"assistant"},"finish_reason":"stop","index":0}],
 "usage":{"output_tokens_est":1,"latency_ms":2536},
 "id":"fm-1215AA1B-E8BF-4F64-9F8B-F12327FAE3F4"}
```

Real daemon, real process (`local-inference/crucible-fm-daemon 11435`, PID 859, up since Tue),
real response. **Note the latency: 2536 ms to emit one token.** That number is load-bearing for §5.

---

## 1. End-to-end real-task traces (the most important section)

Five fresh tasks, none drawn from any bench file, each sent through the **real `/api/chat` SSE
endpoint** with a real session cookie — the same path `App.tsx` hits (`src/App.tsx:1212`).
Full verbatim streams: `audit-traces/t{1..5}-*.sse`.

### Scoreboard

| # | task | wall | events | asked clarifying Q? | decomposition? | build-negotiation? | ended | **does the output actually run?** |
|---|---|---:|---:|---|---|---|---|---|
| 1 | reverse a linked list + tests | **88.6s** | 80 | no | no | no | answered | **NO — 12 tsc errors** |
| 2 | todo app, localStorage, drag-reorder | **120.5s** | 17 | no | no | no | **honest failure** | n/a (nothing produced) |
| 3 | markdown notes, sidebar + preview | **68.0s** | 19 | no | no | no | `ok:true` | **runs, but is not the app** |
| 4 | Zod IPv4 schema — exact method name | **100.9s** | 77 | no | no | no | answered | **NO — fabricated API** |
| 5 | sliding-window rate limiter + boundary tests | **181.0s** | 379 | no | no | no | answered | **NO — throws on construction** |

**1 of 5 produced anything a user could use, and it wasn't what they asked for. 0 of 5 asked a
clarifying question. 0 of 5 triggered decomposition or build-negotiation.** Model calls are not
directly reported by the stream; the closest proxies are `spentTokens` (t2: 0, t3: 683) and the
per-task attempt counts quoted below.

---

### Task 1 — trivial coding. **VGR abstained, and the system shipped anyway.**

The decisive two lines of the stream:

```json
{"type":"thought","text":"Verification-guided reasoning: proposing candidates and certifying each by execution (no external model)…"}
{"type":"thought","text":"VGR could not certify a solution (abstained) — answering with the on-device model."}
```

Event histogram for the whole 88.6s request:

```
  69  synthesis      4  stage      2  thought      1  thinking
   1  contract       1  layer1     1  local_debate
```

**There is no `verify` event, no `tool_call`, and no `final`.** A trivial coding request never
reached the agent or the verifier. VGR abstained and the answer engine served raw FM output.

The code that reached the user (assembled from the 69 `synthesis` chunks), compiled verbatim:

```
$ tsc -p .   # strict:false, the most permissive setting
ll.ts(1,7):  error TS2300: Duplicate identifier 'Node'.
ll.ts(3,9):  error TS2315: Type 'Node' is not generic.
ll.ts(6,34): error TS2315: Type 'Node' is not generic.
ll.ts(6,39): error TS2304: Cannot find name 'T'.
ll.ts(6,44): error TS2315: Type 'Node' is not generic.
ll.ts(6,49): error TS2304: Cannot find name 'T'.
ll.ts(7,13): error TS2315: Type 'Node' is not generic.
ll.ts(7,18): error TS2304: Cannot find name 'T'.
ll.ts(17,34): error TS2304: Cannot find name 'T'.
… 12 errors total
```

The functions are annotated `Node<T>` but are **not declared generic** — `T` does not exist. The
class collides with the DOM's built-in `Node`. It cannot compile under any setting. The answer was
also **emitted twice** — the same fenced block repeats mid-stream (visible in the assembled text).

And the council signed off:

```json
{"agreement":"unanimous","method":"consensus-vote","confidence":0.97,
 "winnerId":"answer-engine","contributors":["answer-engine","track-s-fm","minicpm5-1b"],
 "mindsChanged":false,"totalLatencyMs":22324}
```

**22.3 seconds of "debate" to unanimously approve uncompilable code at 0.97 confidence, with
`mindsChanged: false`.**

---

### Task 2 — ambiguous build. **The honest one.** The gate worked; the proposer produced nothing.

```json
{"type":"thought","text":"Attempt 1 rejected by the run-and-verify gate (empty completion) — regenerating"}
{"type":"thought","text":"Attempt 2 rejected by the run-and-verify gate (the app does nothing visible: after typing into the field and clicking the \"Complete\" control, nothi) — regenerating"}
{"type":"thought","text":"Attempt 3 rejected by the run-and-verify gate (the app does nothing visible…) — regenerating"}
{"type":"thought","text":"Attempt 4 rejected by the run-and-verify gate (empty completion) — regenerating"}
{"type":"thought","text":"Attempt 5 rejected by the run-and-verify gate (runtime JavaScript errors when the page runs: Uncaught TypeError: Cannot read properties of null (re) — regenerating"}
{"type":"thought","text":"Attempt 6 rejected by the run-and-verify gate (runtime JavaScript errors…) — regenerating"}
{"type":"agent_error","error":"[offline-escalate] FM could not produce a working app after 6 run-verified attempts"}
{"type":"agent_done","ok":false,"stopped":"error","iters":1,"toolCallCount":0,"spentTokens":0,"ms":120358}
{"type":"final","text":"[offline-escalate] FM could not produce a working app after 6 run-verified attempts"}
```

**This is the system working as designed.** The runtime gate caught every bad artifact — empty
completions, dead controls, null derefs — and refused all 6. It ended honestly.

Two problems remain: (a) the user-facing message is a **raw internal error string** with an
`[offline-escalate]` prefix; (b) "drag-to-reorder" is genuinely ambiguous and **nothing asked**.
`resolveBuildTurn` did not fire.

---

### Task 3 — the multi-file app. **`ok: true`. It is a page that says "Sidebar".**

The trace looks like a success story — the gate rejects 4 attempts, then passes one:

```json
{"type":"thought","text":"Attempt 1 rejected by the run-and-verify gate (the page renders nothing — its <body> is empty at load…) — regenerating"}
{"type":"thought","text":"Attempt 3 rejected by the run-and-verify gate (the app renders an EMPTY <form>: you created a form element and wired up its handlers, but never put…) — regenerating"}
{"type":"thought","text":"Generated app.html (attempt 5) — verified in a real headless browser"}
{"type":"tool_result","ok":true,"output":"Wrote 2348 chars to /Users/justin/Desktop/Crucible/ward-fern-wren-form/app.html"}
{"type":"verify","passed":true,"signal":"none","report":"No runnable check detected.","escalate":false,"unverified":true}
{"type":"agent_done","ok":true,"stopped":"final","iters":2,"toolCallCount":1,"spentTokens":683,"ms":67867}
{"type":"final","text":"Wrote app.html — self-contained single-file HTML, inline scripts syntax-verified. Open it with the Preview button to play."}
```

Note the `verify` event: **`passed: true, signal: "none", unverified: true`** → accepted →
`ok: true`. This is live confirmation of the Phase 0 finding — `unverified` is emitted to telemetry
and read by nobody (`loop.ts:584/589` branch only on `!v.passed`).

**What the user actually gets.** The complete shipped artifact's script:

```js
let app = document.getElementById('app');
let notes = [];
function render() {
  app.innerHTML = '';
  let sidebar = document.createElement('div');
  sidebar.textContent = 'Sidebar';          // ← the "sidebar list"
  app.appendChild(sidebar);
  let notesList = document.createElement('div');  app.appendChild(notesList);
  let preview = document.createElement('div');    app.appendChild(preview);
  notes.forEach((note, index) => { /* … never runs: notes is always [] … */ });
}
render();
```

- **There is no way to add a note.** No input, no button. `notes` is `[]` forever, so the
  `forEach` body is dead code.
- **There is no markdown rendering.** `preview.innerHTML = note` — raw text, no parser.
- The "sidebar" is a `div` containing the literal string `Sidebar`.

Rendered in a real browser (`python3 -m http.server 8899` → `http://localhost:8899/app.html`) and
measured from the live DOM. The entire application is the word "Sidebar" on a black background:

```json
{ "visibleText": "Sidebar",
  "inputs": 0, "buttons": 0, "forms": 0, "listItems": 0,
  "bodyHtmlLen": 1253 }
```

**Zero inputs. Zero buttons. Zero forms. Zero list items. The whole visible text of the
"note-taking app" is the string `Sidebar`.**

**And the gate still passes it today**, run directly against the shipped file:

```
$ runtimeVerifyApp(<the shipped app.html>, 'markdown note-taking app with a sidebar list and a preview pane')
runtimeVerifyApp verdict: PASS (null = no objection)
```

**Root cause (universal, not a one-off).** The artifact has **zero controls**, so every
interaction invariant skips via the fail-open branch that exists so a legitimate landing page
passes — `__html_app_bench.ts:316` asserts *"a legitimately static page passes (no controls →
check skipped, fail-open)"*. The gate **never consults the goal kind**, so it cannot distinguish
"landing page" (must pass) from "app with no way to interact" (must fail). Every bench fixture for
this class has a `<form>` or a control; this artifact has neither and walks through the hole.

This is the **same class cont.79h claimed to have closed** with 7 invariants and a 71/71 green
bench. It shipped again today, on the first realistic request.

---

### Task 4 — the lookup. **Total fabrication, and zero grounding fired.**

```json
{"type":"thought","text":"VGR could not certify a solution (abstained) — answering with the on-device model."}
```

What the user was told (verbatim, first 400 chars):

> To validate a string is a valid IPv4 address using the Zod library, you can use the `validate`
> method. […]
> ```python
> from zod import Zod
> ipv4_schema = Zod({ "type": "string", "pattern": r"^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$" })
> if ipv4_schema.validate(ipv4_address): …
> ```

**Zod is a TypeScript library. The answer is Python.** There is no `Zod({...})` constructor and no
`.validate()` method. Every element of this answer is invented.

**No lookup happened.** Grep over the entire 15,935-byte stream:

```
$ grep -ciE "citation|web_search|searching|grounded|http" t4-lookup.sse
0
```

Event histogram — no search/citation event type exists in the stream at all:

```
  66  synthesis   4  stage   2  thought   1  thinking   1  contract   1  layer1   1  local_debate
```

This directly contradicts the cont.69 claim recorded as *"web-grounding is the DEFAULT for EVERY
query"*. For a question that **cannot be answered without a lookup**, zero lookups fired.

**The ground truth was sitting on this machine the whole time.** `zod@4.4.3` is in
`node_modules`:

```
$ node -e "const z=require('zod'); console.log(Object.keys(z).filter(k=>/ip/i.test(k)).join(', '))"
ZodIPv4, ZodIPv6, ZodPipe, ipv4, ipv6, pipe, multipleOf
$ node -e "const z=require('zod'); console.log('string().ip()?', typeof z.string().ip, '| z.ipv4()?', typeof z.ipv4)"
string().ip()? undefined | z.ipv4()? function
```

The correct answer is **`z.ipv4()`**. And the council again: `unanimous`, `confidence 0.97`,
`mindsChanged: false`, 27.3s.

---

### Task 5 — the hard one. **`verify` said `passed:false`, and it shipped anyway.**

```json
{"type":"thought","text":"Answer hit the length budget (open-code-fence) — continuing where it left off…"}
{"type":"thought","text":"Answer hit the length budget (budget-capped) — continuing where it left off…"}
{"type":"verify","passed":false,"report":"The answer appears cut off before finishing."}
```

**Verification explicitly failed and the answer was delivered regardless.** 181 seconds,
379 events, 70KB of stream.

The shipped class, run verbatim:

```
$ tsc -p .
rl.ts(8,3):  error TS2377: Constructors for derived classes must contain a 'super' call.
rl.ts(9,5):  error TS17009: 'super' must be called before accessing 'this' …
  … (one per field)

$ tsx -e "new SlidingWindowRateLimiter(3, 1000)"
RUNTIME ERROR on construction: ReferenceError: Must call super constructor in derived class
before accessing 'this' or returning from derived constructor
```

**The class cannot be instantiated.** Beyond that:

- `tryAcquire` contains **no time logic whatsoever**. It returns `true` the first time a key is
  seen and `false` forever after. `currentWindow += 1` counts calls, not milliseconds. It is not a
  rate limiter by any definition.
- Its own comments claim `// true, true, true, false`; the real behaviour is `true, false, false, false`.
- The "tests" it shipped are **not valid TypeScript**:
  ```
  $ echo 'const limiter = new X(maxRequests: 3, window: 1000);' | tsc --noEmit
  error TS1005: ',' expected.
  error TS1005: ',' expected.
  ```
  Named arguments do not exist in TypeScript.

---

### The same 5 tasks, solved by Claude Code directly (baseline)

Sources: `audit-traces/baseline/`. I am not the interesting part of this comparison — the point is
the delta on identical prompts.

| # | Crucible | Claude Code (me) |
|---|---|---|
| 1 | 88.6s → 12 tsc errors, uncompilable | ~1 min → **`tsc --strict` clean (0 errors), 6/6 tests pass** incl. empty/single/generic/in-place |
| 2 | 120.5s → honest failure, nothing produced | not separately built (same class as #3) |
| 3 | 68.0s → a page saying "Sidebar" | ~2 min → **working app**: sidebar, live preview, full markdown, localStorage persistence verified across reload |
| 4 | 100.9s → fabricated Python API | ~30s → **`z.ipv4()`**, verified by executing it against 7 inputs |
| 5 | 181.0s → throws on construction, no time logic | ~2 min → **`tsc --strict` clean, 7/7 tests pass** incl. the window boundary, true sliding semantics, bounded memory |

Baseline task 1:
```
$ tsc -p .   # strict:true
tsc exit=0 (0 = clean)
errors: 0
$ tsx linkedList.test.ts
  ok even-length list / odd-length list / empty list / single node / generic over string / reverses in place
all passed
```

Baseline task 5 — the boundary cases task 5 asked for and Crucible never attempted:
```
$ tsx rateLimiter.test.ts
  ok allows exactly `limit` then denies
  ok per-key isolation
  ok window boundary (inside denies, at edge allows)
  ok slides continuously (not a fixed bucket)
  ok limit=0 denies
  ok rejects a non-positive window
  ok memory stays bounded under sustained load
all passed
```

Baseline task 3, exercised in a real browser (created a note, typed markdown, reloaded):
```json
{"sidebarTitles":["Audit test note","Welcome"],"previewHasH2":true,"previewHasBold":true,
 "previewHasCode":true,"previewHasLink":true,"previewHasList":true,"previewHasQuote":true,
 "previewHasPre":true,"persisted":2}
```

The same DOM measurement as the Crucible artifact above, for a like-for-like comparison:

```json
{ "inputs": 1, "buttons": 3, "sidebarNotes": 2,
  "previewRendersMarkdown": { "h1h2": 1, "bold": 1, "code": 2, "list": 2, "quote": 1 },
  "persistedNotes": 2 }
```

Crucible: `inputs: 0, buttons: 0, visibleText: "Sidebar"`. Baseline: a usable editor with a live
markdown preview and persistence. Same prompt, same machine, same afternoon.

**Honesty note on my own baseline:** my first cut had two real bugs — the blockquote didn't render
(I escaped HTML *before* block parsing, so `>` became `&gt;` and the regex never matched) and the
sidebar `li` styles leaked into the preview list. **I found both by rendering the page and looking
at it** — which is precisely the step Crucible's pipeline does not do, and precisely why its gate
passed a page that says "Sidebar". I fixed them and re-verified. Neither of us wrote it right the
first time; the difference is the feedback loop, not the first draft.

I did not ask clarifying questions either — for these prompts I made the same judgement call
Crucible did. That is a fair tie, not a Crucible failure.

---

## 2. Dead code / reachability audit

Method: real import-graph walk from `server.ts` (`audit-traces/reach.mjs`), refusing to traverse
*into* bench files, so an edge through a harness never launders a module into "live".
Full table: [`audit-traces/02-reachability.md`](audit-traces/02-reachability.md).

### Totals (production modules; bench harness files excluded)

| dir | files | LOC total | LOC live | LOC bench-only | LOC orphan | % live |
|---|---:|---:|---:|---:|---:|---:|
| reasoning | 19 | 6583 | 6400 | 183 | 0 | 97% |
| agent | 29 | 8582 | 8582 | 0 | 0 | 100% |
| synth | 28 | 9999 | 7666 | 0 | 2333 | 77% |
| retrieval | 1 | 829 | 829 | 0 | 0 | 100% |
| research | 5 | 2082 | 1853 | 0 | 229 | 89% |
| answer | 14 | 3520 | 3520 | 0 | 0 | 100% |
| **TOTAL** | **96** | **31595** | **28850** | **183** | **2562** | **91%** |

Bench harness files themselves: **36 files, 7507 LOC**.

### Correcting the "orphan" column — and correcting myself

Six of the seven "orphans" are **npm-script CLI entrypoints**, not dead code:

```
ocb-runner            ← npm run bench:ocb
prove-all             ← npm run prove:all
synth-prove           ← npm run synth:prove
synth-taxonomy        ← npm run synth:taxonomy
universal-prove       ← npm run synth:universal
validate-batch        ← npm run validate:batch
structuralSynthBridge ← NOT an npm script, NOT imported = TRULY ORPHANED (208 LOC)
```

Counting CLI entrypoints as live, these six directories are **~98% wired, with exactly one truly
orphaned module**. `reasoning/`'s only non-live file is `faultInject.ts` (183 LOC), which is
legitimately a bench harness.

**I was wrong last session.** I claimed "~100 modules in CrucibleEngine, of which maybe 10 are
load-bearing" and called the codebase sprawling. The import graph refutes that. This is a
well-wired codebase, and dead code is not one of its problems.

### UI components — also well-wired

| component | imported by App.tsx? | imported anywhere? |
|---|---|---|
| AgentsTabView | **yes** | 1 |
| BackgroundBlobs | **yes** | 1 |
| CrucibleMark | no | 1 |
| DebugCapture | **yes** | 1 |
| HistoryTabView | **yes** | 1 |
| IntegrationsBinder | **yes** | 1 |
| LibraryBinder | **yes** | 1 |
| LocalModelsPanel | no | 1 |
| MoltenPour | no | 1 |
| NavRail | **yes** | 2 |
| SelfPatcherBinder | **yes** | 1 |
| SelfRepairBinder | **yes** | 1 |
| SettingsTabView | **yes** | 1 |
| SidebarRail | **yes** | 1 |
| AgentPanel | no | 1 |
| AuthScreen | **yes** | 1 |
| CodeRunner | no | 1 |
| MessageList | **yes** | 1 |
| binders / core / panels / ensemble | **yes** | 1–5 |

**Every component is imported by at least one file. No unmounted orphans.**

### BUT — file-level reachability badly overstates liveness

This is the important methodological caveat, and it flips the conclusion for two headline features.
A file counts as "live" if anything imports it — even a type import. Checking the **entry-point
symbols** instead:

```
  decomposeCodeTask        live call sites: 0    in: solve.ts (only inside itself)
  solveByDecomposition     live call sites: 0    in: NONE
  keepBestK                live call sites: 0    in: NONE
  runFaultSuite            live call sites: 0    in: faultInject.ts (bench only — expected)
  solveCodingRequest       live call sites: 2    in: solve.ts, server.ts        ← genuinely live
  composeProposers         live call sites: 5    in: retrievalProposer, mutationRepair, solve
  makeRetrievalProposer    live call sites: 1    in: solve.ts                   ← genuinely live
  planRenameTree           live call sites: 1    in: src/server/refactorRoutes.ts
```

- **`decompose.ts` is functionally dead in production.** `solveByDecomposition` is called exactly
  once — at `solve.ts:263`, *inside* `decomposeCodeTask`, which **nothing calls**. The file is
  "97% live reasoning/" only because `solve.ts` imports its types. `vgr:decompose` benches it
  35/35 and it has never run for a user.
- **`keepK.ts` is functionally dead in production.** `keepBestK`: zero live call sites.
  `keepk:bench` 15/15.
- VGR itself **is** genuinely live — corroborated independently by the `"VGR could not certify"`
  thoughts in the task 1/4 traces.

**Rough honest percentage:** ~98% of the code in these six directories is *imported* from a live
route; but at least two flagship subsystems (~400 LOC + their 450 LOC of benches) are import-live
and call-dead. File-level reachability is the wrong instrument for the question "is this feature
real", and it is the instrument that would have told you decomposition was shipped.

---

## 3. Benchmark realism audit

### 3a. The bench specs, verbatim

`__vgr_bench.ts` — the flagship suite (208 checks). Representative task specs, unedited:

```js
// line 44
goal: 'Write sumEvens(nums) returning the sum of only the even numbers in the array. Empty array → 0.',
entry: 'sumEvens',
cases: [
  { args: [[1, 2, 3, 4]], expected: 6 },
  { args: [[2, 4, 6]], expected: 12 },
  { args: [[1, 3, 5]], expected: 0 },
  { args: [[]], expected: 0 },
  { args: [[-2, -3, 8]], expected: 6 },
],
```
```js
// line 201-207 — sortAsc
verifyByProperty({ value: 'export function sortAsc(a){return a.slice().sort((x,y)=>x-y)}', … })
verifyByProperty({ value: 'export function sortAsc(a){return a}', … })   // must fail
```
```js
// line 267 — add/sub
harvestExplicitExamples('write add(a,b) and sub(a,b). add(2,3) === 5. sub(9,4) === 5. sub(1,1) === 0')
```
```js
// line 283 — harvest fidelity
harvestExplicitExamples('half(3) returns 1.5')
```
```js
// line 310 — single-edit repair
solveCodeTask({ goal: 'fix isAdult', entry: 'isAdult', cases: gold.cases, buggyCode: buggy })
// deterministic repair fixes `>` → `>=` with no model involved
```

`__html_app_bench.ts` (confirmed as the html/app-gate bench, 71 checks) — these are **not tasks at
all**. They are hand-written HTML fixtures asserted against the gate:

```js
const DEAD_JS = `…document.getElementById('f').addEventListener('submit', function (e) {
  e.preventDefault(); var v = …value.trim(); if (!v) return; items.push(v); });`   // must REJECT
const EMPTY_FORM = `…app.appendChild(form);   // no input, no button ever go INSIDE the form`  // must REJECT
const STATIC_HTML = `${HEAD}<body><h1>Acme</h1><p>We make things.</p></body></html>`           // must PASS
const ENTER_ONLY  = …  // a correct Enter-to-commit todo — must PASS
const FILTER_HTML = …  // a filter box that keeps its text — must PASS
```

**Assessment: these are narrow synthetic probes, not realistic user tasks.** `sumEvens` with 5
cases is not "build a markdown note-taking app". The `html_app` suite tests the *gate* against
fixtures the author wrote; it never asks the system to *build* anything.

### 3b. Fresh full run — it reproduces

```
$ npx tsx src/CrucibleEngine/__bench_all.ts
…
PASS  vgr:decompose    35/35  (56.4s)
PASS  keepk:bench      15/15  (0.8s)
PASS  html:app:bench   71/71  (37.1s)
971/971 checks across 33 suites

real 3m18.7s
```

**971/971, zero failures, zero flakes, ~3m19s.** Full log:
[`audit-traces/03-bench-all-fresh.log`](audit-traces/03-bench-all-fresh.log). No suite is disabled
or skipped. The ledger claim reproduces exactly.

### 3c. THE FINDING: the benchmark suite does not exercise the model

Same suite, only change — point the FM daemon at a dead port:

```
$ LOCAL_INFERENCE_URL=http://127.0.0.1:1 npx tsx src/CrucibleEngine/__bench_all.ts
968/968 checks across 33 suites
REGRESSION  vgr:bench: 205 passed < previous 208

$ diff <fresh> <no-fm>
5c5
< vgr:bench 208/208
---
> vgr:bench 205/205
```

**968 of 971 checks (99.7%) pass with no model at all.** Every suite except `vgr:bench` is
byte-identical. Full log: [`audit-traces/03-bench-all-no-fm.log`](audit-traces/03-bench-all-no-fm.log).

This is **by design and documented** — `__vgr_bench.ts:16`:

> `// stable in CI regardless of whether the on-device FM daemon is up.`

The 3 model-dependent checks live in PART B, which **skips rather than fails** when the daemon is
down (208 → 205 silently). And those 3 checks are written like this:

```js
ok('live on-device loop reaches a certified solution OR abstains honestly (never ships unverified)',
   live.status === 'solved' || live.solution === null)
```

**That assertion passes whether the model succeeds or fails.** A proposer that abstains 100% of the
time satisfies all three. So:

> **Zero of 971 checks measure whether the system can produce correct code.**
> They measure that the scaffolding doesn't ship garbage. Those are different claims.

Fair credit — PART B did genuinely solve when I ran it live:

```
PART B — live on-device FM proposer (daemon UP)
    live result: solved in 3 call(s) — solved in 3 model call(s)
    live differential: solved [via differential path] — no example → differential consensus:
      6 case(s) agreed by ≥2 of 3 distinct impls (arity 1, 40 inputs fuzzed); solved in 1 model call(s)
    live metamorphic: solved — no example → sort(asc) canonical reference (0 model calls, certified
      against 2 invariants)
```

The on-device loop **can** solve tiny pure functions (`dedupeStable`, `titleCase`, `arrange`). That
capability is real. But the bench would not notice if it vanished tomorrow.

### 3d. Does a passing bench entry mean "would satisfy a real user"?

**No.** Two concrete divergences found today:

1. **`html:app:bench` 71/71 green, and the live app path shipped a page that says "Sidebar"**
   (§1 task 3). The bench's `EMPTY_FORM` fixture pins the "no way to add anything" class — but
   only for artifacts that *have* a `<form>`. The live artifact had **zero controls**, landing in
   the `STATIC_HTML` "legitimately static page passes, fail-open" branch. The suite is green and
   the class it exists to prevent shipped on the first realistic request.

2. **`vgr:decompose` 35/35 and `keepk:bench` 15/15 are green for code with zero live callers**
   (§2). A green suite here means "this module works if you call it". Nothing calls it.

---

## 4. Doctrine vs implementation

### CLAIM: "Zero external paid model API calls" → **PARTIALLY TRUE**

**The inference path is genuinely, structurally on-device.** Two real mechanisms, both verified:

`server.ts:2494` — hard-pinned, not a default:
```ts
const requestOffline: string = 'strict'
```

`server.ts:1463` — a real lowest-level tripwire in `callModel`:
```ts
// ── NORTH-STAR TRIPWIRE (permanent, lowest-level guarantee): on-device models ONLY.
if (provider !== 'local' && provider !== 'synth' && !currentByokKeys()[provider]) {
  throw new OfflineStrictError(provider)
}
```

Corroborated by the live traces: `{"driver":"ON-DEVICE (Apple FM + synth)"}` and
`{"modelId":"local/apple-fm"}`. This part of the doctrine is **real and well-built**.

**But "BYOK keys are the ONLY way external models get called" is FALSE.** `modelHunter.ts`
bypasses `callModel` entirely:

```
$ grep -c "callModel" src/CrucibleEngine/modelHunter.ts
0
$ grep -c "fetch(" src/CrucibleEngine/modelHunter.ts
3
```
```js
// modelHunter.ts:80 — raw fetch, sending the BUNDLED key
fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${apiKey}`, … },
```

Observed **8 outbound probes on boot with no user action** (§0). `.env.local` ships live keys for
five providers:

```
VITE_GEMINI_API_KEY VITE_GROQ_API_KEY VITE_MISTRAL_API_KEY VITE_OPENROUTER_API_KEY VITE_HF_API_KEY
CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_KEY JWT_SECRET GOOGLE_CLIENT_ID … VAPID_PRIVATE_KEY
```

These probes hit **free-tier** models, so "paid" is arguably not violated on a technicality. But
the system contacts external model APIs with a bundled key on every boot, outside the tripwire.
That is worth either fixing or restating in the doctrine.

### CLAIM: "Correctness comes from the loop, not the oracle" → **FALSE on the live chat route**

There is a code-generation path that returns raw model output with **no verifier**. It is not a
timeout fallback or an edge case — it is the documented default when VGR abstains:

```json
{"type":"thought","text":"VGR could not certify a solution (abstained) — answering with the on-device model."}
```

Fired on **task 1 and task 4**. Both shipped raw FM output. Task 1's output does not compile
(12 errors); task 4's is a fabricated API for the wrong language. Neither had a `verify` event
at all.

Worse — on task 5 the verifier **ran, failed, and was ignored**:
```json
{"type":"verify","passed":false,"report":"The answer appears cut off before finishing."}
```
The answer shipped anyway.

### CLAIM: "Abstain means abstain" → **FALSE**

This is the same evidence, and it is the most serious finding in the audit. The doctrine says an
abstain is final. The live implementation treats abstain as a **trigger to ship unverified output**:
VGR abstains → answer engine serves the raw ~3B completion → the council stamps it
`unanimous / 0.97 confidence / mindsChanged:false` → the user sees a confident, authoritative,
uncompilable answer with **no indication whatsoever that verification failed**.

The user-visible text for task 4 begins *"To validate a string is a valid IPv4 address using the
Zod library, you can use the `validate` method."* — stated flatly, no hedge, no abstain notice.

**Where abstain IS honest:** task 2. The app path abstained after 6 gate-rejected attempts and
told the user plainly. So the doctrine holds on the **agent/app** route and fails on the
**answer** route. The UI doesn't paper over it — the answer engine never tells the UI there was
anything to paper over.

### CLAIM: "Cognitive core ~1B, reasoning-dense, not memorization-heavy" → **ASPIRATIONAL-ONLY**

What is actually running:
```
{"model":"apple-fm","provider":"apple-foundation-models","available":true}
```
Apple's on-device Foundation Model — **~3B parameters, off-the-shelf, unmodified, not ~1B, not
reasoning-distilled, and not trained by this project**.

Is there any work toward a distilled core?

```
knowledgeDistillation: 0 files      torch: 0 files       .safetensors: 0 files
training loop: 0 files              LoRA: 6 files (all comments/naming)
fine-tune: 4 files
```

`fineTuning.ts` **is** imported by `server.ts:402` and builds SFT/DPO datasets. But:

```
$ ls .crucible/finetune-jobs.json
  no finetune-jobs.json → no job has ever been submitted
$ grep HF_TOKEN .env.local ; grep HF_REPO .env.local
  HF_TOKEN: ABSENT → submitFineTuneJob cannot run
  HF_REPO:  ABSENT → submitFineTuneJob cannot run
```

No SFT/DPO `.jsonl` artifacts exist on disk (only telemetry ledgers). And the target is
**HuggingFace AutoTrain** (`fineTuning.ts:215`) — a hosted cloud service, which would itself sit
awkwardly against the local-only doctrine.

**Verdict: dataset-export scaffolding that has never executed, cannot execute (no credentials), and
points at cloud training rather than a local ~1B distilled core.** The "~1B reasoning-dense core"
is documentation, not work-in-progress.

---

## 5. What "as good as Codex/Claude Code" would actually require

### The concrete gaps, from §1 evidence

1. **The proposer.** This is the whole ballgame. Every §1 failure is a proposer failure that the
   surrounding machinery either caught (task 2, correctly) or failed to catch (tasks 1, 3, 4, 5).
   A ~3B model that emits `Node<T>` without declaring `T`, invents a Python API for a TypeScript
   library, and writes a rate limiter with no clock is not within reach of the tasks being asked
   of it. **Not speed, not tool breadth, not context window — raw generation quality.**
2. **Speed.** 2536 ms/token measured at the daemon. 88.6s for a linked list; 181s for a rate
   limiter; 68s to produce the word "Sidebar". Claude Code does each in ~1–2 min *including*
   getting them right. Crucible's floor is set by re-sampling a slow model 5–6 times.
3. **Repo scale.** Every §1 task was greenfield. My Phase 0 work this morning found the agentic
   path is **wedged at 0 on this repo** (an ESLint 10 config error fails verification before any
   code is considered) and **cannot service JavaScript projects at all** (`oracle.ts:101`'s
   include glob is `.ts`/`.tsx` only). Codex/Claude Code's core competency — "change this thing in
   my existing 100k-LOC repo" — is currently not reachable.
4. **Grounding that doesn't fire.** Task 4 needed one lookup and did zero, with the answer sitting
   in `node_modules`.
5. **Honest signalling.** The system is confidently wrong. 0.97 confidence on uncompilable code
   is worse than no answer.

### Is closing it (a) engineering, (b) a different architecture, or (c) a compute ceiling?

**Honest read: (c) is real and binding for the "as good as Claude Code" framing, with (a) still
worth a lot for a narrower framing.** Specifically:

**(c) The ceiling is real.** The doctrine's bet is "correctness comes from the loop, not the
oracle" — a weak proposer plus a strong verifier plus search. That bet is *sound in the domain
where a verifier exists and the search space is small*: PART B proves it, certifying `dedupeStable`
and `titleCase` from a 3B model with 1–3 calls, and `arrange` with **zero** model calls. That is
genuinely impressive and it is the real thing this project has built.

But the bet degrades exactly where the value is:
- **Verification requires a spec.** "Build me a markdown notes app" has no `cases` array. The
  html gate is a proxy for a spec, and §1 task 3 shows the proxy has holes you can drive an entire
  non-functional app through — because "is this a good notes app" is not mechanically checkable.
- **Search cost scales with proposer error rate.** At 2.5s/token and a proposer that fails 6/6 on
  a todo app, the loop cannot buy correctness with more attempts. Task 2 spent 120s to prove that.
- **8GB unified memory caps the proposer at ~3B.** The measured failures are not loop failures;
  they are the 3B model not knowing that `T` must be declared. No amount of verification makes a
  model that can't write the code write the code — verification can only *reject* it, which is what
  task 2 correctly did. **A perfect verifier on this hardware yields an honest abstain, not a
  working app.**

**(a) Engineering still buys real things**, and they're worth doing because they're cheap:
- Kill the abstain→ship-anyway fallback (§4). This is a small change that converts "confidently
  wrong" into "honestly abstained" — which is the doctrine's own promise and is *achievable today*.
- Make the bench exercise the proposer (§3c), or every future number is uninterpretable.
- Fix the two infra wedges (ESLint config, `.js` glob) — real-repo work is 0 for reasons that have
  nothing to do with model size.
- Make grounding actually fire (§1 task 4).

**(b) is not needed** — the architecture is not the problem. The verifier ladder, the runtime app
gate, the differential/metamorphic certification are good engineering, and §2 shows they're wired.

**The plain business-relevant statement:** on 8GB with a ~3B core, this architecture can plausibly
reach *"a trustworthy assistant for small, specifiable coding tasks that honestly abstains when it
can't"*. It cannot reach *"Codex/Claude Code"* on this hardware, because that product's value is
generating correct non-specifiable code on the first or second try, and that is a property of the
model, which is the one component the loop cannot substitute for. That is not a discouraging fact
about the work — task 2 and PART B show the loop doing exactly what it promises. It is a fact about
what the loop can be *asked* to compensate for. The strategic question is whether "honest, verified,
small-task, fully-private, zero-cost" is a product; it is a genuinely different and defensible one
from "Claude Code but local", and the evidence says the second is out of reach and the first is
maybe 1–2 hard problems away.

---

## OPEN QUESTIONS / THINGS I COULDN'T VERIFY

1. **Model calls per task are not directly measurable from the SSE stream.** I reported wall-clock,
   event counts, and attempt counts instead. `spentTokens` is reported (t2: 0, t3: 683) but is
   clearly not counting the answer-engine path (t1 shipped ~2KB of text with no token count). I
   did not instrument `callModel` to get a true count; the numbers in §1 are proxies.

2. **§1 is n=1 per task.** Tasks 1–5 ran once each. Given that memory records `fault:live` as a
   ±4pt noise band, single runs are indicative, not conclusive — the *kind* of failure (uncompilable,
   fabricated, throws on construction) is more reliable than the rate. I did not have time for 5×5.

3. **I could not run the 8 Crucible-repo agentic tasks** from my own Phase 0 plan. Not needed —
   the result is deterministic (the ESLint wedge fails verification before any work starts, verified
   with the real verifier: attempt 1 fail, attempt 2 escalate) — but "0/8" is an inference from the
   mechanism, not 8 observed runs.

4. **The "EXERCISED" half of my Phase 0 rubric remains unmeasured** (tsx transpilation breaks V8
   coverage URL mapping). This audit inherits that gap.

5. **`vgr:decompose` 35/35 and `keepk:bench` 15/15 pass for call-dead code.** I verified zero live
   call sites by grep, which cannot see dynamic dispatch (`await import(…)`, registry lookup). I
   found one dynamic import in the codebase (`server.ts:8334`, for `fineTuning`), so the pattern
   exists. I am confident but not certain these are dead.

6. **I did not verify the council/debate adds value anywhere.** I observed `mindsChanged: false`
   and `unanimous / 0.97` on two wrong answers, costing 22–27s. That is two data points suggesting
   it is theatre; it is not a measurement of its value across the distribution.

7. **Whether the 3 live PART B checks would catch a proposer regression:** they would not (they
   pass on abstain), but I did not test whether some *other* suite would. Given 968/971 pass with no
   model, I'm confident the answer is no — but I did not enumerate all 33 suites individually.

8. **`structuralSynthBridge.ts` (208 LOC)** is flagged truly orphaned. I did not read it to
   determine whether it was superseded or is simply not yet wired.

9. ~~**`.env.local` key exposure**~~ — **CHECKED AND CLEAR. No action needed.** Both vectors:
   - *Git*: gitignored (`.gitignore:11: .env*.local`), never committed
     (`git log --all -- .env.local` is empty), untracked.
   - *Bundling*: the keys are `VITE_`-prefixed, which normally means Vite inlines them into the
     client bundle — and `app/` **is** committed and served. But none of the five key values appears
     in `app/`, and there is no `sk-or-…` pattern anywhere in it. Vite only inlines
     `import.meta.env.VITE_*` that client code actually references; these are read server-side via
     `process.env`, so they never reach the bundle. The prefix is misleading but harmless.

   **Methodology note, because it nearly cost me a false finding:** my first pass at this reported
   `*** KEY FOUND IN BUNDLE ***`. That was a bug in my own shell — `grep -rl "$K" app/ | head -3 &&
   echo "FOUND"` fires the `echo` even on zero matches, because `head` exits 0 regardless. I only
   caught it because the follow-up check contradicted the first, and I re-ran with `grep -rlF`, a
   counted result, and a **planted-sentinel positive control** to prove the grep could find anything
   at all. A green check whose failure mode is silent is worthless — which is the same lesson as
   §3c, applied to the auditor.

10. **The 2536 ms/token figure is one sample** (a 1-token completion, which is dominated by
    time-to-first-token). Throughput on long generations may be materially better; I did not
    benchmark tokens/sec on a sustained generation, and §5's speed argument would soften if TTFT
    is the dominant term.

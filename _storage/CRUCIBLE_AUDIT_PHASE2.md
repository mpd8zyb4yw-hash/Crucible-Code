# Crucible Audit — Phase 2: Is Retrieval-as-Brain Actually Wired?

Continues [`CRUCIBLE_AUDIT_RESULTS.md`](CRUCIBLE_AUDIT_RESULTS.md) (Phase 1, commit `1ef48b3`).
Traces: `audit-traces/p2/`.

---

## Verdict (up front)

The question "is retrieval wired?" has **two different answers depending on which path you
mean**, and Phase 1 conflated them. There are two independent retrieval subsystems:

| subsystem | entry | live on `/api/chat` by default? | verdict |
|---|---|---|---|
| **Answer path** — `groundedAnswer.ts::answerWithWebGrounding` | Q&A / factual turns | **PARTLY — question-shaped only; code-shaped prompts bypass it** | **WIRED-BUT-BROKEN** (2 bugs: routing §2.3 open, truncation §3 fixed) |
| **Code path** — `solve.ts::withRetrieval` ← `server.ts::codeWebGround` | VGR code synthesis | **NO — triple-gated off** | **NOT-WIRED-ON-LIVE-PATH** |

**There are TWO independent bugs here, not one, and I initially mis-called this.** My first draft of
this report led with "Phase 1's zero-grounding claim was WRONG." That was itself wrong, and I
caught it by checking Phase 1's raw trace instead of trusting my own re-run. The honest split:

- **Phase 1's finding STANDS.** Its Task 4 trace contains **zero** `sources` events
  (`grep -c '"type":"sources"' audit-traces/t4-lookup.sse` → `0`). Grounding really did not fire.
  I have now **root-caused why**: a *prompt-shape routing gate*. A code-shaped prompt
  (*"Write a Zod schema that validates…"*) **bypasses web grounding entirely** — verified live,
  0 sources events, §2.3. This is the more damaging bug, because that is the phrasing real users
  type, and it is **still open**.
- **A SECOND bug, previously unknown**, sits on the path Phase 1 never reached. Question-shaped
  prompts (*"what is the exact method…"*) **do** ground: 10 sources found, the *correct* zod
  DeepWiki page read. Then a `text.slice(0, 1200)` **threw the answer away**, handing the model
  3.6KB of zod evidence with zero mentions of "ipv4." **This one I found, root-caused, fixed, and
  verified end-to-end** (§3–§4).

So Phase 1's ceiling finding **survives** — but its *diagnosis* was incomplete. The failure was
never "a ~3B model can't reason." On one path the model was never given the evidence
(routing); on the other it was given evidence with the answer cut out (truncation). **In both
cases the model behaved correctly given its inputs.** The retrieval-as-brain thesis is not
refuted by Phase 1 — it was never actually tested, because retrieval never delivered.

And retrieval-as-brain does **not** rescue Phase 1 wholesale either: the *code* path's retrieval is
dead by default, and when force-enabled it fails at extraction for a sibling reason. See §5.

---

## 1. Part 1 — the wiring trace

### 1.1 The code path is gated off by an env flag that is set nowhere

`server.ts:2445` (verbatim, pre-fix):

```ts
const webGroundOrNull = process.env.CRUCIBLE_CODE_WEB_GROUND === '1' ? codeWebGround : undefined
```

Exhaustive grep — the flag exists in **exactly two places, both in server.ts**, and is *assigned*
in none:

```
$ grep -rn "CRUCIBLE_CODE_WEB_GROUND" . --exclude-dir=node_modules --exclude-dir=.git
server.ts:2436:// false answer (doctrine-sound). Only wired when CRUCIBLE_CODE_WEB_GROUND=1 …
server.ts:2445:const webGroundOrNull = process.env.CRUCIBLE_CODE_WEB_GROUND === '1' ? codeWebGround : undefined
```

Not in `.env.local`, not in `launch.sh` / `start.sh` / `electron.cjs`, not in `package.json`.

Consequence at `solve.ts:50` — the silent-disable the task brief predicted:

```ts
if (!webGround) return base   // ← retrieval removed from the proposer chain. No error. No log.
```

**Runtime proof** (tripwire at the boot line, default `npm`-style boot):

```
[AUDIT2] BOOT CRUCIBLE_CODE_WEB_GROUND=undefined -> webGroundOrNull=undefined
```

### 1.2 It is not one gate — it is three

Even setting the flag is insufficient. The two live call sites stack further conditions:

```ts
// server.ts:3948 — the VGR pre-gate (the one that runs on a normal turn)
converge: process.env.CRUCIBLE_CONVERGE === '1',     // ← unset
webGround: webGroundOrNull,                          // ← undefined

// server.ts:3384 — the repair/escalation loop
webGround: tryHard ? webGroundOrNull : undefined,    // ← needs attempt > 1 AS WELL
```

And `solve.ts:514-518` states the design constraint plainly:

> *"Only active on the converge path (that's where research runs). Absent → no web grounding."*

So the code path needs **`CRUCIBLE_CODE_WEB_GROUND=1` AND `CRUCIBLE_CONVERGE=1`** (or a second
attempt) before a single byte is fetched. Measured, not inferred:

| config | `codeWebGround` fired? | `withRetrieval` reached? |
|---|---|---|
| default | no | **no** |
| `CRUCIBLE_CODE_WEB_GROUND=1` | **no** | **no** |
| `CRUCIBLE_CODE_WEB_GROUND=1 CRUCIBLE_CONVERGE=1` | **yes** | **yes** |

### 1.3 "Grounding is the DEFAULT for EVERY query" is a *different subsystem*

The task brief was right to flag this. The cont.69 memory record refers to
`answerWithWebGrounding` (`src/CrucibleEngine/answer/groundedAnswer.ts`), reached from
`answerEngine.ts:369` and `synthDriver.ts:209`. It is **not** `retrievalProposer.ts` /
`codeResearch.ts`, which is the code path above.

They share nothing but the word "grounding" and a common fetch layer:

- `webGrounding.ts` (67 LOC) — a **third** thing again: a DuckDuckGo Instant-Answer wrapper gated
  on `isTimeDependent()`, used for "who is the current CEO"-style queries. Not code, not the
  answer engine.
- `codeResearch.ts` (192 LOC) — contains **no HTTP calls at all**. It takes `webGround` as an
  injected dependency. It cannot retrieve anything on its own.

So the memory claim is true *for the answer path only*, and Phase 1 generalized it to code.

### 1.4 No API key is required — retrieval is keyless by design

Load-bearing fact the brief asked for explicitly: **no paid search API is involved, and nothing is
missing from `.env.local`.** `retrievalLayer.ts` (828 LOC) fetches directly via node `https`:

```
api.github.com   raw.githubusercontent.com   registry.npmjs.org   unpkg.com
api.stackexchange.com   en.wikipedia.org   html.duckduckgo.com   lite.duckduckgo.com   bing.com
```

All keyless/scraped. `GITHUB_TOKEN` only raises rate limits for `certify`. **Retrieval was never
blocked on a credential** — this is a switch that was left off, not a dependency that was absent.

---

## 2. The re-run — Task 4, instrumented

Reconstructed prompt (Phase 1 did not record the verbatim string; noted as a reconstruction):

> *"In the Zod library, what is the exact method to validate that a string is a valid IPv4 address?"*

Fired at the real SSE endpoint with a real session cookie (`audit-traces/p2/fire2.sh`, same shape
as Phase 1's `fire.sh`).

### 2.1 On *this* phrasing, grounding fired — the path Phase 1 never reached

```
[AUDIT2] answerWithWebGrounding FIRED msg="In the Zod library, what is the exact method…"
[AUDIT2] answerWithWebGrounding evidence=sources=[
  "https://deepwiki.com/colinhacks/zod/3.2-string-format-validators",
  "https://dev.to/ashikrnhq04/zod-an-ultimate-validation-library-4048",
  "https://oneuptime.com/blog/post/2026-01-25-zod-validation-typescript/view"]
```

Live SSE events the user actually saw:

```json
{"type":"thought","text":"Searching the web for current, verifiable sources…"}
{"type":"thought","text":"Found 10 sources — reading the top 3: deepwiki.com, dev.to, oneuptime.com…"}
{"type":"sources","phase":"reading","items":[{"url":"https://deepwiki.com/colinhacks/zod/3.2-string-format-validators",…}]}
{"type":"thought","text":"Grounding the answer in 3 sources…"}
```

**S1 is the correct source.** The zod DeepWiki "String Format Validators" page. Raw page contains
`ipv4` 5× and `cidrv4` 4×.

### 2.2 …and the answer was still wrong, now *with citations*

```
According to the evidence, the exact method to validate that a string is a valid IPv4 address in
the Zod library is to use the `regex` method on the `string` schema. The regex pattern used is
`/^\d{5}$/`, which matches a string consisting of exactly five digits. This pattern ensures that
the string is a valid IPv4 address…

For example, the string "192.168.1.1" is valid because it matches the pattern `/^\d{5}$/` …
This method is used in the `addressSchema`… The `zipCode` field in the `addressSchema` is defined
with a regex pattern to validate that the zip code is a valid IPv4 address.

[S1] String Format Validators | colinhacks/zod | DeepWiki — https://deepwiki.com/…
```

`/^\d{5}$/` is a **US ZIP-code regex**. The model claimed `192.168.1.1` matches it (it does not,
and the model cannot execute a regex to find out), and stated outright that "the zipCode field …
validates that the zip code is a valid IPv4 address."

**This is strictly worse than Phase 1's failure.** Phase 1's Task 4 was a naked fabrication.
This is a fabrication wearing three real citations, including a citation to the page that
contains the right answer. Citations raised the confidence of a wrong answer without raising its
accuracy.

### 2.3 The routing gate — Phase 1's finding, vindicated and root-caused

Phase 1 could not have seen §2.1/§2.2, because **its prompt never reached grounding at all.**

```
$ grep -c '"type":"sources"' audit-traces/t4-lookup.sse
0
$ grep -o '"text":"Searching[^"]*"' audit-traces/t4-lookup.sse
(nothing)
```

I reproduced that live. Same server, same session, default config — only the *phrasing* changes:

| prompt | shape | `sources` events | grounded? |
|---|---|---:|---|
| "**In the Zod library, what is the exact method** to validate…" | question | **2** | ✅ yes |
| "**Write a Zod schema that** validates a string is a valid IPv4 address." | code | **0** | ❌ **no** |

The code-shaped answer, ungrounded, in full:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "IPv4 Address Validation",
  "type": "object",
  "properties": { "ip": { "type": "string", "pattern": "^((25[0-5]|…)\\.){3}…" } }
}
```

**That is JSON Schema. The user asked for Zod.** Not a wrong method — the wrong *library*, wrong
*language ecosystem*, delivered with no citation, no abstain, and no lookup. Phase 1's Task 4
verdict ("total fabrication, and zero grounding fired") was **correct**, and this is its cause:

> **The prompts most in need of an API lookup — "write me code using library X" — are exactly the
> prompts routed away from the lookup.** Grounding is gated on the turn looking like a *question*,
> not on whether the model actually knows the answer.

This inverts the cont.69 memory record's claim that "web-grounding is the DEFAULT for EVERY query."
It is the default for *question-shaped* queries only. Fixing this is **Phase 2a** in §7 and it is,
on the evidence, worth more than everything else in this report.

---

## 3. Root cause — proven, not inferred (the *second* bug, on the grounded path)

I dumped the exact evidence block handed to the model.

```
[AUDIT2] EVIDENCE src=deepwiki.com   strippedLen=7955  ipv4At=6370  survivesTruncation=false
[AUDIT2] EVIDENCE src=dev.to         strippedLen=8977  ipv4At=-1    survivesTruncation=false
[AUDIT2] EVIDENCE src=oneuptime.com  strippedLen=17524 ipv4At=-1    survivesTruncation=false
[AUDIT2] EVIDENCE block written len=3614 containsIpv4=false
```

The mechanism, `groundedAnswer.ts` (pre-fix):

```ts
const PER_SOURCE_CHARS = 1200
…
parts.push(`[S${n}] ${item.title || host} — ${item.url}\n${text.slice(0, perSource)}`)
```

**A blind head-slice.** The correct page strips to 7955 chars with `ipv4` at offset **6370**. Only
chars 0–1200 survive. `6370 > 1200` → the answer is fetched over the network, then discarded
in-process.

Worse, two bugs chain. Here is what the 1200-char S1 budget was actually spent on:

```
[S1] String Format Validators | colinhacks/zod | DeepWiki — https://deepwiki.com/…
String Format Validators | colinhacks/zod | DeepWiki Loading... Index your code with Devin
DeepWikiDeepWikicolinhacks/zod Index your code with Devin Edit Wiki Share Loading... Last
indexed: 12 June 2026 (912f0f)OverviewInstallation and SetupBasic Usage ExamplesCore
ArchitecturePackage Structure and ExportsSchema Type SystemValidation PipelineCheck System…
```

**Navigation chrome.** `stripBoilerplate()` does not remove nav sidebars, so the entire budget for
the one page that had the answer went to a table of contents.

And the ZIP regex the model cited is verbatim in the evidence — from **S2**, not S1:

```
zipCode: z.string().regex(/^\d{5}$/, "Invalid zip code"),
```

**So the model behaved correctly given its inputs.** It was instructed *"Ground every factual claim
in the evidence; do not invent facts it does not support."* Its evidence contained zero mentions of
ipv4 and exactly one regex. It used the regex. **The model is not the bottleneck here — the
retrieval-to-evidence pipeline is.**

---

## 4. The fix (universal, shipped, verified)

Per the no-templates rule, this is a mechanism fix, not a zod band-aid:
**replace the head-slice with query-relevance passage selection.**

`groundedAnswer.ts` — new exported `selectRelevantPassages(text, query, budget)`: splits the page
into 400-char windows, scores each by distinct query-term coverage weighted by *inverse page
frequency* (so a rare term like `ipv4` outweighs a ubiquitous one like `zod`), keeps the best
windows within budget, and stitches them in document order with `…` elisions.

Universality guards, deliberate:
- no query-term hits anywhere → **falls back to the exact old head slice** (zero behaviour change)
- page under budget → returned whole
- budget is still respected to the byte

### Before / after, same prompt, same endpoint, same machine

| | evidence | answer |
|---|---|---|
| Phase 1 | (not measured) | fabricated Python `Zod({...}).validate` |
| Phase 2 pre-fix | `containsIpv4=false` | `regex(/^\d{5}$/)` — a ZIP regex, **cited** |
| Phase 2 **post-fix** | **`containsIpv4=true`** | **`ipv4()`** ✅ |

Post-fix answer through the real `/api/chat`, 15.1s:

> The exact method to validate that a string is a valid IPv4 address in the Zod library is to use
> the `ipv4()` validator. This method is documented in the `regexes.ts` file under the
> `Network Address Formats` section.

**This is Phase 1's proposed phase-1 milestone, achieved.** The task brief named it exactly:
*"Task 4's Zod question gets a real web lookup and the correct `z.ipv4()` API, end to end, through
the real endpoint."*

Honest caveats:
- It says `ipv4()`, not `z.ipv4()` — the namespace is dropped.
- The embedded ```ts``` snippet is mangled table-scrape garbage
  (`ValidatorRegexipv4()regexes.ipv4ipv6()regexe`). `stripBoilerplate` flattens HTML tables into
  noise. The *prose* is correct; the *code block* is not copy-pasteable.
- One prompt is one data point. This fixes a proven mechanism, but I did not measure the
  distribution-wide lift.

### No regressions

```
$ npm run ground:bench   → 24/24 passed   (17 pre-existing + 7 new windowing guards)
$ npm run vgr:bench      → 208 passed, 0 failed
```

The new guards include one that **reproduces the original bug**, so it cannot silently return:

```
PASS head-slice baseline would MISS the answer (bug reproduced)
PASS windowing SURFACES the answer within budget
PASS no-match query falls back to head slice (no behaviour change)
PASS rare term (ipv4) beats frequent term (zod) for window selection
```

---

## 5. The code path — and why the same bug lives there too

### 5.1 Task 3 (the markdown app): retrieval is unreachable even with the flag ON

```
[AUDIT2] BOOT CRUCIBLE_CODE_WEB_GROUND="1" -> webGroundOrNull=codeWebGround
t3-codeground wall=25.9s events=13
=== code-path tripwires ===
(nothing — codeWebGround never fired; withRetrieval never called)
```

The app-build path (`synthDriver`) **never calls `solveCodeTask` at all**. So for "build me an
app" — the single most representative user request — the code-retrieval system is not merely
gated off, it is **not on the call graph**. Enabling the flag changes nothing.

### 5.2 Force-enabled on a pure function, it fires — and fails at extraction

`CRUCIBLE_CODE_WEB_GROUND=1 CRUCIBLE_CONVERGE=1`, task: *"Write a TypeScript function
parseDuration that converts '1h30m' or '45s' into total seconds."*

```
[AUDIT2] codeWebGround FIRED query="TypeScript parseDuration converts strings like 1h30m or 45s…"
[AUDIT2] codeWebGround bundle sources=[
  "https://github.com/orknist/typed-duration-parser",
  "https://github.com/orknist/typed-duration-parser/blob/main/README.md"]
  blockLen=1532 codeBlocks=2
[AUDIT2] withRetrieval entry=parseDuration webGround=PRESENT
```

It found a **real, relevant GitHub repo**. Then:

```
VGR · retrieval: source found but no function definitions extracted
VGR · duplicate proposal (stuck) — will force a different approach
VGR could not certify a solution (aborted) — answering with the on-device model.
```

Both sources are the repo landing page and the **README** — markdown prose, not the `.ts` source.
`extractFunctions()` found no function definitions and the retrieval proposer went dry.

### 5.3 The unifying finding

> **Both retrieval paths find the right source and then lose the answer between fetch and model.**
> The answer path loses it to a head-slice. The code path loses it to fetching the README instead
> of the source file.
>
> **Retrieval is not the frontier. Extraction is.**

The search stage — the part everyone assumed was hard, needing a paid API — works. It found the
canonical zod docs page and a correct parseDuration repo on the first try, keyless. What's missing
is the ~200 LOC that turns a fetched page into the *right 1200 characters*.

---

## 6. Revised verdict on Phase 1's ceiling finding

**Phase 1's ceiling finding SURVIVES. Its diagnosis was incomplete, and my first correction of it
was wrong — I retracted that mid-audit after checking its raw trace (§2.3).**

Phase 1 concluded of Task 4: *"Grounding that doesn't fire. Task 4 needed one lookup and did zero."*
**That is accurate**, and §2.3 now supplies the cause: a prompt-shape routing gate sends
code-shaped prompts around grounding. What Phase 1 could not see is that the grounded path is
*also* broken, independently, by evidence truncation — a bug that only surfaces once you get past
the gate Phase 1's prompt never passed.

What **does** survive:

- **Task 3's failure is untouched by any of this.** The app-build path never calls code retrieval,
  and a markdown app has no `cases` array to verify against. Phase 1's "verification requires a
  spec" finding stands, unmodified. Retrieval-as-brain has nothing to say about it yet.
- **The code path really is unwired**, as the brief's Outcome B predicted — same class as
  `decomposeCodeTask` / `keepBestK` in Phase 1: import-live, call-dead. This is now the *third*
  confirmed instance of that pattern. It is the dominant failure mode in this codebase and it is
  not a coincidence — nothing in the bench suite can detect a dead call path, per the cont.80b
  memory record.
- **The bench suite still measures nothing here.** `ground:bench` was 17/17 green across the entire
  period when the answer path was shipping a ZIP regex for an IPv4 question. It tests `rankResults`
  in isolation and never assembles an evidence block. Green benches, broken product — again.

**Reframed thesis:** "the internet is the solver" is *closer to true than Phase 1 suggested*, and
cheaper — the retrieval layer is real, keyless, 828 LOC, and finds correct sources. But it is
wired to one of two paths, silently disabled on the other, and the glue that converts a found page
into usable evidence is the actual unbuilt part.

---

## 7. Build plan

Ordered by evidence-weight, not ambition. Phase 1 is done and in this commit.

### Phase 1 — ✅ DONE: query-relevance evidence windowing
`groundedAnswer.ts`. Milestone met (`ipv4()` end-to-end). `ground:bench` 24/24.

### Phase 2a — route code-shaped prompts through grounding (HIGHEST VALUE — do first)
The §2.3 gate. "Write a Zod schema…" must trigger the same lookup "what is the Zod method…" does.
Locate the shape gate (open question 1), then gate on *knowledge uncertainty*, not grammar.
**Milestone:** the code-shaped prompt in §2.3 returns Zod using `z.ipv4()` instead of JSON Schema.
This is the single highest-value fix in this report: it is the difference between Phase 1's Task 4
verdict standing and falling.

### Phase 2b — fix `stripBoilerplate`
The nav-chrome bug is still live; windowing works *around* it, not through it. Strip nav/aside/
footer/script, and preserve `<table>`/`<pre>` structure instead of flattening it (that's what
mangled the `ts` snippet in §4).
**Milestone:** the post-fix Task 4 answer emits a copy-pasteable `z.ipv4()` snippet, not
`ValidatorRegexipv4()regexes.ipv4`. Pure function, benchable offline, no architecture decision.

### Phase 3 — make the code path fetch SOURCE, not READMEs
In `retrievalLayer.ts`: when a GitHub hit is returned, resolve to actual source files via the
trees API + `raw.githubusercontent.com`, filtering to code extensions, instead of stopping at the
README. §5.2 is the exact regression test — `parseDuration` should certify with retrieved code.
**Note:** this is where the *oracle `.ts`-only glob* from the cont.80 memory record will bite; it
must not be re-created here.

### Phase 4 — ungate the code path
Delete `CRUCIBLE_CODE_WEB_GROUND` and default it on, with a latency budget instead of a flag.
**Blocked on a decision** (see below) — it's a real latency and network-egress change.

### Phase 5 — put retrieval on the app-build path (§5.1)
The largest scope and the least certain. `synthDriver` doesn't call `solveCodeTask`, so this isn't
a wiring change; it needs a retrieval→component-composition mechanism that doesn't exist.

### Genuinely hard — flagged rather than waved through
- **Adapting a found snippet to an arbitrary target signature** is *not* "just retrieval." It is
  program transformation, and it is an open problem. Phases 2–3 succeed by finding the right
  *text*; they do not solve this. I would not commit to Phase 5 on the assumption that it falls out.
- **The "walk away for an hour" mode** was in the brief; I have no evidence to offer on it and
  won't speculate. `search.ts`'s budget model is interactive-shaped (`maxModelCalls: 6-8`,
  40s pre-gate timeout), so a retrieval-heavy long-horizon mode is a different endpoint, not
  bigger numbers — but that's an assessment, not a measurement.

### Decisions for the project owner
1. **Doctrine — is a keyless web *search* in tension with local-only?** My read: no. Doctrine is
   about not routing cognition through an external *model*; `retrievalLayer.ts:1-15` already
   asserts this explicitly and it's the existing precedent. But it's your call, and Phase 4 makes
   it load-bearing rather than opt-in.
2. **Latency budget for ungating.** Task 4 post-fix was 15.1s; the code path with retrieval ran
   ~80s and still aborted. Ungating without a budget regresses the interactive path.
3. **Phase 5 scope** — worth it only if the answer to "adapting snippets" above is a research
   effort you want to fund.

---

## OPEN QUESTIONS

1. **Where exactly is the shape gate?** §2.3 proves the routing bug empirically (code-shaped →
   0 sources) but I did not locate the branch that makes the call. Memory (cont.53/69) points at
   `isResearchShaped` / `isCodeShaped` in `solveNonCodeTurn`, and cont.69 claims these were
   *inverted to ground-by-default* — my measurement says that inversion does not hold for
   code-shaped turns on the live path. **This is the top thread for Phase 3.**
2. **Does windowing lift the distribution, or just this prompt?** One prompt, one reversal. No
   N-task measurement. Per the recalibration rule, I am not claiming a % move on one data point.
3. **What else does `PER_SOURCE_CHARS=1200` silently break?** Any query whose answer sits deep in a
   long page. That's most API-reference questions. The blast radius is likely much larger than
   Task 4.
4. **Is `EVIDENCE_BUDGET=3600` chars the next ceiling?** 3 sources × 1200. Even perfectly windowed,
   that is a very small evidence window for a multi-part question.
5. **Why did `withRetrieval` never log on the non-converge VGR path** despite `solve.ts:187`
   appearing to call it? I established the converge-gate empirically (§1.2) but did not read the
   branch that skips 187. There may be a fourth gate.
6. **Task 3 remains unexplained and unfixed.** Nothing in Phase 2 touches it.

---

## Reproduction

```bash
# the fix, offline
npm run ground:bench            # 24/24, incl. the bug-reproduction guard
npm run vgr:bench               # 208/208

# live, end-to-end (server on :3001, token in audit-traces/p2/.token)
./audit-traces/p2/fire2.sh t4 "In the Zod library, what is the exact method to validate that a string is a valid IPv4 address?"

# prove the code path is dead by default
grep -rn "CRUCIBLE_CODE_WEB_GROUND" . --exclude-dir=node_modules   # 2 hits, both server.ts, 0 assignments
```

Traces: `audit-traces/p2/` — `boot-default.log` (flag undefined), `boot-codeground.log` (flag on,
still no fire), `boot-both.log` (both flags, retrieval fires, extraction fails),
`t4-default-b.sse` (ZIP regex), `t4-fixed.sse` (`ipv4()`), `evidence-block.txt`.

---

# Phase 2a — the routing gate: FOUND, FIXED, and NOT SUFFICIENT

Follow-on session. Traces: `audit-traces/p2/t4-routefix.sse`, `t4-rf2.sse`, `evidence-routefix.txt`.

## The gate, located

**Two** gates, both blocking, in different files.

**`answerEngine.ts:337`** — the shape requirement, stated literally in the source:

```ts
const isGenRequest = CODE_GEN.test(message) || CODE_FENCE.test(message)
const isQuestionShaped = /^\s*(what|how|why|when|which|who|where|does|do|is|are|…)\b/i.test(message)
                         || message.trim().endsWith('?')
const groundingEligible = !usedRetrieval && !useConsensus && !isGenRequest &&
  !facets.needsComputation && isQuestionShaped && …
```

**The code contradicts itself.** `shouldResearch()` — gated *behind* `groundingEligible` — already
encodes the exact finding of this audit:

```ts
if (isCodingQuery(message)) return true   // API/library/language specifics — FM bluffs; SO/docs strong
```

That line can never run for a code-gen prompt. `isGenRequest` / `isQuestionShaped` veto upstream
first. **It is a dead branch inside the gate** — someone already knew the FM bluffs on library APIs
and wrote the rule; the eligibility check silently made it unreachable.

**`synthDriver.ts:207`** — the same veto, reached a different way:

```ts
if (!contextDependent && !isCodeShaped) {
  const g = await answerWithWebGrounding(goal, { history })
```

`isCodeShaped` was written for the **research DAG** at line 221, whose abstain is *preserved as the
final answer* (cont.53). For the DAG, its comment is right — *"over-matching here only means
'answer directly instead of web-retrieving' — the safe failure direction."* **That reasoning does
not transfer to grounding**, which returns `null` and falls through harmlessly. cont.69 added the
grounding block at 207 and reused the DAG's guard, inheriting a condition that does not apply to it.

## The principle behind the fix (not a shape rule)

The "code generation opts out of grounding" rule has a *sound* justification — `answerEngine.ts:239`:

> *"Only the dedicated VERIFIED non-web paths opt out upstream: arithmetic/consensus and code
> GENERATION — those are checked, not memorized."*

True for **algorithmic** work: VGR proposes and *executes* against a spec, which beats a lookup.
It collapses for an **external library**: there is no spec to execute, and an API surface is an
arbitrary fact about the world. **`z.ipv4()` cannot be derived from first principles. Reversing a
linked list can.**

So the fix routes on that distinction — `namesExternalLibrary()` in `retrievalLayer.ts`, using
structural signals only (package nouns, imports, namespaced calls, non-language proper nouns).
**No list of known package names** — that would rot on the next release and is what the
no-templates rule forbids. Language names *are* enumerated, as a closed grammatical class (the
`FUNCTION_WORDS` precedent), so "TypeScript" doesn't read as a third-party library.

Cost asymmetry drove one design call: a **false positive is worse than a miss.** A missed lookup on
a library ask is one bad answer; a needless lookup on algorithmic work **diverts it away from the
verifier that would have certified it.** Hence the digit rule — standards carry version/width
digits (IPv4, UTF8, SHA256), library names essentially never do — which fixed
"write a regex to match an IPv4 address" being misread as a library ask.

## Result: the gate opens. The answer is still wrong.

| prompt | before | after |
|---|---:|---:|
| "Write a Zod schema that validates … IPv4 …" | **0** sources | **2** sources ✅ |

Grounding now fires, retrieves the **same correct** zod DeepWiki page, and the evidence block
**contains the answer**:

```
[AUDIT2] EVIDENCE len=3010 containsIpv4=true
```

**And the model still emitted JSON Schema** — the wrong library, ungrounded, from parametric memory:

```json
{ "$schema": "http://json-schema.org/draft-07/schema#", "title": "IPv4 Address",
  "properties": { "address": { "type": "string", "pattern": "^(25[0-5]|…)$" } } }
```

(A prior run produced `import { Schema } from 'zod'` with a hand-rolled regex — right library, still
fabricated API. Non-deterministic; both wrong.)

### Why — and it is item #2, not a model ceiling

Here is `ipv4` **as it appears in the evidence**:

```
Network Address Formats  Network validators handle IP addresses (v4/v6), CIDR blocks, and MAC
addresses. ValidatorRegexipv4()regexes.ipv4ipv6()regexes.ipv6mac()regexes.mac() (factory for
custom delimiters)cidrv4()regexes.cidrv4cidrv6()regexes.cidrv6
```

That is a documentation **table**, flattened by `stripBoilerplate` into an unreadable run-on.
`ValidatorRegexipv4()regexes.ipv4` is a column header welded to two cells. The answer is *present*
and *illegible*. The model ignored it and fell back on memory.

**This is the same bug class a third time: retrieval delivers, the pipeline mangles, the model gets
blamed.** And it retroactively explains the caveat in §4 — the question-shaped run produced correct
*prose* (`ipv4()`) but a mangled *code block*, from this identical text. The model can sometimes
squeeze the name out of the wreckage for prose; it cannot reconstruct a code sample from it.

**Therefore `stripBoilerplate` (build-plan Phase 2b) is not cosmetic. It is on the critical path**,
and it is now the highest-value remaining fix — promoted above Phase 3.

## Status

- ✅ Routing gate: **fixed and verified** (0 → 2 sources on the exact failing prompt)
- ✅ Truncation: fixed (previous session)
- ❌ **The code-shaped Zod prompt still returns a wrong answer.** Two of three stages are fixed;
  the third (table-mangling) is not, and it is sufficient on its own to keep the answer wrong.

**Phase 1's Task 4 verdict has NOT been overturned for code-shaped prompts.** It is now failing for
a third, fully-characterized reason instead of an unknown one. Grounding fires; the evidence is
right; the rendering destroys it.

Benches: `ground:bench` **41/41** (17 pre-existing + 7 windowing + 17 routing incl. a
`KNOWN GAP` assertion for lowercase library names), `vgr:bench` **208/208**. The one
`retrievalLayer.ts` tsc error is pre-existing (verified by stash).

## Revised order

1. **Phase 2b — `stripBoilerplate` table/structure preservation.** Now proven load-bearing, not
   polish. Milestone: the §2.3 prompt returns Zod using `z.ipv4()`.
2. Phase 3 — code path fetches source, not READMEs.
3. Phase 4 — ungate the code path.
4. Phase 5 — retrieval on the app-build path (Task 3's class; still untouched).

## Added open questions

7. **Would a code-gen-specific synthesis prompt help independently?** `GROUNDING_SYSTEM` is written
   for prose ("Write a clear, accurate, well-structured answer"). A generation ask may need
   "use the API surface in the evidence; never invent an API name." Untested — it may be that
   clean evidence alone suffices, and I would test 2b before adding a prompt variant.
8. **`namesExternalLibrary` misses all-lowercase library names** ("pandas"). Asserted as a
   `KNOWN GAP` in the bench so it stays visible. No structural signal exists; the honest options
   are a package-registry lookup at gate time (latency) or accepting the miss.
9. **Is the false-positive/miss asymmetry calibrated right?** I chose it by argument, not
   measurement. If VGR's certify rate on algorithmic asks is low, the asymmetry inverts.

---

## Phase 2b — stripBoilerplate fixed; the blocker is stage 4 (faithfulness)

**Method: evidence-first. Every claim below is a dump, not an inference.**

### The defect was real
`stripTags` strips `<[^>]+>` with NO separator → block content welds. Reproduced live on
`deepwiki.com/colinhacks/zod/3.2-string-format-validators`:

```
Network validators handle IP addresses... ValidatorRegexipv4()regexes.ipv4ipv6()regexes.ipv6mac()...
```

Fixed (`markBlockBoundaries` + `stripTagsKeepLines`). Same page, after:

```
Validator | Regex
ipv4() | regexes.ipv4
ipv6() | regexes.ipv6
```

Prose path only — `extractCodeBlocks` shares `stripTags`; injecting delimiters would corrupt
lifted code (bench 5h asserts byte-identical output). retrieval:bench 10→18.

### It was not the blocker
Search ranking shifted between sessions. For the actual code-shaped query, S1 is now the CLEAN
`zod.dev/api?id=ip-addresses`; `selectRelevantPassages` selects a window containing a literal
`z.ipv4();` (verified: `z.ipv4() in SELECTED? true`). cont.81b's claim that table wreckage was
"the last stage between correct retrieval and a correct answer" was accurate for its evidence
and is false as a general claim. The `audit-traces/p2/evidence-routefix.txt` diff in c12363e
shows the shift directly (that file regenerates on every live run).

**Stale-process caveat, worth institutionalizing:** the server under test had started at 16:46,
four minutes BEFORE the 16:50 routing-fix commit. Any live claim made against it was measuring
old code. Restarted, re-measured. *Check process start time against commit time before citing a
live run.*

### The measurement that redirects the roadmap
Live, current code: grounds → cites `zod.dev/api?id=ip-addresses` → emits JSON Schema, with a
regex that is now flatly broken (`{3}` = three octets, no dots). The model gets the right answer,
cites its source, and contradicts it.

A/B, identical evidence, same FM, only the system prompt varies:

| system prompt | result |
|---|---|
| PROSE (`GROUNDING_SYSTEM`, current) | JSON Schema; no `z.ipv4()` |
| CODE-AWARE ("use ONLY names literally in the evidence") | no JSON Schema (real gain), but invents `require('zod').validate({...})` + hand-rolled regex |

`GROUNDING_SYSTEM` is a prose-answer prompt ("write a clear answer", "roughly 120-250 words",
"do NOT append an Example section") — it actively fights code output, and Phase 2a routed code
into it. So it is a genuine defect. But the A/B proves it is **necessary and not sufficient**:
told explicitly to copy only evidence identifiers, with `z.ipv4()` in context, the model still
fabricated. A second, independent instance: "what string format validators does zod provide?"
grounded on three thin npmjs.com pages and invented `MinLength`/`IsAlphanumeric`.

**Stage 4 = evidence faithfulness. Retrieval finds it, formatting now preserves it, the prompt
can aim it — and the model still won't copy it.**

### Next: the doctrine-consistent answer (NOT "bigger model")
VGR already answers this: don't trust the proposer, CHECK it. A deterministic
**API-faithfulness verifier** on the grounded code path — extract candidate identifiers from the
evidence, reject emitted library calls absent from it, repair/retry. Un-foolable and
model-independent, the same shape as the cont.58 arithmetic recomputation verifier. Note this
also catches the broken-regex failure only if paired with execution; the faithfulness check
alone would accept `z.ipv4()`.

**OPEN QUESTION 10:** faithfulness rejection needs an identifier inventory from evidence. Prose
mentions (`ipv4()`) and real call syntax (`z.ipv4()`) differ; the check must not reject valid
code that merely differs in namespace binding. Risk: a false reject poisons repair (cont.79h).

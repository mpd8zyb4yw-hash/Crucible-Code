# Crucible — Open Problems & Next Build Priorities

> This document is a handoff for the next engineering session.
> Read ROADMAP.md first for full architectural context.
> These are the gaps that matter most, in priority order.
>
> **STANDING RULE (added 2026-07-03, keep this at the top forever):** the section immediately
> below — CURRENT STATE — is the only part of this file guaranteed to be current. It must be
> REPLACED (not appended to) at the end of every session, before that session ends. Everything
> under "SESSION LOG" further down is a dated archive: useful for history/rationale, but NOT to
> be treated as the current open-items list. This rule exists because a stale, pre-session-N
> snapshot of this file has already been fed as live context to a later session at least once
> (2026-07-03) — the fix is a summary block that gets overwritten, not just more appending.
> If you are reading this file and it does NOT have a CURRENT STATE section immediately below,
> or that section's "last updated" commit/date looks old relative to `git log -1`, treat it as
> untrustworthy and re-derive open items from the SESSION LOG archive and a live repro instead.

---

## CURRENT STATE (last updated 2026-07-04 late, after tripwire RECALIBRATION 2→3 on real
ledger evidence + live verification sweep of the phase-open work — see SESSION LOG below)

**HEADLINE: Frontier-SWE-gap phase ACTIVE; its first two deliverables now VERIFIED against
real data. Tripwire threshold recalibrated 2→3 consecutive identical fingerprints: replaying
fm-rounds.jsonl (18 attempts) showed the 2-round threshold would have killed 2 of the 8
eventual wins (both recovered on round 3 after two identical failures) to save ≤1 round each
in the 7 genuine non-converging runs. Post-recalibration live smoke:code: 6/7 green (gen 2/3),
no lint false positives, tripwire fired live twice on sortModule (compile-only, round 3/3)
with the honest abstain. `prove:all` 250/250 green. Also found+fixed: `@typescript-eslint/parser`
was an UNDECLARED transitive dep — Gate A2 would silently fail open on any install that
dropped it; now pinned ^8.61.0 in devDependencies.**

**NEXT SESSION — HIGH TIER ITEMS (concise):**

1. ~~Restart `:3001`~~ DONE 2026-07-04 late — restarted onto the recalibration commit.
2. ~~Real smoke:code sweep with Gate A2 + tripwire live~~ DONE — see headline. NOTE:
   sortModule got FURTHER than its documented boundary this sweep (module produced,
   12/13 hidden checks pass; only single-element-list + a frozen-types tsc mismatch failed)
   vs the "never produces a module" characterization — the accepted-boundary write-up is
   already partially stale. Re-check it every sweep; do not let it calcify.
2b. **Gate A2 packaged-app check still OPEN:** eslint + parser are devDeps; in a packaged
   Electron/asar build the gate fails open BY DESIGN but silently. Decide: promote to prod
   deps, or log once at startup when `ran:false` so absence is visible.
   (`~/Desktop/Crucible.app/Contents/Resources` has no asar — packaging story unclear, verify.)
3. **Second Workstream 1 critic** — candidates per ROADMAP: contract/interface checking
   between decomposed pieces, or property-based/fuzz testing via a vetted local tool
   (fast-check is the obvious Lego-piece candidate; would also be the 2nd external-tool
   adoption that unlocks considering a registry per the new external-tool invariant).
   `tsc` is ALREADY Gate A — do not re-plan it as a critic.
4. **Workstream 2 (upfront elicitation)** — untouched; planning-workflow change, needs a real
   bounded feature task as its test. Design before building.
5. **Tripwire scope note** — current signal is exact-fingerprint repetition (3 consecutive,
   recalibrated 2026-07-04 late on ledger evidence — see headline).
   sortModule's later rounds sometimes show *fresh, non-repeating* type errors — those still
   burn all rounds by design. A "no two rounds share any failure overlap → also not
   converging" second signal is possible but unproven; only add it with ledger evidence.
6. **Pre-existing, not mine, worth a look:** `synth/catalogs/_author_parsers2.ts` fails
   `tsc -p tsconfig.server.json` with TS1109 at HEAD `d8b6c5f` (untouched by this session).
7. **e002 / e005 (explain category)** — unchanged from 2026-07-03: retrieval-ranking and
   content-relevance gaps, need their own scoping conversation. e003 remains NOT a bug
   (accepted tradeoff; do not loosen `PREMISE_RX`).

**Composite benchmark baseline (conversational suite) as of last confirmed sweep (2026-07-03,
N=3 post premise-gate fix):** pass 0.920 ± 0.000 — unrelated to and not re-run by tonight's
coding-engine work.

---

## SESSION LOG — 2026-07-03 (N=5 confirmation + premise-gate explain-category fix — IMPLEMENTED, VERIFIED, PARTIALLY CLOSED)

**Mandate: run the N=5 confirmation sweep parked from last session, then work down the
open-items list (explain category / Frontier-SWE-gap) as far as comfortable, flagging
decision points rather than guessing priorities.**

**N=5 confirmation sweep — DONE, cl001/cl003 fix CONFIRMED ROBUST:**
- clarify **1.00 / 1.00 across all 5 runs**, zero flips — not a single-run fluke.
- Composite baseline (pre-fix, N=5): pass **0.924 ± 0.008** [0.92, 0.94], cov **0.942 ± 0.004**.
- All other categories held their clean bands (general/definition/abstain/reasoning/
  false-premise all 1.000 ± 0.000). Only `explain` (0.526 ± 0.052) and one flipper
  (e007, GPS wording variance) kept the composite off a perfect 1.0.
- Infra note: the sandbox environment reset mid-run once (port 3001, FM daemon, and all
  `/tmp` scratch state wiped simultaneously, mid-background-process). Git tree was
  untouched. Recovered by restarting the FM daemon (`local-inference/crucible-fm-daemon`,
  not yet a launchd service — see [[crucible-track-s-local-inference]]) and the server,
  then relaunching the sweep from scratch. If this recurs, treat any long
  background/scheduled-wakeup run as possibly needing a full respawn, not just a log check.

**Root-caused explain-category always-fail (e002, e005) — NOT what prior sessions assumed:**
Prior handoffs called this "pre-existing DAG-mangles-explainers." Actual mechanism, traced
via `/api/debug/history` on live fires:
- `checkPremiseGrounding` (`researchDag.ts` — the "Bug A" false-premise fix from an earlier
  session) ran **unconditionally on every research-DAG answer**, not just questions with an
  embedded false premise. On ordinary "explain how X works" questions, the on-device FM
  still gets asked "does the verified fact contradict this question's presupposition?" and
  answers yes with high confidence — hallucinating a contradiction where none exists.
- **e005** ("Explain the water cycle"): a good, complete, grounded 677-char answer was
  discarded in favor of the FM's "correction," which cut off mid-word.
- **e002** ("How does a refrigerator keep food cold?"): the FM's "correction" directly
  negated its own cited source — "Solar-powered refrigerators do **not** keep food cold"
  while the quoted evidence says they can. Confidently wrong AND self-contradicting.
- e003 ("Why is the sky blue?") is unrelated — genuine leaf-level abstain (no source found),
  the already-accepted strict-mode corpus-coverage tradeoff from 2026-07-01. Not a bug.

**Fix — `isPremiseBearing` gate, committed `311ae9f`:**
New primitive in `leafPrimitives.ts` (Primitive 3a) classifies the question as
CLAIM (myth/trivia-shaped, checkable assertion about a named subject — reaches the
existing correction path) or MECHANISM (explaining a well-established phenomenon — skips
it, keeps the grounded synthesis untouched). Wired into `researchDag.ts` ahead of
`checkPremiseGrounding`.

**Verified over 3 fresh full CONVOEDGE_50 sweeps post-fix:** zero regressions.
false-premise held **1.00 ± 0.000** across all 3 (fp001-4 untouched — they're
CLAIM-classified and still reach the correction path). All other categories unchanged.
Composite passRate rock-stable at **0.920 ± 0.000** across the 3 runs. The truncation and
self-contradiction bugs are gone — confirmed by direct re-fire, not just aggregate score.

**Cache-poisoning side-investigation (e002) — dead end, real finding:**
`.crucible/research-claims.json` had a stale claim keyed to "how does a refrigerator keep
food cold" mapping to an off-topic *solar-powered*-refrigerator fact — looked like classic
cache poisoning. Purged it (backed up first to `/tmp/research-claims.json.bak-preclean`,
user-confirmed before the destructive write — the auto-mode safety classifier correctly
blocked two earlier attempts as under-authorized). **Did not fix e002**: fresh live
retrieval reproduces the identical mismatch. The real root cause is the web-search/ranking
layer itself consistently preferring the "Solar-powered refrigerator" Wikipedia article over
the general one for this query — a retrieval-ranking issue, not a cache/data issue. Bigger
and differently-scoped than what was authorized this session; explicitly NOT investigated
further — flagged for a future session to pick up deliberately.

**Current state (post-session, N=1 spot-check):** overall passRate 0.92–0.94 depending on
run (e007 remains a wording-variance flipper, not a regression). explain 0.5–0.63 (e001,
e004, e006, e008 clean; e002/e003/e005 fail for three now well-characterized, distinct
reasons — see above).

**STILL OPEN (unchanged from before, plus one new item):**
- e002 — retrieval/web-search ranking prefers an over-specific source. NEW finding this
  session, not previously diagnosed at this depth. Needs its own scoping conversation.
- e003 — accepted strict-mode corpus-coverage tradeoff (2026-07-01 decision), unchanged.
- e005's remaining gap (post-fix) — the grounded source is accurate but framed around
  water mass-balance rather than evaporation/condensation; a retrieval-content-relevance
  gap, distinct from the truncation bug just fixed.
- Frontier-SWE-gap phase — still untouched. Note: ROADMAP.md's gating condition
  ("timeout verification/regression, clarify wiring, and any still-open false-premise/trust
  diagnosis") no longer names an unresolved item verbatim — timeout and clarify are closed,
  and today's fix hardened the false-premise/trust path further. Whether that means the gate
  is now open is a judgment call left to the user, not decided here.

---

## SESSION LOG — 2026-07-02 (cl001/cl003 clarify-wiring — IMPLEMENTED, VERIFIED, CLOSED)

**Mandate: pick up the parked clarify-wiring thread (cl001/cl003, stuck at 0.500±0.000
across every prior sweep). Diagnose in isolation, fix, confirm against the full
CONVOEDGE_50 sweep before closing.**

**Also closed as a side effect of session-start housekeeping:** the working tree had
gone a long stretch with zero commits (757 files / ~48k lines of accumulated,
undocumented WIP across many sessions — a new chat-conversations store, synthDriver.ts,
researchDag.ts, retrievalLayer.ts wiring, the synth skill library, Electron launch
pipeline, Off-Fly cutover staging, and the corpus-acquisition strict-mode gate this
doc had flagged as still-open — that gate was in fact already fixed, just uncommitted).
All of it is now one checkpoint commit on `crucible-northstar-sessions`. Recommend
committing at the end of every session going forward instead of letting this
accumulate again.

**Root cause — TWO bugs, not one:**
1. The offline-conversational path (`solveNonCodeTurn`, server.ts ~3090) had no
   pre-check for under-specified requests at all — unlike the code-agent path, which
   has a dedicated Tier 2.4 (`ambiguity.ts`) that resolves-or-asks before synthesis.
   Conversational turns just got handed straight to the FM, which always tries to
   produce a confident answer.
2. Compounding it: Track M1's casual-mode short-circuit (`detectConversational` in
   `conversationalMode.ts`, server.ts ~2857) treats any message ≤4 words with no
   `DOMAIN_SIGNAL_WORDS` hit as small talk, and instructs the local model to "mirror
   exactly what was sent." "Book it for tomorrow." (4 words, no domain-signal word —
   `book` isn't in that list) fell into this bucket and got echoed back verbatim
   before ever reaching the conversational pipeline. `translate`/`fix` *are* in
   DOMAIN_SIGNAL_WORDS, so cl002/cl004 were already skipping M1 — this is why the
   bug looked partial rather than total across the 4 clarify cases.

**Fix — new file `src/CrucibleEngine/conversationalClarify.ts`:**
Pure, deterministic, zero-inference — same philosophy as the abstain/false-premise
checks, extended to the "under-specified" failure mode. Three narrow detectors:
- action verb (book/schedule/translate/send/order/buy/...) + a bare dangling pronoun
  object (it/this/that/them) in a short command → ask what it refers to.
- immediate-tense weather question with no location given → ask which location.
  Deliberately excludes far-future/impossible-horizon phrasing (digits, "in exactly
  N days") so it never intercepts a006-style abstain cases — those must still abstain,
  not ask for a location that wouldn't help anyway.
- "fix/solve/debug/resolve the bug/issue/error" with no file path, error text, or
  code identifier → ask which bug/file.

Wired in at TWO points originally (before M1's casual short-circuit, and again before
`solveNonCodeTurn`); the second was provably dead code once the first was in place
(strict subset of the same guard condition, same message, no way to reach it with
`needsClarification` still true) — removed it, kept only the M1-level check.

**Verification (empirical, not assumed):**
- Pure-function check against all 50 CONVOEDGE_50 prompts (no server): exactly the 4
  `cl0xx` prompts fire, zero false positives on the other 46 — including a006
  ("weather... in exactly 100 days"), which stays correctly unintercepted (still
  reaches the FM's own abstain behavior).
- Live N=1 full CONVOEDGE_50 sweep on `:3011` strict, post-fix:
  - **clarify: 1.00 / 1.00 (was 0.500 ± 0.000)** — all 4 pass, ~0ms each (short-circuits
    before any model call).
  - general 1.00, abstain 1.00, false-premise 1.00, reasoning 1.00 — all held their
    prior clean bands exactly.
  - definition 0.88 — the one miss is d005, the same pre-existing surface-form flip
    already documented in the prior session's log, not a new regression (only
    definition-path-independent code changed this session).
  - explain 0.50 — unchanged, still parked, not touched.
- Re-confirmed live after removing the dead second insertion — all 4 cl0xx still pass.

**Not done / open for next session:** N=5 confirmation sweep (this session ran N=1
live + the full-50 pure-function check, per the standing "isolate then confirm"
pattern, but hasn't yet repeated the live sweep 5x the way the daemon-timeout fix did
before updating the baseline of record). Composite baseline not yet formally updated —
do that after an N=5 run. explain category and Frontier-SWE-gap phase remain parked,
untouched this session.

---

## SESSION LOG — 2026-07-02 (daemon-timeout fix — IMPLEMENTED, VERIFIED, CLOSED)

**Mandate: implement fix (d) mislabeled error string + fix (a) FM_TIMEOUT_MS 30s→45s,
verify r001 in isolation, then full convoedge-50 regression N=5 before updating baseline.
DONE — both fixes landed, isolation confirmed clean, full regression confirmed clean.**

**Code changes (both live in the repo now, not yet committed to git — this project isn't
a git repo; changes are just on disk):**
- `src/CrucibleEngine/agent/fmReact.ts`: `FM_TIMEOUT_MS` raised `30_000` → `45_000`, with a
  comment explaining why (healthy generation measured 21-28s, already against the old
  ceiling).
- `server.ts` (~3121, the `offline_conversational_escalate` catch block): now distinguishes
  `e.name === 'TimeoutError'` (FM_TIMEOUT_MS abort — daemon healthy, just slow) from a
  genuinely unreachable daemon (`OfflineEscalateError` health-check failure, or
  `ECONNREFUSED`/`ECONNRESET`) from any other solve failure, and reports the correct one of
  three distinct abstain strings instead of always claiming "daemon is unreachable". Also
  added `errName` to the `debugBus.emit` diagnostic event for future debugging.
- Verified empirically (not assumed) that `AbortSignal.timeout()` rejects with
  `e.name === 'TimeoutError'` and a real `ECONNREFUSED` rejects with `e.name === 'TypeError'`
  + `e.cause.code === 'ECONNREFUSED'`, on this Node version (v26.4.0), before writing the
  distinguishing logic — see the node -e repro if this ever needs re-verifying.

**r001 isolation re-test (CONFIRMED, N=10 cold + N=10 warm, :3011 strict, new code):**
- First attempt (both :3001 and :3011 freshly restarted together, corpus background
  acquisition actively running): cold 8/10 (80%), warm 6/10 (60%) — better than the old
  47%/25% baseline but not at the ~90%+ target.
- Root-caused the shortfall to a confound, not the fix: `initCorpus()` at server.ts:6394
  kicks off a background "deliberate-curation acquisition" cycle (fetches from arxiv.org)
  on EVERY boot with no `CRUCIBLE_OFFLINE` gate — a genuine external-call-under-strict leak,
  same bug class as the already-fixed Hunter boot probes but NOT covered by that fix. It was
  actively running (visible in the :3011 log) during the first isolation attempt and is the
  likely source of the elevated latency/failures (CPU contention on this 8GB machine, not a
  timeout-margin problem).
- Re-ran with `CORPUS_AUTOACQUIRE=0` (existing env escape hatch, used only to get a clean
  benchmark signal — does NOT fix the underlying gate-missing bug): **cold 10/10 (100%),
  warm 10/10 (100%)**, latencies 21-37s, comfortable margin under the new 45s ceiling. This
  is the confirmed result — the timeout fix works.
- **New finding NOT fixed this session** (flagged as a background task chip for the user,
  task_7db1d756): gate `initCorpus()`'s `autoAcquire` behind `CRUCIBLE_OFFLINE === 'strict'`
  the same way the Hunter probes were gated. Until fixed, `:3011` (and any strict instance)
  leaks external arxiv calls at boot, violating the "no external calls under strict"
  standing constraint.

**Full convoedge-50 regression sweep (CONFIRMED N=5, :3011 strict, `CORPUS_AUTOACQUIRE=0`
to keep the corpus-acquisition confound out of the measurement):**
- Composite pass: **0.876 ± 0.015** [0.86, 0.90] (was 0.868 ± 0.020 [0.84, 0.90] stale).
- Composite cov: **0.896 ± 0.010** (was ~0.886 ± 0.014 stale).
- Per-category (5-run band):
  - general **1.000 ± 0.000** — unchanged, clean.
  - abstain **1.000 ± 0.000** — unchanged, clean.
  - definition **0.976 ± 0.048** — unchanged, clean (one d005 flip, pre-existing surface-form
    variance, not new).
  - false-premise **1.000 ± 0.000** — unchanged, clean.
  - reasoning **1.000 ± 0.000** — UP from 0.888 ± 0.056. This is the fix's headline result:
    the r001/r004 daemon-timeout flake is gone, confirmed at N=5, not a single-run fluke.
  - explain **0.502 ± 0.079** — roughly flat vs 0.552 stale (within the category's known
    instability — e004/e008 hit the *harness's own* 180s outer fetch timeout twice across
    5 runs, unrelated to FM_TIMEOUT_MS; e007 flipped again as previously documented). Still
    parked, not touched this session.
  - clarify **0.500 ± 0.000** — unchanged, still parked.
- **general/abstain/definition/false-premise held their prior clean bands exactly — no
  regression from the shared FM_TIMEOUT_MS constant change.** reasoning is the only category
  that moved, and it moved up.

**Infra note for future sessions:** during this session's long benchmark runs, the `tsx`
node server processes for both `:3001` and `:3011` died silently (no crash log, no
exception) mid-run on the machine's tight 8GB memory (observed 60-150MB free / 7.5-7.7GB
used while both servers + FM daemon were up). The compiled Swift FM daemon (`:11435`) never
died. Worked around by (1) temporarily stopping `:3001` during the :3011 sweep and (2)
wrapping the sweep loop in a self-healing restart-if-down check. `:3001` was restored to its
normal non-strict default config at the end of the session. If this recurs, consider not
running `:3001` and `:3011` simultaneously for long unattended benchmark runs on this
machine, or a launchd-based restart-on-exit supervisor (already flagged as a TODO in the
run-commands memory for the stale-process hazard, same root cause: this box can't
reliably keep long-lived nohup'd node processes alive unsupervised).

**Baseline updated. Daemon-flake thread CLOSED** (per the standing constraint, closes once
verified clean — it now is, at confirmed N=5). New baseline of record: composite
0.876 ± 0.015, per-category as above. cl001/explain/Frontier-SWE-gap remain parked,
not started this session, per the explicit "stop and report" instruction.

**Open for the user:** decide whether to pick up the newly-flagged corpus-acquisition
strict-mode leak (chip already spawned) before or alongside the next parked item.

---

## SESSION LOG — 2026-07-01 (roadmap addition — Frontier-SWE gap phase queued)

**User-provided roadmap addition incorporated into `ROADMAP.md`, not started.**

- Added a queued phase near the top-level build order: **Closing the Frontier-SWE Gap**.
- Preserved the honest framing: the target is not frontier-model parity, but reliable
  autonomous handling of conventional, well-specified, tool-verifiable engineering work
  plus explicit escalation for judgment-heavy remainder.
- Preserved sequencing: this phase starts only after current trust-bug work closes
  (timeout verification/regression, clarify wiring, and any remaining false-premise/trust
  diagnosis). Do not start Workstream 1 in parallel.
- Captured the three workstreams:
  1. deterministic critic tooling,
  2. upfront elicitation / ambiguity surfacing,
  3. out-of-depth tripwire.
- Open user decision remains: which Workstream 1 critic to build first once the phase
  actually starts (static-analysis gating, contract/interface checking, fuzzing/property
  tests, security scanning, or known-bad-pattern scanning).

---

## SESSION LOG — 2026-07-01 (timeout fix verification — PARTIAL, interrupted by architecture pivot)

**Mandate resumed from platform handoff:** verify the Tier-3 FM timeout/error-label fix on
:3011 strict, then run full convoedge-50 regression before closing. **Partially done only.**

**Verified code/runtime state:**
- Actual repo root confirmed as `/Users/justin/crucible-local/crucible-local`.
- `:3011` was listening as PID **11165**.
- `src/CrucibleEngine/agent/fmReact.ts`: `FM_TIMEOUT_MS = 45_000` confirmed present.
- `server.ts` strict catch block confirmed present: distinguishes `TimeoutError` from
  genuinely unreachable daemon errors and reports timeout as "local model is taking too
  long to respond (timed out)".
- Apple FM daemon health on `:11435` returned `status: ok`.

**r001 isolation post-fix (confirmed N=10 cold + N=10 warm, :3011 strict):**
- Cold back-to-back: **9/10 pass (90%)**.
- Warm/loaded back-to-back: **9/10 pass (90%)**.
- The two failures were exact **45.0s timeout** abstentions, now correctly labeled as
  timeout rather than "daemon unreachable".
- Several successful fires landed above the old 30s ceiling (e.g. 32-44s), so the 45s
  bump is a real improvement. However, the new ceiling still has limited slack; 45s is
  not a complete elimination of the timeout edge under sustained load.

**NOT YET DONE / still required before closing this fix:**
- Full convoedge-50 sweep **N=5 minimum** on :3011 strict.
- Confirm general/abstain/definition remain near prior clean bands.
- Update per-category confirmed numbers only after that N>=5 sweep.
- Surface the :3001 restart decision after the full sweep is clean; do not restart
  :3001 unilaterally.

---

## SESSION LOG — 2026-07-01 (daemon-flake DIAGNOSIS — r001 isolation)

**Mandate: diagnose the r001 "daemon unreachable" flake in isolation (10-20x outside the
full sweep) to determine load-dependent vs standalone. Diagnose only, do not fix without
go-ahead. DONE.**

**ROOT CAUSE FOUND — it is a too-tight timeout, NOT a daemon crash/reliability issue, and
the "daemon is unreachable" label is WRONG.** Concrete measured numbers, r001 fired in
isolation against :3011 (strict), via scratchpad `r001_iso.ts` (fire() copied from
__convoedge_bench.ts):

- RUN A (cold, back-to-back N=15): **7/15 pass (47%)**. First 7 passed 21–24s, then #8–15
  ALL failed identically at exactly 30.0s.
- RUN B (warm, back-to-back N=12): **3/12 pass (25%)**. Passing fires were SLOWER (26–28s).
- RUN C (20s idle gap between fires, N=8): **6/8 pass (75%)**. Latencies 18–29s; the fastest
  (18–19s) appear only after idle recovery.

**Mechanism (traced through code, not assumed):**
- r001 ("I have $1000 to invest safely. What are some options?") is NOT research-shaped
  ("what are" ∉ isResearchShaped regex) and NOT complex → routes straight to Tier-3
  `fmDirectAnswer` (synthDriver.ts:162) → `callFm` with `FM_TIMEOUT_MS = 30_000` and
  `max_tokens: 1536` (fmReact.ts:32,46).
- A healthy r001 generation takes 21–28s — already RIGHT against the 30s ceiling. Any
  slowdown (sustained load, ANE throttle, warm-session degradation on the 8GB A18) pushes
  it past 30s → `AbortSignal.timeout` fires → caught → solveNonCodeTurn throws → server.ts
  catch (3121-3124) abstains with the hardcoded "local model daemon is unreachable" string.
- The REAL escalate reason (from /api/debug/history `offline_conversational_escalate`) on
  EVERY failure is `"The operation was aborted due to timeout"` — a slow generation, NOT an
  unreachable socket. The daemon `/health` stayed `ok` throughout, and a small direct prompt
  to :11435 returned in <1s during the failure window. Daemon never crashed.

**Verdict on the handoff's two diagnostic questions:**
1. Load-dependent or standalone? → **Load-dependent** (margin-vs-fixed-timeout). Back-to-back
   it degrades to 25–47%; 20s idle gaps recover it to 75%. NOT a standalone random crash.
2. Root-cause category? → **Timeout/throughput margin, NOT concurrency** (fires are strictly
   sequential — no concurrency backlog) and **NOT daemon reliability/crash**.
- This fully explains the ~80% in-sweep failure: during a 50-prompt sweep the daemon is
  continuously loaded, so r001-class generations sit in the 28–32s band and time out most
  of the time.

**Fix NOT applied (per trace-first / ask-before-fix constraint).** It is a tuning/structural
decision with tradeoffs, not a trivial bug. Candidate fixes to discuss:
  (a) raise `FM_TIMEOUT_MS` for Tier-3 direct answers (e.g. 45–60s) — simplest, but slow turns;
  (b) lower `max_tokens` for direct answers (1536 → ~768) — faster, shorter answers;
  (c) cap/cooldown the daemon under sustained load; (d) fix the mislabeled error string so it
  reports "timeout" not "unreachable" (low-risk, orthogonal, worth doing regardless).
**Open question for user: which fix direction, or stop here?**

NOTE: the 0.868 baseline's reasoning category (0.888 ± 0.056) is depressed by exactly this
timeout flake — once mitigated, reasoning should rise and stabilize.

---

## SESSION LOG — 2026-07-01 (re-confirmation sweep; 0.90 did NOT hold)

**Mandate this session: re-run convoedge-50 on :3011 to test whether the prior 0.90
composite was a stable baseline or a lucky single run. Result: it was the top of the
range, not the center.**

**Re-confirmation sweep — convoedge-50, N=5, :3011 (strict, no code changes):**
- Per-run passRate: **[0.90, 0.86, 0.88, 0.86, 0.84]**
- **Composite pass 0.868 ± 0.020 [min 0.84, max 0.90]**, cov 0.886 ± 0.014.
- The prior session's 0.90 = the single best run, not a representative baseline.
  **New ground-truth baseline going forward: ~0.87 (0.868 ± 0.020).**
- Stability: 42 always-pass, 5 always-fail (cl001, cl003, e002, e003, e005), 3 flippers.

**Per-category bands (N=5):**
- general 1.000 ± 0.000 · abstain 1.000 ± 0.000 · **false-premise 1.000 ± 0.000** (fp fix robust)
- definition 0.976 ± 0.048 · reasoning **0.888 ± 0.056** (was claimed 1.00) · explain 0.552 ± 0.064 · clarify 0.500 ± 0.000

**DIVERGENCE = SIGNAL, not noise (per standing constraint, called out plainly):**
- **false-premise held perfectly across all 5 runs** — the fp004 grounding fix is
  confirmed stable, not a one-run artifact. fp004 independently re-fired: genuine
  evidence-grounded negation ("did not purchase Alaska from Canada … sold by Russia",
  SOURCE-QUOTED), not a false-premise parrot. SOLID.
- **reasoning dropped from claimed 1.00 → 0.888 ± 0.056.** Cause identified: the
  daemon-unreachable flake the prior handoff flagged as "could be luck rather than a
  fixed issue" is REAL AND RECURRING. r001 flipped Ynnnn (1/5) — 4 of 5 runs returned
  "I can't answer this offline right now — the local model daemon is unreachable, and
  strict mode blocks external escalation." The prior 1.00 was the flake being absent
  that run, NOT a fix. This is the single biggest contributor to the composite drop.
- **e007 is NOT stable-pass** (prior log claimed "e007 now passes"): flipped YnYnn (2/5).
- e003 regression still present (always-fail, cov 0.50) — unchanged, still needs decision.

**Unchanged / re-confirmed:** :3001 PID 94614 still serving (non-strict, not flipped).
:3011 env CRUCIBLE_OFFLINE=strict confirmed. No code changes made this session — pure
measurement. fp004 rubric NOT reverted.

**USER DECISIONS (made this session, 2026-07-01):**
1. **Baseline → accept ~0.87 (0.868 ± 0.020) as the new ground truth.** 0.90 is retired as
   a one-run high, not a representative baseline. Compare future sweeps to ~0.87.
2. **e003 → ACCEPT tradeoff (a), logged as accepted.** "Why is the sky blue?" abstaining
   under PREMISE_RX→DAG is a KNOWN, ACCEPTED tradeoff. fp001-004 passing is the higher-value
   outcome; the FM-direct-fallback fix that would solve e003 would re-break fp001. Do NOT
   "fix" e003 by loosening PREMISE_RX or adding a no-evidence FM fallback — that path is
   closed by decision. (Option (b), a narrower evidence-absence signal, was NOT chosen.)
3. **Hunter boot probes → GATE under strict (DONE + VERIFIED this session, see below).**
4. **reasoning daemon flake → PROMOTED to a real tracked fix item** (no longer "parked
   infra"). It, not explain/clarify, is what gates reasoning (~4 composite pts). See
   "DAEMON FLAKE" below.

**DECISION 3 IMPLEMENTED — Hunter/waitlist external calls gated under strict:**
- `server.ts`: added `if ((process.env.CRUCIBLE_OFFLINE ?? '1') === 'strict') return` to all
  three external background tasks — boot Hunter (setTimeout, ~line 488), 24h Hunter
  (setInterval), and 6h waitlist scorer (updateWaitlistScores). Guard sits AFTER the
  existing `if (!apiKey) return`, matching the canonical strict convention at server.ts:2985.
- **Verified empirically:** restarted :3011 (strict) on gated code, waited past the 30s
  boot-Hunter delay. Pre-gate log (/tmp/crucible-3011.log) had **9** external probe lines
  (1 catalog fetch + 8 OpenRouter model probes). Gated log (/tmp/crucible-3011-gated.log)
  has **0**. The only remaining `[Hunter]` line is "Loaded 3 previously-discovered model(s)"
  — a LOCAL file read, not a network call. Chat path unaffected: fp004 re-fired post-restart
  returns the same grounded Russia negation (200, SOURCE-QUOTED). **The "no external calls
  under strict" constraint now holds literally — the 3-session re-flag thread is CLOSED.**
- **New :3011 PID 90630** (was 92024). Still strict, still serving fixed grounded corrections.
- NOTE: :3001 was NOT restarted (non-strict by design; the gate is a no-op there since the
  guard only triggers under strict — strict default NOT flipped). :3001 will pick up the gate
  on its next natural restart; no action needed.

**DAEMON FLAKE — now a tracked fix item (was parked):**
- Symptom: r001 (reasoning) returned "I can't answer this offline right now — the local
  model daemon is unreachable, and strict mode blocks external escalation" in 4 of 5 runs.
  This is the Apple FM daemon (port 11435) intermittently unreachable mid-sweep, NOT a
  routing/grounding bug. It depresses reasoning from a true ~1.0 to ~0.89 and is the single
  largest contributor to the 0.90→0.87 composite move.
- Next: investigate daemon liveness/reconnect (Track S Swift bridge, port 11435). Until
  fixed, reasoning numbers carry this flake — read sweep dips in reasoning as likely-daemon
  before assuming a real regression.

**STILL OPEN (unchanged, parked per standing plan):**
- cl001/cl003 clarify-wiring (0.50) — separate session, needs explicit go-ahead.
- explain e002/e005 (pre-existing DAG-mangles-explainers) — separate from e003.
- Frontier-SWE-gap roadmap phase — starts after cl001 + (now-closed Hunter) threads.

---

## SESSION LOG — 2026-06-30/07-01 (verification + :3001 restart)

**Verification of prior session's claims (both independently re-checked):**
- **Item 1 (fp004 "rubric artifact"): CONFIRMED.** Fresh fires against fixed :3011 return
  the grounded, *negated* correction ("The United States did not purchase Alaska from
  Canada … purchased from Russia in 1867", SOURCE-QUOTED, evidence-backed). The rubric
  failed only because the forbidden substring `from canada` matched inside the negation.
  The earlier 0.5 `/tmp/fp-strict.log` (22:57) was a STALE pre-restart :3011 run (it
  predated the 23:09–23:13 fixes), which is why it showed flat false-premise acceptance.
- **Item 2 (zero external chat calls under strict): CONFIRMED.** `/tmp/crucible-3011.log`:
  all 8 external (openrouter) hits are `[Hunter]` boot probes at lines 13–27, ALL before
  the first `/api/chat` at line 29. Chat region (lines 29–294) has zero
  groq/openai/anthropic/openrouter strings. Confirmed `:3011` env `CRUCIBLE_OFFLINE=strict`.

**DECISION 1 — :3001 RESTARTED on fixed code (user-approved Option A).**
- Old PID 89496 (started 2026-06-30 22:41:41) was objectively pre-fix (fixes landed
  23:09–23:13) and had `CRUCIBLE_OFFLINE` unset (NOT strict).
- Restarted with identical config (default PORT 3001, no env overrides — strict default
  NOT flipped, per standing constraint). **New PID 94614, started 2026-06-30 23:56:47.**
  Verified serving fixed grounded correction on fp004. `/tmp/crucible-3001.log`.

**DECISION 2 — fp004 rubric fixed (pre-authorized, applied after Item 1 confirmed).**
- `__convoedge50.ts` fp004: dropped bare `from canada` forbidden check; kept `russia`
  required and `canada in` (matches acceptance phrasing only, not the negation).
- Post-fix fp set N=5 on :3011: composite **1.0** (fp001–004 all 5/5).

**Final authoritative sweep — convoedge-50 N=5 on :3011 (strict, fixed):**
overall pass **0.90**, cov 0.91. Per-category: general 1.0 (12), definition 1.0 (8),
reasoning 1.0 (7), abstain 1.0 (7), **false-premise 1.0 (4)** [was 0.5], explain 0.63 (8),
clarify 0.5 (4). Remaining fails: e002/e005 (pre-existing explain), e003 partial
(NEW regression, cov 0.50), cl001/cl003 (parked clarify-wiring). e007 now passes.

**Still open / surfaced (NOT decided this session):** e003 regression tradeoff;
boot-time `[Hunter]` external probes under strict (3rd flag); cl001; explain category.

---

## PRIORITY 1 — Close the Learning Loop (The Compounding Gap)

**The problem:**
Crucible has all the pieces of a self-improving system — genealogy attribution, specialization
memory, quality predictor, triumvirate governance, ANIMA truth store, uncertainty surface — but
they feed into each other weakly. The system learns within a session and across sessions via EMA
weights, but it does not yet systematically identify what is working, extract the pattern, and
harden it into the pipeline configuration itself.

**What's missing:**
The self-patcher (`selfPatcher.ts`) exists and is documented as [x] but needs verification that
it is actually wired and firing. The specific missing behavior:

- After every N pipeline rounds (suggest 20), read the last 100 debug events
- Identify which pipeline stage most frequently precedes a low synthesis score
- Cross-reference with `quality-history.json` and `specialization.json`
- Propose a concrete config change (stage prompt tweak, model weight adjustment, early-exit
  threshold change) — not code, just config that the existing infrastructure can apply
- Route proposal through triumvirate (already built)
- Apply on approval, log to `.crucible/self-patches.json`
- Roll back automatically if quality predictor trend goes negative within 10 rounds

**Key distinction from fine-tuning:**
Crucible does NOT train model weights. It refines ITSELF — its routing logic, its stage prompts,
its scoring thresholds, its model selection weights. The models stay external and free. The
intelligence that compounds is in the pipeline configuration and the accumulated signal in
`.crucible/`. This is the correct framing of "self-improvement" for Crucible's architecture.

**Files to verify/fix:**
- `src/CrucibleEngine/selfPatcher.ts` — confirm it is actually called from server.ts on a schedule
- `src/CrucibleEngine/autoImprove.ts` — confirm `triggerImprovementPass()` is firing after rounds
- `GET /api/self-patcher/patches` — check this endpoint returns real data, not empty

---

## PRIORITY 2 — Regression Safety Net (Benchmark Suite)

**The problem:**
Architectural decisions — which models to favor, which pipeline stages to keep, which weights to
tune — are currently made based on feel and spot-checking. A bad patch could degrade answer
quality and would only be caught through user observation, not measurement.

**What's missing:**
Track E3 (benchmark suite) is marked [x] in the roadmap but needs verification it is actually
running continuously. Specifically:

- `.crucible/benchmarks.json` should exist with 50+ canonical questions and known correct answers
  across all prompt types (coding, reasoning, factual, math, creative, general)
- After every significant pipeline change, the suite should run in the background and record
  pass rates per category
- `GET /api/debug/benchmarks` should return rolling pass rates and flag any category that dropped
  more than 5% from its baseline
- The neuromorphic stress test (documented in ROADMAP.md) should be one of the benchmark entries
  with its 7-section pass criteria

**Implementation note:**
The benchmark runner should use the SIMPLE_PIPELINE_CONFIG (not full ensemble) to avoid burning
quota on self-testing. Results go to `.crucible/benchmark-results.json`. The signal is trend,
not absolute score — is the system getting better or worse over time on a fixed question set.

---

## PRIORITY 3 — "Shows Its Work" Mode (The Demo Mode)

**The problem:**
Crucible performs extraordinary reasoning — triadic dialectics, abductive synthesis, epistemic
calibration, ANIMA shaping, confidence annotation — and the user sees almost none of it. The
process trail exists but is collapsed by default and doesn't tell a coherent story.

**What's missing:**
A toggle in the UI (off by default, labeled something like "thinking visible") that expands the
synthesis to show:

- Which models agreed vs disagreed at Stage 1 (score variance visualization)
- What the Critic flagged (already stored in `criticProblems`)
- Which claims are HIGH vs LOW confidence (already stored in `round.confidence`)
- The fragile assumption (already stored in `fragilityAssumption`)
- What ANIMA detected and how it shaped the response (transparency layer already built)
- Cross-domain connections MASTERPIECE found (already stored in `masterpiece` field)
- Which model actually contributed most to the final synthesis (genealogy attribution)

**Why this matters:**
This is simultaneously the strongest marketing asset (visible reasoning beats any benchmark
number) and the best debugging tool (when something goes wrong, you can see exactly which stage
failed and why). It is not a new system — it is a UI layer over data that already exists in
every `Round` object. Estimated build: 2-4 hours in `App.tsx`.

**Design constraint:**
No emojis. No clutter. A single toggle that reveals/hides a structured breakdown panel below
the synthesis. Mobile-first — must work at phone width. Should feel like turning on subtitles,
not opening a dashboard.

**Status (June 14 2026):**
Genealogy contribution rates are now sent over SSE (`genealogy` event type) and displayed in
the process trail — showing which model contributed what fraction of the final synthesis.
`recordPipelineRun()` and `recordProbationOutcome()` wired. Probation status shown in topology.
The "toggle all open by default" version of Shows Its Work is still not built — the process
trail is still collapsed by default. A `showWork` boolean in state that auto-opens the
`<details>` elements and adds a toolbar toggle is the remaining work.

---

## PRIORITY 4 — Voice Pipeline (Mobile Transformation)

**The problem:**
Crucible on mobile requires typing. The Remote Brain track is documented but not built. Even
without the full screen-stream vision, a voice input → pipeline → spoken response loop would
transform how the system feels and dramatically expand its use cases.

**What to build (minimal viable version):**
1. Microphone button in the mobile input bar
2. On press: record audio, send to Whisper on HuggingFace Inference API (free, no key needed
   for public models, ~300ms transcription)
3. Transcribed text enters the normal pipeline
4. After synthesis, pass response text through Edge-TTS (Microsoft, free, no API key) for
   spoken playback
5. The response plays through the phone speaker while text is visible

**What NOT to build yet:**
The full Remote Brain (screen stream, Mac control, Bluetooth fallback) is a larger project.
Build the voice I/O loop first — it is self-contained and validates the audio pipeline
before adding the complexity of screen streaming.

**Key files to create:**
- `src/CrucibleEngine/voice/stt.ts` — Whisper HuggingFace wrapper
- `src/CrucibleEngine/voice/tts.ts` — Edge-TTS wrapper
- `App.tsx` — microphone button + audio playback (mobile only, hidden on desktop)

**Free-tier note:**
HuggingFace `openai/whisper-large-v3` is available on the Inference API free tier.
Edge-TTS is accessed via the `edge-tts` npm package, no API key, Microsoft's free
neural voices. Both fit the free-tier-only philosophy exactly.

---

## PRIORITY 5 — Persistent Agent Goals (Long-Horizon Continuity)

**The problem:**
Every agent session starts from zero context about multi-session goals. The checkpoint system
saves iteration state within a session, and episodic memory summarizes what happened. But if
you tell Crucible "refactor this codebase over the next week," it has no structure for tracking
progress across sessions, knowing what's done vs pending, or picking up intelligently where it
left off.

**What's missing:**
A task graph that persists across sessions:

```json
// .crucible/task-graph/<goal-id>.json
{
  "goal": "Refactor authentication system",
  "created": "2026-06-14T…",
  "status": "in_progress",
  "nodes": [
    { "id": "n1", "task": "Audit current auth flow", "status": "done", "completedAt": "…" },
    { "id": "n2", "task": "Replace JWT library", "status": "in_progress", "startedAt": "…" },
    { "id": "n3", "task": "Update tests", "status": "pending", "dependsOn": ["n2"] }
  ]
}
```

At session start, agent checks for open task graphs matching the current project, reports
progress naturally ("Last session I finished the auth audit — continuing with the JWT
replacement"), and resumes from the correct node.

**Integration points:**
- `goalDecomposer.ts` already exists — extend to write decomposition output to task graph file
- `episodicMemory.ts` already summarizes sessions — link summaries to task graph nodes
- Agent loop preamble already reads `memoryDigest` — add task graph injection here
- New `GET /api/task-graph` endpoint for inspection
- New `POST /api/task-graph/create` to initialize a multi-session goal

---

## PRIORITY 6 — Actionable Uncertainty (Closing the Epistemic Loop)

**The problem:**
H1 confidence calibration flags LOW and UNVERIFIED claims. H4 surfaces the fragile assumption.
H2 routes uncertain topics to the full pipeline. But none of this tells the user what to DO
about the uncertainty. A flagged claim with no suggested action is decorative, not useful.

**What's missing:**
When the confidence calibrator produces LOW or UNVERIFIED claims, generate a specific
suggested action alongside each flag:

- For UNVERIFIED factual claims: auto-generate a web search query the user can run to verify
  (use the existing DDG grounding infrastructure — `webGrounding.ts` — to attempt verification
  first, surface the query if grounding fails or conflicts)
- For LOW confidence reasoning claims: surface the specific assumption that if wrong would
  break the claim (this is already computed by H4 `getFragilityAssumption` — just link it
  to the specific flagged sentence rather than the synthesis as a whole)
- For PROVISIONAL world model facts: surface when the fact was last verified and what would
  update it

**Implementation:**
Extend `confidenceCalibrator.ts` `calibrate()` return type to include `suggestedAction?` per
flagged claim. Extend the `confidence` SSE event to carry these. Extend the UI confidence
strip to show the action inline with each flagged claim — a small "verify →" link or suggested
search query. No new model calls needed — this is recombination of existing signals.

---

## ARCHITECTURAL REMINDER — What Self-Improvement Means in Crucible

Crucible does NOT fine-tune or retrain models. The models are external, free-tier, and fixed.

What Crucible refines is ITSELF:
- **Routing logic** — which model gets which query (specialization memory, viability scores)
- **Stage configuration** — which pipeline stages fire, in what order, with what prompts
- **Scoring thresholds** — when to early-exit, when to force full pipeline, when to escalate
- **Model selection weights** — EMA-based bias toward models that actually survive into synthesis
- **World model** — accumulated facts, decisions, episodic memory that inform future responses
- **Pipeline prompts** — the system prompts driving each stage, tunable via self-patcher

The compounding advantage is not in model weights. It is in the accumulated signal in
`.crucible/` and the pipeline configuration that has been tuned on real usage. Six months of
real queries produces routing intelligence, uncertainty surface calibration, and specialization
memory that cannot be replicated by spinning up the same stack on a fresh install.

This is the correct framing. Build everything with this in mind.

---

## QUICK WINS (< 2 hours each)

These are not priorities but are high-value and low-effort:

**A. Wire `recordPipelineRun()` verification** — DONE (June 14 2026)
`recordPipelineRun()` is now called after every Stage 5 completion so the specialization
forcing recency counter advances correctly. `pipelineRunCount` was stuck at 0 — forcing decay
never fired. Fixed in server.ts.

**B. `/api/waitlist` auto-promotion on boot** — DONE (was already wired)
`promoteNextFromWaitlist()` is already called at server boot (line 336 in server.ts).

**C. Probation outcome recording** — DONE (June 14 2026)
`recordProbationOutcome()` now called alongside `recordModelOutcome()` at Stage 1 outcome
sites. Probation models now accumulate outcome data and can graduate or be rejected.

**D. Debug topology shows probation status** — DONE (June 14 2026)
`GET /api/debug/topology` now includes `probation` array with id, label, callsRemaining for
each model in a probation slot.

**E. Genealogy contribution rates in UI** — DONE (June 14 2026)
`genealogy` SSE event now emitted after attribution pass. Process trail in App.tsx now shows
per-model contribution rates as percentage bars under the ensemble section.

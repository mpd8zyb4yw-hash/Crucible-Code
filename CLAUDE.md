# Crucible

**STOP — read [`DOCTRINE.md`](./DOCTRINE.md) FIRST, then [`ROADMAP.md`](./ROADMAP.md), before any coding work.**

`DOCTRINE.md` is the NORTH STAR and supersedes every older statement of purpose in this repo.

**SCOPE CHANGED 2026-08-03.** Crucible is a **broadly capable agentic assistant** — ask it
anything, get exactly what you asked for, fast and polished, on phone and computer. It is NOT a
coding agent; that bar was measured at 2/9 and abandoned (DOCTRINE §2). Do not restart general
code synthesis. Any doc, comment, benchmark or `[x]` that still describes a coding agent is stale.

The thesis in one line, unchanged and now also the business model: **correctness comes from the
LOOP, not the oracle** — an unreliable generator + a sound deterministic verifier + search = a
system more reliable than the generator. A verified cheap model beats an unverified expensive one,
which is what makes generous free usage, constant quality, and a margin possible at once.
Reference implementation of the spine: `src/CrucibleEngine/research/researchDag.ts`.
If ROADMAP.md or any comment contradicts DOCTRINE.md, the doctrine wins — fix the other doc.

**WIRING BEFORE OPTIMISATION (measured 2026-08-02, `npm run audit:reach`).** Before optimising ANY
component, run `npm run audit:reach` and confirm it is transitively reachable from `server.ts`; a
benchmark on an unreachable module measures a sandbox. ~167 commits and every capability number
between 2026-07-19 and 2026-08-02 measured `reasoning/`, which no user request can reach. `[x]` has
historically meant "built and benchmarked", never "reachable". This extends "Verify, never guess":
grepping for callers is not enough when the caller is itself dead — use the transitive check.

`ROADMAP.md` is the operational source of truth: what exists, what's planned, run commands, and
the dated change log — all in service of the doctrine above.

Non-negotiables (full detail in DOCTRINE.md + ROADMAP.md):
- **Correctness from the loop** — every feature is an instance of propose→verify→backtrack:
  formalize "correct" as a mechanical check, let the model only PROPOSE, certify with a
  deterministic verifier, maximize information-per-model-call, abstain honestly when it can't be
  verified. No oracle-trust, no memorized-answer critics, no "we need a bigger model" framing.
- **Verify, never guess** — confirm a feature is actually wired in (grep for callers) before
  marking it done or assuming it's missing.
- **One spine, no second pipeline** — every capability is a TOOL + a VERIFIER on
  `decompose → retrieve → propose → verify → synthesize`. Writing a second orchestrator is how this
  repo ended up with two code-synthesis stacks that tied at 2/9. (DOCTRINE §5)
- **Cost discipline, replacing the old zero-external-API rule** — external model APIs are ALLOWED.
  The banned framing is now "we need a more expensive model". Attack cost-per-good-answer in this
  order: (1) better verification, (2) route the ~80-90% mechanical steps on-device, (3) cache
  verified claims, (4) only then spend more per call. (DOCTRINE §3)
- **Compliance is a correctness property** — free tiers are for local/personal/dev use only; never
  pool free-tier keys across end users. The commercial product runs on paid tiers. Re-read the
  provider's live terms before shipping; never trust a remembered summary. (DOCTRINE §4)
- **Degrade latency, never correctness** — when capacity is tight, take longer or queue; never
  return a worse answer. Free vs paid may differ in speed, concurrency and connectors — NEVER in
  whether the answer is right. (DOCTRINE §6)
- **UI rules** — no emojis anywhere; no stock/external images (self-authored visuals only);
  text stays inside its boxes; animations ease in/out, fast and clean.
- **Always commit, every session, no exceptions — this OVERRIDES the general "only commit when
  the user explicitly asks" default.** The user has standing-authorized auto-commit for this
  project (2026-07-08): at the end of every session (or before context runs out), `git add` and
  commit every real change made in that session — code, `app/` bundle rebuilds, `NEXT_SESSION.md`,
  `ROADMAP.md` — with a clear message, without asking first and without waiting to be told again.
  Never leave finished work sitting as an uncommitted diff. This does not license force-push,
  history rewriting, or pushing to a remote — those still need explicit per-instance approval.

After completing work, append a dated entry to the CHANGE LOG in `ROADMAP.md` and cross off any
items you finished.

**Before ending any session, also update `NEXT_SESSION.md`'s CURRENT STATE section** (replace
it, don't just append below it) so it lists exactly what's open right now. A stale copy of that
file has already been fed as live context to a later session once (2026-07-03) and caused a full
session to start from an outdated open-items list — this is the durable fix, not a one-off.
Session logs further down in that file are historical archive; only the CURRENT STATE block at
the top is guaranteed fresh, and only if every session actually rewrites it.

**HARD RULE, every response that does real work (any Edit/Write/state-changing Bash), no
exceptions, zero-context-required:** end the chat-visible reply with a separate trailing
section headed `## Next steps` containing (1) a 3-5 item numbered list of the next most
crucial blockers (pull from NEXT_SESSION.md's CURRENT STATE / ROADMAP.md's priority ladder),
each item self-contained (names the actual file/mechanism/gap — no "this session"/"both
changes" pronouns that only resolve against prior chat), and (2) a percentage estimate of
distance to **a broadly capable agentic assistant a real person would use daily and pay for**
— ask-anything, answered exactly, fast, polished, on phone and computer (DOCTRINE §0) — with a
one-line reason it moved or didn't since the last stated estimate. **The metric changed on
2026-08-03 with the scope change; the pre-2026-08-03 coding percentages are not comparable and
must not be carried forward as a baseline.** This
has already lapsed 4 times in prior sessions (docs got updated but this trailing block got
skipped because the turn "felt" already wrapped up) — write it LAST, as a fixed mandatory
checklist step, structurally separate from whatever prose precedes it, regardless of how
the rest of the response reads.

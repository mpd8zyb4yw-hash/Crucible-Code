# Crucible

> ## STOP — FAILURE MODES ALREADY MADE, DO NOT REPEAT (read before any action, zero-context-proof)
> A fresh session with no chat history has already burned full sessions on each of these. They are
> recoverable from files in this repo, so there is NO excuse for repeating them:
>
> 1. **NO external model calls, ever — measurement included.** The doctrine is FULLY OFFLINE, FULLY
>    ON-DEVICE (success-bar #5). `npm run smoke:code` routes through an EXTERNAL free model pool and
>    is OFF-DOCTRINE — its numbers are invalid. The ONLY valid capability run is
>    **`npm run smoke:code:offline`** (`CRUCIBLE_OFFLINE=strict`, qwen2.5-1.5b as sole generator).
>    If you see "…pausing 45s to let the free pool recover…" in benchmark output, you ran the WRONG
>    command. There is no "hybrid vs on-device" choice to offer the user — the doctrine settles it.
> 2. **NEVER report a percentage that isn't `passedHard/total` (gen-path) from an offline harness run
>    THIS turn.** No "~60%", no "distance to parity" estimate, no vibe grade. A fabricated "62%"
>    (and a fake "+2pt" continuity with no stored prior) burned a session on 2026-07-22. No harness
>    run ⇒ you have no number ⇒ say "no benchmark run this turn."
> 3. **The head is qwen2.5-1.5b, target is a ~1B core — NOT "3B", NEVER "we need a bigger model."**
>    See DOCTRINE.md. Catalog-primitive greens are memorized answers (debt), not reasoning — the
>    real signal is `path=gen` only.
> 4. **A change is a "fix" ONLY if it flips a measured task fail→pass.** Do not build features off a
>    roadmap "vibes" open-items list. State which task id a change should move and why BEFORE writing
>    code; run the offline harness AFTER; if the number didn't move, revert. "This should help" is banned.
> 5. **One benchmark only** (`coding-benchmarks.ts`, 14→30 tasks). Never build a second grand bench.

**STOP — read [`DOCTRINE.md`](./DOCTRINE.md) FIRST, then [`ROADMAP.md`](./ROADMAP.md), before any coding work.**

`DOCTRINE.md` is the NORTH STAR and supersedes every older statement of purpose in this repo.
The thesis in one line: **correctness comes from the LOOP, not the oracle** — an unreliable
small on-device model + a sound deterministic verifier + search = a system more reliable than
the model. The on-device head TODAY is **qwen2.5-1.5b** (local llama-server sidecar, cont.90) —
NOT "3B"; the ~3B Apple FM is only a fallback. The direction of travel is a SMALLER, reasoning-
denser **~1B cognitive core** (distilled/self-trained if needed), never a bigger model. Every
performance gain comes from better verification-and-search infra, never more parameters. NOT
preloaded/memorized answers (the catalog-primitive fast paths are debt, not capability — they do
not measure reasoning); the system must reason about NOVEL problems it has not seen. Reference
implementation: `src/CrucibleEngine/reasoning/`
(`npm run vgr:bench`). If ROADMAP.md or any comment contradicts DOCTRINE.md, the doctrine
wins and the other doc is wrong — fix it to match.

`ROADMAP.md` is the operational source of truth: what exists, what's planned, run commands, and
the dated change log — all in service of the doctrine above.

Non-negotiables (full detail in DOCTRINE.md + ROADMAP.md):
- **Correctness from the loop** — every feature is an instance of propose→verify→backtrack:
  formalize "correct" as a mechanical check, let the model only PROPOSE, certify with a
  deterministic verifier, maximize information-per-model-call, abstain honestly when it can't be
  verified. No oracle-trust, no memorized-answer critics, no "we need a bigger model" framing.
- **Verify, never guess** — confirm a feature is actually wired in (grep for callers) before
  marking it done or assuming it's missing.
- **Free-tier philosophy** — free models + the self-refinement pipeline ("garbage in, gold out").
  Weak output ⇒ more client-side processing, never a premium model.
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
changes" pronouns that only resolve against prior chat), and (2) the CURRENT capability number
as `passedHard/total` (gen-path only) from the offline benchmark harness — the EXACT scorecard
figure from a run THIS session, or the literal words "no benchmark run this turn" if none was
run. NEVER a vibe percentage, a "~60%", or an estimate of "distance to parity": a made-up "62%"
already burned a full session (2026-07-22). If you did not run the harness, you do not have a
number — say so. Write this block LAST, as a fixed mandatory checklist step, structurally
separate from whatever prose precedes it, regardless of how the rest of the response reads.

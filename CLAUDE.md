# Crucible

**STOP — read [`DOCTRINE.md`](./DOCTRINE.md) FIRST, then [`ROADMAP.md`](./ROADMAP.md), before any coding work.**

`DOCTRINE.md` is the NORTH STAR and supersedes every older statement of purpose in this repo.
The thesis in one line: **correctness comes from the LOOP, not the oracle** — an unreliable
small on-device model + a sound deterministic verifier + search = a system more reliable than
the model. We do NOT need a bigger model (8GB Mac, ~3B ANE model is the permanent ceiling and
the correct choice); every performance gain comes from better verification-and-search infra,
never more parameters. NOT preloaded/memorized answers — the system must reason about NOVEL
problems it has not seen. Reference implementation: `src/CrucibleEngine/reasoning/`
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
changes" pronouns that only resolve against prior chat), and (2) a percentage estimate of
distance to fully agentic, 0-external-API-call, on-device coding that rivals Claude/Codex
output quality, with a one-line reason it moved or didn't since the last stated estimate. This
has already lapsed 4 times in prior sessions (docs got updated but this trailing block got
skipped because the turn "felt" already wrapped up) — write it LAST, as a fixed mandatory
checklist step, structurally separate from whatever prose precedes it, regardless of how
the rest of the response reads.

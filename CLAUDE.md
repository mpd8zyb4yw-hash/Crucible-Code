# Crucible

**STOP — read [`ROADMAP.md`](./ROADMAP.md) before any coding work.**

`ROADMAP.md` is the single source of truth for this project: what exists, what's planned, the
working rules, run commands, and the dated change log. It replaces all prior handoff docs.

Non-negotiables (full detail in ROADMAP.md):
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

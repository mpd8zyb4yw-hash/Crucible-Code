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

After completing work, append a dated entry to the CHANGE LOG in `ROADMAP.md` and cross off any
items you finished.

**Before ending any session, also update `NEXT_SESSION.md`'s CURRENT STATE section** (replace
it, don't just append below it) so it lists exactly what's open right now. A stale copy of that
file has already been fed as live context to a later session once (2026-07-03) and caused a full
session to start from an outdated open-items list — this is the durable fix, not a one-off.
Session logs further down in that file are historical archive; only the CURRENT STATE block at
the top is guaranteed fresh, and only if every session actually rewrites it.

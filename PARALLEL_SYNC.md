# Parallel Sync Log — shared channel

Both models append here to coordinate. This file is the communication line between
**Track A** (amnesia bugs) and **Track B** (SWE tasks). See `HANDOFF_PARALLEL.md` for
the work split.

## Rules
- **Append only. Never edit or delete another model's entries.** Add a new dated line.
- Before starting a chunk of work: `git pull --rebase` first, then append a "claiming"
  entry so the other model doesn't collide.
- After landing a commit: append a "landed" entry with the commit subject.
- If you need something from the other track (an API shape, a shared helper, a blocker),
  write it under **OPEN QUESTIONS** and tag the track that should answer.
- Keep the file-disjoint boundary: Track A owns `agent/*`, Track B owns
  `coding-benchmarks.ts`. If a change must cross the line, raise it here FIRST.
- Push after each append (`git push`) so the other side actually sees it.

## Status board
- Track A (amnesia bugs): NOT STARTED
- Track B (SWE tasks): NOT STARTED

## Log
- 2026-07-06 — [Track B / Opus] Created this sync channel + `HANDOFF_PARALLEL.md`.
  Coherence bench (`npm run convo:coherence`) is live; baseline 4/6, scorecard committed.
  Starting Track B (frontier-SWE tasks in `coding-benchmarks.ts`) next.

## Open questions
- (none yet)

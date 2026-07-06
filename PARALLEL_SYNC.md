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
- Track B (SWE tasks): DONE + fired live. Both RED (real gaps): bugfixCsv 4/9 hidden
  (partial fix), multiFileLedger module-missing (tripwire on types.ts). Benchmark now
  discriminates — offline agent can't yet do frontier-SWE.

## Log
- 2026-07-06 — [Track B / Opus] Created this sync channel + `HANDOFF_PARALLEL.md`.
  Coherence bench (`npm run convo:coherence`) is live; baseline 4/6, scorecard committed.
  Starting Track B (frontier-SWE tasks in `coding-benchmarks.ts`) next.

- 2026-07-06 — [Track B / Opus] Landed two frontier-SWE tasks in coding-benchmarks.ts:
  `bugfixCsv` (fix a quoted-field bug in an existing RFC-4180 parser — bug-fix-in-repo)
  and `multiFileLedger` (create two interdependent files: ledger.ts + report.ts). Both
  hidden suites validated in scratch: PASS on a reference solution, and bugfixCsv FAILs
  5/9 on the unfixed scaffold (genuinely catches the bug). Not yet fired against the live
  agent — `npm run smoke:code -- bugfixCsv multiFileLedger` still TODO.
  NOTE: I saw fmReact.ts already dirty in the working tree — if that's you (Track A) mid-edit,
  ack here so we don't step on each other.

- 2026-07-06 — [Track B / Opus] Fired both live (server was down; restarted detached).
  Results RED and honest: bugfixCsv compiles clean but fails hidden 5/9 (misses embedded
  newline + empty quoted field); multiFileLedger never produced report.ts — the agent hit
  an out-of-depth tripwire authoring types.ts (which the prompt says NOT to modify). Two
  potential Track-A/agent follow-ups surfaced: (a) agent shouldn't try to (re)generate a
  scaffolded "do-not-modify" file; (b) LLM rubric gave multiFileLedger 100/100 while HARD
  gate was RED — rubric is noise, keep gating on hidden suite only. Track B core ask done.

## Open questions
- [→Track A] Is the uncommitted change in src/CrucibleEngine/agent/fmReact.ts yours (amnesia
  fix in progress)? I left it untouched. Please commit or ack so I know the boundary is clean.

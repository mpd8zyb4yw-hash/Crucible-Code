# Highest-leverage work to close the gap toward Fable / Codex parity

Written 2026-07-20. Ranked by leverage (impact ÷ effort), most-leveraged first. Grounded in
the current architecture: weak on-device FM + deterministic verifier + search (VGR doctrine),
single-session FM daemon, agentic loop = planner.ts + loop.ts.

## The gap in one sentence
Crucible already MATCHES frontier models on the verified-single-artifact path (lookup + oracle +
repair). It LOSES on (a) multi-step tool-use planning that a strong model does in one shot, (b)
holding a large coupled change-set in one head, and (c) sustained multi-turn sessions. Those three
are the parity gap — not raw single-file code quality.

---

### 1. Fix the sustained-session failure (remote brain dies after N messages)  — HIGHEST
Highest leverage because it is a *correctness-of-availability* bug: the product silently stops
working mid-session. Frontier tools never do this. Needs a live reproduction pass:
- Instrument every foreground request with begin/endForeground **in a finally** and log
  `fmQueueStats` (depth/active/enqueued/completed) per turn. The FM queue itself is structurally
  clean (finally always releases `active`), so the hang is almost certainly (a) an unpaired
  beginForeground on an error path, (b) an SSE/stream response with no client-disconnect handler
  leaking a held connection, or (c) FM-daemon context growth past a ctx window → silent timeout.
- Reproduce over the tunnel, watch which counter climbs. Fix is one of the three above.
This is a day of live debugging, not a code-read fix — but it is the single most visible defect.

### 2. Tool-aware ReAct pass for the on-device planner (item 6 deep half)
Codex/Fable parity on *actions* comes from picking the right tool among many and chaining 3-5
steps. Layer 2 currently caps at 1-3 hardcoded tools and bails to the LLM loop otherwise. Build a
real ReAct loop over the full registry (registry.ts has ~40 tools) with observation feedback, so
tool-selection is learned-in-the-loop and verified per step. This is the biggest capability delta.

### 3. Change-set-native synthesis (generalize items 1-2)
The synth engine is single-file-first; coupled refactors are bolted on via sibling/combined
repair. Frontier models plan the whole change-set up front. Make the oracle + proposer operate on
a change-set as the primitive (not the file), with a planner that emits the file DAG first. Tier-2
corpus (0/4 → moving) is the measurement harness already in place.

### 4. Raise the agentic bench difficulty floor to include tool-selection (item 10)
Currently the corpus only exercises the synth/edit path, so tool-selection regressions surface in
production, not bench. Add a tier that scores WHICH tool was chosen against a held-out correct
tool, over distractor-heavy tool sets. Prereq for trusting #2's progress.

### 5. Multi-turn session memory + context management under a small ctx window
Frontier models keep long sessions coherent. On a small local ctx window, parity requires
aggressive, verified context compaction (conversationMemory.ts exists; extend to summarize-and-
verify old turns so the daemon never silently overflows — also mitigates #1).

### 6. Property/metamorphic judge for rule-based goals (item 4)
Closes the last verifier blind spot: goals stating a RULE (not a call example) — "a dot in the
domain after the @". The goal-example oracle (shipped this session) covers example-goals; this
covers rule-goals. Riskier (false-reject poisons repair) so build behind the executing oracle.

### 7. Assistant layer: REST connector + MCP client (item 7)
Parity on *reach*. Codex/Fable get breadth from tool ecosystems. The MCP client turns every MCP
server into a Crucible tool for free — highest breadth-per-effort once #2's ReAct loop exists to
drive them.

### 8. Mobile UX overhaul
Not a capability gap but an adoption gap: the mobile UI is crowded on sub-pages (agents, settings).
Frontier tools ship clean mobile. Bounded design work; do after the capability items.

---

## What is NOT the gap (don't spend here)
- Raw single-file code quality — already at parity via the verified path.
- A bigger model — DOCTRINE: correctness comes from the loop, not model size (measured repeatedly).
- More deterministic repair proposers before the oracle/planner improves — the ceiling is now
  planning + change-set scope, not repair surface.

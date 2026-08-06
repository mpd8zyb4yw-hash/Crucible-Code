# Fable 5 Handoff — Skill/Tool Ecosystem, Conversational Build Mode, Self-Repair
*(written 2026-07-06, for the next session — considers Fable 5's throughput profile: fast,
high-volume execution across many files. Use that to parallelize independent workstreams
below rather than serializing everything, but do NOT skip this project's verification
discipline to go faster — every item still needs `tsc --noEmit` clean, `npm run prove:all`
250/250, and a live-fire confirmation against a freshly restarted `:3001` before it counts as
done. Read ROADMAP.md's MISSION block (top of file) first — it was just sharpened to make the
success bar explicit; every feature below is justified against it, not novelty for its own sake.*

## THE ONLY METRIC THAT MATTERS

Crucible succeeds when it can, with **zero external paid/rate-limited model API calls**:
1. Do frontier-level SWE work (real multi-file changes, real debugging, real refactors)
2. Construct complex websites/apps with deep backends (auth, data layers, real APIs)
3. Find advanced, non-obvious bugs through real reasoning/testing, not lint pattern-matching
4. Produce genuinely good fixes, not plausible-looking patches
5. Do all of this using local models (including Crucible's own tuned models) + deterministic
   tooling — Claude/Codex-parity output, not "good enough for a local model"

Every feature below exists to move the needle on 1-5. If you build something and it doesn't
obviously serve one of these, cut it or say plainly in the handoff that it's supporting
structure, not progress — this is the standing reporting discipline (see
`feedback-report-percent-to-goal` memory), don't let a big feature-request session break it.

---

## Existing infrastructure — read this before building anything, it changes the scope

A research pass this session found several of these features are HALF-BUILT already. Don't
rebuild from scratch.

- **Two distinct "skill" systems already exist, do not conflate them:**
  - **Skill catalog** (`src/CrucibleEngine/synth/catalog.ts` + `synth/catalogs/*.json`,
    merged by `catalogIndex.ts`): ~229 entries, oracle-verified, zero-inference deterministic
    code generators. `CatalogEntry { id, filename, summary, patterns[], defaultPath, exports[],
    impl, tests[] }`. These are compile-time primitives Crucible pattern-matches against, not
    something the live agent invokes as a "tool" mid-conversation.
  - **Dynamic tool registry** (`src/CrucibleEngine/tools/registry.ts`, 1654 lines):
    `registry.register/list/get/exec`. Built-in tools include `read_file`, `write_file`,
    `edit_file`, `apply_patch`, `search`, `run`, `web_search`, `query_world_model`,
    `consult_specialist`. **`create_tool` (line 819) ALREADY lets the agent write and persist
    a brand-new tool from a natural-language description, live in-session AND reloaded in all
    future sessions** (`.crucible/dynamic-tools/`, real files on disk). `list_dynamic_tools`
    (line 920) already lists them. This is most of feature #1 below — it has no UI yet, that's
    the actual gap.
- **No skill/tool browsing UI exists at all** — confirmed zero hits for "catalog"/"skill list"
  anywhere in `src/App.tsx` or any `.tsx` file. The drawer UI PATTERN already exists though
  (`.crucible-tasks-drawer` / `.crucible-history-drawer`, App.tsx ~992-1352, and an "External
  tool integrations" drawer at ~3701) — reuse that CSS/component convention, don't invent a new
  one.
- **Chat modes today**: `quorum | code | seeker | research` (App.tsx:1872, switched by
  `ModeSwitcher` at line 48, or auto-classified by `classifyMode`, lines 2100-2113). `agent` is
  a 5th mode but it's **programmatic-only** — set by Remote Brain / detected-coding-task logic
  (line 2568, gated at 2395 in `server.ts`), never user-selectable. There is no "just talk
  about what to build" mode distinct from full tool-loop execution.
- **RSI/self-improvement already runs, just has no user-facing "propose → explain → approve"
  surface**: `src/CrucibleEngine/rsi/controller.ts` (`runRsiCycle`, `snapshotLearnedState`,
  kill switch `setRsiEnabled`), `autoImprove.ts` (`doImprovementPass`, pattern/weight tuning),
  `applyLayer.ts` (snapshot→apply→verify→keep-if-not-worse→hard-restore). Endpoints:
  `GET /api/rsi/status` (server.ts:5949), `POST /api/rsi/cycle` (5954), `POST /api/rsi/kill`
  (5965) — these are raw toggles with no plain-language explanation and no approval gate.
- **Retrieval layer** (`src/CrucibleEngine/retrieval/retrievalLayer.ts`, 388 lines) already
  does DDG search (`search`, line 100), page fetch + boilerplate-strip + code-block extraction
  (`fetch`/`stripBoilerplate`/`extractCodeBlocks`, 189-239), npm/DefinitelyTyped type pulling
  (`fetchTypeDefs`, 263), relevance ranking (`rankByRelevance`, 301), and a top-level
  `retrieveForTask`/`buildRetrievalBlock` (328/368) that only feeds the FM's prompt context —
  there is no user-facing "here's what I found, want me to wire it in" surface yet.
- **`consult_specialist`** (registry.ts:960) already does one-hop parallel-ish agent-to-agent
  consultation (researcher/coder/critic/strategist) — a real, if narrow, precedent for
  feature #5.
- **Local model wiring**: `LOCAL_MODEL` const (`modelRegistry.ts:49-54`,
  `{id:'local/apple-fm', provider:'local'}`) plus the Swift daemon in `local-inference/`
  (port 11435). It is NOT currently in the main `MODEL_REGISTRY` selection array — worth
  checking whether that's intentional or a gap while touching this area.
- **Two competing agent-execution stacks still unresolved** (priority-ladder item 4, see
  `crucible-agentic-architecture` memory): live path is `agent/planner.ts`+`agent/loop.ts`;
  the clean `capabilityRouter→decompositionDag→nodeExecutor` stack is parked, proven only in
  isolation. Feature #5 (parallel agentic calling) directly collides with this — see below.

---

## Feature 1 — Skill Library + Tool Library drawers (nested, browsable, NL-buildable)

**Build:**
- Two new drawers (reuse the existing drawer component/CSS pattern) — "Skill Library" and
  "Tool Library" — each a nested/collapsible list.
- **Tool Library**: new `GET /api/tools/dynamic` wrapping `listDynamicTools(projectPath)` +
  `registry.list()` for built-ins. Show name, description, use count, created-by, last-used.
  The "describe in plain language and have it built" ask is **already implemented** at the
  engine layer via `create_tool` — wire a text box in this drawer that sends a chat message
  engineered to invoke `create_tool` (or add a lightweight dedicated endpoint that skips full
  agent-loop classification overhead for a clearly-scoped "build me a tool that does X" intent).
- **Skill Library**: list `catalogIndex.ts`'s merged `ALL` array (id, summary, defaultPath).
  The NL-build path does NOT exist yet for skills (skills are oracle-verified via
  `synth/generate.ts` + `validate-batch`, a batch/offline pipeline, not a live agent action).
  New work: a server endpoint that takes a plain-language skill request, runs it through the
  EXISTING generate→validate pipeline, and on success appends a new entry to a
  `catalogs/user-skills.json` (same schema as the other `catalogs/*.json` files) so it becomes
  a permanent zero-inference primitive, not a one-off. Follow the established
  "confirm-not-already-a-catalog-primitive-first" + hand-verify-with-reference-and-buggy-impl
  discipline from `crucible-coding-harness` memory before landing any new entry.
- **"Access in future sessions via a type command or the directory directly"**: dynamic tools
  already persist to `.crucible/dynamic-tools/` (real files, already directory-browsable).
  Give skills the same treatment (`catalogs/user-skills.json`, browsable). Add a slash-style
  chat shortcut (`/tool <name>`, `/skill <name>`) that looks up by exact name and either
  invokes directly (tool) or synthesizes against the catalog entry (skill) — bypassing full NL
  intent classification for the common case of "I know exactly what I want to run."

## Feature 2 — Conversation Mode (plain-language planning + live check-ins)

**Build:**
- New 5th user-selectable `ModeSwitcher` option — call it `plan` or `discuss`. Runs the same
  conversational pipeline as `quorum` today, but loads `goalDecomposer.ts` context so the model
  can ask clarifying questions and describe its intended approach in plain language before any
  code gets written. Only hands off to real agent-mode execution (the tool loop) on explicit
  user confirmation ("go ahead", "build it", etc.) — this is a natural pairing with the
  still-unbuilt Workstream 2 (upfront elicitation, see priority-ladder item 3 / `HITL_PLANNING_TRACK.md`)
  and should probably be built together with it rather than as a separate parallel thing.
- **Mid-build check-ins** ("hey how's the code coming?"): agent-mode already streams SSE
  progress (`/api/debug/stream`, iteration/progress events feeding `.crucible/exec-ledger.jsonl`).
  Check whether `getOrCreateSession`/`abortCurrentTask` (server.ts ~2408) can accept a
  side-channel question WHILE a run is in flight without interrupting the tool loop — if not,
  add a lightweight query path that answers from the live session/ledger state directly
  (iteration count, current file being worked, last error) rather than requiring the user to
  wait for completion or abort to ask.

## Feature 3 — Matt Pocock ecosystem tooling ("deep modules", "de-slop")

**This is a research task first, not a build task.** Use the existing retrieval layer
(`retrievalLayer.ts`'s `fetch`/`extractCodeBlocks`) to actually pull Matt Pocock's public
repos and identify concrete, license-clean, reusable pieces — do not vendor speculatively.
Likely candidates once confirmed: "deep modules" (Ousterhout-style code-organization
heuristics — could become a new deterministic critic gate, same family as `lintGate.ts`/
`contractGate.ts`, flagging shallow/over-fragmented module structure) and "de-slop" (AI-
generated-code cleanup patterns — could become a critic that flags AI-slop smells: redundant
comments, over-abstraction, dead branches, unnecessary indirection — directly serves mission
criterion 4, "genuinely good fixes, not plausible-looking patches"). Land whichever pieces
prove out as either (a) a new Workstream-1 critic gate, or (b) new skill-catalog entries — not
as a blind file dump.

## Feature 4 — Auto-recommend relevant repos/resources based on current task context

**Build:** extends `retrievalLayer.ts` directly. `retrieveForTask`/`rankByRelevance` already
find and rank external sources for FM grounding — that's currently invisible to the user. Add
a user-facing surface: when relevance score clears a threshold, show a suggestion card (reuse
the "External tool integrations" drawer pattern, App.tsx:3701) with a plain-language
description of what was found and how it would be wired in (e.g. "found X in <repo> — would
add as `src/lib/y.ts`, call it from your existing `z()`"), with a one-click accept that runs
through the SAME apply/verify/RSI-gated pipeline as any other agent edit (`applyLayer.ts` —
snapshot→apply→verify→keep-if-not-worse). Never blind-paste ungated external code — that would
violate the project's "no import lands without verifying it" grounding constraint (ROADMAP.md
"Grounding" section).

## Feature 5 — Parallel agentic calling to specialized resources

**Scope this carefully before building — it's the highest-leverage and highest-risk item
here.** `consult_specialist` already does one-hop parallel-ish fan-out. The literal ask (cloud
repos/DBs agents call out to) needs disambiguation: building genuinely NEW hosted
infrastructure conflicts with the mission's zero-external-dependency constraint unless it's
Crucible's own free-forever compute (see Feature 6 — don't conflate the two). The
mission-aligned concrete interpretation: **parallelize the agent's OWN reasoning across the
local free-model pool** by extending `agent/loop.ts` to dispatch independent nodes from the
(currently parked) `decompositionDag.ts` as concurrent `consult_specialist`-style calls instead
of one node at a time. This is also the natural forcing function to finally resolve
priority-ladder item 4 (two competing agent stacks) — you can't parallelize DAG nodes on a
stack that doesn't run DAG nodes live. Do not merge the parked stack speculatively; prototype
the parallel-dispatch pattern in isolation first, same discipline that parked it originally
(see `crucible-agentic-architecture` memory).

## Feature 6 — Cloud-hosted heavy tools (voice, image recognition) — DESIGN ONLY, do not build

**Explicitly deferred by the user pending more discussion — do not write code for this.**
Produce a short design note instead: which capabilities are provably impossible to run locally
on the target hardware (8GB Mac, per the `crucible-track-s-local-inference` memory's A18/8GB
constraint) — likely real-time voice transcription/synthesis and heavier vision models — and
which genuinely-free-forever (not "free tier of a paid API," which the mission explicitly
rejects elsewhere as the "External-tool invariant") hosting options exist. ROADMAP Tier 3
already scopes "Opt-in Distributed Compute" as unbuilt — this may be the same idea. Flag
open questions for the user rather than picking an answer.

## Feature 7 — Self-cleaning / self-repair with plain-language proposals + one-click apply

**Build:** the RSI/autoImprove/applyLayer machinery already runs end-to-end — what's missing
is the user-facing "propose, explain, approve" loop the user explicitly asked for. Concretely:
1. Extend `runRsiCycle`'s returned `Verdict` (currently pass/fail only, `rsi/controller.ts`)
   with a plain-language `summary`/`rationale`/`plan` — template it from signals
   `doImprovementPass` already computes (what changed, why, expected effect). No new model
   calls needed, matching this project's "recombination of existing signals" convention
   (see ROADMAP's Priority 6 design for the same pattern applied to confidence calibration).
2. Add a `pending` state to the RSI cycle: propose → surface in a new drawer/card (plain
   language, not a diff dump) → user clicks Apply/Reject → only THEN run the existing
   snapshot→apply→verify→keep-if-not-worse path. Default to requiring approval; an explicit
   opt-in toggle can allow full-auto for users who want true AFK.
3. This is the first concrete, scoped real use case for the still-unbuilt HITL/AFK stakes
   router (priority-ladder item 3) — building this approval gate IS a legitimate first test
   case for that router, not a separate parallel effort. Treat it as such rather than
   reinventing an ad hoc approval flow that the router will later have to subsume.

---

## Execution order suggestion (not a hard requirement — reorder if you find a better path)

1. **Feature 1** (skill/tool drawers) and **Feature 7** (self-repair approval UI) are the most
   concretely scoped with the least architectural risk — good first targets to crunch through
   fast, and both are close to pure UI + thin endpoint wiring over already-working engine code.
2. **Feature 4** (retrieval recommendations) is a moderate extension of an existing module.
3. **Feature 3** (Pocock research) can run in parallel with anything else — it's pure retrieval
   + design work, no shared-file contention with the UI work above.
4. **Feature 2** (conversation mode) should be scoped together with Workstream 2
   (upfront elicitation) rather than built in isolation — read `HITL_PLANNING_TRACK.md` first.
5. **Feature 5** (parallel agentic calling) is the biggest architectural bet — don't start it
   until 1/4/7 are done and you've re-read the `crucible-agentic-architecture` memory in full.
6. **Feature 6** — design note only, explicitly not code, this session.

Every item that touches derive.ts/oracle/harness code inherits the standing disciplines from
`crucible-coding-harness` memory: read `.crucible/fm-rounds.jsonl` before guessing on any RED
result, confirm a new skill isn't already a catalog primitive before adding it, hand-verify
new hidden test suites against both a reference AND a deliberately-buggy implementation before
trusting them as a live signal, and restart `:3001` onto the new commit before any `smoke:code`
sweep — in-process changes are invisible otherwise.

## End-of-session requirement (same as every session)

Update NEXT_SESSION.md CURRENT STATE (replace, don't append), ROADMAP.md CHANGE LOG (append),
and relevant memory files with what got built vs. deferred, plus the mandatory % estimate
toward the 5-point mission bar at the top of this file — not toward any narrower metric
(catalog coverage %, latency reduction %, single-benchmark pass rate) that could get
conflated with overall progress again.

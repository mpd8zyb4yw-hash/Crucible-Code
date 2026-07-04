# Crucible — HITL / Planning Design Track (parallel to the engine track)

> **STATUS: DESIGN PROPOSAL — NOTHING HERE IS BUILT.** Speculative design output from a
> tangent conversation (triggered by Matt Pocock's "AI Coding for Real Engineers" workshop),
> not shipped code. Read it as **additive** to the engine-track handoffs (ROADMAP.md CHANGE
> LOG + NEXT_SESSION.md CURRENT STATE), a second parallel track about planning/UX — NOT a
> replacement for engine work and NOT a competing set of tasks to start immediately. The
> engine track's item 0 (dark gates) took priority and was fixed 2026-07-04; see the
> ROADMAP cont. 9 entry. Verify every claim below against the live repo before acting —
> none of it has been checked against what may already exist (skill registry,
> `registerSkill()`, the out-of-depth tripwire).

Filed 2026-07-04 at the user's request. This document is the canonical home for this track;
ROADMAP.md and NEXT_SESSION.md carry one-line pointers to it.

---

## 1. Why this track exists

The user is building/using Crucible with **zero programming background** ("vibe coding").
That changes design priorities in ways the engine-focused roadmap doesn't fully cover:
technical correctness gates (Gate A2, the tripwire) protect code quality, but nothing in the
current design specifically protects the *experience* of someone who can't read a diff,
doesn't know the vocabulary, and needs the system to check in rather than guess or silently
proceed. This track closes that gap, informed by (not copying) Matt Pocock's AI-coding
workshop — whose target audience (a fluent engineer running Claude Code/Sandcastle across a
team) differs enough that most ideas need adaptation, not adoption.

## 2. Pocock workshop — evaluated, verdict on each

**Adopt near-term (treated as fixes to existing known issues, not new competing priorities):**
- **Fresh-context review, never same session as implementation.** Candidate reinforcement for
  the engine-track item-0 fix (`grounding`/`harden`) — a genuinely separate review invocation
  seeing only the diff/spec. NOTE: item 0's *structural* darkness was already fixed (glue was
  misrouted through the coding-loop state machine); the remaining follow-up is the on-device
  FM's *judgment* quality, which a fresh-context stronger-tier reviewer could address — within
  the model-cost-independence constraint (FM-first, escalate only to the free pool).
- **Doc-rot discipline, more aggressive than current practice.** Hit twice already (stale
  `CRUCIBLE_SESSION_HANDOFF.md`; NEXT_SESSION.md's standing rule exists because of a prior
  identical incident). Pocock's answer — don't leave superseded planning docs in the repo at
  all, even banner-marked; close/archive them out of an agent's default search path — is
  sharper than the "mark superseded" fix already applied. Worth reconsidering.
- **Context-budget enforcement as an explicit, measured constraint.** Pocock claims a ~100k
  token "smart zone" ceiling regardless of advertised window, from quadratic attention
  degradation. Worth empirically testing against Crucible's own FM (does repair/synthesis
  quality measurably degrade with context size?) rather than assuming it applies or doesn't.

**Adapt, don't import wholesale:**
- **Grill-me / upfront elicitation** — real overlap with already-planned Workstream 2
  (ambiguity surfacing). Adapt heavily for this user — see §3.
- **Tracer bullets / vertical slicing** — directionally right, not urgent today (current
  stress tasks are single-function, not multi-layer). Becomes relevant if/when the parked DAG
  stack (`decompositionDag.ts`) is un-parked for multi-file feature work — carry as a design
  constraint on *that* decision, don't build now.
- **Push-rules-to-reviewer / pull-skills-for-implementer** — cheap, close to how the skill
  registry already works; apply as lightweight prompting discipline (lean implementation
  system prompt; standards enforcement lives in the gate layer).

**Deferred/skipped:**
- **Sand Castle-style parallel Docker-sandboxed multi-agent orchestration.** Solves a
  different problem (a fleet of interchangeable paid-model agents unblocking a team) than
  Crucible has (one local FM cascade, one machine, real compute constraints). Adds real
  complexity without addressing anything on the current open list. Flagged so it doesn't
  quietly become an assumed future milestone.

## 3. Core design — a stakes-aware HITL/automation router, novice-safe by default

User's stated preference: **more HITL is fine if it makes the end product better; automate
when safe and effective; escalate to a human for bigger-stakes decisions.** Same shape as the
existing out-of-depth tripwire, generalized from "codegen retries" to "planning/decision
points generally."

**A router scoring every decision point on:**
- **Reversibility** — cheaply undoable (rerun, rollback) vs. a one-way door (data deletion,
  irreversible external action).
- **Ambiguity** — does the spec/plan determine the answer, or is this a genuine judgment call?
- **Blast radius** — one function, or a system-wide ripple?

Low-stakes + reversible + unambiguous → automate silently. High-stakes / irreversible /
genuinely ambiguous → route to HITL via grill-me. Reuses the tripwire's honesty principle
rather than building a second parallel system.

**The HITL interface, when triggered — designed for zero programming background:**
- **Multiple-choice by default**, 2–4 mutually exclusive options, one question at a time
  (never a batch of 40+, unlike Pocock's engineer-facing version).
- **Always a "something else / not sure" escape hatch** dropping into a short free-text
  follow-up only when picked.
- **Plain-language restatement of the real-world consequence**, not the technical mechanism —
  not "should writes be idempotent?" but "if someone clicks submit twice, should that make two
  entries, or just one?" A translation/prompt-engineering problem, not a widget choice.
- **A recommended default always visible**, in the same plain language ("Just one — this is
  the recommended default").

## 4. New — agentic self-direction of which tool/skill to invoke next

The model should **notice, mid-conversation, that a specific gap exists and proactively name
both the gap and the tool it thinks closes it** — e.g. "this plan has a few inconsistencies
around X — want to run a grill-me pass before we build?" — rather than silently proceeding,
silently asking an unstructured question, or waiting to be told which skill to use.

This means the skill/tool library (§5) must be **legible to the model itself**, not just
invocable by command — each tool needs a standing model-facing sense of what class of gap it
closes, so the model can match a detected gap to the right tool and explain the match in plain
language, as a suggestion the user can accept or wave off (not a silent auto-trigger). Natural
extension of the tripwire (detect something's off) + the §3 router (decide if it's
stakes-worthy); the addition is that the model **narrates its own diagnosis and proposed next
step**. Treat this narration as a first-class UX requirement for every tool: each skill ships
with a short model-facing "symptom that suggests reaching for this."

## 5. Proposed skill/tool library (adapted from Pocock, reframed for this user)

- **`grill-me`** — entry point for ambiguity/inconsistency, MC-first per §3. Self-triggerable
  per §4.
- **`explain-this`** — reverse of grill-me: user points at a decision/diff/term/error, gets a
  plain-language explanation without derailing the main task. Covers *mid-task* confusion that
  upfront-only grill-me doesn't.
- **`to-plan`** (Pocock's `to-prd`) — converts a grill-me session into a plain-language plan
  the user can actually read and approve/reject (deviation from Pocock, who is fluent enough
  not to read his own PRDs).
- **`to-tasks`** (his `to-issues`) — vertical-slice breakdown; each task gets plain language
  ("next you'll be able to X", not "implement PATCH /todos/:id").
- **`diagnosing-bugs`** — adopt near as-is: reproduce → minimize → hypothesize → instrument →
  fix → regression-test. Fits the existing `fm-rounds.jsonl` ledger discipline.
- **`code-review`** — maps to the item-0 fresh-context-reviewer reinforcement. Needs a
  plain-language summary layer over the technical diff for this user.
- **`handoff`** — compact a session into a clean resumable state. Close to what's been done
  manually for Crucible across this whole thread — worth building as a real skill.
- **`checkpoint`/`prototype`** — disposable sandbox for a risky/uncertain direction before
  committing; planning-stage analog of the RSI snapshot→verify→keep-or-restore discipline.

## 6. Broader experience refinements (novice-first)

- **A living, auto-built glossary** — captures project-specific term meanings as introduced in
  grill-me/planning sessions, so the user has a standing reference.
- **Plain-language "what just happened" narration for AFK/automated work** — a short summary
  ("added the ability to mark a task done — here's what changed and why"), not a raw commit
  log/diff. Likely the single biggest gap vs. Pocock's audience.
- **A plain-language confidence/cost indicator per decision** — not a percentage; "common,
  well-tested pattern" vs. "judgment call, reasonable people differ" vs. "not fully sure,
  worth a second look." The tripwire's honesty principle, surfaced to the user.
- **Undo as a first-class, user-visible feature** — if RSI already guarantees a clean internal
  rollback, expose it as a plain "undo the last change" affordance.
- **Adjustable HITL sensitivity** — let the user (or a learned setting) control how often
  they're asked, rather than one fixed bar for everyone.

## 7. Open questions (left open on purpose)

- Where does the §3 stakes-router live — a generalization of the out-of-depth tripwire, or a
  separate mechanism sharing its philosophy? Extending the existing (working, though
  provisionally-tuned) tripwire seems more promising, but hasn't been checked against its
  implementation.
- How much of §4 (self-directed tool selection) risks becoming a new fail-open surface — if
  the model fails to notice a gap it should flag, that's the same shape as a silently-dark
  gate. Whatever telemetry/verification discipline applies to Gate A2 and the tripwire should
  apply here too (cf. the gate-telemetry work).
- None of §5's skill list has been reconciled with what may already exist (skill registry,
  `registerSkill()`). Do that before building anything net-new, per "verify, never guess."

## 8. Status

Nothing here is built. Weigh against engine-track priorities in ROADMAP.md / NEXT_SESSION.md.
The engine track's dark-gate item was the most urgent issue and is now fixed; the follow-up
(FM critic *judgment* quality) is the current engine priority. This track's most natural first
build is **Workstream 2 (upfront elicitation) reframed as `grill-me` per §3**, since it
already has a roadmap slot.

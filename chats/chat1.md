# Crucible UI redesign implementation

_Started 2026-07-06 00:44 UTC_

---

## User

fix crucibles ui to abide by the following, all pipeline ui elements, calls, etc should be fully wiped and replaced with the new clean ui decisions outlined below ask any clarifying questions before beginning.   claude 4.8 just fucked this all up i need you to fix it  ## Repo

`/Users/justin/crucible-local/crucible-local`, branch `crucible-northstar-sessions`.
**Check `git status` first** — there is likely still a prior uncommitted diff (critic
split-routing fix) sitting in the tree. Don’t lose it; commit or stash it before starting
this, since this task will touch overlapping files (`App.tsx`).

## Inputs already in the repo

- `Crucible UI redesign/Crucible v2.dc.html` — the new design (target look/UX).
- `Crucible UI redesign/Crucible - Current UI.dc.html` — current UI for diffing against.
- `Crucible UI redesign/support.js`, `.thumbnail` — supporting assets.
- These are static exports (likely from a design tool), NOT React — treat as a visual/UX
  spec to reimplement in `src/App.tsx` and friends, not files to import directly.

## Current architecture (what exists today)

- `src/App.tsx` is a 269KB monolith: UI + orchestration logic combined. This is the main
  file you’ll be restructuring.
- Mode state: `useState<'quorum'|'code'|'seeker'|'research'>('quorum')` (~line 1874).
  `ModeSwitcher` component (~line 50) renders the bottom mode picker. `'quorum'` = Ensemble
  (“Multi-model pipeline”, line 44).
- `classifyMode()` (~line 2102) auto-routes prompts into ensemble/quorum mode based on
  complexity/length — **this is why every query currently hits the pipeline**, not just
  explicit ensemble requests.
- Pipeline/ensemble config: `modelRegistry.ts` `PIPELINE_CONFIG` (parallelCount: 3,
  wildcardCount: 1) — this is likely called regardless of mode for anything not trivial.

## What “Crucible” vs “the pipeline” means here (confirm with Justin if unclear)

“Crucible” = the local FM / on-device model path (fast, no external API calls).
“The pipeline” / “ensemble” = the multi-model external API fan-out (Groq/OpenRouter/etc,
`PIPELINE_CONFIG`, `selectDriverCandidates`). Quality complaints (“responses are F tier”)
are reportedly from pipeline output, not Crucible’s own model — verify this assumption by
tracing one real request end-to-end before assuming which path is actually underperforming.

## Required changes

1. **Reimplement the new UI** (`Crucible v2.dc.html` as spec) into `App.tsx`/component tree,
   following its design system (spacing, color, dark-mode-only, typography) as the new
   default — replace ad hoc styling, don’t layer on top of it.
1. **Remove the 3-mode picker entirely** (`ModeSwitcher`, the `mode` state machine as
   currently structured). Replace with: Crucible (local) is the default and only path for a
   normal query — no picker needed.
1. **Make ensemble/pipeline opt-in, not automatic.** Remove/neuter `classifyMode`’s
   auto-escalation to `'quorum'` on complexity. Instead: surface an explicit toggle or a
   confirmation ask (“Use ensemble mode for this?”) before any external API fan-out happens.
   Default = Crucible only, zero external calls, unless the user opts in.
1. **Revamp the main page** so it visually presents as “Crucible” — not a pipeline/ensemble
   dashboard. Pipeline/ensemble UI (progress theater, per-model panels, etc. — e.g.
   `crucible-pipeline-theater`, `crucible-pipeline-status`, `crucible-pipeline-log` class
   names around lines 579, 4091, 4713) should move behind the opt-in, not be default-visible.
1. **Verify every tool actually works** post-merge — don’t assume parity. Regression-test
   whatever tool-calling surface exists (this repo has a `src/CrucibleEngine/tools/`
   directory and `src/CrucibleEngine/agent/` — check both).
1. **Crucible chat animation — FINAL SPEC.** This has been through several revisions with
   Justin; the below is final and should NOT be re-discussed or re-asked about. Three phases,
   triggered by the real lifecycle of a streaming response:
   
   **A) Idle/thinking** (trigger: message sent, before first response token arrives)
- Crucible icon loops continuously: upright → tilt right → upright. Slow, fluid,
  ease-in-out, no hard stops or snapping.
   
   **B) Pouring** (trigger: first token arrives; runs for the full duration of streaming)
- Crucible holds a full tilt-right “pouring” pose — distinct from idle’s partial tilt —
  and stays there (no idle-looping during this phase).
- A continuous molten stream animates from the crucible’s spout to the top of the message
  box border. Must read as liquid: mottled/uneven gradient (not flat orange) + subtle
  animated shimmer + soft outward bloom/glow, combined. A flat solid-color bar is wrong.
- From that top point, molten glow fills the box border down BOTH left and right edges
  simultaneously, corners rounded to match the box’s border-radius, converging toward the
  bottom-center of the CURRENT content edge — track the box’s live/growing height, don’t
  target a guessed final height.
- The entire poured-so-far border stays lit in ambient molten glow through this whole
  phase (not just a thin leading edge) — everything poured so far keeps glowing.
- Fill speed follows real token arrival (faster incoming text → faster visible fill) but
  is smoothed, not literal: bursts ease the fill forward rather than snapping it; gaps
  between tokens keep a slow idle shimmer/drift so it never looks frozen.
- Enforce a MINIMUM fill duration (~1.2–1.5s floor, tune as needed) even for a
  near-instant full response, so the pour always reads as fluid and is never skipped.
   
   **C) Complete** (trigger: response finishes streaming)
- Crucible returns to upright and fades to 0 opacity — clean, smooth, no snap.
- Concurrently, the border cools: molten glow transitions to the default dark-mode border
  color, sweeping top-to-bottom (same direction as the original pour) — top cools first,
  bottom cools last.
- Cool-sweep and crucible fade-out run concurrently and finish at roughly the same time —
  completion should read as one unified moment.
- Enforce a MINIMUM cool-sweep duration (~0.8–1.2s floor) so instant responses still
  visibly cool rather than snapping straight to default.
   
   **Implementation notes:**
- A directional partial-border fill tracking live content height is NOT achievable with
  plain CSS border-color transitions. Expect to need a masked/clipped overlay (absolutely
  positioned pseudo-element or SVG border with animated mask/clip-path) revealing the
  molten layer over the box’s real border.
- Drive fill/cool progress from real stream state (token/chunk events + live content
  height), not a fixed timer — but always route the visible motion through an eased
  current→target animator with min/max speed clamps, so motion stays fluid regardless of
  how choppy the underlying token stream is.
- Find the actual streaming-response render logic in `App.tsx` and hook these three
  phases to its real lifecycle events (send → first-token → stream-end) — don’t fake the
  triggers with timers.
- These decisions are final. If something is genuinely ambiguous during implementation,
  make the closest reasonable call consistent with the spec above and leave a code
  comment — do not stop to re-ask Justin.

## Suggested approach for Claude Code

1. Read both `.dc.html` files and `support.js` fully to understand the target design system
   and any animation/interaction logic they encode.
1. Read `App.tsx` in full (or in large chunks — it’s 269KB) to understand current
   structure before changing anything.
1. Ask Justin any clarifying questions BEFORE large structural changes — especially:
- Is “Crucible” the local FM model path, confirmed?
- Should opt-in ensemble be a persistent per-session toggle, or a per-query ask?
- Any specific tools/features from the current app that must be preserved 1:1 vs. can be
  redesigned?
1. Plan the merge as a restructure (new design system + trimmed mode logic + gated
   ensemble), not a patch — but do it incrementally with working checkpoints (tsc clean,
   app boots) rather than one giant rewrite.
1. Land animation fixes last, once structure is stable, so you’re not debugging animations
   against a moving target.

## Do NOT do

- Don’t remove Crucible’s own local-model path/tools while gutting the pipeline UI.
- Don’t assume the `.dc.html` files are directly usable as components — they’re a spec.
- Don’t touch the critic split-routing fix from the prior session (grounding/harden in
  `synthDriver.ts`/`driver.ts`) — unrelated, already verified, don’t regress it.

## Assistant

_[tool: local_ls]_

_[tool: update_todos]_

_[tool: local_read]_

_[tool: local_read]_

_[tool: questions_v2]_

## User

Questions answered:
- deliverable: Fix/rebuild Crucible v2.dc.html as the definitive design spec (with working pour animation) + Claude Code handoff notes
- whats_broken: didnt implement changes, ruined the ui, still routing to pipeline, didnt apply the ui elements you build, idk how to cleanly handoff the files but clearly a .zip with the ui elements wasnt enough to append its stupidity

- ensemble_ui: toggle/ per query for genuine challenging tasks but must require user provided api keys dont list providers have a blank slate where they can name the keys etc not a pre baked "mistral keys:" "gemini keys:" etc. up to the user clean blank slate somewhere

## Assistant

_[tool: local_read]_

_[tool: local_read]_

_[tool: dc_write]_

## Assistant

## Assistant

_[tool: local_grep]_

_[tool: dc_write]_

_[tool: show_html]_

_[tool: write_file]_

_[tool: ready_for_verification]_

Done. Two files:

- **`Crucible v3.dc.html`** — the definitive spec, live and interactive: Crucible-first chat (no mode picker, no pipeline chrome, "ON-DEVICE" identity), ensemble strictly opt-in via composer pill + per-query confirm, blank-slate BYO API keys in Settings (chips on ensemble replies are labeled by *your* key names), and the final 3-phase molten pour animation running on a real simulated token stream — thinking tilt-loop, spout stream + both-edge border fill tracking live card height with a 1.35s floor, then concurrent top-down cool + crucible fade. Tweaks panel exposes stream speed / min-fill / auto-demo.
- **`HANDOFF — Claude Code implementation brief.md`** — verified `App.tsx` line refs (mode state L1801, `classifyMode` L2042, call site L3264, pipeline-theater/status/log L504/4060/4688), the structural changes, design tokens, and porting notes for `drawPour()`.

Caveat: the prototype's stream is canned; the brief tells Claude Code exactly how to swap in real token events. Try typing your own message, and add a key in Settings then arm Ensemble to see the confirm flow.


# Crucible v3 — Agent Coordination

**Read this file first, every session, before touching code.** Two coding LLMs are working
this codebase in parallel. This file is the persistent handshake between you: what exists,
what's left, who's touching what right now, and a running log of what happened. It survives
between sessions — when you start a new session here, `git pull` and read this file before
doing anything else.

Source-of-truth docs (don't duplicate their content here, just point to them):
- `../../project/HANDOFF - Claude Code implementation brief.md` — the implementation spec.
  Its structural requirements and the pour-animation spec are **final** — do not re-litigate
  them, make the closest reasonable call and leave a code comment if something is ambiguous.
- `../../project/Crucible v3.dc.html` — the visual/UX reference prototype (open it, don't
  import it).
- `../../chats/chat1.md` — the original conversation with Justin; explains *why*, not just
  *what*.

---

## Ground rules (apply to both tracks)

1. **Verify, never guess.** Before claiming something is done, grep for the actual wiring —
   a component existing is not the same as it being rendered/called. (Same rule the main
   Crucible repo runs on — keep both codebases held to it.)
2. **Don't regress what's already correct.** As of this writing, the mode picker/`classifyMode`
   auto-escalation is gone, ensemble is opt-in with a per-query confirm card, API keys are a
   blank-slate list (no baked-in provider fields), and `MoltenPour` is wired to real stream
   phases (`thinking → pouring → finishing → cooling`), not timers. Don't reintroduce any of
   these patterns while working on other things.
3. **Zero external calls on the default path.** `streamLocal()` must never fetch/XHR. Only
   `runEnsemble()`, and only after explicit per-query confirmation, may hit the network.
4. **Dark-mode only, tokens from `src/styles/tokens.css`.** Don't hardcode colors that already
   have a token.
5. **Mobile + desktop both.** Any layout/spacing/tap-target change must hold at phone width and
   desktop width — check both before calling a UI change done.
6. **No emojis, no stock/external images.** Self-authored visuals only (canvas/SVG/CSS), per
   the design spec.
7. **Small, working commits.** Land structural changes as checkpoints that build and run
   (`npm run dev` boots, `npm run typecheck` passes) — not one giant diff.

---

## Current state (verified by reading the code, not assumed)

| Area | Status | Where |
|---|---|---|
| Mode state machine / `ModeSwitcher` / `classifyMode` | Removed — confirmed absent | grep clean across `src/` |
| Ensemble opt-in + per-query confirm card | Done | `state/store.ts` (`ensembleArmed`, `confirm`), `components/chat/Composer.tsx` |
| API keys — blank-slate name+value list | Done | `state/store.ts` (`addKey`/`removeKey`), `components/settings/SettingsView.tsx` |
| Pipeline chrome (`crucible-pipeline-theater` etc.) | Never present — confirmed absent | grep clean |
| MoltenPour animation (thinking/pouring/cooling, real lifecycle, fill/cool floors) | Implemented, ported from the prototype's `drawPour` family | `components/chat/MoltenPour.tsx` (303 lines) |
| Design tokens (bg/text/accent/on-device green/radii/glass) | Implemented, matches spec literals | `styles/tokens.css` |
| Local model path | **Stub.** Deterministic templated responder, zero network calls, but not a real on-device model (no llama.cpp/WebLLM/ONNX wired). Explicitly flagged as an integration seam in the file's own comment. | `CrucibleEngine/localModel.ts` |
| Ensemble fan-out | **Partially real.** If a key's value contains a URL, makes a real OpenAI-chat-compatible POST. If it's a bare token with no discoverable endpoint, falls back to a local simulated draft (marked `real: false`). | `CrucibleEngine/ensemble.ts` |
| Tool-calling surface | **Stub.** Two toy tools (`word_count`, `json_format`). Real repo has actual tool implementations (file/shell/web) not available in this build environment. | `CrucibleEngine/tools/index.ts` |
| Agent drafting | **Stub.** Deterministic local planner, no real tool execution loop. | `CrucibleEngine/agent/index.ts` |
| History / Agents / Settings views | Present, functional against local state | `components/history/`, `components/agents/`, `components/settings/` |

**Open question for Justin, don't guess:** this rewrite lives at
`crucible-code/crucible-local/crucible-local` in GitHub, but the HANDOFF brief's repo path is
`/Users/justin/crucible-local/crucible-local` on branch `crucible-northstar-sessions` — a much
larger, pre-existing 269KB `App.tsx` monolith (that repo structure matches
`mpd8zyb4yw-hash/crucible` on GitHub, not this one). Confirm whether this small rewrite is
meant to **replace** that monolith wholesale, or whether specific pieces (MoltenPour, the
opt-in-ensemble state machine, the API-keys UI) need to be **ported into** it. Don't assume;
ask before doing a large merge in either direction.

---

## The plan — two tracks, split to minimize file collisions

### Track A — Engine & Data (owns `CrucibleEngine/`, `state/`, `lib/`)
- [ ] Decide + implement the real local-model integration (or confirm stub-forever is
      acceptable) — `CrucibleEngine/localModel.ts`
- [ ] Expand `tools/index.ts` toward real tool implementations (file/shell/web-fetch), keeping
      the existing `{ name, description, run(input) }` shape so nothing downstream changes
- [ ] Harden `ensemble.ts`: retry/backoff, better error surfacing per-key in the UI, timeout
      tuning (currently a flat 12s abort)
- [ ] Richer `agent/index.ts` planning (currently keyword-matches tool names against free text)
- [ ] Session/history data logic — search, filtering, pinning edge cases in `state/store.ts`
- [ ] Resolve the "which repo is canonical" open question above with Justin

### Track B — Visual & Animation (owns `components/chat/MoltenPour.tsx`,
`components/shared/`, `components/NavRail.tsx`, `styles/tokens.css`)
- [ ] Pixel-check `MoltenPour.tsx` against `Crucible v3.dc.html`'s `drawPour` — fill floor
      (1350ms), cool floor (1000ms), easing curves, molten mottled color range
      (`rgb(255, 70–180, 10–70)` around `#ff6a1a`)
- [ ] Verify glass panel treatment (`backdrop-filter: blur(24–32px)`, inset top highlight) is
      applied consistently across chat/history/settings/agents panels
- [ ] `NavRail.tsx` and `BackgroundBlobs.tsx` visual polish against the prototype
- [ ] Mobile-width pass on all four tabs (chat/agents/history/settings) — verify tap targets,
      overflow, and that MoltenPour's canvas sizing (`left:-24px; top:-70px`) still tracks the
      card correctly at narrow widths

### Shared files — coordinate before editing
`components/chat/ChatView.tsx` and `components/chat/Composer.tsx` carry both data wiring
(Track A) and layout/visual concerns (Track B). Before editing either file for more than a
small fix, add a row to **Active Claims** below so the other track knows to pull first / avoid
concurrent edits.

---

## Parallel-work protocol

1. **Start of session:** `git pull`, read this file top to bottom, check Active Claims.
2. **Before starting non-trivial work on a file** (especially the shared files above): add a
   row to Active Claims with your track, the file(s), and what you're doing.
3. **Work in small commits, push often** — the longer a claim sits unpushed, the more likely
   the other agent collides with it.
4. **When done with a claim:** remove its row from Active Claims and append a dated entry to
   the Change Log below (one or two lines: what changed, why, any regressions to watch for).
5. **If you hit the "canonical repo" open question or anything else genuinely ambiguous and
   consequential** (large merges, deleting the stub engines, changing the animation spec):
   stop and flag it in the Change Log / ask Justin — don't guess on anything expensive to undo.

### Active Claims
_(empty — add a row when you start non-trivial work; remove it when you push the result)_

| Track | Files | Description | Started |
|---|---|---|---|

### Change Log
_(append newest entry at the bottom; keep entries short)_

- **2026-07-06** — Created this coordination doc after auditing current repo state (mode
  machine removal, opt-in ensemble, MoltenPour wiring all confirmed present and correct against
  the HANDOFF brief). No code changes made. Flagged the canonical-repo question above for
  Justin.

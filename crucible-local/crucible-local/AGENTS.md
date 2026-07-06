# Crucible v3 — Agent Coordination (reference implementation — frozen, see RESOLVED below)

**Read this file first, every session, before touching code.** This codebase served as the
reference implementation for the v3 UI redesign. As of 2026-07-06 it's **frozen** — active
two-agent work has moved to `mpd8zyb4yw-hash/crucible`'s `NEXT_SESSION.md` (PRIORITY 0). Skip
to the RESOLVED section below before doing anything here.

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

## RESOLVED — this repo vs. `mpd8zyb4yw-hash/crucible` (2026-07-06)

This rewrite lives at `crucible-code/crucible-local/crucible-local` in GitHub, but the HANDOFF
brief's repo path (`/Users/justin/crucible-local/crucible-local`, branch
`crucible-northstar-sessions`) is actually a much larger, pre-existing 269KB `App.tsx`
monolith with a real backend — that repo structure matches `mpd8zyb4yw-hash/crucible` on
GitHub (confirmed: same `ModeSwitcher`/`classifyMode`/`PIPELINE_CONFIG` architecture), not
this one.

**Decision: this app is a validated reference implementation, not a replacement.** Its
`CrucibleEngine/` is entirely stubbed (fake local model, two toy tools, semi-fake ensemble) —
that's fine for proving out the UI/UX and animation, but the real product's actual pipeline
(`server.ts`), real tools/agent surface, self-patcher, and benchmark suite live only in
`mpd8zyb4yw-hash/crucible` and must not be thrown away.

**This repo is now frozen as a reference — active porting work happens in
`mpd8zyb4yw-hash/crucible`.** See `NEXT_SESSION.md` PRIORITY 0 and the CHANGE LOG entry dated
2026-07-06 in that repo's `ROADMAP.md` for the two-phase port plan and the live claims table.
If you're a coding agent arriving here looking for active work: this codebase's job is done —
go there instead. Only touch this repo again if the port plan explicitly calls for
re-referencing something here.

---

## Change Log
_(append newest entry at the bottom; keep entries short)_

- **2026-07-06** — Created this coordination doc after auditing current repo state (mode
  machine removal, opt-in ensemble, MoltenPour wiring all confirmed present and correct against
  the HANDOFF brief). No code changes made.
- **2026-07-06** — Resolved the canonical-repo question without escalating to Justin: this app
  is a reference implementation, not a replacement for the real product in
  `mpd8zyb4yw-hash/crucible`. Moved the active two-agent work plan to that repo's
  `NEXT_SESSION.md` (PRIORITY 0). This repo is now frozen — no more parallel-track work happens
  here.

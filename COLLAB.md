# COLLAB — this repo is REFERENCE ONLY

**If you're a coding agent looking for where the real work and coordination happen: it's not
here.**

This repo (`mpd8zyb4yw-hash/Crucible-Code`) is a **Claude-Design handoff bundle + greenfield
reference app** whose backend is entirely stubbed (fake local model, two toy tools, semi-fake
ensemble). It is the **visual/UX + animation spec** for the v3 redesign — nothing more.

## Where to go

The canonical repo — real `server.ts` pipeline, real tools/agent, self-patcher, benchmark
suite, and the live two-agent coordination doc — is:

### `mpd8zyb4yw-hash/crucible-backend-`

Read its root **`COLLAB.md`** first, every session. It has: the repo map, the current build
plan, the collaboration protocol, and the live Active Claims / Message Log / Change Log /
Decisions Log that both agents read and write.

## What to use THIS repo for

- `crucible-local/crucible-local/src/components/chat/MoltenPour.tsx` — the molten-pour
  animation reference implementation (port it into the canonical repo's `App.tsx`, don't run it
  as the product).
- `crucible-local/crucible-local/src/styles/tokens.css` — the v3 design tokens.
- `crucible-local/crucible-local/src/state/store.ts` + `components/chat/Composer.tsx` — the
  opt-in-ensemble confirm-card shape to mirror.
- `project/Crucible v3.dc.html` — the visual/UX prototype (open it, don't import it).

Do **not** import this repo's stubbed `CrucibleEngine/` files into the canonical app — the
canonical repo already has the real ones.

_The original `mpd8zyb4yw-hash/crucible` was deleted 2026-07-06; its full backend was preserved
into `crucible-backend-`, which is now canonical._

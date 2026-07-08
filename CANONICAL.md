# CANONICAL SOURCE OF TRUTH — read first

**This repo is the one that actually runs.** Edit and deploy here. Do not use the copies.

| | |
|---|---|
| **Canonical repo** | `github.com/mpd8zyb4yw-hash/Crucible-Code` |
| **Canonical branch** | `crucible-northstar-sessions` |
| **Runs from (Mac)** | `~/crucible-local/crucible-local` |
| **Frontend domain** | `crucible.cam` |

## Stale copies — DO NOT edit or deploy (they will silently diverge)
- `github.com/mpd8zyb4yw-hash/crucible-backend-` — an older, smaller, **non-deployed** copy.
  (Historically mislabeled "canonical" in coordination docs — that was wrong.)
- `github.com/mpd8zyb4yw-hash/Crucible.git` → `~/crucible-local/crucible-local copy` — stale.
- `~/iCloud Drive .../Desktop/crucible`, `~/Desktop/crucible` — stale archives.

If you (a Claude session or a person) are asked to change the app, confirm your working
directory's `git remote get-url origin` is **Crucible-Code** before editing. A fix committed
anywhere else never reaches the running app.

## Deploy — now automatic (auto-sync pipeline)
`electron.cjs` runs an auto-sync pipeline (source runs only): the server runs under
`tsx watch` (auto-restarts on `server.ts`/import changes), and a poller checks
`origin/crucible-northstar-sessions` every 15s — on a new commit it `git reset --hard`s,
rebuilds the frontend if `src/**` changed, and reloads the windows. **So a pushed commit
goes live on the Mac within ~15s with no manual pull/restart.**

Guards: disabled when packaged, when origin isn't `Crucible-Code`, or when checked out on a
branch other than `crucible-northstar-sessions` (won't clobber a WIP branch). Disable with
`CRUCIBLE_AUTOSYNC=0`.

**Bootstrap (one time):** the pipeline itself ships in `electron.cjs`, so it takes one manual
pull + relaunch to activate:
```
git pull origin crucible-northstar-sessions
pkill -f "tsx.*server.ts"; pkill -f electron; sleep 2; npx electron electron.cjs &
```
After that, pushes self-deploy. (A change to `electron.cjs` itself still needs a manual
relaunch — the Electron main process doesn't hot-reload; the `tsx watch` server + windows do.)

## Remote Brain screen stream (how it works, so nobody "re-fixes" it wrong)
- Fast path: **WebRTC** peer-to-peer. Page loads over https (`crucible.cam`); only SDP/ICE
  signaling crosses the tunnel; the screen video flows Mac↔phone directly over the LAN/hotspot.
- Fallback: JPEG frames over WebSocket (`/api/screen-stream-ws`), relayed from the Electron
  capture window (`/api/screen-ingest-ws`) or a screencapture loop.
- Diagnose: `curl -s http://localhost:3001/api/screen-diag` on the Mac.
- Bitrate knobs (fallback path): `CRUCIBLE_CAPTURE_FPS`, `CRUCIBLE_CAPTURE_MAXW`,
  `CRUCIBLE_CAPTURE_QUALITY`.

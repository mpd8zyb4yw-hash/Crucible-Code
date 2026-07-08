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

## Changes only take effect after BOTH steps
The server runs via `tsx server.ts` (no watch) and the phone loads a **built** frontend, so a
`git pull` alone changes nothing that's running:

1. **Rebuild the frontend** (needed for any `src/**` change; the phone loads the build):
   `npx vite build`
2. **Restart the server** (needed for any `server.ts` change):
   `pkill -f "tsx.*server.ts"; pkill -f electron; sleep 2; npx electron electron.cjs &`

Server-only changes (`server.ts`, `/_capture`) need step 2. Frontend changes (`src/**`) need
both. When in doubt, do both.

## Remote Brain screen stream (how it works, so nobody "re-fixes" it wrong)
- Fast path: **WebRTC** peer-to-peer. Page loads over https (`crucible.cam`); only SDP/ICE
  signaling crosses the tunnel; the screen video flows Mac↔phone directly over the LAN/hotspot.
- Fallback: JPEG frames over WebSocket (`/api/screen-stream-ws`), relayed from the Electron
  capture window (`/api/screen-ingest-ws`) or a screencapture loop.
- Diagnose: `curl -s http://localhost:3001/api/screen-diag` on the Mac.
- Bitrate knobs (fallback path): `CRUCIBLE_CAPTURE_FPS`, `CRUCIBLE_CAPTURE_MAXW`,
  `CRUCIBLE_CAPTURE_QUALITY`.

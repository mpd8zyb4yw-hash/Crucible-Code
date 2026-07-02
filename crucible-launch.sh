#!/bin/bash
# crucible-launch.sh — the one and only way to launch/update Crucible locally.
#
# Double-click Crucible.app (which calls this) or run it directly. On each launch it:
#   1. pulls the latest code for the current branch (fast-forward only, fail-safe offline),
#   2. installs deps if package-lock changed, and deploys the Worker to Cloudflare if
#      worker/ or wrangler.toml changed since the last deploy,
#   3. (re)starts the backend (:3001) + Vite (:5180) detached and opens the browser.
#
# It is safe to run repeatedly: if nothing changed and the stack is already healthy it
# just opens the browser. Services are nohup'd, so closing the terminal won't kill them.
#
# Flags:
#   --no-update   skip git pull / npm / cloudflare (fastest launch)
#   --deploy      force `wrangler deploy` even if the worker didn't change
#   --mobile      bind Vite to 0.0.0.0 and print the LAN URL for your phone
#   --restart     force-restart the services even if nothing changed
#   --stop        stop the backend + Vite and exit

set -u

# ── Resolve repo root = this script's own directory (path-independent) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || { echo "Cannot cd to $SCRIPT_DIR"; exit 1; }

BACKEND_PORT=3001
VITE_PORT=5180
LOG_DIR="/tmp/crucible"
STAMP=".crucible/last-worker-deploy"
mkdir -p "$LOG_DIR" .crucible

SKIP_UPDATE=0; FORCE_DEPLOY=0; MOBILE=0; RESTART=0; STOP=0
for a in "$@"; do case "$a" in
  --no-update) SKIP_UPDATE=1;;
  --deploy)    FORCE_DEPLOY=1;;
  --mobile)    MOBILE=1;;
  --restart)   RESTART=1;;
  --stop)      STOP=1;;
  *) echo "Unknown flag: $a";;
esac; done

bold(){ printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }
ok(){   printf '\033[32m  ✓ %s\033[0m\n' "$1"; }
warn(){ printf '\033[33m  ! %s\033[0m\n' "$1"; }

listening(){ lsof -nP -tiTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
backend_healthy(){ curl -fs -o /dev/null --max-time 3 "http://localhost:$BACKEND_PORT/api/diag" 2>/dev/null; }
wait_for(){ # url tries
  i=0; while [ "$i" -lt "$2" ]; do curl -fs -o /dev/null --max-time 2 "$1" 2>/dev/null && return 0; i=$((i+1)); sleep 1; done; return 1
}
stop_services(){
  for p in "$BACKEND_PORT" "$VITE_PORT"; do
    pids=$(lsof -nP -tiTCP:"$p" -sTCP:LISTEN 2>/dev/null)
    [ -n "$pids" ] && kill $pids 2>/dev/null
  done
  # also catch tsx/vite started without a listening socket yet
  pkill -f "tsx.*server.ts" 2>/dev/null
  sleep 1
}
open_app(){
  open "http://localhost:$VITE_PORT" 2>/dev/null
  if [ "$MOBILE" = 1 ]; then
    IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
    [ -n "${IP:-}" ] && printf '\033[1;35m  📱 Phone (same Wi-Fi): http://%s:%s\033[0m\n' "$IP" "$VITE_PORT"
  fi
}

# ── --stop short-circuit ──
if [ "$STOP" = 1 ]; then
  bold "Stopping Crucible"; stop_services; ok "backend + Vite stopped"; exit 0
fi

echo "════════════════════════════════════════"
echo "  Crucible launcher — $(cd "$SCRIPT_DIR" && git rev-parse --abbrev-ref HEAD 2>/dev/null)"
echo "════════════════════════════════════════"

BEFORE=$(git rev-parse HEAD 2>/dev/null || echo "")
AFTER="$BEFORE"

# ── 1. Update phase ──
if [ "$SKIP_UPDATE" = 0 ]; then
  bold "Checking for updates"
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  # Fail fast when offline / unauthenticated instead of hanging or prompting.
  if GIT_SSH_COMMAND='ssh -o ConnectTimeout=8 -o BatchMode=yes' git fetch --quiet origin "$branch" 2>/dev/null; then
    if git rev-parse --verify --quiet "origin/$branch" >/dev/null 2>&1; then
      behind=$(git rev-list --count "HEAD..origin/$branch" 2>/dev/null || echo 0)
      if [ "${behind:-0}" -gt 0 ]; then
        if git merge --ff-only "origin/$branch" >/dev/null 2>&1; then
          AFTER=$(git rev-parse HEAD 2>/dev/null); ok "pulled $behind new commit(s) → $(git rev-parse --short HEAD)"
        else
          warn "behind by $behind but can't fast-forward (local commits or dirty tree) — using current code"
        fi
      else ok "already up to date"; fi
    else warn "no origin/$branch yet — nothing to pull"; fi
  else warn "offline or remote unreachable — launching current code"; fi

  changed=""
  [ "$BEFORE" != "$AFTER" ] && changed=$(git diff --name-only "$BEFORE" "$AFTER" 2>/dev/null)

  # 1b. deps
  if [ ! -d node_modules ] || printf '%s\n' "$changed" | grep -qE 'package(-lock)?\.json'; then
    bold "Installing dependencies"
    npm install --no-audit --no-fund >"$LOG_DIR/npm.log" 2>&1 && ok "deps ready" || warn "npm install failed (see $LOG_DIR/npm.log)"
  fi

  # 1c. Cloudflare Worker deploy — only when the worker actually changed (or --deploy).
  worker_sig=$(cat worker/index.ts wrangler.toml 2>/dev/null | shasum 2>/dev/null | cut -d' ' -f1)
  [ -f "$STAMP" ] || echo "$worker_sig" > "$STAMP"   # baseline on first run; don't surprise-deploy
  if [ "$FORCE_DEPLOY" = 1 ] || { [ -n "$worker_sig" ] && [ "$(cat "$STAMP" 2>/dev/null)" != "$worker_sig" ]; }; then
    bold "Updating Cloudflare Worker"
    if npx wrangler whoami >/dev/null 2>&1; then
      if npx wrangler deploy >"$LOG_DIR/wrangler.log" 2>&1; then
        echo "$worker_sig" > "$STAMP"; ok "Worker deployed ($(grep -o 'https://[^ ]*workers.dev' "$LOG_DIR/wrangler.log" | head -1))"
      else warn "wrangler deploy failed (see $LOG_DIR/wrangler.log) — continuing"; fi
    else warn "wrangler not authenticated (run: npx wrangler login) — skipping deploy"; fi
  fi
fi

# ── 2. Launch phase ──
restart_needed=0
[ "$BEFORE" != "$AFTER" ] && restart_needed=1
[ "$RESTART" = 1 ] && restart_needed=1

if backend_healthy && listening "$VITE_PORT"; then
  if [ "$restart_needed" = 0 ]; then
    bold "Already running"; ok "backend :$BACKEND_PORT + Vite :$VITE_PORT healthy"; open_app
    echo ""; echo "Open. (./crucible-launch.sh --stop to stop, --restart to reload code)"; exit 0
  fi
  bold "Code updated — restarting"; stop_services
fi

bold "Starting Crucible"
stop_services >/dev/null 2>&1
nohup npx tsx --no-deprecation server.ts >"$LOG_DIR/backend.log" 2>&1 &
printf '  backend starting'
if wait_for "http://localhost:$BACKEND_PORT/api/diag" 40; then echo; ok "backend up on :$BACKEND_PORT"
else echo; warn "backend didn't answer in 40s (see $LOG_DIR/backend.log)"; fi

VITE_ARGS="--port $VITE_PORT --strictPort"
[ "$MOBILE" = 1 ] && VITE_ARGS="$VITE_ARGS --host 0.0.0.0"
nohup node node_modules/vite/bin/vite.js $VITE_ARGS >"$LOG_DIR/vite.log" 2>&1 &
printf '  frontend starting'
if wait_for "http://localhost:$VITE_PORT" 30; then echo; ok "Vite up on :$VITE_PORT"
else echo; warn "Vite didn't answer in 30s (see $LOG_DIR/vite.log)"; fi

open_app
echo ""
echo "════════════════════════════════════════"
ok "Crucible is running — http://localhost:$VITE_PORT"
echo "  logs: $LOG_DIR/{backend,vite}.log   stop: ./crucible-launch.sh --stop"
echo "════════════════════════════════════════"

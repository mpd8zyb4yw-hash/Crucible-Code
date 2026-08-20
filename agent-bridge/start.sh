#!/bin/bash
# Start the agent bridge daemon. Survives terminal close.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$DIR")"
STATE="$REPO/.agent-bridge"
PIDFILE="$STATE/bridge.pid"
LOG="$STATE/logs/bridge.log"
mkdir -p "$STATE/logs"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running (pid $(cat "$PIDFILE"))"; exit 0
fi

cd "$REPO"
nohup node "$DIR/daemon.mjs" >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"
sleep 2
if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "bridge started (pid $(cat "$PIDFILE")) — log: .agent-bridge/logs/bridge.log"
else
  echo "bridge failed to start; last lines:"; tail -20 "$LOG"; exit 1
fi

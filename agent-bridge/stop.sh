#!/bin/bash
# Stop the bridge daemon.
#
# If the LaunchAgent is installed, it is booted out first — otherwise KeepAlive
# would simply restart the process we just killed.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$(dirname "$DIR")/.agent-bridge"
LABEL="cam.crucible.agent-bridge"

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  echo "launchagent stopped (it will start again at login unless uninstalled)"
fi

for f in "$STATE/bridge.lock" "$STATE/bridge.pid"; do
  [ -f "$f" ] || continue
  PID="$(cat "$f")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    sleep 1
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
    echo "daemon stopped (pid $PID)"
  fi
  rm -f "$f"
done
echo "bridge stopped"

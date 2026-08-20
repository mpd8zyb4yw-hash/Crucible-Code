#!/bin/bash
# Report daemon state without touching Gmail.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$(dirname "$DIR")/.agent-bridge"
LOCK="$STATE/bridge.lock"
LABEL="cam.crucible.agent-bridge"

# The daemon writes its own lock, however it was started.
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then
  echo "running (pid $(cat "$LOCK"))"
else
  echo "not running"
fi
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "launchagent: installed (starts at login)"
else
  echo "launchagent: not installed — start manually with ./agent-bridge/start.sh"
fi
echo "bridge id: $(cat "$DIR/.secrets/bridge_id" 2>/dev/null || echo '?')"
echo "owner:     $(cat "$DIR/.secrets/owner" 2>/dev/null || echo '?')"
[ -f "$STATE/processed.json" ] && echo "processed: $(node -e "console.log(Object.keys(require('$STATE/processed.json')).length)" 2>/dev/null || echo '?')"
echo "--- last log lines ---"
tail -12 "$STATE/logs/bridge.log" 2>/dev/null || echo "(no log)"

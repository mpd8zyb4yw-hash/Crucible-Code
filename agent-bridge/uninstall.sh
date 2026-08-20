#!/bin/bash
# Remove the bridge, reversibly.
#
#   --keep-state   leave .agent-bridge/ (journal, checkpoints) for inspection
#
# The Crucible repo and all user data are left untouched. Revoking Gmail
# access itself is a separate step, done at myaccount.google.com/permissions.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$DIR")"
KEEP=0; [ "${1:-}" = "--keep-state" ] && KEEP=1

"$DIR/stop.sh" || true

PLIST="$HOME/Library/LaunchAgents/cam.crucible.agent-bridge.plist"
if [ -f "$PLIST" ]; then
  launchctl bootout "gui/$(id -u)/cam.crucible.agent-bridge" 2>/dev/null || true
  rm -f "$PLIST"
  echo "LaunchAgent removed"
fi

rm -rf "$DIR/.secrets"
echo "bridge secrets removed (the local Google token copy)"

if [ "$KEEP" = "1" ]; then
  echo "state kept at .agent-bridge/ for inspection"
else
  rm -rf "$REPO/.agent-bridge"
  echo "state removed"
fi
echo
echo "The bridge is gone. To also revoke Gmail access for Crucible, visit"
echo "https://myaccount.google.com/permissions"

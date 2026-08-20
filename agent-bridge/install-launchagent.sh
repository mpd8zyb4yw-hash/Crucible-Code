#!/bin/bash
# Install a user LaunchAgent so the bridge comes back after login.
#
# User-scoped, no root, no network listener, removable with uninstall.sh.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$DIR")"
LABEL="cam.crucible.agent-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"
mkdir -p "$HOME/Library/LaunchAgents" "$REPO/.agent-bridge/logs"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/daemon.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$REPO/.agent-bridge/logs/bridge.log</string>
  <key>StandardErrorPath</key><string>$REPO/.agent-bridge/logs/bridge.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
</dict>
</plist>
PLISTEOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 2
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "LaunchAgent $LABEL installed and running"
  echo "remove with: ./agent-bridge/uninstall.sh"
else
  echo "LaunchAgent installed but not confirmed running; check .agent-bridge/logs/bridge.log"
fi

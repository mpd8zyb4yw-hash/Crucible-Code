#!/usr/bin/env bash
#
# Install (or reinstall) the deploy watchdog, and PROVE it is registered.
#
# The proof is the point. `launchctl load` is quiet about almost everything —
# a malformed plist, a path that does not exist, a job that was already loaded —
# and a watchdog nobody checked is indistinguishable from no watchdog at all,
# which is the exact failure it exists to prevent one level up.
#
# Idempotent: run it as many times as you like.
#
set -uo pipefail
cd "$(dirname "$0")/.."

LABEL="com.crucible.deploy"
SRC="scripts/watchdog.plist"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ ! -f "$SRC" ]; then
  echo "✗ $SRC is missing — nothing to install."
  exit 1
fi

# THE PATH IS RESOLVED HERE, NOT WRITTEN INTO THE TEMPLATE. A hard-coded home
# directory is a watchdog that stops working the day the checkout moves, and it
# stops working SILENTLY — launchd does not complain about a job whose program
# is missing, it simply never produces anything.
ROOT="$(pwd -P)"
mkdir -p "$HOME/Library/LaunchAgents"
sed "s|__CRUCIBLE_ROOT__|$ROOT|g" "$SRC" > "$DEST"

# Unload first so this is a reinstall rather than a duplicate. Failure here is
# ordinary — it means it was not loaded — so its noise is discarded.
launchctl unload "$DEST" 2>/dev/null

if ! launchctl load "$DEST" 2>/tmp/cru-watchdog-load.err; then
  echo "✗ launchctl refused the job:"
  cat /tmp/cru-watchdog-load.err
  exit 1
fi

# ── proof, not optimism ──────────────────────────────────────────────────────
if launchctl list | grep -q "$LABEL"; then
  echo "✓ $LABEL is registered and runs every 15 minutes (and at login)."
  echo "  Watching: $ROOT"
  echo "  It reconciles crucible.cam against this working tree and does nothing when they agree."
  echo "  Log: .crucible-watchdog.log · deploy log: .crucible-deploy.log · state: .crucible-deploy-state"
  # The last thing that can be wrong is a plist that loaded fine and points at
  # nothing runnable. Cheap to check, and invisible otherwise.
  [ -x "$ROOT/scripts/deploy.sh" ] || echo "  ✗ but $ROOT/scripts/deploy.sh is not executable — the job will do nothing."
else
  echo "✗ launchctl accepted the load but the job is not listed. It is NOT running."
  exit 1
fi

#!/bin/bash
# Self-healing launch pipeline.
#   build → (heal up to 3× via scripts/selfHeal.ts) → launch.
# The healer uses the same proven primitives as the engine: synthesizeUniversal to
# propose patches, applyVerified+syntacticVerify as the never-regress gate. Every
# heal attempt is logged to .crucible/heal-log.jsonl.
#
# NOTE: `npm run electron` waits on the dev stack (vite :5173 + server :3001). Start
# those the usual way (npm run dev, or the launch.json crucible-vite + detached
# server) before/alongside this script — this launcher intentionally does NOT spawn
# them so it can't collide with an already-running stack.

cd "$(dirname "$0")" || exit 1

echo "🔨 Building..."
BUILD_OUT=$(npm run build 2>&1)
if [ $? -eq 0 ]; then
  echo "✅ Clean build — launching"
  npm run electron
  exit 0
fi

echo "⚠️  Build errors detected — running self-healer..."
echo "$BUILD_OUT" | npx tsx scripts/selfHeal.ts
if [ $? -eq 0 ]; then
  echo "✅ Healed — launching"
  npm run electron
else
  echo "❌ Could not auto-heal — check .crucible/heal-log.jsonl"
  exit 1
fi

#!/bin/sh
# Vite-only preview helper (path-independent). For the full stack use ./crucible-launch.sh.
cd "$(dirname "$0")" || exit 1
exec ./node_modules/.bin/vite --port "${PORT:-5180}" --strictPort

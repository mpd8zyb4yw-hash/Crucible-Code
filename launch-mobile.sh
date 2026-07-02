#!/bin/bash
# Thin shim — kept for muscle memory. The real logic lives in crucible-launch.sh.
# Binds Vite to the LAN and prints the phone URL.
cd "$(dirname "${BASH_SOURCE[0]}")" && exec ./crucible-launch.sh --mobile "$@"

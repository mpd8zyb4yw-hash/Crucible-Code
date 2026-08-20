#!/usr/bin/env bash
# One MCP tool call against the deployed façade: ./.mcp-call.sh <tool> '<json args>'
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
URL="https://crucible-evaluator-mcp.creatorbase-api.workers.dev/mcp/$(cat "$HERE/.mcp-secret")"
ARGS="${2-}"; [ -z "$ARGS" ] && ARGS='{}'
curl -s -m 180 -X POST "$URL" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$ARGS}}"

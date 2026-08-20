#!/usr/bin/env bash
#
# BRING THE EVALUATOR BRIDGE BACK UP.
#
# Two processes and no state beyond evaluator/.profile: the bridge itself, and
# the tunnel that publishes it at eval.crucible.cam. The Google sign-in lives in
# the profile directory, so a restart does NOT cost another approval — deleting
# that directory is what costs another approval.
#
#   ./evaluator/start.sh            headless, the normal case
#   ./evaluator/start.sh --headed   a visible window, for signing in
#
set -uo pipefail
cd "$(dirname "$0")/.."

HEADED=""
[ "${1:-}" = "--headed" ] && HEADED="--headed"

pkill -f 'evaluator/server.mjs' 2>/dev/null
pkill -f 'evaluator/tunnel.yml' 2>/dev/null
sleep 1

EVAL_TOKEN="$(cat evaluator/.token)" nohup node evaluator/server.mjs \
  --target https://crucible.cam $HEADED > evaluator/.server.log 2>&1 &

nohup cloudflared --config evaluator/tunnel.yml tunnel run > evaluator/.tunnel.log 2>&1 &

sleep 8
code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 \
  -H "authorization: Bearer $(cat evaluator/.token)" https://eval.crucible.cam/status)
echo "https://eval.crucible.cam/status → $code"
[ "$code" = "200" ] || { echo "not reachable yet; check evaluator/.tunnel.log"; exit 1; }

#!/bin/sh
# teardown-fly.sh — the LAST step of the $0-forever off-ramp: destroy the Fly app
# once everything it used to do has moved to the free Cloudflare Worker.
#
# This is IRREVERSIBLE: `fly apps destroy` deletes the app, its secrets (incl. the
# CLOUDFLARE_TUNNEL_CRED), and the `crucible_data` volume. So this script refuses to
# run until it has PROVEN the Worker has taken over, and even then only with --confirm.
#
# Usage:
#   sh teardown-fly.sh              # pre-flight checks only (dry run, destroys nothing)
#   sh teardown-fly.sh --confirm    # run checks, then actually destroy crucible-api
#
# Free / no-dev-account: uses only the already-installed `fly` CLI and `curl`.

set -eu

APP="crucible-api"
PROXY="${PROXY_URL:-https://proxy.crucible.cam}"   # canonical Worker origin (see wrangler.toml)
CONFIRM="${1:-}"

red()  { printf '\033[31m%s\033[0m\n' "$1"; }
grn()  { printf '\033[32m%s\033[0m\n' "$1"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$1"; }

fail() { red "✗ $1"; red "  Aborting — Fly NOT destroyed."; exit 1; }

echo "── Pre-flight: confirm the Worker has fully taken over before killing Fly ──"

# 1. fly CLI must be authenticated.
fly auth whoami >/dev/null 2>&1 || fail "fly CLI not authenticated (run: fly auth login)"
grn "✓ fly CLI authenticated as $(fly auth whoami 2>/dev/null)"

# 2. The Worker must be deployed AND have its OAuth secret set. /auth/login/google
#    returns 302 -> accounts.google.com when GOOGLE_CLIENT_ID is set, or 503 if not.
LOC=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$PROXY/auth/login/google" || echo "000")
CODE=$(echo "$LOC" | cut -d' ' -f1)
DEST=$(echo "$LOC" | cut -d' ' -f2-)
case "$CODE" in
  302) case "$DEST" in
         https://accounts.google.com/*) grn "✓ Worker OAuth live ($PROXY -> Google)";;
         *) fail "Worker /auth/login/google redirected somewhere unexpected: $DEST";;
       esac;;
  503) fail "Worker reachable but OAuth secrets unset (got 503). Run the wrangler secret puts first.";;
  000) fail "Worker not reachable at $PROXY (deploy it: wrangler deploy). Override with PROXY_URL=...";;
  *)   fail "Worker /auth/login/google returned HTTP $CODE (expected 302).";;
esac

# 3. GitHub login leg too — check the redirect DESTINATION, not just the 302 code.
GHRES=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$PROXY/auth/login/github" || echo "000")
GHCODE=$(echo "$GHRES" | cut -d' ' -f1)
GHDEST=$(echo "$GHRES" | cut -d' ' -f2-)
case "$GHCODE" in
  302) case "$GHDEST" in
         https://github.com/login/oauth/authorize*) grn "✓ Worker GitHub login live ($PROXY -> GitHub)";;
         *) fail "Worker /auth/login/github redirected somewhere unexpected: $GHDEST";;
       esac;;
  503) fail "Worker reachable but GitHub OAuth client id unset (got 503).";;
  *)   fail "Worker /auth/login/github returned HTTP $GHCODE (expected 302).";;
esac

# 4. crucible.cam (the app shell + the post-login FRONTEND_URL the worker redirects to) must
#    ALREADY be served by the Mac tunnel. Destroying Fly removes Fly's cloudflared, so if the
#    Mac isn't answering now, crucible.cam goes dark. Fly is currently suspended, so a healthy
#    response here proves the Mac — not Fly — is serving it. Fail closed otherwise.
FE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://crucible.cam/api/diag" || echo "000")
[ "$FE" = "200" ] && grn "✓ crucible.cam healthy (served by the Mac tunnel — safe to drop Fly's)" \
  || fail "crucible.cam/api/diag returned HTTP $FE — the Mac tunnel isn't serving it. Destroying Fly would take crucible.cam offline."

# 5. Show exactly what will be destroyed.
echo ""
ylw "The following Fly app will be PERMANENTLY destroyed (app + secrets + data volume):"
fly apps list 2>/dev/null | grep -E "NAME|$APP" || true
echo ""
ylw "Reminder — also verify BEFORE confirming:"
echo "  • crucible.cam now resolves to the Mac tunnel ONLY (the dual-bound tunnel hazard:"
echo "    destroying Fly removes its cloudflared, leaving the Mac as the sole origin — good,"
echo "    but it means crucible.cam is only up while the Mac is on)."
echo "  • The web frontend was rebuilt with VITE_PROXY_URL=$PROXY and redeployed."
echo "  • OAuth callback URLs ($PROXY/auth/callback/{google,github}) are registered."

if [ "$CONFIRM" != "--confirm" ]; then
  echo ""
  grn "Dry run complete — all pre-flight checks passed."
  ylw "Re-run with --confirm to actually destroy:  sh teardown-fly.sh --confirm"
  exit 0
fi

# Final human attestation. The 302 checks prove the redirect legs + that the client IDs are
# set, and step 4 proves crucible.cam is up — but NONE of that proves the OAuth callback /
# token-exchange works (that needs the client SECRETS on the Worker AND the redirect_uri
# registered byte-for-byte in the consoles). Only a real end-to-end login proves it, and the
# destroy is irreversible, so require the operator to attest it.
echo ""
ylw "The pre-flight cannot prove token exchange (callback secrets + console registration)."
ylw "Before destroying Fly you must have completed a REAL end-to-end login through $PROXY"
ylw "with BOTH Google AND GitHub, landing back signed-in on crucible.cam."
if [ "${CRUCIBLE_E2E_LOGIN_OK:-}" = "1" ]; then
  grn "✓ Attestation via CRUCIBLE_E2E_LOGIN_OK=1"
elif [ -t 0 ]; then
  printf 'Type EXACTLY "i-logged-in" to attest you did this: '
  read -r ATTEST
  [ "$ATTEST" = "i-logged-in" ] || fail "Attestation not given."
else
  fail "No TTY for attestation. Re-run with CRUCIBLE_E2E_LOGIN_OK=1, and only after a real end-to-end login."
fi

echo ""
ylw "Destroying $APP …"
fly apps destroy "$APP" --yes
grn "✓ $APP destroyed. Crucible is now $0/forever off Fly."
ylw "Optional: 'fly apps destroy crucible-code --yes' removes the empty leftover app too."

#!/bin/sh
# Start cloudflared tunnel if credentials are injected, then start the server.
# The Node process is PID 1 so Fly signals it correctly on shutdown.

if [ -n "$CLOUDFLARE_TUNNEL_CRED" ]; then
  echo "$CLOUDFLARE_TUNNEL_CRED" > /tmp/tunnel-cred.json
  cat > /tmp/cloudflared.yml << 'CFEOF'
tunnel: 7ec0a9bb-a669-43da-885b-ac246820fd5d
credentials-file: /tmp/tunnel-cred.json
ingress:
  - hostname: crucible.cam
    service: http://localhost:3001
  - service: http_status:404
CFEOF
  cloudflared tunnel --no-autoupdate --config /tmp/cloudflared.yml run &
  echo "[Tunnel] cloudflared started (PID $!)"
else
  echo "[Tunnel] CLOUDFLARE_TUNNEL_CRED not set — tunnel skipped"
fi

exec npx tsx /app/server.ts

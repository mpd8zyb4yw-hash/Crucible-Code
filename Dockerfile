FROM node:22-slim

# System deps for better-sqlite3 (native module) + curl for cloudflared download
RUN apt-get update && apt-get install -y python3 make g++ curl && rm -rf /var/lib/apt/lists/*

# Install cloudflared so the Cloudflare Tunnel runs alongside the server
RUN curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild better-sqlite3 && npm install typescript@~6.0.2 --no-save

COPY . .

# Build frontend (skip tsc — server tsconfig has known non-blocking errors)
RUN npx vite build

EXPOSE 3001

ENV NODE_ENV=production
ENV PORT=3001

# start.sh launches cloudflared (if CLOUDFLARE_TUNNEL_CRED is set) then the server
CMD ["/bin/sh", "/app/start.sh"]

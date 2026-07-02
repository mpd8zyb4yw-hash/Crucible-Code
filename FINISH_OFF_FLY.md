# Finish the off-Fly cutover — the last mile to $0-forever

Everything code-side is done. What remains are credential/console steps that can't be
scripted from here (they touch your live Cloudflare / Google / GitHub accounts). All are
**free** — no new developer account, no billing, no paid signing cert. Google reuses your
existing OAuth app; GitHub needs a second *free* OAuth App on the same account (§2 — its
one-callback-URL limit makes a true zero-downtime cutover impossible with a single app).

Canonical Worker origin (already wired in `wrangler.toml` + `teardown-fly.sh`):
**`https://proxy.crucible.cam`**

---

## ✅ Already done this session (in the repo, free tier)

| Task | State |
|---|---|
| **Cloudflare KV binding** | `CRUCIBLE_USERS` namespace + preview created and bound in `wrangler.toml` (`id=54c5ee1a…`, `preview_id=d7de46b7…`). Verified via `wrangler deploy --dry-run`. |
| **Windows build CI** | `.github/workflows/build.yml` builds the Windows `.exe` (+ mac/linux) on free GitHub runners. Unsigned (no paid cert). `package.json` `publish` now points at `mpd8zyb4yw-hash/Crucible`. |
| **Fly teardown** | `teardown-fly.sh` — safety-gated destroy; refuses to run until the Worker has provably taken over. |
| **OAuth callback origin** | Worker self-derives `redirect_uri` from its origin; callback URLs + custom-domain route set in `wrangler.toml`. |

---

## 1. Deploy the Worker with its secrets (free)

```sh
cd ~/Desktop/crucible-local
# Provider keys + JWT secret (Session A) — values from .env.local / .dev.vars:
for s in JWT_SECRET VITE_GROQ_API_KEY VITE_OPENROUTER_API_KEY VITE_GEMINI_API_KEY \
         VITE_HF_API_KEY VITE_MISTRAL_API_KEY CLOUDFLARE_API_KEY CLOUDFLARE_ACCOUNT_ID; do
  npx wrangler secret put "$s"
done
# OAuth secrets (Session B):
for s in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET; do
  npx wrangler secret put "$s"
done
npx wrangler deploy        # provisions proxy.crucible.cam (custom_domain) + the KV binding
```
> For `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, use the **second (Worker) GitHub OAuth App**
> from §2 — not the old Fly app (whose secrets must keep the live site's GitHub login alive until
> teardown). Google reuses the existing app, so its id/secret are unchanged.

## 2. Register the OAuth callback URLs (free)

The `redirect_uri` must match the Worker origin byte-for-byte.

- **Google** — multiple redirect URIs are allowed, so just **add** the new one and keep the old
  `crucible.cam` one (the live site keeps working through cutover). [console.cloud.google.com](https://console.cloud.google.com/apis/credentials)
  → OAuth 2.0 Client `841623591544-mcpst1l03ebgal3ba8blo4v9pv9qig1r…` → **Authorized redirect URIs** → add:
  ```
  https://proxy.crucible.cam/auth/callback/google
  ```
- **GitHub** — an OAuth App allows exactly **one** callback URL, and the old one
  (`https://crucible.cam/api/auth/callback/github`) differs in host *and* path, so they **cannot
  coexist on one app**. To avoid a GitHub-login outage, register a **second, free GitHub OAuth App**
  on the same account: [github.com/settings/developers](https://github.com/settings/developers) →
  **New OAuth App** → Authorization callback URL:
  ```
  https://proxy.crucible.cam/auth/callback/github
  ```
  Use this new app's id/secret for the Worker (§1). The original app `Ov23liTkB7BDDyc9wPNd` stays
  untouched, keeping the Fly site's GitHub login alive until teardown. No new account, no billing.
  *(Simpler, with a brief GitHub-only outage: reuse the single app and switch its one callback URL
  to the proxy URL only AFTER §3 deploys the new frontend.)*

Verify both legs without a browser:
```sh
curl -sI https://proxy.crucible.cam/auth/login/google | grep -i location  # -> accounts.google.com
curl -sI https://proxy.crucible.cam/auth/login/github | grep -i location  # -> github.com/login
```

## 3. Point the web frontend at the Worker, rebuild, redeploy

```sh
cp .env.production.example .env.production    # sets VITE_PROXY_URL=https://proxy.crucible.cam
npx vite build
# deploy app/ to its static host (or let the Mac tunnel serve it)
```

## 4. Tear down Fly (irreversible — script-gated)

```sh
sh teardown-fly.sh             # dry run: passes only once steps 1–3 are live
sh teardown-fly.sh --confirm   # actually destroys crucible-api (+ optionally crucible-code)
```

After this: keys proxied through the free Worker, OAuth on the Worker + KV, the desktop app
built by CI, and **$0/forever** — crucible.cam served by the Mac tunnel alone.

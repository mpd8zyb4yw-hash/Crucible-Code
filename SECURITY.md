# Crucible — Security Posture & Audit Log

This file is the **single source of truth for Crucible's security state**. It records the
current protective posture, the audit history, fixed issues, and the remaining/deferred
items with ready-to-apply patches. Future sessions: read this before touching auth, the
oracle/execution path, dependency bumps, or anything that shells out.

---

## Standing security rules (apply to all future work)

1. **Never commit real secrets.** Real credential files (`.env.local`, `.dev.vars`, and the
   generated `.crucible/jwt_secret`) are gitignored. Templates use the `.example` suffix and
   stay tracked. The `.gitignore` now blocks `**/.token`, `.env`, `.env.*`, `*.pem`, `*.key`,
   `*_rsa`, `*.p12/.pfx` at any depth (with `!*.example` negation). If you add a new secret
   file type, extend the "Secret / credential hardening" block in `.gitignore`.
2. **Any code that shells out must escape or use `execFile`/arg-arrays.** `src/CrucibleEngine`
   uses `execSync`/`exec` (a *shell*) in several places. Interpolating unescaped values into a
   shell string is command injection. Single-quote-escape (`.replace(/'/g, "'\\''")`) or pass
   an argument array. Validate identifiers (git hashes, ports, pids) against a strict regex
   before they reach a command.
3. **Never run model-generated code with real secrets or unrestricted network.** The oracle
   executes untrusted candidate code (`src/CrucibleEngine/synth/oracle.ts`). It now uses
   `sandboxEnv()` (secret-scrubbed env). Any *new* execution path for model output must do the
   same, and ideally run under `sandbox-exec` network-deny (see `/api/sandbox/run` for the
   pattern). A correctness test never needs real credentials.
4. **Keep the `/api/*` auth guard closed by default.** `app.use('/api', …)` in `server.ts`
   requires a valid `crucible_session` cookie for everything except an explicit allowlist. When
   adding an endpoint, it is authenticated unless you deliberately allowlist it — and if you
   allowlist one, justify it in a comment (the current allowlist is auth flows + LAN-only
   diagnostics/stream).
5. **CORS: reflect only trusted origins.** Never pair `credentials: true` with reflecting an
   arbitrary `Origin`. Keep the allowlist + LAN/localhost regex (see deferred item S-6).
6. **Server-only provider keys should not carry the `VITE_` prefix.** Vite inlines any
   `import.meta.env.VITE_*` referenced in client code. These keys are currently only read via
   `process.env` (server), so nothing leaks today — but the prefix is a foot-gun. New provider
   keys used only on the server must NOT be `VITE_`-prefixed.
7. **Rotating a secret:** `JWT_SECRET` is `process.env.JWT_SECRET` → `.crucible/jwt_secret`
   (random 32-byte hex, auto-created) → generated. To rotate, delete `.crucible/jwt_secret`
   and/or set a new `JWT_SECRET`, then redeploy the Worker secret (`wrangler secret put
   JWT_SECRET`) to match. Rotating invalidates all live sessions.

---

## Audit — 2026-07-23 (cont.107)

Triggered by a stale handoff doc (written cont.97b, 2026-07-19). Findings below were verified
against the real tree (`crucible-northstar-sessions`). **The doc's headline security panic was
unfounded** — see S-1.

### Fixed this session

| ID  | Severity | Issue | Fix | Commit |
|-----|----------|-------|-----|--------|
| S-1 | Low (was framed critical) | Two audit JWTs committed at `audit-traces/{p2,p4}/.token`; `.gitignore` rule `audit-traces/.token` never matched nested paths. | Both tokens **already expired 2026-07-17**; full-history grep found **no real secret** (all hits are test fixtures / `loadOrCreateJwtSecret()` at runtime). Removed the dead files; fixed the gitignore rule + broadened secret coverage. | `933a558` |
| S-2 | **High** | Oracle executes model-generated candidate code with `env: process.env` — full secrets (JWT_SECRET, provider API keys, OAuth client secrets) + network. A crafted "write me code" prompt could exfiltrate env during verification. | `sandboxEnv()` deny-lists credential-shaped env keys for both `run` (spawnSync) and `runAsync` (spawn). Verified: `synth:prove` 4/4 green. | `933a558` |
| S-3 | Medium | `checkpoint.ts` interpolates the commit `message` into a shell string unescaped (`execSync`), while paths right above it *are* escaped — command injection via agent/goal-derived messages. Rollback `git checkout ${hash}` also unvalidated. | Single-quote-escape the message; validate `hash` is `[0-9a-f]{4,40}`. Verified with an injection repro: `$(touch …)` payload is stored as inert literal, no execution. | `933a558` |
| S-4 | 2 low + 6 high | Dependency vulns (undici cluster: TLS bypass, header injection, cache poisoning, …). | `npm audit fix` (non-breaking): **20 → 12**. | `8dd0253` |
| S-6 | Medium | `cors()` reflected an arbitrary `Origin` with `credentials:true` (any site could make credentialed cross-origin calls). Mitigated by `httpOnly`+`sameSite:lax`, but real for cookieless allowlisted endpoints. | Reflect only an allowlist (`FRONTEND_URL`, `crucible.cam`) + localhost/LAN; all other origins get no ACAO. Isolated-staged around a concurrent `server.ts` edit; esbuild parse-clean. | `9fde212` |
| S-7 | Low-med | Oracle ran model-generated code with **network reachable** — a candidate could phone home / exfiltrate the scratch dir / act as an SSRF-DoS pivot (S-2 only closed env secrets). | Wrap `run`/`runAsync` in `sandbox-exec (deny network*)` on macOS; platform-guarded + `CRUCIBLE_ORACLE_NO_SANDBOX=1` escape hatch. Verified: `synth:prove` 4/4; positive control confirms network actually denied. | `59083b2` |
| S-8 | Low | `rawGet` (retrieval) could fetch a poisoned search-result URL pointing at cloud metadata / localhost / RFC-1918 → SSRF pivot. | Custom `lookup` hook (blocks hostnames resolving private; DNS-rebinding-safe) **plus** synchronous IP-literal check (Node skips lookup for IP literals — the metadata payload). Covers redirects. Verified in the real module: metadata/live-server/localhost all blocked, public still fetches; unit 15/15. | `b559219` |
| S-5 | 2 crit + 5 high (of the remaining 12) | Dev/build-time transitive vuln chains pinned by lagging parents. | `@electron/rebuild` `^3.7.1→^4.2.0` (clears `tar` CRITICAL + `@electron/node-gyp`/`cacache`/`make-fetch-happen` HIGHs) + `overrides.shell-quote ^1.10.0` (quadratic-DoS HIGH). Surgical: exactly 2 version bumps, no runtime dep changed, `--package-lock-only` (no node_modules churn). **npm audit 12 → 5.** | `df175d3` |

### Verified GOOD (no change needed — documented so future sessions don't re-audit)

- **JWT secret loading** (`server.ts:677`): env → disk → random 32-byte hex. No weak/hardcoded default. `crypto.randomBytes`, not `Math.random`.
- **Global `/api` auth guard** (`server.ts:750`): cookie required for all `/api/*` except an explicit allowlist. `/api/debug/*` is therefore **authenticated** (the handoff doc's "unauthenticated debug disclosure" is false).
- **Auth cookie** (`server.ts:1380`): `httpOnly` + `sameSite:'lax'` + `secure` in production. This is what neutralizes the CORS finding (S-6) to medium/low.
- **User-code sandbox** (`server.ts:7548`): `/api/sandbox/run` runs under `sandbox-exec` with `(deny network*)`.
- **No provider keys in the client bundle**: no `import.meta.env.VITE_*_API_KEY` refs in `app/`; no literal key material in the build.
- **Phantom-package gate** (`retrievalLayer.ts:1171`): `packageExistence()` tri-state npm check already guards fabricated package names.

### Remaining (with reason)

> S-5, S-6, S-7, S-8 were implemented + validated (`df175d3`, `9fde212`, `59083b2`,
> `b559219`). S-5's dev/build chains are cleared (12 → 5); only the runtime-ML residue and
> the operational proxy (S-9) remain.

**S-5-residual — 5 remaining vulns, all the `@xenova/transformers` runtime chain**
(`protobufjs` CRITICAL + `onnx-proto` / `onnxruntime-web` / `sharp` HIGH). **Deliberately not
changed:**
- `protobufjs` ACE requires *untrusted* protobuf input, but onnxruntime only parses **local,
  trusted** model files (the app never loads a user-supplied `.onnx`) → **not exploitable here**.
- The only offered fix is `@xenova/transformers@1.4.2` — a **major downgrade** (current `^2.17.2`)
  that would break semantic recall / vision. `protobufjs` only patches at 8.x, two majors above
  the `6.11.6` that `onnx-proto` pins — forcing it risks breaking embeddings at runtime.
- **`sharp`** is the one with a plausible (narrow) untrusted-input path (image processing);
  if vision ever processes user-supplied images, prioritize validating a `sharp`/`@xenova` bump.
- **Validate any bump in isolation (never touches the live tree):**
  ```sh
  git worktree add ../crucible-deps chore/xenova-bump && cd ../crucible-deps && npm ci
  npm i @xenova/transformers@latest    # or add overrides for protobufjs/onnx/sharp
  npm run smoke && npm run smoke:code && npm run synth:prove   # keep only if recall/vision green
  ```

**S-9 — Operational: proxy down. Root-caused; blocked on credentials only.**
- **Root cause (found this session):** `proxy.crucible.cam` returns **NXDOMAIN** — the
  Workers custom-domain binding (which `wrangler.toml`'s `custom_domain = true` auto-provisions
  on deploy) is gone, so there is no DNS record and no route. `crucible.cam` itself resolves
  (zone intact). The `000` from curl was a DNS failure, not a 5xx.
- **Fix:** `wrangler deploy` from the repo root re-provisions the custom domain + DNS + edge cert.
- **Why not done independently:** the only Cloudflare credential in the repo
  (`CLOUDFLARE_API_KEY` in `.dev.vars`/`.env.local`) is a narrowly-scoped token that
  (verified via the CF API) **has no Workers Scripts permission and sees 0 zones** — it can
  neither deploy the worker nor edit `crucible.cam` DNS. There is no `CLOUDFLARE_API_TOKEN`
  and no email for global-key auth, and interactive `wrangler login` (browser OAuth) is
  unavailable in a non-interactive shell. This is a hard permission boundary, not a code issue.
- **Unblock (one of):** run `wrangler login` in a real terminal then `wrangler deploy`; OR add
  a token with **Account · Workers Scripts · Edit** (+ **Zone · DNS · Edit** on crucible.cam)
  as `CLOUDFLARE_API_TOKEN`, after which `CLOUDFLARE_API_TOKEN=… npx wrangler deploy` is fully
  scriptable. KV binding to preserve: `CRUCIBLE_USERS` id `54c5ee1ae4a9446bb6ab5b0a0e617b98`.

---

## Note on git-history rewrite

The two committed `.token` files are **expired and contain no reusable secret** (HS256 JWTs do
not embed the signing key). A `git filter-repo` history rewrite + force-push to purge them has
**near-zero security value** and real disruption risk (breaks every other clone, and collides
with active parallel sessions). It is therefore **not recommended**. If done anyway for hygiene,
do it only when no parallel session is active and coordinate a re-clone.

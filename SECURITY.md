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

### Verified GOOD (no change needed — documented so future sessions don't re-audit)

- **JWT secret loading** (`server.ts:677`): env → disk → random 32-byte hex. No weak/hardcoded default. `crypto.randomBytes`, not `Math.random`.
- **Global `/api` auth guard** (`server.ts:750`): cookie required for all `/api/*` except an explicit allowlist. `/api/debug/*` is therefore **authenticated** (the handoff doc's "unauthenticated debug disclosure" is false).
- **Auth cookie** (`server.ts:1380`): `httpOnly` + `sameSite:'lax'` + `secure` in production. This is what neutralizes the CORS finding (S-6) to medium/low.
- **User-code sandbox** (`server.ts:7548`): `/api/sandbox/run` runs under `sandbox-exec` with `(deny network*)`.
- **No provider keys in the client bundle**: no `import.meta.env.VITE_*_API_KEY` refs in `app/`; no literal key material in the build.
- **Phantom-package gate** (`retrievalLayer.ts:1171`): `packageExistence()` tri-state npm check already guards fabricated package names.

### Deferred / recommended (NOT applied — reason noted)

**S-5 — 12 remaining dependency vulns (2 critical, 10 high).** All require **major** bumps and
are **build/dev-time, not runtime-exploitable with untrusted input**:
- `tar` (CRITICAL) → `@electron/rebuild@4.2.0` — arbitrary file write during tarball extraction: **electron packaging / native rebuild only**.
- `protobufjs` (CRITICAL) → `@xenova/transformers@1.4.2` — ACE requires *untrusted* protobuf; here transitive under onnxruntime loading **local** models. A major downgrade of the embeddings lib risks breaking semantic recall / vision.
- `shell-quote` (HIGH) → `concurrently@9` — DoS in a **dev-only** script runner.
- **Why deferred:** the fix is `npm audit fix --force` (major bumps). Per the handoff doc's own guidance, run it **in a dedicated branch, then `npm run smoke && npm run smoke:code && npm run synth:prove && npm run prove:all`** to confirm nothing broke. Do NOT run it while a server is live and a parallel session is editing.
- **Command:** `git switch -c chore/dep-majors && npm audit fix --force && <run benches> && npm audit --json`.

**S-6 — Permissive CORS (medium, patch ready).** `server.ts:632` reflects an arbitrary
`Origin` with `credentials: true`. Mitigated today by `sameSite:'lax'` + `httpOnly` + the
global auth guard (the cookie is not sent on cross-site fetch), so it is **not a live exploit**
for authenticated endpoints — but it is a real misconfiguration and matters for the cookieless
allowlisted endpoints (`/api/screen-stream` etc.). **Not applied because `server.ts` is the
known merge-contention file and a parallel session was editing it live during this audit.**
Apply when `server.ts` is quiescent:

```js
// server.ts ~632 — replace the cors({...}) block
app.use(cors({
  origin: (origin, cb) => {
    // Reflect only trusted origins; never reflect an arbitrary origin with credentials:true.
    // LAN + localhost preserved for phone/dev access.
    const allow = [process.env.FRONTEND_URL, 'https://crucible.cam',
                   'http://localhost:5173', 'http://localhost:3001'].filter(Boolean)
    if (!origin) return cb(null, true)                       // same-origin / curl / native app
    if (allow.includes(origin) ||
        /^https?:\/\/(localhost|127\.0\.0\.1|(192\.168|10|172\.(1[6-9]|2\d|3[01]))\.)/.test(origin))
      return cb(null, origin)
    return cb(null, false)
  },
  credentials: true,
}))
```

**S-7 — Oracle network egress not isolated (low-medium).** `sandboxEnv()` (S-2) closes secret
*exfiltration via env*, but the candidate can still open sockets. For full isolation, wrap the
oracle's `spawn`/`spawnSync` in `sandbox-exec -p '(version 1)(allow default)(deny network*)'`
on macOS (the `/api/sandbox/run` pattern). Deferred because a correct implementation must not
break `npx tsx` module resolution; validate against `synth:prove` + `smoke:code`.

**S-8 — SSRF hardening on outbound fetch (low).** `retrievalLayer.ts:569` `fetch(url)` and
`modelDownloadManager.ts:155` (`redirect:'follow'`) fetch URLs derived from search results /
registries (not raw user input, so no direct sink). For cloud deploys (Fly.io), add a guard
that resolves the host and **rejects private / link-local ranges** (`169.254.169.254`,
`10.*`, `192.168.*`, `127.*`, `::1`) before fetching, and re-checks after each redirect — to
prevent a poisoned search result from reaching cloud metadata.

**S-9 — Operational: proxy down.** `proxy.crucible.cam` returns connection-refused (edge-level;
`crucible.cam` is 200). Local `wrangler` auth is expired, so it can't be diagnosed headlessly.
Requires an interactive `wrangler login` (or `CLOUDFLARE_API_TOKEN`), then
`wrangler deployments list` / `wrangler tail` / verify the `CRUCIBLE_USERS` KV binding
(`wrangler.toml` id `54c5ee1ae4a9446bb6ab5b0a0e617b98`). OAuth + provider routing are down on
the deployed surface until fixed. Not a code vulnerability.

---

## Note on git-history rewrite

The two committed `.token` files are **expired and contain no reusable secret** (HS256 JWTs do
not embed the signing key). A `git filter-repo` history rewrite + force-push to purge them has
**near-zero security value** and real disruption risk (breaks every other clone, and collides
with active parallel sessions). It is therefore **not recommended**. If done anyway for hygiene,
do it only when no parallel session is active and coordinate a re-clone.

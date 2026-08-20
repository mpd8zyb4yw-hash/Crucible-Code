# Crucible evaluator bridge

A small authenticated HTTP surface over one real browser driving the real
deployed Crucible at `https://crucible.cam`. It exists so an external agent can
use the product the way a person does — every operation ends in a pointer or key
event inside the rendered page. Nothing calls a server action directly.

Development-only and disposable: delete `evaluator/` and nothing else changes.

    ChatGPT → https://eval.crucible.cam → bridge on the Mac → Playwright → real Crucible

## Running it

    ./evaluator/start.sh              # headless — the normal case
    node evaluator/login.mjs          # one interactive Google sign-in, if the session is lost
    EVAL_TOKEN=$(cat evaluator/.token) EVAL_URL=https://eval.crucible.cam \
      node evaluator/journey.mjs      # the end-to-end proof

The Google session lives in `evaluator/.profile` and survives restarts. Deleting
that directory costs another interactive sign-in.

## Authentication

One bearer token, in `evaluator/.token`, gitignored. Every request needs
`Authorization: Bearer <token>`; anything else gets a 401.

## Operations

| Operation | Notes |
|---|---|
| `GET /status` | alive, target, whether Crucible is signed in |
| `POST /cold_start` | destroys client storage, keeps the account session (`{keepSession:false}` drops cookies too) |
| `GET /observe` | url, surface, openApp, visible text, controls, errors, recent API calls |
| `GET /screenshot` | PNG (`?fullPage=1`, `?base64=1`) |
| `POST /tap` | `{target}` |
| `POST /type` | `{target?, text, submit?}` — real keystrokes |
| `POST /press` | `{key}` |
| `POST /swipe` | `{direction}` — pages the Home deck |
| `POST /back` | in-app back; refuses to leave Crucible |
| `POST /reload` / `POST /open` / `POST /wait` / `POST /restart` | |
| `GET /visible_elements` | controls without page text |
| `GET /console_errors`, `GET /network_failures`, `GET /current_url` | |
| `GET /inspect` | build, signed-in, loading, API calls with status and latency, blocked writes, external attempts |
| `POST /probe_write` | proves the read-only guard by making the page attempt `POST /api/act` |

## Targeting

There are no evaluator-only test ids. `target` resolves in this order:

1. a raw CSS selector, if it starts with `[`, `.` or `#`
2. the app's own attributes, case-insensitively — `data-role`, `data-card`,
   `data-object`, `data-frame`, `data-open`, `data-deck`
3. accessible name (`aria-label`, `title`, text, **placeholder**), exact then partial
4. visible text, shortest match

Useful ones on Home: `calendar`, `mail`, `composer`, `composer-send`,
`surface-close`, `deck-overview`, `Ask Crucible anything`, `expand`.

A tap dispatches at `elementFromPoint` of the resolved element's centre, not at
the element itself — Crucible puts `data-card` on a wrapper and the `onClick` on
a child, so dispatching at the match hits nothing. This is also the more faithful
simulation: it is where a finger lands.

## Write safety

Read-only. These are refused at the socket with a 403 and recorded:

    POST/PUT/PATCH/DELETE  /api/act
    POST                   /api/actions/:id/undo
    POST                   /api/google/disconnect
    PUT                    /api/sources

`/api/act` is the only path that reaches Google with a mutation — every send,
calendar create/delete and archive goes through `perform()` behind it. The
composer's own action table (`server/say.ts`) can only sync, track, build a pane
or research, none of which leave the account. The controls stay live, so the UI
takes its real path and the failure is observable; nothing leaves the account.

## Known limits

- Two processes started by hand; they do not survive a reboot. `start.sh` restores
  them without a new sign-in.
- Non-http schemes (Brave, YouTube app links) cannot be launched from automated
  Chromium. The attempted URL and scheme are recorded in `/inspect.externalAttempts`
  instead, which is enough to tell which destination Crucible chose.
- One browser, one page: requests are serialised.

## MCP façade

`mcp/` is a second Worker (`crucible-evaluator-mcp`) that speaks MCP over
streamable HTTP and forwards each tool to this same bridge. It holds no browser
and adds no authority: the read-only guard, target scoping and serialisation all
stay here.

    ChatGPT tool call → MCP Worker → https://eval.crucible.cam → Playwright → crucible.cam

    https://crucible-evaluator-mcp.creatorbase-api.workers.dev/mcp/<MCP_SECRET>

Two credentials: `MCP_SECRET` (the unguessable path — a connector cannot send a
header) and `EVAL_TOKEN` (the bearer, held only as a Worker secret). Both are
`wrangler secret put`; the local copy of the outside one is `evaluator/.mcp-secret`,
gitignored. Rotate by putting a new value. Tools: observe, screenshot, tap, type,
press, swipe, back, reload, cold_start, wait, inspect, visible_elements,
console_errors, network_failures, current_url, probe_write — no shell, no
free-form URL, nothing outside that table.

    ./evaluator/.mcp-call.sh observe
    ./evaluator/.mcp-call.sh tap '{"target":"calendar"}'

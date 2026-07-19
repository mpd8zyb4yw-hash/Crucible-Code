# Crucible Assistant Layer — Spec (2026-07-19, design-only, not yet built)

> Goal: evolve Crucible from "chat + agent runs" into a genuine personal assistant —
> app/API integrations like Codex's agent mode, standing automations (daily/repeated
> tasks, summaries), and a Fortune-500-grade UI organized around that capability.
> Everything below honors the doctrine: local-first, propose→verify, no premium models.

## 1. The three pillars

### A. Connections (app + API integrations)
A first-class registry of external capabilities the agent can use, each one a typed
tool bundle with its own auth, health state, and permission scope.

- **Tier 1 — already latent in the repo:** Google (OAuth tokens already stored:
  `google-tokens-*.json`) → Gmail read/summarize, Calendar read/create; GitHub CLI
  (the `/api/integrations` drawer exists, 4 tools registered); local Mac control
  (open_app/type_text/AppleScript — already live).
- **Tier 2 — API connectors:** generic REST connector (user pastes base URL + key,
  declares 1-5 endpoints; each becomes a registry tool with a JSON-schema arg spec);
  webhooks out (notify Slack/Discord/ntfy on run completion).
- **Tier 3 — MCP client:** speak Model Context Protocol so any MCP server the user
  runs (filesystem, Postgres, Puppeteer…) mounts as a tool bundle. This is the
  Codex-style "app integration" endgame and mostly protocol plumbing, not model work.

Server shape: `src/CrucibleEngine/connections/` — `registry.ts` (id, name, authState,
tools[], scopes, lastHealthCheck), `oauth.ts`, `restConnector.ts`, `mcpClient.ts`.
Every connector tool call flows through the EXISTING agent tool loop — no second
execution path — and is journaled per run (which run touched which connection).

### B. Automations (standing tasks)
An automation = **trigger + brief + delivery**, persisted in `.crucible/automations.json`,
executed by the existing agent loop under a scheduler.

- Triggers: cron-style schedule ("weekdays 8am"), interval ("every 2h"), event
  (connection webhook, file-drop in a watched folder), and one-shot ("tomorrow 9am").
- Brief: same free-text brief Mission Control takes today, plus pinned connections
  and a variable context block (date, last-run summary — enables diffing runs).
- Delivery: inline card in a dedicated "Digest" feed, push notification (webpush is
  already wired), or a file artifact.
- Flagship recipes shipped as templates (not hardcoded profiles — the planner still
  infers the workflow): Morning Brief (calendar + inbox summary + yesterday's run
  results), Inbox Triage, Weekly Folder Cleanup, Site-change Watch.
- Every automation run is a normal agent session: journaled, replayable, visible in
  Mission Control with a "recurring" badge; failures surface in the Digest, silence
  is never assumed success (doctrine: honest abstention).

Scheduler: one `setInterval`-driven tick in server.ts (survives restart by
recomputing nextRun from the stored spec), max 1 concurrent automation run, per-
automation backoff on repeated failure.

### C. Memory & context (what makes it feel personal)
The assistant needs durable user context: preferences ("summaries in bullet form"),
standing facts ("my partner's birthday"), and per-connection defaults. Reuse the
existing entity-graph/causal-memory stores; add a user-visible "What Crucible knows"
panel with per-item delete — trust requires inspectability.

## 2. UI — organized around the assistant (the Fortune-500 pass)

The polish problem is structural, not cosmetic: the app currently presents as
"chat with drawers". The redesign presents as a command product with four fixed
territories, in line with the existing mission-control aesthetic (no profiles,
context decides the workflow):

1. **Rail (64px, always):** the collapsed icon rail that already exists becomes the
   permanent primary nav — Home, Chats, Mission Control, Automations, Connections,
   Settings. The expanded history column appears only within Chats. One nav system,
   no drawers-overlapping-settings.
2. **Home = the assistant surface** (replaces the bare splash after first run):
   today's Digest cards (automation results, running agents, upcoming triggers) above
   the composer. The splash's identity moment stays for first-run only.
3. **Automations page:** table of standing tasks — name, trigger, last run status,
   next run, delivery — with a run-now button and a two-pane create flow (brief left,
   plain-language trigger/delivery right, live "next 3 runs" preview).
4. **Connections page:** card grid — connector, auth state, scopes, last used, tool
   count — replacing the IntegrationsBinder drawer.

Polish system (applies everywhere, mostly token work on the existing `src/ui.tsx`):
one 4px spacing scale, one type ramp (12/13/15/20/28), tabular numerals for all
metrics, 150-200ms eased transitions only, status communicated by a single dot+label
vocabulary (running/ok/failed/idle) reused in every territory, topbar chips promoted
to real tabs. No emojis, no external imagery (existing rules).

## 3. Build order (each step ships something usable)

1. **Automations MVP** — scheduler + JSON store + Automations page; recipes limited
   to what current tools can do (file cleanup, site-watch via web tools, daily
   agent-run summary). No new auth needed. ~1 session.
2. **Connections registry + Google** — formalize the latent Google tokens into a
   Connections page with Gmail/Calendar read tools → unlocks Morning Brief, the
   flagship demo. ~1-2 sessions.
3. **UI territory refactor** — rail-first nav, Home/Digest, kill remaining drawers.
   ~1 session, mostly moving existing components.
4. **REST connector + webhooks out**, then **MCP client** last (biggest payoff,
   biggest surface).

Non-goals: no cloud sync, no multi-user, no paid-API dependence anywhere in the
loop (webpush + OAuth are free infrastructure, not model calls).

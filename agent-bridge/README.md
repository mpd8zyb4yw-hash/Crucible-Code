# Crucible Agent Bridge

A typed, repo-scoped RPC system for a second coding agent, whose transport
happens to be Gmail. ChatGPT sends a JSON command from the phone; the daemon
on the Mac executes one allowlisted operation and replies in the same thread.

It is **not** an email-triggered shell. No inbound message can execute
anything, no free text ever reaches an executor, and no shell command string
exists anywhere in the code.

    ChatGPT (Gmail connector)
      → command email, account to itself
        → daemon polls its own SENT mailbox
          → eligibility → schema → operation allowlist
            → deterministic executor (repo / git / tests / evaluator / Claude)
              → result email in the same thread

## Architecture

| Piece | What it does |
|---|---|
| `daemon.mjs` | poll loop, one command at a time, idempotency ledger, replies |
| `security.mjs` | eligibility gate, schema, path confinement, redaction |
| `executor.mjs` | the operation table — name to function, nothing else |
| `gmail.mjs` | token refresh, SENT-scoped queries, MIME send with attachments |
| `ops/repo.mjs` | inspection and confined mutation, checkpoints, patches |
| `ops/exec.mjs` | argv-only process execution and package-task wrappers |
| `ops/service.mjs` | the five known dev services, by name only |
| `ops/browser.mjs` | pass-through to the existing `evaluator/` |
| `ops/claude.mjs` | optional, asynchronous Claude Code delegation |

## Command envelope

Plain-text JSON, sent from the account to itself, subject beginning
`[CRUCIBLE-AGENT]`:

```json
{
  "protocol": 1,
  "bridge_id": "cb-...",
  "job_id": "audit-calendar-001",
  "step_id": "004",
  "op": "repo.read",
  "args": { "path": "server/deck.ts", "start_line": 1, "end_line": 220 }
}
```

The reply carries subject `[CRUCIBLE-AGENT RESULT] <bridge-id> <job> #<step>`
and echoes `job_id` and `step_id`. Results larger than ~24 KB become a JSON
attachment with a summary in the body; screenshots are always PNG attachments.

Unknown envelope fields are rejected. `args` is validated per operation.

## Authorization — the three gates

A message executes only if every one of these holds:

1. **Eligibility.** Gmail's own API reports the message carrying the `SENT`
   system label, addressed to the bridge account, with the exact command
   subject prefix, and the authenticated profile is the configured owner. The
   `From:` header is never consulted — it is forgeable; SENT membership by
   ordinary mail delivery is not.
2. **Schema.** The exact `bridge_id`, an operation enum, and typed arguments.
   Unknown envelope fields are rejected. There is no operation that takes
   prose, and no model sits between the transport and this check.
3. **Idempotency.** The Gmail message id is recorded in
   `.agent-bridge/processed.json` *before* execution, so a crash or a repeated
   delivery cannot run a mutation twice.

### Why there is no shared secret

An earlier version required a 256-bit capability in every envelope. It was
removed, for two reasons. It bought nothing: the analysis below shows that
anyone able to place a message in this account's SENT mailbox can also read
the READY email that carried the secret, so the boundary was already Gmail
account authority with or without it. And it broke the transport outright —
ChatGPT's Gmail tool refuses to send a message containing a credential, so no
command could be transmitted at all. **A command therefore contains no secret
of any kind.** A stale `capability` field is tolerated and ignored.

### What this does and does not protect against

**Does:** any externally delivered email. A forged `From:`, a bridge-shaped
subject from an outsider, and a prompt-injection message are all refused at
gate 1 without being parsed — this is proven by `selftest-security.mjs`, which
plants real messages in the mailbox rather than mocking them.

**Does not:** someone who already holds full Gmail API access to this account.
Gmail applies `SENT` to a message imported via the API by the account owner.
So **bridge authority equals Gmail account authority.**
That is inherent to using Gmail as the transport — every channel ChatGPT can
use, an account-compromiser can use too — and it is the reason revocation is
one command (below) rather than a policy.

## Safety boundaries

- **Filesystem.** Every path is canonicalized and must resolve inside the repo
  root, checked again after symlink resolution. `..`, absolute paths and `~`
  are refused.
- **Execution.** `process.run` takes a program plus an argv array and spawns
  with `shell: false`. The program must be on the allowlist in `config.mjs`.
  No `sh -c`, no `bash -c`, no `eval`, ever.
- **Mutation.** Every write, patch and delete takes a checkpoint first and
  returns its id; `repo.restore` undoes it. Writes accept `expected_sha256`
  and are refused with `STALE_FILE` if the file moved under them, so a
  concurrent Claude Code edit is never silently clobbered.
- **Git.** The bridge never commits, resets, cleans or rewrites history.
- **External accounts.** The browser evaluator stays read-only. Repo mutation
  is authorized; sending mail or writing to Calendar is not, and
  `browser.probe_write` proves the guard is still in place.
- **Secrets.** Everything leaving the machine is redacted, by known value and
  by shape: OAuth tokens, API keys, JWTs, cookies and `.env` values.

## Operations

`bridge.status` · `repo.status` `repo.list` `repo.read` `repo.search`
`repo.changed_files` `repo.diff` `repo.diff_file` `repo.write`
`repo.apply_patch` `repo.create` `repo.delete` `repo.mkdir` `repo.restore` ·
`git.show` `git.log` · `process.run` `test.run` `build.run` `typecheck.run` ·
`service.list` `service.start` `service.stop` `service.restart` `service.logs` ·
`browser.cold_start` `browser.observe` `browser.screenshot` `browser.tap`
`browser.type` `browser.press` `browser.swipe` `browser.back` `browser.reload`
`browser.wait` `browser.inspect` `browser.visible_elements`
`browser.console_errors` `browser.network_failures` `browser.current_url`
`browser.probe_write` · `app.inspect` `journal.latest` · `claude.start`
`claude.status` `claude.result` `claude.cancel`

`app.inspect` merges observe + inspect + console errors + network failures into
one record, to save round trips. `search` uses `git grep`: this machine has no
`rg` binary.

## Claude Code delegation

Optional and asynchronous — `claude.start` returns a task id immediately, so a
long run never blocks polling. Output goes to `.agent-bridge/claude/<id>.out`;
only a bounded tail and the final message travel by mail. Give it a concise
brief (objective, files, constraints, acceptance test); the bridge deliberately
does not prepend project context, because doing so every time is what makes
delegation expensive.

The bridge is fully useful without it. Reading, searching, editing, patching,
testing and browser operation are all ordinary ChatGPT work.

## Daemon lifecycle

    ./agent-bridge/start.sh     # nohup, survives terminal close
    ./agent-bridge/status.sh
    ./agent-bridge/stop.sh
    node agent-bridge/ready.mjs # re-send the READY handshake

Auto-start after login is a user LaunchAgent, `cam.crucible.agent-bridge`,
installed by `install-launchagent.sh` and removed by `uninstall.sh`. It runs as
the user, needs no root, logs to `.agent-bridge/logs/`, and opens no network
listener — the daemon only makes outbound Gmail requests.

### Recovery after reboot

With the LaunchAgent installed, nothing to do. Without it, run `start.sh`. The
processed-message ledger persists, so no command replays.

## Gmail labels and queries

Commands and results are labelled `Crucible-Agent/Commands` and
`Crucible-Agent/Results` under `Crucible-Agent`, and removed from `INBOX` so
machine traffic stays out of the normal inbox. Nothing is trashed
automatically. Labels are organizational only — **the `SENT` system label is
the eligibility check**, and a label alone never authenticates anything.

The poller's only query is:

    in:sent to:<self> subject:"[CRUCIBLE-AGENT]" newer_than:2d

There is no code path that reads the Inbox.

## Tests

    node agent-bridge/selftest-security.mjs   # 22 assertions, real planted messages
    node agent-bridge/selftest-e2e.mjs        # full loop over real Gmail

## Disable or remove

    ./agent-bridge/stop.sh                 # stop accepting commands now
    ./agent-bridge/uninstall.sh            # remove daemon, LaunchAgent, secrets
    ./agent-bridge/uninstall.sh --keep-state   # ...but keep journal and checkpoints

Uninstall leaves the Crucible repo and all user data untouched. To revoke the
Google access itself, visit <https://myaccount.google.com/permissions>.

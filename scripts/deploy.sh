#!/usr/bin/env bash
#
# BUILD AND SHIP TO CRUCIBLE.CAM, AND KEEP IT SHIPPED.
#
# crucible.cam is the copy he actually uses, from his phone. A change that only
# exists on this laptop is a change that does not exist. The standing
# instruction is that the deployed copy must never drift from the code — so this
# is not "a deploy command", it is a RECONCILER: it compares what is live with
# what is here and closes the gap.
#
# It reconciles ONLY THE RELEASE BRANCH, and only from a clean tree. It used to
# reconcile whatever happened to be on disk, which made every unfinished edit a
# deployment; see "WHAT MAY REACH PRODUCTION" below, which is the rule that now
# governs every path into this file.
#
# It runs from three places, and all three are the same code path:
#   · a launchd agent, every fifteen minutes              (scripts/watchdog.plist)
#   · by hand, deliberately                               (scripts/deploy.sh release)
#   · a Stop hook, if one is installed — none is by default, because "the
#     session ended" is not evidence that the work is finished.
#
# ── WHAT WENT WRONG BEFORE, WHICH IS WHY THIS FILE IS SHAPED LIKE THIS ───────
#
# Every one of these was observed, not imagined, and each closed a way for the
# live site to sit silently behind the code:
#
#   1. TWO RUNS AT ONCE. The Stop hook fired while a hand-run deploy was going.
#      Both run the test suite, the suite binds fixed ports, so they fought each
#      other and NEITHER got as far as uploading. The log gained two bare
#      headers and the site stayed a build behind for an hour. → a lock.
#
#   2. THE STAMP COULD MASK REAL DRIFT. The fingerprint check ran FIRST and
#      exited before asking what was live. That is correct only if nothing can
#      change the live site except this script — and things can: a rollback, a
#      half-propagated deploy, an upload that reported success and did not take.
#      → the live check now runs FIRST and can force a deploy on its own. The
#      stamp is an optimisation and may never suppress a real divergence.
#
#   3. A FLAKY HARNESS READ AS A BROKEN PRODUCT. The screenshot suite failed
#      with ECONNREFUSED because a leftover fixture server had been killed
#      underneath it, and this script announced "an application surface changed
#      type with its data" — a false and frightening verdict about a socket. →
#      ports are cleaned first, the suite gets one retry, and the message says
#      what actually happened.
#
#   4. A KILLED RUN LEFT NO VERDICT. The log ended on a header with nothing
#      under it, which looks exactly like a run still in progress. → a trap
#      writes a terminal line whatever happens, including on SIGTERM.
#
#   5. IT ONLY RAN WHEN A SESSION ENDED. Nobody is always in a session. → the
#      watchdog, which is what makes "always, forever, with nobody here" true.
#
# ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
#
#   It does not touch git. Shipping to the edge and publishing source are
#   different acts with different audiences, and only the first was asked for.
#
#   It does not ship a failing build. "Always up to date" does not outrank
#   "always working": a Calendar that has quietly stopped being a Calendar is
#   worse than a Calendar that is a day old. A real failure BLOCKS and says so
#   on every subsequent run, so it is loud rather than forgotten.
#
#   It does not do the expensive work when there is nothing to do. The common
#   case — nothing changed, live matches — costs one HTTP request.
#
set -uo pipefail
cd "$(dirname "$0")/.."

STAMP=".crucible-deploy-stamp"
LOG=".crucible-deploy.log"
STATE=".crucible-deploy-state"
LOCK=".crucible-deploy.lock"
SITE="https://crucible.cam"

# THE FIXTURE PORT ONLY, deliberately — not vite's 5174.
#
# A leftover fixture server is the one that poisons a run: `fixture.mjs` builds
# its scenarios once at import, so an old copy serves data that no longer
# matches the fixture file and the suite fails describing a bug that does not
# exist. Vite is the opposite — it reloads from source, so the harness REUSES a
# running one, and killing it here would mean a background job silently
# shutting down his dev server every fifteen minutes.
HARNESS_PORTS="3002"

MODE="${1:-auto}"   # auto | release | force | check

say() { printf '%s\n' "$*" >> "$LOG"; }
emit() { printf '{"systemMessage":%s}\n' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')"; }

# ── WHAT MAY REACH PRODUCTION, AND FROM WHERE ────────────────────────────────
#
# This script used to ship whatever was on disk, from any branch, committed or
# not, on a fifteen-minute timer. That is a fine reconciler for a tree that only
# ever holds finished work and a live hazard for one that does not: an edit
# saved mid-thought is on his phone within the quarter hour, and development,
# review and production stop being three different things.
#
# So the modes are now separated by what each is ALLOWED to ship:
#
#   auto     the watchdog and the Stop hook. UNATTENDED — nobody is watching,
#            so it may only ever ship the designated release branch with a
#            clean tree. In any other state it does nothing, silently.
#   release  a deliberate act by a person who means it. Any branch, still
#            never a dirty tree.
#   force    for a person debugging the deploy itself. Still never a dirty tree.
#   check    read-only. Always permitted.
#
# The dirty-tree rule has no exception in any mode. A deploy that cannot be
# named by a commit cannot be reviewed, reverted or reproduced, and the
# question "what is live" stops having an answer.
#
# The release branch is data, not a constant, so moving production to a
# different branch does not require editing this file:
#     echo my-branch > .crucible-release-branch

RELEASE_BRANCH="$(cat .crucible-release-branch 2>/dev/null || echo 'crucible-groundtruth')"

# DEPLOYABLE PATHS ONLY — the same set the fingerprint uses. A scratch note or
# a stray log in the tree is not a reason to refuse to ship, and a rule that
# fires on irrelevant dirt is one that gets worked around.
tree_dirty() {
  [ -n "$(git status --porcelain -- src server worker public index.html wrangler.jsonc package.json 2>/dev/null)" ]
}

if [ "$MODE" != "check" ]; then
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"

  if tree_dirty; then
    say "── $(date '+%Y-%m-%d %H:%M:%S') ──"
    say "refused: uncommitted deployable changes in the working tree (mode=$MODE)"
    # Silent for auto, which fires on a timer and would otherwise narrate every
    # tick of every working day. A person who typed the command hears about it.
    [ "$MODE" = "auto" ] || emit "Deploy refused: the working tree has uncommitted changes. Commit them first."
    exit 0
  fi

  if [ "$MODE" = "auto" ] && [ "$branch" != "$RELEASE_BRANCH" ]; then
    # SILENT ON PURPOSE. While any branch work is in progress this is the
    # normal state, several times an hour; a message here would train him to
    # ignore the one that matters. `scripts/deploy.sh check` still answers.
    exit 0
  fi
fi

# ── one at a time ────────────────────────────────────────────────────────────
#
# `mkdir` is the lock, because it is atomic on every filesystem this will ever
# see and needs no coreutils that macOS does not ship. The PID inside is what
# makes the lock recoverable: a run killed mid-flight would otherwise wedge the
# deploy permanently, which is a far worse failure than the collision the lock
# exists to prevent.
if ! mkdir "$LOCK" 2>/dev/null; then
  held="$(cat "$LOCK/pid" 2>/dev/null || echo '')"
  if [ -n "$held" ] && kill -0 "$held" 2>/dev/null; then
    # A real run is in progress. Silent on purpose: the watchdog fires on a
    # timer and would otherwise narrate every overlap.
    exit 0
  fi
  say "── reclaimed a stale lock (pid ${held:-unknown} is gone) ──"
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || exit 0
fi
printf '%s' "$$" > "$LOCK/pid"

verdict="interrupted"
finish() {
  rm -rf "$LOCK"
  # THE LOG ALWAYS ENDS ON A VERDICT. A header with nothing under it is
  # indistinguishable from a run still going, and that ambiguity is what let a
  # dead deploy look like a busy one for an hour.
  if [ "$verdict" = "interrupted" ]; then
    say "verdict: INTERRUPTED — killed before it could finish; the next run retries"
    printf 'interrupted %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" > "$STATE"
  fi
}
trap finish EXIT
trap 'exit 143' TERM INT

# ── the last hole in "with nobody here" ──────────────────────────────────────
#
# `emit` writes a systemMessage, which only ever reaches a Claude session. With
# nobody in one — which is the whole point of the watchdog — a BLOCKED deploy
# leaves its evidence in a log file and a state file that nobody reads, and the
# live site sits behind the code indefinitely while everything looks quiet.
# Self-healing where it can and silent where it cannot is not "always up to
# date"; it is the same failure with better bookkeeping.
#
# So a state CHANGE rings the Mac's own notification centre. On the transition
# only: this runs on a timer, and a notification that repeats forever is one he
# turns off, after which it is worth less than nothing.
notify() {
  osascript -e "display notification \"$2\" with title \"Crucible · $1\"" >/dev/null 2>&1
  return 0
}

done_with() {
  verdict="$1"
  # `cat | cut`, not `cut < "$STATE"`. The redirect is performed by the SHELL,
  # before cut exists, so cut's own 2>/dev/null cannot suppress its failure —
  # and a missing state file is the NORMAL case on a first run. It printed
  # "No such file or directory" into the watchdog log every time.
  local was="$(cat "$STATE" 2>/dev/null | cut -d' ' -f1)"
  say "verdict: $1"
  printf '%s %s\n' "$1" "$(date '+%Y-%m-%d %H:%M:%S')" > "$STATE"
  [ "$was" = "$1" ] && return 0   # unchanged: say nothing

  case "$1" in
    current|deployed)
      # Only worth announcing as a RECOVERY — "it is fine" on every tick is
      # noise, and "it is fine again after being broken" is news.
      case "$was" in
        ''|current|deployed) ;;
        *) notify "back in sync" "crucible.cam is serving the current build again." ;;
      esac
      ;;
    blocked-tests)
      notify "deploy blocked" "The test suite failed twice. crucible.cam is stuck on the previous build." ;;
    blocked-build)
      notify "deploy blocked" "The build failed. crucible.cam is now BEHIND the code." ;;
    blocked-upload)
      notify "deploy failed" "wrangler could not ship it — check your Cloudflare login." ;;
    did-not-take|app-behind|unverified-worker|unverified-app)
      notify "deploy unverified" "It uploaded, but crucible.cam is not serving it yet." ;;
    unreadable-source)
      notify "deploy skipped" "Could not read the source tree." ;;
  esac
  return 0
}

# ── a phase that cannot hang forever ─────────────────────────────────────────
#
# macOS has no `timeout(1)`. A hung `npm test` — a browser that never launches,
# a port that never frees — would otherwise hold the lock until the machine
# reboots, and the watchdog would skip every run in the meantime believing a
# real deploy was in progress. Output is captured to a file rather than a
# variable so a killed phase still leaves its partial log behind.
run_phase() {
  local limit="$1" out="$2"; shift 2
  "$@" > "$out" 2>&1 &
  local pid=$! waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$limit" ]; then
      kill -TERM "$pid" 2>/dev/null
      sleep 2
      kill -KILL "$pid" 2>/dev/null
      return 124
    fi
    sleep 2
    waited=$((waited + 2))
  done
  wait "$pid"
}

# Leftover listeners from a killed run. This is the single most common cause of
# a suite that fails for reasons that have nothing to do with the code — a stale
# fixture server serves the PREVIOUS build's data and the assertions fail
# describing a bug that does not exist.
free_ports() {
  for p in $HARNESS_PORTS; do
    # ORPHANS ONLY — the same rule `scripts/shots.mjs` uses, and for the same
    # reason it was written there. A listening socket is INHERITED BY CHILDREN,
    # so `lsof -ti :3002` names the harness that spawned the fixture as well as
    # the fixture. Killing everything on the port therefore killed a concurrent
    # run's `shots.mjs` outright — observed, with `Killed: 9` in this very log,
    # blocking a deploy over a test suite that was passing.
    #
    # A fixture whose parent is gone (reparented to pid 1) is left over from a
    # killed run and owned by nobody. One with a living parent belongs to a run
    # in progress and is left completely alone.
    for pid in $(lsof -ti ":$p" -sTCP:LISTEN 2>/dev/null); do
      line="$(ps -o ppid=,command= -p "$pid" 2>/dev/null)" || continue
      case "$line" in *fixture.mjs*) ;; *) continue ;; esac
      [ "$(printf '%s' "$line" | awk '{print $1}')" = "1" ] || continue
      kill -9 "$pid" 2>/dev/null
    done
  done
  return 0
}

# Every request is cache-busted with a unique query string AND no-cache headers.
# Not belt-and-braces: an edge-cached /api/version answered with the PREVIOUS
# deploy's hash during a session, which made a stale build look verified — the
# worst failure this check has, because it reports false confidence.
nocache() {
  curl -fsS --max-time 10 -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
    "$1?cb=$$-$(date +%s)-$RANDOM" 2>/dev/null
}

live_build() { nocache "$SITE/api/version" | sed -n 's/.*"tree":"\([^"]*\)".*/\1/p'; }

# Everything that ends up in the deploy, and nothing that does not.
fingerprint() {
  # server/build.ts is generated by scripts/stamp.mjs and carries a fresh
  # timestamp every build, so counting it would make every deploy look like a
  # change and defeat the whole point of this check.
  find src server worker public index.html wrangler.jsonc package.json \
    -type f -not -path '*/node_modules/*' -not -path 'server/build.ts' -print0 2>/dev/null \
    | LC_ALL=C sort -z \
    | xargs -0 shasum 2>/dev/null \
    | shasum | cut -d' ' -f1
}

now="$(fingerprint)"
if [ -z "$now" ]; then
  emit "Deploy skipped: could not read the source tree."
  done_with "unreadable-source"
  exit 0
fi

# ── DECIDE, AND ASK PRODUCTION FIRST ─────────────────────────────────────────
#
# The order here is the correctness fix. The fingerprint alone answers "did the
# source change since the last successful deploy", which is NOT the question —
# the question is "is the live site running this code". Those differ whenever
# anything other than a successful run of this script has touched production,
# and when they differ the fingerprint says everything is fine.
#
# So the live build is read first, on every run, and any mismatch forces a
# deploy no matter what the stamp says. One HTTP request; the common case is
# still nearly free.
live="$(live_build)"
stamped="$(cat "$STAMP" 2>/dev/null || echo '')"
expected_now="$(sed -n 's/.*"tree": "\([^"]*\)".*/\1/p' server/build.ts 2>/dev/null | head -1)"

reason=""
if [ "$MODE" = "force" ] || [ "$MODE" = "release" ]; then
  reason="deliberate ${MODE}"
elif [ -z "$live" ]; then
  # Unreachable is not "up to date". It may be a flat network, and it may be a
  # Worker that will not start — and the second is a site that is DOWN, which
  # is the one state where doing nothing is unforgivable.
  reason="crucible.cam did not answer"
elif [ "$stamped" != "$now" ]; then
  reason="the source changed"
elif [ -n "$expected_now" ] && [ "$live" != "$expected_now" ]; then
  reason="crucible.cam is serving ${live}, not the build here"
fi

if [ "$MODE" = "check" ]; then
  if [ -n "$reason" ]; then
    say "── $(date '+%Y-%m-%d %H:%M:%S') check ──"
    say "check: OUT OF DATE — $reason"
    done_with "out-of-date"
    emit "crucible.cam is out of date: ${reason}."
  else
    done_with "current"
  fi
  exit 0
fi

if [ -z "$reason" ]; then
  done_with "current"
  exit 0
fi

say "── $(date '+%Y-%m-%d %H:%M:%S') ──"
say "deploying because: $reason"

# ── the product contract, before the build ───────────────────────────────────
#
# Shipping a Calendar that has quietly stopped being a Calendar is worse than
# not shipping. The suite gates the deploy — and gets ONE retry, with the ports
# cleaned first, because the harness drives a real browser against two real
# servers and a socket that was not ready is not a regression. A genuine
# contract break fails both times; a flake almost never does.
free_ports
tests_ok=""
for attempt in 1 2; do
  # CAPTURED BEFORE ANY `if`, and that is not style. `if run_phase …; then` and
  # then reading `$?` in the failure branch always reports 0: bash has already
  # replaced the condition's status with the if-statement's own. So every failed
  # attempt announced "exited 0", which is the same species of lying diagnostic
  # as the "an application surface changed type" message this file replaced.
  run_phase 900 /tmp/crucible-test.$$ npm test
  rc=$?
  if [ "$rc" = "0" ]; then
    tests_ok="yes"
    break
  fi
  say "$(cat /tmp/crucible-test.$$ 2>/dev/null)"
  if [ "$rc" = "124" ]; then
    say "test attempt $attempt: TIMED OUT after 15 minutes"
  else
    say "test attempt $attempt: exited $rc"
  fi
  [ "$attempt" = "2" ] && break
  say "cleaning harness ports and retrying once"
  free_ports
  sleep 3
done
rm -f /tmp/crucible-test.$$

if [ -z "$tests_ok" ]; then
  # NAMED HONESTLY. This used to say "an application surface changed type with
  # its data" for every possible failure, including a refused socket — a
  # specific, alarming claim about something the script had not established.
  emit "Deploy BLOCKED: the test suite failed twice. crucible.cam is still on the previous build. See crucible-local/.crucible-deploy.log."
  done_with "blocked-tests"
  exit 0
fi

if ! run_phase 600 /tmp/crucible-build.$$ npm run build; then
  say "$(cat /tmp/crucible-build.$$ 2>/dev/null)"
  rm -f /tmp/crucible-build.$$
  # Loud, because a failed build means the deployed copy is now BEHIND the code
  # and will stay behind until someone notices. Silence here is the failure.
  emit "Deploy BLOCKED: the build failed. See crucible-local/.crucible-deploy.log."
  done_with "blocked-build"
  exit 0
fi
say "$(cat /tmp/crucible-build.$$)"
rm -f /tmp/crucible-build.$$

if ! run_phase 600 /tmp/crucible-ship.$$ npx wrangler deploy; then
  say "$(cat /tmp/crucible-ship.$$ 2>/dev/null)"
  rm -f /tmp/crucible-ship.$$
  emit "Deploy FAILED: wrangler could not ship it. See crucible-local/.crucible-deploy.log."
  done_with "blocked-upload"
  exit 0
fi
out="$(cat /tmp/crucible-ship.$$)"
say "$out"
rm -f /tmp/crucible-ship.$$

# ── proof, not optimism ──────────────────────────────────────────────────────
#
# A successful build is not a deploy, and a successful deploy command is not
# proof that clients receive the new code. Until this check existed, "Deployed
# to crucible.cam" meant "wrangler exited 0" — which is why a session was spent
# debugging a renderer without first establishing which renderer was live.
expected="$(sed -n 's/.*"tree": "\([^"]*\)".*/\1/p' server/build.ts | head -1)"
live=""
for _ in 1 2 3 4 5 6; do
  live="$(live_build)"
  [ -n "$live" ] && [ "$live" = "$expected" ] && break
  sleep 3   # edge propagation, not failure — retry before crying wolf
done

if [ -z "$live" ]; then
  say "post-deploy check: /api/version unreachable"
  emit "Deployed, but crucible.cam did not answer /api/version — treat the live build as UNVERIFIED."
  done_with "unverified-worker"
  exit 0
fi
if [ "$live" != "$expected" ]; then
  say "post-deploy check: live=$live expected=$expected"
  # Deliberately NOT stamped: an unverified deploy must retry next run.
  emit "Deploy did NOT take: crucible.cam is serving build ${live}, expected ${expected}."
  done_with "did-not-take"
  exit 0
fi
say "post-deploy check: live=$live (matches)"

# ── the half the Worker cannot vouch for ─────────────────────────────────────
#
# /api/version is answered by the Worker. The APP is static assets, served and
# cached on a completely different path, so "the Worker is new" and "the phone
# downloads new code" are separate claims — and it is the second one that
# decides whether a UI change exists. `scripts/stamp.mjs` puts the same tree
# hash into the client bundle (main.tsx → window.__cruBuild), so the bundle a
# browser actually receives can be checked for it directly.
#
# RETRIED, because the Worker answers with the new hash immediately while the
# edge may still be handing out the previous index.html. A verification step
# that cries wolf gets ignored, which costs more than having no check at all.
entry=""
carries=""
for _ in 1 2 3 4 5 6; do
  html="$(nocache "$SITE/")"
  entry="$(printf '%s' "$html" | sed -n 's/.*<script[^>]*src="\([^"]*\.js\)".*/\1/p' | head -1)"
  if [ -n "$entry" ]; then
    case "$entry" in
      /*) url="${SITE}${entry}" ;;
      ./*) url="${SITE}/${entry#./}" ;;
      *) url="$entry" ;;
    esac
    if nocache "$url" | grep -q "$expected"; then carries="yes"; break; fi
  fi
  sleep 4   # edge propagation of the HTML, which lags the Worker
done

if [ -z "$entry" ]; then
  say "asset check: no module script found in the served HTML"
  emit "Deployed and the Worker is ${live}, but the served HTML had no entry bundle — the APP is UNVERIFIED."
  done_with "unverified-app"
  exit 0
fi
if [ -z "$carries" ]; then
  say "asset check: $entry does not carry build $expected"
  # Not stamped: the browser is still being served old code, which is exactly
  # the state that wastes a session debugging a fix that did ship.
  emit "Deploy did NOT reach the app: crucible.cam still serves a bundle without build ${expected}."
  done_with "app-behind"
  exit 0
fi
say "asset check: $entry carries $expected"

# Only stamped after a deploy that actually succeeded AND was verified live, so
# a failure retries on the next run rather than being remembered as done.
printf '%s' "$now" > "$STAMP"
version=$(printf '%s' "$out" | sed -n 's/.*Current Version ID: \(.*\)/\1/p' | tail -1)
done_with "deployed"
emit "Deployed to crucible.cam${version:+ (version ${version})}."

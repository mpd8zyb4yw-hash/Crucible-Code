# Crucible — Open Problems & Next Build Priorities

> This document is a handoff for the next engineering session.
> Read ROADMAP.md first for full architectural context.
> These are the gaps that matter most, in priority order.
>
> **STANDING RULE (added 2026-07-03, keep this at the top forever):** the section immediately
> below — CURRENT STATE — is the only part of this file guaranteed to be current. It must be
> REPLACED (not appended to) at the end of every session, before that session ends. Everything
> under "SESSION LOG" further down is a dated archive: useful for history/rationale, but NOT to
> be treated as the current open-items list. This rule exists because a stale, pre-session-N
> snapshot of this file has already been fed as live context to a later session at least once
> (2026-07-03) — the fix is a summary block that gets overwritten, not just more appending.
> If you are reading this file and it does NOT have a CURRENT STATE section immediately below,
> or that section's "last updated" commit/date looks old relative to `git log -1`, treat it as
> untrustworthy and re-derive open items from the SESSION LOG archive and a live repro instead.

---

## CURRENT STATE (last updated 2026-07-09, cont. 56 — NORTH STAR reset: Verification-Guided Reasoning is now the thesis)

**Read [`DOCTRINE.md`](./DOCTRINE.md) before anything else.** It supersedes all older framing.

**The reframe (this session):** After an audit, the project's true north star was made explicit and
wired into all top-level literature: **correctness comes from the LOOP, not the oracle.** An
unreliable ~3B on-device model + a sound deterministic verifier + search = a system more reliable
than the model. We do NOT need more parameters (8GB Mac → ~3B ANE model is the permanent, correct
ceiling). We do NOT ship memorized/preloaded answers (answer-specific critics like the clock-arith
splicer are now classified as debt to delete, not progress). The model only PROPOSES; deterministic
ground truth certifies; the loop explores/prunes/backtracks/abstains.

**Shipped this session:**
- **`DOCTRINE.md`** — the authoritative north-star doc. All future sessions anchor here.
- **`src/CrucibleEngine/reasoning/`** — the reference implementation (VGR):
  - `types.ts` (Candidate/Verdict/Proposer/Verifier/TaskSpec/SearchResult),
  - `search.ts` (deterministic propose→verify→backtrack **beam engine** — model never touches control flow),
  - `codeVerifier.ts` (**executes** candidates vs acceptance cases → high-information actual-vs-expected feedback; zero model),
  - `codeProposer.ts` (the ONLY place the model lives; threads prior-failure feedback into the next guess),
  - `solve.ts` (`solveCodeTask()` public entry), `README.md` (module literature).
- **`npm run vgr:bench`** — 11/11 green. Proves: single-shot ships a wrong answer, the loop rejects it
  via execution and certifies the correct one, a non-converging proposer ABSTAINS, spec extraction's
  consensus filter drops model-contradicted cases, a single USER example forms a trustworthy spec, and
  the LIVE on-device FM solves novel tasks through the loop.
- **LIVE-WIRED + PROVEN on real `/api/chat` traffic (behind `CRUCIBLE_VGR=1`, default off):** fired a
  real coding request against the running server → `VGR-certified src/slugify.ts (1 executed case passed,
  no external model)`; the emitted file behaviorally correct (`slugify("Hello, World!")==="hello-world"`).
  Inserted in the synth-miss branch (server.ts ~2926): when deterministic synth (L0/L1) misses, VGR
  proposes-verifies-certifies before the legacy unverified model loop.
- **Spec extraction shipped** — `specExtractor.ts`: harvests USER-stated `f(x)===y` examples as GOLD
  ground truth (trusted, no consensus) + model-proposed cases behind a cross-sample consensus filter.
  Gold user examples are the certification gate; model cases are advisory only (a wrong model-invented
  case must never make a solvable spec unsatisfiable — the vote-bias trap DOCTRINE.md warns about, hit
  live on `initials` and fixed).
- **Real bug fixed:** `codeVerifier` now transpiles TS→JS (esbuild) before executing — the FM emits
  TypeScript, which raw `node` can't run, so every candidate was failing at load regardless of correctness.
- Docs re-pointed: `CLAUDE.md`, `ROADMAP.md` lead with the north star → DOCTRINE.md.
- **VGR is now DEFAULT-ON (commit 96a5237)** — `CRUCIBLE_VGR !== '0'`; runs after synth L0/L1 miss, ships
  only certified code, falls through on abstain. Verified firing with no env flag. Interactive budget 8 calls.
- **Semantic-thrash detection (codeProposer, 96a5237):** the FM makes the SAME logical error with
  cosmetically-different code (live: `.join(/\s+/)` — regex-as-separator → "fox/\s+/brown…"), invisible to
  fingerprint-dedup. Now a recurring failure-SIGNAL triggers a pointed "you're stuck, fix THIS line" hint +
  higher temperature. reverseWords (which anchored on this) now solves.

**FM daemon contention — FIXED (cont.56, commit ee589fc).** Was the top blocker: live VGR exhausted on
`initials` (solves in 3 calls unloaded) because the single-session daemon, hit concurrently by
background work, returned empty responses that burned the search's patience budget. Two fixes:
(a) `fmQueue.ts` — a concurrency-1 priority queue in front of the daemon (interactive=HIGH, pipeline/
background=NORMAL); every daemon call site routed through it; `/api/diag.fmQueue` shows depth (observed
maxDepth 11 under load). (b) `search.ts` — null/empty proposals are retried on a separate bounded budget,
never charged to the reasoning/patience budget. Result: `initials` now certifies LIVE in 1 call. bench 12/12.

**Latency — PARTLY ADDRESSED (cont.56, commit a205213).** Foreground gate on fmQueue: /api/chat marks
itself foreground; FM-heavy background schedulers (improvement daemon tick, keepalive warmup) skip while
a request is live. Live `titleCase` certified in 41s; peak FM queue depth dropped 11→5 under load.
Residual: a background call ALREADY in-flight when the request arrives can still block it once (the queue
can't preempt in-flight); mitigate by giving background local FM calls a short timeout (they use
LOCAL_FM_TIMEOUT_MS, up to 600s in strict). 41s is still slow for interactive — the multi-call serial
search is inherently latency-heavy on one ANE session.

**Spec sourcing — DONE (cont.56, 4860796 + 940bdb7):** VGR ground-truth priority is now explicit —
(1) USER examples (gold; harvested via VGR regex UNIONED with synth/derive extractSpecExamples),
(2) GENERAL PROPERTY (new `propertyVerifier.ts` reuses `derive.ts derivePropertyTests`: sort/codec/
validator/transform families, executed in the codeVerifier harness), (3) model-consensus cases (last
resort). No-example tasks now certify: `sortAsc` → 5 sort properties → `arr.sort((a,b)=>a-b)`. bench 15/15.

**Property coverage widened (cont.56, 416a3d5 + e129726):** a model-free triage showed nearly every
common no-example task fell to the bias-prone model-consensus path. Added VGR-side `SUPP_FAMILIES` in
propertyVerifier.ts — factorial/fibonacci/gcd/isPrime/capitalize/sum/reverse/chunk — certified by
RECURRENCE / REFERENCE-DERIVATION / INVOLUTION general properties, NOT in the shared synth path (zero
prove:all risk), each tightly name-gated against the collision class. bench 21/21.

**Model-consensus fallback ROBUSTIFIED (cont.56, 9fdbf55):** `recoverFromPoisonedCase` in solve.ts — when
the model-consensus search exhausts, if ≥2 independent impls unanimously fail the SAME single case (pass
all others), that CASE is dropped (cross-derivation agreement > one model-invented value) and a candidate
is re-certified against the cleaned set. Strictly gated (≥3 cases, ≥2 agreeing, winner must pass the rest);
never ships code failing a trusted case; no model calls. bench 24/24.

**THE NEXT LEVER (highest priority — this is where capability now comes from):**
1. **Multi-file specs.** VGR still emits ONE `src/<entry>.ts` for a single function. Extend to tasks that
   span files / multiple exports (the semantic index + synth repo-context already model this). Until then
   VGR only handles single-function requests; larger asks fall through to the legacy loop. THE mission gap.
2. **Widen property families further** (parsers, numeric min/max, stateful classes) — same recurrence/
   reference-derivation pattern in `SUPP_FAMILIES` (propertyVerifier.ts).
3. **Kill the memorized-answer critics.** Audit `answer/verify.ts` (clock-arith splicer, phrasing
   correctors) and `synthDriver` regex gates; replace any that patch a *specific* answer with a
   *general property* verifier, or delete them. They are doctrine violations.
4. **Sample-efficiency pass (continued):** semantic-thrash detection landed (96a5237); next add minimized
   counterexamples in `codeVerifier` signals, and for reasoning tasks an independent deterministic
   derivation that OVERRIDES the K-sample vote (replaces vote-counting, which amplifies model bias).
5. **Collapse the two agent stacks.** The orphaned capabilityRouter/decompositionDag/nodeExecutor
   stack should either become the VGR-shaped live path or be deleted. Maintaining dead "proven" code
   is why `prove:all` is green while the product underperforms.

**Prior answer-engine work (cont. 54-55)** — Stages 1-3 (classify → grounding → depth-scaled prompt →
deterministic critics → repair/abstain; K=5 self-consistency) remains live. Reframed under the doctrine:
its *general* critics (arithmetic re-derivation) are doctrine-aligned; its *answer-specific* correctors
(clock phrasing) are the debt called out in lever #3. The deterministic elapsed-time solver noted last
session is still worth building — but as a VERIFIER that overrides the vote, per the doctrine.

Everything below is PRIOR state, kept for history only.

---

## PRIOR STATE (cont. 37 — MULTI-TURN CONTEXT FIX. The user reported
that real chat is "dumb as fuck / misaligned instantly even on simple coherent prompts." Root-caused
LIVE (minted-JWT curl, not a boot screenshot): the offline conversational brain threw away
conversation history entirely — `solveNonCodeTurn(message)` got only the current message, so every
turn was answered in isolation and follow-ups hallucinated (e.g. a nonsensical refusal to recall the
user's favorite language). The client already SENT `history`; the server just dropped it. prove:all
is all single-shot so it stayed green while real multi-turn chat was broken — trust real chat over
the suites.

**cont. 37 — what shipped (tsc-clean server+app, all live-verified via /api/chat on :3001):**
1. `src/CrucibleEngine/agent/fmReact.ts`: new `ConvTurn` + `historyToMessages()`; `fmDirectAnswer`
   and `fmReact` now prepend prior turns as alternating chat messages.
2. `src/CrucibleEngine/agent/synthDriver.ts`: `solveNonCodeTurn(goal, projectPath?, history?)` threads
   history into the FM ReAct + direct tiers; a back-reference guard makes research-shaped follow-ups
   ("what is ITS population?") skip the history-blind research DAG and use the FM tiers instead.
3. `server.ts`: passes `history.slice(-6)` to `solveNonCodeTurn`; new `isContextDependent` (has
   history AND back-reference regex) forces triageTier='full' (so short follow-ups don't collapse to
   the history-blind simple-triage single call) AND bypasses both the exact + semantic response caches
   (message-keyed → would serve a stale answer from a different conversation).
   Verified: name recall, pronoun resolution (Rust vs Go), research follow-ups (Japan pop/capital),
   and standalone prompts all coherent. See [[crucible-multiturn-context-fix]].

**cont.37 second slice — runaway-repetition fix (committed 8d95e13):** Apple's FM has no
repetition-penalty knob, so open-ended prompts sometimes loop ("### Example 10, 11, 12…") to the
token ceiling. Added `stripRunawayRepetition()` in `fmReact.ts` (deterministic: cuts at the 3rd
occurrence of a digit-normalized block signature, drops dangling trailing headings, falls back to
original if the trim would gut the answer). Applied to `fmDirectAnswer`. Unit-verified 3286→603 ch
on the real signature; normal answers untouched. NOT yet applied to `fmReact`'s FINAL_ANSWER output
(lower risk there) — extend if runaway shows up in tool-loop answers.

**Still open after cont.37 (next priorities):**
- Research DAG occasionally self-contradicts on standalone factual Qs ("Paris is not the capital of
  France. The capital is Paris."). Could NOT reproduce in isolation this session — the DAG returned
  clean answers on repeated tries, so it's nondeterministic (source-snippet dependent). Left as a
  watch item; repro with several runs of `solveNonCodeTurn("what is the capital of France?")`.
- DAG answer FORMAT is verbose report chrome ("[CORROBORATED · 74% confidence…] *Sources: …*") even
  for conversational questions that reach the full tier — feels robotic vs a plain sentence. Consider
  a conversational post-format that drops the evidence scaffold unless the user asked for sources.
- Conversational latency is 12-17s for simple answers — worth profiling (research DAG + FM tiers).
- Everything below this block is the PRIOR (cont.36c) state, kept for history only.

---

## PRIOR — CURRENT STATE (last updated 2026-07-06, cont. 36c — FULL v3 CHAT REBUILD after the user
rejected cont.36's wrap-only slice as superficial ("didn't hit half the features"). This
continuation REBUILT the chat surface for real and fixed the actual ensemble-default leak,
which was SERVER-side. All verified live in the browser against a real running backend with
a minted JWT — screenshots of the logged-in UI, real queries answered, this is NOT the
boot-to-auth-screen verification ceiling of prior sessions.)

**cont.36c — what actually shipped (all tsc-clean, live-verified):**
1. **THE ensemble-default bug was server-side and is now structurally fixed.** server.ts's
   `/api/chat` had `mode = 'quorum'` as the DESTRUCTURING DEFAULT, and `mode:'code'`
   conversational turns were explicitly EXCLUDED from the offline-brain route (the old gate
   said `mode !== 'code'`), so ordinary chat fell through to the external multi-model
   pipeline regardless of the client's local default. Fix: (a) default is now `mode = 'code'`;
   (b) new per-request `requestOffline` lever right after body destructuring — ANY
   non-'quorum' request behaves as `CRUCIBLE_OFFLINE=strict` for its entire lifetime (all 5
   in-handler env reads now read `requestOffline`), making the external pipeline structurally
   unreachable without the explicit ensemble confirm + BYOK keys; (c) the offline-conv-brain
   gate now INCLUDES mode 'code'. Live-verified: 4 real queries in mode:code all answered
   on-device (one even with cited sources from the local research DAG), zero external
   fan-out. Also gated the CLIENT predictive pre-warm (App.tsx handleInput) on
   mode==='quorum' — typing was warming external Groq/OpenRouter models even in local mode.
2. **Old topbar DELETED, everything is left-rail now.** The 340-line topbar block (binder
   icon cluster + hamburger menu + Google-services menu) is gone. New slim in-chat header:
   Crucible wordmark + ON-DEVICE/ENSEMBLE badge + live elapsed/stage while working + New
   chat. The binders (History/Tasks/Integrations/Library/SelfRepair/SelfPatcher + governance
   trigger) moved into Settings → System section (SettingsTabView `advanced` prop). The old
   menu's dead items (API Keys/Pipeline Config/Model Roster "coming soon" alerts, About,
   Google-services status) were dropped entirely — Google status has no UI home now, flag if
   missed.
3. **MoltenPour is REAL now** — `src/MoltenPour.tsx`, verbatim canvas port of the reference
   (vessel + tilt-loop + molten stream + dual-edge border fill + top-down cool sweep),
   driven by round state via a new `PourWrap` (App.tsx) + `liveRoundId` state (only the
   round streamed live THIS session animates — restored history never replays the pour).
   The live round's card now mounts IMMEDIATELY on send (empty shell, `reserveTop` headroom)
   so the vessel visibly tilt-loops during 'thinking' — screenshot-verified live.
   `PourRing.tsx` is now DEAD CODE (unused, still on disk) — delete or keep as reference.
4. **Reply cards are clean per v3**: local replies = plain glass card + copy/feedback +
   `CRUCIBLE · ON-DEVICE` footer; ALL ensemble chrome (model chips, "consensus" label,
   attribution, the entire shows-its-work process trail with its "N models · X% confident"
   chips) now renders ONLY when `round.models.length > 0` (i.e. an actual ensemble run).
   Screenshot-verified: the old "0 models · 0% confident / SHOWS ITS WORK" junk is gone
   from local replies.
5. **Composer rebuilt to the reference**: crucible glyph + textarea + round send/stop
   (molten orange while working) in row 1; Ensemble pill + honest status line ("0 external
   calls" / "armed — will ask before any fan-out") in row 2. The ugly "+ KEY" pill is gone;
   with no keys the pill routes to the Settings tab. The per-query ensemble confirm and the
   no-keys prompt are now INLINE CARDS above the composer (reference style), not modals —
   `EnsembleKeyModal`/`EnsembleConfirm`/`EnsemblePill` in ensemble.tsx are now unused by
   App.tsx (dead exports, still on disk).
6. **Mode-machine purge**: `MODE_META` deleted; conversation-restore no longer adopts a
   stored 'quorum' mode (both restore sites); `classifyMode` was already gone. `mode` state
   survives internally ('code' default) but the ONLY write paths are the Ensemble pill and
   the confirm-card handlers.
7. **How this was live-verified (reusable recipe):** backend restarted onto current code
   (killed the pre-edit process on 3001 first — same stale-port class as the Electron fix
   earlier this session), vite preview + minted JWT (per [[crucible-local-auth-testing]])
   set as a browser cookie via preview_eval (cookies ignore ports, so a localhost cookie
   reaches :3001) — then drove the REAL logged-in UI: sent 4 queries, watched answers
   register, screenshotted the thinking-vessel animation and the clean cards. This bypasses
   the OAuth wall that capped every prior session's verification.

**Known rough edges left (small, listed so they aren't re-derived):**
- The pouring/cooling border phases weren't visually captured (local FM answered in one
  chunk after a long thinking phase; screenshots caught thinking-vessel only). The
  finishing-floor (1350ms) + cool floor (1000ms) guarantee visibility; if the user reports
  no border glow, debug MoltenPour's phase mapping in PourWrap first.
- `/api/prewarm` is still ungated server-side (client no longer calls it in local mode).
- Server-wide background external traffic still exists OUTSIDE /api/chat (free-model Hunter
  probing, ModelRefresh) — visible in the server log on boot. Product decision needed:
  those run on the bundled env key. Not chat-triggered.
- Dead files: PourRing.tsx, plus ensemble.tsx's EnsemblePill/EnsembleKeyModal/
  EnsembleConfirm exports.
- The Electron app: user must fully relaunch Crucible.app to get this server code (the
  electron.cjs stale-port fix from earlier today will clear any leftover 3001 process).

## PRIOR (cont. 36 first slice — superseded in part by 36c above): BUILD-BREAK FIX, Electron
stale-port fix, AND the v3 left-rail tab shell ported from a reference implementation. A new design
handoff (`Crucible UI redesign/v3/HANDOFF - Claude Code implementation brief.md` +
`Crucible v3.dc.html`, both untracked) superseded/clarified v2's ensemble UX. Discovered
mid-session: `git log` showed an UNDOCUMENTED commit `c9db65f` ("Update engine, UI, and
checkpoints...", 2026-07-06 07:02, after cont.35b's own commits) that left the working tree
with `npx tsc --noEmit -p tsconfig.app.json` FAILING — `App.tsx` imported `EnsemblePill` from
`./ensemble` but `ensemble.tsx` only exported the old `ModeBar`. Fixed first, before any new
feature work. `c9db65f` also added `SelfPatcherBinder.tsx` + `CrucibleEngine/selfPatcher.ts`,
unrelated to the UI redesign and not otherwise investigated — worth a look if unfamiliar.

**Also this session: root-caused the user's report that the Electron app "wasn't picking up
backend changes"** — a manually-started detached `tsx server.ts` from the PRIOR DAY was still
squatting on port 3001, so the app's own freshly-spawned server crashed silently with
EADDRINUSE and the window opened against the stale process instead. Killed it and hardened
`electron.cjs` (`spawnBackend()` now kills any prior 3001 occupant before binding, every
launch). Full detail in [[crucible-run-commands]].

**Then: the user pointed at a REFERENCE implementation repo** —
`https://github.com/mpd8zyb4yw-hash/Crucible-Code` (a from-scratch small reference app a design
handoff produced, NOT this project's real backend) — cloned to
`~/crucible-local/crucible-v3-reference` (sibling folder, untracked by this repo) and read in
full: `src/state/store.ts`+`types.ts` (zustand shape), `src/styles/tokens.css` (design tokens),
`src/components/NavRail.tsx`, `chat/{ChatView,Composer,MoltenPour}.tsx`,
`agents/AgentsView.tsx`, `history/HistoryView.tsx`, `settings/SettingsView.tsx`,
`shared/BackgroundBlobs.tsx`, and the mock `CrucibleEngine/{localModel,ensemble}.ts` (these
last two are explicitly-labeled zero-network stand-ins for a real backend — did NOT port them,
kept this app's real `/api/chat` streaming + tool/agent path).

**Ported into the REAL app this session (new `tab` state + 4 new files):**
- `src/NavRail.tsx` — the 56px left glass rail, near-verbatim from the reference (Chat/Agents/
  History/Settings icon buttons + wordmark).
- `src/AgentsTabView.tsx` — full-page Agents tab: the reference's 5 prebuilt-workflow cards
  (Vibe Code/Search Web/Deep Research/Smoke Test/Decide For Me), each wired to `onBuild` →
  real `send()` with a task-specific prompt (not the reference's mock `draftAgent`), plus the
  REAL skill/tool catalog (`GET /api/library/skills` + `/tools`, same data LibraryBinder's
  drawer already showed) rendered as a searchable grid below the cards.
- `src/HistoryTabView.tsx` — full-page History tab, same `GET /api/conversations` data source
  as the existing topbar `HistoryBinder` dropdown, day-bucketed list, click-to-restore (reuses
  the exact restore logic that lived inline for `HistoryBinder`'s `onRestore`).
- `src/SettingsTabView.tsx` — full-page Settings tab: the blank-slate BYOK key list promoted
  out of the composer-pill `EnsembleKeyModal` into its own tab, same underlying `ensemble`
  state/provider-auto-detection from `ensemble.tsx` (cont.36 build-fix work), just a full page
  instead of a modal.
- `src/App.tsx`: added `const [tab, setTab] = useState<'chat'|'agents'|'history'|'settings'>
  ('chat')`; wrapped the root render in a new flex row
  (`<NavRail/>` + a column div) and gated the ENTIRE pre-existing chat body (topbar, message
  feed, composer, all the topbar drawers — Library/SelfRepair/Integrations/Tasks/SelfPatcher)
  behind `{tab === 'chat' && <>...</>}` — a pure wrap at the two boundary points (right after
  `<style>`, right before the root's final closing div), no interior content touched, so the
  existing Chat-tab functionality is provably unchanged. `tsc --noEmit` clean; app boots with
  zero console errors in the preview (still auth-gated past that point — see the recurring
  verification-ceiling note below).

**Deliberately NOT done / left for next session (scope calls, not oversights):**
- The reference's `MoltenPour.tsx` canvas port was READ in full but NOT swapped in for the
  existing `PourRing.tsx` — cross-checked the two against each other and `PourRing.tsx` already
  implements the same phase model (idle→pouring→done, real-stream-driven, same
  `POUR_MIN_MS`/`COOL_MIN_MS` floors, top-center spout, dual-half-path border reveal, top-down
  cool sweep) via a different code path (dashed-stroke technique vs the reference's manual
  polyline stroke-by-arc-length). Functionally equivalent as far as a code read can tell; a
  literal byte-for-byte canvas port was judged not worth the regression risk this session. If a
  future session wants the exact reference visual (mottled-noise `moltenColor` formula vs
  `PourRing`'s hue-drift gradient), that's the remaining gap — not a missing feature.
- `tokens.css` was READ but deliberately NOT imported — its `:root` block defines `--bg`/
  `--text`/`--accent` etc. that COLLIDE by name with `src/index.css`'s pre-existing (differently
  valued, light/dark-mode) CSS vars, which other legacy components may depend on. The v3
  redesign already uses literal hex values inline (not CSS vars) throughout App.tsx/ensemble.tsx/
  the new tab views, and those literals already match the tokens.css values (`#101016`,
  `#e4e4ee`, `#7c7cf8`, `#4db89e`, etc.) — so the design system IS applied, just not via a
  shared stylesheet. Importing tokens.css for real would need renaming its vars first.
- Agents/History/Settings tabs are NEW, purpose-built full-page views — NOT the existing
  drawer components (`LibraryBinder`/`HistoryBinder`/`SelfRepairBinder`) repurposed. Those
  drawers are unconverted and still live, unchanged, inside the Chat tab's topbar button
  cluster (per the original brief's "keep existing structure/tools intact"). This means there's
  now SOME overlap (e.g. skill/tool browsing exists both in the Agents tab and the Library
  drawer) — worth deciding next session whether to fold the drawers into the new tabs or keep
  both.
- `SelfRepairBinder`/`SelfPatcherBinder`/`IntegrationsBinder`/`TasksBinder` have no tab-level
  home yet — they're still only reachable via the Chat tab's topbar icons.

**Cont. 36 (this session):**
1. **Fixed the build break** — added `EnsemblePill` to `src/ensemble.tsx` (a plain single
   toggle button; the old `ModeBar`'s Code/Search pills are gone for good, matching App.tsx's
   own comment "mode picker UI removed (v3)"). `tsc --noEmit` clean on `tsconfig.app.json`
   again; confirmed via `preview_start` (vite) — app boots to the (OAuth-gated) auth screen
   with zero console errors, same verification ceiling as cont.35b since the chat view itself
   still requires a real Google/GitHub login.
2. **Implemented the v3 handoff's BYOK key list** (`EnsembleKeyModal` in `src/ensemble.tsx`):
   replaced the old fixed 6-provider form (`BYOK_PROVIDERS`, always showing Mistral/Gemini/etc.
   input boxes) with a blank-slate, freely-named list — user types any name + pastes any key,
   `+ Add key`/`Remove` per row, stored as `NamedKey[]` in localStorage
   (`crucible_byok_named_keys`). Provider is auto-detected from the pasted token's own prefix
   (`detectKeyProvider()`: `sk-or-`→openrouter, `gsk_`→groq, `AIza`→gemini, `sk-`→openai,
   unrecognized → stored but flagged "not dispatchable yet" in the row). This was a judgment
   call reconciling the v3 spec ("no pre-baked provider fields... name freely") with the
   server's actual per-provider dispatch (`modelRegistry.resolveProviderKey`) — no code comment
   needed re-litigation per the handoff's own "make the closest reasonable call" instruction.
   **Caveat carried over from cont.35b, still true:** only `openrouter` is actually wired
   server-side (`server.ts` reads `resolveProviderKey('openrouter')` in exactly 2 places); a
   key that auto-detects as groq/gemini/openai is stored and shown correctly but the server
   won't use it yet — extending the SDK-client providers to accept BYOK keys per-request is
   still the next real step for those three, unchanged from before this session.

**NOT done this session (still the actual bulk of the v3 handoff, unstarted):**
- **Structural change #1** (delete the mode state machine entirely — `mode` state, remaining
  `research`/`seeker` MODE_META wiring) — NOT done; `mode` state and `MODE_META` still exist in
  App.tsx (`quorum`/`code`/`seeker`/`research`), just no longer auto-classified. The v3 brief's
  literal ask ("delete the mode state machine... zero external calls except via the pill") is
  ALREADY effectively true in behavior (no auto-escalation, confirmed cont.35), but the dead
  `seeker`/`research` states/menu remnants haven't been removed — check `modeMenuOpen`,
  `MODE_META`, and whatever still reads `mode==='seeker'`/`'research'` before assuming this is
  fully closed.
- **The MoltenPour canvas rewrite** — v3's handoff asks for a literal port of the prototype's
  `drawPour()` canvas methods into a new `MoltenPour.tsx`. The EXISTING `PourRing.tsx` (from
  cont.35b) already implements the same phase model (idle→pouring→done, live stream-driven,
  border-fill-tracks-card-height) by a different code path (dashed-stroke SVG-ish approach, not
  a raw `<canvas>` port) — functionally very close to spec per its own doc block above. Did NOT
  rewrite it as a literal canvas port this session; worth comparing directly against
  `Crucible v3.dc.html`'s `drawPour()` next time to decide if the existing implementation is
  good enough or needs the literal port.
- **The 56px left glass rail + Chat/Agents/History/Settings tab-nav** (task #4, still the single
  biggest unstarted structural piece, unchanged from cont.35b's description of it).
- **Settings → API keys as its own screen** (v3 puts key management under a Settings tab, not
  just a modal off the composer pill) — today's `EnsembleKeyModal` is still a modal, not a
  Settings-tab surface; low-risk to leave as-is until the tab-nav shell exists to house it.

**Also this session — root-caused why the Electron app "wasn't picking up backend changes":**
a manually-started detached `tsx server.ts` from the PRIOR DAY (`Sun Jul 5 22:05`) was still
squatting on port 3001. `electron.cjs`'s own `spawnBackend()` tried to bind 3001 too, crashed
silently with `EADDRINUSE` (only visible in `~/Library/Logs/Crucible-launch.log`), but
`waitForPort(3001)` doesn't check WHICH process answers — so the app window opened against the
stale day-old backend instead, with zero visible error. Killed the stale process and hardened
`electron.cjs`: `spawnBackend()` now calls a new `killStalePortOwner(3001)` (lsof+SIGKILL)
before every spawn, so this can't recur silently. Full detail in
[[crucible-run-commands]]. **The Desktop `Crucible.app` launcher itself was fine** (correctly
points at this repo) — the bug was purely the port race, not the launcher or the build step.
User should just quit and relaunch Crucible.app now to get a clean backend bound to current
code (the currently-open window, if any, is talking to the now-dead stale process).

**Next session should start by:** (a) reading the v3 handoff file directly (`Crucible UI
redesign/v3/HANDOFF - Claude Code implementation brief.md`) since it has exact current line
numbers for App.tsx's mode state/classifyMode remnants and the canvas port spec verbatim; (b)
deciding MoltenPour canvas-port vs keep-PourRing before touching animation code; (c) task #4
(left rail) is still the load-bearing remaining piece for the whole redesign to feel "done".

**Cont. 35b commits (all on `crucible-northstar-sessions`):**
- `9ef4aaf` — checkpoint of all verified cont.33/34 work (before touching App.tsx).
- `d112fed` — classifyMode no longer auto-escalates into ensemble; default mode `code` (local).
- `d34e123` — the v2 redesign slice (below).
- `c9db65f` — UNDOCUMENTED at the time; broke the build (see cont.36 above), fixed this session.

**What `d34e123` shipped:**
- **New component files:** `src/BackgroundBlobs.tsx` (ambient canvas backdrop, port of the v2
  `startBg`), `src/PourRing.tsx` (the FINAL 3-phase pour animation), `src/ensemble.tsx`
  (ModeBar pills + `useEnsemble()` toggle/BYOK store + `EnsembleKeyModal` + `EnsembleConfirm`).
- **App.tsx:** root bg `#101016` / text `#e4e4ee`; `<BackgroundBlobs>` mounted; ModeSwitcher
  (+ `MODES`/`Mode`) removed, replaced by `<ModeBar>`; reply card wrapped in `<PourRing>`
  driven by `round.synthDone/synthStreaming`; `send()` gains the ensemble opt-in+BYOK gate and
  sends `byokKeys` only for ensemble; key modal + per-query confirm modal mounted.
- **BYOK server plumbing:** `modelRegistry.ts` — AsyncLocalStorage scoping
  (`runWithByokKeys`/`enterByokKeys`/`resolveProviderKey`/`currentByokKeys`); `providerHasKey`
  activates a provider when the user supplies a key; `server.ts` `/api/chat` calls
  `enterByokKeys(byokKeys)`, `callModel` bypasses the shared key-proxy when a user key is
  present, and the OpenRouter branches read `resolveProviderKey('openrouter')`.
  **KNOWN LIMIT:** SDK-client providers (groq/mistral/gemini, instantiated once at module load
  with env keys) are still env-only — only OpenRouter (the recommended single BYOK key) is
  fully wired for user keys. Extending BYOK to the SDK providers = reinstantiate their clients
  per-request from `resolveProviderKey`, next-session work.

**PourRing animation — how it maps to the FINAL spec** (so the next session can tune, not
re-derive): phase = `idle` (pre-first-token) → `pouring` (streaming) → `done`. Pouring draws a
molten stream from the card's top-center spout, then fills BOTH border edges via two mirrored
half-paths dashed by an eased fill fraction that tracks live card height (ResizeObserver) with a
`POUR_MIN_MS=1350` floor; everything poured stays lit (3-pass bloom/glow/crisp). Done runs a
top→bottom cool sweep over `COOL_MIN_MS=1000` then clears to the card's default border. Motion is
routed through an eased current→target animator so choppy token streams still read fluid. Tune
the molten palette in `mottled()` and the floors as needed — spec is final, don't re-ask Justin.

**REMAINING redesign work (task #4, structural — the big piece left):** the v2 **56px left glass
rail** with Chat / Agents / History / Settings tab-nav + avatar, and the **Agents** and
**History** full-screen tabs (v2 has them as distinct screens; today the app is a single chat
view with drawer binders). This needs a `tab` state + screen router in App.tsx and restyling the
existing binders (Library/SelfRepair/History/Tasks/Integrations) into the new look. `Crucible
v2.dc.html` has the exact markup for all three tabs (Chat/Agents/History) — reimplement from it.
Also task #6 (gate the pipeline theater explicitly behind ensemble) is only implicitly handled
(local mode simply doesn't populate `round.models`, so the theater stays empty) — make it
explicit when building the tab shell.

**Design assets** (untracked, in `Crucible UI redesign/`): `Crucible v2.dc.html` (target),
`Crucible - Current UI.dc.html` (current), `support.js` (dc-runtime — these are divine.computer
design-tool exports, a VISUAL SPEC, not importable React). The canvas code in v2's
`<script>` (startBg/startMark/startRing) was the reference for BackgroundBlobs/PourRing.

## PRIOR (cont. 35 kickoff): NORTHSTAR UI/ROUTING REDESIGN STARTED
on branch `crucible-northstar-sessions`. Two clean commits landed: (1) `9ef4aaf` the entire
verified cont.33/34 body of work (NL-skill pipeline, /skill+/tool, RSI auto-approve) —
committed as a checkpoint before the redesign, at the user's explicit instruction; (2)
`d112fed` first redesign increment — Crucible-LOCAL is now the default path and the external
ensemble is never silently entered. The big visual redesign, BYOK ensemble gating, and the
3-phase pour animation are SCOPED + TASK-TRACKED but NOT yet built. Read the "cont.35 REDESIGN"
block immediately below before continuing.)

**Cont. 35 (this session) — NEW LARGE TASK RECEIVED mid-session: merge the `Crucible v2.dc.html`
UI redesign and make Crucible (local), not the external pipeline, the default experience.
Full brief lives in the user's handoff message + `Crucible UI redesign/` (untracked design
assets: `Crucible v2.dc.html` = target spec, `Crucible - Current UI.dc.html` = current, both
are design-tool exports with `{{ }}` template syntax — a VISUAL SPEC to reimplement, NOT
importable React).**

**Clarifying answers the user gave (authoritative for this redesign):**
1. **Commit current work first** → done (`9ef4aaf`).
2. **Crucible = local FM path** — BUT external API calls must be **opt-in AND bring-your-own-key
   (BYOK)**: end users supply their OWN keys, so Crucible doesn't infringe provider ToS if
   monetized. NEW durable constraint saved as memory [[crucible-byok-ensemble-constraint]].
3. **Ensemble opt-in = BOTH** a persistent per-session toggle AND a per-query "use ensemble?"
   confirm ask.
4. **Keep all coherent features**, restyle them into the new look (Library/SelfRepair/History/
   Integrations drawers, agent tool-calling all stay — verify post-merge, don't assume parity).

**DONE this session (commit `d112fed`, tsc clean, app boots — auth-gated so no deep UI check):**
- `classifyMode` (App.tsx ~2102) no longer escalates INTO `'quorum'` on complexity/research-verb
  heuristics — those two branches removed. It now only routes between local modes (code/seeker)
  and respects an explicit ensemble/research opt-in once chosen. This was the mechanism silently
  sending long/multipart prompts to the external pipeline with no consent.
- Default `mode` state + `preBrainModeRef` (App.tsx ~1874/1888): `'quorum'` → `'code'` (local).

**NOT DONE — the actual bulk of the redesign (task IDs #4-#7 in the tracker):**
- **#4 Visual redesign:** port `Crucible v2.dc.html`'s design system into App.tsx — 56px glass
  left rail (Chat/Agents/History/Settings nav + avatar), `#101016` dark-only bg, canvas bg
  layer, "Crucible" wordmark + ENSEMBLE badge topbar, its spacing/type/color tokens. App.tsx is
  a 5049-line monolith; `App()` = lines 1856-5049. Component map captured this session (ModeSwitcher
  ~50, PipelineTheater ~575, CritiqueGrid ~594, HistoryBinder ~1208, ClarificationCard ~1578,
  AuthScreen ~1753). Do it incrementally with tsc-clean/app-boots checkpoints, NOT one rewrite.
- **#5 Ensemble opt-in + BYOK (partially done — see above):** still need the persistent toggle +
  per-query confirm UI, and BYOK — `modelRegistry.ts` already has `providerHasKey()`/
  `PROVIDER_KEY_ENV` (env-var gating, line ~152-170); extend it to accept USER-supplied keys
  passed per-request, with NO bundled-key fallback and an "add your API key" affordance. Also:
  the server only has a SERVER-WIDE `CRUCIBLE_OFFLINE` env (server.ts ~2765), not a per-request
  local-vs-ensemble signal — that per-request plumbing is the missing server piece so the client
  default actually prevents external calls (right now `mode:'code'` non-agent chat can still fan
  out server-side; the client default is necessary but not yet sufficient).
- **#6** Move pipeline theater (PipelineTheater ~575, `crucible-pipeline-theater/status/log`
  classes ~579/4091/4713) behind the opt-in; restyle preserved features into the new look.
- **#7** Final 3-phase Crucible pour chat animation (idle tilt-loop → pour w/ molten border fill
  tracking live content height, ≥1.2-1.5s floor → upright fade + top-to-bottom cool, ≥0.8-1.2s).
  Spec is FINAL per the user — do not re-ask. Masked/clipped SVG or pseudo-element overlay driven
  by real stream lifecycle (send/first-token/stream-end). LAND LAST, once structure is stable.
- **Do NOT** regress the prior-session critic split-routing fix in synthDriver.ts/driver.ts
  (handoff says it's already verified — I did not touch it; note it wasn't in the working tree
  this session, so confirm it's already committed on this branch before assuming it's safe).

**Also still open from cont.34 (not lost, just deprioritized by the redesign):** Feature 4
(retrievalLayer recommendation cards, apply-gated) and the RSI trend-gate self-deadlock decision.

---

## PRIOR: 2026-07-06, cont. 34 — both cont.33 "next increment" items
BUILT AND LIVE-VERIFIED: (a) the verified NL-skill pipeline — a plain-language request in
the Library drawer now becomes a PROVEN catalog entry in `catalogs/user-skills.json`, first
real entry `user/slugify` landed via on-device FM + a NEW deterministic repair, prove:all
251/251; (b) the RSI auto-approve consumer — the 6h scheduler now routes every tick through
the stakes router (`rsi_cycle`, its FIRST non-filesystem consumer, priority-ladder item 3),
proposing-and-waiting by default and auto-approving only under the explicit AFK opt-in.)

**Cont. 34 (this session) — FABLE5_HANDOFF execution, second slice. All items below are
live-verified against a restarted `:3001` (current code IS running there now), not just
bench-verified.**

**1. Verified NL-skill pipeline (Feature 1 increment) — DONE.**
`src/CrucibleEngine/synth/userSkillPipeline.ts` (`buildUserSkill`): admission gate (the
request must declare an exact exported API and pin ≥2 worked examples `f(x) -> y`, else
honest rejection with guidance — no examples ⇒ nothing to prove ⇒ nothing enters the
library) → duplicate check (export-name collision against merged catalog + on-disk user
batch; an L0 primitive hit is also reported as "already covered") → `synthesizeUniversal`
(maxFmRounds 6, distill:false, oracle-gated on the request's own examples) → CatalogEntry
(patterns = exact export names at weight 0.9 per the skill-factory self-match convention;
tests[] = the SAME examples the oracle ran, via the new `extractSpecExamples` export from
derive.ts) → whole-user-batch `validate-batch` in scratch → append to
`catalogs/user-skills.json` → `generate:skills` + full `prove:all`, with rollback +
re-generate + re-prove on failure so the manifest never drifts from green. Server:
`POST /api/library/skills/build` (async job, 409 single-flight — FM + manifest contention)
+ `GET .../build/:id` polling; successful entries are pushed into the in-process
SKILL_CATALOG so the drawer/shortcuts see them without a restart. LibraryBinder's skill
BuildBox now calls this pipeline and renders a live status card (stage/message/detail,
amber on failure, dismissable) — browser-verified. **First proven user skill landed:
`user/slugify`** — FM round-1 candidate had the classic dash-run bug, the oracle rejected
it, the new repair fixed it deterministically, ALL PASS, batch oracle PASS, prove:all
251/251. Rejection paths (no examples / no API / hexToRgb duplicate) all verified too.

**2. 9th deterministic repair — `repairSeparatorRunNormalize` (repairProposers.ts).**
Added on a REAL recurrence: the FM failed slugify 9/9 rounds across 2 independent fires
with the same fingerprint (maps chars to '-' correctly but never collapses runs nor trims
edges; read from `.crucible/fm-rounds.jsonl` per the item-17 discipline before acting).
Closed-world: parses derive.ts's own `FAIL — name(...) === "want"  (got "got")` lines and
proposes ONLY when a single separator ('-'|'_') explains EVERY failing pair; transform
renames the export to a `__raw_` impl + re-exports a normalizing wrapper; oracle re-gates.
`__repairProposers_bench.ts` 11→14/14. This is what turned the pipeline's happy path GREEN.

**3. /skill + /tool slash shortcuts — DONE.** In server.ts `/api/chat`, ahead of ALL NL
intent classification: `/skill <id|filename|export>` writes the proven entry's impl to its
defaultPath in the project (reindexed, SSE tool_call/tool_result/final); `/tool <name>
[json|text]` executes the registry tool directly (JSON args or raw text mapped onto the
first required param), with fuzzy closest-match suggestions on unknown names. All paths
live-verified through authed `/api/chat` (emit → read back via `/tool read_file`).

**4. RSI auto-approve consumer (Feature 7 increment) — DONE, and it IS the stakes
router's first non-filesystem test case.** `assessStakes` gained an `rsi_cycle` branch:
the cycle is reversible by construction (snapshot→measure→keep-if-not-worse→restore), so
stakes reduce to pure AUTHORIZATION — the durable fully-automatic toggle is the standing
equivalent of EXPLICIT_VERBS. `runScheduledRsiTick()` (server.ts, next to the RSI
endpoints) replaces the old silent 6h `runRsiCycle` call: high stakes → `buildCycleProposal`
and WAIT (card appears in SelfRepairBinder); low stakes → approve pending-or-new proposal →
same gated cycle as the manual Apply → `recordProposalOutcome`. `POST /api/rsi/tick` fires
one tick on demand (ops/testing). `stakesRouter-bench.ts` 15→17/17. **Live-verified both
paths:** toggle OFF → `proposed` (plain-language reason) then `already-pending` on re-tick;
toggle ON → `auto-approved`, a real 222s cycle ran and honestly recorded
`failed/reverted — trend_down` onto the proposal. Auto-approve was restored to OFF
after testing (its pre-session state), so the scheduler is in propose-and-wait mode.

**5. OPEN OBSERVATION (flagged, deliberately not changed): possible RSI trend-gate
self-deadlock.** The last two cycles IMPROVED the benchmark (0.53→0.6, 0.47→0.6) yet both
reverted solely because `qualityPredictor.stats().trend === 'down'` (controller.ts step 5,
documented belt-and-suspenders). If the live trend stays down for a stretch, RSI
structurally cannot promote the very improvements that might fix the trend. Decide next
session: keep (conservative), or let a benchmark-IMPROVING (not merely holding) candidate
through despite a down trend.

**Verification summary:** `tsc --noEmit` clean on both configs; `prove:all` 251/251 (ran
as the pipeline's own gate post-landing); `__fuzz_bench` 31/31; `ambiguity:bench` 9/9;
`__repairProposers_bench` 14/14; `stakesRouter-bench` 17/17; drawer + status card verified
in the real browser preview (localStorage still had a stale `crucible_api_base=:3012`
override from cont.33's verification — cleared; watch for it when browser-testing).
Nothing committed (standing rule: no commit without an explicit ask).

**NEXT (in order): (a) Feature 4** — surface `retrievalLayer.ts` recommendations as cards
with apply-gated integration (drawer pattern exists; `retrieveForTask`/`rankByRelevance`
already compute everything; route accepts through applyLayer, never blind-paste);
**(b) decide the RSI trend-gate question above; (c) Feature 2** (conversation mode, scope
WITH Workstream 2 — read HITL_PLANNING_TRACK.md first); **(d) Feature 3** (Pocock research
pass); **(e) Feature 5** (parallel agentic calling — re-read crucible-agentic-architecture
memory first); **(f) Feature 6** (design note only). Also worth a quick pass: the NL-skill
pipeline requires literal worked examples by design — a fair v2 increment is having the
drawer SUGGEST example lines derived from the request before rejecting outright.

## PRIOR: 2026-07-06, cont. 33 — FABLE5_HANDOFF Features 1 and 7
BUILT AND LIVE-VERIFIED: skill/tool Library drawer + self-repair propose/explain/approve
drawer, both endpoint-tested with a minted JWT and browser-verified through the real UI.
Also: cont.32's pending 12-task regression sweep COMPLETED CLEAN — 10/12 HARD-green,
"No regressions vs the previous scorecard", caseCompareModule GREEN at full-suite level.)

**Cont. 33 (this session) — first execution slice of FABLE5_HANDOFF.md (read that file for
the full 7-feature plan; ROADMAP.md's sharpened 5-point MISSION block is the success bar).**

**1. Regression sweep from cont.32 — CLOSED.** Full 12-task `smoke:code` against the fixed
server: 4/4 catalog GREEN + 6/8 generation GREEN (filterModule, summaryModule, clampModule,
leaderboardModule, usernameModule, caseCompareModule). sortModule RED (unchanged accepted
boundary), tagSetModule RED (same genuine intersect-dedupe generation variance as cont.31,
rubric 40 — still below the repair-recurrence bar). Both cont.32 derive.ts fixes are
confirmed at full-suite level. No open verification debt from cont.32.

**2. Feature 1 (skill/tool Library drawer) — BUILT, VERIFIED.** New `GET /api/library/tools`
(built-ins from `registry.list()` + per-project dynamic tools) and `GET /api/library/skills`
(the merged 229-entry catalogIndex, `?q=` filtered) in server.ts (next to
`/api/debug/dynamic-tools`). New `src/LibraryBinder.tsx` — topbar trigger + frosted drawer
(same pattern as HistoryBinder/IntegrationsBinder) with two nested collapsible sections
(Skill Library · 229 / Tool Library · 49 built-ins + dynamic), live search, and a
plain-language "describe it, have it built" BuildBox per section that routes the request
into the agent loop (tools land on the existing `create_tool` persistence path;
`.crucible/dynamic-tools/`). Verified: endpoints curl-tested with minted JWT (229 skills,
`?q=semver`→3, 49 tools), drawer opened/searched/screenshotted in the real browser preview,
tsc clean. **REMAINING from Feature 1:** the NL skill request currently routes through the
agent as a normal build task — the dedicated generate→validate→`catalogs/user-skills.json`
pipeline (so NL-built skills become PROVEN catalog entries automatically) is not built;
that's the next Feature-1 increment. Slash shortcuts (`/tool <name>`, `/skill <name>`)
also not built.

**3. Feature 7 (self-repair propose/explain/approve) — BUILT, VERIFIED.** New
`src/CrucibleEngine/rsi/proposals.ts`: `RsiProposal` records persisted to
`.crucible/rsi-proposals.json`, `buildCycleProposal()` composes a plain-language
what/why/how/risk card from REAL live signals (quality-history size, qualityPredictor
trend, learned-weights balance, RSI cycle track record) with zero model inference;
`resolveProposal`/`recordProposalOutcome` carry the cycle's honest verdict back onto the
record; one-pending-at-a-time guard; `isAutoApproveEnabled`/`setAutoApprove` opt-in flag
(`.crucible/rsi-auto-approve.json`). Five new endpoints in server.ts next to the existing
RSI block: `GET /api/rsi/proposals`, `POST /api/rsi/propose` (409 on duplicate pending),
`POST /api/rsi/proposals/:id/approve` (runs the normal gated `runRsiCycle` with the same
`buildRsiDeps()` as `/api/rsi/cycle`; outcome recorded on completion),
`POST .../:id/reject`, `POST /api/rsi/auto-approve`. New `src/SelfRepairBinder.tsx` drawer:
track-record header (real data: 34 runs / 2 kept / 14 auto-undone), pending-proposal
decision card (Apply / Not now), running state with 5s polling, history with honest
outcome labels, fully-automatic toggle. Verified end-to-end: propose→409-duplicate→reject
via curl; propose→plain-language card→"Not now" through the real browser UI; approve
verified live END-TO-END: a real gated cycle ran on the :3012 instance, learned state
dipped on re-measure, the cycle honestly REVERTED, and `recordProposalOutcome` wrote
`status:failed / verdict:reverted / "Quality dipped on re-measure — changes were
automatically undone."` onto the proposal record — the complete propose→approve→run→
honest-outcome loop is proven, including the safety path. tsc
clean throughout. NOTE: the auto-approve flag is stored+toggleable but nothing CONSUMES it
yet (no scheduler auto-runs cycles when it's on) — wiring it into the idle scheduler is the
next Feature-7 increment, and per FABLE5_HANDOFF this approval gate should become the first
concrete test case of the HITL/AFK stakes router (priority-ladder item 3).

**Verification environment note:** all live checks ran against a SECOND server instance
(`PORT=3012 CRUCIBLE_OFFLINE=strict`) + the vite preview with `crucible_api_base` localStorage
override, so the primary `:3001` (mid-sweep) was never disturbed. `:3001` still runs
pre-cont.33 code — restart it onto the current commit before any sweep that touches the new
endpoints. The 12-task suite does NOT touch them, so the clean sweep above is valid.

**NEXT (in order): remaining FABLE5_HANDOFF features** — (a) Feature 1 increment: verified
NL-skill pipeline + slash shortcuts; (b) Feature 7 increment: auto-approve consumer in the
idle scheduler; (c) Feature 4 (retrieval recommendations surface — `retrievalLayer.ts`
already ranks, just needs the drawer card + apply-gated integration); (d) Feature 2
(conversation/plan mode — scope WITH Workstream 2, read HITL_PLANNING_TRACK.md first);
(e) Feature 3 (Pocock research pass); (f) Feature 5 (parallel agentic calling — biggest bet,
re-read crucible-agentic-architecture memory first); (g) Feature 6 (design note only).

**Cont. 32 (this session) — audit-only continuation of cont.31's explicit "not yet
live-confirmed" item: `derive.ts`'s `comparator` family "unconditionally tests both
numeric AND string calls on every comparator regardless of declared type."** Confirmed
by reading the code (`src/CrucibleEngine/synth/derive.ts:216-232` pre-fix): every
comparator match unconditionally emitted BOTH a numeric-pair assertion
(`${name}(1, 2)`) AND a string-pair assertion (`${name}('a','a')`), regardless of the
spec's declared parameter types. A comparator explicitly typed `(a: string, b: string)`
(a very ordinary shape — e.g. `compareVersions(a: string, b: string): number`) would hit
the identical unwinnable-oracle-gate bug as `tagSetModule`: the generated property-test
file itself fails `tsc` (`Argument of type 'number' is not assignable to parameter of
type 'string'`) before any candidate is even judged. This had NOT yet fired live (no
comparator-family generation-stress task exists yet), so this was caught by inspection,
same discipline as cont.30's proactive fuzz-family audit — not a live-repro this time.

**Fix (same pattern as cont.31's set-op fix):** reused the existing `getSpecParamsRaw()`
helper to sniff the spec's declared signature; when explicitly `string`-only, emit just
the string assertions; when explicitly `number`-only, emit just the numeric assertions;
untyped/generic signatures (the common case, no declared types) are unchanged — still
get both, exactly as before. Scratch-verified directly against `derivePropertyTests()`
with three synthetic specs (string-typed `compareVersions`, number-typed `compareNums`,
untyped `compare`) — confirmed each produces only the assertions that will actually
typecheck, and the untyped case is byte-identical to the old unconditional behavior.
`npx tsc --noEmit` clean, `npm run prove:all` 250/250 unchanged (no catalog skill uses
this family's code path with a string-typed comparator, so no regression risk there).

**Not done:** did not add a new generation-stress task to exercise this live (e.g. a
`versionCompareModule` task with a `string`-typed comparator) — this fix closes the
identified risk but, like cont.30's fuzz-family audit fixes, has zero live-fire
confirmation yet. That is the natural next verification step, same shape as how
cont.31 closed the loop on cont.30's two new tasks. Did not touch any other `derive.ts`
family — no other family was flagged as having this risk.

## PRIOR: 2026-07-06, cont. 31 — live-fired the 2 new tasks from
cont.30; tagSetModule's first fire was RED at 0% (module never produced) and root-caused
to a REAL oracle bug in `synth/derive.ts`'s `set-op` family — same audit discipline as the
sum/summarize fix, this time caught on first live contact rather than by proactive
inspection. Fixed, re-verified, and a full 11-task sweep confirms no regressions.

**Cont. 31 — continuation of cont.30's "not yet live-fired" open item.**
Restarted `:3001` clean (`CRUCIBLE_OFFLINE=strict` in the server's own env) and fired
`usernameModule`/`tagSetModule` live. `usernameModule` GREEN first try (11/11 hidden,
genuine generation signal). `tagSetModule` RED: `module exists FAIL` — the FM never
produced a passing candidate at all, oracle honestly escalated after 3 rounds with an
identical compile-error fingerprint.

**Read `.crucible/fm-rounds.jsonl` before guessing (the item-17 discipline) — found a real
oracle bug, not an FM capability gap.** The repeating error was
`__property__/spec.test.ts(10,64): error TS2322: Type 'number' is not assignable to type
'string'` — `synth/derive.ts`'s `set-op` family (union/intersect/difference) hardcodes
NUMERIC literal test data (`[1,2,3]`, etc.) unconditionally, regardless of the task's real
declared parameter types. `tagSetModule`'s spec correctly declares `string[]` params
(`unionTags(a: string[], b: string[])`), so the auto-generated property-test file itself
failed to compile — an unwinnable oracle gate no candidate could ever pass, same failure
class as the `localHardenFuzz.ts` type-collision risks found earlier this session, but in
the DIFFERENT derive.ts/oracle-side property-test system (built from the spec's own prompt
text before any candidate exists, not from candidate code).

**Fixed:** `getSpecParamsRaw()` + a type-aware `arr()` literal-builder in `derive.ts`'s
set-op block — sniffs the spec's own declared signature and switches to string literals
(`'a'`,`'b'`,...) preserving the exact same overlap/dedup relationships when the params
are explicitly typed `string[]`; numeric/untyped specs are unaffected. Scratch-verified
directly against `derivePropertyTests()` with the real `tagSetModule` prompt text before
touching the live server (confirmed string literals + no assertion-semantics change).
`npx tsc --noEmit` clean, `npm run prove:all` 250/250 unchanged (set-op catalog skills use
numeric specs, untouched by this branch).

**Re-verified live, 3 fires total post-fix:** `tagSetModule` now reliably reaches
`module exists PASS` + `compiles clean PASS` + hidden suite (previously 0/1 ever got that
far) — the oracle bug is confirmed fixed. Hidden-suite result is now genuine
generation-quality signal: fire 1 caught a severely broken `intersectTags` (inverted
membership check, `result.includes(tag) && b.includes(tag)` — can never be true from an
empty result, so intersect returns near-empty); fire 2 and fire 3 caught a narrower,
DIFFERENT bug (`intersectTags` correct but doesn't dedupe when `a` itself has repeated
tags). **Deliberately did NOT add a `repairProposers.ts` entry** — the two bugs are not an
identical recurring fingerprint (this project's established 2-3-identical-recurrence bar
for adding a repair, see items 30/31 in [[crucible-coding-harness]]), they're genuine
FM-generation variance on this task shape. `tagSetModule` is RED 3/3 so far but for a real,
hand-verifiable reason each time, not an oracle artifact — legitimate new generative-
capability signal, the exact goal of broadening the suite.

**Full 11-task sweep run after the fix + server restart, to check for regressions:**
4/4 catalog GREEN (kvstore/ratelimiter/scheduler/regex, unaffected as expected — derive.ts's
set-op branch isn't in their path). Generation tasks: filterModule, summaryModule,
leaderboardModule, usernameModule all GREEN; sortModule RED (unchanged accepted boundary,
untouched per instruction); clampModule RED this run (oracle rejected 3 candidates with an
identical clamp-bounds failure shape, honestly escalated) — this is FM-generation
variance unrelated to this session's derive.ts change (clampModule uses the
`number-transform-clamp` family, a different code branch never touched this session);
consistent with this suite's long-documented run-to-run flakiness, not a regression.
tagSetModule RED as above (genuine signal, not oracle). **Net: 8/11 HARD-green
(4 catalog + 4 generation), 4/7 generation tasks GREEN** — no regressions vs. the pre-
session scorecard on any task this session didn't touch.

**Not done:** did not chase clampModule's flake (single-run, no established recurrence,
matches known variance); did not add a repair for tagSetModule's intersect-dedupe gap
(correctly below the recurrence bar); did not extend the type-aware literal fix to
`derive.ts`'s `comparator` family, which has a DIFFERENT, not-yet-live-confirmed risk
(it unconditionally tests both numeric AND string calls on every comparator regardless of
declared type — `comparator: correct string comparator, non-numeric params` audit-worthy
next, same discipline, no live evidence yet).

## PRIOR: 2026-07-06, cont. 30 — generation-stress suite broadened
5→7 tasks (usernameModule, tagSetModule) hand-verified against reference+buggy impls; a
proactive audit of every fuzz-family name-regex (same discipline that found the
summarize/sum collision) found and fixed 3 real type-collision false-positive risks in
`localHardenFuzz.ts` before any live sweep surfaced them)

**Cont. 30 (this session) — explicit ask: broaden the generation-stress suite beyond 5
tasks, leave sortModule's accepted capability boundary alone, and apply the
"is-the-checker-even-testing-the-right-contract" audit discipline (item 31's
summarize/sum lesson) to other fuzz families PROACTIVELY, not just when a live sweep
happens to surface a collision.**

**1. Two new generation-stress tasks added to `coding-benchmarks.ts` (5→7):**
`usernameModule` (standalone, `validator` family — `isValidUsername(name): boolean`,
3-20 chars/leading-letter/alnum-or-underscore rules) and `tagSetModule` (repo-context,
exercises BOTH `set-op-union` and `set-op-intersect` in one task —
`unionTags`/`intersectTags(a: string[], b: string[]): string[]`, no-mutation +
no-duplicates rules). Both confirmed not already covered by the skill catalog (checked
`validatorsB.json` for username-shaped validators, all catalogs for union/intersect —
only an unrelated `segmentsIntersect` geometry primitive exists). New hidden suites
(`coding-bench/usernameModule.hidden.ts`, `tagSetModule.hidden.ts`) hand-verified in
scratch BEFORE committing, same discipline items 9/21 used: a correct reference impl for
each passes 11/11 and 10/10 clean, and a deliberately buggy variant for each (missing
leading-letter rule; in-place-mutating union + wrong-answer intersect) is caught with
precise got/expected output. **Not yet live-fired against the actual agent** — these are
hand-verified test-design correctness, not a live GREEN/RED read; that's the natural next
step before trusting them as a live signal.

**2. sortModule:** untouched this session, per explicit instruction — its structural
conditional-grouping miss (item 16 in [[crucible-coding-harness]]) stays the one
documented, accepted capability boundary. No code touched, no new investigation opened.

**3. Proactive fuzz-family contract audit (the actual point of this session) — read
every `detectChecks()` name-regex in `localHardenFuzz.ts` the way item 31 diagnosed
`/^sum/i` matching `summarizeByAccount` post-hoc, but BEFORE a live sweep forced the
issue.** Found 3 real risks, all sharing one root cause: a family's name+arity gate can
match a real, common function whose declared TS parameter TYPES don't match the family's
numeric fuzz-input assumption, and the resulting throw/type-mismatch inside `fc.assert`
would be misreported as a genuine counterexample on perfectly correct code:
   - `comparator` family (`/^(compare|...)/`, arity 2) would misfire on something like
     `compareVersions(a: string, b: string): number` — fuzzes with random integers,
     `a.split('.')` throws on a number.
   - `set-op-diff` family (`/^(difference|subtract|complement)/`, arity 2) would misfire
     on `differenceInDays(a: Date, b: Date): number` — a very ordinary date-math helper
     name, not a set operation at all.
   - `array-dedupe` family (`/^(dedupe|unique|distinct)/`, arity 1) would misfire on
     `uniqueId(prefix: string): string` — an ID generator, not an array dedupe.
   None of these three had actually fired live yet (unlike item 31's summarize case,
   which needed 3 live recurrences before the root cause was found) — this audit found
   them by inspection first. **Fix:** added `paramsLookNonNumeric()` in
   `localHardenFuzz.ts` — sniffs the raw declared parameter-type text for an explicit
   `string`/`Date`/`boolean` annotation and skips the numeric-input families (sort,
   comparator, set-op-*, clamp, array-dedupe, number-aggregate-sum) when found, leaving
   `validator`/`string-transform` (which correctly expect real strings) untouched. Added
   3 regression cases to `__fuzz_bench.ts` (28→31/31, all passing) — one per collision
   shape, each asserting the correct-but-non-numeric-typed candidate produces NO finding.
   `npx tsc --noEmit` clean, `npm run prove:all` 250/250 unchanged throughout.

**Not done this session:** no live `smoke:code` sweep (neither the 2 new tasks nor the
fuzz-audit fix were fired against a running server) — the two new tasks are hand-verified
design-correct but have zero live pass/fail history yet; that's the natural next step.
Did not extend the same param-type audit to `localHardenCheck.ts`'s AST scanner (a
different gate, item 25 already gave it its own mirror-image audit pass) or to
`derive.ts`'s oracle-side family conventions (a related but separate system from the
harden-fuzz layer audited here) — worth doing the same discipline there next if this
proactive-audit pattern keeps paying off.

## PRIOR: 2026-07-05, cont. 29 — cont.28's flagged summaryModule
empty-array shape recurred 2 more times (3 confirmed total) but turned out to be an ORACLE
false positive, not an FM bug — fixed the fuzz classifier, not repairProposers.ts

**Cont. 29 (this session) — picked up cont.28's explicit next step: re-run the authed
debug-stream-tail technique against summaryModule + the 4 non-sortModule generation tasks a
few more times to see if the byte-identical `Counterexample: [[]]` empty-array shape recurs;
2-3 confirmed recurrences was the stated bar for writing a 9th repairProposers.ts entry.**

Minted an authed JWT ([[crucible-local-auth-testing]]), tailed `GET /api/debug/stream` to a
scratch log, and fired `summaryModule` 3 times and `clampModule` once via `npm run smoke:code`
while the tail ran. **The shape recurred all 3 times** — byte-identical
`summarizeByAccount fails the number-aggregate-sum property ... Counterexample: [[]]` at iters
7/8/9 every single fire, clearing the 2-3-recurrence bar cont.28 set.

**But investigating WHY before writing a repair proposer changed the diagnosis entirely: this
is not an FM generation bug, it's an oracle false positive — the exact same name-collision
class as items 11/24/25.** `localHardenFuzz.ts`'s `detectChecks()` classified
`summarizeByAccount` into the `number-aggregate-sum` fuzz family because its old regex was
`/^sum/i && arity===1` — it matches any name starting with "sum" with one argument, including
"summarize", regardless of what the function actually returns. `summarizeByAccount` returns a
`Record<string, {...}>`, not a number, so the fuzz property's `typeof r !== 'number'` check
fails on EVERY call unconditionally — no possible generated code could ever satisfy this
check, which is why the finding was byte-identical every time and why it always harmlessly
self-corrected by iter 10 (the harden critic is soft, not a hard gate). Writing a 9th repair
proposer would have been the wrong lever entirely — there is no code fix for a check that's
testing the wrong contract.

**Fix (not repairProposers.ts): narrowed the classifier regex** to
`/^sum(?:[A-Z]|$)/` — requires a camelCase boundary right after "sum" (matches `sumValues`,
bare `sum`; rejects `summarize*`/`summary*`), same convention `^is[A-Z]` already uses one line
above it in the same function. Added a regression case to `__fuzz_bench.ts` (27→28/28, the
exact `summarizeByAccount` shape asserted clean). `npm run prove:all` → 250/250 unchanged.
**Re-verified live, not just via the bench:** re-fired `summaryModule` (still GREEN, 14/14
hidden, zero `number-aggregate-sum` finding in the fresh debug-stream capture — confirms the
fix, not just the unit test) and `clampModule` (GREEN, unaffected — confirms no regression on
an unrelated fuzz family).

**Net this session: 0 lines changed in repairProposers.ts or loop.ts** — the honest answer to
cont.28's open question was "the recurrence was real, but it wasn't an FM bug," not "add a 9th
proposer." Lesson for future sessions applying this same investigate-before-fixing discipline:
a harden/fuzz finding that survives 3 confirmed live recurrences is strong signal SOMETHING is
wrong, but check whether the checker itself is testing the right contract before assuming the
generated code is at fault — the fix belongs wherever the false signal actually originates.

## PRIOR: 2026-07-06, cont. 26 — clean generation-stress baseline
confirmed post-ambiguity-fix (4/5 gen tasks GREEN, sortModule the only accepted boundary);
first three commits of the session landed; a new deterministic repair added for
leaderboardModule's mutation bug, with an important caveat about which path it actually covers)

**Cont. 26 (this session) — committed the full accumulated session (3 commits: agent/HITL
layer, deterministic critic layer, docs — see `git log`), then re-ran the generation-stress
suite live now that the ambiguity gate fix (cont.25) is in place, to get the clean baseline
that fix was blocking.**

**Clean baseline, live-verified:** filterModule GREEN (15/15 hidden), summaryModule GREEN
(14/14 hidden), sortModule RED (the pre-existing, documented ACCEPTED capability boundary —
unchanged, not a new regression), clampModule GREEN (from cont.24's session), leaderboardModule
RED (reaches the hidden suite now, per cont.25 — fails on a mutation bug, a completely
different failure mode from "never attempted"). **4 of 5 generation tasks are GREEN** — the
healthiest read this suite has ever had, and for the first time one we can trust wasn't
undercounted by the ambiguity-gate bug.

**New deterministic repair added, with a real scope caveat found while adding it:**
`repairProposers.ts` gained `repairMutatingSort` — rewrites a bare `paramName.sort(...)` (which
mutates its argument) to `[...paramName].sort(...)`, gated on the fuzz layer's own
mutation-failure message text. The regex structurally cannot false-fire on already-correct
`[...x].sort(...)` or `x.slice().sort(...)` forms (a `]`/`)` sits between the identifier and
the dot in both). Verified directly against leaderboardModule's exact failing candidate — the
proposed repair is byte-identical to hand-writing the fix. **Caveat found while wiring this
in: `repairProposers.ts`/`proposeRepairs` is only called from `universal.ts` — the synth/oracle
round-based generation path — never from `agent/loop.ts`, the interactive tool-calling path
`smoke:code`'s live agent-mode benchmark actually uses.** So this repair does NOT fix
leaderboardModule's specific failure in the benchmark as currently run (mode:agent); it's
real, verified, and immediately useful for any task that goes through the synth/oracle path
(e.g. `synthesizePureCode`), but bringing deterministic repair to the agent-loop path is a
distinct, not-yet-done architectural step — flagged here rather than overclaimed as fixed.
Also: `repairProposers.ts` (7 pre-existing repair functions plus this new one) had ZERO test
coverage anywhere in the repo — added `__repairProposers_bench.ts` (11/11: one true-positive
per repair, two false-positive no-op guards for the new repair, one no-signal-no-repair
baseline), wired into `npm run prove:all` (`repair:bench`). `tsc` clean, `prove:all` 250/250.

**Not done this session:** bringing deterministic repair (or ANY repairProposers-style
mechanism) to `agent/loop.ts`'s interactive path — this is the concrete next step for actually
closing leaderboardModule's live benchmark failure, not just adding a repair that's reachable
from a different code path. Re-running clampModule/leaderboardModule together in one sweep to
double check nothing conflicts (each was tested separately this session).

## PRIOR: 2026-07-06, cont. 25 — CRITICAL FIX: ambiguity.ts's live-wired
gate (shipped cont.20) was silently killing real coding tasks at 0 iterations — a structural
false positive found by live-firing an actual benchmark task, not by code audit. Live-verified
fixed: leaderboardModule went from 0 iterations (never attempted) to 10 iterations reaching the
hidden suite.)

**Cont. 25 (this session) — while re-verifying cont.22's fuzz fix with a real live sweep
(routine confirmation, not expected to find anything new), `leaderboardModule` fired 0
iterations and produced nothing. This turned out to be the single highest-impact finding of
the session: ambiguity.ts's DEF_REF heuristic, live-wired into loop.ts since cont.20, has an
effectively unbounded false-positive rate on ordinary prose, and was actively preventing the
agent from attempting well-specified tasks.**

Root cause, confirmed via `/api/debug/history`: an `ambiguity_gate` event with 5
`unresolved-reference` signals (confidence 0.031) fired on leaderboardModule's spec BEFORE the
agent made a single tool call — `resolveAmbiguity` misread ordinary prose ("the COMPLETE...",
"the exact API...", "...that sorts a mixed list...", "confirms... that the input...") as 5
distinct unresolved code-symbol references and short-circuited straight to a clarification
stop, exactly the documented-but-never-fixed DEF_REF false-positive class (cont.17 already
fixed ONE instance of this, "that returns" → VERB_STOPLIST). Patched the 4 specific words
first (STOP_REFS: exact/complete/ordering/the/this/that/a/an; VERB_STOPLIST: sort/sorts/
sorted/sorting) — then, before declaring it closed, wrote a standalone script testing
`resolveAmbiguity` against the literal prompt text of **all 9 of this repo's own benchmark
tasks** (kvstore/ratelimiter/scheduler/regex/filterModule/sortModule/summaryModule/
clampModule/leaderboardModule). Result: **6 of 9 were STILL falsely flagged ambiguous** even
after the word-list patch (new false hits: "the least", "the WAL", "the injected", "the
rolling", "the preceding", "the primary", "the calls", "the account", "the credits" — a
different set of common words every time), proving conclusively that a hand-maintained
stoplist can never keep pace with ordinary English prose.

**Structural fix, not another word added to a list:** `resolveAmbiguity` now only generates
`unresolved-reference` signals when the goal does NOT already name a concrete target file
(`FILE_TOKEN` — the same check the `no-target` signal already used, just computed earlier and
reused). Rationale: DEF_REF's entire purpose is catching "fix THE parser" — a request that
refers to something via a definite article WITHOUT naming any concrete target. Once a file
path IS named (as every one of this repo's own benchmark specs does), the "what to change"
question is already answered, so hunting for other "the X" phrases in the surrounding
rules/behavior prose adds no real signal, only false positives. Auto-resolution (the single-
index-match rewrite) still runs unconditionally — it's purely additive goal enrichment, never
a source of a false "ambiguous" verdict, so no reason to gate it. Re-ran the all-9-prompts
check: **9/9 clean.** `ambiguity-bench.ts` still 9/9 (the "fix the parser" cases all have no
named file, so the gate correctly still applies there — verified this isn't a blanket
disable). `tsc` clean, `prove:all` 250/250.

**Live-verified end to end, not just via the standalone script:** restarted `:3001` clean
(`CRUCIBLE_OFFLINE=strict`, single LISTEN pid) and re-fired `leaderboardModule` through
`npm run smoke:code:offline`. Before the fix: `iters=0`, module never written. After the fix:
`iters=10`, module written, **compiles clean, reaches the hidden suite for the first time**
(still RED — the FM's candidate mutates the input array in place, the pre-existing
`sortScoresAscending` capability gap items 21-22 already characterized — but that's a
completely different, already-documented failure mode from "the task was never attempted at
all"). This is not a hypothetical fix — it demonstrably unblocks real task attempts.

**Why this matters more than every other fix this session combined:** items cont.22-24 all
hardened critics against bugs the FM might write. This fix removes a gate that was silently
preventing the FM from being given a chance to write anything at all, on the majority of
realistic, well-specified coding requests, the moment a semantic index is available (i.e. on
essentially every real repo-context task) — since cont.20 wired this gate into the actual live
`agent/loop.ts` path. **Any generation-accuracy measurement taken between cont.20 (2026-07-04)
and this fix should be treated as unreliable** — a nonzero fraction of "the FM failed" reads
during that window were likely actually "the request never reached the FM." No way to
retroactively quantify how much of item 2's measured gap this explains without re-running the
full generation-stress suite, which is the natural next step.

## PRIOR: 2026-07-06, cont. 24 — Gate A3 (contractGate.ts) audited next;
found and fixed a real FALSE POSITIVE that was actively hurting generation accuracy, not just
a missed-detection gap; both Gate A2 and Gate A3 gained their first-ever bench, wired into
`prove:all`)

**Cont. 24 (this session, continuing the systematic critic audit) — extended the mirror-image
audit from localHardenFuzz/localHardenCheck to the two Workstream-1 gates that hadn't been
touched yet (Gate A2 lintGate.ts, Gate A3 contractGate.ts).**

**Gate A3 (`contractGate.ts`) had a real, previously-unknown FALSE POSITIVE — worse than a
missed detection, since it actively rejects correct code.** `actualSignatures()` only
recognized `export function name(...)` (TS `FunctionDeclaration`). A candidate written as
`export const name = (a, b): R => ...` (arrow function) or
`export const name = function(a, b): R {...}` (function expression) — an equally common,
equally correct style — was completely invisible to it: `checkContract` reported "missing
export" and rejected a CORRECT candidate, burning an FM retry round on nothing. Confirmed live
before the fix (`checkContract` on a correct arrow-const candidate → rejected) and after
(→ accepted, while arity mismatches and non-exported bindings are still correctly caught).
Fixed: `actualSignatures` now also walks exported `const name = <arrow|function-expression>`
declarations. **This directly serves item 2 (generation accuracy) in a way none of the prior
fixes did** — every prior fix this session hardened a gate against bugs the FM might write;
this one removes a gate rejecting correct FM output for a superficial style reason, which
means Gate A3 was silently degrading the FM's effective pass rate on any spec whose actual
implementation preferred arrow-function style. Checked `.crucible/fm-rounds.jsonl` (599 lines)
for a historical `"verdict":"contract:..."` rejection — zero hits, so this specific bug hasn't
been observed to have actually fired on the current generation-stress suite's tasks (the FM
happened to always write `export function` style for these); it's a real, confirmed defect via
direct test, not a proven explanation for any of the measured item-2 gap. Still worth watching
for on future/different tasks now that it's fixed rather than latent.

**Gate A2 (`lintGate.ts`) had zero known defects** — it wraps trusted ESLint rules, so the
risk profile is wiring regressions (e.g. the already-once-hit flat-config `files` matcher
pitfall), not incomplete pattern coverage. No fix needed, but it had no bench either.

**Both gates had NO test coverage anywhere in the repo before this session** — same
test-debt-cleanup discipline as cont.20's `localHardenCheck` bench. Added
`__contractGate_bench.ts` (10/10: the arrow/function-expression false-positive case, arity
mismatches in both declaration styles, missing-export, non-exported-binding, return-type
widening-to-any allowed, return-type array-ness mismatch caught) and `__lintGate_bench.ts`
(12/12: one true-positive per configured ESLint rule + one clean-code true-negative). Both
wired into `npm run prove:all` (`contract:bench`, `lintgate:bench` scripts added). `tsc`
clean, `prove:all` 250/250 unchanged (bench suites run before the 250-skill catalog check,
same pattern as the other 3 bench suites already wired in).

## PRIOR: 2026-07-06, cont. 23 — localHardenCheck.ts's 5-shape AST scanner audited the same
way the fuzz layer was in cont.22; found 5 MORE real false-negative gaps, all fixed

**Cont. 23 (this session, continuing cont.22's methodology) — the item flagged as "not done
this session" in cont.22 ("localHardenCheck.ts wasn't audited for analogous gaps") is now
done.** Read all 5 AST checks looking for the same class of defect found in the fuzz layer:
an operand/statement-shape the check silently doesn't recognize even though it's the identical
bug. Found and fixed 5, each confirmed live before AND after the fix:
1. `checkOffByOneLoopBound` only matched `i <= arr.length` (loop var on the left) — the
   logically-identical reversed form `arr.length >= i` passed clean. Now handles both.
2. `checkOffByOneTerminalAccess`'s `X.length + k` addition only checked length-on-the-left —
   `arr[1 + arr.length]` (operands swapped) passed clean. Now checks both operand orders.
3. `checkAssignmentInCondition` only visited `if`/`while`/`do-while` — `for (...; i = 1; ...)`
   (same always-truthy-assignment typo, different statement) passed clean. Now also visits a
   for-loop's own condition slot; verified no false positive on the legitimate
   `while ((x = next()) != null)` resumed-value idiom.
4. `checkNaNComparison` only matched the bare `NaN` identifier — `x === Number.NaN` (same
   global value, spelled via the `Number` namespace) passed clean. Now matches both forms.
5. `checkDivideByZeroLiteral` only matched the binary `/`/`%` operators — the compound
   assignment forms `x /= 0`/`x %= 0` (same bug) passed clean. Now matches both.
`__localHardenCheck_bench.ts` grew 10→16/16 (one regression case per fix). `tsc` clean,
`prove:all` 250/250 unchanged. All 5 are genuine reversed-operand/unvisited-statement blind
spots in a pattern-matching AST scanner — exactly the kind of gap that's invisible until you
go looking for the mirror-image of each existing pattern, which is what this pass did
systematically rather than waiting for a live sweep to surface one by accident.

**Cont. 22 recap (prior entry, kept for continuity):** found and fixed 5 real defects across
the fuzz-property gate (set-op-diff/intersect completeness, comparator degenerate-zero, clamp
flakiness) and the stakes-router (multi-tool-call gating, create_tool body scanning).

**Cont. 21 recap (prior entry, kept for continuity):** items 1 (frontend clarification
consumer) and 3 (HITL stakes-router) turned out to already be built, uncommitted, just
undocumented. Item 2's `leaderboardModule` Set-dedup bug was fixed (sort-family fuzz range
narrowed). See git history of this file / [[crucible-priority-ladder-2026-07-04]] for detail.

**Cont. 22 (this session) — driven by an explicit "keep going, no API calls, frontier-rivaling,
don't stop for input" directive. Audited every fuzz family and the stakes-router's own
documented scope gaps rather than picking a new task; found 4 more real, previously-invisible
defects in the verification layer itself.**

1. **`set-op-diff`/`set-op-intersect` fuzz properties had NO completeness check — `() => []`
   passed both silently, always, regardless of input.** Only "nothing foreign appears in the
   result" was ever checked, never "every qualifying element is actually present." Confirmed
   live: a candidate that always returns `[]` for `differenceArrays`/`intersectArrays` passed
   the gate with zero findings. Fixed both properties to also assert every expected distinct
   value is present (mirrors `set-op-union`'s existing two-directional check), and narrowed all
   three set-op families' integer range to `{min:0,max:8}` so `a`/`b` actually overlap often
   enough to exercise the new check (`localHardenFuzzWorker.cjs`). Added 2 regression cases.

2. **`comparator` property couldn't detect a degenerate "always return 0" comparator** — a
   comparator that treats every pair as equal trivially satisfies the old antisymmetry-only
   check (`a===b` branch aside, `ab===0 && ba===0` both hold). Confirmed live: `() => 0` passed
   clean. Fixed: for a distinct pair, `ab===0` is now itself a failure (documented as a
   heuristic tied to this family's naming convention — see the code comment on the honest
   tradeoff). Added 1 regression case.

3. **`number-transform-clamp`'s property was genuinely flaky — observed ~15-30% false-negative
   rate across repeated bench runs**, unrelated to anything touched this session or last.
   Root cause: `fc.double()`'s default arbitrary heavily biases samples toward "interesting"
   edge values (0, -0, tiny fractions) rather than spreading uniformly, even after an earlier
   narrowing to `[-1000,1000]` — so a real "never enforces the upper bound" bug only triggered
   on ~3 of every 4 bench runs instead of reliably every run. Switched `v`/`lo`/`hi` from
   `fc.double` to bounded `fc.integer({min:-1000,max:1000})`, which samples far more uniformly.
   Verified 20/20 clean bench runs after the fix (was ~15/20 before). This was a real
   reliability gap in a gate the whole zero-API vision depends on — a flaky critic is worse
   than a slow one, since it ships a false sense of "clean" some fraction of the time.

4. **Stakes-router scope gap #1 closed: multi-tool-call turns are now gated, not just
   lone-call turns.** `agent/loop.ts` (~420-438) previously only ran `assessStakes` when
   `turn.toolCalls.length === 1` — a destructive call co-emitted alongside benign ones bypassed
   the gate entirely (documented, not silent, but a real hole). Now scores every call in the
   turn and gates on the first high-stakes one found, holding the WHOLE turn (not just the
   flagged call) pending the user's answer. `stakesRouter-bench.ts` unaffected (pure-function
   logic didn't change, only the caller), still 11/11 → now 15/15 with item 5's additions.

5. **Stakes-router scope gap #2 closed: `create_tool` dynamic-tool bodies are now scanned for
   destructive native APIs at creation time.** A model-authored `create_tool` body is arbitrary
   JS, not shell-command text, so `destructiveReason()`'s shell-syntax patterns (`rm -rf` etc.)
   never saw it — a persisted tool calling `fs.rmSync`/`execSync`/etc. would register and
   auto-run in every future session with zero stakes gating, a real hole matching the module's
   own documented scope limitation. Added `destructiveToolBodyReason()`
   (`tools/registry.ts`) — coarse, deliberately-scoped native-API pattern scan (fs delete/
   overwrite, child_process exec/spawn) — wired into `assessStakes` for `toolName==='create_tool'`,
   gating at CREATION (a one-way door: the tool persists to disk and reloads on every future
   server start) rather than trying to recognize the tool's own name at later invocation time
   (which the router has no way to do generically). 4 new bench cases (destructive body → high;
   explicitly authorized → low; benign body → low).

**All changes this session:** `npx tsc --noEmit -p .` clean, `npm run prove:all` 250/250
unchanged throughout, `__fuzz_bench.ts` 20→27/27, `stakesRouter-bench.ts` 11→15/15. Every fix
directly re-verified against the exact buggy shape it targets (not just "tests pass").

**Not done this session:** stakes-router still doesn't cover `control_mac`/external
integrations or non-filesystem blast-radius classes (shared config/schema/migration edits) —
narrowed scope gaps, not closed ones. `localHardenCheck.ts`'s 5-shape AST scanner wasn't
audited for analogous gaps (only the fuzz/property layer was this session) — worth the same
audit treatment next. No live `smoke:code:offline` re-sweep of any task this session (all
verification was direct `runLocalHardenFuzz`/bench-level, not a full live FM regeneration).
Nothing was committed — `git status` still shows the same ~19 modified/untracked files plus
this session's edits sitting in the working tree (per standing git-safety rules: never commit
without an explicit ask, which this session didn't get).

---

## SESSION LOG — 2026-07-04, cont. 19 (fuzz mutation-blindness for
sort/set-op/dedupe families CLOSED, and a real self-inflicted bug in that fix caught and fixed
before it shipped)

**Cont. 19 (this session): NEXT SESSION item 1 from cont.18 ("fuzz mutation-blindness") is now
CLOSED.** `src/CrucibleEngine/agent/localHardenFuzz.ts`'s `detectChecks` now emits a companion
`<kind>-no-mutate` check alongside `sort`, `set-op-union`, `set-op-diff`, `set-op-intersect`,
and `array-dedupe` (5 of the 8 families — the mutating-prone ones; `validator`/`string-
transform`/`comparator`/`number-transform-clamp`/`number-aggregate-sum` don't apply, they
return new values by construction). Each new `buildProperty` case in
`localHardenFuzzWorker.cjs` calls `fn` on the caller's own array(s) and asserts they're
unchanged afterward — independent of whether the return value is correct.

**Caught a real bug in the fix itself before committing it:** an earlier draft passed fast-
check's OWN generated array directly to `fn`. A candidate that mutates its input then corrupted
fast-check's internal shrink bookkeeping and hung — reproduced standalone with a debug counter
showing an infinite shrink loop stuck replaying the identical counterexample forever (not a
candidate infinite loop — the CANDIDATE terminated fine each call; fast-check's own shrink
driver never converged). Fixed by always `.slice()`-ing a private copy before handing anything
to `fn`, never passing fast-check's array by reference. This is worth remembering as a general
rule for any future "call fn on the real object and check for mutation" property: never let that
real object be the one the property-testing library owns.

`__fuzz_bench.ts` extended 20→23 cases (3 new mutate-but-otherwise-correct cases covering
sort/union/dedupe), all pass, no hang, no timeout. Manually reproduced the EXACT
`leaderboardModule` shape from cont.17 (`sortScoresAscending(scores) { return
scores.sort(...) }`) directly against `runLocalHardenFuzz` — now flags it via `sort-no-mutate`
(`Counterexample: [[1,0]]`), closing the loop cont.17 opened when the hidden suite caught it but
fuzz didn't. `npx tsc --noEmit` clean, `npm run prove:all` → 250/250 unchanged.

**Not done this session:** `__fuzz_bench.ts` and `localHardenCheck.ts`'s own bench are still
standalone scripts, not wired into `npm run prove:all` (item 4 below, unchanged from cont.18).
Priority-ladder items 2 (generation accuracy) and 3 (HITL router) untouched. No live
`smoke:code:offline` re-sweep this session (the fix was verified via the bench + a direct
`runLocalHardenFuzz` repro of the known-buggy shape, not a fresh end-to-end FM generation run —
worth a live re-confirm next session if a `sort`-family task gets regenerated).

---

**Cont. 18 (prior session) — ambiguity.ts got its first regression bench, 9/9, locking in
cont.17's VERB_STOPLIST fix; fuzz layer got its first LIVE positive catch; families broadened
6→8; generation-stress suite broadened 3→5; HITL Workstream 2 got one narrow, verified
data-shape slice)

**Cont. 18 addendum (same day, small follow-up):** `src/CrucibleEngine/ambiguity-bench.ts`
added (`npm run ambiguity:bench`, 9/9) — this module had zero test coverage before. Covers the
`VERB_STOPLIST` regression (`validateEmail`/"that returns" no longer flips to ambiguous), "fix
the parser" resolving against a fake `SemanticIndex` for single/zero/multi-match cases and with
no index at all, plus baseline `no-target`/`vague-scope`/`underspecified-behavior` signal
firing. Standalone `tsx` script, no framework (matches `__critic_bench.ts` convention — repo
has no test runner configured). Does not change any behavior in `ambiguity.ts` itself and does
not touch item 2 below (still unwired into the live path).

**Mandate this session: (1) get the fuzz layer a live positive catch, (2) broaden fast-check
families past 6 and/or commit a real bench, (3) broaden generation-stress suite past 3 tasks,
(4) build HITL/AFK Workstream 2. All four addressed; (4) deliberately scoped narrow, not the
full router.**

**1. Fuzz layer bench committed — `src/CrucibleEngine/agent/__fuzz_bench.ts`, 20/20.**
Replaces cont.15's 4-case ad hoc scratch verification with a real, committed test covering
every family, true-positive AND true-negative each (same discipline as `localHardenCheck`'s
bench convention). Run: `npx tsx src/CrucibleEngine/agent/__fuzz_bench.ts`. NOT yet wired into
`npm run prove:all` (kept standalone, consistent with cont.12-16's precedent of not yet
formalizing these gate benches into that harness — a real next step, not done this session).

**2. Families broadened 6 → 8** — added `array-dedupe` (`dedupe*`/`unique*`/`distinct*`,
arity 1: no duplicate values in output, every distinct input value present, no foreign values)
and `number-aggregate-sum` (`sum*`, arity 1: output equals the exact numeric sum) to both
`localHardenFuzz.ts`'s `detectChecks` and `localHardenFuzzWorker.cjs`'s `buildProperty`. One
tuning fix caught by the bench itself: `array-dedupe`'s property initially used
`fc.array(fc.integer())` (full int32 range), which almost never generates actual duplicates,
so the "leaves duplicates in" bug case went undetected — narrowed to
`fc.integer({min:0,max:5})` so generated arrays collide often enough to exercise the property.
`npx tsc --noEmit` clean; `npm run prove:all` → 250/250 unchanged.

**3. Generation-stress suite broadened 3 → 5, AND a root cause found for why the fuzz layer
had never fired live before this session:** `filterModule`/`sortModule`/`summaryModule`'s
real exported APIs never match ANY fuzz family by name+arity convention (e.g.
`sortProducts(products, opts)` is arity 2, not the arity-1 `sort` family) — so the fuzz layer
had zero surface area on the existing suite regardless of how many live sweeps ran. Added two
new repo-context tasks to `coding-benchmarks.ts`'s `TASKS` array, deliberately shaped to land
inside a family's detection window: `clampModule` (`clampVolume(value,min,max)`, arity 3,
`number-transform-clamp` family) and `leaderboardModule` (`sortScoresAscending(scores)`,
arity 1, `sort` family). Each has a hidden adversarial suite
(`src/CrucibleEngine/coding-bench/{clampModule,leaderboardModule}.hidden.ts`, same convention
as the existing three) — these were MISSING on first run and crashed `auditTask`'s
`copyFileSync` (ENOENT); fixed by adding both hidden files before the confirming re-run.

**4. LIVE fuzz catch — CLOSES the "only scratch-verified" gap.** Restarted `:3001` with
`CRUCIBLE_OFFLINE=strict` in the server's own env (one clean LISTEN pid verified), ran
`npm run smoke:code:offline -- clampModule leaderboardModule` end to end (real agent fires,
real FM generation, no mocking). `.crucible/gate-telemetry.jsonl` recorded, live, during the
`leaderboardModule` run:
```
{"gate":"harden","ran":true,"reason":"local-fallback (reviewer error: [offline-escalate] critic turn class has no offline equivalent — routing to local harden fallback): findings [+1 fuzz]"}
```
appearing twice — the fuzz layer contributed a real finding during the FM's 9-round
generation loop for `leaderboardModule` (a `sort`-family match), on a genuinely live sweep,
not a scratch script. Priority-ladder item 1's "has it ever caught anything live" flag,
open since cont.15, is now CLOSED. Scorecard: `clampModule` GREEN (hidden suite 9/9,
generated path); `leaderboardModule` RED — the FM's final candidate sorted correctly but
mutated its input array in place (`scores.sort(...)`, no copy), a real bug the HIDDEN suite
caught. Honest gap: fuzz's `sort` property always calls `fn(arr.slice())` (a defensive copy),
so it structurally cannot see mutation-of-input bugs — only the hidden suite's own explicit
mutation check caught this one. Not fixed this session (would need a second property variant
that passes the caller's own array and checks it's unchanged) — flagged as a concrete next
family-hardening step, not assumed away.

**5. HITL/AFK Workstream 2 — one narrow, verified slice, NOT the full router.** Read
`HITL_PLANNING_TRACK.md` §3 (MC-first clarification + visible recommended default) against
the ALREADY-LIVE `ambiguity.ts` (Tier 2.4, code-agent pre-synthesis check) rather than
building a new parallel mechanism per §7's own open question. Added
`clarificationOptions?: string[]` + `recommendedOption?: string` to `ResolutionResult`,
populated ONLY for the `unresolved-reference`-with-multiple-candidates signal — the one
existing signal type with a genuinely enumerable answer set (the candidate symbol list).
Deliberately did NOT force fake MC options onto `no-target`/`vague-scope`/
`underspecified-behavior` (open-ended by nature; a wrong-shaped list would violate this
module's own zero-guessing discipline). Verified: multi-candidate case produces correct
options (`["parseTokens (src/parseTokens.ts)", "parseExprTree (src/parseExpr.ts)", "Something
else / not sure"]`) + recommended default; vague-scope case correctly has none; `npx tsc
--noEmit` clean. **Not done:** wiring this into the actual live path — the only current
caller, `nodeExecutor.ts`, is the PARKED capabilityRouter/decompositionDag stack per
[[crucible-agentic-architecture]], not `agent/planner.ts`+`loop.ts`. Wiring the MC options
into `loop.ts`'s real `ask_user`/`'clarification'` stop reason (loop.ts:356) is the natural
next step and wasn't attempted this session. Everything else in the design doc (§2 stakes
router by reversibility/blast-radius, §4 self-directed tool suggestion, §5 skill library, §6
UX refinements) remains unbuilt — see HITL_PLANNING_TRACK.md §8 for the full status writeup.

**Found in passing, FIXED same session (spawned as background task `task_8da28286`, completed
before this doc was finalized):** `ambiguity.ts`'s `DEF_REF` regex spuriously matched ordinary
prose like "...that returns true..." as a definite-article code-symbol reference, flipping an
otherwise well-specified request to `ambiguous:true` whenever an `index` was supplied and no
symbol matched. Fixed with a `VERB_STOPLIST` (returns/is/has/does/matches/... and conjugations)
checked alongside the existing `STOP_REFS` set. Re-verified live after the fix: the
multi-candidate `clarificationOptions` case (this session's own addition) still works
unchanged, and the previously-false-positive case now correctly reports `ambiguous:false`.
`npx tsc --noEmit` clean.

**Verification summary, all real (not assumed):** `__fuzz_bench.ts` 20/20 (8 families × TP/TN);
`npx tsc --noEmit -p tsconfig.server.json` clean throughout (pre-existing `_author_parsers2.ts`
TS1109 aside, not mine); `npm run prove:all` → 250/250 unchanged; one live
`smoke:code:offline` sweep against a freshly-restarted `:3001`, confirmed via the real
`.crucible/gate-telemetry.jsonl` ledger, not console text or assumption.

**NEXT SESSION — HIGH TIER ITEMS (concise), superseding the 2026-07-04 list below:**

1. ~~Fuzz mutation-blindness~~ DONE cont.19 (`sort-no-mutate` + 4 set-op/dedupe companions,
   see CURRENT STATE above). Live re-confirm via a fresh `smoke:code:offline` sweep on a
   `sort`-family task is still worth doing (this session verified via bench + direct repro of
   the known-buggy shape, not a brand-new end-to-end FM generation run).
2. **Wire ambiguity.ts's new `clarificationOptions` into the live path** —
   `agent/planner.ts`+`loop.ts`'s real `'clarification'` stop reason (loop.ts:356), not the
   parked `nodeExecutor.ts`. Currently computed but unconsumed anywhere live.
3. ~~Fix the DEF_REF false-positive~~ DONE (`VERB_STOPLIST`, see cont.18 above).
4. **Commit `__fuzz_bench.ts` (now 23/23) into `npm run prove:all`** rather than leaving it
   standalone — same formalization gap cont.12-16 left open for `localHardenCheck`'s bench too.
5. **Generative coding accuracy remains the deeper open item** — `leaderboardModule`'s
   mutation bug is itself fresh evidence for priority-ladder item 2 (thin/under-measured
   accuracy on novel tasks): even a 9-round FM loop converged on subtly-wrong code that only a
   hand-written hidden suite (and now fuzz, post cont.19) caught.
6. Items 3 ("Second Workstream 1 critic") and 6-7 (pre-existing `_author_parsers2.ts` TS1109;
   e002/e005 explain-category retrieval gaps) from the 2026-07-04 list are UNCHANGED, not
   touched this session — see that list below for full detail, still accurate.

**Composite benchmark baseline (conversational suite) as of last confirmed sweep (2026-07-03,
N=3 post premise-gate fix):** pass 0.920 ± 0.000 — unrelated to and not re-run this session.

---


## SESSION LOG — 2026-07-04 night (fail-open gate telemetry — IMPLEMENTED, VERIFIED, CLOSED; found grounding+harden dark)

Shipped `debug/gateTelemetry.ts` + wiring into gateA2_lint/grounding/harden (`c79da7c`).
Full detail in ROADMAP CHANGE LOG (2026-07-04 cont. 8). Key facts a future session needs:
- `.crucible/gate-telemetry.jsonl` is the ledger; console.warn fires once per gate per
  process on first skip. recordGate() is best-effort and must stay that way.
- smoke:code verifies THROUGH the running `:3001` server process — telemetry (and any
  in-process change) is invisible until the server is restarted onto the new commit.
  prove:all and the catalog path bypass the oracle's verifyCandidate entirely and will
  never generate gate telemetry; only gen-path traffic exercises it.
- First instrumented sweep: grounding 0/2 usable verdicts, harden 0/3 — both fail open
  every time (FM glue turn returns no JSON / empty text). This is now CURRENT STATE item 0.

## SESSION LOG — 2026-07-03 (N=5 confirmation + premise-gate explain-category fix — IMPLEMENTED, VERIFIED, PARTIALLY CLOSED)

**Mandate: run the N=5 confirmation sweep parked from last session, then work down the
open-items list (explain category / Frontier-SWE-gap) as far as comfortable, flagging
decision points rather than guessing priorities.**

**N=5 confirmation sweep — DONE, cl001/cl003 fix CONFIRMED ROBUST:**
- clarify **1.00 / 1.00 across all 5 runs**, zero flips — not a single-run fluke.
- Composite baseline (pre-fix, N=5): pass **0.924 ± 0.008** [0.92, 0.94], cov **0.942 ± 0.004**.
- All other categories held their clean bands (general/definition/abstain/reasoning/
  false-premise all 1.000 ± 0.000). Only `explain` (0.526 ± 0.052) and one flipper
  (e007, GPS wording variance) kept the composite off a perfect 1.0.
- Infra note: the sandbox environment reset mid-run once (port 3001, FM daemon, and all
  `/tmp` scratch state wiped simultaneously, mid-background-process). Git tree was
  untouched. Recovered by restarting the FM daemon (`local-inference/crucible-fm-daemon`,
  not yet a launchd service — see [[crucible-track-s-local-inference]]) and the server,
  then relaunching the sweep from scratch. If this recurs, treat any long
  background/scheduled-wakeup run as possibly needing a full respawn, not just a log check.

**Root-caused explain-category always-fail (e002, e005) — NOT what prior sessions assumed:**
Prior handoffs called this "pre-existing DAG-mangles-explainers." Actual mechanism, traced
via `/api/debug/history` on live fires:
- `checkPremiseGrounding` (`researchDag.ts` — the "Bug A" false-premise fix from an earlier
  session) ran **unconditionally on every research-DAG answer**, not just questions with an
  embedded false premise. On ordinary "explain how X works" questions, the on-device FM
  still gets asked "does the verified fact contradict this question's presupposition?" and
  answers yes with high confidence — hallucinating a contradiction where none exists.
- **e005** ("Explain the water cycle"): a good, complete, grounded 677-char answer was
  discarded in favor of the FM's "correction," which cut off mid-word.
- **e002** ("How does a refrigerator keep food cold?"): the FM's "correction" directly
  negated its own cited source — "Solar-powered refrigerators do **not** keep food cold"
  while the quoted evidence says they can. Confidently wrong AND self-contradicting.
- e003 ("Why is the sky blue?") is unrelated — genuine leaf-level abstain (no source found),
  the already-accepted strict-mode corpus-coverage tradeoff from 2026-07-01. Not a bug.

**Fix — `isPremiseBearing` gate, committed `311ae9f`:**
New primitive in `leafPrimitives.ts` (Primitive 3a) classifies the question as
CLAIM (myth/trivia-shaped, checkable assertion about a named subject — reaches the
existing correction path) or MECHANISM (explaining a well-established phenomenon — skips
it, keeps the grounded synthesis untouched). Wired into `researchDag.ts` ahead of
`checkPremiseGrounding`.

**Verified over 3 fresh full CONVOEDGE_50 sweeps post-fix:** zero regressions.
false-premise held **1.00 ± 0.000** across all 3 (fp001-4 untouched — they're
CLAIM-classified and still reach the correction path). All other categories unchanged.
Composite passRate rock-stable at **0.920 ± 0.000** across the 3 runs. The truncation and
self-contradiction bugs are gone — confirmed by direct re-fire, not just aggregate score.

**Cache-poisoning side-investigation (e002) — dead end, real finding:**
`.crucible/research-claims.json` had a stale claim keyed to "how does a refrigerator keep
food cold" mapping to an off-topic *solar-powered*-refrigerator fact — looked like classic
cache poisoning. Purged it (backed up first to `/tmp/research-claims.json.bak-preclean`,
user-confirmed before the destructive write — the auto-mode safety classifier correctly
blocked two earlier attempts as under-authorized). **Did not fix e002**: fresh live
retrieval reproduces the identical mismatch. The real root cause is the web-search/ranking
layer itself consistently preferring the "Solar-powered refrigerator" Wikipedia article over
the general one for this query — a retrieval-ranking issue, not a cache/data issue. Bigger
and differently-scoped than what was authorized this session; explicitly NOT investigated
further — flagged for a future session to pick up deliberately.

**Current state (post-session, N=1 spot-check):** overall passRate 0.92–0.94 depending on
run (e007 remains a wording-variance flipper, not a regression). explain 0.5–0.63 (e001,
e004, e006, e008 clean; e002/e003/e005 fail for three now well-characterized, distinct
reasons — see above).

**STILL OPEN (unchanged from before, plus one new item):**
- e002 — retrieval/web-search ranking prefers an over-specific source. NEW finding this
  session, not previously diagnosed at this depth. Needs its own scoping conversation.
- e003 — accepted strict-mode corpus-coverage tradeoff (2026-07-01 decision), unchanged.
- e005's remaining gap (post-fix) — the grounded source is accurate but framed around
  water mass-balance rather than evaporation/condensation; a retrieval-content-relevance
  gap, distinct from the truncation bug just fixed.
- Frontier-SWE-gap phase — still untouched. Note: ROADMAP.md's gating condition
  ("timeout verification/regression, clarify wiring, and any still-open false-premise/trust
  diagnosis") no longer names an unresolved item verbatim — timeout and clarify are closed,
  and today's fix hardened the false-premise/trust path further. Whether that means the gate
  is now open is a judgment call left to the user, not decided here.

---

## SESSION LOG — 2026-07-02 (cl001/cl003 clarify-wiring — IMPLEMENTED, VERIFIED, CLOSED)

**Mandate: pick up the parked clarify-wiring thread (cl001/cl003, stuck at 0.500±0.000
across every prior sweep). Diagnose in isolation, fix, confirm against the full
CONVOEDGE_50 sweep before closing.**

**Also closed as a side effect of session-start housekeeping:** the working tree had
gone a long stretch with zero commits (757 files / ~48k lines of accumulated,
undocumented WIP across many sessions — a new chat-conversations store, synthDriver.ts,
researchDag.ts, retrievalLayer.ts wiring, the synth skill library, Electron launch
pipeline, Off-Fly cutover staging, and the corpus-acquisition strict-mode gate this
doc had flagged as still-open — that gate was in fact already fixed, just uncommitted).
All of it is now one checkpoint commit on `crucible-northstar-sessions`. Recommend
committing at the end of every session going forward instead of letting this
accumulate again.

**Root cause — TWO bugs, not one:**
1. The offline-conversational path (`solveNonCodeTurn`, server.ts ~3090) had no
   pre-check for under-specified requests at all — unlike the code-agent path, which
   has a dedicated Tier 2.4 (`ambiguity.ts`) that resolves-or-asks before synthesis.
   Conversational turns just got handed straight to the FM, which always tries to
   produce a confident answer.
2. Compounding it: Track M1's casual-mode short-circuit (`detectConversational` in
   `conversationalMode.ts`, server.ts ~2857) treats any message ≤4 words with no
   `DOMAIN_SIGNAL_WORDS` hit as small talk, and instructs the local model to "mirror
   exactly what was sent." "Book it for tomorrow." (4 words, no domain-signal word —
   `book` isn't in that list) fell into this bucket and got echoed back verbatim
   before ever reaching the conversational pipeline. `translate`/`fix` *are* in
   DOMAIN_SIGNAL_WORDS, so cl002/cl004 were already skipping M1 — this is why the
   bug looked partial rather than total across the 4 clarify cases.

**Fix — new file `src/CrucibleEngine/conversationalClarify.ts`:**
Pure, deterministic, zero-inference — same philosophy as the abstain/false-premise
checks, extended to the "under-specified" failure mode. Three narrow detectors:
- action verb (book/schedule/translate/send/order/buy/...) + a bare dangling pronoun
  object (it/this/that/them) in a short command → ask what it refers to.
- immediate-tense weather question with no location given → ask which location.
  Deliberately excludes far-future/impossible-horizon phrasing (digits, "in exactly
  N days") so it never intercepts a006-style abstain cases — those must still abstain,
  not ask for a location that wouldn't help anyway.
- "fix/solve/debug/resolve the bug/issue/error" with no file path, error text, or
  code identifier → ask which bug/file.

Wired in at TWO points originally (before M1's casual short-circuit, and again before
`solveNonCodeTurn`); the second was provably dead code once the first was in place
(strict subset of the same guard condition, same message, no way to reach it with
`needsClarification` still true) — removed it, kept only the M1-level check.

**Verification (empirical, not assumed):**
- Pure-function check against all 50 CONVOEDGE_50 prompts (no server): exactly the 4
  `cl0xx` prompts fire, zero false positives on the other 46 — including a006
  ("weather... in exactly 100 days"), which stays correctly unintercepted (still
  reaches the FM's own abstain behavior).
- Live N=1 full CONVOEDGE_50 sweep on `:3011` strict, post-fix:
  - **clarify: 1.00 / 1.00 (was 0.500 ± 0.000)** — all 4 pass, ~0ms each (short-circuits
    before any model call).
  - general 1.00, abstain 1.00, false-premise 1.00, reasoning 1.00 — all held their
    prior clean bands exactly.
  - definition 0.88 — the one miss is d005, the same pre-existing surface-form flip
    already documented in the prior session's log, not a new regression (only
    definition-path-independent code changed this session).
  - explain 0.50 — unchanged, still parked, not touched.
- Re-confirmed live after removing the dead second insertion — all 4 cl0xx still pass.

**Not done / open for next session:** N=5 confirmation sweep (this session ran N=1
live + the full-50 pure-function check, per the standing "isolate then confirm"
pattern, but hasn't yet repeated the live sweep 5x the way the daemon-timeout fix did
before updating the baseline of record). Composite baseline not yet formally updated —
do that after an N=5 run. explain category and Frontier-SWE-gap phase remain parked,
untouched this session.

---

## SESSION LOG — 2026-07-02 (daemon-timeout fix — IMPLEMENTED, VERIFIED, CLOSED)

**Mandate: implement fix (d) mislabeled error string + fix (a) FM_TIMEOUT_MS 30s→45s,
verify r001 in isolation, then full convoedge-50 regression N=5 before updating baseline.
DONE — both fixes landed, isolation confirmed clean, full regression confirmed clean.**

**Code changes (both live in the repo now, not yet committed to git — this project isn't
a git repo; changes are just on disk):**
- `src/CrucibleEngine/agent/fmReact.ts`: `FM_TIMEOUT_MS` raised `30_000` → `45_000`, with a
  comment explaining why (healthy generation measured 21-28s, already against the old
  ceiling).
- `server.ts` (~3121, the `offline_conversational_escalate` catch block): now distinguishes
  `e.name === 'TimeoutError'` (FM_TIMEOUT_MS abort — daemon healthy, just slow) from a
  genuinely unreachable daemon (`OfflineEscalateError` health-check failure, or
  `ECONNREFUSED`/`ECONNRESET`) from any other solve failure, and reports the correct one of
  three distinct abstain strings instead of always claiming "daemon is unreachable". Also
  added `errName` to the `debugBus.emit` diagnostic event for future debugging.
- Verified empirically (not assumed) that `AbortSignal.timeout()` rejects with
  `e.name === 'TimeoutError'` and a real `ECONNREFUSED` rejects with `e.name === 'TypeError'`
  + `e.cause.code === 'ECONNREFUSED'`, on this Node version (v26.4.0), before writing the
  distinguishing logic — see the node -e repro if this ever needs re-verifying.

**r001 isolation re-test (CONFIRMED, N=10 cold + N=10 warm, :3011 strict, new code):**
- First attempt (both :3001 and :3011 freshly restarted together, corpus background
  acquisition actively running): cold 8/10 (80%), warm 6/10 (60%) — better than the old
  47%/25% baseline but not at the ~90%+ target.
- Root-caused the shortfall to a confound, not the fix: `initCorpus()` at server.ts:6394
  kicks off a background "deliberate-curation acquisition" cycle (fetches from arxiv.org)
  on EVERY boot with no `CRUCIBLE_OFFLINE` gate — a genuine external-call-under-strict leak,
  same bug class as the already-fixed Hunter boot probes but NOT covered by that fix. It was
  actively running (visible in the :3011 log) during the first isolation attempt and is the
  likely source of the elevated latency/failures (CPU contention on this 8GB machine, not a
  timeout-margin problem).
- Re-ran with `CORPUS_AUTOACQUIRE=0` (existing env escape hatch, used only to get a clean
  benchmark signal — does NOT fix the underlying gate-missing bug): **cold 10/10 (100%),
  warm 10/10 (100%)**, latencies 21-37s, comfortable margin under the new 45s ceiling. This
  is the confirmed result — the timeout fix works.
- **New finding NOT fixed this session** (flagged as a background task chip for the user,
  task_7db1d756): gate `initCorpus()`'s `autoAcquire` behind `CRUCIBLE_OFFLINE === 'strict'`
  the same way the Hunter probes were gated. Until fixed, `:3011` (and any strict instance)
  leaks external arxiv calls at boot, violating the "no external calls under strict"
  standing constraint.

**Full convoedge-50 regression sweep (CONFIRMED N=5, :3011 strict, `CORPUS_AUTOACQUIRE=0`
to keep the corpus-acquisition confound out of the measurement):**
- Composite pass: **0.876 ± 0.015** [0.86, 0.90] (was 0.868 ± 0.020 [0.84, 0.90] stale).
- Composite cov: **0.896 ± 0.010** (was ~0.886 ± 0.014 stale).
- Per-category (5-run band):
  - general **1.000 ± 0.000** — unchanged, clean.
  - abstain **1.000 ± 0.000** — unchanged, clean.
  - definition **0.976 ± 0.048** — unchanged, clean (one d005 flip, pre-existing surface-form
    variance, not new).
  - false-premise **1.000 ± 0.000** — unchanged, clean.
  - reasoning **1.000 ± 0.000** — UP from 0.888 ± 0.056. This is the fix's headline result:
    the r001/r004 daemon-timeout flake is gone, confirmed at N=5, not a single-run fluke.
  - explain **0.502 ± 0.079** — roughly flat vs 0.552 stale (within the category's known
    instability — e004/e008 hit the *harness's own* 180s outer fetch timeout twice across
    5 runs, unrelated to FM_TIMEOUT_MS; e007 flipped again as previously documented). Still
    parked, not touched this session.
  - clarify **0.500 ± 0.000** — unchanged, still parked.
- **general/abstain/definition/false-premise held their prior clean bands exactly — no
  regression from the shared FM_TIMEOUT_MS constant change.** reasoning is the only category
  that moved, and it moved up.

**Infra note for future sessions:** during this session's long benchmark runs, the `tsx`
node server processes for both `:3001` and `:3011` died silently (no crash log, no
exception) mid-run on the machine's tight 8GB memory (observed 60-150MB free / 7.5-7.7GB
used while both servers + FM daemon were up). The compiled Swift FM daemon (`:11435`) never
died. Worked around by (1) temporarily stopping `:3001` during the :3011 sweep and (2)
wrapping the sweep loop in a self-healing restart-if-down check. `:3001` was restored to its
normal non-strict default config at the end of the session. If this recurs, consider not
running `:3001` and `:3011` simultaneously for long unattended benchmark runs on this
machine, or a launchd-based restart-on-exit supervisor (already flagged as a TODO in the
run-commands memory for the stale-process hazard, same root cause: this box can't
reliably keep long-lived nohup'd node processes alive unsupervised).

**Baseline updated. Daemon-flake thread CLOSED** (per the standing constraint, closes once
verified clean — it now is, at confirmed N=5). New baseline of record: composite
0.876 ± 0.015, per-category as above. cl001/explain/Frontier-SWE-gap remain parked,
not started this session, per the explicit "stop and report" instruction.

**Open for the user:** decide whether to pick up the newly-flagged corpus-acquisition
strict-mode leak (chip already spawned) before or alongside the next parked item.

---

## SESSION LOG — 2026-07-01 (roadmap addition — Frontier-SWE gap phase queued)

**User-provided roadmap addition incorporated into `ROADMAP.md`, not started.**

- Added a queued phase near the top-level build order: **Closing the Frontier-SWE Gap**.
- Preserved the honest framing: the target is not frontier-model parity, but reliable
  autonomous handling of conventional, well-specified, tool-verifiable engineering work
  plus explicit escalation for judgment-heavy remainder.
- Preserved sequencing: this phase starts only after current trust-bug work closes
  (timeout verification/regression, clarify wiring, and any remaining false-premise/trust
  diagnosis). Do not start Workstream 1 in parallel.
- Captured the three workstreams:
  1. deterministic critic tooling,
  2. upfront elicitation / ambiguity surfacing,
  3. out-of-depth tripwire.
- Open user decision remains: which Workstream 1 critic to build first once the phase
  actually starts (static-analysis gating, contract/interface checking, fuzzing/property
  tests, security scanning, or known-bad-pattern scanning).

---

## SESSION LOG — 2026-07-01 (timeout fix verification — PARTIAL, interrupted by architecture pivot)

**Mandate resumed from platform handoff:** verify the Tier-3 FM timeout/error-label fix on
:3011 strict, then run full convoedge-50 regression before closing. **Partially done only.**

**Verified code/runtime state:**
- Actual repo root confirmed as `/Users/justin/crucible-local/crucible-local`.
- `:3011` was listening as PID **11165**.
- `src/CrucibleEngine/agent/fmReact.ts`: `FM_TIMEOUT_MS = 45_000` confirmed present.
- `server.ts` strict catch block confirmed present: distinguishes `TimeoutError` from
  genuinely unreachable daemon errors and reports timeout as "local model is taking too
  long to respond (timed out)".
- Apple FM daemon health on `:11435` returned `status: ok`.

**r001 isolation post-fix (confirmed N=10 cold + N=10 warm, :3011 strict):**
- Cold back-to-back: **9/10 pass (90%)**.
- Warm/loaded back-to-back: **9/10 pass (90%)**.
- The two failures were exact **45.0s timeout** abstentions, now correctly labeled as
  timeout rather than "daemon unreachable".
- Several successful fires landed above the old 30s ceiling (e.g. 32-44s), so the 45s
  bump is a real improvement. However, the new ceiling still has limited slack; 45s is
  not a complete elimination of the timeout edge under sustained load.

**NOT YET DONE / still required before closing this fix:**
- Full convoedge-50 sweep **N=5 minimum** on :3011 strict.
- Confirm general/abstain/definition remain near prior clean bands.
- Update per-category confirmed numbers only after that N>=5 sweep.
- Surface the :3001 restart decision after the full sweep is clean; do not restart
  :3001 unilaterally.

---

## SESSION LOG — 2026-07-01 (daemon-flake DIAGNOSIS — r001 isolation)

**Mandate: diagnose the r001 "daemon unreachable" flake in isolation (10-20x outside the
full sweep) to determine load-dependent vs standalone. Diagnose only, do not fix without
go-ahead. DONE.**

**ROOT CAUSE FOUND — it is a too-tight timeout, NOT a daemon crash/reliability issue, and
the "daemon is unreachable" label is WRONG.** Concrete measured numbers, r001 fired in
isolation against :3011 (strict), via scratchpad `r001_iso.ts` (fire() copied from
__convoedge_bench.ts):

- RUN A (cold, back-to-back N=15): **7/15 pass (47%)**. First 7 passed 21–24s, then #8–15
  ALL failed identically at exactly 30.0s.
- RUN B (warm, back-to-back N=12): **3/12 pass (25%)**. Passing fires were SLOWER (26–28s).
- RUN C (20s idle gap between fires, N=8): **6/8 pass (75%)**. Latencies 18–29s; the fastest
  (18–19s) appear only after idle recovery.

**Mechanism (traced through code, not assumed):**
- r001 ("I have $1000 to invest safely. What are some options?") is NOT research-shaped
  ("what are" ∉ isResearchShaped regex) and NOT complex → routes straight to Tier-3
  `fmDirectAnswer` (synthDriver.ts:162) → `callFm` with `FM_TIMEOUT_MS = 30_000` and
  `max_tokens: 1536` (fmReact.ts:32,46).
- A healthy r001 generation takes 21–28s — already RIGHT against the 30s ceiling. Any
  slowdown (sustained load, ANE throttle, warm-session degradation on the 8GB A18) pushes
  it past 30s → `AbortSignal.timeout` fires → caught → solveNonCodeTurn throws → server.ts
  catch (3121-3124) abstains with the hardcoded "local model daemon is unreachable" string.
- The REAL escalate reason (from /api/debug/history `offline_conversational_escalate`) on
  EVERY failure is `"The operation was aborted due to timeout"` — a slow generation, NOT an
  unreachable socket. The daemon `/health` stayed `ok` throughout, and a small direct prompt
  to :11435 returned in <1s during the failure window. Daemon never crashed.

**Verdict on the handoff's two diagnostic questions:**
1. Load-dependent or standalone? → **Load-dependent** (margin-vs-fixed-timeout). Back-to-back
   it degrades to 25–47%; 20s idle gaps recover it to 75%. NOT a standalone random crash.
2. Root-cause category? → **Timeout/throughput margin, NOT concurrency** (fires are strictly
   sequential — no concurrency backlog) and **NOT daemon reliability/crash**.
- This fully explains the ~80% in-sweep failure: during a 50-prompt sweep the daemon is
  continuously loaded, so r001-class generations sit in the 28–32s band and time out most
  of the time.

**Fix NOT applied (per trace-first / ask-before-fix constraint).** It is a tuning/structural
decision with tradeoffs, not a trivial bug. Candidate fixes to discuss:
  (a) raise `FM_TIMEOUT_MS` for Tier-3 direct answers (e.g. 45–60s) — simplest, but slow turns;
  (b) lower `max_tokens` for direct answers (1536 → ~768) — faster, shorter answers;
  (c) cap/cooldown the daemon under sustained load; (d) fix the mislabeled error string so it
  reports "timeout" not "unreachable" (low-risk, orthogonal, worth doing regardless).
**Open question for user: which fix direction, or stop here?**

NOTE: the 0.868 baseline's reasoning category (0.888 ± 0.056) is depressed by exactly this
timeout flake — once mitigated, reasoning should rise and stabilize.

---

## SESSION LOG — 2026-07-01 (re-confirmation sweep; 0.90 did NOT hold)

**Mandate this session: re-run convoedge-50 on :3011 to test whether the prior 0.90
composite was a stable baseline or a lucky single run. Result: it was the top of the
range, not the center.**

**Re-confirmation sweep — convoedge-50, N=5, :3011 (strict, no code changes):**
- Per-run passRate: **[0.90, 0.86, 0.88, 0.86, 0.84]**
- **Composite pass 0.868 ± 0.020 [min 0.84, max 0.90]**, cov 0.886 ± 0.014.
- The prior session's 0.90 = the single best run, not a representative baseline.
  **New ground-truth baseline going forward: ~0.87 (0.868 ± 0.020).**
- Stability: 42 always-pass, 5 always-fail (cl001, cl003, e002, e003, e005), 3 flippers.

**Per-category bands (N=5):**
- general 1.000 ± 0.000 · abstain 1.000 ± 0.000 · **false-premise 1.000 ± 0.000** (fp fix robust)
- definition 0.976 ± 0.048 · reasoning **0.888 ± 0.056** (was claimed 1.00) · explain 0.552 ± 0.064 · clarify 0.500 ± 0.000

**DIVERGENCE = SIGNAL, not noise (per standing constraint, called out plainly):**
- **false-premise held perfectly across all 5 runs** — the fp004 grounding fix is
  confirmed stable, not a one-run artifact. fp004 independently re-fired: genuine
  evidence-grounded negation ("did not purchase Alaska from Canada … sold by Russia",
  SOURCE-QUOTED), not a false-premise parrot. SOLID.
- **reasoning dropped from claimed 1.00 → 0.888 ± 0.056.** Cause identified: the
  daemon-unreachable flake the prior handoff flagged as "could be luck rather than a
  fixed issue" is REAL AND RECURRING. r001 flipped Ynnnn (1/5) — 4 of 5 runs returned
  "I can't answer this offline right now — the local model daemon is unreachable, and
  strict mode blocks external escalation." The prior 1.00 was the flake being absent
  that run, NOT a fix. This is the single biggest contributor to the composite drop.
- **e007 is NOT stable-pass** (prior log claimed "e007 now passes"): flipped YnYnn (2/5).
- e003 regression still present (always-fail, cov 0.50) — unchanged, still needs decision.

**Unchanged / re-confirmed:** :3001 PID 94614 still serving (non-strict, not flipped).
:3011 env CRUCIBLE_OFFLINE=strict confirmed. No code changes made this session — pure
measurement. fp004 rubric NOT reverted.

**USER DECISIONS (made this session, 2026-07-01):**
1. **Baseline → accept ~0.87 (0.868 ± 0.020) as the new ground truth.** 0.90 is retired as
   a one-run high, not a representative baseline. Compare future sweeps to ~0.87.
2. **e003 → ACCEPT tradeoff (a), logged as accepted.** "Why is the sky blue?" abstaining
   under PREMISE_RX→DAG is a KNOWN, ACCEPTED tradeoff. fp001-004 passing is the higher-value
   outcome; the FM-direct-fallback fix that would solve e003 would re-break fp001. Do NOT
   "fix" e003 by loosening PREMISE_RX or adding a no-evidence FM fallback — that path is
   closed by decision. (Option (b), a narrower evidence-absence signal, was NOT chosen.)
3. **Hunter boot probes → GATE under strict (DONE + VERIFIED this session, see below).**
4. **reasoning daemon flake → PROMOTED to a real tracked fix item** (no longer "parked
   infra"). It, not explain/clarify, is what gates reasoning (~4 composite pts). See
   "DAEMON FLAKE" below.

**DECISION 3 IMPLEMENTED — Hunter/waitlist external calls gated under strict:**
- `server.ts`: added `if ((process.env.CRUCIBLE_OFFLINE ?? '1') === 'strict') return` to all
  three external background tasks — boot Hunter (setTimeout, ~line 488), 24h Hunter
  (setInterval), and 6h waitlist scorer (updateWaitlistScores). Guard sits AFTER the
  existing `if (!apiKey) return`, matching the canonical strict convention at server.ts:2985.
- **Verified empirically:** restarted :3011 (strict) on gated code, waited past the 30s
  boot-Hunter delay. Pre-gate log (/tmp/crucible-3011.log) had **9** external probe lines
  (1 catalog fetch + 8 OpenRouter model probes). Gated log (/tmp/crucible-3011-gated.log)
  has **0**. The only remaining `[Hunter]` line is "Loaded 3 previously-discovered model(s)"
  — a LOCAL file read, not a network call. Chat path unaffected: fp004 re-fired post-restart
  returns the same grounded Russia negation (200, SOURCE-QUOTED). **The "no external calls
  under strict" constraint now holds literally — the 3-session re-flag thread is CLOSED.**
- **New :3011 PID 90630** (was 92024). Still strict, still serving fixed grounded corrections.
- NOTE: :3001 was NOT restarted (non-strict by design; the gate is a no-op there since the
  guard only triggers under strict — strict default NOT flipped). :3001 will pick up the gate
  on its next natural restart; no action needed.

**DAEMON FLAKE — now a tracked fix item (was parked):**
- Symptom: r001 (reasoning) returned "I can't answer this offline right now — the local
  model daemon is unreachable, and strict mode blocks external escalation" in 4 of 5 runs.
  This is the Apple FM daemon (port 11435) intermittently unreachable mid-sweep, NOT a
  routing/grounding bug. It depresses reasoning from a true ~1.0 to ~0.89 and is the single
  largest contributor to the 0.90→0.87 composite move.
- Next: investigate daemon liveness/reconnect (Track S Swift bridge, port 11435). Until
  fixed, reasoning numbers carry this flake — read sweep dips in reasoning as likely-daemon
  before assuming a real regression.

**STILL OPEN (unchanged, parked per standing plan):**
- cl001/cl003 clarify-wiring (0.50) — separate session, needs explicit go-ahead.
- explain e002/e005 (pre-existing DAG-mangles-explainers) — separate from e003.
- Frontier-SWE-gap roadmap phase — starts after cl001 + (now-closed Hunter) threads.

---

## SESSION LOG — 2026-06-30/07-01 (verification + :3001 restart)

**Verification of prior session's claims (both independently re-checked):**
- **Item 1 (fp004 "rubric artifact"): CONFIRMED.** Fresh fires against fixed :3011 return
  the grounded, *negated* correction ("The United States did not purchase Alaska from
  Canada … purchased from Russia in 1867", SOURCE-QUOTED, evidence-backed). The rubric
  failed only because the forbidden substring `from canada` matched inside the negation.
  The earlier 0.5 `/tmp/fp-strict.log` (22:57) was a STALE pre-restart :3011 run (it
  predated the 23:09–23:13 fixes), which is why it showed flat false-premise acceptance.
- **Item 2 (zero external chat calls under strict): CONFIRMED.** `/tmp/crucible-3011.log`:
  all 8 external (openrouter) hits are `[Hunter]` boot probes at lines 13–27, ALL before
  the first `/api/chat` at line 29. Chat region (lines 29–294) has zero
  groq/openai/anthropic/openrouter strings. Confirmed `:3011` env `CRUCIBLE_OFFLINE=strict`.

**DECISION 1 — :3001 RESTARTED on fixed code (user-approved Option A).**
- Old PID 89496 (started 2026-06-30 22:41:41) was objectively pre-fix (fixes landed
  23:09–23:13) and had `CRUCIBLE_OFFLINE` unset (NOT strict).
- Restarted with identical config (default PORT 3001, no env overrides — strict default
  NOT flipped, per standing constraint). **New PID 94614, started 2026-06-30 23:56:47.**
  Verified serving fixed grounded correction on fp004. `/tmp/crucible-3001.log`.

**DECISION 2 — fp004 rubric fixed (pre-authorized, applied after Item 1 confirmed).**
- `__convoedge50.ts` fp004: dropped bare `from canada` forbidden check; kept `russia`
  required and `canada in` (matches acceptance phrasing only, not the negation).
- Post-fix fp set N=5 on :3011: composite **1.0** (fp001–004 all 5/5).

**Final authoritative sweep — convoedge-50 N=5 on :3011 (strict, fixed):**
overall pass **0.90**, cov 0.91. Per-category: general 1.0 (12), definition 1.0 (8),
reasoning 1.0 (7), abstain 1.0 (7), **false-premise 1.0 (4)** [was 0.5], explain 0.63 (8),
clarify 0.5 (4). Remaining fails: e002/e005 (pre-existing explain), e003 partial
(NEW regression, cov 0.50), cl001/cl003 (parked clarify-wiring). e007 now passes.

**Still open / surfaced (NOT decided this session):** e003 regression tradeoff;
boot-time `[Hunter]` external probes under strict (3rd flag); cl001; explain category.

---

## PRIORITY 1 — Close the Learning Loop (The Compounding Gap)

**The problem:**
Crucible has all the pieces of a self-improving system — genealogy attribution, specialization
memory, quality predictor, triumvirate governance, ANIMA truth store, uncertainty surface — but
they feed into each other weakly. The system learns within a session and across sessions via EMA
weights, but it does not yet systematically identify what is working, extract the pattern, and
harden it into the pipeline configuration itself.

**What's missing:**
The self-patcher (`selfPatcher.ts`) exists and is documented as [x] but needs verification that
it is actually wired and firing. The specific missing behavior:

- After every N pipeline rounds (suggest 20), read the last 100 debug events
- Identify which pipeline stage most frequently precedes a low synthesis score
- Cross-reference with `quality-history.json` and `specialization.json`
- Propose a concrete config change (stage prompt tweak, model weight adjustment, early-exit
  threshold change) — not code, just config that the existing infrastructure can apply
- Route proposal through triumvirate (already built)
- Apply on approval, log to `.crucible/self-patches.json`
- Roll back automatically if quality predictor trend goes negative within 10 rounds

**Key distinction from fine-tuning:**
Crucible does NOT train model weights. It refines ITSELF — its routing logic, its stage prompts,
its scoring thresholds, its model selection weights. The models stay external and free. The
intelligence that compounds is in the pipeline configuration and the accumulated signal in
`.crucible/`. This is the correct framing of "self-improvement" for Crucible's architecture.

**Files to verify/fix:**
- `src/CrucibleEngine/selfPatcher.ts` — confirm it is actually called from server.ts on a schedule
- `src/CrucibleEngine/autoImprove.ts` — confirm `triggerImprovementPass()` is firing after rounds
- `GET /api/self-patcher/patches` — check this endpoint returns real data, not empty

---

## PRIORITY 2 — Regression Safety Net (Benchmark Suite)

**The problem:**
Architectural decisions — which models to favor, which pipeline stages to keep, which weights to
tune — are currently made based on feel and spot-checking. A bad patch could degrade answer
quality and would only be caught through user observation, not measurement.

**What's missing:**
Track E3 (benchmark suite) is marked [x] in the roadmap but needs verification it is actually
running continuously. Specifically:

- `.crucible/benchmarks.json` should exist with 50+ canonical questions and known correct answers
  across all prompt types (coding, reasoning, factual, math, creative, general)
- After every significant pipeline change, the suite should run in the background and record
  pass rates per category
- `GET /api/debug/benchmarks` should return rolling pass rates and flag any category that dropped
  more than 5% from its baseline
- The neuromorphic stress test (documented in ROADMAP.md) should be one of the benchmark entries
  with its 7-section pass criteria

**Implementation note:**
The benchmark runner should use the SIMPLE_PIPELINE_CONFIG (not full ensemble) to avoid burning
quota on self-testing. Results go to `.crucible/benchmark-results.json`. The signal is trend,
not absolute score — is the system getting better or worse over time on a fixed question set.

---

## PRIORITY 3 — "Shows Its Work" Mode (The Demo Mode)

**The problem:**
Crucible performs extraordinary reasoning — triadic dialectics, abductive synthesis, epistemic
calibration, ANIMA shaping, confidence annotation — and the user sees almost none of it. The
process trail exists but is collapsed by default and doesn't tell a coherent story.

**What's missing:**
A toggle in the UI (off by default, labeled something like "thinking visible") that expands the
synthesis to show:

- Which models agreed vs disagreed at Stage 1 (score variance visualization)
- What the Critic flagged (already stored in `criticProblems`)
- Which claims are HIGH vs LOW confidence (already stored in `round.confidence`)
- The fragile assumption (already stored in `fragilityAssumption`)
- What ANIMA detected and how it shaped the response (transparency layer already built)
- Cross-domain connections MASTERPIECE found (already stored in `masterpiece` field)
- Which model actually contributed most to the final synthesis (genealogy attribution)

**Why this matters:**
This is simultaneously the strongest marketing asset (visible reasoning beats any benchmark
number) and the best debugging tool (when something goes wrong, you can see exactly which stage
failed and why). It is not a new system — it is a UI layer over data that already exists in
every `Round` object. Estimated build: 2-4 hours in `App.tsx`.

**Design constraint:**
No emojis. No clutter. A single toggle that reveals/hides a structured breakdown panel below
the synthesis. Mobile-first — must work at phone width. Should feel like turning on subtitles,
not opening a dashboard.

**Status (June 14 2026):**
Genealogy contribution rates are now sent over SSE (`genealogy` event type) and displayed in
the process trail — showing which model contributed what fraction of the final synthesis.
`recordPipelineRun()` and `recordProbationOutcome()` wired. Probation status shown in topology.
The "toggle all open by default" version of Shows Its Work is still not built — the process
trail is still collapsed by default. A `showWork` boolean in state that auto-opens the
`<details>` elements and adds a toolbar toggle is the remaining work.

---

## PRIORITY 4 — Voice Pipeline (Mobile Transformation)

**The problem:**
Crucible on mobile requires typing. The Remote Brain track is documented but not built. Even
without the full screen-stream vision, a voice input → pipeline → spoken response loop would
transform how the system feels and dramatically expand its use cases.

**What to build (minimal viable version):**
1. Microphone button in the mobile input bar
2. On press: record audio, send to Whisper on HuggingFace Inference API (free, no key needed
   for public models, ~300ms transcription)
3. Transcribed text enters the normal pipeline
4. After synthesis, pass response text through Edge-TTS (Microsoft, free, no API key) for
   spoken playback
5. The response plays through the phone speaker while text is visible

**What NOT to build yet:**
The full Remote Brain (screen stream, Mac control, Bluetooth fallback) is a larger project.
Build the voice I/O loop first — it is self-contained and validates the audio pipeline
before adding the complexity of screen streaming.

**Key files to create:**
- `src/CrucibleEngine/voice/stt.ts` — Whisper HuggingFace wrapper
- `src/CrucibleEngine/voice/tts.ts` — Edge-TTS wrapper
- `App.tsx` — microphone button + audio playback (mobile only, hidden on desktop)

**Free-tier note:**
HuggingFace `openai/whisper-large-v3` is available on the Inference API free tier.
Edge-TTS is accessed via the `edge-tts` npm package, no API key, Microsoft's free
neural voices. Both fit the free-tier-only philosophy exactly.

---

## PRIORITY 5 — Persistent Agent Goals (Long-Horizon Continuity)

**The problem:**
Every agent session starts from zero context about multi-session goals. The checkpoint system
saves iteration state within a session, and episodic memory summarizes what happened. But if
you tell Crucible "refactor this codebase over the next week," it has no structure for tracking
progress across sessions, knowing what's done vs pending, or picking up intelligently where it
left off.

**What's missing:**
A task graph that persists across sessions:

```json
// .crucible/task-graph/<goal-id>.json
{
  "goal": "Refactor authentication system",
  "created": "2026-06-14T…",
  "status": "in_progress",
  "nodes": [
    { "id": "n1", "task": "Audit current auth flow", "status": "done", "completedAt": "…" },
    { "id": "n2", "task": "Replace JWT library", "status": "in_progress", "startedAt": "…" },
    { "id": "n3", "task": "Update tests", "status": "pending", "dependsOn": ["n2"] }
  ]
}
```

At session start, agent checks for open task graphs matching the current project, reports
progress naturally ("Last session I finished the auth audit — continuing with the JWT
replacement"), and resumes from the correct node.

**Integration points:**
- `goalDecomposer.ts` already exists — extend to write decomposition output to task graph file
- `episodicMemory.ts` already summarizes sessions — link summaries to task graph nodes
- Agent loop preamble already reads `memoryDigest` — add task graph injection here
- New `GET /api/task-graph` endpoint for inspection
- New `POST /api/task-graph/create` to initialize a multi-session goal

---

## PRIORITY 6 — Actionable Uncertainty (Closing the Epistemic Loop)

**The problem:**
H1 confidence calibration flags LOW and UNVERIFIED claims. H4 surfaces the fragile assumption.
H2 routes uncertain topics to the full pipeline. But none of this tells the user what to DO
about the uncertainty. A flagged claim with no suggested action is decorative, not useful.

**What's missing:**
When the confidence calibrator produces LOW or UNVERIFIED claims, generate a specific
suggested action alongside each flag:

- For UNVERIFIED factual claims: auto-generate a web search query the user can run to verify
  (use the existing DDG grounding infrastructure — `webGrounding.ts` — to attempt verification
  first, surface the query if grounding fails or conflicts)
- For LOW confidence reasoning claims: surface the specific assumption that if wrong would
  break the claim (this is already computed by H4 `getFragilityAssumption` — just link it
  to the specific flagged sentence rather than the synthesis as a whole)
- For PROVISIONAL world model facts: surface when the fact was last verified and what would
  update it

**Implementation:**
Extend `confidenceCalibrator.ts` `calibrate()` return type to include `suggestedAction?` per
flagged claim. Extend the `confidence` SSE event to carry these. Extend the UI confidence
strip to show the action inline with each flagged claim — a small "verify →" link or suggested
search query. No new model calls needed — this is recombination of existing signals.

---

## ARCHITECTURAL REMINDER — What Self-Improvement Means in Crucible

Crucible does NOT fine-tune or retrain models. The models are external, free-tier, and fixed.

What Crucible refines is ITSELF:
- **Routing logic** — which model gets which query (specialization memory, viability scores)
- **Stage configuration** — which pipeline stages fire, in what order, with what prompts
- **Scoring thresholds** — when to early-exit, when to force full pipeline, when to escalate
- **Model selection weights** — EMA-based bias toward models that actually survive into synthesis
- **World model** — accumulated facts, decisions, episodic memory that inform future responses
- **Pipeline prompts** — the system prompts driving each stage, tunable via self-patcher

The compounding advantage is not in model weights. It is in the accumulated signal in
`.crucible/` and the pipeline configuration that has been tuned on real usage. Six months of
real queries produces routing intelligence, uncertainty surface calibration, and specialization
memory that cannot be replicated by spinning up the same stack on a fresh install.

This is the correct framing. Build everything with this in mind.

---

## QUICK WINS (< 2 hours each)

These are not priorities but are high-value and low-effort:

**A. Wire `recordPipelineRun()` verification** — DONE (June 14 2026)
`recordPipelineRun()` is now called after every Stage 5 completion so the specialization
forcing recency counter advances correctly. `pipelineRunCount` was stuck at 0 — forcing decay
never fired. Fixed in server.ts.

**B. `/api/waitlist` auto-promotion on boot** — DONE (was already wired)
`promoteNextFromWaitlist()` is already called at server boot (line 336 in server.ts).

**C. Probation outcome recording** — DONE (June 14 2026)
`recordProbationOutcome()` now called alongside `recordModelOutcome()` at Stage 1 outcome
sites. Probation models now accumulate outcome data and can graduate or be rejected.

**D. Debug topology shows probation status** — DONE (June 14 2026)
`GET /api/debug/topology` now includes `probation` array with id, label, callsRemaining for
each model in a probation slot.

**E. Genealogy contribution rates in UI** — DONE (June 14 2026)
`genealogy` SSE event now emitted after attribution pass. Process trail in App.tsx now shows
per-model contribution rates as percentage bars under the ensemble section.

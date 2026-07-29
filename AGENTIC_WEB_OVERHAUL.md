# Agentic Web Overhaul — 100 implementations

> Opened cont.119 (2026-07-28). The brief: Crucible cannot do agentic work on websites or
> anything in depth. It must breeze through it, and the surface must be useful, interactive,
> sleek and beautiful.
>
> Ordering is by **unblocking power**, not by size. Items 1–20 are the spine: nothing above
> them works properly until they land. Each item states its landing site so it can be picked up
> cold. `[x]` = landed and verified live in this repo, `[~]` = landed, live-verification pending.

---

## Track A — The session spine (1–12)

The profile lock is the single constraint that shapes every browser feature. One shared,
ref-counted context removes it and makes items 13–100 possible at all.

1. `[x]` **Jurisdiction for the ambiguity gate.** `isCodeEditGoal` replaces the anchored verb
   list. Non-code goals reach their tools. (`ambiguity.ts`, `bdc3a47`)
2. `[x]` **`needsToolExecutor` gated on the complement.** Everything agentic that is not a code
   edit gets instruments. (`server.ts:3928`, `bdc3a47`)
3. `[x]` **`browser_sign_in` in the content tool set.** (`server.ts:3941`, `bdc3a47`)
4. `[x]` **One shared persistent context.** `browser.ts` holds a module-level, ref-counted
   `BrowserContext` per profile dir. Every browser tool leases it instead of launching its own.
   Kills the "profile in use" failure and makes a headed sign-in window coexist with headless
   reads. *This is the keystone item.*
5. `[x]` **Headed/headless reconciliation.** A headed context serves headless callers (a headed browser
   can do everything headless can); a headless context is upgraded by relaunch when a sign-in
   needs a window.
6. `[x]` **Idle teardown.** Close the shared context after N minutes idle so a long-lived server does
   not hold a browser forever. Ref-count must reach zero first.
7. `[x]` **Crash recovery.** `context.on('close')` clears the singleton so the next lease relaunches
   instead of handing out a dead handle.
8. `[x]` **`signInFlow` returns immediately.** Opens the window, registers a pending sign-in, returns.
   The agent turn is never blocked on a human.
9. `[x]` **Sign-in completion is OBSERVED, not assumed.** Poll `context.cookies()` for the target host;
   success is a real session cookie appearing, never "the window closed".
10. `[x]` **`browser_sign_in` stops returning `ok:true` unconditionally.** Today it reports success
    whether or not a session exists. It must report: window open / signed in / timed out.
11. `[x]` **Pending-sign-in store.** `{id, userId, host, goal, sessionId, createdAt, expiresAt}`
    persisted to `.crucible/pending-signin.json` so a server restart mid-sign-in resumes.
12. `[x]` **Background resume.** When the session appears, re-run the ORIGINAL goal through the same
    internal `/api/chat` path `runAutomationNow` uses, and deliver to the digest + push.

## Track B — Real page interaction (13–30)

Today the browser can only READ. Agentic web work means acting.

13. `[x]` **`browser_act`** — click / type / select / scroll / press on a live page, by accessible name
    or CSS, against the shared context.
14. `[x]` **Accessibility-tree page reader.** Return a ref-tagged interactive element list, not just
    text, so the model can name a target instead of guessing selectors.
15. `[~]` **Stable element refs** (`ref_N`). Stamped onto the DOM and resolvable by
    `[data-crucible-ref]`, so a ref survives re-query on an unchanged page. NOT yet stable across
    a DOM change: re-reading renumbers from `e1`, so a stale ref can resolve to a different
    element. Needs identity-based numbering before this is honestly done.
16. **`browser_fill_form`** — fill many fields in one call, with per-field confirmation of what
    landed.
17. **Wait-for-condition primitive** (selector / text / network-idle) with a bounded timeout.
    NOT done — `web_act` waits on navigation and then a fixed settle beat, and the `wait` action
    is a plain sleep. The blanket `waitForTimeout` is still there.
18. `[x]` **Multi-step page session.** A `browser_session` handle so a task can act across several
    turns on one page without reloading.
19. **Tabs.** Open, list, switch, close — many sites open flows in new tabs.
20. **Download handling.** Capture `download` events to `.crucible/artifacts/` and emit a file
    entity.
21. **Upload handling** via `setInputFiles`.
22. **Frame/iframe traversal** — checkout and embedded auth flows live in iframes.
23. **Shadow-DOM piercing** for the reader and for `browser_act`.
24. **Infinite-scroll harvesting** with a bounded page budget and dedupe.
25. **Pagination following** — detect and walk "next" until a stated limit.
26. **Table extraction** to structured rows, emitted as entities.
27. **Screenshot of an ELEMENT**, not just the page, for visual confirmation of an action.
    NOT done — page-level capture only.
28. `[x]` **Action confirmation.** After every mutating action, re-read and assert the page actually
    changed; report honestly when it did not.
29. `[x]` **Never auto-accept.** Consent banners, terms, cookie walls are REPORTED and handed to the
    user — the existing `needsConsent` discipline extended to every action path.
30. **Destructive-action gate.** Send / buy / delete / post require explicit user confirmation,
    surfaced in the UI, never inferred.

## Track C — Scheduling & unattended work (31–42)

The automations subsystem is complete and the agent cannot reach it.

31. `[x]` **`schedule_task` tool** — create an automation from chat (`store.ts` + existing runner).
32. `[x]` **`list_scheduled_tasks` / `cancel_scheduled_task`** tools.
33. `[x]` **Natural-language trigger parsing** → the existing `Trigger` union ("every weekday at 8am",
    "in 2 hours", "every Monday").
34. `[x]` **Duplicate guard** — creating the same brief+trigger twice updates rather than duplicates.
35. `[x]` **Preview before create.** The agent states the parsed schedule and next run time.
36. **One execution path.** Extract `runAutomationNow`'s SSE runner to `src/server/agentBrief.ts`
    so automations, sign-in resumes and one-off deferrals share it.
37. **Condition triggers**, not just time — "when I'm signed into X", "when this page changes".
38. **Page-change watch** — poll a URL, diff extracted text, fire on meaningful change.
39. **Run history is actionable** — every digest card opens the full answer and continues in chat.
40. **Failure surfacing** — a paused automation says why, in the digest, with a one-click retry.
41. **Timezone correctness** for daily/weekly triggers.
42. **Catch-up policy** — a missed run while the machine slept reports as missed, never silently.

## Track D — Comprehension & routing (43–56)

The cont.118 capability ceiling. Every "why did it do that" bug lives here.

43. **Referent resolution** replacing self-pattern enumeration (`CAPABILITY_CEILING.md`).
44. **Derived self-model corpus** — model id, tools, network posture computed at boot, never typed.
45. **Wire the world model into the answer path** — `entityGraph`/`episodicMemory` exist and the
    conversation path never reads them.
46. **Semantic tool retrieval.** Tool selection from registry descriptions via the on-device
    embedder, replacing `detectAgentTask`'s ~25 regexes. *The universal fix for Track A items 1–3.*
47. **Tool-choice explanation** — why this tool, surfaced in the run panel.
48. **Capability honesty.** "I can't take screenshots" must be impossible to say when the tool is
    registered; assert the claim against the live registry before it ships.
49. **Platform awareness.** The Win+Space answer on a Mac is a self-knowledge failure.
50. **Intent + entity extraction in one pass**, so "save X from Y as PDF" resolves all three.
51. **Clarify only when a question has an answer** — generalise the jurisdiction rule to every
    clarify site.
52. **Multi-goal decomposition** for compound requests.
53. **Follow-up anchoring** — "now do the same for Z" resolves against the prior run's entities.
54. **Progressive disclosure** — act on the resolvable part, ask about the rest.
55. **Never zero-tool-call fabrication.** A personal/device/web claim with no tool call is a
    hard failure, gated before it reaches the user.
56. **Route telemetry** — one line per request showing which gate decided what.

## Track E — The surface (57–76)

Useful, interactive, sleek, beautiful.

57. **Live browser view.** Stream the headed context's screenshots into the run panel so you SEE
    the agent working.
58. **Take control.** A button that hands the window back to the user mid-run, and resumes after.
59. **Step timeline** — each tool call as a card with its artifact inline.
60. **Inline artifact preview** — PDFs, images, tables render in the panel, not as paths.
61. **Entity cards with real affordances** — open, reply, save, schedule.
62. **Diffable page snapshots** for watch tasks.
63. **Run panel that survives reload** (already journaled — surface it).
64. **Pending sign-in surfaced as a first-class card**, with "I've signed in" as an explicit
    control alongside the automatic detection.
65. **Background task tray** — everything deferred, running, or waiting on you, in one place.
66. **Push notification on completion** with a deep link to the run.
67. **Empty states that teach** rather than apologise.
68. **Keyboard-first navigation** across the run panel.
69. **Dark/light parity** — no exceptions.
70. **Motion discipline** — clean ease, no bounce, no emoji, no stock imagery (`UI rules`).
71. **Zero layout shift** while a run streams.
72. **Mobile: the tray and digest are fully usable** on a phone.
73. **Copy/export a run** as markdown with artifacts.
74. **Cost/time budget shown live** per run.
75. **Cancel means cancel** — abort propagates to the browser context.
76. **Failure cards that say what to do next**, never a stack trace.

## Track F — Trust (77–88)

77. **Credential discipline stays absolute** — no password ever typed, asked for, or stored.
78. **Per-site session inventory** — what the profile is signed into, revocable per host.
79. **One-click session purge.**
80. **Domain allowlist** for autonomous browsing.
81. **SSRF/private-range guard** on every navigation, not just `read_url`.
82. **Secret scrubbing** in page text before it enters a transcript or log.
83. **Download scanning** — type and size checks, never auto-execute.
84. **Action audit log** — every mutating web action, replayable.
85. **Rate limiting** per host so a loop cannot hammer a site.
86. **`robots.txt` awareness** with an explicit user override.
87. **Isolation** — the profile is a dedicated dir, never the user's Chrome.
88. **No cross-site data compilation** without an explicit ask.

## Track G — Verification (89–100)

Per doctrine: the oracle must EXECUTE, and a green gate means nothing unread.

89. **Live browser corpus** — N real sites, asserted end-to-end, not mocked.
90. **Sign-in resume test** with a simulated cookie appearance.
91. **Profile-lock regression test** — headed + headless concurrently.
92. **Routing corpus** — the 35-case ambiguity bench extended to full request→tool assertions.
93. **Zero-tool-call detector** in the bench: any personal/device/web goal answering with no tool
    call fails the suite.
94. **Fabrication probes** — platform claims, capability claims, "empty inbox".
95. **Artifact assertions** — a PDF has pages, a PNG has pixels, a table has rows.
96. **Restart-survival test** for pending sign-ins and automations.
97. **Timezone/DST tests** for triggers.
98. **Abort test** — cancel mid-navigation leaves no orphan browser.
99. **Orphan-process check** in the suite (cont.70 recurred this session: a stranded server was
    found reparented to init).
100. **One command** — `npm run agentic:web` runs 89–99 and prints a single honest score.

---

## Landed this session (cont.119)

| commit | what |
|---|---|
| `bdc3a47` | items 1-3 — the three gates that made every non-code request unreachable |
| `4e6e84c` | items 4-12 — one shared browser context; sign-in returns immediately; background resume |
| `aa85010` | items 13, 14, 18, 28, 29 (and 15 partially) — web_open / web_act / web_close |
| `c52c355` | items 31-35 — schedule_task / list_scheduled_tasks / cancel_scheduled_task |
| `b5e4324` | **the profile relocation** — the actual reason none of this worked before |

Measured, end-to-end on the live server:

- `take a screenshot of my screen` — was *"as an AI, I don't have the capability to take
  screenshots"* (and, in agent mode, instructions to press **Win+Space on a Mac**). Now calls the
  tool and produces a real 2816x1762 PNG. **macOS Screen Recording permission is already
  granted** — the 2 MB artifact proves it, so overhaul item "grant permission" was a non-issue.
- `every weekday at 8am send me a summary of my inbox` — was *"Which file or symbol should this
  change target?"*. Now creates a real automation, `weekdays 08:00`, first run tomorrow 08:00.
- Sign-in no longer blocks: returns in ~3s, and headless reads + PDF export succeed **while** the
  window is open. Previously impossible — the profile lock made them mutually exclusive.

Benches: `npm run ambiguity:bench` 35/35 · `npm run web:bench` 19/19 ·
`npm run schedule:bench` 56/56.

### Found while verifying, all by running it for real

1. **The profile was per-conversation.** 363 scratch projects, no browser profile in any of them.
   Sessions could never persist. Fixed by making it user-level; existing session migrated.
2. **The app and the repo keep separate state.** The Electron server's cwd is
   `~/Library/Application Support/crucible-local`. A schedule the server confirmed was absent
   from the repo's `automations.json` because they are different files. `/api/diag` now reports
   real paths.
3. **`schedule_task` claimed success for a write that never landed.** Now verified by read-back.
4. **Anti-bot CAPTCHA pages were read as content** (duckduckgo.com/html served one mid-run).
   Detected and reported as a third wall class. Never solved.
5. **`ReferenceError: __name`** — esbuild's keepNames helper does not exist in the browser, so
   every `page.evaluate` with a variable-assigned inner function threw.
6. **Accessible-name precedence** ranked `placeholder` above `<label for>`, so fill-by-name missed.
7. **A stranded orphan server** (PID 2109, reparented to init) — cont.70's failure mode, recurred.

### Round 2 — the flashcard debug report (2026-07-29)

One user report, `"build me a quizlet flashcard set with simple grammatical italian terms"`,
turned out to be **eight** independent defects stacked end to end. Each was found by running it,
and every one of them alone was enough to ruin the answer.

| # | defect | commit |
|---|---|---|
| 1 | `statedSubject` only accepted `about\|on\|covering\|for` — the request said **"with"**, so a stated subject was asked about. Fixed structurally: the subject is the residue after the deliverable, joined by the same closed connector class `deliverableOf` already terminates on. | `99e8891` |
| 2 | The reply to our own question became the goal — the debug event reads `{"goal":"i already told you"}`. | `99e8891` |
| 3 | ...and folding it back in produced text the spec parser could no longer read, so an *answered* question still could not be built. Now folded in as the slot that was asked about. | `23bf05c` |
| 4 | `namesExternalLibrary` treated every sentence-initial capital in multi-line text as a library name. | `cab43a0` |
| 5 | The artifact contract ran on 2 of 9 answer paths. Moved to the `send` choke point. | `80a4024` |
| 6 | **The brief was a `Key: value` block**, which a small model transcribes as a config object — `Level:` is what summoned `abstract-level`. Now prose. | `7d17e5e` |
| 7 | A tool call written as source (`web_open("https://...")`) executed nothing. | `df4dafc` |
| 8 | **The verifier could not see a correct deck**: `Q:\n\nA:` split into two half-items, so 20 good cards verified as 0 — which is what pushed the request into the tool loop that answered with LevelDB typings. | `71ddd18` |

Plus: a **content path** — a resolved creation goal sourced from the model's own knowledge is now
WRITTEN directly and verified before any tool loop sees it. Measured: handed `contentBriefFor`
alone the model produces the deck cleanly; handed the same request through the ReAct loop it
returned LevelDB typings, `fs` wrappers, and `web_open(...)` as source. The model was never the
limitation — giving a writing job to a tool loop was.

**Deliberately NOT shipped:** a token-overlap duplicate detector for padding-by-restatement. It
works on the live case (15 items → 8) and it rejects valid formulaic decks — three of the
artifact bench's own fixtures included. Recorded in `__artifact_bench.ts` with the evidence.

**Still open after round 2:** the on-device model's output QUALITY. It now reliably reaches the
right path and is honestly graded, but it under-delivers (15 of 20), pads the tail with restated
cards, invents facts ("lo" described as a neuter article; Italian has no neuter), and drifts
format (`**Subject:** / **Definition:**` instead of `Q:/A:`). That is the capability ceiling from
`CAPABILITY_CEILING.md`, not a routing bug — every gate above it now reports the shortfall
instead of hiding it.

### Next, in priority order

1. **Item 46 — semantic tool retrieval.** Three enumerative gates were fixed this session by
   hand; `detectAgentTask`'s ~25 regexes are the fourth and should be replaced by embedding the
   registry's own tool descriptions, not extended.
2. **Items 57-65 — the surface.** None of the UI work is started. The live browser view (57) and
   the pending-sign-in card (64) are what make this *feel* agentic rather than merely be it.
3. **Item 36** — extract the SSE runner; `runBriefUnattended` currently duplicates
   `runAutomationNow`.
4. **Items 19-26** — tabs, downloads, iframes, pagination, table extraction.
5. **Duplicate tool calls**: the agent emitted `schedule_task` three times for one request. The
   dedupe guard caught it, but the loop should not be issuing them.

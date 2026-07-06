# Crucible v3 — implementation brief for Claude Code

Spec artifact: `Crucible v3.dc.html` (this project). It is a **working prototype** — open it and
watch the auto-demo: send → thinking → molten pour → cool. Treat it as the definitive visual/UX
spec. Reimplement in `src/App.tsx` + components; do NOT import the .dc.html file.

Repo: `/Users/justin/crucible-local/crucible-local`, branch `crucible-northstar-sessions`.
**Run `git status` first** — a prior uncommitted critic split-routing diff may exist
(`synthDriver.ts` / `driver.ts`). Commit or stash before touching `App.tsx`. Do not regress it.

## Verified current line refs (App.tsx, as of this read)

- L36: comment noting 'research' mode
- L504: `crucible-pipeline-theater` panel
- L1801: `const [mode, setMode] = useState<'quorum'|'code'|'seeker'|'research'>('code')`
- L2042: `classifyMode()` definition (L2037 comment above it)
- L3264: `setMode(classifyMode(val, mode))` — the auto-routing call site
- L4060: `crucible-pipeline-status`
- L4688: `crucible-pipeline-log`

## Structural changes

1. **Delete the mode state machine.** Remove `mode` state (L1801), `classifyMode` (L2042), the
   call at L3264, and any `ModeSwitcher` remnants. Default and only path for a normal query:
   Crucible local FM. Zero external calls.
2. **Ensemble = opt-in only.** Composer pill toggles `ensembleArmed`. Even armed, EVERY send
   shows a per-query confirmation card ("Use ensemble for this?") with [Crucible only] and
   [Run ensemble]. No auto-escalation on complexity/length, ever.
3. **Ensemble requires user-provided API keys.** New Settings → API keys: a blank-slate list.
   User names each key freely (name + token) — NO pre-baked provider fields ("Mistral key",
   "Gemini key", etc.). No keys ⇒ ensemble confirm shows the "add keys" state instead and only
   offers Crucible-only. Store locally.
4. **Pipeline chrome behind the gate.** `crucible-pipeline-theater` / `-status` / `-log`
   (L504/L4060/L4688) must never render for local queries. On a confirmed ensemble run only,
   the reply card shows per-key chips (chip label = the user's key name) + a small "ensemble"
   tag. Default replies: clean card, tiny "CRUCIBLE · ON-DEVICE" footer.
5. Keep Crucible's local model path and `src/CrucibleEngine/tools/` + `agent/` intact.
   Regression-test the tool surface after the merge.

## Design system (from the prototype — use these literals)

- bg `#101016`, text `#e4e4ee`/`#dcdcea`, dim `#55556a`/`#77778c`, hairline `rgba(255,255,255,0.06–0.09)`
- glass panels: `rgba(255,255,255,0.03–0.045)` + `backdrop-filter: blur(24–32px)` + inset top highlight
- accent (nav/ensemble) `#7c7cf8`; on-device green `#4db89e`; radius 14–20px; dark-mode only
- molten palette (pour only): `rgb(255, 70–180, 10–70)` mottled around `#ff6a1a`

## Pour animation — FINAL, implemented in the prototype's `drawPour()`

Port the logic class methods `startAnimator / drawPour / drawHalf / roundRectPoints /
moltenColor / drawVessel` nearly verbatim into a React component (e.g. `MoltenPour.tsx`)
rendering one `<canvas>` absolutely positioned over the streaming reply card
(`left:-24px; top:-70px`, sized to card rect + padding, `pointer-events:none`).

Phase triggers — hook to REAL stream lifecycle, not timers:
- **thinking**: on send, before first token. Crucible icon loops upright→tilt-right→upright
  (eased cosine, no snap).
- **pouring**: on first token → stream end. Full tilt hold (target 1.02 rad). Molten stream
  spout→border-top (3 layered wobbling quadratic strokes + shadowBlur bloom). Border fills from
  the top landing point down BOTH edges simultaneously (two half-perimeter polylines), rounded
  corners included, converging at bottom-center of the LIVE card height (re-measure every frame
  via getBoundingClientRect — content grows during stream). Whole poured extent stays lit
  (full stroke redrawn each frame, ambient shimmer). Fill target = smoothed(tokensReceived
  fraction) clamped by `elapsed / minFill` — **min fill floor 1350ms**; eased current→target
  with min drift (never frozen) + max step clamp.
- **cooling**: on stream end, after fill reaches 1. Crucible eases upright + fades to 0 WHILE
  the border cools top→bottom (destination-out gradient sweep, top cools first). Concurrent,
  both finish together. **Min cool floor 1000ms.** Then unmount canvas / swap to default border.

Driving values from the real stream: replace the prototype's `_tokensFrac` (canned word sim)
with `receivedChars / estimatedTotal` or a monotone smoothed rate; keep the same easing clamps —
that's what keeps choppy token streams looking fluid.

## Do NOT

- Remove Crucible's local FM path or its tools while gutting pipeline UI.
- Re-ask about the animation spec — it's final; make the closest reasonable call + code comment.
- Touch the critic split-routing fix in `synthDriver.ts` / `driver.ts`.

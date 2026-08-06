// ── Ambient field (elevation 0) ────────────────────────────────────────────────
// DESIGN_HANDOFF §3.1. Glass is meaningless without something behind it: this is the
// self-authored gradient mesh the frosted surfaces sample.
//
// REPLACES the old canvas implementation rather than extending it (the handoff asked
// for an explicit call on that). Reasons the canvas had to go:
//   - It ran a requestAnimationFrame loop forever, repainting a full-viewport radial
//     gradient every frame to express a 55s cycle. The CSS version is composited on the
//     GPU and costs nothing after the first paint.
//   - It could not honour `prefers-reduced-motion` without extra code, and freezing the
//     drift is a hard requirement (§6.2).
//   - Its two blobs at alpha 0.02 were too faint for glass to sample; the four-blob
//     field in `.cru-ambient` is what the glass tokens were measured against (§3.4).
//   - Canvas colours could not follow the light/dark theme tokens. `.cru-ambient` reads
//     --amb-base and --amb-1..4, so both themes are one variable swap.
//
// MoltenPour.tsx is untouched — it is a foreground identity moment, not a backdrop, and
// does not overlap this component's job.
//
// Everything visual here is authored in CSS in index.css (`.cru-ambient`): no images, no
// external asset requests, per house rule 2.

export default function BackgroundBlobs({ working = false }: { working?: boolean }) {
  return (
    <div
      aria-hidden
      style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none', overflow: 'hidden' }}
    >
      {/* The field itself drifts 52s linear — imperceptible frame to frame, frozen
          entirely under prefers-reduced-motion. */}
      <div className="cru-ambient" />
      {/* While the assistant is working the field warms very slightly. This is ambient
          reassurance, not a progress indicator — the dock says what it is doing in
          words (§6.3). Opacity-only, so it survives reduced motion untouched. */}
      <div
        style={{
          position: 'absolute', inset: '-14%',
          background: 'radial-gradient(70% 55% at 50% 100%, var(--amb-3) 0%, transparent 65%)',
          opacity: working ? 0.5 : 0,
          transition: 'opacity 1.2s var(--ease-standard)',
        }}
      />
    </div>
  )
}

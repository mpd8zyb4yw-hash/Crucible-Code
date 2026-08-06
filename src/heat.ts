/**
 * Heat → pixels.
 *
 * The model picks one of four heat values. Everything visual is decided here,
 * with the exact values from the Claude Design handoff. This is the seam that
 * lets the model author the feed without ever being able to drift the design:
 * it never names a colour, so no output can produce one that wasn't approved.
 */
export type Heat = 'hot' | 'warm' | 'quiet' | 'handled'

export interface HeatSkin {
  /** Card background on the home feed. */
  bg: string
  /** Card box-shadow (the inset hairline + top highlight). */
  shadow: string
  /** Blurred corner glow; empty for tiers that don't carry one. */
  glow: string
  /** Uppercase heat-label colour. */
  labelColor: string
  /** The small pulsing dot. */
  dot: string
  /** Whether the dot carries a bloom. */
  dotGlow: boolean
  /** Report header gradient. */
  headerBg: string
}

export const heatSkin: Record<Heat, HeatSkin> = {
  hot: {
    bg: 'linear-gradient(160deg, rgba(50,32,28,.5), rgba(28,21,19,.4))',
    shadow: 'inset 0 1.5px 0 rgba(255,190,170,.18), inset 0 0 0 1px rgba(240,115,107,.2)',
    glow: 'rgba(240,115,107,.16)',
    labelColor: '#F0938B',
    dot: '#F0736B',
    dotGlow: true,
    headerBg: 'linear-gradient(160deg, rgba(52,32,28,.5), rgba(20,16,15,0))',
  },
  warm: {
    bg: 'rgba(28,26,22,.4)',
    shadow: 'inset 0 1px 0 rgba(255,220,170,.1), inset 0 0 0 1px rgba(231,178,76,.14)',
    glow: '',
    labelColor: '#D9A94E',
    dot: '#E7B24C',
    dotGlow: false,
    headerBg: 'linear-gradient(160deg, rgba(44,36,20,.45), rgba(20,17,12,0))',
  },
  quiet: {
    bg: 'rgba(255,255,255,.03)',
    shadow: 'inset 0 0 0 1px rgba(255,255,255,.06)',
    glow: '',
    labelColor: 'rgba(237,238,241,.5)',
    dot: '#A98FE0',
    dotGlow: false,
    headerBg: 'linear-gradient(160deg, rgba(30,26,40,.4), rgba(16,15,20,0))',
  },
  handled: {
    bg: 'rgba(24,32,28,.4)',
    shadow: 'inset 0 1px 0 rgba(180,240,210,.12), inset 0 0 0 1px rgba(95,201,166,.16)',
    glow: 'rgba(95,201,166,.10)',
    labelColor: '#8FE0AE',
    dot: '#5FC9A6',
    dotGlow: false,
    headerBg: 'linear-gradient(160deg, rgba(24,40,32,.42), rgba(14,18,16,0))',
  },
}

export const skinOf = (heat: string): HeatSkin => heatSkin[(heat as Heat)] ?? heatSkin.quiet

/**
 * Named accents.
 *
 * Heat says how much something matters; an accent says which of several
 * equally-quiet things a row belongs to, so the quiet group doesn't collapse
 * into one repeated dot. Same seam as heat: the model picks a NAME, the value
 * lives here. Every hex below is one the design already uses — nothing new
 * enters the palette by way of model output.
 */
export type Accent = 'violet' | 'rose' | 'mint' | 'amber' | 'sage' | 'teal'

export const accents: Record<Accent, string> = {
  violet: '#A98FE0',
  rose: '#F0524B',
  mint: '#5FC9A6',
  amber: '#E7B24C',
  sage: '#A6CE82',
  teal: '#7BD9B8',
}

/** Resolve an accent name, falling back to the heat's own dot. */
export const accentOf = (name: string | null | undefined, heat: string): string =>
  (name && accents[name as Accent]) || skinOf(heat).dot

/** The composer's ask card — its own skin, not a heat the model can select. */
export const askSkin: HeatSkin = {
  bg: 'rgba(30,32,37,.4)',
  shadow: 'inset 0 1px 0 rgba(255,255,255,.16), inset 0 0 0 1px rgba(255,255,255,.08)',
  glow: '',
  labelColor: 'rgba(237,238,241,.6)',
  dot: '#F0A56B',
  dotGlow: false,
  headerBg: 'linear-gradient(160deg, rgba(38,30,22,.4), rgba(16,14,12,0))',
}

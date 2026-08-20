/**
 * WHICH CAPABILITIES THE MEMORY CORE IS ALLOWED TO ANSWER FOR — AND WHY THIS IS
 * NOT A BOOLEAN.
 *
 * §3 is unusually direct: do not implement `legacy world OFF / memory core ON`.
 * §52 then gives an eight-step order to migrate authority in, starting at entity
 * enrichment and ending at proactive recommendations, and §51 makes each step
 * conditional on gates that are passed at different times.
 *
 * A single `shadowMode` flag cannot express any of that. It has exactly two
 * states, and the whole argument of those three sections is that the interesting
 * states are all in between. Worse, a boolean invites the change that this
 * milestone exists to prevent: one line, one commit, and every conclusion the
 * model has ever formed is live on his home screen at once, with no way to say
 * which of them was the one that went wrong.
 *
 * So there is no flag to flip. There is a map from capability to authority, every
 * entry defaults to `shadow`, and the only way to make something user-visible is
 * to name that thing. `shadowMode` as a concept still exists — it is simply the
 * default value of every row rather than a switch beside them.
 *
 * WHAT `shadow` ACTUALLY MEANS, MECHANICALLY.
 *
 *     shadow  the pipeline runs, the conclusions are stored, the shadow log
 *             records what WOULD have been said, and no read path returns it
 *     live    the same, and consumers may read it
 *
 * Not "off". §30 is explicit that ingestion, reflection, prediction resolution
 * and candidate generation all happen in shadow mode — that is the point, because
 * a model that is not running is a model whose calibration cannot be observed
 * before it is trusted. `enabled: false` is the separate, blunter thing: the
 * memory core is not installed at all, which is what `node-runtime.ts` falls back
 * to when `better-sqlite3` will not load.
 */

/**
 * The eight capabilities, in §52's migration order.
 *
 * The order is data rather than commentary because `nextCapability` reads it: the
 * supported way to widen authority is to take the next one, and a reviewer can
 * see at a glance that nothing has jumped ahead to recommendations.
 */
export const CAPABILITIES = [
  /** Identity, aliases and merges enriching the people the app already knows. */
  'entities',
  /** Per-weekday means and spreads, as the baseline surfaces compare against. */
  'baselines',
  /** Learned recurring activity: what he does, when, how reliably. */
  'routines',
  /** Deviations from the above, as attention candidates. */
  'anomalies',
  /** Whether what we expected actually happened. Calibration, not engagement. */
  'prediction_outcomes',
  /** Supported associations and dated shifts. */
  'hypotheses',
  /** The Home intelligence slot consuming memory-core candidates. */
  'intelligence',
  /** Acting on any of it unprompted. Last, and gated hardest. */
  'recommendations',
] as const

export type Capability = (typeof CAPABILITIES)[number]

export type Authority = 'shadow' | 'live'

/**
 * The installed posture.
 *
 * `Partial` on purpose, and read through `authorityOf`, so a capability added to
 * `CAPABILITIES` later is `shadow` in every host that has not heard of it. The
 * failure direction is chosen: a new capability nobody configured stays invisible
 * rather than going live because a map had no entry and something read `undefined`
 * as falsy-therefore-fine.
 */
export interface MemoryPosture {
  /** Whether the memory core runs at all. False only when the store will not open. */
  enabled: boolean
  authority: Partial<Record<Capability, Authority>>
}

/** Everything shadowed. §30's default state, and the one this milestone ships in. */
export const SHADOW_ONLY: MemoryPosture = { enabled: true, authority: {} }

/**
 * THE SEVEN READ-ONLY CAPABILITIES, LIVE. `recommendations` DELIBERATELY NOT.
 *
 * Promoting these is only defensible because of what promotion does NOT do. It
 * does not lower a single evidence bar: `significance.ts` still demands its
 * coverage, diversity and magnitude, `correction.ts` still removes anything he
 * has denied, and every compiler still returns the empty answer when the record
 * does not support one. The negative corpus asserts exactly that, under this
 * posture, and is the reason this line can be written at all — it already tested
 * that a LIVE capability over thin evidence stays silent.
 *
 * So the change is from "memory is invisible regardless of evidence" to "memory
 * is visible when, and only when, the evidence clears the bar it always had".
 * On today's ledger that still means quiet most of the time. Quiet because
 * nothing was earned is the designed state; quiet because the read path was
 * never connected was the defect.
 *
 * `recommendations` — acting unprompted — stays shadow. It is the one capability
 * whose failure is not a wrong sentence on a screen but an action he did not
 * ask for, and §52 gates it hardest for that reason. It is promoted after
 * real-world calibration, not with this batch.
 */
export const READ_ONLY_LIVE: MemoryPosture = {
  enabled: true,
  authority: {
    entities: 'live',
    baselines: 'live',
    routines: 'live',
    anomalies: 'live',
    prediction_outcomes: 'live',
    hypotheses: 'live',
    intelligence: 'live',
    // recommendations: intentionally absent → 'shadow' via `authorityOf`.
  },
}

export const authorityOf = (p: MemoryPosture, c: Capability): Authority =>
  p.enabled ? (p.authority[c] ?? 'shadow') : 'shadow'

/** The question every read path asks before returning a memory-core answer. */
export const isLive = (p: MemoryPosture, c: Capability): boolean => authorityOf(p, c) === 'live'

/**
 * THE NEXT CAPABILITY THAT MAY BE PROMOTED, per §52's order.
 *
 * Returns the first still-shadowed capability rather than any of them, which is
 * the whole content of the rule: observation quality is proven before prediction,
 * prediction before hypothesis, and nothing before entity enrichment. A host that
 * wants to skip a step has to say so explicitly by naming the capability, and
 * that is then visible in the posture rather than in a decision nobody recorded.
 */
export const nextCapability = (p: MemoryPosture): Capability | null =>
  CAPABILITIES.find((c) => authorityOf(p, c) === 'shadow') ?? null

/** Human-readable posture, for the developer view and the shadow log's header. */
export function describePosture(p: MemoryPosture): string {
  if (!p.enabled) return 'memory core not installed'
  const live = CAPABILITIES.filter((c) => authorityOf(p, c) === 'live')
  return live.length
    ? `live: ${live.join(', ')} · shadow: ${CAPABILITIES.filter((c) => !live.includes(c)).join(', ')}`
    : 'shadow only — nothing the memory core concludes reaches a screen'
}

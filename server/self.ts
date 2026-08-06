import { snapshot } from './models.js'
import { budgets } from './router.js'

/**
 * What Crucible knows about itself.
 *
 * The requirement was that a dead model must not be visible in the picker but
 * must still be answerable when asked about — and, crucially, WITHOUT a
 * hardcoded prompt to trigger it. Matching "why did gemini stop working" against
 * a pattern would be the wrong shape twice over: it only ever answers the
 * questions someone thought to enumerate, and the moment he phrases it his own
 * way ("what happened to the pro model", "is anything broken", "am I about to
 * run out") it falls back to a generic non-answer.
 *
 * So there is no intent matching anywhere. This renders the app's own live
 * state as a few lines of plain text, and it is appended to the context of
 * every reply, exactly like the world model is. The model already knows how to
 * answer novel questions about the facts it is given; the only thing it was
 * missing was the facts. Ask something it has no state for and it says so,
 * which is the same behaviour as for any other question — no special case.
 *
 * The cost is a few hundred characters per reply and no extra call.
 */
export async function renderSelf(): Promise<string> {
  const [reg, budget] = await Promise.all([snapshot().catch(() => null), budgets().catch(() => [])])
  const now = Date.now()
  const lines: string[] = []

  if (reg?.models?.length) {
    const verified = reg.models.filter((m) => m.verdict === 'verified')
    const quarantined = reg.models.filter((m) => m.verdict === 'quarantined' && (m.until ?? 0) > now)

    if (verified.length) {
      lines.push(
        `Models you can currently think with (${verified.length}): ` +
          verified
            .sort((a, b) => b.quality - a.quality)
            .slice(0, 8)
            .map((m) => `${m.model} (quality ${m.quality}/10${m.measured ? ' measured' : ' estimated from its name'}${m.latencyMs ? `, ${Math.round(m.latencyMs)}ms` : ''})`)
            .join('; ')
      )
    }

    /**
     * The reasons, verbatim, with when each is next reconsidered.
     *
     * This is the whole point of keeping a quarantined model rather than
     * deleting it: "gemini-2.5-pro is not available on this plan, retrying on
     * the 8th" is a real answer, and it is not one the model could produce by
     * reasoning — it has to be told.
     */
    if (quarantined.length) {
      lines.push(
        `Models currently set aside as not working (${quarantined.length}), hidden from his settings but askable: ` +
          quarantined
            .slice(0, 12)
            .map((m) => `${m.model} — ${m.reason ?? 'would not answer'} (will be retried ${when(m.until ?? 0, now)})`)
            .join('; ')
      )
    }
  }

  const live = budget.filter((b) => b.basis !== 'unknown')
  if (live.length) {
    lines.push(
      'Remaining budget per model: ' +
        live
          .slice(0, 8)
          .map((b) => {
            const left = b.requestsLeft === null ? 'unknown' : `${b.requestsLeft}${b.requestLimit ? `/${b.requestLimit}` : ''} requests`
            // The distinction is load-bearing: one of these is the provider's
            // promise and the other is our arithmetic, and saying so is the
            // difference between a fact and a fabricated statistic.
            const how = b.basis === 'measured' ? 'reported by the provider' : 'our own estimate from published limits minus what we have spent'
            return `${b.model}: ${left} (${how}; ${b.usedToday} used today)`
          })
          .join('; ')
    )
  }

  const resting = budget.filter((b) => b.restingUntil)
  if (resting.length) {
    lines.push(
      'Resting right now: ' +
        resting.map((b) => `${b.model} — ${b.why ?? 'rate limited'}, back ${when(b.restingUntil!, now)}`).join('; ')
    )
  }

  if (!lines.length) return ''
  return (
    'ABOUT YOURSELF — the live state of this app, for when he asks about it:\n' +
    lines.map((l) => `- ${l}`).join('\n') +
    '\nHe can ask you anything about how you are working. Answer from these facts, plainly, and say you do not know if they do not cover it. Never guess at your own internals.'
  )
}

function when(at: number, now: number): string {
  const ms = at - now
  if (ms <= 0) return 'now'
  const h = ms / 3_600_000
  if (h < 1) return `in ${Math.round(ms / 60_000)} minutes`
  if (h < 48) return `in about ${Math.round(h)} hours`
  return `in about ${Math.round(h / 24)} days`
}

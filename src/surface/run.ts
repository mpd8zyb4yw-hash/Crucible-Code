import { dispatch, snapshot } from './store'
import { CAPABILITIES, type SurfaceCommand } from './types'

/**
 * A command as it arrives from the model: `op` is a string, not yet one of ours.
 *
 * Deliberately not narrowed at the boundary. The reducer refuses any op the
 * target surface does not declare and REPORTS the refusal, which is strictly
 * better than dropping it here — a silently discarded command is one the model
 * will go on to describe as done.
 */
export interface LooseCommand {
  surface?: string
  op: string
  args?: Record<string, unknown>
}

/**
 * Running what the model asked for, visibly and interruptibly.
 *
 * Two rules shape this. Nothing is faked: there is no typing animation and no
 * artificial pause on a single operation, because pretending to work is a lie
 * about latency and he can feel the difference. But a sequence of three changes
 * applied in the same frame is indistinguishable from one change, and the whole
 * claim of this layer is that he can SEE what it did — so multi-step runs put a
 * beat between steps, which is also the window in which he can stop it.
 *
 * Stopping is the other rule. He must be able to say "no, Wednesday" while it
 * is still moving, and land somewhere coherent: each step is applied whole and
 * is individually undoable, so cancelling leaves the surface in the state after
 * the last completed step rather than half way through anything.
 */

/** Long enough to register as a separate change, short enough not to feel slow. */
const BEAT = 220

export interface Run {
  /** Stop before the next step. Steps already applied stay applied. */
  cancel(): void
  /** What each applied step said, in order. Resolves when the run ends. */
  done: Promise<{ said: string[]; cancelled: boolean }>
}

/**
 * Which surface a command means.
 *
 * The model is asked to name one and usually does. When it does not — or names
 * one that has closed since it was told about it — the fallback is the only
 * surface that could possibly have been meant: if just one is open, that one;
 * otherwise the first that actually declares the operation. Guessing beyond
 * that would be worse than refusing, so it refuses.
 */
function target(cmd: LooseCommand): string | null {
  const open = snapshot()
  if (!open.length) return null
  if (cmd.surface && open.some((s) => s.key === cmd.surface)) return cmd.surface
  if (open.length === 1) return open[0]!.key
  const able = open.filter((s) => (CAPABILITIES[s.kind] ?? []).some((c) => c.op === cmd.op))
  return able.length === 1 ? able[0]!.key : able[0]?.key ?? null
}

export function runCommands(
  commands: LooseCommand[],
  onStep?: (said: string, index: number, total: number) => void
): Run {
  let cancelled = false
  const said: string[] = []

  const done = (async () => {
    for (const [i, cmd] of commands.entries()) {
      if (cancelled) break
      const key = target(cmd)
      if (!key) {
        said.push('There was nothing open to do that to.')
        onStep?.(said[said.length - 1]!, i, commands.length)
        continue
      }
      const r = dispatch(key, cmd as SurfaceCommand, 'model')
      said.push(r.said)
      onStep?.(r.said, i, commands.length)
      // Only between steps, and only when there is a next one to see.
      if (i < commands.length - 1 && commands.length > 1) {
        await new Promise((r) => setTimeout(r, BEAT))
      }
    }
    return { said, cancelled }
  })()

  return { cancel: () => { cancelled = true }, done }
}

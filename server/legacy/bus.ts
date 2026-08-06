// ============================================================
// CRUCIBLE — Debug Bus
// Central event bus: every subsystem emits here. SSE subscribers
// get a live feed; the ring buffer keeps the last 500 events.
// ============================================================

export type DebugSeverity = 'info' | 'warn' | 'error' | 'success'

export interface DebugEvent {
  id: string
  ts: number
  severity: DebugSeverity
  category:
    | 'model'
    | 'pipeline'
    | 'verify'
    | 'execution'
    | 'agent'
    | 'tool'
    | 'circuit'
    | 'system'
  type: string
  requestId?: string
  data: Record<string, unknown>
}

type Subscriber = (event: DebugEvent) => void

const RING_SIZE = 500

class DebugBus {
  private ring: DebugEvent[] = []
  private subs = new Set<Subscriber>()
  private seq = 0

  emit(
    category: DebugEvent['category'],
    type: string,
    data: Record<string, unknown>,
    opts: { severity?: DebugSeverity; requestId?: string } = {},
  ): void {
    const event: DebugEvent = {
      id: `${Date.now()}-${this.seq++}`,
      ts: Date.now(),
      severity: opts.severity ?? 'info',
      category,
      type,
      requestId: opts.requestId,
      data,
    }
    if (this.ring.length >= RING_SIZE) this.ring.shift()
    this.ring.push(event)
    for (const sub of this.subs) {
      try { sub(event) } catch { /* never let a bad subscriber kill the bus */ }
    }
  }

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  history(n = 100): DebugEvent[] {
    return this.ring.slice(-n)
  }

  /** Events for a specific request, in order. */
  causalChain(requestId: string): DebugEvent[] {
    return this.ring.filter(e => e.requestId === requestId)
  }
}

export const debugBus = new DebugBus()

/**
 * THE ONE READ BOUNDARY BETWEEN THE MEMORY CORE AND A SCREEN.
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ──────────────────────────────────────────
 *
 * The memory core lives in two different places on the two hosts, and until now
 * only one of them was reachable from the feed:
 *
 *   Mac    `installMemory()` → `host.ts` holds the store → `memoryStore()`
 *          answers → `feed.ts` enriches. Works.
 *
 *   EDGE   the real SQLite ledger — the one with his actual life in it — lives
 *          inside `WorldObject`, and the Worker never called `installMemory()`.
 *          So `memoryStore()` returned NULL on every production request, and
 *          `slotThree()` and `enrichPanes()` took their defensive `if (!store)
 *          return` branch on every single build. Silently, by design, forever.
 *
 * The sophisticated half of this product was stranded inside a Durable Object
 * while the production UI asked a different abstraction for it and was politely
 * told there was nothing there. No test caught it because every memory test
 * drives a local `MemoryStore` directly, which is exactly the host that worked.
 *
 * ── WHY A COGNITION BOUNDARY AND NOT A STORE BOUNDARY ────────────────────────
 *
 * The obvious fix — hand the Worker a `MemoryStore` — is the wrong one twice
 * over. A `MemoryStore` is a synchronous SQL handle; the edge's is on the other
 * side of an RPC and can never be synchronous. And making it one would mean
 * either copying the ledger into KV (two stores, guaranteed to diverge) or
 * shipping the database to the isolate to compose one sentence.
 *
 * So the boundary is drawn at the NARROWEST POINT THAT WAS ALREADY THERE.
 * `domain.ts` and `intelligence.ts` were already written as pure functions from
 * (store, bounded typed facts) to bounded typed presentation. That is the seam:
 *
 *     in    `DomainFacts` — four small typed records the projection already
 *           computed. Never the world, never the ledger.
 *     out   `DomainContext[]` / `IntelligencePresentation` — clamped lines with
 *           their certainty and their provenance ids. Never rows.
 *
 * Both directions are bounded, both are already serialisable, and the SQL stays
 * where the SQL is.
 *
 * ── ONE IMPLEMENTATION, TWO HOSTS ────────────────────────────────────────────
 *
 * `cognitionOverStore` is the whole of the thinking and it is host-blind. The
 * Mac runs it over its own store; the edge runs THE SAME FUNCTION inside the
 * Durable Object, over the real ledger, and only the transport differs. There
 * is deliberately no second implementation to drift — a "worker version" of
 * this reasoning is the bug this file was written to make impossible.
 */

import { domainContexts, type DomainContext, type DomainContextOptions, type DomainFacts } from '../domain.js'
import { intelligenceSlot, type IntelligencePresentation } from '../intelligence.js'
import { memoryPosture, memoryStore } from './host.js'
import type { MemoryPosture } from './authority.js'
import type { MemoryStore } from './types.js'

/**
 * Everything the compilers need about WHEN and WHERE, and nothing else.
 *
 * `now` is an ISO string rather than a `Date` because this crosses a wire, and
 * the zone is carried explicitly for the reason stated everywhere else in this
 * codebase: the Worker's runtime zone is UTC and his is not, so a boundary
 * derived from the runtime puts his day change at two in the morning.
 *
 * Note what is NOT here: `label` and `magnitudeOf` used to be passed into
 * `intelligenceSlot` as functions. Functions do not serialise, so they are
 * reconstructed on whichever side runs the compiler — see `metricLabel`.
 */
export interface CognitionContext {
  now: string
  timeZone?: string
  hour12?: boolean
}

/**
 * WHAT A HOST MUST BE ABLE TO ANSWER FOR THE MEMORY CORE TO REACH A SCREEN.
 *
 * Two methods, both async, both allowed to answer "nothing" — which remains the
 * normal answer, because the evidence gates in `significance.ts` are unchanged
 * and this file deliberately does not touch them. Making memory REACHABLE and
 * making it TALKATIVE are different changes; this is only the first.
 */
export interface MemoryCognition {
  /** Slot three, compiled, or null. Null far more often than not. */
  intelligence(ctx: CognitionContext): Promise<IntelligencePresentation | null>
  /** Every line the core can support for the domains it was given facts about. */
  domainContexts(facts: DomainFacts, ctx: CognitionContext): Promise<DomainContext[]>
}

/**
 * Metric ids in his words.
 *
 * MOVED HERE FROM `feed.ts`, and the move is the point: the compiler that needs
 * it now runs inside a Durable Object where nothing imports the feed. A function
 * cannot cross the RPC, so the only way both hosts phrase a metric identically
 * is for both to call this — which is the same "one predicate, one place" rule
 * that a duplicated `ahead` already broke once.
 */
export const metricLabel = (m: string): string =>
  m === 'steps' ? 'your step count'
  : m === 'events_per_day' ? 'how much is in your calendar'
  : m === 'departure_minute' ? 'when you leave'
  : m === 'contact_days' ? 'how often you are in touch'
  : m

/**
 * THE COGNITION ITSELF. Both hosts run exactly this.
 *
 * Async in signature and synchronous in fact — the store handed to it is always
 * a local SQL handle, because this only ever runs on the side the database is
 * on. The promise is the boundary's shape, not this function's nature.
 *
 * Defensive to the point of rudeness, for the reason `host.ts` states: a broken
 * ledger costs evidence and must never cost a screen. Both methods return the
 * empty answer on any throw, which is byte-for-byte the app that existed before
 * the memory core did.
 */
export function cognitionOverStore(store: MemoryStore, posture: MemoryPosture): MemoryCognition {
  return {
    async intelligence(ctx) {
      try {
        return intelligenceSlot(store, {
          now: new Date(ctx.now),
          timeZone: ctx.timeZone,
          posture,
          label: metricLabel,
        })
      } catch {
        return null
      }
    },
    async domainContexts(facts, ctx) {
      try {
        const opts: DomainContextOptions = { posture, timeZone: ctx.timeZone, hour12: ctx.hour12 }
        return domainContexts(store, facts, opts)
      } catch {
        return []
      }
    },
  }
}

/**
 * THE HOST'S CHOICE OF TRANSPORT, INSTALLED ONCE.
 *
 * Null until a host installs one, and null is not an error state: it is a
 * deploy with no memory core bound, which must behave exactly like one whose
 * capabilities are all shadowed.
 */
let installed: MemoryCognition | null = null

/** Point the read path at a transport. The Worker installs its RPC here. */
export function setCognition(c: MemoryCognition | null): void {
  installed = c
}

/**
 * The cognition this host can reach, or null.
 *
 * THE FALLBACK IS THE MAC'S WHOLE INTEGRATION. A host that installed a memory
 * store through `installMemory()` and never thought about this file gets a
 * store-backed cognition for free, which is why `node-runtime.ts` needs no
 * change and why every existing local test keeps testing the same thing. A host
 * that has a real transport — the edge — installs it explicitly and wins.
 */
export function cognition(): MemoryCognition | null {
  if (installed) return installed
  const store = memoryStore()
  return store ? cognitionOverStore(store, memoryPosture()) : null
}

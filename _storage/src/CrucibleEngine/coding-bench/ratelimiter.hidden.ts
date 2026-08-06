// HIDDEN adversarial audit suite — token-bucket + sliding-window rate limiter.
// Run via `npx tsx __audit__/ratelimiter.hidden.ts` inside the scratch project.
// Uses an injected virtual clock so timing is deterministic (no real sleeps).
import { TokenBucket, SlidingWindowLimiter } from '../src/ratelimiter'

let failures = 0
function check(name: string, cond: boolean) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} — ${name}`)
  if (!cond) failures++
}

// ── TokenBucket: capacity 3, refill 1 token/sec, virtual clock ──────────────────
let t = 0
const now = () => t
const tb = new TokenBucket(3, 1, now)
check('bucket allows up to capacity immediately', tb.tryRemove() && tb.tryRemove() && tb.tryRemove())
check('bucket blocks once drained', tb.tryRemove() === false)
t += 1000                                  // +1s → +1 token
check('bucket refills over elapsed time', tb.tryRemove() === true)
check('bucket blocks again after the single refilled token is spent', tb.tryRemove() === false)
t += 10_000                                // long idle → refill must cap at capacity
check('bucket caps refill at capacity (3 available, not 10)',
  tb.tryRemove() && tb.tryRemove() && tb.tryRemove() && tb.tryRemove() === false)

// ── SlidingWindowLimiter: 2 requests per 1000ms, per-key ────────────────────────
t = 0
const sw = new SlidingWindowLimiter(2, 1000, now)
check('window allows the 1st request', sw.allow('u1') === true)
check('window allows the 2nd request', sw.allow('u1') === true)
check('window blocks the 3rd request within the window', sw.allow('u1') === false)
check('a different key is isolated (own quota)', sw.allow('u2') === true)
t += 500
check('still blocked partway through the window', sw.allow('u1') === false)
t += 600                                   // total 1100ms — earliest request has aged out
check('window admits again once the oldest request slides out', sw.allow('u1') === true)

console.log(`\n  ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)

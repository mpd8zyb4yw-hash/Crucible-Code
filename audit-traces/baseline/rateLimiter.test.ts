import assert from 'assert'
import { SlidingWindowRateLimiter } from './rateLimiter'

// Controllable clock — window-boundary behaviour must be tested deterministically,
// never with real sleeps.
let clock = 1_000
const now = () => clock
const mk = (limit: number, win: number) => new SlidingWindowRateLimiter(limit, win, now)

{ // basic limit
  const l = mk(3, 1000)
  assert.deepStrictEqual([l.tryAcquire('a'), l.tryAcquire('a'), l.tryAcquire('a'), l.tryAcquire('a')],
    [true, true, true, false])
  console.log('  ok allows exactly `limit` then denies')
}
{ // keys are independent
  const l = mk(1, 1000)
  assert.strictEqual(l.tryAcquire('a'), true)
  assert.strictEqual(l.tryAcquire('b'), true, 'a different key has its own budget')
  assert.strictEqual(l.tryAcquire('a'), false)
  console.log('  ok per-key isolation')
}
{ // THE WINDOW BOUNDARY — the edge case the task calls out
  clock = 1_000
  const l = mk(1, 1000)
  assert.strictEqual(l.tryAcquire('a'), true)
  clock = 1_999                       // still inside the window
  assert.strictEqual(l.tryAcquire('a'), false, 'inside the window must deny')
  clock = 2_000                       // exactly one window later — the first hit ages out
  assert.strictEqual(l.tryAcquire('a'), true, 'at the boundary the old hit expires')
  console.log('  ok window boundary (inside denies, at edge allows)')
}
{ // sliding, not fixed-bucket
  clock = 1_000
  const l = mk(2, 1000)
  assert.strictEqual(l.tryAcquire('a'), true)   // t=1000
  clock = 1_500
  assert.strictEqual(l.tryAcquire('a'), true)   // t=1500
  assert.strictEqual(l.tryAcquire('a'), false)  // 2 in window
  clock = 2_001                                  // t=1000 aged out, t=1500 still live
  assert.strictEqual(l.tryAcquire('a'), true, 'only the aged-out hit frees a slot')
  assert.strictEqual(l.tryAcquire('a'), false, 'the still-live hit keeps the limit')
  console.log('  ok slides continuously (not a fixed bucket)')
}
{ // limit 0 denies everything
  const l = mk(0, 1000)
  assert.strictEqual(l.tryAcquire('a'), false)
  console.log('  ok limit=0 denies')
}
{ // input validation
  assert.throws(() => mk(1, 0), RangeError)
  console.log('  ok rejects a non-positive window')
}
{ // no unbounded growth for a hammered key
  clock = 1_000
  const l = mk(2, 100)
  for (let i = 0; i < 1000; i++) { clock += 10; l.tryAcquire('a') }
  assert.ok((l as any).hits.get('a').length <= 2, 'evicted timestamps must not accumulate')
  console.log('  ok memory stays bounded under sustained load')
}
console.log('all passed')

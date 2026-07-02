// HIDDEN adversarial audit suite — persistent LRU+TTL KV store with WAL crash-recovery.
// The agent never sees this file. It is copied into the scratch project under __audit__/
// at audit time and run via `npx tsx __audit__/kvstore.hidden.ts`. Relative import resolves
// to the agent-produced module at <scratch>/src/kvstore.ts.
//
// Exits 0 iff every adversarial case passes; non-zero otherwise. This is the un-gameable
// "Claude-level" bar: it exercises edge cases the task prompt did NOT spell out.
import { KVStore } from '../src/kvstore'
import fs from 'fs'
import os from 'os'
import path from 'path'

let failures = 0
function check(name: string, cond: boolean) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} — ${name}`)
  if (!cond) failures++
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const tmp = (tag: string) => path.join(os.tmpdir(), `kvaudit_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}.wal`)

async function main() {
  const wal = tmp('a')
  try { fs.rmSync(wal, { force: true }) } catch {}

  // 1 — basic set/get/size
  const s = new KVStore({ maxEntries: 3, walPath: wal })
  s.set('a', '1'); s.set('b', '2'); s.set('c', '3')
  check('get returns the stored value', s.get('a') === '1')
  check('size reflects entry count', s.size() === 3)

  // 2 — LRU eviction respects recency: touch 'a', insert 'd' over cap → 'b' (LRU) is evicted, 'a' survives
  s.get('a')          // 'a' becomes most-recently-used
  s.set('d', '4')     // exceeds maxEntries(3) → evict least-recently-used
  check('size stays capped at maxEntries after overflow', s.size() === 3)
  check('LRU evicts the least-recently-used key (b), not the touched one (a)', s.get('a') === '1' && s.get('b') === undefined)
  check('newest inserted key is present after eviction', s.get('d') === '4')

  // 3 — TTL expiry
  s.set('temp', 'x', 40)
  check('TTL key readable before expiry', s.get('temp') === 'x')
  await sleep(80)
  check('TTL key gone after expiry', s.get('temp') === undefined)

  // 4 — delete semantics
  s.set('k', 'v')
  check('delete returns true for an existing key', s.delete('k') === true)
  check('get after delete is undefined', s.get('k') === undefined)
  check('delete returns false for a missing key', s.delete('does-not-exist') === false)

  // 5 — overwrite updates value, not size
  s.set('a', '99')
  check('overwriting an existing key updates the value', s.get('a') === '99')
  s.close()

  // 6 — persistence + WAL replay across a fresh instance (the crash-recovery requirement)
  const wal2 = tmp('b')
  try { fs.rmSync(wal2, { force: true }) } catch {}
  const p = new KVStore({ maxEntries: 100, walPath: wal2 })
  p.set('persist1', 'hello'); p.set('persist2', 'world')
  p.set('gone', 'x'); p.delete('gone')
  p.set('expireme', 'y', 30)
  p.close()                                  // simulate clean shutdown / crash
  await sleep(60)                            // let 'expireme' lapse before reopen
  const p2 = new KVStore({ maxEntries: 100, walPath: wal2 })   // fresh instance replays WAL
  check('WAL replay recovers committed entries on a fresh instance', p2.get('persist1') === 'hello' && p2.get('persist2') === 'world')
  check('a deleted key stays deleted after WAL replay', p2.get('gone') === undefined)
  check('an entry whose TTL lapsed before reopen is not resurrected by replay', p2.get('expireme') === undefined)
  p2.close()

  try { fs.rmSync(wal, { force: true }); fs.rmSync(wal2, { force: true }) } catch {}
  console.log(`\n  ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch(e => { console.error('  audit crashed:', e?.stack ?? e); process.exit(2) })

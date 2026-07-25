// Pure, offline crash-guard bench for every `vm` sandbox tier. No model calls, no network.
// Run: npx tsx src/CrucibleEngine/reasoning/__sandboxguard_bench.ts   (npm run vgr:sandboxguard)
//
// WHY (measured live 2026-07-25, during abstain:bench): an answer's demo was ASYNC and awaited
// `fetch` — undefined inside the sandbox, because network access is denied by design. The rejection
// settled on a LATER tick, after `runInContext` had already returned, so the try/catch around the
// run never saw it; Node's default unhandled-rejection behaviour then KILLED THE HOST PROCESS
// mid-run. A verifier that executes untrusted answer code must always return a VERDICT — the code
// it runs must never be able to take the engine down.
//
// This bench exercises every tier that evaluates candidate code in a `vm` context — executionVerify
// (2 sites), contractVerify (2), faultLocalize (3, including the host-side calls into sandbox
// functions, which can also hand back a rejecting promise). Each case feeds async code that rejects
// after the sync run returns and asserts we still get a verdict AND the process is still alive.
//
// RE-PROVING THIS: `withSandboxRejectionGuard` installs ONE process-level listener the first time
// any wrapped run executes, so unwrapping a SINGLE call site still passes. To see the crash, remove
// the guard entirely (isolation-proven that way on 2026-07-25).
import { verifyPlainCodeByExecution } from './executionVerify'
import { verifyAnswerContract } from './contractVerify'
import { localizeFault, createCoverageHarness } from './faultLocalize'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

// The live artifact, near-verbatim: an async function whose await hits a denied global, called for
// its side effect so nothing ever handles the rejection.
const ASYNC_REJECTING = `async function getWinningNumber() {
  const response = await fetch('https://example.com/lottery');
  return (await response.json()).number;
}
const p = getWinningNumber();
console.log(p);`

const asAnswer = (s: string) => '```ts\n' + s + '\n```'

console.log('== every vm tier survives answer code that rejects on a later tick ==')
{
  let verdict: unknown, survived = true
  try { verdict = verifyPlainCodeByExecution(asAnswer(ASYNC_REJECTING)) } catch { survived = false }
  check('executionVerify (plain-code tier) returns a verdict', survived && !!verdict)
}
{
  // Same shape, but exported so the contract tier has an entry to probe.
  const contractSrc = `export async function fetchWinner(url: string): Promise<number> {
  const response = await fetch(url);
  return (await response.json()).number;
}
const p = fetchWinner('https://example.com/lottery');
console.log(p);`
  let verdict: any, survived = true
  try { verdict = verifyAnswerContract('write a function that fetches the winning number', asAnswer(contractSrc)) } catch { survived = false }
  check('contractVerify returns a verdict', survived && !!verdict?.status, verdict?.reason)
}
{
  // faultLocalize loads the module in vm, then CALLS the entry from the host — a returned rejecting
  // promise is the same crash class as a rejecting top-level run, so both are guarded.
  const src = `export async function lookup(id: number): Promise<number> {
  const response = await fetch('https://example.com/' + id);
  return (await response.json()).value;
}`
  let result: any, survived = true
  try {
    result = localizeFault(src, 'lookup', [{ args: [1], expected: 1 }, { args: [2], expected: 2 }])
  } catch { survived = false }
  check('localizeFault returns a result instead of dying', survived && !!result?.status, result?.reason)

  let harness: any, called: any, survived2 = true
  try {
    harness = createCoverageHarness(src)
    called = 'error' in harness ? { ok: false } : harness.call('lookup', [1])
  } catch { survived2 = false }
  check('createCoverageHarness().call() returns instead of dying', survived2 && !!called)
}

// The rejections above settle on later ticks — defer the summary past them. Without the guard the
// process exits here with `ReferenceError: fetch is not defined` and prints no verdict at all.
setTimeout(() => {
  check('process still alive after every sandbox rejection settled', true)
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}, 100)

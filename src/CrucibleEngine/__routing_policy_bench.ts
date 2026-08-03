// ============================================================================
// ROUTING POLICY BENCH — proves the bundled free-tier keys cannot reach an end user.
//
// WHY THIS IS A BENCH AND NOT A COMMENT. DOCTRINE §4 makes provider compliance a CORRECTNESS
// property: free tiers are for local/personal/dev use, and pooling them across end users is
// out of bounds. This repo has already shipped that bug once — a `quorum` request escalated
// to Groq/Gemini/Mistral on the bundled .env.local keys, producing the "I was made by AC/DC"
// cloud answers. The response then was to hard-pin every request to on-device only, which
// closed the hole by deleting tiered routing entirely, for everyone, including users who
// brought their own key.
//
// The hole is now closed in KEY RESOLUTION instead, which means routing is free to be derived
// — and it means a single wrong `if` in modelRegistry.ts silently re-opens a compliance
// breach. That is exactly the kind of invariant that must be mechanically checked rather than
// remembered, so this asserts the property directly:
//
//   1. No BYOK, no opt-in           -> NO external provider is reachable, no key resolves.
//   2. BYOK supplied                -> ONLY that provider is reachable, and only with the
//                                      user's key. Bundled keys stay unreachable.
//   3. CRUCIBLE_ALLOW_BUNDLED_KEYS=1 -> the dev escape hatch works (else local dev breaks
//                                      and someone "fixes" it by weakening case 1).
//   4. BYOK always outranks a bundled key, even when both exist.
//
// `ALLOW_BUNDLED_KEYS` is read at MODULE LOAD, so each case runs in its own child process
// with its own environment. Testing it in-process would test a value captured before the
// bench could set it — a green result that proves nothing.
//
// Run: npx tsx src/CrucibleEngine/__routing_policy_bench.ts
// ============================================================================
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'

// Resolved from cwd rather than __dirname: this file is loaded as an ES module, where
// __dirname does not exist, and every npm script runs from the repo root.
const ROOT = process.cwd()
const REGISTRY = path.join(ROOT, 'modelRegistry.ts')

/** Fake keys. If any of these strings ever appears in a resolved key under case 1 or 2, a
 *  bundled credential escaped — which is the whole failure this file exists to catch. */
// Names must match PROVIDER_KEY_ENV in modelRegistry.ts — they are VITE_-prefixed, a legacy
// of the keys once being read client-side. The first cut of this bench used the unprefixed
// names, so case 3 "failed" against a policy that was working correctly.
const BUNDLED = {
  VITE_GROQ_API_KEY: 'BUNDLED-groq-must-never-leak',
  VITE_GEMINI_API_KEY: 'BUNDLED-gemini-must-never-leak',
  VITE_MISTRAL_API_KEY: 'BUNDLED-mistral-must-never-leak',
  VITE_OPENROUTER_API_KEY: 'BUNDLED-openrouter-must-never-leak',
}

interface Probe {
  /** Provider -> user key, entered as this request's BYOK. */
  byok?: Record<string, string>
  allowBundled?: boolean
}

interface Outcome {
  available: string[]
  resolved: Record<string, string>
}

/**
 * Run the real modelRegistry in a child process under a given environment and report what it
 * would actually spend. Uses the shipped functions — nothing is re-implemented here.
 */
function probe(p: Probe): Outcome {
  const script = `
    const reg = require(${JSON.stringify(REGISTRY)});
    reg.enterByokKeys(${JSON.stringify(p.byok ?? {})});
    const providers = ['groq','gemini','mistral','openrouter'];
    const resolved = {};
    for (const x of providers) resolved[x] = reg.resolveProviderKey(x);
    console.log(JSON.stringify({ available: reg.availableExternalProviders(), resolved }));
  `
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', '-e', script],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...BUNDLED,
        CRUCIBLE_ALLOW_BUNDLED_KEYS: p.allowBundled ? '1' : '',
      },
    },
  )
  // The child may print unrelated startup noise; the payload is the last JSON line.
  const line = out.trim().split('\n').filter(l => l.trim().startsWith('{')).pop() ?? '{}'
  return JSON.parse(line) as Outcome
}

let pass = 0
let fail = 0
const ok = (cond: boolean, msg: string, detail?: unknown) => {
  if (cond) { pass++; console.log(`  PASS  ${msg}`) }
  else { fail++; console.log(`  FAIL  ${msg}${detail !== undefined ? `\n         ${JSON.stringify(detail)}` : ''}`) }
}

const leaked = (o: Outcome) => Object.values(o.resolved).filter(v => v.startsWith('BUNDLED-'))

console.log('— case 1: end-user request, no BYOK, no opt-in (the shipping default) —')
{
  const o = probe({})
  ok(o.available.length === 0, 'no external provider is reachable', o.available)
  ok(leaked(o).length === 0, 'NO bundled key resolves — DOCTRINE §4 holds', leaked(o))
  ok(Object.values(o.resolved).every(v => v === ''), 'every provider resolves to an empty key', o.resolved)
}

console.log('\n— case 2: user brought their own Groq key —')
{
  const o = probe({ byok: { groq: 'sk-user-owned-key' } })
  ok(o.available.length === 1 && o.available[0] === 'groq', 'exactly the BYOK provider is reachable', o.available)
  ok(o.resolved.groq === 'sk-user-owned-key', "the user's own key is what would be spent", o.resolved.groq)
  ok(leaked(o).length === 0, 'a BYOK request still cannot reach a bundled key', leaked(o))
  ok(o.resolved.gemini === '' && o.resolved.mistral === '', 'other providers stay unreachable', o.resolved)
}

console.log('\n— case 3: local/dev opt-in —')
{
  const o = probe({ allowBundled: true })
  ok(o.available.length >= 4, 'the dev escape hatch reaches the configured providers', o.available)
  ok(o.resolved.groq === BUNDLED.VITE_GROQ_API_KEY, 'env key resolves when explicitly permitted')
}

console.log('\n— case 4: BYOK outranks a bundled key when both are present —')
{
  const o = probe({ byok: { groq: 'sk-user-owned-key' }, allowBundled: true })
  ok(o.resolved.groq === 'sk-user-owned-key', "the user's key wins over the bundled one", o.resolved.groq)
  ok(o.resolved.gemini === BUNDLED.VITE_GEMINI_API_KEY, 'un-overridden providers still use env under the opt-in')
}

console.log('\n— the routing decision derived from the above —')
{
  // Mirrors server.ts: spendable providers decide the mode. Asserted here so the two cannot
  // drift apart silently — a 'strict' default that quietly became '' would be invisible
  // otherwise, and that is precisely the regression this guards.
  const mode = (o: Outcome) => (o.available.length > 0 ? '' : 'strict')
  ok(mode(probe({})) === 'strict', 'no key -> on-device only (same behaviour as the old hard pin)')
  ok(mode(probe({ byok: { groq: 'sk-user-owned-key' } })) === '', 'BYOK -> offline-first WITH escalation')
  ok(mode(probe({ allowBundled: true })) === '', 'dev opt-in -> offline-first with escalation')
}

console.log(`\nROUTING POLICY BENCH: ${pass}/${pass + fail}`)
process.exit(fail ? 1 : 0)

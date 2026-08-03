// Live probe for the keyless source federation. Hits the real network — a source that
// looks right in code and returns nothing in production is the exact failure this whole
// module exists to fix, so it is verified against the live APIs, not mocked.
// Run: npx tsx src/CrucibleEngine/retrieval/__sources_probe.ts
import { federatedSearch, classifyIntent } from './sources'

const PROBES: Array<{ q: string; expectIntent: string; mustMention?: RegExp }> = [
  { q: 'What is the weather in Tokyo?', expectIntent: 'weather', mustMention: /temperature/i },
  { q: 'What is the capital of Australia?', expectIntent: 'geography', mustMention: /Canberra/i },
  { q: 'population of Japan', expectIntent: 'geography', mustMention: /population/i },
  { q: 'define ephemeral', expectIntent: 'definition', mustMention: /short|brief|transient|lasting/i },
  { q: 'What are the main differences between HTTP/2 and HTTP/3?', expectIntent: 'general', mustMention: /QUIC|head-of-line/i },
  { q: 'recent research on retrieval augmented generation', expectIntent: 'academic', mustMention: /retrieval|generation/i },
  { q: 'latest Node.js LTS version', expectIntent: 'tech_current' },
  { q: 'Who is Ada Lovelace?', expectIntent: 'entity_fact', mustMention: /Lovelace/i },
]

async function main() {
  let pass = 0, fail = 0
  const sourceHits: Record<string, number> = {}

  for (const p of PROBES) {
    const intent = classifyIntent(p.q)
    const t0 = Date.now()
    const r = await federatedSearch(p.q)
    const ms = Date.now() - t0
    const withBody = r.docs.filter(d => d.text && d.text.length > 80)
    const corpus = r.docs.map(d => `${d.title}\n${d.text ?? d.snippet}`).join('\n').slice(0, 20000)

    for (const s of r.ran) sourceHits[s.id] = (sourceHits[s.id] ?? 0) + s.count

    console.log(`\n${'─'.repeat(76)}`)
    console.log(`Q: ${p.q}`)
    console.log(`  intent=${intent} (expected ${p.expectIntent})  ${ms}ms  docs=${r.docs.length}  withBody=${withBody.length}`)
    console.log(`  sources: ${r.ran.map(s => `${s.id}:${s.count}(${s.ms}ms)`).join('  ')}`)
    for (const d of r.docs.slice(0, 3)) {
      console.log(`   [${d.tier}/${d.sourceId}] ${d.title.slice(0, 66)}`)
      console.log(`      ${(d.text ?? d.snippet).replace(/\s+/g, ' ').slice(0, 150)}`)
    }

    let ok = true
    if (intent !== p.expectIntent) { console.log(`  FAIL intent: got ${intent}, expected ${p.expectIntent}`); ok = false }
    if (r.docs.length === 0) { console.log(`  FAIL: zero documents`); ok = false }
    if (withBody.length === 0) { console.log(`  FAIL: no document carried a real body (>80 chars) — unverifiable by construction`); ok = false }
    if (p.mustMention && !p.mustMention.test(corpus)) { console.log(`  FAIL: corpus never mentions ${p.mustMention}`); ok = false }
    if (ok) { pass++; console.log('  PASS') } else fail++
  }

  console.log(`\n${'═'.repeat(76)}`)
  console.log(`${pass} passed, ${fail} failed`)
  console.log('per-source total docs:', JSON.stringify(sourceHits))
  process.exit(fail ? 1 : 0)
}
main()

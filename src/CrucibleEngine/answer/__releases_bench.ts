// ============================================================================
// RELEASE SOLVER BENCH — hermetic. Fixed release table, fixed "today", no network.
//
// The point of pinning both is that the correct answer stops moving. A live bench against
// endoflife.date would go red every six months for reasons that have nothing to do with our
// code, and would be silently green when the network is down and everything returns null.
//
// Run: npx tsx src/CrucibleEngine/answer/__releases_bench.ts
// ============================================================================
import { parseReleaseQuery, resolveProduct, solveRelease } from './releases'

const TODAY = '2026-08-03'

// Trimmed real rows from https://endoflife.date/api/nodejs.json (fetched 2026-08-03).
const NODEJS = [
  { cycle: '26', releaseDate: '2026-05-05', lts: '2026-10-28', eol: '2029-04-30', latest: '26.5.1', latestReleaseDate: '2026-07-29' },
  { cycle: '25', releaseDate: '2025-10-15', eol: '2026-06-01', latest: '25.9.0', lts: false },
  { cycle: '24', releaseDate: '2025-05-06', lts: '2025-10-28', eol: '2028-04-30', latest: '24.18.1', latestReleaseDate: '2026-07-29' },
  { cycle: '22', releaseDate: '2024-04-24', lts: '2024-10-29', eol: '2027-04-30', latest: '22.22.0' },
  { cycle: '20', releaseDate: '2023-04-18', lts: '2023-10-24', eol: '2026-04-30', latest: '20.19.5' },
  { cycle: '18', releaseDate: '2022-04-19', lts: '2022-10-25', eol: '2025-04-30', latest: '18.20.8' },
]

// A product with no LTS concept at all — the "answer, don't abstain" branch.
const REDIS = [
  { cycle: '8.0', releaseDate: '2025-05-01', eol: false, latest: '8.0.3' },
  { cycle: '7.4', releaseDate: '2024-07-01', eol: '2026-02-01', latest: '7.4.2' },
]

const SLUGS = ['nodejs', 'redis', 'python', 'postgresql', 'go', 'ubuntu', 'spring-framework', 'oracle-jdk', 'dotnet', 'docker-engine', 'kubernetes']

const TABLES: Record<string, any[]> = { nodejs: NODEJS, redis: REDIS }
const opts = {
  today: TODAY,
  fetchSlugs: async () => SLUGS,
  fetchCycles: async (slug: string) => TABLES[slug] ?? null,
}

interface Case { q: string; want: RegExp[] | null; note?: string }

const CASES: Case[] = [
  // ── The probe that abstained on 2026-08-03 ────────────────────────────────
  { q: 'What is the current Long Term Support (LTS) version of Node.js?', want: [/\b24\b/, /24\.18\.1/],
    note: 'Node 26 has an LTS date of 2026-10-28, still in the FUTURE — it must not win.' },
  { q: 'whats the node lts version', want: [/\b24\b/] },
  { q: 'current LTS release of node.js', want: [/\b24\b/] },
  // The newest line is mentioned but must never be presented as the LTS answer.
  { q: 'node.js LTS version?', want: [/current \*\*Node\.js LTS\*\* line is \*\*24\*\*/] },

  // ── Latest, which is a different question ─────────────────────────────────
  { q: 'what is the latest version of Node.js', want: [/26\.5\.1/],
    note: '26 is newest and not EOL, so it is the latest even though 24 is the LTS.' },
  { q: 'latest nodejs release', want: [/26\.5\.1/] },

  // ── Support status of a named line ────────────────────────────────────────
  { q: 'Is Node 18 still supported?', want: [/^No/m, /end of life/i] },
  { q: 'is node.js 22 still supported', want: [/^Yes/m, /April 30, 2027/] },
  { q: 'is node 20 supported', want: [/^No/m], note: '20 EOL 2026-04-30, before today 2026-08-03.' },

  // ── End of life dates ─────────────────────────────────────────────────────
  { q: 'when does Node 24 reach end of life', want: [/April 30, 2028/] },
  { q: 'node 18 eol', want: [/April 30, 2025/, /passed/] },

  // ── Products with no LTS concept answer, they do not abstain ──────────────
  { q: 'what is the redis LTS version', want: [/does not publish long-term-support/] },
  { q: 'latest redis version', want: [/8\.0\.3/] },

  // ── Must NOT intercept ────────────────────────────────────────────────────
  { q: 'What is Node.js?', want: null, note: 'Encyclopedia question — no lifecycle words.' },
  { q: 'How do I upgrade Node.js to the latest version?', want: null, note: 'A how-to, not a lookup.' },
  { q: 'What is the difference between Node 20 and Node 22?', want: null, note: 'Comparison, not a lookup.' },
  { q: 'what is the latest version of Frobnicator9000', want: null, note: 'Unknown product must abstain, not guess.' },
  { q: 'what is the capital of Australia', want: null },
  { q: 'what version of the truth do you believe', want: null, note: 'Lifecycle word, no resolvable product.' },
]

// ── Unit-level checks on the two pieces that are easiest to get subtly wrong ──

interface Unit { name: string; got: unknown; want: unknown }
const UNITS: Unit[] = []

for (const [q, ask] of [
  ['current lts version of node', 'lts'],
  ['latest python version', 'latest'],
  ['is ubuntu 20.04 still supported', 'supported'],
  ['when is go 1.20 end of life', 'eol'],
] as const) {
  UNITS.push({ name: `ask(${q})`, got: parseReleaseQuery(q)?.ask, want: ask })
}

// The product need only be PRESENT among the candidates; ordering is the resolver's job.
for (const [q, product] of [
  ['current lts version of node.js', 'node.js'],
  ['latest postgres version', 'postgres'],
  ['what is the newest spring framework release', 'spring framework'],
  ['when does Node 24 reach end of life', 'node'],
] as const) {
  UNITS.push({
    name: `product(${q})`,
    got: parseReleaseQuery(q)?.candidates.includes(product) ?? false,
    want: true,
  })
}

// Longest n-gram must come first so a multi-word product wins over its first word.
UNITS.push({
  name: 'ngram order (spring framework before spring)',
  got: (() => {
    const c = parseReleaseQuery('what is the newest spring framework release')?.candidates ?? []
    return c.indexOf('spring framework') < c.indexOf('spring')
  })(),
  want: true,
})

// Cycle extraction must survive version-shaped noise in protocol names.
UNITS.push({ name: 'cycle(is node 20 supported)', got: parseReleaseQuery('is node 20 supported')?.cycle, want: '20' })
UNITS.push({ name: 'cycle(is ubuntu 22.04 supported)', got: parseReleaseQuery('is ubuntu 22.04 supported')?.cycle, want: '22.04' })

async function main() {
  let pass = 0
  let fail = 0

  console.log('── resolveProduct ──')
  for (const [name, want] of [
    ['node', 'nodejs'], ['node.js', 'nodejs'], ['nodejs', 'nodejs'],
    ['postgres', 'postgresql'], ['postgresql', 'postgresql'],
    ['spring framework', 'spring-framework'], ['docker', 'docker-engine'],
    ['java', 'oracle-jdk'], ['k8s', 'kubernetes'], ['go', 'go'],
    ['frobnicator9000', null], ['truth', null],
  ] as const) {
    const got = await resolveProduct(name, SLUGS)
    const ok = got === want
    ok ? pass++ : fail++
    if (!ok) console.log(`  FAIL ${name} -> ${got} (want ${want})`)
  }
  console.log(`  ${pass} ok`)

  console.log('\n── parse units ──')
  for (const u of UNITS) {
    const ok = u.got === u.want
    ok ? pass++ : fail++
    if (!ok) console.log(`  FAIL ${u.name}: got ${JSON.stringify(u.got)} want ${JSON.stringify(u.want)}`)
  }

  console.log('\n── end to end ──')
  for (const c of CASES) {
    const sol = await solveRelease(c.q, opts)
    if (c.want === null) {
      const ok = sol === null
      ok ? pass++ : fail++
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} (abstain) ${c.q}`)
      if (!ok) console.log(`       got: ${sol!.text.split('\n')[0]}`)
      continue
    }
    if (!sol) {
      fail++
      console.log(`  FAIL (null)    ${c.q}${c.note ? `  [${c.note}]` : ''}`)
      continue
    }
    const missing = c.want.filter(re => !re.test(sol.text))
    const ok = missing.length === 0
    ok ? pass++ : fail++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${c.q}`)
    if (!ok) {
      console.log(`       missing: ${missing.map(String).join(', ')}`)
      console.log(`       got: ${sol.text.replace(/\n+/g, ' | ')}`)
    }
  }

  console.log(`\nRELEASES BENCH: ${pass}/${pass + fail}`)
  if (fail) process.exit(1)
}

main().catch(e => { console.error('BENCH THREW:', e); process.exit(1) })

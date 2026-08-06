// Does semantic tool retrieval actually work? (cont.119, overhaul item 46). Run:
//   npx tsx src/CrucibleEngine/agent/__toolretrieval_bench.ts
//
// MEASURE BEFORE WIRING. Four enumerative gates were hand-fixed this session and none of them is
// the answer, because the answer cannot be a better list. This asks whether embedding the tools'
// own descriptions can do the job instead — and it is worth landing ONLY if the numbers say so.
// A retrieval layer that is 60% right would replace a predictable failure with an unpredictable
// one, which is worse.
import { retrieveTools } from './toolRetrieval'

// Requests that failed THIS SESSION, plus the ordinary asks around them. `want` is any tool that
// would be a correct choice — several requests have more than one defensible answer.
const CASES: Array<{ goal: string; want: string[] }> = [
  { goal: 'take a screenshot of my screen', want: ['screenshot'] },
  { goal: 'grab an image of what is on my screen right now', want: ['screenshot'] },
  { goal: 'sign me in to youtube', want: ['browser_sign_in'] },
  { goal: 'log into my instagram account', want: ['browser_sign_in'] },
  { goal: 'every weekday at 8am send me a summary of my inbox', want: ['schedule_task'] },
  { goal: 'remind me to check the deploy every morning', want: ['schedule_task'] },
  { goal: 'what have I got scheduled to run automatically', want: ['list_scheduled_tasks'] },
  { goal: 'stop the morning briefing from running', want: ['cancel_scheduled_task'] },
  { goal: 'save example.com as a pdf', want: ['save_pdf'] },
  { goal: 'what is in my downloads folder', want: ['list_dir'] },
  { goal: 'read the contents of server.ts', want: ['read_file'] },
  { goal: 'check my email', want: ['gmail_search'] },
  { goal: 'what meetings do I have tomorrow', want: ['calendar_list'] },
  { goal: 'open youtube and click the first video', want: ['web_open', 'web_act'] },
  { goal: 'fill in the search box on that page and press enter', want: ['web_act'] },
  { goal: 'find me a good pasta recipe', want: ['web_search'] },
  { goal: 'delete the old build folder', want: ['delete_folder', 'delete_file'] },
  { goal: 'empty the trash', want: ['empty_trash'] },
]

// Requests no tool should confidently claim — a retrieval layer that fires on these would be
// worse than the regexes it replaces.
const NO_TOOL = [
  'what is 17 times 4',
  'write me a poem about otters',
  'explain the difference between affect and effect',
]

async function main() {
  let top1 = 0, top3 = 0
  const misses: string[] = []
  console.log('  — did the right tool come back? —')
  for (const c of CASES) {
    const hits = await retrieveTools(c.goal, 3)
    if (!hits.length) { misses.push(`${c.goal} (no embedder)`); continue }
    const names = hits.map(h => h.name)
    const at1 = c.want.includes(names[0])
    const at3 = names.some(n => c.want.includes(n))
    if (at1) top1++
    if (at3) top3++
    else misses.push(`${c.goal} -> ${names.join(', ')} (wanted ${c.want.join('/')})`)
    console.log(`  ${at1 ? '1st' : at3 ? 'top3' : 'MISS'}  ${JSON.stringify(c.goal.slice(0, 46))} -> ${names.map((n, i) => `${n}:${hits[i].score.toFixed(2)}`).join('  ')}`)
  }

  console.log('\n  — and does it stay quiet when no tool applies? —')
  const noToolScores: number[] = []
  for (const g of NO_TOOL) {
    const hits = await retrieveTools(g, 1)
    const s = hits[0]?.score ?? 0
    noToolScores.push(s)
    console.log(`  ..  ${JSON.stringify(g)} -> ${hits[0]?.name ?? '(none)'}:${s.toFixed(2)}`)
  }

  const n = CASES.length
  console.log(`\ntop-1: ${top1}/${n} (${Math.round(top1 / n * 100)}%)   top-3: ${top3}/${n} (${Math.round(top3 / n * 100)}%)`)
  console.log(`highest score on a no-tool request: ${Math.max(...noToolScores).toFixed(2)}`)
  if (misses.length) {
    console.log('\nmisses:')
    for (const m of misses) console.log(`  - ${m}`)
  }
}


// ── The wired use: ADDITIVE, read-only suggestions ───────────────────────────
// Wired only where recall is what matters. Asserts the guarantees the wiring depends on.
import { suggestReadOnlyTools } from './toolRetrieval'
import { registry } from '../tools/registry'

async function suggestChecks() {
  let pass = 0, fail = 0
  const ck = (n: string, ok: boolean, d = '') => { console.log(`  ${ok ? 'OK ' : 'XX '} ${n}${ok ? '' : ` — ${d}`}`); ok ? pass++ : fail++ }
  console.log('\n  — additive read-only suggestions —')

  const CONTENT_SET = new Set(['browse_page', 'web_open', 'web_act', 'web_close', 'read_url', 'web_search',
    'save_pdf', 'save_page_image', 'screenshot', 'browser_sign_in', 'schedule_task',
    'list_scheduled_tasks', 'cancel_scheduled_task', 'list_dir', 'read_file', 'write_file'])

  const mail = await suggestReadOnlyTools('summarise the emails in my inbox from this week', CONTENT_SET, 3)
  ck('a mail request reaches a mail tool the curated set lacks', mail.includes('gmail_search'), JSON.stringify(mail))

  // Never a mutating tool: a retrieval score is not consent to send, delete or buy.
  for (const goal of ['delete everything in the trash', 'send an email to my boss', 'remove the old folder']) {
    const got = await suggestReadOnlyTools(goal, new Set(), 5)
    const mutating = got.filter(n => registry.get(n)?.mutates)
    ck(`never suggests a mutating tool for ${JSON.stringify(goal.slice(0, 34))}`, mutating.length === 0, JSON.stringify(mutating))
  }

  // Already-offered tools are not duplicated.
  const dup = await suggestReadOnlyTools('take a screenshot of my screen', CONTENT_SET, 3)
  ck('does not re-suggest a tool already offered', !dup.includes('screenshot'), JSON.stringify(dup))

  // Quiet on requests no tool serves.
  for (const goal of ['what is 17 times 4', 'write me a poem about otters']) {
    const got = await suggestReadOnlyTools(goal, CONTENT_SET, 3)
    ck(`quiet on ${JSON.stringify(goal)}`, got.length === 0, JSON.stringify(got))
  }
  console.log(`\nsuggest checks: ${pass}/${pass + fail}`)
  if (fail) process.exit(1)
}
main().then(suggestChecks).catch(e => { console.error(e); process.exit(1) })

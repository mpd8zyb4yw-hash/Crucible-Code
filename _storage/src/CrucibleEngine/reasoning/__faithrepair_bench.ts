// Pure, offline bench for the faithfulness REPAIR SEARCH. No model calls, no network:
// `complete` is a scripted list of replies, so the whole loop is deterministic.
// Run: npx tsx src/CrucibleEngine/reasoning/__faithrepair_bench.ts   (npm run vgr:faithrepair)
//
// Guards the cont.83 measured failure: detection worked, RECOVERY did not — one retry with a
// hint re-sampled the same distribution and fabricated something else. This pins the search:
// K candidates, keep any the verifier certifies, escalate the hint with what already failed.
//
// The load-bearing half is NON-REGRESSION, per cont.79h (a false reject / a bad swap teaches
// the loop to "fix" correct code): the search must NEVER ship something the verifier scores
// worse than the draft, must never accept an ABSTAIN (escaping judgement by deleting the code
// is not a repair), and must never spend a model call it was not granted.
import { repairUntilFaithful, faithfulnessVerdict, makeRepairProposer, type RepairMessage } from './faithfulRepair'
import { verifyApiFaithfulness, escalatedRepairHint, rejectedIdentifiers } from './apiFaithfulness'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

// The real zod.dev passage the live run retrieved (audit-traces/p2/evidence-routefix.txt, S1).
const ZOD_EV = `[S1] Defining schemas | Zod — https://zod.dev/api?id=ip-addresses
String formats To validate against some common string formats: z.email(); z.uuid(); z.url();
z.httpUrl(); z.hostname(); z.e164(); z.emoji(); z.base64(); z.jwt(); z.nanoid(); z.cuid();
z.ulid(); z.ipv4(); z.ipv6(); z.mac(); z.cidrv4(); z.cidrv6(); IP addresses const ipv4 = z.ipv4();
.extend() To add additional fields to an object schema: const DogWithBreed = Dog.extend({ breed: z.string() });`

const code = (s: string) => '```ts\n' + s + '\n```'
const BASE: RepairMessage[] = [{ role: 'system', content: 'ground' }, { role: 'user', content: 'zod ipv4?' }]

// [REAL] the fabrication the live FM actually emitted (t4-routefix.sse).
const DRAFT_BAD = code("import { Schema } from 'zod';\nconst ipv4Schema: Schema<string> = { type: 'string' };")
const GOOD = code("import * as z from 'zod'\nconst ipv4Schema = z.ipv4()\nexport const parse = (s: string) => ipv4Schema.parse(s)")

/** A scripted model: hands back replies in order, recording the prompts it was given. */
function scripted(replies: string[]) {
  const seenHints: string[] = []
  let i = 0
  const complete = async (msgs: RepairMessage[]) => {
    seenHints.push(msgs[msgs.length - 1].content)
    return replies[i++] ?? ''
  }
  return { complete, seenHints, calls: () => i }
}

const run = (draft: string, replies: string[], opts = {}) => {
  const s = scripted(replies)
  return repairUntilFaithful(
    { draft, evidence: ZOD_EV, goal: 'zod ipv4?', baseMsgs: BASE, complete: s.complete },
    opts,
  ).then(r => ({ r, s }))
}

/** Two scripted engines + a shared call ORDER log — the second-proposer rotation under test. */
const run2 = (draft: string, primary: string[], alt: string[], opts = {}) => {
  const order: string[] = []
  const tap = (name: string, s: ReturnType<typeof scripted>) =>
    async (m: RepairMessage[], sig?: AbortSignal) => { order.push(name); return s.complete(m) }
  const p = scripted(primary), a = scripted(alt)
  return repairUntilFaithful(
    {
      draft, evidence: ZOD_EV, goal: 'zod ipv4?', baseMsgs: BASE,
      complete: tap('afm', p), completeAlt: tap('minicpm', a),
    },
    opts,
  ).then(r => ({ r, p, a, order }))
}

;(async () => {
  console.log('== the draft is free: a certified draft spends nothing ==')
  {
    const { r, s } = await run(GOOD, [])
    check('certified draft → status certified', r.status === 'certified', r.status)
    check('certified draft → 0 model calls', r.modelCalls === 0, `${r.modelCalls}`)
    check('certified draft → model never called', s.calls() === 0)
    check('certified draft ships unchanged', r.text === GOOD)
  }

  console.log('\n== the search recovers what one retry could not ==')
  {
    // Attempt 1 fabricates something ELSE (the measured live behavior), attempt 2 gets it right.
    const { r, s } = await run(DRAFT_BAD, [code("import * as z from 'zod'\nconst s = z.parseIPv4()"), GOOD])
    check('2nd candidate certifies → status certified', r.status === 'certified', r.detail)
    check('certified text is the good one', r.text === GOOD)
    check('spent exactly 2 model calls', r.modelCalls === 2, `${r.modelCalls}`)
    check('this is the case a single retry LOSES', s.calls() === 2)
  }
  {
    // K=3 by default: a 3rd-attempt win must still land.
    const { r } = await run(DRAFT_BAD, [
      code("import * as z from 'zod'\nconst s = z.parseIPv4()"),
      code("import { validate } from 'zod'\nconst s = validate('ip')"),
      GOOD,
    ])
    check('3rd candidate certifies within K=3', r.status === 'certified', r.detail)
  }

  console.log('\n== escalation: each attempt carries what already failed ==')
  {
    const { s } = await run(DRAFT_BAD, [
      code("import * as z from 'zod'\nconst s = z.parseIPv4()"),
      code("import * as z from 'zod'\nconst s = z.checkIp()"),
      code("import * as z from 'zod'\nconst s = z.ipTest()"),
    ])
    check('1st hint names the draft fabrication', s.seenHints[0].includes('Schema'))
    check('2nd hint carries the 1st repair\'s failure', s.seenHints[1].includes('parseIPv4'), s.seenHints[1].slice(0, 120))
    check('3rd hint carries BOTH earlier failures',
      s.seenHints[2].includes('parseIPv4') && s.seenHints[2].includes('checkIp'), s.seenHints[2].slice(0, 160))
    check('escalated hint tells it to copy verbatim', /VERBATIM/i.test(s.seenHints[1]))
    check('every hint still offers the documented surface', s.seenHints.every(h => h.includes('ipv4')))
  }

  console.log('\n== honest failure: K exhausted ships the DRAFT, unverified ==')
  {
    const { r } = await run(DRAFT_BAD, [
      code("import * as z from 'zod'\nconst s = z.parseIPv4()"),
      code("import * as z from 'zod'\nconst s = z.checkIp()"),
      code("import * as z from 'zod'\nconst s = z.ipTest()"),
    ])
    check('nothing certifies → status unrepaired', r.status === 'unrepaired', r.status)
    check('ships the original draft', r.text === DRAFT_BAD)
    check('verdict is the draft\'s real violation', r.verdict.status === 'violations')
    check('detail admits the measured ceiling', /no candidate certified/.test(r.detail), r.detail)
    check('K bounds the spend', r.modelCalls === 3, `${r.modelCalls}`)
  }

  console.log('\n== NON-REGRESSION: the search may never make the answer worse ==')
  {
    // A repair that swaps 1 fabrication for 2 must be discarded, not shipped.
    const { r } = await run(DRAFT_BAD, [code("import { A, B } from 'zod'\nconst s: A = B()")])
    check('a WORSE repair is discarded', r.text === DRAFT_BAD, r.detail)
    check('discarding a worse repair → unrepaired', r.status === 'unrepaired')
  }
  {
    // Escaping judgement is not repair: deleting the code abstains, and must never be selected.
    const { r } = await run(DRAFT_BAD, ['Sorry, I cannot help with that.', 'Still no code here.'])
    check('an ABSTAINing repair is never shipped', r.text === DRAFT_BAD, r.status)
    check('abstain scores below every real violation count',
      faithfulnessVerdict(verifyApiFaithfulness('prose', ZOD_EV)).score
      < faithfulnessVerdict(verifyApiFaithfulness(code("import { A, B, C } from 'zod'\nconst x: A = 1"), ZOD_EV)).score)
  }
  {
    // Ties resolve to the draft — the ranking is a proxy, so equal score is not an improvement.
    const { r } = await run(DRAFT_BAD, [code("import { Widget } from 'zod'\nconst ipv4Schema: Widget<string> = { t: 1 };")])
    check('an equally-bad repair does NOT displace the draft', r.text === DRAFT_BAD, r.detail)
  }

  console.log('\n== best-effort: a strict, verifier-measured improvement ==')
  {
    // Draft has 2 fabrications; the repair leaves 1. Not certified — but measurably better.
    const draft2 = code("import { Schema, Infer } from 'zod'\nconst s: Schema<string> = Infer('ip')")
    const { r } = await run(draft2, [code("import { Schema } from 'zod'\nconst s: Schema<string> = z.ipv4()")])
    check('strict improvement → best-effort', r.status === 'best-effort', r.detail)
    check('best-effort still NOT certified', r.verdict.status === 'violations')
    check('detail reports the measured delta', /2 → 1|fabricated/.test(r.detail), r.detail)
  }

  console.log('\n== budget + abort: never spend what was not granted ==')
  {
    const { r, s } = await run(DRAFT_BAD, [GOOD], { canPropose: () => false })
    check('canPropose false → no model call', s.calls() === 0, `${s.calls()}`)
    check('canPropose false → ships the draft', r.text === DRAFT_BAD && r.status === 'unrepaired')
    check('canPropose false → 0 model calls charged', r.modelCalls === 0)
    check('canPropose false → terminates (no spin)', r.detail.length > 0)
  }
  {
    const { r } = await run(DRAFT_BAD, [GOOD], { attempts: 1 })
    check('attempts=1 still allows one real repair', r.status === 'certified', r.detail)
  }
  {
    const ac = new AbortController()
    ac.abort()
    const { r, s } = await run(DRAFT_BAD, [GOOD], { signal: ac.signal })
    check('aborted → no model call', s.calls() === 0)
    check('aborted → ships the draft', r.text === DRAFT_BAD)
  }

  console.log('\n== anti-thrash: an identical repeated proposal is not re-verified ==')
  {
    const same = code("import * as z from 'zod'\nconst s = z.parseIPv4()")
    const { r } = await run(DRAFT_BAD, [same, same, same])
    check('duplicate proposals terminate honestly', r.status === 'unrepaired', r.status)
    check('duplicates ship the draft', r.text === DRAFT_BAD)
  }

  console.log('\n== SECOND PROPOSER: MiniCPM seated alongside the FM (cont.86) ==')
  {
    // The measured cont.84/85 ceiling: the FM re-proposes a name the hint just rejected, forever.
    // An independent generator gets the very next attempt and certifies. This is the whole point.
    const { r, order } = await run2(DRAFT_BAD, [code("import * as z from 'zod'\nconst s = z.parseIPv4()")], [GOOD])
    check('alt certifies what the FM could not', r.status === 'certified', r.detail)
    check('certified text is the alt\'s', r.text === GOOD)
    check('attributed to minicpm', r.proposedBy === 'minicpm', r.proposedBy)
    check('detail names the winning engine', /minicpm/.test(r.detail), r.detail)
    check('FM opened, alt took the next slot', JSON.stringify(order) === JSON.stringify(['afm', 'minicpm']), order.join(','))
  }
  {
    // Rotation over K=3: afm → minicpm → afm. The FM opens (stronger on this path), the alt gets
    // the attempt right after the FM's first failure, and the FM keeps the majority of the budget.
    const bad = (n: string) => code(`import * as z from 'zod'\nconst s = z.${n}()`)
    const { r, order } = await run2(DRAFT_BAD, [bad('aa'), bad('bb')], [bad('cc')])
    check('K=3 rotates afm → minicpm → afm',
      JSON.stringify(order) === JSON.stringify(['afm', 'minicpm', 'afm']), order.join(','))
    check('rotation spends exactly K model calls', r.modelCalls === 3, `${r.modelCalls}`)
    check('nothing certified → still ships the draft', r.text === DRAFT_BAD && r.status === 'unrepaired')
    check('honest failure names BOTH engines tried', /afm/.test(r.detail) && /minicpm/.test(r.detail), r.detail)
  }
  {
    // ANTI-STARVATION — the property that dies if rotation keys off history.length instead of an
    // attempt counter. A whiffing alt (not resident / timed out / reasoning leak) returns '' → a
    // null proposal → search retries the SAME slot free of charge. Keyed on history, the alt would
    // be re-selected forever and the FM would never get its remaining calls.
    const { r, p, a, order } = await run2(
      DRAFT_BAD,
      [code("import * as z from 'zod'\nconst s = z.parseIPv4()"), code("import * as z from 'zod'\nconst s = z.checkIp()"), GOOD],
      ['', '', ''],   // MiniCPM never produces usable output
    )
    check('a whiffing alt does not starve the FM', r.status === 'certified', r.detail)
    check('FM still got all K=3 of its calls', p.calls() === 3, `${p.calls()}`)
    check('the alt was still tried (not silently skipped)', a.calls() > 0, `${a.calls()}`)
    check('a whiffed alt call charges NO budget', r.modelCalls === 3, `${r.modelCalls}`)
    check('slot rotates back to the FM after a whiff',
      order.filter(o => o === 'afm').length === 3, order.join(','))
    check('whiffed alt → result attributed to the FM', r.proposedBy === 'afm', r.proposedBy)
  }
  {
    // Identical prompting: the escalating hint is the entire mechanism, so handicapping either
    // engine would make the attribution meaningless (see __fault_headtohead's same discipline).
    const { p, a } = await run2(
      DRAFT_BAD,
      [code("import * as z from 'zod'\nconst s = z.parseIPv4()"), code("import * as z from 'zod'\nconst s = z.zz()")],
      [code("import * as z from 'zod'\nconst s = z.checkIp()")],
    )
    check('alt receives a real escalating hint', a.seenHints.length === 1 && a.seenHints[0].includes('parseIPv4'),
      (a.seenHints[0] ?? '').slice(0, 120))
    check('alt hint offers the documented surface too', a.seenHints[0].includes('ipv4'))
    check('the FM\'s next hint carries the ALT\'s failure', p.seenHints[1]?.includes('checkIp'),
      (p.seenHints[1] ?? '').slice(0, 160))
  }
  {
    // NON-REGRESSION: the alt is bound by the same verifier. A worse alt repair is discarded.
    const { r } = await run2(DRAFT_BAD, [code("import * as z from 'zod'\nconst s = z.parseIPv4()")],
      [code("import { A, B } from 'zod'\nconst s: A = B()")])
    check('a WORSE alt repair is discarded', r.text === DRAFT_BAD, r.detail)
    check('an abstaining alt cannot win', r.status === 'unrepaired', r.status)
  }
  {
    // No alt injected (MiniCPM never downloaded) → byte-for-byte the single-proposer search.
    const { r } = await run(DRAFT_BAD, [GOOD])
    check('no alt → unchanged single-proposer behavior', r.status === 'certified' && r.text === GOOD)
    check('no alt → attributed to the FM', r.proposedBy === 'afm', r.proposedBy)
  }
  {
    const { r } = await run(GOOD, [])
    check('a free certified draft is attributed to the draft', r.proposedBy === 'draft', r.proposedBy)
    check('draft-certified detail claims no repair call', /already faithful/.test(r.detail), r.detail)
  }
  {
    // best-effort must attribute too — a partial win is still a measurement.
    const draft2 = code("import { Schema, Infer } from 'zod'\nconst s: Schema<string> = Infer('ip')")
    const { r } = await run2(draft2, [code("import { Schema, Infer } from 'zod'\nconst s: Schema<string> = Infer('ip4')")],
      [code("import { Schema } from 'zod'\nconst s: Schema<string> = z.ipv4()")])
    check('best-effort attributes the improving engine', r.status === 'best-effort' && r.proposedBy === 'minicpm',
      `${r.status}/${r.proposedBy}`)
    check('best-effort detail names the engine', /minicpm/.test(r.detail), r.detail)
  }

  console.log('\n== hint plumbing (pure) ==')
  {
    const v1 = verifyApiFaithfulness(code("import { Schema } from 'zod';"), ZOD_EV)
    const v2 = verifyApiFaithfulness(code("import * as z from 'zod'\nconst s = z.parseIPv4()"), ZOD_EV)
    check('rejectedIdentifiers unions across verdicts',
      JSON.stringify(rejectedIdentifiers([v1, v2])) === JSON.stringify(['Schema', 'parseIPv4'].sort()))
    check('rejectedIdentifiers hides the ignored-evidence placeholder',
      rejectedIdentifiers([verifyApiFaithfulness(code('const schema = { type: "string", format: "ipv4", pattern: "^[0-9.]+$" };\nmodule.exports = schema;'), ZOD_EV)]).length === 0)
    check('escalatedRepairHint with no prior == a plain hint', escalatedRepairHint(v1, []).includes('Schema'))
    check('escalatedRepairHint is empty for a certified verdict',
      escalatedRepairHint(verifyApiFaithfulness(GOOD, ZOD_EV), [v1]) === '')
    check('escalatedRepairHint does not repeat the current violation as "already tried"',
      (escalatedRepairHint(v1, [v1]).match(/Schema/g) ?? []).length < 3)
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
})()

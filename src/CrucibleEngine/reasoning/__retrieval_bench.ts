// ═══════════════════════════════════════════════════════════════════════════════
// RETRIEVAL-PROPOSER bench — proves web code becomes an EXECUTABLE, CERTIFIED candidate.
// Run:  npm run vgr:retrieval
// ═══════════════════════════════════════════════════════════════════════════════
//
// No live FM and no network — a deterministic `webGround` returns fixed reference
// source, and the REAL execution verifier (verifyCode, in-process via search) decides.
// This proves the doctrine step the live parseClock runs demanded: retrieved code,
// mechanically aliased to the target signature and run STRAIGHT through the verifier,
// certifies the kernel with ZERO model calls — the FM never touches it.
//
//   1. EXTRACT      — pull function/const-arrow/expression defs out of messy web source
//                     (imports/exports/module.exports stripped; braces in strings ignored).
//   2. ALIAS        — re-export the chosen fn under the target name; siblings preserved so
//                     inter-helper calls resolve; name-collision handled.
//   3. CERTIFY      — the retrieval candidate PASSES the real verifier through search().
//   4. FALLTHROUGH  — composeProposers tries every retrieved candidate, then the FM; a dry
//                     retriever yields nothing and the FM path is reached unharmed.
//   5. PARSECLOCK   — the exact live-failing kernel: retrieval certifies it with 0 FM calls.
// ═══════════════════════════════════════════════════════════════════════════════

import { verifyCode, type CodeCase } from './codeVerifier'
import {
  extractFunctions, sanitizeRetrievedSource, aliasToEntry, matchDelimiter,
  makeRetrievalProposer, composeProposers,
} from './retrievalProposer'
import { search } from './search'
import { solveCodeTask, decomposeCodeBySubFunction, type SubFunctionSpec } from './solve'
import type { Candidate, Proposer, TaskSpec } from './types'

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

const spec = (entry: string, cases: CodeCase[]): TaskSpec =>
  ({ goal: `implement ${entry}`, domain: 'code', acceptance: { entry, cases } as unknown as Record<string, unknown> })

async function main() {
  console.log('\nRETRIEVAL-PROPOSER bench — web code → executable candidate → certified\n')

  // ── 1. EXTRACTION over messy, module-wrapped web source. ─────────────────────────
  {
    const web = `
import { pad } from './util'
const NAMES = ['a', 'b']
export function toMinutes(str) {
  // handles "1:30 pm"  — note the '}' in this string should not confuse the scanner: "}"
  const m = str.match(/(\\d+):(\\d+)\\s*(am|pm)/i)
  let h = Number(m[1]) % 12
  if (/pm/i.test(m[3])) h += 12
  return h * 60 + Number(m[2])
}
export const isPm = (s) => /pm/i.test(s);
const double = n => n * 2;
module.exports = { toMinutes, isPm }
`
    const fns = extractFunctions(web)
    const names = fns.map(f => f.name)
    check('1 extracts the function declaration', names.includes('toMinutes'))
    check('1 extracts the const arrow binding', names.includes('isPm'))
    check('1 extracts the expression-body arrow', names.includes('double'))
    const tm = fns.find(f => f.name === 'toMinutes')!
    check('1 function body is captured whole (brace-matched past a "}" inside a string)',
      tm.source.includes('return h * 60') && tm.source.trimEnd().endsWith('}'), tm.source)
    check('1 arity is read from the params', tm.arity === 1, `arity=${tm.arity}`)
    const san = sanitizeRetrievedSource(web)
    check('1 sanitize strips import/module.exports/export plumbing',
      !/\bimport\b/.test(san) && !/module\.exports/.test(san) && !/^\s*export\s/m.test(san), san)
  }

  // ── 1b. matchDelimiter honors strings, templates, comments. ──────────────────────
  {
    const s = 'f() { const a = "}"; const b = `${x}}`; /* } */ return 1 }'
    const open = s.indexOf('{')
    const end = matchDelimiter(s, open)
    check('1b matchDelimiter skips braces in strings/templates/comments', s.slice(end) === '', s.slice(end))
  }

  // ── 2. ALIASING: re-export under the target name; siblings kept; collision handled. ──
  {
    const web = 'function toMinutes(s){ return helper(s) }\nfunction helper(s){ return s.length }'
    const aliased = aliasToEntry(web, 'toMinutes', 'parseClock')
    check('2 binds chosen fn to the target entry name (local const + export)',
      /const\s+parseClock\s*=\s*toMinutes\s*;/.test(aliased) && /export\s*\{\s*parseClock\s*\}/.test(aliased), aliased)
    check('2 keeps sibling helpers so inter-helper calls resolve', /function helper/.test(aliased))
    const same = aliasToEntry('function parseClock(s){ return 1 }', 'parseClock', 'parseClock')
    check('2 name-collision (chosen === entry) just exports it', /export\s*\{\s*parseClock\s*\}/.test(same), same)
  }

  // ── 3. CERTIFY: a retrieved candidate PASSES the real verifier through search, 0 FM. ──
  {
    let fmCalls = 0
    const fm: Proposer<string> = async () => { fmCalls++; return { value: 'export function evensOnly(a){ return a }', fingerprint: `fm${fmCalls}` } }
    const webGround = async () => `
export function keepEvens(arr) { return arr.filter(n => n % 2 === 0) }
export const other = x => x
`
    const retrieval = makeRetrievalProposer({ entry: 'evensOnly', goal: 'keep only even numbers', webGround, wantArity: 1 })
    const proposer = composeProposers(retrieval, fm)
    const r = await search(spec('evensOnly', [{ args: [[1, 2, 3, 4]], expected: [2, 4] }, { args: [[5, 6]], expected: [6] }]),
      proposer, verifyCode, { maxModelCalls: 6 })
    check('3 retrieval candidate is certified by the REAL verifier', r.status === 'solved', JSON.stringify({ s: r.status, d: r.detail }))
    check('3 the certified solution is the RETRIEVED code (filter), not the FM stub', /filter/.test(r.solution?.value ?? ''), r.solution?.value ?? '')
    check('3 the FM was never consulted (kernel solved by the internet)', fmCalls === 0, `fmCalls=${fmCalls}`)
  }

  // ── 4. FALLTHROUGH: a DRY retriever yields nothing → the FM path is reached unharmed. ──
  {
    let fmCalls = 0
    const fm: Proposer<string> = async () => {
      fmCalls++
      return { value: 'export function evensOnly(a){ return a.filter(n => n % 2 === 0) }', fingerprint: `fm${fmCalls}` }
    }
    const dry = makeRetrievalProposer({ entry: 'evensOnly', goal: 'keep evens', webGround: async () => null })
    const r = await search(spec('evensOnly', [{ args: [[1, 2]], expected: [2] }]), composeProposers(dry, fm), verifyCode, { maxModelCalls: 6 })
    check('4 a dry retriever falls through to the FM and still solves', r.status === 'solved' && fmCalls >= 1, JSON.stringify({ s: r.status, fmCalls }))

    // a retriever whose source has no functions also falls through cleanly
    let fmCalls2 = 0
    const fm2: Proposer<string> = async () => { fmCalls2++; return { value: 'export function id(x){ return x }', fingerprint: `f${fmCalls2}` } }
    const noFns = makeRetrievalProposer({ entry: 'id', goal: 'identity', webGround: async () => 'const NAMES = [1,2,3]; // no functions here' })
    const r2 = await search(spec('id', [{ args: [7], expected: 7 }]), composeProposers(noFns, fm2), verifyCode, { maxModelCalls: 4 })
    check('4 source-with-no-functions also falls through to the FM', r2.status === 'solved' && fmCalls2 >= 1, JSON.stringify({ s: r2.status, fmCalls2 }))
  }

  // ── 5. PARSECLOCK — the exact kernel that thrashed the FM live. Retrieval certifies it. ──
  //     Reference source is a realistic StackOverflow-shaped answer (module-wrapped, extra
  //     helpers, a differently-named entry). Extraction + aliasing + execution close it with
  //     ZERO model calls — the load-bearing proof of "the internet solves the kernel".
  {
    const referenceFromWeb = `
// https://stackoverflow.com/questions/xxxx  — 12h clock to minutes since midnight
const clean = (s) => s.trim().toLowerCase()
function to24(hour, isPm) {
  let h = hour % 12
  if (isPm) h += 12
  return h
}
export function timeToMinutes(input) {
  const s = clean(input)
  const m = s.match(/^(\\d{1,2}):(\\d{2})\\s*(am|pm)$/)
  if (!m) return null
  const minutes = to24(Number(m[1]), m[3] === 'pm') * 60 + Number(m[2])
  return minutes
}
module.exports = { timeToMinutes }
`
    let fmCalls = 0
    const fm: Proposer<string> = async () => {
      // the live failure mode: split(':') never isolates the am/pm suffix
      fmCalls++
      return { value: "export function parseClock(s){ const [h,m] = s.split(':'); return Number(h)*60 + Number(m) }", fingerprint: `fm${fmCalls}` }
    }
    const cases: CodeCase[] = [
      { args: ['12:00 am'], expected: 0 },
      { args: ['1:30 am'], expected: 90 },
      { args: ['12:00 pm'], expected: 720 },
      { args: ['1:30 pm'], expected: 810 },
      { args: ['11:59 pm'], expected: 1439 },
    ]
    const retrieval = makeRetrievalProposer({
      entry: 'parseClock', goal: 'convert 12 hour am pm time to minutes since midnight', wantArity: 1,
      webGround: async () => referenceFromWeb,
    })
    const r = await search(spec('parseClock', cases), composeProposers(retrieval, fm), verifyCode, { maxModelCalls: 8 })
    check('5 parseClock is CERTIFIED from the retrieved reference', r.status === 'solved', JSON.stringify({ s: r.status, d: r.detail }))
    check('5 the FM (which would thrash on split(":")) was never consulted', fmCalls === 0, `fmCalls=${fmCalls}`)
    check('5 the certified code is the adapted web reference (timeToMinutes bound to parseClock)',
      /timeToMinutes/.test(r.solution?.value ?? '') && /const\s+parseClock\s*=\s*timeToMinutes\s*;/.test(r.solution?.value ?? ''), r.solution?.value ?? '')

    // Control: WITHOUT retrieval the FM alone cannot solve it (proves the candidate path is what closes it).
    const alone = await solveCodeTask({ goal: 'parseClock', entry: 'parseClock', cases }, { maxModelCalls: 6 }, fm)
    check('5 CONTROL: the FM alone does NOT solve parseClock (retrieval is doing the work)', alone.status !== 'solved', alone.status)
  }

  // ── 6. WIRED END-TO-END: decomposeCodeBySubFunction certifies a helper from RETRIEVAL. ──
  //     The FM can plan (name the kernel) and compose, but CANNOT implement the kernel helper.
  //     The wired retrieval path supplies the helper from web source, aliased + executed. This
  //     proves the whole doctrine chain live: decompose → corner the kernel → retrieve it → verify.
  {
    const cases: CodeCase[] = [
      { args: ['12:00 am'], expected: 0 },
      { args: ['1:30 pm'], expected: 810 },
      { args: ['11:59 pm'], expected: 1439 },
    ]
    // Planner cornering the kernel into one helper `toMins`.
    const planner = async (): Promise<SubFunctionSpec[]> => [
      { name: 'toMins', goal: 'convert a 12-hour am/pm clock string to minutes since midnight',
        cases: [{ args: ['12:00 am'], expected: 0 }, { args: ['1:30 pm'], expected: 810 }] },
    ]
    // FM: composes correctly (calls toMins) but produces BROKEN code for the kernel helper itself.
    const fm: Proposer<string> = async (ctx) => {
      const entry = (ctx.spec.acceptance as { entry: string }).entry
      if (entry === 'toMins') return { value: "export function toMins(s){ const [h,m]=s.split(':'); return +h*60 + +m }", fingerprint: 'fm-broken' }
      return { value: 'export function parseClock(s){ return toMins(s) }', fingerprint: 'fm-compose' }
    }
    // Web reference implementing exactly the kernel (differently named, module-wrapped).
    const webGround = async () => `
const clean = s => s.trim().toLowerCase()
export function timeToMinutes(input) {
  const m = clean(input).match(/^(\\d{1,2}):(\\d{2})\\s*(am|pm)$/)
  if (!m) return null
  let h = Number(m[1]) % 12
  if (m[3] === 'pm') h += 12
  return h * 60 + Number(m[2])
}
module.exports = { timeToMinutes }
`
    const r = await decomposeCodeBySubFunction(
      { goal: 'parse a 12-hour clock string to minutes since midnight', nl: 'convert 12 hour am pm time to minutes since midnight', entry: 'parseClock', cases },
      { planner, webGround, planAttempts: 1 },
      fm,
    )
    check('6 WIRED decompose solves parseClock end-to-end (kernel from retrieval)', r.status === 'solved', JSON.stringify({ s: r.status, d: r.detail }))
    check('6 the kernel helper `toMins` certified (via retrieved reference, FM impl was broken)',
      r.rungs.some(x => x.name === 'toMins' && x.certified), JSON.stringify(r.rungs.map(x => ({ n: x.name, c: x.certified }))))
    check('6 the final module contains the adapted web helper', /timeToMinutes/.test(r.code ?? ''), (r.code ?? '').slice(0, 120))
  }

  // ── 7. CROSS-FILE DIVERSITY — same-named alternate impls survive as DISTINCT candidates. ──
  //     The regression this guards: extractFunctions dedups by name (first-wins). When two
  //     files each define `slugify` and the SPEC-BREAKING one (transliterates `&`→`and`) is
  //     seen first, joining them into one blob would discard the plain, spec-matching impl and
  //     retrieval could never certify. Returning per-file blobs keeps both — the verifier picks
  //     the one that passes. File order is adversarial: the wrong impl is first.
  {
    const optionHeavy = `
// library slugify: transliterates ampersand to the word "and" — FAILS "Rock & Roll" → "rock-roll"
export function slugify(str, options = {}) {
  return String(str).trim().toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
`
    const plain = `
// plain slugify: drops non-alphanumerics — matches the spec's "Rock & Roll" → "rock-roll"
export function slugify(input) {
  return String(input).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
`
    const cases: CodeCase[] = [
      { args: ['Hello World'], expected: 'hello-world' },
      { args: ['  Foo   Bar!  '], expected: 'foo-bar' },
      { args: ['Rock & Roll'], expected: 'rock-roll' },
    ]

    // Control: JOINING the two files collapses to the first-seen (broken) slugify → NOT solved.
    let fmA = 0
    const joined = makeRetrievalProposer({
      entry: 'slugify', goal: 'slugify string to url slug', wantArity: 1,
      webGround: async () => `${optionHeavy}\n\n${plain}`,   // one blob → first-wins dedup
    })
    const rJoined = await search(spec('slugify', cases),
      composeProposers(joined, async () => { fmA++; return { value: 'export function slugify(){ return "" }', fingerprint: `fmA${fmA}` } }),
      verifyCode, { maxModelCalls: 6 })
    check('7 CONTROL: joining files collapses same-named impls → broken one wins, not solved by retrieval',
      !(rJoined.status === 'solved' && fmA === 0), JSON.stringify({ s: rJoined.status, fmA }))

    // Fix: per-file blobs keep BOTH slugify defs → the plain one certifies, 0 FM calls.
    let fmB = 0
    const perFile = makeRetrievalProposer({
      entry: 'slugify', goal: 'slugify string to url slug', wantArity: 1,
      webGround: async () => [optionHeavy, plain],           // array → distinct candidates
    })
    const rPerFile = await search(spec('slugify', cases),
      composeProposers(perFile, async () => { fmB++; return { value: 'export function slugify(){ return "" }', fingerprint: `fmB${fmB}` } }),
      verifyCode, { maxModelCalls: 6 })
    check('7 per-file blobs certify the spec-matching alternate impl', rPerFile.status === 'solved', JSON.stringify({ s: rPerFile.status, d: rPerFile.detail }))
    check('7 the certified impl is the PLAIN slugify (not the &→and library one), 0 FM calls',
      fmB === 0 && !/ and /.test(rPerFile.solution?.value ?? ''), JSON.stringify({ fmB, v: (rPerFile.solution?.value ?? '').slice(0, 80) }))
  }

  console.log(`\n${pass}/${pass + fail} passed\n`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })

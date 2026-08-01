// ═══════════════════════════════════════════════════════════════════════════════
// SELF-CHECK for the general scorecard's task rows — NO MODEL, pure and offline.
// Run:  npx tsx src/CrucibleEngine/reasoning/__general_hardset_selfcheck.ts
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHY. A benchmark row can fail for two reasons and the scorecard prints them identically: the
// system could not solve the task, or the task is UNSOLVABLE because a gold case is wrong. The
// hard set (2026-08-01b) is four brand-new rows whose expected values were worked out by hand
// from prose — precisely the situation where a mis-transcribed expectation turns into "tier 3
// still can't do it" and gets written into the ROADMAP as a capability finding.
//
// So: a reference implementation per hard row, written to the goal text as literally as possible,
// asserted against every case. If a case here fails, the ROW is wrong, not the head. This is the
// same discipline as `__template_selfcheck.ts` (every template helper's seed cases are satisfied
// by a correct impl) applied to the acceptance sets the general path is scored on.
//
// It also re-asserts `hasDecomposeTemplate === false` for every row in BOTH sets, which is the
// scorecard's load-bearing precondition — the live harness checks it too, but only when you spend
// half an hour running it, and a row that quietly acquires a detector should fail in one second.

import { TASKS, HARD_TASKS, type GeneralProbe } from './__decompose_general_scorecard_live'
import { hasDecomposeTemplate } from './fmPlanner'

let passed = 0, failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) { passed++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ── reference implementations, one per hard row ─────────────────────────────────

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

function numberToWords(n: number): string {
  if (n === 0) return 'zero'
  const parts: string[] = []
  const thousands = Math.floor(n / 1000)
  if (thousands) parts.push(ONES[thousands], 'thousand')
  const hundreds = Math.floor((n % 1000) / 100)
  if (hundreds) parts.push(ONES[hundreds], 'hundred')
  const rest = n % 100
  if (rest) {
    if (rest < 20) parts.push(ONES[rest])
    else {
      parts.push(TENS[Math.floor(rest / 10)])
      if (rest % 10) parts.push(ONES[rest % 10])
    }
  }
  return parts.join(' ')
}

function formatDuration(seconds: number): string {
  if (seconds === 0) return 'now'
  const units: [number, string][] = [[86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']]
  let rest = seconds
  const parts: string[] = []
  for (const [size, name] of units) {
    const n = Math.floor(rest / size)
    rest -= n * size
    if (n) parts.push(`${n} ${name}${n === 1 ? '' : 's'}`)
  }
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

function wordWrap(text: string, width: number): string[] {
  const words = text.split(' ').filter(w => w.length > 0)
  if (!words.length) return []
  const lines: string[] = []
  let line = words[0]
  for (const w of words.slice(1)) {
    if (line.length + 1 + w.length <= width) line = `${line} ${w}`
    else { lines.push(line); line = w }
  }
  lines.push(line)
  return lines
}

function csvSelect(csv: string, index: number): string[] {
  return csv.split('\n').map((row) => {
    const fields: string[] = []
    let cur = '', inQuotes = false
    for (let i = 0; i < row.length; i++) {
      const c = row[i]
      if (inQuotes) {
        if (c === '"' && row[i + 1] === '"') { cur += '"'; i++ }
        else if (c === '"') inQuotes = false
        else cur += c
      } else if (c === '"') inQuotes = true
      else if (c === ',') { fields.push(cur); cur = '' }
      else cur += c
    }
    fields.push(cur)
    return fields[index] ?? ''
  })
}

const REFS: Record<string, (...args: any[]) => unknown> = {
  numberToWords, formatDuration, wordWrap, csvSelect,
}

// ── the checks ──────────────────────────────────────────────────────────────────

console.log('\n── HARD-SET gold cases are satisfied by a correct implementation ─────')
for (const p of HARD_TASKS) {
  const impl = REFS[p.entry]
  if (!impl) { check(`${p.entry} has a reference implementation`, false, 'none registered — add one or drop the row'); continue }
  for (const c of p.cases) {
    const got = impl(...(c.args as unknown[]))
    const ok = JSON.stringify(got) === JSON.stringify(c.expected)
    check(`${p.entry}(${c.args.map(a => JSON.stringify(a)).join(', ')})`, ok,
      ok ? JSON.stringify(c.expected) : `expected ${JSON.stringify(c.expected)}, reference gives ${JSON.stringify(got)}`)
  }
}

console.log('\n── every scorecard row still matches NO decompose template ───────────')
const all: [string, GeneralProbe[]][] = [['core', TASKS], ['hard', HARD_TASKS]]
for (const [set, rows] of all) {
  for (const p of rows) {
    check(`${set}: ${p.entry} is template-free`, !hasDecomposeTemplate(p.goal, p.entry),
      'a detector here would silently re-measure the template path')
  }
}

console.log('\n── the two sets are disjoint and non-empty ───────────────────────────')
const coreNames = new Set(TASKS.map(t => t.entry))
check('no entry appears in both sets', HARD_TASKS.every(t => !coreNames.has(t.entry)))
check('core set is non-empty', TASKS.length > 0, `${TASKS.length} rows`)
check('hard set is non-empty', HARD_TASKS.length > 0, `${HARD_TASKS.length} rows`)

console.log(`\n${failed === 0 ? '✅' : '❌'} general hard-set self-check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)

// Verified Tier-1B primitive: cron expression parser/validator.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible — cron expression parser/validator (5-field: min hr dom mon dow).
export interface CronParts {
  minute: string; hour: string; dayOfMonth: string; month: string; dayOfWeek: string
}

export function parseCron(expr: string): CronParts {
  const parts = expr.trim().split(/\\s+/)
  if (parts.length !== 5) throw new Error(\`Invalid cron: expected 5 fields, got \${parts.length}\`)
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts
  return { minute, hour, dayOfMonth, month, dayOfWeek }
}

function validField(val: string, min: number, max: number): boolean {
  if (val === '*') return true
  if (val.startsWith('*/')) {
    const step = parseInt(val.slice(2), 10)
    return !isNaN(step) && step > 0
  }
  for (const part of val.split(',')) {
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number)
      if (isNaN(lo) || isNaN(hi) || lo < min || hi > max || lo > hi) return false
    } else {
      const n = parseInt(part, 10)
      if (isNaN(n) || n < min || n > max) return false
    }
  }
  return true
}

export function isCronValid(expr: string): boolean {
  try {
    const p = parseCron(expr)
    return (
      validField(p.minute, 0, 59) &&
      validField(p.hour, 0, 23) &&
      validField(p.dayOfMonth, 1, 31) &&
      validField(p.month, 1, 12) &&
      validField(p.dayOfWeek, 0, 7)
    )
  } catch { return false }
}

export function describeCron(expr: string): string {
  const p = parseCron(expr)
  if (expr === '* * * * *') return 'every minute'
  if (p.minute !== '*' && p.hour !== '*' && p.dayOfMonth === '*' && p.month === '*' && p.dayOfWeek === '*')
    return \`at \${p.hour}:\${p.minute.padStart(2,'0')} every day\`
  if (p.minute === '0' && p.hour !== '*' && p.dayOfMonth === '*' && p.month === '*' && p.dayOfWeek === '*')
    return \`at \${p.hour}:00 every day\`
  return \`cron: \${expr}\`
}
`

const SUITE = `
import { parseCron, isCronValid, describeCron } from './src/module'
const ok = (b: boolean, msg: string) => { if (!b) { console.error('FAIL', msg); process.exit(1) } }
const p = parseCron('0 9 * * 1-5')
ok(p.minute === '0' && p.hour === '9' && p.dayOfWeek === '1-5', 'parse fields')
ok(isCronValid('* * * * *'), 'all stars valid')
ok(isCronValid('*/15 * * * *'), 'step valid')
ok(isCronValid('0 9 * * 1-5'), 'range valid')
ok(!isCronValid('60 * * * *'), 'minute 60 invalid')
ok(!isCronValid('* 25 * * *'), 'hour 25 invalid')
ok(!isCronValid('not a cron'), 'bad expr invalid')
ok(describeCron('* * * * *') === 'every minute', 'describe every minute')
let threw = false
try { parseCron('* *') } catch { threw = true }
ok(threw, 'throws on wrong field count')
console.log('ALL PASS')
`

registerSkill({
  id: 'cronExpr',
  summary: 'Cron expression parser/validator: parseCron, isCronValid, describeCron (5-field standard format).',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bcron.?expr\b|\bcron.?pars|\bparseCron\b/i)) sc += 0.85
    if (s.has(/\bcron\b.*\bvalidat|\bvalidat\b.*\bcron\b/i)) sc += 0.6
    if (s.has(/cron.*schedule|schedule.*cron/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/module.ts', content: IMPL }]
  },
  suite: SUITE,
})

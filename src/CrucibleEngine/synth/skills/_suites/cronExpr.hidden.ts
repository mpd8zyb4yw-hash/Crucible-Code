import { parseCron, isCronValid, describeCron } from '../src/module'
let f = 0
const ok = (b: boolean, msg: string) => { if (!b) { console.error('FAIL', msg); f++ } }
const p = parseCron('0 9 * * 1-5')
ok(p.minute === '0' && p.hour === '9' && p.dayOfWeek === '1-5', 'parse fields')
ok(p.dayOfMonth === '*' && p.month === '*', 'wildcards')
ok(isCronValid('* * * * *'), 'all stars')
ok(isCronValid('*/15 * * * *'), 'step expr')
ok(isCronValid('0,30 * * * *'), 'list expr')
ok(isCronValid('0 9 * * 1-5'), 'range expr')
ok(!isCronValid('60 * * * *'), 'minute 60 invalid')
ok(!isCronValid('* 25 * * *'), 'hour 25 invalid')
ok(!isCronValid('not a cron'), 'bad expr')
ok(!isCronValid('* * 32 * *'), 'dom 32 invalid')
ok(describeCron('* * * * *') === 'every minute', 'describe every minute')
let threw = false; try { parseCron('* *') } catch { threw = true }
ok(threw, 'throws on wrong count')
console.log(f === 0 ? 'ALL PASS' : `${f} FAILURE(S)`); process.exit(f === 0 ? 0 : 1)

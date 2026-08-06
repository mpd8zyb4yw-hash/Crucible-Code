import { scopeTsErrors } from './oracle'
const SCOPE = ['src/validate.ts','src/store.ts','src/report.ts','test.ts']
const cases: Array<[string,string,string[],'fatal'|'deferred']> = [
  ['(a) rename-field: error in unedited consumer',
   "/tmp/scr/src/report.ts(3,33): error TS2339: Property 'qty' does not exist on type 'Item'.", SCOPE, 'deferred'],
  ['FATAL: error in the file being written right now',
   "/tmp/scr/src/types.ts(2,3): error TS1005: ';' expected.", SCOPE, 'fatal'],
  ['(b) correct sibling import of a not-yet-created change-set file',
   "/tmp/scr/src/checkout.ts(1,31): error TS2307: Cannot find module './discount'.", ['src/discount.ts'], 'deferred'],
  ['FATAL: WRONG path to a change-set file must reach the FM (live false-defer, 2026-07-19)',
   "/tmp/scr/src/checkout.ts(1,31): error TS2307: Cannot find module './src/discount'.", ['src/discount.ts'], 'fatal'],
  ['FATAL: missing module NOT in the change set',
   "/tmp/scr/src/checkout.ts(1,31): error TS2307: Cannot find module 'lodash-es'.", ['src/discount.ts'], 'fatal'],
  ['FATAL: no scope declared at all (legacy behaviour preserved)',
   "/tmp/scr/src/report.ts(3,33): error TS2339: Property 'qty' does not exist on type 'Item'.", [], 'fatal'],
  ['FATAL: written change-set file (caller excludes it) still fatal',
   "/tmp/scr/src/store.ts(9,40): error TS2339: Property 'qty' does not exist.", ['src/report.ts'], 'fatal'],
]
let pass = 0
for (const [name, line, scope, want] of cases) {
  const r = scopeTsErrors(line, scope, '/tmp/scr')
  const got = r.fatal.length ? 'fatal' : 'deferred'
  const ok = got === want
  if (ok) pass++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  → ${got} (want ${want})`)
}
console.log(`${pass}/${cases.length}`)
process.exit(pass === cases.length ? 0 : 1)

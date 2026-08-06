// HIDDEN adversarial suite — formatBytes utility.
// Run via `npx tsx __audit__/formatBytes.hidden.ts` inside the scratch project.
import { formatBytes } from '../src/formatBytes'

let failures = 0
function check(name: string, got: unknown, want: unknown) {
  const ok = got === want
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${name}`)
  if (!ok) { console.log(`       got:  ${JSON.stringify(got)}`); console.log(`       want: ${JSON.stringify(want)}`); failures++ }
}

check('zero',              formatBytes(0),              '0 B')
check('1 byte',            formatBytes(1),              '1 B')
check('500 bytes',         formatBytes(500),            '500 B')
check('1 KB exact',        formatBytes(1024),           '1 KB')
check('1.5 KB',            formatBytes(1536),           '1.5 KB')
check('1 MB exact',        formatBytes(1024 ** 2),      '1 MB')
check('1 GB exact',        formatBytes(1024 ** 3),      '1 GB')
check('1 TB exact',        formatBytes(1024 ** 4),      '1 TB')
check('1023 bytes',        formatBytes(1023),           '1023 B')
check('1025 bytes',        formatBytes(1025),           '1 KB')
check('decimals=0 1.5KB',  formatBytes(1536, 0),        '2 KB')
check('decimals=3 1KB',    formatBytes(1024, 3),        '1 KB')
check('2.5 MB',            formatBytes(2.5 * 1024**2),  '2.5 MB')

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

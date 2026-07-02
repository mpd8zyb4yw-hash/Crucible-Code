// HIDDEN adversarial suite — base64 encode/decode.
// Run via `npx tsx __audit__/base64.hidden.ts` inside the scratch project.
import { base64Encode, base64Decode } from '../src/base64'

let failures = 0
function check(name: string, got: unknown, want: unknown) {
  const ok = got === want
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${name}`)
  if (!ok) { console.log(`       got:  ${JSON.stringify(got)}`); console.log(`       want: ${JSON.stringify(want)}`); failures++ }
}

check('encode hello',           base64Encode('hello'),          'aGVsbG8=')
check('encode empty',           base64Encode(''),               '')
check('encode Man (RFC 4648)',  base64Encode('Man'),            'TWFu')
check('encode ascii 0-9',       base64Encode('0123456789'),     'MDEyMzQ1Njc4OQ==')
check('encode with spaces',     base64Encode('hello world'),    'aGVsbG8gd29ybGQ=')
check('decode hello',           base64Decode('aGVsbG8='),       'hello')
check('decode empty',           base64Decode(''),               '')
check('decode Man',             base64Decode('TWFu'),           'Man')
check('decode with padding ==', base64Decode('MDEyMzQ1Njc4OQ=='), '0123456789')
check('roundtrip ascii',        base64Decode(base64Encode('The quick brown fox')), 'The quick brown fox')
check('roundtrip special',      base64Decode(base64Encode('abc\ndef\t!')),         'abc\ndef\t!')
check('roundtrip unicode repr', base64Decode(base64Encode('café')),           'café')

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

// HIDDEN adversarial suite — slug generator.
// Run via `npx tsx __audit__/slug.hidden.ts` inside the scratch project.
import { slug } from '../src/slug'

let failures = 0
function check(name: string, got: unknown, want: unknown) {
  const ok = got === want
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${name}`)
  if (!ok) { console.log(`       got:  ${JSON.stringify(got)}`); console.log(`       want: ${JSON.stringify(want)}`); failures++ }
}

check('basic two words',          slug('Hello World'),          'hello-world')
check('leading/trailing spaces',  slug('  foo  BAR  '),         'foo-bar')
check('special chars stripped',   slug('Hello, World!'),        'hello-world')
check('multiple spaces collapse', slug('a   b   c'),            'a-b-c')
check('already lowercase',        slug('hello-world'),          'hello-world')
check('numbers preserved',        slug('Step 1: Do It'),        'step-1-do-it')
check('unicode stripped',         slug('Café au lait'),         'caf-au-lait')
check('leading hyphen removed',   slug('--hello'),              'hello')
check('trailing hyphen removed',  slug('hello--'),              'hello')
check('consecutive hyphens',      slug('hello---world'),        'hello-world')
check('empty string',             slug(''),                     '')
check('only spaces',              slug('   '),                  '')
check('only special chars',       slug('!@#$%'),                '')
check('mixed case + punctuation', slug("It's a test!"),         'its-a-test')
check('tab character',            slug('hello\tworld'),         'hello-world')

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

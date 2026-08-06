// HIDDEN adversarial suite — HTML entity escape/unescape.
// Run via `npx tsx __audit__/escapeHtml.hidden.ts` inside the scratch project.
import { escapeHtml, unescapeHtml } from '../src/escapeHtml'

let failures = 0
function check(name: string, got: unknown, want: unknown) {
  const ok = got === want
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${name}`)
  if (!ok) { console.log(`       got:  ${JSON.stringify(got)}`); console.log(`       want: ${JSON.stringify(want)}`); failures++ }
}

// escapeHtml
check('escape ampersand',         escapeHtml('a & b'),           'a &amp; b')
check('escape less-than',         escapeHtml('<b>'),             '&lt;b&gt;')
check('escape greater-than',      escapeHtml('a > b'),           'a &gt; b')
check('escape double-quote',      escapeHtml('"hi"'),            '&quot;hi&quot;')
check('escape single-quote',      escapeHtml("it's"),            'it&#39;s')
check('all five chars',           escapeHtml('<a href="x">it\'s</a>'), '&lt;a href=&quot;x&quot;&gt;it&#39;s&lt;/a&gt;')
check('no special chars',         escapeHtml('hello world'),     'hello world')
check('empty string',             escapeHtml(''),                '')
check('multiple ampersands',      escapeHtml('a & b & c'),       'a &amp; b &amp; c')
check('script tag',               escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;')

// unescapeHtml
check('unescape amp',             unescapeHtml('a &amp; b'),     'a & b')
check('unescape lt gt',           unescapeHtml('&lt;b&gt;'),     '<b>')
check('unescape quot',            unescapeHtml('&quot;hi&quot;'),'\"hi\"')
check('unescape apos',            unescapeHtml('it&#39;s'),      "it's")
check('roundtrip',                unescapeHtml(escapeHtml('<b>hello & "world"</b>')), '<b>hello & "world"</b>')
check('no entities',              unescapeHtml('plain text'),    'plain text')

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

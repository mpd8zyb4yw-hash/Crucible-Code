// HIDDEN adversarial audit suite — mini regex engine (full-match semantics).
// Run via `npx tsx __audit__/regex.hidden.ts` inside the scratch project.
// Supported: literals, '.', '*', '+', '?', char classes [abc] / [a-z], and '\' escaping.
// regexMatch returns true iff the ENTIRE text is matched by the pattern.
import { regexMatch } from '../src/regex'

let failures = 0
function check(name: string, cond: boolean) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} — ${name}`)
  if (!cond) failures++
}

// literals (full match)
check('literal exact match', regexMatch('abc', 'abc') === true)
check('literal rejects a trailing char (full match)', regexMatch('abc', 'abcd') === false)
check('literal rejects a missing char', regexMatch('abc', 'ab') === false)
// '.'
check('. matches any single char', regexMatch('a.c', 'axc') === true)
check('. requires exactly one char', regexMatch('a.c', 'ac') === false)
// '*'
check('b* matches zero occurrences', regexMatch('ab*c', 'ac') === true)
check('b* matches many occurrences', regexMatch('ab*c', 'abbbbc') === true)
check('.* matches an arbitrary run', regexMatch('.*', 'anything at all') === true)
check('a.*z spans the whole string', regexMatch('a.*z', 'a-middle-z') === true)
// '+'
check('b+ requires at least one (rejects zero)', regexMatch('ab+c', 'ac') === false)
check('b+ matches one or more', regexMatch('ab+c', 'abbc') === true)
// '?'
check('b? matches zero', regexMatch('ab?c', 'ac') === true)
check('b? matches one', regexMatch('ab?c', 'abc') === true)
check('b? rejects two', regexMatch('ab?c', 'abbc') === false)
// character classes
check('[abc]+ matches a run of class members', regexMatch('[abc]+', 'cabba') === true)
check('[abc]+ rejects a non-member', regexMatch('[abc]+', 'cabd') === false)
check('[a-z]+ matches a lowercase range', regexMatch('[a-z]+', 'hello') === true)
check('[a-z]+ rejects an out-of-range char', regexMatch('[a-z]+', 'helloX') === false)
// escaping
check('\\. matches a literal dot', regexMatch('a\\.c', 'a.c') === true)
check('\\. rejects a non-dot', regexMatch('a\\.c', 'axc') === false)
check('\\* matches a literal star', regexMatch('a\\*', 'a*') === true)

console.log(`\n  ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)

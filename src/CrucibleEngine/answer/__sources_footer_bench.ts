// Pure, offline bench for the sources footer gate. No model calls, no network.
// Run: npx tsx src/CrucibleEngine/answer/__sources_footer_bench.ts
//
// Guards the spurious-sources regression: a purely computed / parametric answer that CITES
// none of the retrieved evidence must ship with NO "Sources:" footer. The web bundle is just
// whatever generic pages the query surfaced; stapling unrelated Wikipedia links onto an answer
// that never used them is the exact bug this gate closes.
import { withSourcesFooter } from './groundedAnswer'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

const ev = {
  block: '',
  sources: [
    'https://en.wikipedia.org/wiki/GitHub',
    'https://en.wikipedia.org/wiki/Artificial_intelligence_industry_in_the_United_Kingdom',
    'https://en.wikipedia.org/wiki/Data_center',
  ],
  titles: ['GitHub', 'Artificial intelligence industry in the United Kingdom', 'Data center'],
}

console.log('== computed answer that cites nothing gets NO footer ==')
{
  const answer = 'The total of 17 times 4 is 68.'
  const out = withSourcesFooter(answer, ev)
  check('no Sources: block appended', !/Sources:/.test(out), out)
  check('no [S#] links appended', !/\[S\d+\]/.test(out), out)
  check('answer text returned unchanged', out === answer, out)
}

console.log('\n== grounded answer that cites [S1]/[S2] shows only cited sources ==')
{
  const answer = 'GitHub is a code host [S1]. The UK has a notable AI industry [S2].'
  const out = withSourcesFooter(answer, ev)
  check('footer present', /---\nSources:/.test(out))
  check('S1 listed', out.includes('[S1] GitHub — https://en.wikipedia.org/wiki/GitHub'))
  check('S2 listed', out.includes('[S2] Artificial intelligence industry in the United Kingdom'))
  check('uncited S3 NOT listed', !out.includes('[S3]'), out)
}

console.log(`\n${pass}/${pass + fail} passed`)
if (fail > 0) process.exit(1)

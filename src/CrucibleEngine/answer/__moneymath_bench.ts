// Hermetic bench for everyday money math.
import { solveMoneyMath } from './moneyMath'

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

const HITS: Array<[string, RegExp]> = [
  ['What is 15% of 240?', /\*\*36\*\*/],
  ["What's a 20% tip on $84?", /\*\*\$16\.80\*\*.*total of \$100\.80/],
  ['Split $137.50 three ways.', /\*\*\$45\.83\*\*.*does not divide evenly.*1 person pays one cent more \(\$45\.84\)/],
  ['Split $60 between 4 people.', /\*\*\$15\.00\*\*/],
  ['How much is 8% sales tax on $42?', /\*\*\$3\.36\*\*.*total of \$45\.36/],
  ['What is $85 with 20% off?', /saves \$17\.00.*\*\*\$68\.00\*\*/],
  ['20% off 85', /\*\*\$68\.00\*\*/],
  ['What is 15 percent of 240?', /\*\*36\*\*/],
  ['What is 7.5% of $1,200?', /\*\*\$90\.00\*\*/],
  ['Split £100 three ways', /£33\.33.*1 person pays one cent more \(£33\.34\)/],
]
for (const [q, want] of HITS) {
  const got = solveMoneyMath(q)
  check(`solves: ${q}`, !!got && want.test(got.text), got ? got.text : 'null')
}

// The remainder must actually reconcile — this is the whole reason the split case exists.
const s = solveMoneyMath('Split $137.50 three ways.')!
check('split remainder reconciles to the original total', /45\.83/.test(s.text) && /45\.84/.test(s.text))

const MISSES: Array<[string, string]> = [
  ['What is 17 times 23?', 'bare arithmetic — directArithmetic owns this'],
  ['What is the capital of Australia?', 'not numeric'],
  ['Convert 100 km to miles.', 'conversion lane'],
  ['Split the difference between the two designs.', 'no numbers'],
  ['I have 3 meetings, when am I free?', 'schedule lane'],
  ['What percent of users churned?', 'no numbers to compute over'],
  ['Write a function that splits a list 3 ways.', 'code, not money'],
]
for (const [q, why] of MISSES) {
  const got = solveMoneyMath(q)
  check(`refuses (${why}): ${q}`, got === null, got ? got.text : '')
}

console.log(`\nMONEY MATH BENCH: ${pass}/${pass + fail}`)
if (fail) process.exit(1)

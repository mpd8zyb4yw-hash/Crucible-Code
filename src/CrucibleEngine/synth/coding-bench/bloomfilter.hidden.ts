import { synthesize } from '../synthEngine'
import '../skills/bloomFilter'
import { writeFileSync, mkdirSync } from 'fs'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error('FAIL — ' + msg)
  console.log('  PASS — ' + msg)
}

const spec = 'Build a bloom filter for probabilistic set membership with a tunable false positive rate. export class BloomFilter'
const result = synthesize(spec)
assert(result !== null, 'synthesize() matches the bloom-filter skill for this spec')

mkdirSync('/tmp/crucible-synth-test', { recursive: true })
const outPath = '/tmp/crucible-synth-test/bloomFilterGen.ts'
writeFileSync(outPath, result!.files[0].content)

const { BloomFilter } = await import(outPath)

const bf = new BloomFilter(1000, 0.01)
bf.add('apple')
bf.add('banana')
bf.add('cherry')

assert(bf.mightContain('apple') === true, 'an added item is always reported as present')
assert(bf.mightContain('banana') === true, 'a second added item is always reported as present')

let falseNegative = false
for (let i = 0; i < 1000; i++) bf.add('item-' + i)
for (let i = 0; i < 1000; i++) {
  if (!bf.mightContain('item-' + i)) { falseNegative = true; break }
}
assert(falseNegative === false, 'zero false negatives across 1000 added items (the core guarantee)')

console.log('ALL PASS')

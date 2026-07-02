import { synthesize } from '../synthEngine'
import '../skills/trie'
import { writeFileSync, mkdirSync } from 'fs'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error('FAIL — ' + msg)
  console.log('  PASS — ' + msg)
}

const spec = 'Build a trie prefix tree with insert, search, startsWith, delete, and wordsWithPrefix. export class Trie'
const result = synthesize(spec)
assert(result !== null, 'synthesize() matches the trie skill for this spec')

mkdirSync('/tmp/crucible-synth-test', { recursive: true })
const outPath = '/tmp/crucible-synth-test/trieGen.ts'
writeFileSync(outPath, result!.files[0].content)

const { Trie } = await import(outPath)

const t = new Trie()
t.insert('cat')
t.insert('car')
t.insert('card')
t.insert('care')
t.insert('dog')

assert(t.search('cat') === true, 'exact word inserted is found')
assert(t.search('ca') === false, 'a prefix never inserted as a full word is not a match')
assert(t.startsWith('ca') === true, 'startsWith finds a branch even when the prefix itself is not a word')
assert(t.startsWith('xyz') === false, 'startsWith correctly rejects a branch that does not exist')

const prefixed = t.wordsWithPrefix('car').sort()
assert(JSON.stringify(prefixed) === JSON.stringify(['car', 'card', 'care']),
  'wordsWithPrefix returns exactly the matching words, sorted: ' + JSON.stringify(prefixed))

t.delete('card')
assert(t.search('card') === false, 'deleted word is no longer found')
assert(t.search('car') === true, 'sibling word survives deletion of a word sharing its prefix')

console.log('ALL PASS')

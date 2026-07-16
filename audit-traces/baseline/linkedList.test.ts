import assert from 'assert'
import { reverseLinkedList, fromArray, toArray } from './linkedList'

assert.deepStrictEqual(toArray(reverseLinkedList(fromArray([1, 2, 3, 4]))), [4, 3, 2, 1])
console.log('  ok even-length list')
assert.deepStrictEqual(toArray(reverseLinkedList(fromArray([1, 2, 3]))), [3, 2, 1])
console.log('  ok odd-length list')
assert.deepStrictEqual(toArray(reverseLinkedList(fromArray([]))), [])
console.log('  ok empty list')
assert.deepStrictEqual(toArray(reverseLinkedList(fromArray([1]))), [1])
console.log('  ok single node')
assert.deepStrictEqual(toArray(reverseLinkedList(fromArray(['a', 'b']))), ['b', 'a'])
console.log('  ok generic over string')
const l = fromArray([1, 2, 3])
reverseLinkedList(l)
assert.strictEqual(l!.next, null, 'old head must become the tail (in-place)')
console.log('  ok reverses in place')
console.log('all passed')

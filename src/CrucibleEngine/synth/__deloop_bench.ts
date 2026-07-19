// Two-direction bench for stripDegenerateRepetition (cont.100).
// VERIFIERS FAIL IN TWO DIRECTIONS: a de-looper that eats correct code is worse than no
// de-looper, so every clean candidate below MUST pass through byte-identical.
import { stripDegenerateRepetition as cut } from './universal'

const CLEAN_SINGLE = `import { Item } from './types';
export function renderItem(item: Item): string {
  return item.sku + ' x' + item.quantity;
}
export class Store {
  items: Item[] = [];
}`

// The real cont.100 shape: whole file re-emitted, 3rd copy clipped mid-token by max_tokens.
const LOOPED = `import { Item } from './types';
export function renderItem(item: Item): string {
  return item.sku + ' x' + item.quantity;
}
export interface Item { sku: string; quantity: number; }

export function renderItem(item: Item): string {
  return item.sku + ' x' + item.quantity;
}
export interface Item { sku: string; quantity: nu`

const CASES: Array<{ name: string; input: string; expect: 'unchanged' | string }> = [
  { name: 'clean single copy survives', input: CLEAN_SINGLE, expect: 'unchanged' },
  { name: 'no top-level decl (bare expr) survives', input: 'const x = 1 + 2', expect: 'unchanged' },
  { name: 'empty survives', input: '', expect: 'unchanged' },
  // Overloads legitimately repeat a *signature* but not an identical full decl line.
  {
    name: 'distinct decls with same keyword survive',
    input: 'export function a(): void {}\nexport function b(): void {}',
    expect: 'unchanged',
  },
  {
    name: 'looped file cut at first restart',
    input: LOOPED,
    expect: `import { Item } from './types';
export function renderItem(item: Item): string {
  return item.sku + ' x' + item.quantity;
}
export interface Item { sku: string; quantity: number; }`,
  },
]

let pass = 0
for (const c of CASES) {
  const got = cut(c.input)
  const want = c.expect === 'unchanged' ? c.input : c.expect
  const ok = got === want
  if (ok) pass++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}`)
  if (!ok) console.log(`  want: ${JSON.stringify(want)}\n  got:  ${JSON.stringify(got)}`)
}
console.log(`\n${pass}/${CASES.length}`)
process.exit(pass === CASES.length ? 0 : 1)

// Bench for Gate A3 (cross-file duplicate exported symbol). Both directions, per the standing
// rule that a verifier fails in two directions: the KNOWN-CORRECT artifact must certify, and
// the known-dirty one must be rejected. The dirty case is the verbatim shape from the first
// tier-2 pass (cont.101, run 33753 rename-field-across-layers).
import fs from 'fs'
import os from 'os'
import path from 'path'
import { checkDuplicateExports } from './dupSymbolGate'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dupgate-bench-'))
const ctx = (rel: string, content: string) => {
  const src = path.join(tmp, rel.replace(/\//g, '_'))
  fs.writeFileSync(src, content)
  return { src, rel }
}

const VALIDATE = `import { Item } from './types';
export function isValidItem(item: Item): boolean { return item.quantity > 0; }`
const STORE = `import { Item } from './types';
export class Store { items: Item[] = []; }`
const TYPES_CLEAN = `export interface Item { sku: string; quantity: number; }`
// The live bug: types.ts re-declares what validate.ts and store.ts own.
const TYPES_DIRTY = `export interface Item { sku: string; quantity: number; }
export function isValidItem(item: Item): boolean { return item.quantity > 0; }
export class Store { items: Item[] = []; }`

const CASES: Array<{ name: string; files: any[]; ctx: any[]; expectOk: boolean; expectName?: string }> = [
  {
    name: 'known-correct refactor certifies (each symbol owned by one module)',
    files: [{ path: 'src/types.ts', content: TYPES_CLEAN }],
    ctx: [ctx('src/validate.ts', VALIDATE), ctx('src/store.ts', STORE)],
    expectOk: true,
  },
  {
    name: 'live cont.101 bug rejected — types.ts re-declares isValidItem',
    files: [{ path: 'src/types.ts', content: TYPES_DIRTY }],
    ctx: [ctx('src/validate.ts', VALIDATE), ctx('src/store.ts', STORE)],
    expectOk: false, expectName: 'isValidItem',
  },
  {
    name: 'in-place edit of an existing file is NOT a duplicate of itself',
    files: [{ path: 'src/validate.ts', content: VALIDATE }],
    ctx: [ctx('src/validate.ts', VALIDATE), ctx('src/store.ts', STORE)],
    expectOk: true,
  },
  {
    name: 'pre-existing duplication in untouched context does not block the candidate',
    files: [{ path: 'src/types.ts', content: TYPES_CLEAN }],
    ctx: [ctx('src/a.ts', 'export function dup(): void {}'), ctx('src/b.ts', 'export function dup(): void {}')],
    expectOk: true,
  },
  {
    name: 'same-named PRIVATE helper in two modules is ordinary code, not a duplicate',
    files: [{ path: 'src/types.ts', content: `${TYPES_CLEAN}\nfunction helper(): void {}` }],
    ctx: [ctx('src/store.ts', `${STORE}\nfunction helper(): void {}`)],
    expectOk: true,
  },
  {
    name: 'two candidate files duplicating each other are caught (no context needed)',
    files: [
      { path: 'src/a.ts', content: 'export function shared(): void {}' },
      { path: 'src/b.ts', content: 'export function shared(): void {}' },
    ],
    ctx: [],
    expectOk: false, expectName: 'shared',
  },
  {
    name: 'non-TS context is ignored',
    files: [{ path: 'src/types.ts', content: TYPES_CLEAN }],
    ctx: [ctx('src/notes.md', 'export function Item(): void {}')],
    expectOk: true,
  },
]

let pass = 0
for (const c of CASES) {
  const v = checkDuplicateExports(c.files, c.ctx)
  const ok = v.ok === c.expectOk && (c.expectName ? v.detail.includes(c.expectName) : true)
  if (ok) pass++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}`)
  if (!ok) console.log(`  want ok=${c.expectOk}${c.expectName ? ` naming '${c.expectName}'` : ''}, got ok=${v.ok} detail=${JSON.stringify(v.detail)}`)
}
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass}/${CASES.length}`)
process.exit(pass === CASES.length ? 0 : 1)

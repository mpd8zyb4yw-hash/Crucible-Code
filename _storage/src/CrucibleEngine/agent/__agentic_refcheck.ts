// ═══════════════════════════════════════════════════════════════════════════════
// Corpus reference check — the OTHER direction (cont.98).
// ═══════════════════════════════════════════════════════════════════════════════
//
// __agentic_live.ts's sanity pass proves each hidden spec FAILS on the untouched repo (it is
// not vacuous). That is one direction. This proves the other: fed a KNOWN-CORRECT solution,
// each spec CERTIFIES, and the visible suite is green. A spec nothing can pass is exactly as
// broken as one everything passes — it just fails silently, as a capability the model has and
// the harness scores WRONG (cont.85).
//
// Not theoretical. On its first run this caught 3 of the 4 tier-2 tasks:
//   · thread-tax-rate  — two hand-computed expectations were simply wrong (800 vs 1300 for the
//     zero-rate case, 1465 vs 1464 for the per-line rounding probe). Unpassable as authored.
//   · rename-field-across-layers, sync-store-to-async — a correct refactor NECESSARILY breaks a
//     suite that encodes the old name / the sync call, so `test.ts` had to join the coupled set.
//     Reconciling the tests is part of the refactor, not an accident of it.
//
// Run this whenever a task is added or a hidden spec is edited.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import { TASKS } from './__agentic_corpus'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const ROOT = path.join(os.tmpdir(), 'refcheck-' + process.pid)

const SOLUTIONS: Record<string, Record<string, string>> = {
  'thread-tax-rate': {
    'src/tax.ts': `export function applyTax(cents: number, rate: number = 0.08): number {
  return Math.round(cents * (1 + rate));
}
`,
    'src/lineItem.ts': `import { applyTax } from './tax';
export interface Line { qty: number; unitCents: number }
export function lineTotal(line: Line, rate?: number): number {
  return applyTax(line.qty * line.unitCents, rate);
}
`,
    'src/order.ts': `import { lineTotal, Line } from './lineItem';
export function orderTotal(lines: Line[], rate?: number): number {
  return lines.reduce((sum, l) => sum + lineTotal(l, rate), 0);
}
`,
    'src/invoice.ts': `import { orderTotal } from './order';
import { Line } from './lineItem';
export function invoice(customer: string, lines: Line[], rate?: number): { customer: string; totalCents: number } {
  return { customer, totalCents: orderTotal(lines, rate) };
}
`,
  },
  'rename-field-across-layers': {
    'src/types.ts': `export interface Item {
  sku: string;
  quantity: number;
}
`,
    'src/validate.ts': `import { Item } from './types';
export function isValidItem(item: Item): boolean {
  return typeof item.sku === 'string' && item.sku.length > 0
    && typeof item.quantity === 'number' && item.quantity > 0;
}
`,
    'src/store.ts': `import { Item } from './types';
import { isValidItem } from './validate';
export class Store {
  items: Item[] = [];
  add(item: Item): boolean {
    if (!isValidItem(item)) return false;
    this.items.push(item);
    return true;
  }
  totalUnits(): number {
    return this.items.reduce((sum, i) => sum + i.quantity, 0);
  }
}
`,
    'src/report.ts': `import { Item } from './types';
export function renderItem(item: Item): string {
  return item.sku + ' x' + item.quantity;
}
`,
    'test.ts': `import assert from 'assert';
import { isValidItem } from './src/validate';
import { Store } from './src/store';
import { renderItem } from './src/report';
assert.strictEqual(isValidItem({ sku: 'a', quantity: 2 }), true);
console.log('  ok validates an item');
const s = new Store();
s.add({ sku: 'a', quantity: 2 });
s.add({ sku: 'b', quantity: 3 });
assert.strictEqual(s.totalUnits(), 5);
console.log('  ok totals units');
assert.strictEqual(renderItem({ sku: 'a', quantity: 2 }), 'a x2');
console.log('  ok renders an item');
console.log('all passed');
`,
  },
  'sync-store-to-async': {
    'src/db.ts': `const ROWS: Record<string, { name: string }> = {
  u1: { name: 'Ada' },
  u2: { name: 'Grace' },
};
export async function get(id: string): Promise<{ name: string } | undefined> {
  return ROWS[id];
}
`,
    'src/userRepo.ts': `import { get } from './db';
export async function findUser(id: string): Promise<{ name: string } | undefined> {
  return await get(id);
}
`,
    'src/userService.ts': `import { findUser } from './userRepo';
export async function greet(id: string): Promise<string | null> {
  const u = await findUser(id);
  if (!u) return null;
  return 'Hello ' + u.name;
}
`,
    'src/api.ts': `import { greet } from './userService';
export async function handle(id: string): Promise<{ ok: boolean; body: string }> {
  const g = await greet(id);
  if (!g) return { ok: false, body: 'not found' };
  return { ok: true, body: g };
}
`,
    'test.ts': `import assert from 'assert';
import { handle } from './src/api';
(async () => {
  const a = await handle('u1');
  assert.deepStrictEqual(a, { ok: true, body: 'Hello Ada' });
  console.log('  ok handles a known user');
  const b = await handle('nope');
  assert.deepStrictEqual(b, { ok: false, body: 'not found' });
  console.log('  ok handles a missing user');
  console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
`,
  },
  'extract-duplicated-discount': {
    'src/discount.ts': `export function applyDiscount(cents: number, member: boolean): number {
  let out = cents;
  if (cents >= 10000) out = Math.round(out * 0.9);
  if (member) out = Math.round(out * 0.95);
  return out;
}
`,
    'src/checkout.ts': `import { applyDiscount } from './discount';
export function checkoutTotal(cents: number, member: boolean): number {
  return applyDiscount(cents, member);
}
`,
    'src/quote.ts': `import { applyDiscount } from './discount';
export function quoteTotal(cents: number, member: boolean): number {
  return applyDiscount(cents, member);
}
`,
    'src/preview.ts': `import { applyDiscount } from './discount';
export function previewTotal(cents: number, member: boolean): number {
  return applyDiscount(cents, member);
}
`,
  },
}

let bad = 0
for (const [id, sol] of Object.entries(SOLUTIONS)) {
  const task = TASKS.find(t => t.id === id)!
  const dir = path.join(ROOT, id)
  fs.mkdirSync(dir, { recursive: true })
  for (const [rel, body] of Object.entries(task.files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }
  try { fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir') } catch {}
  // apply the known-correct solution
  for (const [rel, body] of Object.entries(sol)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body)
  }

  const sh = (cmd: string) => {
    try { return { ok: true, out: execSync(cmd, { cwd: dir, encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 60000 }) } }
    catch (e: any) { return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` || String(e.message) } }
  }

  // the VISIBLE suite must still be green under the correct solution
  const suite = sh('npm test --silent')
  // the HIDDEN spec must now certify
  const hp = path.join(dir, '__hidden_spec.ts')
  fs.writeFileSync(hp, task.hidden)
  const h = sh(`${JSON.stringify(path.join(REPO, 'node_modules/.bin/tsx'))} ${JSON.stringify(hp)}`)
  const hidPass = h.ok && /HIDDEN OK/.test(h.out)

  const ok = suite.ok && hidPass
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'BAD '} ${id.padEnd(28)} suite=${suite.ok ? 'green' : 'RED'} hidden=${hidPass ? 'CERTIFIES' : 'FALSE-REJECT'}`)
  if (!ok) console.log('      ' + (suite.ok ? h.out : suite.out).trim().split('\n').slice(0, 6).join('\n      '))
}
console.log(bad ? `\n${bad} task(s) have an unpassable or suite-breaking spec.` : '\nAll new specs certify a known-correct solution.')
process.exit(bad ? 1 : 0)

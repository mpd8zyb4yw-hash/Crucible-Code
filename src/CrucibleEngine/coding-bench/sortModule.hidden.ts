// Hidden adversarial suite for sortModule (Phase C guard, generation-stressing task #2).
// Tests the agent NEVER saw. Imported as: npx tsx this-file from __audit__ dir.
// The produced code lives at ../src/sort.ts; scaffold at ../src/types.ts and ../src/catalog.ts.

import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'src')

let passed = 0; let failed = 0
function check(desc: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${desc}`)
  if (!ok) console.log(`         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`)
  ok ? passed++ : failed++
}

// Wrapped in an async IIFE, driven with .catch() (NOT top-level await) — see filterModule.hidden.ts
// for why: the frozen snapshot dir has no package.json up its directory tree, so esbuild/tsx
// defaults to CJS there, which doesn't support top-level await.
;(async () => {
  const { sortProducts } = await import(path.join(SRC, 'sort.js')).catch(
    () => import(path.join(SRC, 'sort.ts') as string),
  ) as { sortProducts: (products: any[], opts: any) => any[] }

  const { getAllProducts } = await import(path.join(SRC, 'catalog.js')).catch(
    () => import(path.join(SRC, 'catalog.ts') as string),
  ) as { getAllProducts: () => any[] }

  const products = getAllProducts()
  // id 1 Widget      tools   19.99 inStock
  // id 2 Gadget      tools   9.99  outOfStock
  // id 3 Sprocket    tools   19.99 outOfStock
  // id 4 Doohickey   novelty 4.99  inStock
  // id 5 Contraption novelty 29.99 inStock
  const ids = (arr: any[]) => arr.map(p => p.id)

  check('price asc, no grouping', ids(sortProducts(products, { by: 'price' })), [4, 2, 1, 3, 5])
  check('price asc — explicit direction', ids(sortProducts(products, { by: 'price', direction: 'asc' })), [4, 2, 1, 3, 5])
  check('price desc', ids(sortProducts(products, { by: 'price', direction: 'desc' })), [5, 1, 3, 2, 4])
  check('price tie (1 vs 3, both 19.99) breaks by id ascending even under desc', ids(sortProducts(products, { by: 'price', direction: 'desc' })).indexOf(1) < ids(sortProducts(products, { by: 'price', direction: 'desc' })).indexOf(3), true)

  check('name asc', ids(sortProducts(products, { by: 'name' })), [5, 4, 2, 3, 1])
  check('name desc', ids(sortProducts(products, { by: 'name', direction: 'desc' })), [1, 3, 2, 4, 5])

  check('inStockFirst + price asc', ids(sortProducts(products, { by: 'price', inStockFirst: true })), [4, 1, 5, 2, 3])
  check('inStockFirst + name asc', ids(sortProducts(products, { by: 'name', inStockFirst: true })), [5, 4, 1, 2, 3])
  check('inStockFirst=false behaves like omitted', ids(sortProducts(products, { by: 'price', inStockFirst: false })), [4, 2, 1, 3, 5])

  check('result length always 5', sortProducts(products, { by: 'price' }).length, 5)
  check('single-element list', ids(sortProducts([products[0]], { by: 'price' })), [1])
  check('empty list', sortProducts([], { by: 'price' }), [])

  const snapshot = JSON.parse(JSON.stringify(products))
  sortProducts(products, { by: 'price', direction: 'desc', inStockFirst: true })
  check('no input mutation', products, snapshot)

  console.log(`\n${passed + failed} checks — ${failed === 0 ? 'ALL PASS' : `${failed} FAILURE(s)`}`)
  if (failed > 0) process.exitCode = 1
})().catch((e) => { console.error(e); process.exitCode = 1 })

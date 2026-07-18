// Pure, offline bench for verifyCodeBlocks — the answer-path fenced-code syntax gate.
// Run: npx tsx src/CrucibleEngine/__codeblock_bench.ts   (npm run vgr:codeblock)
//
// Guards the cont.90 blocker: the gate handled python/js but NOT typescript, so a TS answer
// fenced as ```typescript sailed through with zero checks — a live linked-list answer shipped
// uncompilable code (`this.head: Node<T> = null` inside a constructor → TS1005) and the council
// stamped it. The TS branch reads ts.transpileModule's SYNTACTIC diagnostics only (TS1xxx).
//
// FALSE-REJECT guards are the load-bearing half (verifiers fail in two directions): a missed
// syntax error ships one warning-less answer; a false reject warns on CORRECT code and, worse,
// invites a needless repair. Every "valid-*" case asserts we do NOT flag legitimate TS — including
// TYPE errors and undeclared types, which strict:false deliberately ignores.
import { verifyCodeBlocks, relabelMislabeledJsFences, fenceUnfencedCode, detectNoDependencyConstraint, findExternalImports } from './domainVerifiers'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}
const flagged = (txt: string) => verifyCodeBlocks(txt).length > 0
const fence = (lang: string, s: string) => '```' + lang + '\n' + s + '\n```'

// [REAL] the verbatim linked-list body from the live /api/chat run (cont.90 suite, task 1).
const REAL_LINKEDLIST = `class SinglyLinkedList<T> {
  constructor() {
    this.head: Node<T> | null = null;
  }
}`

console.log('== broken TS must be FLAGGED ==')
check('[REAL] linkedlist ctor field-with-type', flagged(fence('typescript', REAL_LINKEDLIST)))
check('unterminated generic', flagged(fence('ts', 'function f<T(x: T){ return x }')))
check('missing paren', flagged(fence('tsx', 'const f = (a: number => a + 1')))

console.log('== valid TS must NOT be flagged (false-reject guards) ==')
check('valid generic class', !flagged(fence('ts', 'class A<T>{ head: T | null = null; push(v: T){ this.head = v } }')))
check('type error only (2xxx)', !flagged(fence('typescript', 'const x: number = "hi"; export {x}')))
check('undeclared type (needs libs)', !flagged(fence('ts', 'const y: Foo = 1; export {y}')))
check('import-using snippet', !flagged(fence('typescript', 'import { z } from "zod"\nexport const s = z.string()')))
check('tsx with jsx', !flagged(fence('tsx', 'export const C = () => <div className="x">hi</div>')))

console.log('== runtime-fatal SEMANTIC TS must be FLAGGED ==')
// [REAL] the second live linked-list run parsed fine but reassigned `const current` while walking
// the list → TS2588 → throws "Assignment to constant variable" the first time push() has >1 node.
check('const reassignment (TS2588)', flagged(fence('typescript',
  'class L<T>{ head:{v:T,next:any}|null=null; push(v:T){ const c=this.head; c=this.head as any } }')))
check('redeclare block-scoped (TS2451)', flagged(fence('ts', 'let a = 1; let a = 2;')))

console.log('== semantic check must NOT false-reject (the load-bearing half) ==')
// noLib:true + types:[] must strip the DOM.Node collision that naive type-checking would flag.
check('user Node class (no DOM collide)', !flagged(fence('ts', 'class Node<T>{ v:T; constructor(v:T){this.v=v} } export {Node}')))
check('references global console', !flagged(fence('typescript', 'export function log(x: string){ console.log(x) }')))
check('references undeclared external type', !flagged(fence('ts', 'export const y: Foo = 1 as any')))
check('valid const, no reassign', !flagged(fence('typescript', 'export function f(){ const a = 1; return a + 1 }')))
check('valid let reassignment', !flagged(fence('ts', 'export function f(){ let a = 1; a = 2; return a }')))

console.log('== other langs unchanged ==')
check('valid js not flagged', !flagged(fence('js', 'const f = (a) => a + 1')))
check('broken js flagged', flagged(fence('js', 'function f( {')))
check('prose fence ignored', !flagged(fence('', 'just some text, no lang')))

console.log('== TS-in-js-fence relabel (deterministic, cont.94) ==')
// [REAL] the live 0/6 repair class: the FM writes TypeScript inside a ```js fence. The code is
// fine; the LABEL is the defect. relabelMislabeledJsFences must fix it with zero inference…
const TS_IN_JS = fence('js', 'class Bucket {\n  private tokens: number = 5;\n  take(): boolean { if (this.tokens > 0) { this.tokens--; return true } return false }\n}')
const r1 = relabelMislabeledJsFences(TS_IN_JS)
check('TS-in-js fence is relabeled to ts', r1.relabeled === 1 && r1.text.startsWith('```ts\n'))
check('relabeled fence passes the syntax gate', !flagged(r1.text))
check('relabel preserves the code byte-for-byte', r1.text.includes('private tokens: number = 5;'))
// …and must NOT touch what isn't the mislabel class:
const r2 = relabelMislabeledJsFences(fence('js', 'function f( {'))
check('genuinely broken js is NOT relabeled', r2.relabeled === 0)
const r3 = relabelMislabeledJsFences(fence('js', 'const f = (a) => a + 1'))
check('valid js is untouched', r3.relabeled === 0 && r3.text === fence('js', 'const f = (a) => a + 1'))
const r4 = relabelMislabeledJsFences(fence('ts', 'const x: number = 1'))
check('ts fences are out of scope', r4.relabeled === 0)


console.log('== fence inference on fenceless answers (deterministic, cont.95) ==')
// [REAL-shaped] a code-intent answer shipped as raw source with NO fences — every code gate
// abstained. fenceUnfencedCode must fence a parse-clean code region with zero inference…
const RAW_TS = `Here is a token bucket rate limiter:

class TokenBucket {
  private tokens: number;
  constructor(private capacity: number, private ratePerSec: number) {
    this.tokens = capacity;
  }
  tryAcquire(): boolean {
    if (this.tokens > 0) { this.tokens--; return true; }
    return false;
  }
}

const b = new TokenBucket(5, 1);
console.log(b.tryAcquire());

Use tryAcquire() before each request.`
const f1 = fenceUnfencedCode(RAW_TS)
check('raw TS region gets fenced', f1.fenced >= 1 && f1.text.includes('```'))
check('fenced result passes the syntax gate', !flagged(f1.text))
check('code preserved byte-for-byte', f1.text.includes('private ratePerSec: number'))
check('surrounding prose stays outside the fence', /^Here is a token bucket rate limiter:/.test(f1.text.trim()))
const RAW_PY = `def fib(n):
    if n < 2:
        return n
    a, b = 0, 1
    for _ in range(n - 1):
        a, b = b, a + b
    return b

print(fib(10))`
const f2 = fenceUnfencedCode(RAW_PY)
check('raw python fenced as python', f2.fenced === 1 && f2.text.includes('```python'))
// …and must NEVER fence what is not code:
const PROSE = `The rate limiter pattern controls how often an action runs.

It works by tracking a budget of tokens. Each request spends one token,
and tokens refill over time at a fixed rate. When the bucket is empty,
requests are denied until refill catches up. This bounds burst size
while allowing a steady average rate over longer windows.`
const f3 = fenceUnfencedCode(PROSE)
check('plain prose is never fenced', f3.fenced === 0 && f3.text === PROSE)
const f4 = fenceUnfencedCode('Use `x = 5` to set it.\nThen call f(x).\nDone.')
check('short inline mentions not fenced', f4.fenced === 0)
const f5 = fenceUnfencedCode('```ts\nconst x = 1\n```')
check('already-fenced answers untouched', f5.fenced === 0)
const BROKEN = `class Broken {
  constructor( {
    this.x = = 1;
  }
}
more broken ( } lines here;`
check('unparseable region left unfenced', fenceUnfencedCode(BROKEN).fenced === 0)

console.log('== no-external-dependency constraint (deterministic, cont.95) ==')
check('detects "no external packages"', detectNoDependencyConstraint('build a rate limiter with no external packages'))
check('detects "without using any libraries"', detectNoDependencyConstraint('implement debounce without using any libraries'))
check('detects "stdlib only"', detectNoDependencyConstraint('write an HTTP server, stdlib only'))
check('detects "vanilla javascript"', detectNoDependencyConstraint('a carousel in vanilla JavaScript'))
check('detects "zero dependencies"', detectNoDependencyConstraint('a zero-dependency logger'))
check('no false-fire on plain code ask', !detectNoDependencyConstraint('implement a token bucket rate limiter in TypeScript'))
check('no false-fire on express ask', !detectNoDependencyConstraint('add rate limiting to my express app'))
const EXPRESS = fence('ts', "import express from 'express'\nimport rateLimit from 'express-rate-limit'\nconst app = express()")
check('flags express + express-rate-limit', JSON.stringify(findExternalImports(EXPRESS)) === '[\"express\",\"express-rate-limit\"]')
check('builtins are not external', findExternalImports(fence('ts', "import { EventEmitter } from 'events'\nimport fs from 'node:fs'")).length === 0)
check('relative imports are not external', findExternalImports(fence('ts', "import { x } from './util'")).length === 0)
check('scoped package token', JSON.stringify(findExternalImports(fence('ts', "import { z } from '@scope/pkg/sub'"))) === '[\"@scope/pkg\"]')
check('require() form detected', JSON.stringify(findExternalImports(fence('js', "const _ = require('lodash')"))) === '[\"lodash\"]')
check('no imports → empty', findExternalImports(fence('ts', 'const a = 1')).length === 0)
check('python fences out of scope', findExternalImports(fence('python', 'import requests')).length === 0)

console.log(`\n${pass}/${pass + fail}`)
if (fail) process.exit(1)

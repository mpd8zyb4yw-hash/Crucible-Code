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
import { verifyCodeBlocks, relabelMislabeledJsFences } from './domainVerifiers'

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

console.log(`\n${pass}/${pass + fail}`)
if (fail) process.exit(1)

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
import { verifyCodeBlocks } from './domainVerifiers'

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

console.log('== other langs unchanged ==')
check('valid js not flagged', !flagged(fence('js', 'const f = (a) => a + 1')))
check('broken js flagged', flagged(fence('js', 'function f( {')))
check('prose fence ignored', !flagged(fence('', 'just some text, no lang')))

console.log(`\n${pass}/${pass + fail}`)
if (fail) process.exit(1)

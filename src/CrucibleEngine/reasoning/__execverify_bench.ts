// Pure, offline bench for the answer-path EXECUTION verifier. No model calls, no network.
// Run: npx tsx src/CrucibleEngine/reasoning/__execverify_bench.ts   (npm run vgr:execverify)
//
// Guards the cont.86b blocker: the name-matching verifier CERTIFIED JSON-Schema-with-a-regex
// because a decorative import made every identifier "documented". Cases marked [REAL] are
// verbatim artifacts from live FM runs that the regex verifier certified GREEN.
//
// The FALSE-REJECT guards are the load-bearing half (cont.85 — verifiers fail in TWO directions).
// A missed fabrication ships one bad answer; a false reject teaches repair to "fix" CORRECT code.
// Every guard below asserts we do NOT reject something legitimate, and that we ABSTAIN rather
// than guess whenever the environment cannot prove anything.
import { verifyByExecution, verifyPlainCodeByExecution, certifyAnswer } from './executionVerify'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

// The real zod.dev passage the live run retrieved (audit-traces/p2/evidence-routefix.txt, S1).
const ZOD_EV = `[S1] Defining schemas | Zod — https://zod.dev/api?id=ip-addresses
String formats To validate against some common string formats: z.email(); z.uuid(); z.url();
z.httpUrl(); z.hostname(); z.e164(); z.emoji(); z.base64(); z.jwt(); z.nanoid(); z.cuid();
z.ulid(); z.ipv4(); z.ipv6(); z.mac(); z.cidrv4(); z.cidrv6(); IP addresses const ipv4 = z.ipv4();
.extend() To add additional fields to an object schema: const DogWithBreed = Dog.extend({ breed: z.string() });`

const code = (s: string) => '```ts\n' + s + '\n```'

console.log('== [REAL] artifacts the NAME-MATCHING verifier certified green ==')
{
  // Verbatim shape from the live FM: every name is documented, the import is decorative,
  // the actual work is JSON Schema + a hand-rolled regex. THE case this verifier exists for.
  const gamed = code(`const { base64, cidrv4, cuid, email, ipv4, string } = require('zod');
const ipv4Schema = { type: 'object', properties: { ip: { type: 'string', pattern: '^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$' } } };
const validateIpv4 = (ip) => ipv4Schema.validate(ip);
module.exports = { validateIpv4 };`)
  const v = verifyByExecution(gamed, ZOD_EV)
  check('[REAL] decorative import + JSON Schema → violations', v.status === 'violations', v.reason)
  check('[REAL] blames validateIpv4', v.defects.some(d => d.symbol === 'validateIpv4'), JSON.stringify(v.defects))
  check('[REAL] reports the real runtime error', /is not a function/.test(v.defects[0]?.error ?? ''), v.defects[0]?.error)
  check('[REAL] executed against real zod', v.library === 'zod')
}
{
  // The LAUNDERING artifact — the FM's answer to the regex fix. It calls one documented API
  // (`extend`) so "it used the evidence", while the schema stays JSON Schema. Regex certified
  // this. `extend` is not a real zod export, so EXECUTION catches what regex structurally could not.
  const laundered = code(`const { extend, ipv4 } = require('zod');
const ipv4Schema = { type: 'object', properties: { ip: { type: 'string', pattern: '^(25[0-5])$' } } };
const full = extend(ipv4Schema, { strict: true });
module.exports = { full };`)
  const v = verifyByExecution(laundered, ZOD_EV)
  check('[REAL] decorative extend() call → violations', v.status === 'violations', v.reason)
  check('[REAL] caught at module load', v.defects[0]?.symbol === '<module>', JSON.stringify(v.defects))
  check('[REAL] names extend as not-a-function', /extend is not a function/.test(v.defects[0]?.error ?? ''), v.defects[0]?.error)
}
{
  // qwen2.5-1.5b's CERTIFIED output — an object literal has no .safeParse; it throws.
  const qwen = code(`const { z } = require('zod');
const ipv4Schema = { type: 'object', properties: { address: z.string() } };
function validate(address) { return ipv4Schema.safeParse(address); }
module.exports = { validate };`)
  const v = verifyByExecution(qwen, ZOD_EV)
  check('[REAL] qwen object-literal .safeParse → violations', v.status === 'violations', v.reason)
  check('[REAL] names safeParse as not-a-function', /safeParse is not a function/.test(v.defects[0]?.error ?? ''), v.defects[0]?.error)
}
{
  // A fabricated free identifier — dies with ReferenceError, also structural.
  const v = verifyByExecution(code(`const { z } = require('zod');
function validate(ip) { return parseIPv4(ip); }
module.exports = { validate };`), ZOD_EV)
  check('fabricated free identifier → violations', v.status === 'violations', v.reason)
  check('names it not-defined', /is not defined/.test(v.defects[0]?.error ?? ''), v.defects[0]?.error)
}

console.log('\n== FALSE-REJECT GUARDS — correct code MUST certify (load-bearing) ==')
{
  // Canonical, documented, correct. If this ever rejects, repair starts "fixing" working code.
  const v = verifyByExecution(code(`const { z } = require('zod');
const schema = z.ipv4();
function validate(ip) { return schema.safeParse(ip).success; }
module.exports = { validate };`), ZOD_EV)
  check('canonical z.ipv4()+safeParse → CERTIFIED', v.status === 'certified', v.reason)
  check('reports what it exercised', v.exercised.includes('validate'), JSON.stringify(v.exercised))
}
{
  // .parse() THROWS ZodError on bad input — that is the code WORKING, not a structural defect.
  const v = verifyByExecution(code(`const { z } = require('zod');
const schema = z.ipv4();
function validate(ip) { return schema.parse(ip); }
module.exports = { validate };`), ZOD_EV)
  check('z.ipv4().parse() throwing ZodError → CERTIFIED (not structural)', v.status === 'certified', v.reason)
}
{
  // ESM import syntax, as the docs actually write it.
  const v = verifyByExecution(code(`import { z } from 'zod';
export function validate(ip: string) { return z.ipv4().safeParse(ip).success; }`), ZOD_EV)
  check('ESM + TS canonical → CERTIFIED', v.status === 'certified', v.reason)
}
{
  // A function that throws on SOME inputs only is not structurally broken.
  const v = verifyByExecution(code(`const { z } = require('zod');
function validate(ip) { if (typeof ip !== 'string') throw new TypeError('ip must be a string'); return z.ipv4().safeParse(ip).success; }
module.exports = { validate };`), ZOD_EV)
  check('throws on SOME inputs only → CERTIFIED', v.status === 'certified', v.reason)
}

console.log('\n== ABSTAIN GATES — never guess (an abstain is honest; a false green is not) ==')
{
  check('prose with no code → abstain', verifyByExecution('just prose', ZOD_EV).status === 'abstain')
  check('no import → abstain', verifyByExecution(code('const x = 1 + 1'), ZOD_EV).status === 'abstain')
}
{
  // Evidence is silent on express → we have no authority to judge it.
  const v = verifyByExecution(code(`const express = require('express');\nconst app = express();`), ZOD_EV)
  check('library the evidence never mentions → abstain', v.status === 'abstain', v.reason)
}
{
  // Uninstalled library => ENVIRONMENT limit, not a code defect. Must not reject.
  const EV = 'Docs for leftpad: leftpad.pad(); leftpad.padStart(); leftpad.trim(); leftpad.fill();'
  const v = verifyByExecution(code(`const lp = require('leftpad-nonexistent-xyz');\nconst f = (s) => lp.pad(s);`), EV)
  check('uninstalled library → abstain (environment, not a defect)', v.status === 'abstain', v.reason)
}
{
  // Loads fine but defines nothing callable — nothing to exercise, so no standing to certify.
  const v = verifyByExecution(code(`const { z } = require('zod');\nconst schema = z.ipv4();`), ZOD_EV)
  check('no callable function → abstain', v.status === 'abstain', v.reason)
}
{
  // Syntax errors belong to the sandbox/static path, not this verifier.
  const v = verifyByExecution(code(`const { z } = require('zod'); function ((( broken`), ZOD_EV)
  check('unparseable code → abstain (not a structural defect)', v.status === 'abstain', v.reason)
}

console.log('\n== the sandbox is network-denied ==')
{
  const v = verifyByExecution(code(`const { z } = require('zod');
const fs = require('fs');
function validate(ip) { return z.ipv4().safeParse(ip).success; }`), ZOD_EV)
  check('require("fs") is blocked → cannot reach the host', v.status === 'abstain' || v.status === 'violations', v.reason)
}

// ── PLAIN-CODE execution: no library, run the answer's OWN demonstration ─────────
console.log('\n== PLAIN-CODE execution — no import, run the answer\'s own demo ==')
{
  // A linked-list whose reverse() calls a method that does not exist. Parses fine (past the TS
  // gate), but the author's own example dies structurally when run. THE cont.90 class.
  const broken = code(`class LinkedList {
  constructor() { this.head = null; }
  push(v) { const n = { value: v, next: this.head }; this.head = n; }
  reverse() { return this.rebuild(); }   // rebuild is never defined
}
const list = new LinkedList();
list.push(1); list.push(2);
console.log(list.reverse());`)
  const v = verifyPlainCodeByExecution(broken)
  check('plain: demo hits a missing method → violations', v.status === 'violations', v.reason)
  check('plain: names it not-a-function', /is not a function/.test(v.defects[0]?.error ?? ''), v.defects[0]?.error)
  check('plain: certifyAnswer surfaces it as executed violations',
    (() => { const c = certifyAnswer(broken, '', { codeRequested: true }); return c.status === 'violations' && c.executed })())
}
{
  // Fabricated free identifier reached only when the demo calls the function.
  const v = verifyPlainCodeByExecution(code(`function sum(a, b) { return add(a, b); }
console.log(sum(1, 2));`))
  check('plain: free identifier in exercised fn → violations', v.status === 'violations', v.reason)
  check('plain: reports not-defined', /is not defined/.test(v.defects[0]?.error ?? ''), v.defects[0]?.error)
}
{
  // [REAL, cont.94] timer globals — a correct interval-refill limiter was flagged broken live
  // because the sandbox stubbed setTimeout but not setInterval, and the ReferenceError read as
  // structural. Every timer global a Node/browser demo can reach must be present (stubbed).
  const timers = verifyPlainCodeByExecution(code(`class RateLimiter {
  constructor(capacity, intervalMs) { this.capacity = capacity; this.tokens = capacity; this.timer = setInterval(() => { this.tokens = Math.min(this.capacity, this.tokens + 1) }, intervalMs); }
  acquire() { if (this.tokens > 0) { this.tokens--; return true } return false }
  stop() { clearInterval(this.timer); }
}
const r = new RateLimiter(3, 1000);
console.log(r.acquire());
r.stop();`))
  check('plain: setInterval/clearInterval demo is NOT a structural defect', timers.status === 'certified', timers.status + ': ' + timers.reason)
}
{
  // CORRECT self-demonstrating answer — MUST certify (false-reject guard, load-bearing).
  const good = code(`class LinkedList {
  constructor() { this.head = null; }
  push(v) { this.head = { value: v, next: this.head }; }
  reverse() { let prev = null, cur = this.head; while (cur) { const nx = cur.next; cur.next = prev; prev = cur; cur = nx; } this.head = prev; return this; }
  toArray() { const out = []; let c = this.head; while (c) { out.push(c.value); c = c.next; } return out; }
}
const list = new LinkedList();
list.push(1); list.push(2); list.push(3);
console.log(list.reverse().toArray());`)
  const v = verifyPlainCodeByExecution(good)
  check('plain: correct linked-list demo → CERTIFIED', v.status === 'certified', v.reason)
  check('plain: certifyAnswer certifies it as executed',
    (() => { const c = certifyAnswer(good, '', { codeRequested: true }); return c.status === 'certified' && c.executed })())
}
{
  // A demo that THROWS a normal Error on purpose is not a structural collapse → abstain, not reject.
  const v = verifyPlainCodeByExecution(code(`function guard(x) { if (x < 0) throw new Error('negative'); return x; }
console.log(guard(-1));`))
  check('plain: intentional Error throw → abstain (not structural)', v.status === 'abstain', v.reason)
}
{
  // Definitions with NO usage — nothing ran, so no standing to certify → abstain.
  const v = verifyPlainCodeByExecution(code(`function reverseList(head) { let prev = null; while (head) { const n = head.next; head.next = prev; prev = head; head = n; } return prev; }`))
  check('plain: definitions but no demo → abstain', v.status === 'abstain', v.reason)
}
{
  // A lone console.log is NOT a self-exercise of the answer's own code → abstain.
  const v = verifyPlainCodeByExecution(code(`function noop() { return 1; }\nconsole.log('hi');`))
  check('plain: console.log alone is not a demo → abstain', v.status === 'abstain', v.reason)
}
{
  // Imports a package → NOT the plain path's call (library path or out of scope).
  const v = verifyPlainCodeByExecution(code(`const _ = require('lodash');\nconsole.log(_.chunk([1,2,3], 2));`))
  check('plain: code with an import → abstain (not plain)', v.status === 'abstain', v.reason)
}
{
  // [REAL cont.91] const-reassignment in the live FM's linked-list demo. `const current = head;
  // current = current.next` throws "Assignment to constant variable" on EVERY run — structural.
  const v = verifyPlainCodeByExecution(code(`function build(values) {
  const head = { value: values[0], next: null };
  const current = head;
  for (let i = 1; i < values.length; i++) { current.next = { value: values[i], next: null }; current = current.next; }
  return head;
}
const list = build([1, 2, 3]);
console.log(list);`))
  check('plain: const-reassignment demo → violations', v.status === 'violations', v.reason)
  check('plain: names assignment-to-constant', /Assignment to constant/.test(v.defects[0]?.error ?? ''), v.defects[0]?.error)
}
{
  // [REAL cont.91] the live FM shipped the SAME 84-line program in TWO fences. Joining redeclared
  // every top-level const → SyntaxError → false-abstain. Dedup makes the real defect surface.
  const prog = `function build(values) {
  const head = { value: values[0], next: null };
  let current = head;
  for (let i = 1; i < values.length; i++) { current.next = { value: values[i], next: null }; current = current.next; }
  return head;
}
const list = build([1, 2, 3]);
console.log(JSON.stringify(list));`
  const dup = code(prog) + '\n\n' + code(prog)   // identical block twice
  const v = verifyPlainCodeByExecution(dup)
  check('plain: identical duplicate blocks → not a false-abstain (dedup)', v.status === 'certified', v.reason)
}
{
  // No code at all → abstain.
  check('plain: prose only → abstain', verifyPlainCodeByExecution('just prose').status === 'abstain')
}

console.log('\n== NODE-BUILTIN LAUNDERING (cont.93) — a safe builtin import must not dodge execution ==')
{
  // A pure computational builtin (`events`) is PROVIDED, so correct code behind it runs → certified.
  // Before the fix this abstained (any import → not the plain path), and any broken logic wrapped in
  // the same import laundered past every execution tier untouched.
  const good = code(`import { EventEmitter } from 'events';
class Counter extends EventEmitter {
  constructor() { super(); this.n = 0; }
  inc() { this.n++; this.emit('inc', this.n); return this.n; }
}
const c = new Counter();
let seen = 0;
c.on('inc', v => { seen = v; });
c.inc(); c.inc();
console.log(seen);`)
  const v = verifyPlainCodeByExecution(good)
  check('plain: correct code behind `events` import → CERTIFIED (not laundered)', v.status === 'certified', v.reason)
}
{
  // THE HOLE: structural death laundered behind an `events` import. Now the builtin resolves, the
  // demo runs, and the const-reassignment is caught — instead of the import buying a free pass.
  const laundered = code(`import { EventEmitter } from 'events';
const bus = new EventEmitter();
function build(values) {
  const head = { value: values[0], next: null };
  const current = head;
  for (let i = 1; i < values.length; i++) { current.next = { value: values[i], next: null }; current = current.next; }
  return head;
}
bus.emit('x');
const list = build([1, 2, 3]);
console.log(list);`)
  const v = verifyPlainCodeByExecution(laundered)
  check('plain: broken logic behind `events` import → violations (laundering closed)', v.status === 'violations', v.reason)
  check('plain: certifyAnswer surfaces the laundered defect as executed',
    (() => { const c = certifyAnswer(laundered, '', { codeRequested: true }); return c.status === 'violations' && c.executed })())
}
{
  // FALSE-REJECT GUARD. An I/O-capable builtin (`fs`) is NOT on the allowlist — we deny it, and
  // denying a module the code legitimately needs is not our call → abstain, never reject. The
  // sandbox stays unable to touch the host.
  const usesFs = code(`import * as fs from 'fs';
function readCfg(p) { return fs.readFileSync(p, 'utf8'); }
console.log(readCfg('/etc/hostname'));`)
  const v = verifyPlainCodeByExecution(usesFs)
  check('plain: fs import → abstain (deny, not reject — no host access, no false reject)', v.status === 'abstain', v.reason)
}
{
  // FALSE-REJECT GUARD. A safe builtin next to a third-party package still abstains — the presence
  // of ANY non-allowlisted library defers the whole answer to the library path.
  const mixed = code(`import { EventEmitter } from 'events';
import _ from 'lodash';
const e = new EventEmitter();
console.log(_.chunk([1, 2, 3], 2));`)
  const v = verifyPlainCodeByExecution(mixed)
  check('plain: safe builtin + third-party → abstain (defers to library path)', v.status === 'abstain', v.reason)
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

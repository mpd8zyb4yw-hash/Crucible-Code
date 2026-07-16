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
import { verifyByExecution } from './executionVerify'

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

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

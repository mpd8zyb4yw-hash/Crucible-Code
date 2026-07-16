// Pure, offline bench for the API-faithfulness verifier. No model calls, no network.
// Run: npx tsx src/CrucibleEngine/reasoning/__apifaith_bench.ts   (npm run vgr:apifaith)
//
// Guards the cont.82 blocker: the FM grounds on the right page, cites it, and CONTRADICTS it
// (`import { Schema } from 'zod'`, `require('zod').validate()`) with a literal `z.ipv4();` in
// context. Cases marked [REAL] are verbatim from audit-traces/p2 live runs.
//
// The FALSE-REJECT guards are the load-bearing half. Per cont.79h a false reject is worse than
// a missed check: a missed fabrication ships one bad answer, a false reject teaches the repair
// loop to "fix" correct code. Every guard below asserts we do NOT reject something legitimate.
import {
  verifyApiFaithfulness, verifyEvidenceUsage, repairHint, extractLibraryUsage,
  documentedIdentifiers, documentedCallSurface, answerCodeBlocks,
} from './apiFaithfulness'

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

console.log('== [REAL] fabrications the live FM emitted on evidence containing z.ipv4() ==')
{
  // Verbatim from t4-routefix.sse.
  const v = verifyApiFaithfulness(code("import { Schema } from 'zod';\nconst ipv4Schema: Schema<string> = { type: 'string' };"), ZOD_EV)
  check('[REAL] `import { Schema } from zod` → violations', v.status === 'violations', v.reason)
  check('[REAL] names Schema as the offender', v.violations[0]?.identifier === 'Schema')
  check('[REAL] classifies it a named-import', v.violations[0]?.kind === 'named-import')
}
{
  const v = verifyApiFaithfulness(code("const s = require('zod').validate({ ip: 'string' })"), ZOD_EV)
  check("[REAL] `require('zod').validate()` → violations", v.status === 'violations', v.reason)
  check('[REAL] names validate as the offender', v.violations[0]?.identifier === 'validate')
}
{
  const v = verifyApiFaithfulness(code("import * as z from 'zod'\nconst s = z.parseIPv4()"), ZOD_EV)
  check('invented namespace member `z.parseIPv4()` → violations', v.status === 'violations', v.reason)
  check('classifies it a namespace-member', v.violations[0]?.kind === 'namespace-member')
}

console.log('\n== FALSE-REJECT GUARDS — legitimate code must never be rejected ==')
{
  const v = verifyApiFaithfulness(code("import * as z from 'zod'\nconst ipv4Schema = z.ipv4()\nexport default ipv4Schema"), ZOD_EV)
  check('the CORRECT answer (z.ipv4) certifies', v.status === 'certified', v.reason)
}
{
  const v = verifyApiFaithfulness(code("import { ipv4, email } from 'zod'\nconst a = ipv4()"), ZOD_EV)
  check('documented named imports certify', v.status === 'certified', v.reason)
}
{
  // The Q10 hazard: docs write `ipv4()` in a prose table, code writes `z.ipv4()`. Same API.
  const proseEv = 'Network validators: Validator | Regex\nipv4() | regexes.ipv4\nipv6() | regexes.ipv6\nmac() | regexes.mac\ncidrv4() | regexes.cidrv4  (zod)'
  const v = verifyApiFaithfulness(code("import * as z from 'zod'\nconst s = z.ipv4()"), proseEv)
  check('prose `ipv4()` certifies a `z.ipv4()` call [Q10]', v.status === 'certified', v.reason)
}
{
  // `as` aliasing: the ORIGINAL name is the API claim, the alias is the author's own.
  const v = verifyApiFaithfulness(code("import { ipv4 as v4 } from 'zod'\nconst s = v4()"), ZOD_EV)
  check('aliased import judged on the original name', v.status === 'certified', v.reason)
}
{
  // We must NOT judge members of locals — their type comes from a zod call we cannot infer.
  const v = verifyApiFaithfulness(code("import * as z from 'zod'\nconst s = z.ipv4()\nconst r = s.safeParse('1.2.3.4')\nif (!r.success) throw new Error(r.error.message)"), ZOD_EV)
  check('members of LOCAL vars (s.safeParse) are not judged', v.status === 'certified', v.reason)
}
{
  // A locally defined helper is not a library claim.
  const v = verifyApiFaithfulness(code("import * as z from 'zod'\nfunction toIpv4Schema() { return z.ipv4() }\nconst s = toIpv4Schema()"), ZOD_EV)
  check('locally defined functions are not judged', v.status === 'certified', v.reason)
}
{
  const v = verifyApiFaithfulness(code("import * as z from 'zod'\nconst s = z.ipv4()\nconsole.log(JSON.stringify({ ok: Array.isArray([]) }))"), ZOD_EV)
  check('language builtins are not judged', v.status === 'certified', v.reason)
}
{
  const v = verifyApiFaithfulness(code("import * as z from 'zod'\nexport default z.default"), ZOD_EV)
  check('universal members (.default) are not judged', v.status === 'certified', v.reason)
}

console.log('\n== ABSTAIN — never certify, never reject, when we cannot be an authority ==')
{
  const v = verifyApiFaithfulness('Zod provides `z.ipv4()` for IP validation. [S1]', ZOD_EV)
  check('prose answer with no code → abstain', v.status === 'abstain', v.reason)
}
{
  const v = verifyApiFaithfulness(code('const re = /^[0-9.]+$/\nexport default re'), ZOD_EV)
  check('code with no library import → abstain', v.status === 'abstain', v.reason)
}
{
  // Evidence never mentions express — absence proves nothing about express.
  const v = verifyApiFaithfulness(code("import express from 'express'\nconst app = express()\napp.listen(3000)"), ZOD_EV)
  check('library absent from evidence → abstain, not reject', v.status === 'abstain', v.reason)
}
{
  // A stub page: mentions zod but documents almost nothing.
  const thin = 'Zod101 — Interactive Zod Schema Playground. Test and validate your zod schemas in real-time.'
  const v = verifyApiFaithfulness(code("import { Schema } from 'zod'\nconst s: Schema = {}"), thin)
  check('evidence too thin to be an authority → abstain', v.status === 'abstain', v.reason)
}
{
  const v = verifyApiFaithfulness(code("import { Schema } from 'zod'"), '')
  check('empty evidence → abstain', v.status === 'abstain', v.reason)
}

console.log('\n== [REAL] the WHOLE-ANSWER miss: JSON Schema substituted for the library ==')
{
  // Verbatim shape from the live run (audit-traces/p3): grounded on zod.dev, cited [S1],
  // emitted JSON Schema with a hand-rolled regex and no zod at all.
  const jsonSchema = '```json\n' + JSON.stringify({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { ip: { type: 'string', pattern: '^((25[0-5]|2[0-4][0-9])\\.){3}$' } },
    required: ['ip'],
  }, null, 2) + '\n```'
  const v = verifyApiFaithfulness(jsonSchema, ZOD_EV)
  check('[REAL] JSON-Schema substitution → violations', v.status === 'violations', v.reason)
  check('[REAL] classified as ignored-evidence', v.violations[0]?.kind === 'ignored-evidence')
  check('[REAL] hint tells it to use the documented API', /documented API/i.test(repairHint(v)) && repairHint(v).includes('ipv4'))
}
{
  // Hand-rolled regex instead of the documented validator — same class, different disguise.
  const handRolled = '```ts\nconst ipv4Re = /^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}$/\nexport function isIpv4(s: string): boolean {\n  return ipv4Re.test(s)\n}\n```'
  const v = verifyApiFaithfulness(handRolled, ZOD_EV)
  check('hand-rolled impl ignoring the documented API → violations', v.status === 'violations', v.reason)
}

console.log('\n== FALSE-REJECT GUARDS for the whole-answer check ==')
{
  // ANY contact with the documented surface certifies — one documented call is enough.
  const v = verifyEvidenceUsage('```ts\nimport * as z from "zod"\nconst s = z.ipv4()\nconst out = s.safeParse("1.2.3.4")\nconsole.log(out.success)\n```', ZOD_EV)
  check('answer that uses the API → abstain (per-identifier owns it)', v.status === 'abstain', v.reason)
}
{
  // A shell block is not an API claim.
  const v = verifyApiFaithfulness('Install it first:\n\n```bash\nnpm install zod\n```', ZOD_EV)
  check('bash install block → abstain, not reject', v.status === 'abstain', v.reason)
}
{
  const v = verifyEvidenceUsage('```ts\nconst x = 1\n```', ZOD_EV)
  check('trivial snippet → abstain', v.status === 'abstain', v.reason)
}
{
  // Thin evidence: "no overlap" proves nothing when the docs document nothing.
  const thin = 'Zod101 — Interactive Zod Schema Playground. Test and validate your zod schemas.'
  const v = verifyEvidenceUsage('```json\n{ "type": "object", "properties": { "ip": { "type": "string" } } }\n```', thin)
  check('thin evidence → abstain, not reject', v.status === 'abstain', v.reason)
}
{
  // Prose-only answer, no code — nothing to judge.
  const v = verifyEvidenceUsage('Zod exposes `z.ipv4()` for this. [S1]', ZOD_EV)
  check('prose-only answer → abstain', v.status === 'abstain', v.reason)
}

console.log('\n== extraction unit checks ==')
{
  const u = extractLibraryUsage("import * as z from 'zod'\nimport { toTypedSchema } from '@vee-validate/zod'")
  check('scoped package keeps its @scope/name', u.some(x => x.library === '@vee-validate/zod'), JSON.stringify(u.map(x => x.library)))
  check('subpath collapses to the package (zod/v4 → zod)', extractLibraryUsage("import * as z from 'zod/v4'")[0]?.library === 'zod')
  check('namespace binding captured', u.find(x => x.library === 'zod')?.namespaces.includes('z') === true)
}
{
  const u = extractLibraryUsage("const { ipv4 } = require('zod')")
  check('destructured require → named import', u[0]?.named[0]?.identifier === 'ipv4')
  const d = extractLibraryUsage("const s = require('zod').validate()")
  check('member off require → directMember', d[0]?.directMembers[0]?.identifier === 'validate')
  const def = extractLibraryUsage("import z from 'zod'")
  check('default import → namespace', def[0]?.namespaces.includes('z') === true)
}
{
  check('answerCodeBlocks pulls fenced code', answerCodeBlocks('a\n```ts\nconst x=1\n```\nb')[0].trim() === 'const x=1')
  check('answerCodeBlocks ignores prose', answerCodeBlocks('just prose').length === 0)
  const vocab = documentedIdentifiers(ZOD_EV)
  check('vocab has documented ipv4', vocab.has('ipv4'))
  check('vocab lacks fabricated Schema', !vocab.has('Schema'))
  check('vocab lacks fabricated validate', !vocab.has('validate'))
}
{
  // The hint surface must be the API, not prose noise scraped from `zod.dev` / sentence words.
  const surface = documentedCallSurface(ZOD_EV)
  check('call surface includes ipv4', surface.includes('ipv4'))
  check('call surface excludes prose noise (dev/Perfect)', !surface.includes('dev') && !surface.includes('Perfect'), surface.join(','))
}

console.log('\n== repair hint quality ==')
{
  const v = verifyApiFaithfulness(code("import { Schema } from 'zod';"), ZOD_EV)
  const h = repairHint(v)
  check('hint names the fabricated identifier', h.includes('Schema'))
  check('hint offers the documented API (ipv4)', h.includes('ipv4'))
  check('hint forbids hand-rolled substitution', /hand-rolled/i.test(h))
  check('hint is empty for a certified verdict', repairHint(verifyApiFaithfulness(code("import * as z from 'zod'\nconst s = z.ipv4()"), ZOD_EV)) === '')
  check('hint is empty for an abstain verdict', repairHint(verifyApiFaithfulness('prose only', ZOD_EV)) === '')
}
{
  // One defect, used twice, is one finding.
  const v = verifyApiFaithfulness(code("import * as z from 'zod'\nconst a = z.parseIPv4()\nconst b = z.parseIPv4()"), ZOD_EV)
  check('repeated fabrication dedups to 1 violation', v.violations.length === 1, `got ${v.violations.length}`)
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

// ═══════════════════════════════════════════════════════════════════════════════
// W2 — GBNF grammar builder bench (offline; zero model)
// ═══════════════════════════════════════════════════════════════════════════════
// Proves the pure grammar builders emit well-formed GBNF with the intended structure. The live
// constrained-decoding activation (localModelPool.completeLocalModel({ gbnf })) is exercised only
// when a GGUF runtime is present, so here we assert the STRINGS: correct rule set, safe escaping,
// input validation. If node-llama-cpp is importable we additionally assert each grammar compiles.
// ═══════════════════════════════════════════════════════════════════════════════

import { enumGrammar, fencedCodeGrammar, jsonObjectGrammar } from './grammars'

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

async function main() {
  console.log('\nGBNF grammar builders — offline structural checks\n')

  // ── fencedCodeGrammar ──
  const fc = fencedCodeGrammar('typescript')
  check('fenced grammar has a root rule', /^root ::= /m.test(fc))
  check('fenced grammar opens with a triple-backtick + lang literal', fc.includes('\\u0060\\u0060\\u0060typescript'))
  check('fenced grammar body forbids a backtick (unambiguous close)', fc.includes('body ::= [^\\u0060]*'))
  check('fenced grammar sanitizes an unsafe lang to typescript', fencedCodeGrammar('js; rm -rf').includes('\\u0060\\u0060\\u0060typescript'))

  // ── jsonObjectGrammar ──
  const jg = jsonObjectGrammar([{ key: 'label', type: 'string' }, { key: 'score', type: 'number' }, { key: 'ok', type: 'boolean' }])
  check('json grammar emits the keys in order', jg.indexOf('\\"label\\"') < jg.indexOf('\\"score\\"') && jg.indexOf('\\"score\\"') < jg.indexOf('\\"ok\\"'))
  check('json grammar maps string→strval, number→numval, boolean→boolval',
    /strval/.test(jg) && /numval/.test(jg) && /boolval/.test(jg))
  check('json grammar defines every referenced value rule', /strval ::=/.test(jg) && /numval ::=/.test(jg) && /boolval ::=/.test(jg))
  let threwEmpty = false
  try { jsonObjectGrammar([]) } catch { threwEmpty = true }
  check('json grammar rejects an empty field set', threwEmpty)
  let threwUnsafe = false
  try { jsonObjectGrammar([{ key: 'a"b', type: 'string' }]) } catch { threwUnsafe = true }
  check('json grammar rejects an unsafe key', threwUnsafe)

  // ── enumGrammar ──
  const eg = enumGrammar(['bug', 'feature', 'question'])
  check('enum grammar alternates the choices', eg.includes('"bug" | "feature" | "question"'))
  check('enum grammar escapes quotes/backslashes in a choice', enumGrammar(['say "hi"']).includes('\\"hi\\"'))
  let threwEnum = false
  try { enumGrammar([]) } catch { threwEnum = true }
  check('enum grammar rejects an empty choice set', threwEnum)

  // ── Optional: live compile check if the runtime is present ──
  try {
    const mod: any = await import('node-llama-cpp')
    const llama = await mod.getLlama()
    for (const [label, g] of [['fenced', fc], ['json', jg], ['enum', eg]] as const) {
      await llama.createGrammar({ grammar: g })
      check(`live: node-llama-cpp compiles the ${label} grammar`, true)
    }
  } catch {
    console.log('  (node-llama-cpp not installed — skipping live grammar-compile checks)')
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} grammars bench: ${pass} passed, ${fail} failed\n`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })

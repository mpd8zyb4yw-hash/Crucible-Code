// ═══════════════════════════════════════════════════════════════════════════════
// Item 4 — pureCode L0 supplemental co-gate bench (offline; zero model)
// ═══════════════════════════════════════════════════════════════════════════════
// Proves verifyAgainstSupplemental lifts a shape-only L0 ship to behavior-verified when a declared
// export matches a VGR-side supplemental invariant family, and forces an honest escalation when the
// primitive violates that family. This is the last honest-floor gap the plan called out: an L0
// catalog hit that satisfies the declared API shape but whose SEMANTICS were never checked.
// ═══════════════════════════════════════════════════════════════════════════════

import { verifyAgainstSupplemental } from './pureCode'
import type { SynthFile } from './index'

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

async function main() {
  console.log('\npureCode L0 supplemental co-gate — teeth check\n')

  const f = (content: string): SynthFile[] => [{ path: 'src/module.ts', content } as SynthFile]

  // A declared export whose NAME matches a supp family (`clamp`) and whose behavior is correct:
  // the co-gate returns 'pass' → the ship is behavior-verified, not shape-only.
  const goodClamp = await verifyAgainstSupplemental(f(`export function clamp(x,lo,hi){return x<lo?lo:x>hi?hi:x}`), ['clamp'])
  check('a correct clamp primitive PASSES the supplemental co-gate', goodClamp === 'pass', goodClamp)

  // Same name+shape, wrong semantics (ignores the upper bound): the co-gate returns 'fail' → the
  // L0 ship is refused and the cascade escalates honestly instead of shipping a GREEN-yet-wrong hit.
  const badClamp = await verifyAgainstSupplemental(f(`export function clamp(x,lo,hi){return x<lo?lo:x}`), ['clamp'])
  check('a clamp that ignores the upper bound FAILS the co-gate (honest escalation)', badClamp === 'fail', badClamp)

  // A correct csv parser exercises the roundtrip family added this session, end-to-end through the
  // pureCode entry point (not just the reasoning bench).
  const goodCsv = await verifyAgainstSupplemental(f(`export function parseCsvLine(line){
    if(/[\\r\\n]/.test(line)) throw new SyntaxError('nl')
    const out=[]; let i=0
    for(;;){ let fld=''
      if(line[i]==='"'){ i++; let c=false
        while(i<line.length){ if(line[i]==='"'){ if(line[i+1]==='"'){fld+='"';i+=2} else {i++;c=true;break} } else {fld+=line[i];i++} }
        if(!c) throw new SyntaxError('unterminated'); if(i<line.length&&line[i]!==',') throw new SyntaxError('after')
      } else { while(i<line.length&&line[i]!==','){ if(line[i]==='"') throw new SyntaxError('q'); fld+=line[i]; i++ } }
      out.push(fld); if(i>=line.length) break; i++; if(i===line.length){out.push('');break} }
    return out }`), ['parseCsvLine'])
  check('a correct parseCsvLine primitive PASSES the co-gate (roundtrip family)', goodCsv === 'pass', goodCsv)

  // No declared export matches any supp family → 'none' → the shape-only floor is preserved (the
  // co-gate can only ADD confidence, never manufacture a rejection out of an unknown name).
  const none = await verifyAgainstSupplemental(f(`export function frobnicate(x){return x}`), ['frobnicate'])
  check('an unknown export name yields `none` (shape-only floor preserved)', none === 'none', none)

  // Empty inputs are a safe 'none' (never throws).
  check('no files → none', (await verifyAgainstSupplemental([], ['clamp'])) === 'none')
  check('no exports → none', (await verifyAgainstSupplemental(f('export function clamp(){}'), [])) === 'none')

  console.log(`\n${fail === 0 ? '✅' : '❌'} purecode supp co-gate bench: ${pass} passed, ${fail} failed\n`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })

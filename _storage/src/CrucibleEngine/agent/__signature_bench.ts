// Bench for draft signatures (draftSignature.ts). Run:
//   npx tsx src/CrucibleEngine/agent/__signature_bench.ts
//
// Anchored on the EXACT draft from the 2026-07-29 report, whose closing was:
//
//     Best regards,
//
//     [Your Name]
//
// The user's note: "it doesn't have the name to add at the bottom".
import { applySignature, hasNamePlaceholder } from './draftSignature'

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'OK ' : 'XX '} ${name}${ok ? '' : ` — ${detail}`}`)
  ok ? pass++ : fail++
}

const SHIPPED = `Hi Google,

Thank you for bringing this to my attention. I checked my account, and everything looks normal.

Please let me know if there's anything else I need to do.

Best regards,

[Your Name]`

console.log('  — THE SHIPPED DRAFT —')
{
  const r = applySignature(SHIPPED, 'Justin Fitzpatrick')
  check('the placeholder is detected', r.hadPlaceholder === true)
  check('the real name is substituted', r.signed && r.text.endsWith('Justin Fitzpatrick'), JSON.stringify(r.text.slice(-40)))
  check('no placeholder survives', hasNamePlaceholder(r.text) === false, r.text)
  check('the rest of the draft is untouched', r.text.startsWith('Hi Google,') && r.text.includes('Best regards,'))
}

console.log('  — no name known: remove rather than ship a form to fill in —')
{
  for (const name of [null, undefined, '', '   ']) {
    const r = applySignature(SHIPPED, name as any)
    check(`name=${JSON.stringify(name)} leaves no placeholder`, hasNamePlaceholder(r.text) === false, r.text)
    check(`name=${JSON.stringify(name)} keeps the sign-off`, /Best regards,/.test(r.text), r.text)
    check(`name=${JSON.stringify(name)} reports it did not sign`, r.signed === false)
    check(`name=${JSON.stringify(name)} does not trail blank lines`, !/\n\s*\n\s*$/.test(r.text), JSON.stringify(r.text.slice(-20)))
  }
}

console.log('  — the placeholder vocabulary —')
for (const p of [
  '[Your Name]', '[your name]', '[YOUR NAME]', '[Name]', '[Full Name]', '[Your Full Name]',
  '[Sender]', "[Sender's Name]", '[My Name]', '[Insert Name]', '[Name Here]', '[Your Name Here]',
  '<Your Name>', '{{name}}', '[Signature]',
]) {
  const draft = `Thanks.\n\nBest,\n\n${p}`
  const r = applySignature(draft, 'Ada Lovelace')
  check(`${p} → signed`, r.signed && r.text.endsWith('Ada Lovelace'), JSON.stringify(r.text))
}

console.log('  — must NOT fire on real content —')
for (const draft of [
  'Please review the [attached] document and let me know.',
  'The variable [name] in the config refers to the service name.',
  'Hi Sam,\n\nSee you Tuesday.\n\nBest,\nJustin',
  'We discussed the naming convention (your name first, then the date).',
  'Ranked list:\n1. name\n2. address',
]) {
  const r = applySignature(draft, 'Ada Lovelace')
  check(`untouched: ${JSON.stringify(draft.slice(0, 44))}`, r.text === draft && !r.hadPlaceholder,
    'a false positive here rewrites the user\'s real content')
}

console.log('  — a name is never invented —')
{
  // The dangerous failure would be substituting something plausible when the name is unknown.
  const r = applySignature(SHIPPED, null)
  check('no invented name appears', !/\b(John|Jane|Doe|User|Assistant|Crucible)\b/.test(r.text), r.text)
}

console.log('  — total on odd input —')
{
  check('empty draft', applySignature('', 'Ada').text === '')
  check('no placeholder, name given', applySignature('Hello.', 'Ada').text === 'Hello.')
  check('multiple placeholders all filled',
    applySignature('[Name]\n\n[Your Name]', 'Ada').text === 'Ada\n\nAda',
    JSON.stringify(applySignature('[Name]\n\n[Your Name]', 'Ada').text))
  check('repeated calls are stable',
    applySignature(applySignature(SHIPPED, 'Ada').text, 'Ada').text === applySignature(SHIPPED, 'Ada').text)
}

console.log(`\nTOTAL: ${pass}/${pass + fail}`)
if (fail) process.exit(1)

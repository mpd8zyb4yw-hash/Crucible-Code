// End-to-end bench for the draft → review → confirm → send flow (cont.120). Run:
//   npx tsx src/CrucibleEngine/agent/__draftflow_bench.ts
//
// The unit benches cover the pieces (proposal gate, signature, artifact contract). This one walks
// the WHOLE chain the live failure walked, from the raw provider JSON to the exact arguments that
// would reach gmail_send, with no network and no model:
//
//   raw Gmail message  →  entity  →  draftable action  →  proposal  →  "send it"  →  bound args
//
// It exists because every individual piece passed its own tests while the flow did not exist at
// all. The reported failure was not a broken component; it was four working components with
// nothing joining them, which is exactly the shape a unit bench cannot see.
//
// THE INVARIANT THIS PROTECTS: what the user reviewed is what gets sent. Not a re-derivation of
// it, not a re-generation of it — the same bytes. Anything else makes the review meaningless.
import { gmailMessages } from '../tools/adapters'
import { draftableAction } from '../tools/entities'
import {
  proposeAction, peekProposal, takeProposal, clearProposal,
  isConfirmationOf, isCancellationOf, renderProposal,
} from './proposedAction'
import { applySignature } from './draftSignature'

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'OK ' : 'XX '} ${name}${ok ? '' : ` — ${detail}`}`)
  ok ? pass++ : fail++
}

// The actual message from the 2026-07-29 report, in the shape gmail_read returns it.
const RAW_MESSAGE = {
  id: '19faaa8709db5201',
  threadId: '19faaa8709db5201',
  labelIds: ['INBOX', 'UNREAD'],
  snippet: 'This is a copy of a security alert sent to fjord414@gmail.com',
  payload: {
    headers: [
      { name: 'From', value: 'Google <no-reply@accounts.google.com>' },
      { name: 'To', value: 'justinfitz21@gmail.com' },
      { name: 'Subject', value: 'Security alert for fjord414@gmail.com' },
      { name: 'Date', value: 'Tue, 28 Jul 2026 21:36:32 GMT' },
    ],
  },
}

// The draft the model produced, verbatim — including the placeholder that made it unsendable.
const DRAFT = `Hi Google,

Thank you for bringing this to my attention. I checked my account, and everything looks normal. I never granted access to creatorbase-api.workers.dev, so I'll look into this activity and secure my account.

Please let me know if there's anything else I need to do.

Best regards,

[Your Name]`

const CONV = 'bench-conversation'

console.log('  — step 1: a read message becomes an entity that affords a reply —')
const [msg] = gmailMessages([RAW_MESSAGE], { source: 'gmail_read', body: () => 'full body' })
check('gmail_read emits a message entity', msg?.kind === 'message' && msg.source === 'gmail_read',
  'before cont.120 gmail_read returned prose only, so a read message afforded nothing')
check('the entity carries the real message id', msg.id === '19faaa8709db5201')

console.log('  — step 2: the draft is signed before anyone reviews it —')
const signed = applySignature(DRAFT, 'Justin Fitzpatrick')
check('the placeholder is gone', !/\[Your Name\]/.test(signed.text), signed.text.slice(-40))
check('the draft ends with the real name', signed.text.trimEnd().endsWith('Justin Fitzpatrick'))

console.log('  — step 3: the signed draft binds to a real, executable send —')
const action = draftableAction(msg, signed.text)
check('an action is derived', action !== null, 'nothing to send is why "send it" did nothing')
check('the tool is gmail_send', action?.tool === 'gmail_send')
check('the recipient comes from the message, not the model',
  action?.args.to === 'no-reply@accounts.google.com', String(action?.args.to))
check('the subject is a reply to the real subject',
  action?.args.subject === 'Re: Security alert for fjord414@gmail.com', String(action?.args.subject))
check('the body IS the signed draft, unmodified',
  action?.args.body === signed.text, 'the reviewed text and the sent text must be identical')
check('the effect is send, so confirmation is mandatory', action?.effect === 'send')

console.log('  — step 4: the proposal is parked and shown —')
clearProposal(CONV)
const proposal = {
  tool: action!.tool, args: action!.args, effect: action!.effect, verb: action!.verb,
  summary: `Reply to ${action!.args.to}`,
  preview: [
    { label: 'To', value: String(action!.args.to) },
    { label: 'Subject', value: String(action!.args.subject) },
  ],
}
proposeAction(CONV, proposal, 1_000_000)
const shown = renderProposal({ ...proposal, ts: 1_000_000 })
check('the review block names the real recipient', shown.includes('no-reply@accounts.google.com'), shown)
check('the review block states nothing has been sent', /nothing has been sent/i.test(shown), shown)

console.log('  — step 5: "send it" executes exactly what was reviewed —')
{
  const live = peekProposal(CONV, 1_000_000)!
  check('"send it" is read as confirmation', isConfirmationOf('send it', live) === true,
    'THE REPORTED BUG: this returned false, so the turn fell to the prose pipeline')
  const taken = takeProposal(CONV, 1_000_000)!
  check('the executed args are byte-identical to the reviewed ones',
    taken.args.to === action!.args.to
    && taken.args.subject === action!.args.subject
    && taken.args.body === action!.args.body,
    'a re-derivation between review and send would defeat the review')
  check('a second "send it" has nothing left to send',
    peekProposal(CONV, 1_000_000) === null, 'a repeated confirmation would send a second copy')
}

console.log('  — the other direction: the draft turn must NOT send —')
{
  clearProposal(CONV)
  proposeAction(CONV, proposal, 1_000_000)
  const live = peekProposal(CONV, 1_000_000)!
  // The user's own words in the original request.
  check('"do NOT send it until I say so" is not a confirmation',
    isConfirmationOf('do NOT send it until I say so', live) === false)
  check('a follow-up question does not send', isConfirmationOf('who is that from?', live) === false)
  check('a revision request does not send', isConfirmationOf('make it more formal', live) === false)
  check('the proposal survives a non-answer', peekProposal(CONV, 1_000_000) !== null,
    'an unrelated question must not silently discard the draft')
  check('an explicit no cancels it', isCancellationOf("no, don't send it", live) === true)
}

console.log('  — no name known: still sendable, never a form to fill in —')
{
  const unsigned = applySignature(DRAFT, null)
  check('no placeholder survives', !/\[Your Name\]/.test(unsigned.text), unsigned.text.slice(-40))
  const a = draftableAction(msg, unsigned.text)
  check('it still binds to a real send', a?.args.body === unsigned.text)
}

console.log(`\nTOTAL: ${pass}/${pass + fail}`)
if (fail) process.exit(1)

// Bench for the proposed-action gate (proposedAction.ts). Run:
//   npx tsx src/CrucibleEngine/agent/__proposal_bench.ts
//
// THE LIVE REPORT (2026-07-29): a drafted reply, then "send it", then nothing sent.
//
// This gate stands between a model's draft and an irreversible send, so it is tested in BOTH
// directions and the two are not equally weighted:
//
//   * A MISSED confirmation costs the user one more sentence.
//   * A WRONG confirmation sends an email they did not write, to a recipient they did not
//     choose, and it cannot be recalled.
//
// So every ambiguous case below is asserted to resolve to "not confirmed", and the false-accept
// cases are the ones written most aggressively — negations, questions, and instructions that
// begin with the confirming verb ("send it to legal instead") but change what would be sent.
import {
  proposeAction, peekProposal, takeProposal, clearProposal,
  isConfirmationOf, isCancellationOf, renderProposal, PROPOSAL_TTL_MS,
  type ProposedAction,
} from './proposedAction'

let pass = 0, fail = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'OK ' : 'XX '} ${name}${ok ? '' : ` — ${detail}`}`)
  ok ? pass++ : fail++
}

const sendMail: ProposedAction = {
  tool: 'gmail_send',
  args: { to: 'no-reply@accounts.google.com', subject: 'Re: Security alert', body: 'Hi Google, ...' },
  effect: 'send',
  verb: 'send',
  summary: 'Send a reply to no-reply@accounts.google.com',
  preview: [{ label: 'To', value: 'no-reply@accounts.google.com' }, { label: 'Subject', value: 'Re: Security alert' }],
  ts: 0,
}

console.log('  — THE REPORTED FAILURE: "send it" must confirm a pending send —')
for (const m of [
  'send it', 'send', 'Send it.', 'send that', 'send it now', 'please send it', 'send the email',
  'yes', 'yep', 'ok', 'okay', 'go ahead', 'do it', 'confirm', 'ship it', 'looks good', 'sounds good',
]) {
  check(JSON.stringify(m), isConfirmationOf(m, sendMail) === true)
}

console.log('  — a confirmation must NOT be read into anything ambiguous —')
for (const m of [
  // Negations — the expensive direction.
  "don't send it", 'do not send it', 'no', 'no, cancel that', 'wait', 'hold off', 'never mind',
  'actually don\'t', 'cancel', 'stop',
  // Questions about the proposal, not approval of it.
  'send it?', 'should i send it?', 'does that look right?',
  // Instructions that START with the verb but change what would be sent. Running the reviewed
  // args for any of these sends the wrong thing to the wrong person.
  'send it to my accountant and cc legal',
  'send it but change the subject line first',
  'send a different reply saying i already fixed it',
  // A new request entirely.
  'now summarize my calendar for tomorrow',
  'make it shorter',
  'rewrite it more formally',
]) {
  check(JSON.stringify(m), isConfirmationOf(m, sendMail) === false, 'FALSE ACCEPT — this would send')
}

console.log('  — cancellation drops the proposal, an unrecognised message does not —')
{
  for (const m of ["don't send it", 'no', 'cancel', 'never mind', 'hold off']) {
    check(`cancels: ${JSON.stringify(m)}`, isCancellationOf(m, sendMail) === true)
  }
  for (const m of ['send it', 'yes', 'what did it say again?', 'who is it from?']) {
    check(`does not cancel: ${JSON.stringify(m)}`, isCancellationOf(m, sendMail) === false)
  }
}

console.log('  — the verb comes from the ACTION, not from a phrase list —')
{
  const createEvent: ProposedAction = { ...sendMail, tool: 'calendar_create', verb: 'create', effect: 'write' }
  check('"create it" confirms a create', isConfirmationOf('create it', createEvent) === true)
  check('"send it" does NOT confirm a create', isConfirmationOf('send it', createEvent) === false,
    'a send phrasing must not approve an unrelated action')
  check('a bare "yes" still confirms any action', isConfirmationOf('yes', createEvent) === true)
}

console.log('  — lifecycle: one proposal, one execution —')
{
  const conv = 'conv-1'
  clearProposal(conv)
  const t0 = 1_000_000
  proposeAction(conv, sendMail, t0)
  check('a proposal can be read back', peekProposal(conv, t0)?.tool === 'gmail_send')
  check('peeking does not consume it', peekProposal(conv, t0)?.tool === 'gmail_send')
  check('taking it returns it', takeProposal(conv, t0)?.tool === 'gmail_send')
  check('a second take returns nothing — no double send',
    takeProposal(conv, t0) === null, 'a repeated confirmation would send a second copy')
}

console.log('  — lifecycle: expiry —')
{
  const conv = 'conv-2'
  clearProposal(conv)
  const t0 = 1_000_000
  proposeAction(conv, sendMail, t0)
  check('live inside the window', peekProposal(conv, t0 + PROPOSAL_TTL_MS - 1) !== null)
  check('gone outside the window', peekProposal(conv, t0 + PROPOSAL_TTL_MS + 1) === null,
    'a stale yes must not send')
  proposeAction(conv, sendMail, t0)
  check('an expired proposal is not resurrected by a later peek',
    peekProposal(conv, t0 + PROPOSAL_TTL_MS + 1) === null || peekProposal(conv, t0) === null)
}

console.log('  — conversations do not leak into each other —')
{
  clearProposal('a'); clearProposal('b')
  proposeAction('a', sendMail, 1000)
  check('a proposal in one conversation is invisible in another', peekProposal('b', 1000) === null)
  check('and an empty conversation id is never stored', (proposeAction('', sendMail, 1000), peekProposal('', 1000) === null))
}

console.log('  — the review block states what will happen and that nothing has —')
{
  const r = renderProposal(sendMail)
  check('names the recipient', r.includes('no-reply@accounts.google.com'), r)
  check('says nothing has been sent yet', /nothing has been sent/i.test(r), r)
  check('tells the user how to confirm', /send it/i.test(r), r)
}

console.log(`\nTOTAL: ${pass}/${pass + fail}`)
if (fail) process.exit(1)

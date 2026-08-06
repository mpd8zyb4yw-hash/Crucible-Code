// Bench for the universal agentic surface (cont.118).
//
// DOCTRINE.md asks one question before any feature ships: "where is the deterministic verifier,
// and what is the ground truth?" For a UI layer that question usually has no answer, which is why
// interfaces rot. It has one here, because `deriveView` is a PURE FUNCTION and the affordance
// registry is DATA — both can be asserted against fixtures with no browser, no network and no
// authenticated session.
//
// What this bench pins, in order of how badly it would hurt to get wrong:
//
//   1. SAFETY — no action that sends or destroys can ever reach the UI unconfirmed, and every
//      affordance names a tool that actually exists in the registry. A phantom action is a dead
//      button; an unconfirmed `send` is an email the user did not write.
//   2. UNIVERSALITY — the whole claim of this design is that a NEW provider gets a real interface
//      for free. The test is literal: invent a provider that has never been seen, emit entities
//      of an existing kind, and assert a full interface comes out with working actions.
//   3. TOTALITY — `deriveView` must produce a renderable spec for EVERY input, including the
//      empty array, mixed kinds, missing ids and malformed timestamps. A renderer with no
//      fallback branch is only safe if the derivation genuinely cannot produce garbage.
//   4. LOSSLESSNESS — cont.105b's "your inbox is empty" happened because structure was thrown
//      away and the model paraphrased prose. Assert that every fixture entity survives with its
//      id and title intact, and that EMPTY IS RENDERED AS A FACT rather than left to the model.
//
// Run: npx tsx src/CrucibleEngine/tools/__surface_bench.ts

import { registry } from './registry'
import {
  entity, bindAffordances, affordancesFor, resolveAction, fieldValue,
  type Entity, type EntityKind,
} from './entities'
import { deriveView, viewToText } from './viewDerivation'
import {
  gmailMessages, calendarEvents, driveFiles, contacts, youtubeVideos, webResults, localFiles,
  parseAddress, friendlyMime,
} from './adapters'

let pass = 0, fail = 0
const failures: string[] = []
function check(label: string, ok: boolean, detail = '') {
  if (ok) { pass++; return }
  fail++
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

const ALL_KINDS: EntityKind[] = [
  'message', 'event', 'file', 'contact', 'place', 'route', 'media', 'webpage', 'task', 'record',
]

// ── Fixtures — real provider response shapes, captured not invented ──────────

const GMAIL_RAW = [
  {
    id: '18f2a1b3c4d5e6f7', threadId: 't1', snippet: 'Hi — attaching the Q3 numbers as promised.',
    labelIds: ['INBOX', 'UNREAD'],
    payload: { headers: [
      { name: 'From', value: 'Ada Lovelace <ada@example.com>' },
      { name: 'Subject', value: 'Q3 numbers' },
      { name: 'Date', value: 'Mon, 27 Jul 2026 09:14:00 +0100' },
    ] },
  },
  {
    id: '28f2a1b3c4d5e6f8', threadId: 't2', snippet: 'Can we move tomorrow to 3pm?',
    labelIds: ['INBOX'],
    payload: { headers: [
      { name: 'From', value: 'bob@example.com' },
      { name: 'Subject', value: 'Re: standup' },
      { name: 'Date', value: 'Mon, 27 Jul 2026 08:02:00 +0100' },
    ] },
  },
]

const CALENDAR_RAW = [
  {
    id: 'evt1', summary: 'Design review', location: 'Room 4', status: 'confirmed',
    start: { dateTime: '2026-07-27T14:00:00+01:00' }, end: { dateTime: '2026-07-27T15:00:00+01:00' },
    htmlLink: 'https://calendar.google.com/event?eid=evt1',
    attendees: [{ email: 'ada@example.com', displayName: 'Ada' }],
  },
  {
    id: 'evt2', summary: 'Offsite', start: { date: '2026-07-28' }, end: { date: '2026-07-29' },
    htmlLink: 'https://calendar.google.com/event?eid=evt2',
  },
]

const DRIVE_RAW = [
  { id: 'f1', name: 'Q3 report.docx', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-07-20T10:00:00Z', webViewLink: 'https://docs.google.com/d/f1', size: '20480' },
  { id: 'f2', name: 'budget.xlsx', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-07-21T10:00:00Z', webViewLink: 'https://docs.google.com/d/f2', size: '51200' },
  { id: 'f3', name: 'logo.png', mimeType: 'image/png', modifiedTime: '2026-07-22T10:00:00Z', webViewLink: 'https://docs.google.com/d/f3', size: '8192' },
  { id: 'f4', name: 'notes.txt', mimeType: 'text/plain', modifiedTime: '2026-07-23T10:00:00Z', webViewLink: 'https://docs.google.com/d/f4', size: '1024' },
]

const CONTACTS_RAW = [
  { person: { resourceName: 'people/c1', names: [{ displayName: 'Ada Lovelace' }], emailAddresses: [{ value: 'ada@example.com' }], phoneNumbers: [{ value: '+44 20 1234 5678' }] } },
]

// ── 1. SAFETY ────────────────────────────────────────────────────────────────
console.log('\n== safety: no phantom tools, no unconfirmed side effects ==')

const registeredTools = new Set(registry.list().map(t => t.name))
check('registry is populated', registeredTools.size > 10, `only ${registeredTools.size} tools`)

for (const kind of ALL_KINDS) {
  for (const a of affordancesFor(kind)) {
    check(`${kind}.${a.id} → tool "${a.tool}" exists`, registeredTools.has(a.tool),
      'PHANTOM ACTION: renders a button that cannot possibly work')
    check(`${kind}.${a.id} declares an effect`, ['read', 'write', 'send', 'destructive'].includes(a.effect))
  }
}

// The load-bearing safety property, asserted over EVERY entity the fixtures can produce rather
// than over a hand-picked example.
const everyEntity: Entity[] = [
  ...gmailMessages(GMAIL_RAW), ...calendarEvents(CALENDAR_RAW), ...driveFiles(DRIVE_RAW),
  ...contacts(CONTACTS_RAW), ...youtubeVideos([{ id: { videoId: 'v1' }, snippet: { title: 'T', channelTitle: 'C', publishedAt: '2026-01-01T00:00:00Z', description: 'd' } }]),
  ...webResults([{ title: 'W', url: 'https://example.com/a', snippet: 's' }]),
  ...localFiles([{ name: 'a.ts', path: '/tmp/a.ts', size: 10, mtime: '2026-01-01T00:00:00Z' }]),
]
for (const e of everyEntity) {
  for (const b of bindAffordances(e)) {
    check(`${e.kind}.${b.id} confirmation matches effect`,
      b.requiresConfirmation === (b.effect !== 'read'),
      `effect=${b.effect} requiresConfirmation=${b.requiresConfirmation} — a send that does not confirm is an email the user did not write`)
    check(`${e.kind}.${b.id} read-actions are pre-bound or need input`,
      b.args !== null || (b.inputs?.length ?? 0) > 0,
      'action has neither arguments nor inputs — it could never be invoked')
  }
}

// A `send` affordance must NEVER produce executable args without user input.
const msg = gmailMessages(GMAIL_RAW)[0]
const reply = bindAffordances(msg).find(a => a.id === 'reply')
check('reply exists on a message', !!reply)
check('reply is classed as send', reply?.effect === 'send')
check('reply requires confirmation', reply?.requiresConfirmation === true)
check('reply has NO pre-bound args', reply?.args === null,
  'a reply with pre-bound args could be fired by one stray click')
check('reply cannot resolve without a body', resolveAction(msg, 'reply', { to: 'x@y.z', subject: 's' }) === null,
  'resolveAction produced a sendable email with no body')
const resolvedReply = resolveAction(msg, 'reply', { to: 'x@y.z', subject: 's', body: 'hello' })
check('reply resolves once the user supplies a body', resolvedReply?.tool === 'gmail_send')
check('…and is still marked send', resolvedReply?.effect === 'send')
check('unknown affordance id resolves to null', resolveAction(msg, 'nonexistent') === null)

// ── 2. UNIVERSALITY — the actual claim under test ────────────────────────────
console.log('\n== universality: an unknown provider gets a real interface for free ==')

// A provider that does not exist and that no code in this repo has ever heard of.
const fictionalProvider: Entity[] = [
  entity({
    id: 'fastmail-1', kind: 'message', source: 'fastmail_search',
    title: 'Invoice #221', subtitle: 'billing@acme.test',
    body: 'Your invoice is attached.', at: '2026-07-26T11:00:00Z',
    fields: [
      { key: 'from', label: 'From', value: 'billing@acme.test', role: 'person' },
      { key: 'date', label: 'Received', value: '2026-07-26T11:00:00Z', role: 'timestamp' },
    ],
  }),
  entity({
    id: 'fastmail-2', kind: 'message', source: 'fastmail_search',
    title: 'Welcome', subtitle: 'hello@acme.test', at: '2026-07-25T11:00:00Z',
    fields: [{ key: 'from', label: 'From', value: 'hello@acme.test', role: 'person' }],
  }),
]
const fictionalView = deriveView(fictionalProvider, { query: 'invoice' })
check('unknown provider yields a real layout', fictionalView.layout === 'list',
  `got ${fictionalView.layout}`)
check('unknown provider entities all render', fictionalView.entities.length === 2)
check('unknown provider inherits kind affordances',
  (fictionalView.actions['fastmail-1']?.length ?? 0) > 0,
  'a new provider got NO actions — the universality claim is false')
check('unknown provider inherits the SEND affordance with confirmation',
  fictionalView.actions['fastmail-1']?.some(a => a.effect === 'send' && a.requiresConfirmation) === true)
// It must NOT inherit the Gmail-only action, because that affordance declines on a foreign source.
check('provider-specific action correctly declines for a foreign source',
  !fictionalView.actions['fastmail-1']?.some(a => a.tool === 'gmail_read'),
  'gmail_read was offered on a non-Gmail message — bind() is not checking source')

// Every kind must survive derivation, including ones no adapter emits yet.
for (const kind of ALL_KINDS) {
  const es = [1, 2, 3].map(n => entity({
    id: `${kind}-${n}`, kind, source: 'synthetic',
    title: `${kind} ${n}`, at: `2026-07-2${n}T10:00:00Z`,
    fields: [{ key: 'a', label: 'A', value: `v${n}`, role: 'label' }],
  }))
  const v = deriveView(es)
  check(`kind "${kind}" derives a renderable layout`,
    ['list', 'agenda', 'table', 'grid', 'map', 'detail'].includes(v.layout), `got ${v.layout}`)
  check(`kind "${kind}" keeps all entities`, v.entities.length === 3)
}

// ── 3. LAYOUT DERIVATION — each branch, with the data shape that should pick it ──
console.log('\n== layout is derived from data shape, deterministically ==')

check('0 entities → empty', deriveView([]).layout === 'empty')
check('1 entity → detail', deriveView(gmailMessages([GMAIL_RAW[0]])).layout === 'detail')
check('messages → list', deriveView(gmailMessages(GMAIL_RAW)).layout === 'list')
check('events with times → agenda', deriveView(calendarEvents(CALENDAR_RAW)).layout === 'agenda')
check('4 uniform files → table', deriveView(driveFiles(DRIVE_RAW)).layout === 'table',
  `got ${deriveView(driveFiles(DRIVE_RAW)).layout}`)
check('media → grid', deriveView([
  entity({ id: 'm1', kind: 'media', source: 's', title: 'a' }),
  entity({ id: 'm2', kind: 'media', source: 's', title: 'b' }),
]).layout === 'grid')
check('places → map', deriveView([
  entity({ id: 'p1', kind: 'place', source: 's', title: 'a' }),
  entity({ id: 'p2', kind: 'place', source: 's', title: 'b' }),
]).layout === 'map')

const tableView = deriveView(driveFiles(DRIVE_RAW))
check('table derives ≥3 columns', (tableView.columns?.length ?? 0) >= 3,
  `got ${tableView.columns?.length}`)
// The identity column. `title` is on the envelope rather than in `fields`, so a purely
// field-derived table came out with Type/Modified/Size and NO FILENAME. A table whose rows
// cannot be told apart is not a table.
check('table always leads with the title column',
  tableView.columns?.[0]?.key === '__title',
  `first column was ${tableView.columns?.[0]?.key} — rows would be unidentifiable`)
check('table never columns the body', !tableView.columns?.some(c => c.role === 'body'))
check('table never columns an id', !tableView.columns?.some(c => c.role === 'id'))
check('table respects the column cap', (tableView.columns?.length ?? 0) <= 5)
// Every derived column must be resolvable for at least one row, or it renders as dead space.
for (const c of tableView.columns ?? []) {
  const resolvable = c.key === '__title'
    ? tableView.entities.every(e => !!e.title)
    : tableView.entities.some(e => e.fields.some(f => f.key === c.key))
  check(`column "${c.key}" resolves against the rows`, resolvable)
}

const agenda = deriveView(calendarEvents(CALENDAR_RAW))
check('agenda groups by day', (agenda.groups?.length ?? 0) >= 2, `got ${agenda.groups?.length} groups`)
check('agenda groups reference real entity ids',
  agenda.groups!.every(g => g.entityIds.every(id => agenda.entities.some(e => e.id === id))))
check('agenda is chronological',
  agenda.entities[0].at! <= agenda.entities[1].at!)

// Determinism — the same input must always produce the same interface.
const a1 = JSON.stringify(deriveView(driveFiles(DRIVE_RAW)))
const a2 = JSON.stringify(deriveView(driveFiles(DRIVE_RAW)))
check('deriveView is deterministic', a1 === a2)

// Mixed kinds must stay legible rather than becoming an undifferentiated pile.
const mixed = deriveView([...gmailMessages(GMAIL_RAW), ...driveFiles(DRIVE_RAW.slice(0, 2))])
check('mixed kinds → list', mixed.layout === 'list')
check('mixed kinds are grouped by kind', (mixed.groups?.length ?? 0) === 2, `got ${mixed.groups?.length}`)

// ── 4. TOTALITY — every hostile input still produces a renderable spec ────────
console.log('\n== derivation is total ==')

const HOSTILE: Array<[string, Entity[]]> = [
  ['empty', []],
  ['entity with no fields', [entity({ id: 'x', kind: 'record', source: 's', title: 't' })]],
  ['entity with empty title', [entity({ id: 'x', kind: 'record', source: 's', title: '' })]],
  ['unparseable timestamp', [
    entity({ id: 'a', kind: 'event', source: 's', title: 'a', at: 'not-a-date' }),
    entity({ id: 'b', kind: 'event', source: 's', title: 'b', at: '2026-07-27T10:00:00Z' }),
  ]],
  ['duplicate ids', [
    entity({ id: 'dup', kind: 'record', source: 's', title: 'one' }),
    entity({ id: 'dup', kind: 'record', source: 's', title: 'two' }),
  ]],
  ['unicode + rtl', [entity({ id: 'u', kind: 'record', source: 's', title: '📊 مرحبا 日本語' })]],
  ['very long title', [entity({ id: 'l', kind: 'record', source: 's', title: 'x'.repeat(10_000) })]],
  ['200 entities', Array.from({ length: 200 }, (_, i) =>
    entity({ id: `e${i}`, kind: 'file', source: 's', title: `f${i}`, fields: [
      { key: 'a', label: 'A', value: i, role: 'quantity' },
      { key: 'b', label: 'B', value: 'x', role: 'label' },
      { key: 'c', label: 'C', value: 'y', role: 'status' },
    ] }))],
]
for (const [label, es] of HOSTILE) {
  let ok = false, detail = ''
  try {
    const v = deriveView(es, { query: 'q' })
    ok = !!v && typeof v.layout === 'string' && Array.isArray(v.entities) && !!v.actions
      && typeof viewToText(v) === 'string'
    if (!ok) detail = JSON.stringify(v).slice(0, 120)
  } catch (e: any) { detail = `threw: ${e?.message}` }
  check(`derives from ${label}`, ok, detail)
}

// Adapters must survive garbage from a provider without taking the process down.
console.log('\n== adapters are total ==')
const ADAPTER_GARBAGE: Array<[string, () => Entity[]]> = [
  ['gmail: empty', () => gmailMessages([])],
  ['gmail: nulls', () => gmailMessages([null, undefined] as any)],
  ['gmail: no payload', () => gmailMessages([{ id: 'x' }])],
  ['calendar: empty start', () => calendarEvents([{ id: 'e', summary: 's' }])],
  ['drive: missing fields', () => driveFiles([{ id: 'f' }])],
  ['contacts: no names', () => contacts([{ person: {} }])],
  ['youtube: bare id', () => youtubeVideos([{ id: 'v', snippet: {} }])],
  ['web: missing url', () => webResults([{ title: 'x' } as any])],
  ['localFiles: dir', () => localFiles([{ name: 'd', path: '/d', isDir: true }])],
]
for (const [label, fn] of ADAPTER_GARBAGE) {
  let ok = false, detail = ''
  try {
    const es = fn()
    ok = Array.isArray(es) && es.every(e => typeof e.id === 'string' && typeof e.title === 'string' && Array.isArray(e.fields))
    if (!ok) detail = JSON.stringify(es).slice(0, 140)
  } catch (e: any) { detail = `threw: ${e?.message}` }
  check(`adapter survives ${label}`, ok, detail)
}

// ── 5. LOSSLESSNESS — the cont.105b class ────────────────────────────────────
console.log('\n== structure survives; emptiness is a FACT, not prose ==')

const inbox = gmailMessages(GMAIL_RAW)
check('every message survives adaptation', inbox.length === GMAIL_RAW.length,
  `${GMAIL_RAW.length} in, ${inbox.length} out — this is exactly the cont.105b inbox collapse`)
check('sender name is extracted, not the raw header',
  inbox[0].subtitle === 'Ada Lovelace', `got ${inbox[0].subtitle}`)
check('sender address is available for a reply',
  fieldValue(inbox[0], 'from') === 'ada@example.com')
check('bare address degrades to itself', parseAddress('bob@example.com').email === 'bob@example.com')
check('unread status is captured', fieldValue(inbox[0], 'status') === 'Unread')
check('read status is captured', fieldValue(inbox[1], 'status') === 'Read')
check('rfc2822 date becomes ISO', inbox[0].at?.startsWith('2026-07-27T08:14') === true, `got ${inbox[0].at}`)

const text = viewToText(deriveView(inbox))
for (const m of GMAIL_RAW) {
  check(`model-visible text keeps id ${m.id.slice(0, 6)}…`, text.includes(m.id),
    'the model cannot refer to a specific message it cannot see the id of')
}
check('model-visible text keeps every subject',
  text.includes('Q3 numbers') && text.includes('Re: standup'))

const emptyView = deriveView([], { query: 'from:nobody' })
check('empty view is layout=empty', emptyView.layout === 'empty')
check('empty view states what was searched', emptyView.notice?.includes('from:nobody') === true,
  `notice was: ${emptyView.notice}`)
check('empty view carries no phantom actions', Object.keys(emptyView.actions).length === 0)
check('empty view text is the notice, not an invitation to the model to invent one',
  viewToText(emptyView) === emptyView.notice)
const failedView = deriveView([], { emptyReason: 'Gmail is not connected.' })
check('an unavailable source reads differently from a genuine zero',
  failedView.notice === 'Gmail is not connected.',
  'the user cannot tell "nothing matched" from "I never looked" — the cont.104 failure')

// ── 6. ADAPTER DETAIL ────────────────────────────────────────────────────────
console.log('\n== adapter correctness ==')
check('friendlyMime: google doc', friendlyMime('application/vnd.google-apps.document') === 'Document')
check('friendlyMime: image', friendlyMime('image/png') === 'PNG')
check('friendlyMime: empty', friendlyMime('') === '')
check('parseAddress: quoted name', parseAddress('"Lovelace, Ada" <ada@x.com>').name === 'Lovelace, Ada')
check('parseAddress: angle only', parseAddress('<ada@x.com>').email === 'ada@x.com')

const events = calendarEvents(CALENDAR_RAW)
check('all-day event keeps its date', events[1].at === '2026-07-28')
check('all-day event is flagged in raw', events[1].raw?.allDay === true)
check('timed event keeps its datetime', events[0].at === '2026-07-27T14:00:00+01:00')
check('confirmed status is suppressed as noise', !events[0].fields.some(f => f.key === 'status'))
check('attendees are flattened to names', fieldValue(events[0], 'attendees') === 'Ada')
check('empty fields are dropped at construction',
  events[1].fields.every(f => f.value !== '' && f.value !== null),
  'an empty field would become a blank table column')

// ── REPORT ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(64)}`)
console.log(`surface bench: ${pass}/${pass + fail} passed`)
if (failures.length) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log(`  ✗ ${f}`)
}
process.exit(fail === 0 ? 0 : 1)

import { entity, bindAffordances, resolveAction, affordancesFor, fieldValue, type Entity } from './entities'
import { deriveView, viewToText } from './viewDerivation'
import { contacts, directions, webResults, calendarEvents, youtubeVideos } from './adapters'

const show = (l: string, v: unknown) => console.log(`\n### ${l}\n` + JSON.stringify(v, null, 1))

// ── A. non-Gmail message provider ──────────────────────────────────────────────
const slackDm = entity({
  id: 'C123-1700000000.001', kind: 'message', source: 'slack_search',
  title: 'can you review the PR?', subtitle: 'justin',
  url: 'https://acme.slack.com/archives/C123/p1700000000001',
  at: '2026-07-27T18:00:00Z',
  fields: [{ key: 'from', label: 'From', value: 'U01JUSTIN', role: 'person' }],
})
show('A. slack DM affordances', bindAffordances(slackDm))
show('A. resolveAction reply on a Slack DM', resolveAction(slackDm, 'reply', { to: 'U01JUSTIN', subject: 'Re: x', body: 'sure' }))

// A2: message with NO from at all
const noFrom = entity({ id: 'm9', kind: 'message', source: 'imap_search', title: 'Hi', fields: [] })
show('A2. message with no sender still offers', bindAffordances(noFrom).map(a => `${a.id}->${a.tool}`))

// ── G. task / record / route with a url ────────────────────────────────────────
const linear = entity({
  id: 'LIN-1', kind: 'task', source: 'linear_search', title: 'Fix login',
  url: 'https://linear.app/acme/issue/LIN-1',
  fields: [{ key: 'status', label: 'Status', value: 'In Progress', role: 'status' }],
})
show('G. task affordances', bindAffordances(linear))
show('G. affordance counts', Object.fromEntries((['message','event','file','contact','place','route','media','webpage','task','record'] as const).map(k => [k, affordancesFor(k as any).map(a => a.id)])))

// ── B. duplicate ids across two search providers ───────────────────────────────
const merged = [
  ...webResults([{ title: 'Google result', url: 'https://example.com/a', snippet: 'g' }], 'web_search'),
  ...webResults([{ title: 'Brave result', url: 'https://example.com/a', snippet: 'b' }], 'brave_search'),
  ...webResults([{ title: 'Other', url: 'https://example.com/b', snippet: 'o' }], 'brave_search'),
]
const mv = deriveView(merged)
console.log('\n### B. merged web results')
console.log('entities:', mv.entities.length, 'action keys:', Object.keys(mv.actions).length)
console.log('groups:', JSON.stringify(mv.groups))
console.log('layout:', mv.layout)

// B2: mixed-kind grouping with a duplicate id -> renderer byId last-wins
const dup = deriveView([
  entity({ id: 'x1', kind: 'file', source: 'dropbox_search', title: 'A.pdf', url: 'https://dbx/A' }),
  entity({ id: 'x1', kind: 'message', source: 'gmail_search', title: 'B mail' }),
  entity({ id: 'x2', kind: 'file', source: 'dropbox_search', title: 'C.pdf' }),
])
console.log('\n### B2. mixed dup id')
console.log('groups:', JSON.stringify(dup.groups))
console.log('actions[x1]:', JSON.stringify(dup.actions['x1']?.map(a => a.id)))

// ── C. day bucketing timezone ──────────────────────────────────────────────────
process.env.TZ = 'America/Los_Angeles'
const evs = calendarEvents([
  { id: 'e1', summary: 'Dinner', start: { dateTime: '2026-07-27T20:00:00-07:00' }, end: { dateTime: '2026-07-27T22:00:00-07:00' } },
  { id: 'e2', summary: 'Breakfast', start: { dateTime: '2026-07-27T08:00:00-07:00' }, end: { dateTime: '2026-07-27T09:00:00-07:00' } },
])
const av = deriveView(evs)
console.log('\n### C. agenda day grouping (TZ=' + Intl.DateTimeFormat().resolvedOptions().timeZone + ')')
console.log(JSON.stringify(av.groups, null, 1))

// ── I. agenda group order vs sorted entities ───────────────────────────────────
const unordered = calendarEvents([
  { id: 'b', summary: 'Late', start: { dateTime: '2026-08-01T17:00:00Z' }, end: {} },
  { id: 'a', summary: 'Early', start: { dateTime: '2026-08-01T09:00:00Z' }, end: {} },
  { id: 'c', summary: 'Mid', start: { dateTime: '2026-08-01T12:00:00Z' }, end: {} },
])
const uv = deriveView(unordered)
console.log('\n### I. agenda order')
console.log('entities order:', uv.entities.map(e => e.title))
console.log('group order   :', JSON.stringify(uv.groups))

// ── D. viewToText loses fields ─────────────────────────────────────────────────
const routes = directions([
  { summary: 'I-5', legs: [{ duration: { text: '5 hours 42 mins' }, distance: { text: '382 mi' }, start_address: 'SF', end_address: 'LA' }] },
  { summary: 'US-101', legs: [{ duration: { text: '7 hours 10 mins' }, distance: { text: '412 mi' }, start_address: 'SF', end_address: 'LA' }] },
], 'San Francisco', 'Los Angeles')
console.log('\n### D. viewToText for routes\n' + viewToText(deriveView(routes)))
const cs = contacts([{ person: { resourceName: 'people/c1', names: [{ displayName: 'Ada Lovelace' }], emailAddresses: [{ value: 'ada@w.org' }, { value: 'ada@home.net' }], phoneNumbers: [{ value: '+44 20 1234 5678' }] } }])
console.log('\n### D2. viewToText for contacts\n' + viewToText(deriveView(cs)))

// ── E/F. contact affordances ───────────────────────────────────────────────────
show('E/F. contact bound affordances', bindAffordances(cs[0]))
show('F. mail_history args', resolveAction(cs[0], 'mail_history'))
show('F. email args', resolveAction(cs[0], 'email', { subject: 'hi', body: 'hello' }))

// ── youtube non-video ids ──────────────────────────────────────────────────────
const yt = youtubeVideos([
  { id: { kind: 'youtube#channel', channelId: 'UC1' }, snippet: { title: 'Chan A' } },
  { id: { kind: 'youtube#playlist', playlistId: 'PL1' }, snippet: { title: 'List B' } },
])
console.log('\n### youtube non-video ids:', JSON.stringify(yt.map(e => ({ id: e.id, url: e.url }))))

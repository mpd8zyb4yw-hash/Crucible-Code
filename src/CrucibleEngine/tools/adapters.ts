// Provider adapters — the ONLY place provider-specific knowledge lives.
//
// Each function here is pure: provider JSON in, `Entity[]` out. Nothing downstream — not the view
// derivation, not the affordance registry, not the renderer — knows that Gmail exists. That is
// what makes the surface universal: adding a mail provider means writing ONE function in this
// file, and it inherits the list layout, the reply action, the detail pane and the agenda
// grouping without touching any of them.
//
// The alternative, which is what the codebase did before cont.118, is to flatten provider JSON
// into prose inside each tool and then RE-PARSE that prose per provider in the renderer
// (`renderPersonalData`'s `renderGmail`/`renderCalendar`). That covered 2 tools out of 44 and
// could never cover the rest — parsing a string back into the object you already had is not a
// general operation. These adapters are the same work done once, in the right direction.
//
// Being pure functions, they are also directly testable against captured fixtures without a
// network or an authenticated session — which is what `__surface_bench.ts` does.

import { entity, type Entity } from './entities'

// ── Gmail ─────────────────────────────────────────────────────────────────────

/** Pull a header value out of Gmail's `payload.headers` array. */
function header(msg: any, name: string): string {
  const headers: any[] = msg?.payload?.headers ?? []
  return headers.find((h: any) => h?.name?.toLowerCase() === name.toLowerCase())?.value ?? ''
}

/** "Ada Lovelace <ada@example.com>" → { name, email }. Falls back to the raw string. */
export function parseAddress(raw: string): { name: string; email: string } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim() }
  const bare = raw.trim()
  return { name: bare, email: bare.includes('@') ? bare : '' }
}

/** RFC-2822 date → ISO, or undefined when unparseable. Never throws. */
function toIso(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const t = Date.parse(raw)
  return Number.isNaN(t) ? undefined : new Date(t).toISOString()
}

export function gmailMessages(messages: any[]): Entity[] {
  return (messages ?? []).filter(Boolean).map(msg => {
    const from = parseAddress(header(msg, 'From'))
    const id = String(msg?.id ?? '')
    const labels: string[] = msg?.labelIds ?? []
    return entity({
      id,
      kind: 'message',
      source: 'gmail_search',
      title: header(msg, 'Subject') || '(no subject)',
      subtitle: from.name,
      body: msg?.snippet ?? '',
      at: toIso(header(msg, 'Date')),
      url: id ? `https://mail.google.com/mail/u/0/#inbox/${id}` : null,
      fields: [
        { key: 'from', label: 'From', value: from.email || from.name, role: 'person' },
        { key: 'date', label: 'Received', value: toIso(header(msg, 'Date')) ?? '', role: 'timestamp' },
        // Unread is the single most useful status on a message and it is free — it is already in
        // the label array the list call returns.
        { key: 'status', label: 'Status', value: labels.includes('UNREAD') ? 'Unread' : 'Read', role: 'status' },
      ],
      raw: { threadId: msg?.threadId, labelIds: labels },
    })
  })
}

// ── Google Calendar ───────────────────────────────────────────────────────────

export function calendarEvents(items: any[]): Entity[] {
  return (items ?? []).filter(Boolean).map(e => {
    // All-day events carry `date`; timed events carry `dateTime`. Both are legitimate.
    const start = e?.start?.dateTime ?? e?.start?.date ?? null
    const end = e?.end?.dateTime ?? e?.end?.date ?? null
    const attendees: any[] = e?.attendees ?? []
    return entity({
      id: String(e?.id ?? ''),
      kind: 'event',
      source: 'calendar_list',
      title: e?.summary ?? '(no title)',
      subtitle: e?.location ?? undefined,
      body: e?.description ?? '',
      at: start,
      until: end,
      url: e?.htmlLink ?? null,
      fields: [
        { key: 'start', label: 'Starts', value: start ?? '', role: 'timestamp' },
        { key: 'end', label: 'Ends', value: end ?? '', role: 'timestamp' },
        { key: 'location', label: 'Location', value: e?.location ?? '', role: 'location' },
        {
          key: 'attendees', label: 'Attendees',
          value: attendees.map(a => a?.displayName ?? a?.email).filter(Boolean).join(', '),
          role: 'person',
        },
        { key: 'status', label: 'Status', value: e?.status === 'confirmed' ? '' : (e?.status ?? ''), role: 'status' },
      ],
      raw: { allDay: !e?.start?.dateTime, organizer: e?.organizer?.email },
    })
  })
}

// ── Google Drive ──────────────────────────────────────────────────────────────

/** "application/vnd.google-apps.spreadsheet" → "Spreadsheet"; "image/png" → "PNG". */
export function friendlyMime(mime: string): string {
  if (!mime) return ''
  const g = mime.match(/vnd\.google-apps\.(\w+)/)
  if (g) return g[1].charAt(0).toUpperCase() + g[1].slice(1)
  const sub = mime.split('/')[1] ?? mime
  return sub.replace(/^x-/, '').toUpperCase()
}

function humanSize(bytes: unknown): string {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export function driveFiles(files: any[]): Entity[] {
  return (files ?? []).filter(Boolean).map(f => entity({
    id: String(f?.id ?? ''),
    kind: 'file',
    source: 'drive_search',
    title: f?.name ?? '(unnamed)',
    subtitle: friendlyMime(f?.mimeType ?? ''),
    at: f?.modifiedTime ?? null,
    url: f?.webViewLink ?? null,
    fields: [
      { key: 'type', label: 'Type', value: friendlyMime(f?.mimeType ?? ''), role: 'label' },
      { key: 'modified', label: 'Modified', value: f?.modifiedTime ?? '', role: 'timestamp' },
      { key: 'size', label: 'Size', value: humanSize(f?.size), role: 'size' },
    ],
    raw: { mimeType: f?.mimeType },
  }))
}

// ── Google People ─────────────────────────────────────────────────────────────

export function contacts(results: any[]): Entity[] {
  return (results ?? []).map(r => r?.person ?? r).filter(Boolean).map((p: any) => {
    const emails: string[] = (p?.emailAddresses ?? []).map((e: any) => e?.value).filter(Boolean)
    const phones: string[] = (p?.phoneNumbers ?? []).map((e: any) => e?.value).filter(Boolean)
    const name = p?.names?.[0]?.displayName ?? emails[0] ?? 'Unknown'
    return entity({
      // resourceName ("people/c123") is the stable key; fall back to the primary email so an
      // entity always has an id an affordance can bind to.
      id: String(p?.resourceName ?? emails[0] ?? name),
      kind: 'contact',
      source: 'contacts_search',
      title: name,
      subtitle: emails[0],
      fields: [
        { key: 'email', label: 'Email', value: emails.join(', '), role: 'person' },
        { key: 'phone', label: 'Phone', value: phones.join(', '), role: 'label' },
        { key: 'org', label: 'Organisation', value: p?.organizations?.[0]?.name ?? '', role: 'label' },
      ],
    })
  })
}

// ── YouTube ───────────────────────────────────────────────────────────────────

export function youtubeVideos(items: any[]): Entity[] {
  return (items ?? []).filter(Boolean).map(v => {
    const id = v?.id?.videoId ?? v?.id ?? ''
    const sn = v?.snippet ?? {}
    return entity({
      id: String(id),
      kind: 'media',
      source: 'youtube_search_api',
      title: sn?.title ?? '(untitled)',
      subtitle: sn?.channelTitle ?? undefined,
      body: sn?.description ?? '',
      at: sn?.publishedAt ?? null,
      url: id ? `https://www.youtube.com/watch?v=${id}` : null,
      fields: [
        { key: 'channel', label: 'Channel', value: sn?.channelTitle ?? '', role: 'person' },
        { key: 'published', label: 'Published', value: sn?.publishedAt ?? '', role: 'timestamp' },
        { key: 'thumbnail', label: 'Thumbnail', value: sn?.thumbnails?.medium?.url ?? '', role: 'url' },
      ],
    })
  })
}

// ── Web search ────────────────────────────────────────────────────────────────

export function webResults(results: Array<{ title?: string; url?: string; snippet?: string }>, source = 'web_search'): Entity[] {
  return (results ?? []).filter(r => r?.url).map((r, i) => entity({
    id: r.url!,
    kind: 'webpage',
    source,
    title: r.title || r.url!,
    subtitle: hostOf(r.url!),
    body: r.snippet ?? '',
    url: r.url,
    fields: [
      { key: 'site', label: 'Site', value: hostOf(r.url!), role: 'label' },
      { key: 'rank', label: 'Rank', value: i + 1, role: 'quantity' },
    ],
  }))
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

// ── Local filesystem ──────────────────────────────────────────────────────────

export function localFiles(
  entries: Array<{ name: string; path: string; isDir?: boolean; size?: number; mtime?: string }>,
): Entity[] {
  return (entries ?? []).filter(e => e?.path).map(e => entity({
    id: e.path,
    kind: 'file',
    source: 'list_dir',
    title: e.name,
    subtitle: e.isDir ? 'Folder' : extOf(e.name),
    at: e.mtime ?? null,
    fields: [
      { key: 'path', label: 'Path', value: e.path, role: 'label' },
      { key: 'type', label: 'Type', value: e.isDir ? 'Folder' : extOf(e.name), role: 'label' },
      { key: 'size', label: 'Size', value: e.isDir ? '' : humanSize(e.size), role: 'size' },
      { key: 'modified', label: 'Modified', value: e.mtime ?? '', role: 'timestamp' },
    ],
    // `read_local` binds on any entity with a path, so a DIRECTORY must say so or it would
    // offer "Read file" on a folder.
    raw: { isDir: !!e.isDir },
  }))
}

function extOf(name: string): string {
  const m = name.match(/\.([a-z0-9]+)$/i)
  return m ? m[1].toUpperCase() : 'File'
}

// ── Maps ──────────────────────────────────────────────────────────────────────

export function directions(routes: any[], origin: string, destination: string): Entity[] {
  return (routes ?? []).filter(Boolean).map((r, i) => {
    const leg = r?.legs?.[0] ?? {}
    return entity({
      id: `route-${i}`,
      kind: 'route',
      source: 'maps_directions',
      title: r?.summary ? `via ${r.summary}` : `Route ${i + 1}`,
      subtitle: `${origin} → ${destination}`,
      fields: [
        { key: 'duration', label: 'Duration', value: leg?.duration?.text ?? '', role: 'duration' },
        { key: 'distance', label: 'Distance', value: leg?.distance?.text ?? '', role: 'quantity' },
        { key: 'start', label: 'From', value: leg?.start_address ?? origin, role: 'location' },
        { key: 'end', label: 'To', value: leg?.end_address ?? destination, role: 'location' },
      ],
      raw: { steps: (leg?.steps ?? []).length },
    })
  })
}

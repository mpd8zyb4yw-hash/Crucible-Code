// Verified Tier-1B primitive: MIME type lookup by file extension.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible — MIME type lookup by file extension.
const MIME_MAP: Record<string, string> = {
  html: 'text/html', htm: 'text/html', css: 'text/css',
  js: 'application/javascript', mjs: 'application/javascript', cjs: 'application/javascript',
  ts: 'application/typescript', tsx: 'application/typescript', jsx: 'application/javascript',
  json: 'application/json', jsonl: 'application/jsonl',
  xml: 'application/xml', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm', ogg: 'audio/ogg',
  wav: 'audio/wav', mpeg: 'video/mpeg',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
  tar: 'application/x-tar', br: 'application/x-brotli',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
  yaml: 'application/yaml', yml: 'application/yaml',
  toml: 'application/toml', wasm: 'application/wasm',
}

export function getMimeType(fileOrExt: string): string {
  const ext = fileOrExt.includes('.') ? fileOrExt.split('.').pop()!.toLowerCase() : fileOrExt.toLowerCase()
  return MIME_MAP[ext] ?? 'application/octet-stream'
}

export function getExtension(mime: string): string | null {
  const entry = Object.entries(MIME_MAP).find(([, v]) => v === mime.split(';')[0].trim())
  return entry ? entry[0] : null
}

export function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/javascript' || mime === 'application/xml'
}
`

const SUITE = `
import { getMimeType, getExtension, isTextMime } from './src/module'
const ok = (b: boolean, msg: string) => { if (!b) { console.error('FAIL', msg); process.exit(1) } }
ok(getMimeType('index.html') === 'text/html', 'html')
ok(getMimeType('app.js') === 'application/javascript', 'js')
ok(getMimeType('data.json') === 'application/json', 'json')
ok(getMimeType('photo.png') === 'image/png', 'png')
ok(getMimeType('video.mp4') === 'video/mp4', 'mp4')
ok(getMimeType('unknown.xyz') === 'application/octet-stream', 'unknown')
ok(getMimeType('css') === 'text/css', 'bare extension')
ok(getExtension('image/png') === 'png', 'reverse lookup')
ok(isTextMime('text/html'), 'text is text')
ok(isTextMime('application/json'), 'json is text')
ok(!isTextMime('image/png'), 'image is not text')
console.log('ALL PASS')
`

registerSkill({
  id: 'mimeType',
  summary: 'MIME type lookup by file extension: getMimeType, getExtension, isTextMime.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bmime.?type\b|\bgetMimeType\b/i)) sc += 0.8
    if (s.has(/\bcontentType\b|content.?type.*extension|extension.*content.?type/i)) sc += 0.5
    if (s.has(/file.*extension.*mime|mime.*extension/i)) sc += 0.5
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/module.ts', content: IMPL }]
  },
  suite: SUITE,
})

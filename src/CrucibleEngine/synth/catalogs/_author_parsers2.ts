import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url'
const HERE = path.dirname(fileURLToPath(import.meta.url))

const entries = [
  {
    id: 'parse-semver-parts', filename: 'parseSemverParts',
    summary: 'parseSemverParts splits a semver string and compareSemver compares two versions returning -1, 0, or 1.',
    defaultPath: 'src/parseSemverParts.ts', exports: ['parseSemverParts', 'compareSemver'],
    patterns: [{ re: '\\bparseSemverParts\\b|\\bcompareSemver\\b', weight: 0.6 }, { re: 'semver.*parse|parse.*semantic.*version', weight: 0.3 }],
    impl: `export function parseSemverParts(v) {
  const m = v.replace(/^v/,'').match(/^(\\d+)\\.(\\d+)\\.(\\d+)(?:-([\\w.]+))?$/)
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], prerelease: m[4] ?? '' }
}
export function compareSemver(a, b) {
  const pa = parseSemverParts(a), pb = parseSemverParts(b)
  if (!pa || !pb) throw new Error('invalid semver')
  for (const k of ['major','minor','patch']) {
    if (pa[k] < pb[k]) return -1
    if (pa[k] > pb[k]) return 1
  }
  if (!pa.prerelease && pb.prerelease) return 1
  if (pa.prerelease && !pb.prerelease) return -1
  return pa.prerelease < pb.prerelease ? -1 : pa.prerelease > pb.prerelease ? 1 : 0
}`,
    tests: [
      { desc: 'parse basic', call: 'parseSemverParts("1.2.3")', want: '{"major":1,"minor":2,"patch":3,"prerelease":""}' },
      { desc: 'parse with v prefix', call: 'parseSemverParts("v2.0.0")', want: '{"major":2,"minor":0,"patch":0,"prerelease":""}' },
      { desc: 'parse pre', call: 'parseSemverParts("1.0.0-beta.1")', want: '{"major":1,"minor":0,"patch":0,"prerelease":"beta.1"}' },
      { desc: 'parse invalid', call: 'parseSemverParts("1.2")', want: 'null' },
      { desc: 'compare equal', call: 'compareSemver("1.2.3","1.2.3")', want: '0' },
      { desc: 'compare higher minor', call: 'compareSemver("1.3.0","1.2.0")', want: '1' },
      { desc: 'compare lower patch', call: 'compareSemver("1.0.0","1.0.1")', want: '-1' },
      { desc: 'pre is lower', call: 'compareSemver("1.0.0-alpha","1.0.0")', want: '-1' },
    ],
  },
  {
    id: 'glob-match', filename: 'globMatch',
    summary: 'globMatch checks if a string matches a glob pattern where * matches within a segment and ? matches one character.',
    defaultPath: 'src/globMatch.ts', exports: ['globMatch'],
    patterns: [{ re: '\\bglobMatch\\b', weight: 0.6 }, { re: 'glob.*pattern|wildcard.*match', weight: 0.3 }],
    impl: `export function globMatch(glob, str) {
  const re = glob.replace(/[.+^${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\*/g,'.*').replace(/\\?/g,'.')
  return new RegExp('^' + re + '$').test(str)
}`,
    tests: [
      { desc: 'star wildcard', call: 'globMatch("*.ts","foo.ts")', want: 'true' },
      { desc: 'no match', call: 'globMatch("*.ts","foo.js")', want: 'false' },
      { desc: 'question mark', call: 'globMatch("?.ts","a.ts")', want: 'true' },
      { desc: 'question wrong', call: 'globMatch("?.ts","ab.ts")', want: 'false' },
      { desc: 'exact', call: 'globMatch("hello","hello")', want: 'true' },
      { desc: 'star all', call: 'globMatch("*","anything.txt")', want: 'true' },
    ],
  },
  {
    id: 'parse-range-spec', filename: 'parseRangeSpec',
    summary: 'parseRangeSpec expands a range specification like "1-3,5,7-8" into a sorted array of numbers.',
    defaultPath: 'src/parseRangeSpec.ts', exports: ['parseRangeSpec'],
    patterns: [{ re: '\\bparseRangeSpec\\b', weight: 0.6 }, { re: 'range.*specification|expand.*range|range.*1-3', weight: 0.3 }],
    impl: `export function parseRangeSpec(spec) {
  const out = new Set()
  for (const part of spec.split(',').map(s=>s.trim()).filter(Boolean)) {
    const dash = part.indexOf('-')
    if (dash > 0) {
      const lo = parseInt(part.slice(0,dash)), hi = parseInt(part.slice(dash+1))
      if (!isNaN(lo) && !isNaN(hi)) for (let i = lo; i <= hi; i++) out.add(i)
    } else { const n = parseInt(part); if (!isNaN(n)) out.add(n) }
  }
  return [...out].sort((a,b)=>a-b)
}`,
    tests: [
      { desc: 'basic range', call: 'parseRangeSpec("1-3")', want: '[1,2,3]' },
      { desc: 'mixed', call: 'parseRangeSpec("1-3,5,7-8")', want: '[1,2,3,5,7,8]' },
      { desc: 'single', call: 'parseRangeSpec("5")', want: '[5]' },
      { desc: 'dedup', call: 'parseRangeSpec("1-3,2-4")', want: '[1,2,3,4]' },
      { desc: 'spaces ignored', call: 'parseRangeSpec("1 - 3 , 5")', want: '[5]' },
      { desc: 'empty', call: 'parseRangeSpec("")', want: '[]' },
    ],
  },
  {
    id: 'strip-ansi-codes', filename: 'stripAnsiCodes',
    summary: 'stripAnsiCodes removes ANSI escape color/style codes from a string.',
    defaultPath: 'src/stripAnsiCodes.ts', exports: ['stripAnsiCodes'],
    patterns: [{ re: '\\bstripAnsiCodes\\b', weight: 0.6 }, { re: 'strip.*ansi|remove.*ansi|ansi.*escape', weight: 0.3 }],
    impl: `export function stripAnsiCodes(s) {
  return s.replace(/\\x1B\\[[0-9;]*[mGKHF]/g, '').replace(/\\x1B\\[[0-9;]*[A-Z]/g,'')
}`,
    tests: [
      { desc: 'red color', call: 'stripAnsiCodes("\\x1B[31mhello\\x1B[0m")', want: '"hello"' },
      { desc: 'bold', call: 'stripAnsiCodes("\\x1B[1mtext\\x1B[0m")', want: '"text"' },
      { desc: 'no codes', call: 'stripAnsiCodes("plain")', want: '"plain"' },
      { desc: 'empty', call: 'stripAnsiCodes("")', want: '""' },
      { desc: 'preserves content', call: 'stripAnsiCodes("\\x1B[32mgreen\\x1B[0m text")', want: '"green text"' },
    ],
  },
  {
    id: 'parse-accept-header', filename: 'parseAcceptHeader',
    summary: 'parseAcceptHeader parses an HTTP Accept header and returns media types sorted by q-value descending.',
    defaultPath: 'src/parseAcceptHeader.ts', exports: ['parseAcceptHeader'],
    patterns: [{ re: '\\bparseAcceptHeader\\b', weight: 0.6 }, { re: 'accept.*header|http.*accept.*parse', weight: 0.3 }],
    impl: `export function parseAcceptHeader(h) {
  return h.split(',').map(s => {
    const [type, ...params] = s.trim().split(';').map(x=>x.trim())
    const qp = params.find(p=>p.startsWith('q='))
    const q = qp ? parseFloat(qp.slice(2)) : 1
    return { type, q }
  }).sort((a,b)=>b.q-a.q || 0).map(x=>x.type)
}`,
    tests: [
      { desc: 'simple', call: 'parseAcceptHeader("text/html")', want: '["text/html"]' },
      { desc: 'by q-value', call: 'parseAcceptHeader("text/html;q=0.9,application/json")', want: '["application/json","text/html"]' },
      { desc: 'multiple types', call: 'parseAcceptHeader("*/*;q=0.1,text/html;q=0.9,application/json").length', want: '3' },
    ],
  },
  {
    id: 'parse-data-uri', filename: 'parseDataUri',
    summary: 'parseDataUri parses a data: URI into its MIME type, base64 flag, and data string; returns null for malformed input.',
    defaultPath: 'src/parseDataUri.ts', exports: ['parseDataUri'],
    patterns: [{ re: '\\bparseDataUri\\b', weight: 0.6 }, { re: 'data.*uri.*parse|data:.*parse', weight: 0.3 }],
    impl: `export function parseDataUri(uri) {
  const m = uri.match(/^data:([^;,]+)?(?:;(base64))?,(.*)$/)
  if (!m) return null
  return { mime: m[1] ?? 'text/plain', isBase64: m[2] === 'base64', data: m[3] }
}`,
    tests: [
      { desc: 'base64 png', call: 'parseDataUri("data:image/png;base64,abc123")', want: '{"mime":"image/png","isBase64":true,"data":"abc123"}' },
      { desc: 'text plain', call: 'parseDataUri("data:text/plain,hello")', want: '{"mime":"text/plain","isBase64":false,"data":"hello"}' },
      { desc: 'invalid', call: 'parseDataUri("notadata:uri")', want: 'null' },
      { desc: 'no mime defaults', call: 'parseDataUri("data:,hello")', want: '{"mime":"text/plain","isBase64":false,"data":"hello"}' },
    ],
  },
  {
    id: 'parse-cron-fields', filename: 'parseCronFields',
    summary: 'parseCronFields splits a 5-field cron expression into named fields; returns null if not exactly 5 space-separated fields.',
    defaultPath: 'src/parseCronFields.ts', exports: ['parseCronFields'],
    patterns: [{ re: '\\bparseCronFields\\b', weight: 0.6 }, { re: 'cron.*expression.*parse|parse.*cron', weight: 0.3 }],
    impl: `export function parseCronFields(expr) {
  const parts = expr.trim().split(/\\s+/)
  if (parts.length !== 5) return null
  const [minute,hour,dayOfMonth,month,dayOfWeek] = parts
  return { minute, hour, dayOfMonth, month, dayOfWeek }
}`,
    tests: [
      { desc: 'basic', call: 'parseCronFields("0 * * * *")', want: '{"minute":"0","hour":"*","dayOfMonth":"*","month":"*","dayOfWeek":"*"}' },
      { desc: 'complex', call: 'parseCronFields("*/5 8-18 * * 1-5")', want: '{"minute":"*/5","hour":"8-18","dayOfMonth":"*","month":"*","dayOfWeek":"1-5"}' },
      { desc: 'wrong count', call: 'parseCronFields("* * * *")', want: 'null' },
      { desc: 'six fields', call: 'parseCronFields("0 0 * * * *")', want: 'null' },
    ],
  },
  {
    id: 'parse-query-params', filename: 'parseQueryParams',
    summary: 'parseQueryParams parses a URL query string (optional leading ?) into a Record of URL-decoded key-value pairs.',
    defaultPath: 'src/parseQueryParams.ts', exports: ['parseQueryParams'],
    patterns: [{ re: '\\bparseQueryParams\\b', weight: 0.6 }, { re: 'query.*string.*parse|parse.*url.*query', weight: 0.3 }],
    impl: `export function parseQueryParams(qs) {
  const out = {}
  const clean = qs.startsWith('?') ? qs.slice(1) : qs
  if (!clean) return out
  for (const part of clean.split('&')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = decodeURIComponent(part.slice(0,eq)), v = decodeURIComponent(part.slice(eq+1))
    out[k] = v
  }
  return out
}`,
    tests: [
      { desc: 'basic', call: 'parseQueryParams("a=1&b=2")', want: '{"a":"1","b":"2"}' },
      { desc: 'with question mark', call: 'parseQueryParams("?x=hello")', want: '{"x":"hello"}' },
      { desc: 'encoded', call: 'parseQueryParams("q=hello%20world")', want: '{"q":"hello world"}' },
      { desc: 'empty', call: 'parseQueryParams("")', want: '{}' },
      { desc: 'last wins on repeat', call: 'parseQueryParams("a=1&a=2")', want: '{"a":"2"}' },
    ],
  },
]

const out = path.join(HERE, 'parsersB.json')
fs.writeFileSync(out, JSON.stringify(entries, null, 2))
console.log(`wrote ${entries.length} -> ${out}`)

// DONE-WHEN: an agent can find files by name and read a web page without mutating
// anything, and web_search hands back URLs that are actually actionable.
// Deterministic: real fs against a temp project, real HTTP against a local server.
// No external network, no model calls.
// Run: npx tsx src/CrucibleEngine/tools/test-research.ts
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { registry, globToRegExp, htmlToText, resolveDdgHref } from './registry'

let failures = 0
const check = (label: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${cond ? '' : ' :: ' + detail}`)
  if (!cond) failures++
}
const m = (pat: string, p: string) => globToRegExp(pat).test(p)

// ── globToRegExp ────────────────────────────────────────────────────────────
check('* stays within one segment', m('src/*.ts', 'src/a.ts') && !m('src/*.ts', 'src/x/a.ts'))
check('** crosses directories', m('src/**/*.ts', 'src/x/y/a.ts'))
check('**/ also matches zero directories', m('src/**/*.ts', 'src/a.ts'))
check('? matches exactly one char', m('a?.ts', 'ab.ts') && !m('a?.ts', 'abc.ts'))
check('{a,b} alternation works', m('**/*.{ts,tsx}', 'src/a.tsx') && !m('**/*.{ts,tsx}', 'src/a.js'))
check('pattern is anchored end to end', !m('*.ts', 'a.ts.bak'))
check('dots are literal, not regex wildcards', !m('a.ts', 'axts'))
check('regex metachars in a pattern cannot inject', !m('a+.ts', 'aaa.ts') && m('a+.ts', 'a+.ts'))
check('an unclosed brace degrades instead of throwing', globToRegExp('a{b.ts') instanceof RegExp)
check('backslash paths are normalized', m('src/*.ts', 'src\\a.ts'.replace(/\\/g, '/')))

// ── htmlToText ──────────────────────────────────────────────────────────────
{
  const t = htmlToText('<html><head><title>x</title><style>body{color:red}</style></head>' +
    '<body><script>alert(1)</script><h1>Title</h1><p>Hello &amp; welcome</p>' +
    '<p>Second&nbsp;line</p></body></html>')
  check('script/style content is dropped', !t.includes('alert') && !t.includes('color:red'), t)
  check('readable text survives', t.includes('Title') && t.includes('Hello & welcome'), t)
  check('block tags become line breaks', /Title\s*\n/.test(t), JSON.stringify(t))
  check('entities are decoded', t.includes('Second line'), JSON.stringify(t))
  check('no runs of blank lines', !/\n\n\n/.test(t), JSON.stringify(t))
}

// ── resolveDdgHref: the fix for "web_search returned no URLs" ────────────────
check('DDG redirector unwraps to the real target',
  resolveDdgHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc') === 'https://example.com/docs',
  String(resolveDdgHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc')))
check('a plain absolute href passes through', resolveDdgHref('https://example.com/a') === 'https://example.com/a')
check('DDG-internal links are rejected', resolveDdgHref('//duckduckgo.com/y.js?ad=1') === null)
check('junk href yields null, never a throw', resolveDdgHref('') === null && resolveDdgHref('javascript:alert(1)') === null)

// ── glob tool, against a real temp project ──────────────────────────────────
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crucible-glob-'))
  const write = (rel: string) => {
    const abs = path.join(work, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, 'x')
    return abs
  }
  write('src/a.ts'); write('src/deep/b.ts'); write('src/deep/c.test.ts')
  write('README.md'); write('node_modules/pkg/index.ts'); write('.github/workflows/ci.yml')

  // read-only context — this is the case that previously had no answer at all
  const ctx = { projectPath: work, allowMutation: false }
  const call = (args: Record<string, unknown>) => registry.exec({ id: 'g', name: 'glob', args }, ctx as any)

  const all = await call({ pattern: '**/*.ts' })
  check('glob runs in a read-only context', all.ok, all.output)
  const lines = all.output.split('\n').filter(Boolean)
  check('finds files at any depth', lines.includes('src/a.ts') && lines.includes('src/deep/b.ts'), all.output)
  check('node_modules is excluded', !all.output.includes('node_modules'), all.output)
  check('hidden dirs excluded by default', !(await call({ pattern: '**/*.yml' })).output.includes('.github'))
  check('a dot-segment pattern opts into hidden dirs',
    (await call({ pattern: '.github/**/*.yml' })).output.includes('ci.yml'),
    (await call({ pattern: '.github/**/*.yml' })).output)

  const tests = await call({ pattern: '**/*.test.ts' })
  check('narrow patterns do not over-match', tests.output.trim() === 'src/deep/c.test.ts', tests.output)

  const none = await call({ pattern: '**/*.rs' })
  check('no matches is a success with an honest message', none.ok && none.output.includes('no files match'), none.output)
  check('no matches reports count 0', (none.meta as any)?.count === 0)

  const capped = await call({ pattern: '**/*', maxResults: 2 })
  check('maxResults is honored and flagged truncated',
    capped.output.split('\n').filter(Boolean).length === 2 && capped.truncated === true, capped.output)

  const bad = await call({ pattern: '' })
  check('empty pattern fails cleanly', !bad.ok && bad.output.includes('non-empty'), bad.output)

  const missing = await call({ pattern: '**/*.ts', dir: path.join(work, 'nope') })
  check('missing dir fails cleanly', !missing.ok && missing.output.includes('not found'), missing.output)

  check('glob did not write anything', !fs.existsSync(path.join(work, '.crucible')))
  fs.rmSync(work, { recursive: true, force: true })
}

// ── fetch_url, against a real local server ──────────────────────────────────
{
  const server = http.createServer((req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body><script>junk()</script><h1>Docs</h1><p>Body &amp; text</p></body></html>')
    } else if (req.url === '/data') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    } else if (req.url === '/slow') {
      setTimeout(() => { res.writeHead(200); res.end('late') }, 60_000)
    } else {
      res.writeHead(404, { 'content-type': 'text/html' })
      res.end('<p>nope</p>')
    }
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  const ctx = { projectPath: os.tmpdir(), allowMutation: false }
  const call = (args: Record<string, unknown>) => registry.exec({ id: 'f', name: 'fetch_url', args }, ctx as any)

  const page = await call({ url: `${base}/page` })
  check('fetch_url runs in a read-only context', page.ok, page.output)
  check('HTML is reduced to readable text', page.output.includes('Docs') && page.output.includes('Body & text'), page.output)
  check('scripts are stripped from fetched HTML', !page.output.includes('junk()'), page.output)

  const json = await call({ url: `${base}/data` })
  check('non-HTML bodies are returned verbatim', json.output.trim() === '{"ok":true}', json.output)

  const notFound = await call({ url: `${base}/missing` })
  check('an HTTP error is reported as a failure, not silent success',
    !notFound.ok && notFound.output.includes('404'), notFound.output)

  const capped = await call({ url: `${base}/page`, maxChars: 5 })
  check('maxChars is honored and flagged truncated', capped.output.length === 5 && capped.truncated === true, capped.output)

  const badUrl = await call({ url: 'not-a-url' })
  check('a non-http url is rejected before any request', !badUrl.ok, badUrl.output)

  // Cancellation must abort in-flight, not hang the agent turn.
  const ac = new AbortController()
  const pending = registry.exec({ id: 'f2', name: 'fetch_url', args: { url: `${base}/slow` } },
    { projectPath: os.tmpdir(), allowMutation: false, signal: ac.signal } as any)
  ac.abort()
  const cancelled = await pending
  check('an in-flight fetch honors cancellation', !cancelled.ok && /Fetch failed/.test(cancelled.output), cancelled.output)

  await new Promise<void>(r => server.close(() => r()))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

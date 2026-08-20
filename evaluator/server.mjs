#!/usr/bin/env node
/**
 * THE EVALUATOR BRIDGE — a small authenticated HTTP surface over one browser.
 *
 * It exists so an external agent can use Crucible the way a person does:
 * every operation here ends in a real event inside a real rendered page against
 * the deployed application. Nothing routes around React, and nothing calls a
 * server action directly, because the failures worth finding live precisely in
 * the gap those shortcuts skip over.
 *
 * It is development-only and deliberately disposable: one directory, one token,
 * no production code touched. Delete evaluator/ and nothing else changes.
 *
 *   EVAL_TOKEN=…  node evaluator/server.mjs [--target https://crucible.cam]
 */
import http from 'node:http'
import { Evaluator } from './browser.mjs'
import { handle as remote, capability } from './remote.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : fallback
}

const PORT = Number(arg('port', process.env.EVAL_PORT || 8899))
const TARGET = arg('target', process.env.EVAL_TARGET || 'https://crucible.cam')
const TOKEN = process.env.EVAL_TOKEN
const HEADLESS = arg('headed', null) === null

if (!TOKEN || TOKEN.length < 24) {
  console.error('EVAL_TOKEN missing or too short. Refusing to expose a browser without one.')
  process.exit(1)
}

const evaluator = new Evaluator({ target: TARGET, headless: HEADLESS })

/**
 * ONE OPERATION AT A TIME.
 *
 * There is a single browser behind this, and two overlapping taps would produce
 * results neither caller could interpret. Requests queue instead of racing.
 */
let chain = Promise.resolve()
const serial = (fn) => (chain = chain.then(fn, fn))

const json = (res, code, body) => {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}

const readBody = (req) =>
  new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}) } catch { resolve({}) } })
  })

/** Constant-time-ish compare, so the token cannot be probed a byte at a time. */
const authed = (req) => {
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (got.length !== TOKEN.length) return false
  let diff = 0
  for (let i = 0; i < TOKEN.length; i++) diff |= got.charCodeAt(i) ^ TOKEN.charCodeAt(i)
  return diff === 0
}

const OPERATIONS = {
  'GET  /status': 'is the bridge and browser alive, what is it pointed at, is Crucible signed in',
  'POST /cold_start': 'destroy client storage and launch fresh — {keepSession?:true}',
  'GET  /observe': 'compact view: url, surface, visible text, controls, errors',
  'GET  /screenshot': 'PNG of what the user would see — ?fullPage=1',
  'POST /tap': '{target} — resolve by attribute/name/text, dispatch a real tap',
  'POST /type': '{target?, text, submit?} — real keystrokes',
  'POST /press': '{key} — e.g. Enter, Escape, ArrowRight',
  'POST /swipe': '{direction: left|right|up|down} — pages the Home deck',
  'POST /back': 'browser back',
  'POST /reload': 'normal reload, storage preserved',
  'POST /open': '{url} — navigate within the target origin',
  'POST /wait': '{ms} — settle, up to 30s',
  'GET  /visible_elements': 'controls only, no page text',
  'GET  /console_errors': 'console errors this session',
  'GET  /network_failures': 'failed and 4xx/5xx requests this session',
  'GET  /current_url': 'current url and surface',
  'GET  /inspect': 'runtime: build version, signed-in, loading, blocked writes, external attempts',
  'POST /probe_write': 'prove the read-only guard: makes the page attempt POST /api/act, expects 403',
  'POST /restart': 'tear the browser down and relaunch',
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const route = `${req.method} ${url.pathname}`

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' })
    return res.end()
  }
  /*
    THE CAPABILITY ROUTE IS CHECKED FIRST AND CARRIES ITS OWN CREDENTIAL.

    ChatGPT's fetcher cannot attach a header, so this one route authenticates by
    unguessable path instead. It reaches the SAME evaluator instance — the
    read-only guard lives in the browser layer, not in the bearer check, so this
    is a second door onto the same protected object rather than a way around it.
    A wrong or absent capability is indistinguishable from a route that does not
    exist.
  */
  if (url.pathname.startsWith('/remote/')) {
    try {
      if (await serial(() => remote(req, res, url, evaluator))) return
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
      return res.end(`error: ${e?.message ?? e}`)
    }
    res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' })
    return res.end('Not found')
  }

  if (!authed(req)) return json(res, 401, { error: 'Bearer token required.' })

  const body = req.method === 'POST' ? await readBody(req) : {}

  try {
    switch (route) {
      case 'GET /status':
        return json(res, 200, await serial(async () => ({
          ok: true,
          target: TARGET,
          browser: evaluator.page && !evaluator.page.isClosed() ? 'running' : 'not started',
          signedIn: await evaluator.signedIn(),
          writeMode: 'read-only (external writes refused)',
          uptimeSec: evaluator.startedAt ? Math.round((Date.now() - evaluator.startedAt) / 1000) : 0,
          operations: Object.keys(OPERATIONS),
        })))

      case 'GET /operations':
        return json(res, 200, OPERATIONS)

      case 'POST /cold_start':
        return json(res, 200, await serial(() => evaluator.coldStart({ keepSession: body.keepSession !== false })))

      case 'GET /observe':
        return json(res, 200, await serial(() => evaluator.observe()))

      case 'GET /screenshot': {
        const png = await serial(() => evaluator.screenshot({ fullPage: url.searchParams.get('fullPage') === '1' }))
        if (url.searchParams.get('base64') === '1') return json(res, 200, { png: png.toString('base64') })
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'no-store' })
        return res.end(png)
      }

      case 'POST /tap':
        return json(res, 200, await serial(async () => ({ ...(await evaluator.tap(String(body.target ?? ''))), after: await evaluator.observe() })))

      case 'POST /type':
        return json(res, 200, await serial(async () => ({
          ...(await evaluator.type(body.target ? String(body.target) : null, String(body.text ?? ''), { submit: body.submit === true })),
          after: await evaluator.observe(),
        })))

      case 'POST /press':
        return json(res, 200, await serial(async () => ({ ...(await evaluator.press(String(body.key ?? 'Enter'))), after: await evaluator.observe() })))

      case 'POST /swipe':
        return json(res, 200, await serial(async () => ({ ...(await evaluator.swipe(String(body.direction ?? 'left'))), after: await evaluator.observe() })))

      case 'POST /back':
        return json(res, 200, await serial(() => evaluator.back()))

      case 'POST /reload':
        return json(res, 200, await serial(() => evaluator.reload()))

      case 'POST /open': {
        const want = String(body.url ?? '')
        const full = want.startsWith('http') ? want : `${TARGET}${want.startsWith('/') ? '' : '/'}${want}`
        // Scoped to the target origin: this is an evaluator for Crucible, not
        // an open proxy that happens to be on the internet.
        if (!full.startsWith(TARGET)) return json(res, 400, { error: `Only ${TARGET} is in scope.` })
        return json(res, 200, await serial(() => evaluator.goto(full)))
      }

      case 'POST /wait':
        return json(res, 200, await serial(async () => {
          await evaluator.settle(Math.min(Number(body.ms) || 1000, 30_000))
          return evaluator.observe()
        }))

      case 'GET /visible_elements':
        return json(res, 200, await serial(async () => {
          const o = await evaluator.observe({ maxText: 0 })
          return { url: o.url, surface: o.surface, deck: o.deck, controls: o.controls }
        }))

      case 'GET /console_errors':
        return json(res, 200, { consoleErrors: evaluator.consoleErrors })

      case 'GET /network_failures':
        return json(res, 200, { networkFailures: evaluator.networkFailures })

      case 'GET /current_url':
        return json(res, 200, await serial(async () => ({
          url: evaluator.page?.url() ?? null,
          surface: (await evaluator.observe({ maxText: 0, maxControls: 0 })).surface,
        })))

      case 'GET /inspect':
        return json(res, 200, await serial(async () => {
          const o = await evaluator.observe({ maxText: 0, maxControls: 0 })
          return {
            url: o.url,
            surface: o.surface,
            deck: o.deck,
            loading: o.loading,
            build: await evaluator.version(),
            signedIn: await evaluator.signedIn(),
            consoleErrors: evaluator.consoleErrors.slice(-10),
            networkFailures: evaluator.networkFailures.slice(-10),
            apiCalls: evaluator.apiCalls.slice(-40),
            blockedWrites: evaluator.blockedWrites,
            externalAttempts: evaluator.externalAttempts,
          }
        }))

      /*
        PROVE THE READ-ONLY GUARD, DON'T ASSERT IT.

        The claim "external writes are refused" is worth nothing unless
        something actually tries one. This makes the attempt from inside the
        page — the app's own origin, its own cookies, the exact path a send or
        a calendar create would take — and reports what came back. It creates
        nothing even if the guard were removed, because the body carries no
        action kind, but it does exercise the rule.
      */
      case 'POST /probe_write':
        return json(res, 200, await serial(async () => {
          await evaluator.ensure()
          if (!evaluator.page.url().startsWith(TARGET)) await evaluator.goto(TARGET)
          const before = evaluator.blockedWrites.length
          const status = await evaluator.page.evaluate(async () => {
            const r = await fetch('/api/act', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ kind: '', params: {} }),
            })
            return r.status
          })
          return { status, recorded: evaluator.blockedWrites.length - before, guard: 'read-only' }
        }))

      case 'POST /restart':
        return json(res, 200, await serial(async () => {
          await evaluator.close()
          await evaluator.launch()
          return evaluator.goto(TARGET)
        }))

      default:
        return json(res, 404, { error: `No such operation: ${route}`, operations: Object.keys(OPERATIONS) })
    }
  } catch (e) {
    return json(res, 500, { error: String(e?.message ?? e) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`evaluator listening on 127.0.0.1:${PORT} → ${TARGET}`)
  // The capability is printed once, locally, so it can be handed over; it is
  // never written to a request log.
  console.log(`capability path ready (evaluator/.capability, ${capability().length * 4} bits)`)
})

/**
 * THE MCP FAÇADE — the existing evaluator, callable as tools.
 *
 * ChatGPT can attach a connector but cannot make arbitrary authenticated HTTP
 * calls, so this Worker speaks MCP (JSON-RPC over streamable HTTP) on the
 * outside and the evaluator's ordinary bearer API on the inside. It is an
 * ADAPTER: it holds no browser, knows nothing about Crucible, and every tool
 * below is one forwarded request to https://eval.crucible.cam. The read-only
 * guard, the target scoping and the serialisation all stay where they already
 * are — in the evaluator — which is why nothing here can widen them.
 *
 * TWO SEPARATE CREDENTIALS, DELIBERATELY.
 *   MCP_SECRET   the outside door: an unguessable path segment, because a
 *                connector cannot send a header. Rotate by re-putting it.
 *   EVAL_TOKEN   the inside door: the evaluator's bearer token, held only as a
 *                Worker secret and never echoed back to a caller.
 *
 * There is no shell, no exec and no free-form URL: `TOOLS` is the entire
 * surface, and anything not in it is a JSON-RPC "unknown tool".
 */
const ORIGIN = 'https://eval.crucible.cam'
const PROTOCOL_VERSION = '2025-06-18'

const S = (d) => ({ type: 'string', ...d })

/**
 * One entry per operation. `path`/`method` are the evaluator's own; `args` is
 * the JSON Schema ChatGPT sees; `body` builds the evaluator payload from the
 * validated args. Nothing is templated from caller input into a path.
 */
const TOOLS = {
  observe: {
    description: 'What the user would see right now: url, surface, open app, visible text, controls, errors.',
    method: 'GET', path: '/observe', args: {},
  },
  screenshot: {
    description: 'PNG of the current Crucible screen, as an image.',
    method: 'GET', path: '/screenshot?base64=1', image: true,
    args: { fullPage: { type: 'boolean', description: 'Capture the whole scrollable page instead of the viewport.' } },
    query: (a) => (a.fullPage ? '&fullPage=1' : ''),
  },
  tap: {
    description: 'Tap a control. Target is a control name, visible text, an app attribute (calendar, mail, composer, composer-send, surface-close) or a raw CSS selector.',
    method: 'POST', path: '/tap',
    args: { target: S({ description: 'Control to tap.' }) }, required: ['target'],
    body: (a) => ({ target: a.target }),
  },
  type: {
    description: 'Type real keystrokes into a field, optionally submitting.',
    method: 'POST', path: '/type',
    args: {
      target: S({ description: 'Field to type into; omit to type into whatever has focus.' }),
      text: S({ description: 'Text to type.' }),
      submit: { type: 'boolean', description: 'Press Enter afterwards.' },
    },
    required: ['text'],
    body: (a) => ({ target: a.target ?? null, text: a.text, submit: a.submit === true }),
  },
  press: {
    description: 'Press a single key, e.g. Enter, Escape, ArrowRight.',
    method: 'POST', path: '/press',
    args: { key: S({ description: 'Key name.' }) }, required: ['key'],
    body: (a) => ({ key: a.key }),
  },
  swipe: {
    description: 'Swipe, which pages the Home deck.',
    method: 'POST', path: '/swipe',
    args: { direction: S({ enum: ['left', 'right', 'up', 'down'] }) }, required: ['direction'],
    body: (a) => ({ direction: a.direction }),
  },
  back: { description: 'In-app back; refuses to leave Crucible.', method: 'POST', path: '/back', args: {}, body: () => ({}) },
  reload: { description: 'Reload the page, keeping client storage.', method: 'POST', path: '/reload', args: {}, body: () => ({}) },
  cold_start: {
    description: 'Destroy client storage and start fresh; the signed-in account session is kept by default.',
    method: 'POST', path: '/cold_start',
    args: { keepSession: { type: 'boolean', description: 'Keep the Google session (default true).' } },
    body: (a) => ({ keepSession: a.keepSession !== false }),
  },
  wait: {
    description: 'Let the app settle, then observe.',
    method: 'POST', path: '/wait',
    args: { ms: { type: 'number', description: 'Milliseconds, up to 30000. Default 5000.' } },
    body: (a) => ({ ms: Math.min(Number(a.ms) || 5000, 30_000) }),
  },
  inspect: { description: 'Runtime detail: build, signed-in, loading, API calls with status and latency, blocked writes, external attempts.', method: 'GET', path: '/inspect', args: {} },
  visible_elements: { description: 'The controls on screen, without page text.', method: 'GET', path: '/visible_elements', args: {} },
  console_errors: { description: 'Console errors seen this session.', method: 'GET', path: '/console_errors', args: {} },
  network_failures: { description: 'Failed and 4xx/5xx requests seen this session.', method: 'GET', path: '/network_failures', args: {} },
  current_url: { description: 'Current url and surface.', method: 'GET', path: '/current_url', args: {} },
  probe_write: {
    description: 'Prove the read-only guard: makes the page attempt POST /api/act and reports the refusal. Expects 403.',
    method: 'POST', path: '/probe_write', args: {}, body: () => ({}),
  },
}

const listed = () =>
  Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: { type: 'object', properties: t.args, required: t.required ?? [], additionalProperties: false },
  }))

/** Constant-time on the outside door, so the secret is not probeable byte by byte. */
const holds = (given, want) => {
  if (typeof given !== 'string' || typeof want !== 'string' || given.length !== want.length) return false
  let diff = 0
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i)
  return diff === 0
}

const rpc = (id, result) => ({ jsonrpc: '2.0', id, result })
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

async function callTool(name, args, env) {
  const t = TOOLS[name]
  if (!t) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] }

  for (const key of t.required ?? []) {
    if (args?.[key] === undefined || args?.[key] === null || args?.[key] === '') {
      return { isError: true, content: [{ type: 'text', text: `Missing required argument: ${key}` }] }
    }
  }

  const url = `${ORIGIN}${t.path}${t.query ? t.query(args ?? {}) : ''}`
  const res = await fetch(url, {
    method: t.method,
    headers: {
      authorization: `Bearer ${env.EVAL_TOKEN}`,
      ...(t.method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    body: t.method === 'POST' ? JSON.stringify(t.body ? t.body(args ?? {}) : {}) : undefined,
  })

  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 2000) } }

  if (!res.ok) {
    // The evaluator's own message, never its credentials.
    return { isError: true, content: [{ type: 'text', text: `evaluator ${res.status}: ${data.error ?? text.slice(0, 400)}` }] }
  }

  if (t.image && data.png) {
    return { content: [{ type: 'image', data: data.png, mimeType: 'image/png' }] }
  }

  return { content: [{ type: 'text', text: JSON.stringify(compact(data), null, 1).slice(0, 60_000) }] }
}

/**
 * Compact, not censored: the evaluator returns long text and control lists, and
 * a model reading them pays for every character. Only obvious bulk is trimmed.
 */
function compact(d) {
  if (!d || typeof d !== 'object') return d
  const out = Array.isArray(d) ? d.slice(0, 60) : { ...d }
  if (!Array.isArray(out)) {
    for (const k of ['controls', 'apiCalls', 'consoleErrors', 'networkFailures', 'externalAttempts', 'blockedWrites']) {
      if (Array.isArray(out[k]) && out[k].length > 40) out[k] = out[k].slice(-40)
    }
    if (typeof out.visibleText === 'string' && out.visibleText.length > 4000) out.visibleText = out.visibleText.slice(0, 4000) + '…'
    if (out.after) out.after = compact(out.after)
  }
  return out
}

async function dispatch(msg, env) {
  const { id, method, params } = msg ?? {}
  switch (method) {
    case 'initialize':
      return rpc(id, {
        protocolVersion: params?.protocolVersion === '2024-11-05' ? '2024-11-05' : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'crucible-evaluator', version: '1.0.0' },
        instructions: 'Drives the real deployed Crucible in a real browser as a user would. Read-only: consequential writes are refused by the evaluator and probe_write proves it. Start with observe or cold_start.',
      })
    case 'tools/list':
      return rpc(id, { tools: listed() })
    case 'tools/call':
      return rpc(id, await callTool(params?.name, params?.arguments ?? {}, env))
    case 'ping':
      return rpc(id, {})
    default:
      if (typeof method === 'string' && method.startsWith('notifications/')) return null
      return rpcError(id ?? null, -32601, `Method not found: ${method}`)
  }
}

const NOT_FOUND = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' } })

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const m = url.pathname.match(/^\/mcp\/([A-Za-z0-9_-]{16,})\/?$/)
    // A wrong secret is indistinguishable from a path that does not exist.
    if (!m || !env.MCP_SECRET || !holds(m[1], env.MCP_SECRET)) return NOT_FOUND()

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST,GET,OPTIONS' } })
    }
    if (request.method === 'GET') {
      // No server-initiated stream: this server only answers what it is asked.
      return new Response('Method not allowed', { status: 405, headers: { 'cache-control': 'no-store' } })
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })

    let msg
    try { msg = await request.json() } catch { return Response.json(rpcError(null, -32700, 'Parse error'), { status: 400 }) }

    const batch = Array.isArray(msg) ? msg : [msg]
    const out = []
    for (const one of batch) {
      const r = await dispatch(one, env)
      if (r) out.push(r)
    }
    if (!out.length) return new Response(null, { status: 202 })

    return Response.json(Array.isArray(msg) ? out : out[0], {
      headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
    })
  },
}

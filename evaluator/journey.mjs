/**
 * THE PROOF: one short journey driven entirely through the PUBLIC evaluator URL.
 *
 * Not through the local port — through https://eval.crucible.cam, the same
 * hostname and the same bearer token an external agent will use, so a pass here
 * is evidence about the thing being handed over rather than about a loopback
 * that happens to work.
 *
 * Every step reports what it actually saw. A step that cannot be performed says
 * so and the journey continues, because "swipe never reached Places" is a
 * finding about the product, not a reason to abandon the run.
 */
const BASE = process.env.EVAL_URL || 'https://eval.crucible.cam'
const TOKEN = process.env.EVAL_TOKEN
if (!TOKEN) { console.error('EVAL_TOKEN required'); process.exit(1) }

const call = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (r.headers.get('content-type')?.includes('image/png')) return { png: (await r.arrayBuffer()).byteLength }
  return r.json()
}

const results = []
const step = async (name, fn) => {
  const t0 = Date.now()
  try {
    const detail = await fn()
    results.push({ step: name, ok: true, ms: Date.now() - t0, detail })
    console.log(`✓ ${name}  (${Date.now() - t0}ms)  ${detail ?? ''}`)
  } catch (e) {
    results.push({ step: name, ok: false, ms: Date.now() - t0, error: String(e.message) })
    console.log(`✗ ${name}  ${e.message}`)
  }
}

const brief = (o) => `[${o?.surface ?? '?'}${o?.openApp ? ` · open: ${o.openApp}` : ''}] ${(o?.visibleText ?? '').replace(/\s+/g, ' ').slice(0, 80)}`

await step('cold start', async () => {
  const o = await call('POST', '/cold_start', {})
  if (!o.url) throw new Error('no page')
  return brief(o)
})

await step('screenshot', async () => {
  const s = await call('GET', '/screenshot')
  if (!s.png || s.png < 2000) throw new Error('empty png')
  return `${Math.round(s.png / 1024)}KB`
})

let controls = []
await step('list controls', async () => {
  const o = await call('GET', '/visible_elements')
  controls = o.controls ?? []
  if (!controls.length) throw new Error('no visible controls')
  return controls.slice(0, 8).map((c) => c.name || JSON.stringify(c.attrs)).join(' | ')
})

await step('tap Calendar', async () => {
  const r = await call('POST', '/tap', { target: 'calendar' })
  if (!r.ok) throw new Error(r.error)
  return `${r.matched.how}: ${brief(r.after)}`
})

await step('observe', async () => brief(await call('GET', '/observe')))

await step('back', async () => brief(await call('POST', '/back', {})))

await step('swipe deck', async () => {
  const r = await call('POST', '/swipe', { direction: 'left' })
  return `${r.from ?? '?'} → ${r.to ?? '?'}`
})

await step('tap the domain in front', async () => {
  const o = await call('GET', '/visible_elements')
  const card = (o.controls ?? []).find((c) => c.attrs?.['data-card'] || c.attrs?.['data-open'])
  if (!card) throw new Error('no card in front to open')
  const t = card.attrs['data-card'] ?? card.attrs['data-open']
  const r = await call('POST', '/tap', { target: t })
  if (!r.ok) throw new Error(r.error)
  return `${t} → ${brief(r.after)}`
})

await step('close Calendar', async () => {
  const r = await call('POST', '/tap', { target: 'surface-close' })
  if (!r.ok) throw new Error(r.error)
  return brief(r.after)
})

await step('open composer', async () => {
  for (const t of ['composer', 'ask', 'Ask Crucible anything', 'input', 'textarea']) {
    const r = await call('POST', '/tap', { target: t })
    if (r.ok) return `${t} (${r.matched.how})`
  }
  throw new Error('composer not found by any of: composer/Ask/Message/input/textarea')
})

await step('type and submit a harmless question', async () => {
  const r = await call('POST', '/type', { target: 'Ask Crucible anything', text: 'What do you know about my schedule?', submit: true })
  if (!r.ok) throw new Error(r.error)
  const typed = (r.after?.controls ?? []).find((c) => c.value)
  return typed ? `typed: "${typed.value}"` : 'submitted (field already cleared)'
})

/*
  WAIT ON THE REQUEST, NOT ON A GUESSED NUMBER.

  /api/say took roughly twenty-five seconds against production, so a fixed
  twelve-second wait reported "no response" for an answer that was still on its
  way. Polling until the call leaves `pending` measures the latency instead of
  assuming it — and a timeout here is a real finding, not a flaky step.
*/
await step('wait for the brain', async () => {
  const t0 = Date.now()
  for (let i = 0; i < 12; i++) {
    await call('POST', '/wait', { ms: 5000 })
    const i2 = await call('GET', '/inspect')
    const say = (i2.apiCalls ?? []).filter((c) => c.path === '/api/say').pop()
    if (say && say.status !== 'pending') return `POST /api/say → ${say.status} after ~${Math.round((Date.now() - t0) / 1000)}s`
  }
  throw new Error('/api/say never completed within 60s')
})

await step('read the answer', async () => {
  // The thread is collapsed by default, so the reply is not on screen until
  // the panel is expanded — the answer existing and the answer being VISIBLE
  // are two different claims.
  const r = await call('POST', '/tap', { target: 'expand' })
  const text = (r.after?.visibleText ?? '').replace(/\s+/g, ' ')
  const at = text.indexOf('What do you know about my schedule?')
  if (at < 0) throw new Error('the question never appeared in the thread')
  return `reply: "${text.slice(at + 34).trim().slice(0, 120)}"`
})

await step('external writes are refused', async () => {
  // Proven by making the app's own origin attempt one, rather than asserted.
  const r = await call('POST', '/probe_write', {})
  if (r.status !== 403) throw new Error(`/api/act returned ${r.status}, expected 403`)
  return `POST /api/act → 403, recorded (${r.recorded} blocked)`
})

await step('runtime inspection', async () => {
  const i = await call('GET', '/inspect')
  return `build=${i.build?.version ?? i.build?.stamp ?? '?'} signedIn=${i.signedIn} loading=${i.loading} consoleErrors=${i.consoleErrors?.length ?? 0} apiCalls=${i.apiCalls?.length ?? 0} blockedWrites=${i.blockedWrites?.length ?? 0}`
})

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} steps passed`)
console.log(JSON.stringify({ passed, total: results.length, results }, null, 1))

/**
 * A TRANSPORT SHIM AND NOTHING ELSE.
 *
 * One ChatGPT web-fetch layer refuses to retrieve crucible.cam and
 * eval.crucible.cam entirely — it fails before authentication is ever
 * considered. The evaluator, the capability semantics and the read-only guard
 * are all correct and unchanged; only the origin needs to be one that fetcher
 * agrees to open. So this Worker sits on workers.dev and forwards the same
 * paths to the same handler.
 *
 * It adds no authority of its own: it forwards ONLY /remote/<cap>/…, so the
 * capability remains the sole credential and the bearer API is not reachable
 * through here at all. Anything else is a 404.
 *
 * The adapter's links and image sources are absolute PATHS ("/remote/<cap>/…"),
 * so they resolve against whichever host served the page. That is why no HTML
 * rewriting is needed here, and why nothing about the page changes.
 */
const ORIGIN = 'https://eval.crucible.cam'

export default {
  async fetch(request) {
    const url = new URL(request.url)

    if (!/^\/remote\/[a-f0-9]{64}(\/|$)/.test(url.pathname)) {
      return new Response('Not found', {
        status: 404,
        headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
      })
    }

    // GET/HEAD only: the compatibility route is navigation, and refusing the
    // rest keeps this from becoming a general-purpose way into the evaluator.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { 'cache-control': 'no-store' } })
    }

    const upstream = await fetch(`${ORIGIN}${url.pathname}${url.search}`, {
      method: request.method,
      headers: { accept: request.headers.get('accept') ?? '*/*' },
      // 303s from the adapter carry an absolute path and must be followed by the
      // CLIENT, so the address bar keeps the capability and relative links work.
      redirect: 'manual',
      cf: { cacheEverything: false },
    })

    const h = new Headers(upstream.headers)
    h.set('cache-control', 'no-store, no-cache, must-revalidate, private')
    h.set('x-robots-tag', 'noindex, nofollow, noarchive')
    h.set('referrer-policy', 'no-referrer')
    return new Response(upstream.body, { status: upstream.status, headers: h })
  },
}

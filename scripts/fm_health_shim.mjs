// Minimal health-shim proxy: makes a raw llama.cpp OpenAI server (:8080) look like the
// Crucible "on-device FM bridge" that server.ts's checkLocalInference() expects.
//   /health  -> {"available":true, ...}   (llama.cpp returns {"status":"ok"}, which the
//                boot-check rejects, disabling the agentic path in CRUCIBLE_OFFLINE=strict)
//   /*       -> transparently proxied to the upstream llama.cpp server, streaming preserved.
import http from 'node:http'

const LISTEN = Number(process.env.SHIM_PORT ?? 8090)
const UP = process.env.SHIM_UPSTREAM ?? 'http://127.0.0.1:8080'
const up = new URL(UP)

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/health/') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ available: true, detail: 'llama.cpp shim', model: 'qwen2.5-1.5b-instruct' }))
    return
  }
  const opts = {
    hostname: up.hostname, port: up.port, path: req.url, method: req.method,
    headers: { ...req.headers, host: up.host },
  }
  const proxied = http.request(opts, (pr) => {
    res.writeHead(pr.statusCode ?? 502, pr.headers)
    pr.pipe(res)
  })
  proxied.on('error', (e) => { res.writeHead(502); res.end(String(e)) })
  req.pipe(proxied)
})
server.listen(LISTEN, () => console.log(`[shim] :${LISTEN} -> ${UP} (health faked as available:true)`))

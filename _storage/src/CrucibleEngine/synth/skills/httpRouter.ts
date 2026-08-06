import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'
const IMPL = `// Synthesized by Crucible — HTTP router: trie-based, params, wildcards, middleware chain.
type Handler = (ctx: Ctx) => void | Promise<void>
type Middleware = (ctx: Ctx, next: () => Promise<void>) => Promise<void>
export interface Ctx { method: string; path: string; params: Record<string, string>; state: Record<string, unknown> }
interface RouteNode { handlers: Map<string, Handler>; children: Map<string, RouteNode>; param?: string; wildcard?: Handler }
function mkNode(): RouteNode { return { handlers: new Map(), children: new Map() } }
export class Router {
  private root: RouteNode = mkNode()
  private mw: Middleware[] = []
  use(m: Middleware): this { this.mw.push(m); return this }
  on(method: string, path: string, handler: Handler): this {
    let node = this.root
    for (const seg of path.split('/').filter(Boolean)) {
      if (seg.startsWith(':')) {
        if (!node.children.has(':')) { const n = mkNode(); n.param = seg.slice(1); node.children.set(':', n) }
        node = node.children.get(':')!
      } else {
        if (!node.children.has(seg)) node.children.set(seg, mkNode())
        node = node.children.get(seg)!
      }
    }
    node.handlers.set(method.toUpperCase(), handler)
    return this
  }
  get(p: string, h: Handler) { return this.on('GET', p, h) }
  post(p: string, h: Handler) { return this.on('POST', p, h) }
  put(p: string, h: Handler) { return this.on('PUT', p, h) }
  delete(p: string, h: Handler) { return this.on('DELETE', p, h) }
  async dispatch(method: string, path: string, state: Record<string, unknown> = {}): Promise<boolean> {
    const params: Record<string, string> = {}
    let node = this.root
    for (const seg of path.split('/').filter(Boolean)) {
      if (node.children.has(seg)) { node = node.children.get(seg)! }
      else if (node.children.has(':')) { node = node.children.get(':')!; params[node.param!] = seg }
      else return false
    }
    const handler = node.handlers.get(method.toUpperCase()); if (!handler) return false
    const ctx: Ctx = { method, path, params, state }
    let idx = 0
    const next = async () => { const m = this.mw[idx++]; if (m) await m(ctx, next); else await handler(ctx) }
    await next(); return true
  }
}
`
registerSkill({
  id: 'http-router',
  summary: 'HTTP router: trie-based, named params, middleware chain, GET/POST/PUT/DELETE.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bhttp.?router\b|\brouter\b/i) && s.has(/\btrie\b|\bpath.?param\b/i)) sc += 0.5
    if (s.has(/\bmiddleware.?chain\b/i)) sc += 0.3
    if (s.has(/\bnamed.?param\b|\burl.?param\b/i) && s.has(/\brouter\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/router.ts', content: IMPL }]
  },
})


import { z } from 'zod'

const ipv4Schema = z.string().regex(/^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/);

ipv4Schema;


const VALID = ["1.2.3.4","192.168.1.1","255.255.255.255","0.0.0.0"]
const INVALID = ["999.1.1.1","1.2.3","abc","1.2.3.4.5","256.1.1.1",""]
// An object schema like z.object({ ip: z.ipv4() }) is a CORRECT answer to "a Zod schema that
// validates an IPv4 address" — it just takes { ip: v } rather than a bare string. Testing only
// bare strings falsely rejected it. Unwrap single-key object schemas and test through them.
function objKey(c) {
  const shape = c?.shape ?? c?._def?.shape ?? (typeof c?._def?.shape === 'function' ? c._def.shape() : null)
  const s = typeof shape === 'function' ? shape() : shape
  if (s && typeof s === 'object') { const k = Object.keys(s); if (k.length === 1) return k[0] }
  return null
}
function accepts(c, v) {
  const k = c && typeof c.safeParse === 'function' ? objKey(c) : null
  const wrap = x => (k ? { [k]: x } : x)
  if (c && typeof c.safeParse === 'function') { try { return c.safeParse(wrap(v)).success === true } catch { return false } }
  if (c && typeof c.parse === 'function')     { try { c.parse(wrap(v)); return true } catch { return false } }
  if (typeof c === 'function') { try { const r = c(v); if (r && typeof r.success === 'boolean') return r.success; return !!r } catch { return false } }
  if (c && typeof c.validate === 'function')  { try { const r = c.validate(v); return !!(r && (r.success ?? r.valid ?? r)) } catch { return false } }
  return null
}
const results = []
for (const n of ["ipv4Schema"]) {
  let c; try { c = eval(n) } catch { continue }
  const okV = VALID.map(v => accepts(c, v)); const okI = INVALID.map(v => accepts(c, v))
  if (okV.includes(null) || okI.includes(null)) { results.push({ name: n, validator: false }); continue }
  results.push({ name: n, validator: true, pass: okV.every(x => x === true) && okI.every(x => x === false), okV, okI })
}
console.log('__PROBE__' + JSON.stringify(results))

// Stateless HS256 JWT sign/verify + cookie parsing, extracted from server.ts so the auth
// crypto is unit-testable in isolation (server.ts binds these to the process JWT_SECRET via
// thin wrappers). Pure: the secret is passed in; no module state, no side effects.
import crypto from 'crypto'

export interface JwtPayload { id: string; email: string; exp: number }

export function signJwt(payload: object, secret: string): string {
  const hdr = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const bdy = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(`${hdr}.${bdy}`).digest('base64url')
  return `${hdr}.${bdy}.${sig}`
}

/** Verify signature AND expiry. Returns the payload, or null on a bad signature, tampered body,
 *  malformed token, or expiry. `now` (seconds) is injectable so the check is testable. */
export function verifyJwt(token: string, secret: string, now = Date.now() / 1000): JwtPayload | null {
  try {
    const [hdr, bdy, sig] = token.split('.')
    if (!hdr || !bdy || !sig) return null
    const expected = crypto.createHmac('sha256', secret).update(`${hdr}.${bdy}`).digest('base64url')
    // Constant-time compare so a caller can't probe the signature byte-by-byte via timing.
    const a = Buffer.from(sig), b = Buffer.from(expected)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
    const payload = JSON.parse(Buffer.from(bdy, 'base64url').toString())
    if (typeof payload.exp !== 'number' || payload.exp < now) return null
    return payload
  } catch { return null }
}

export function parseCookies(cookieHeader: string): Record<string, string> {
  return Object.fromEntries(
    (cookieHeader ?? '').split(';').map(c => c.trim()).filter(Boolean).map(c => {
      const idx = c.indexOf('=')
      return [c.slice(0, idx).trim(), decodeURIComponent(c.slice(idx + 1).trim())]
    }),
  )
}

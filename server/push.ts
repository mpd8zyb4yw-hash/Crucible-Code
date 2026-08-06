/**
 * Web Push, VAPID-signed with WebCrypto.
 *
 * The previous build did this with the `web-push` npm package, which needs
 * Node's crypto and a Postgres table — neither exists on a Worker. The service
 * worker and manifest were salvaged as-is; only the sending half is rewritten.
 *
 * These pushes carry NO PAYLOAD. Encrypting a payload (RFC 8291, aes128gcm)
 * is the genuinely hard part, and it buys little here: `sw.js` already falls
 * back to a sensible title and body when `event.data` is null, and the app
 * fetches the real state on open. A payload-less push is a doorbell, which is
 * all a notification should be — and it means nothing about his life is
 * handed to a third-party push service in transit.
 */

export interface PushSub {
  endpoint: string
  keys?: { p256dh?: string; auth?: string }
}

const b64url = (buf: ArrayBuffer | Uint8Array): string => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const byte of b) s += String.fromCharCode(byte)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromB64url = (s: string): Uint8Array => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * The VAPID private key ships as a raw base64url d-value (what `web-push
 * generate-vapid-keys` prints). WebCrypto wants a JWK, and the public point
 * has to come with it — recovered from the public key rather than derived,
 * since P-256 point multiplication is not something to hand-roll.
 */
async function importKey(privB64: string, pubB64: string): Promise<CryptoKey> {
  const pub = fromB64url(pubB64)
  // Uncompressed point: 0x04 || X (32) || Y (32).
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('VAPID public key is not an uncompressed P-256 point')
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: privB64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    x: b64url(pub.slice(1, 33)),
    y: b64url(pub.slice(33, 65)),
    ext: true,
  }
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

/** A VAPID Authorization header for one push endpoint's origin. */
async function vapidHeader(endpoint: string, publicKey: string, privateKey: string, subject: string): Promise<string> {
  const aud = new URL(endpoint).origin
  const header = b64url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const payload = b64url(
    new TextEncoder().encode(
      JSON.stringify({
        aud,
        // 12 hours. Push services reject anything more than 24h out.
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: subject,
      })
    )
  )
  const key = await importKey(privateKey, publicKey)
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(`${header}.${payload}`)
  )
  // WebCrypto returns r||s, which is exactly what JWS ES256 wants.
  return `vapid t=${header}.${payload}.${b64url(sig)}, k=${publicKey}`
}

export interface PushResult {
  sent: number
  /** Endpoints the service rejected as gone — the caller should forget these. */
  expired: string[]
  errors: string[]
}

/**
 * Ring the doorbell. A 404/410 means the subscription is dead and is reported
 * so the caller can drop it; anything else is noted but never thrown, because
 * a failed notification must not take down the pass that triggered it.
 */
export async function notify(
  subs: PushSub[],
  vapid: { publicKey: string; privateKey: string; subject: string },
  opts: { ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high' } = {}
): Promise<PushResult> {
  const out: PushResult = { sent: 0, expired: [], errors: [] }
  for (const sub of subs) {
    if (!sub?.endpoint) continue
    try {
      const auth = await vapidHeader(sub.endpoint, vapid.publicKey, vapid.privateKey, vapid.subject)
      const r = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          authorization: auth,
          ttl: String(opts.ttl ?? 3600),
          urgency: opts.urgency ?? 'normal',
          // No body, so the service must be told the length is zero.
          'content-length': '0',
        },
      })
      if (r.status === 404 || r.status === 410) out.expired.push(sub.endpoint)
      else if (r.ok || r.status === 201 || r.status === 202) out.sent += 1
      else out.errors.push(`${r.status} ${(await r.text()).slice(0, 80)}`)
    } catch (e) {
      out.errors.push((e as Error).message)
    }
  }
  return out
}

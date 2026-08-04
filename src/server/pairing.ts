// ============================================================================
// Paired-device tokens — the ONLY sanctioned way to reach Crucible from off-LAN.
//
// The locality guard (server.ts `isLocalRequest`) refuses any request whose Host
// is a public hostname. That closed a real hole: with the guard removed and the
// crucible.cam tunnel up, an unauthenticated request from the open internet
// returned this account's identity and conversations. It is also why the phone
// "cannot send anything" when it is on cellular rather than the LAN.
//
// This module adds a second, EXPLICIT door — it does not widen the first one:
//
//   · Nothing is paired by default. With no devices on file the guard behaves
//     exactly as it did before: LAN in, internet out.
//   · A token can only be MINTED from a local request. A paired phone cannot
//     enrol more devices; compromising the phone does not compound.
//   · Only a SHA-256 of the token is stored, so a readable
//     `.crucible/paired-devices.json` does not hand over access.
//   · Comparison is constant-time. A token is a bearer secret; a timing oracle
//     on a public URL is a practical attack, not a theoretical one.
//   · The token travels in the `x-crucible-device` HEADER (or an explicit query
//     param for WebSocket upgrades, which cannot carry custom headers), never a
//     cookie. A custom header forces a CORS preflight, so a hostile page cannot
//     make the browser replay it — there is no ambient authority to steal.
//
// Revocation is immediate: drop the device and the token is dead.
// ============================================================================
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

export interface PairedDevice {
  id: string
  label: string
  hash: string        // sha256 hex of the token — the token itself is never stored
  createdAt: number
  lastSeenAt: number | null
}

/** What a device looks like to the UI: everything except the secret material. */
export type PairedDeviceView = Omit<PairedDevice, 'hash'>

export const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex')

/** 32 bytes of CSPRNG as base64url — 256 bits, URL-safe so it can be a link. */
export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/**
 * Constant-time token comparison.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak length —
 * we compare fixed-width sha256 hex digests, so both sides are always 64 bytes
 * and the length check can never fail for a well-formed entry.
 */
export function tokenMatchesHash(token: string, hash: string): boolean {
  const a = Buffer.from(sha256(token), 'utf8')
  const b = Buffer.from(hash, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * Match a token against every paired device in constant time WITH RESPECT TO THE
 * TOKEN. The loop deliberately does not early-return on a hit: bailing out on the
 * first match would make response time depend on which device matched, leaking
 * the enrolment order.
 */
export function findDevice(devices: PairedDevice[], token: string): PairedDevice | null {
  if (!token) return null
  let found: PairedDevice | null = null
  for (const d of devices) {
    if (tokenMatchesHash(token, d.hash)) found = d
  }
  return found
}

export const toView = (d: PairedDevice): PairedDeviceView => ({
  id: d.id, label: d.label, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt,
})

/**
 * Extract a candidate token from a request-like object. Header first (the normal
 * path, CORS-preflighted); `?device=` only exists because a browser WebSocket
 * cannot set headers on the upgrade.
 */
export function extractToken(
  headers: Record<string, string | string[] | undefined>,
  url?: string,
): string {
  const h = headers['x-crucible-device']
  const fromHeader = Array.isArray(h) ? h[0] : h
  if (fromHeader) return String(fromHeader)
  if (url) {
    try {
      const q = new URL(url, 'http://localhost').searchParams.get('device')
      if (q) return q
    } catch { /* malformed URL → no token */ }
  }
  return ''
}

// ── Persistence ─────────────────────────────────────────────────────────────

export class PairingStore {
  private devices: PairedDevice[] = []
  private loaded = false
  constructor(private readonly file: string) {}

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed?.devices)) this.devices = parsed.devices
    } catch { /* no file yet, or unreadable → nothing is paired, which fails CLOSED */ }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      // 0600: the hashes are not usable as tokens, but there is no reason for
      // anything else on the machine to enumerate the user's paired devices.
      fs.writeFileSync(this.file, JSON.stringify({ devices: this.devices }, null, 2), { mode: 0o600 })
    } catch (e) {
      console.error('[Pairing] could not persist device list:', e)
    }
  }

  list(): PairedDeviceView[] {
    this.load()
    return this.devices.map(toView)
  }

  /** True when nothing is paired — the guard then behaves exactly as before. */
  isEmpty(): boolean {
    this.load()
    return this.devices.length === 0
  }

  /** Mint a token. The plaintext is returned ONCE and never stored. */
  create(label: string): { token: string; device: PairedDeviceView } {
    this.load()
    const token = generateToken()
    const device: PairedDevice = {
      id: crypto.randomUUID(),
      label: (label || 'Paired device').slice(0, 60),
      hash: sha256(token),
      createdAt: Date.now(),
      lastSeenAt: null,
    }
    this.devices.push(device)
    this.persist()
    return { token, device: toView(device) }
  }

  revoke(id: string): boolean {
    this.load()
    const before = this.devices.length
    this.devices = this.devices.filter(d => d.id !== id)
    if (this.devices.length === before) return false
    this.persist()
    return true
  }

  revokeAll(): number {
    this.load()
    const n = this.devices.length
    this.devices = []
    this.persist()
    return n
  }

  /** Verify a token and stamp last-seen. Returns the device, or null. */
  verify(token: string): PairedDeviceView | null {
    this.load()
    const d = findDevice(this.devices, token)
    if (!d) return null
    // Throttle the write — a busy stream would otherwise rewrite the file per request.
    const now = Date.now()
    if (!d.lastSeenAt || now - d.lastSeenAt > 60_000) { d.lastSeenAt = now; this.persist() }
    return toView(d)
  }
}

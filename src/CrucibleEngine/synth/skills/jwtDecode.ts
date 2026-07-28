// Verified Tier-1B primitive: JWT decode (no verification — decode-only).
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible — JWT decode (structure only, no signature verification).
export interface JwtPayload {
  iss?: string; sub?: string; aud?: string | string[]; exp?: number; nbf?: number; iat?: number
  jti?: string; [key: string]: unknown
}

export interface JwtHeader {
  alg: string; typ?: string; kid?: string; [key: string]: unknown
}

function b64urlDecode(s: string): string {
  const padded = s + '='.repeat((4 - s.length % 4) % 4)
  const b64 = padded.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64').toString('utf8')
}

export function jwtDecode(token: string): { header: JwtHeader; payload: JwtPayload; signature: string } {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT: expected 3 parts')
  return {
    header: JSON.parse(b64urlDecode(parts[0])) as JwtHeader,
    payload: JSON.parse(b64urlDecode(parts[1])) as JwtPayload,
    signature: parts[2],
  }
}

export function isJwtExpired(token: string): boolean {
  try {
    const { payload } = jwtDecode(token)
    if (payload.exp == null) return false
    return Date.now() / 1000 > payload.exp
  } catch { return true }
}
`


registerSkill({
  id: 'jwtDecode',
  summary: 'JWT decode (no signature verification): jwtDecode, isJwtExpired.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bjwt.?decode\b|\bdecode.?jwt\b/i)) sc += 0.85
    if (s.has(/\bjwt\b.*\bparse\b|\bparse\b.*\bjwt\b/i)) sc += 0.6
    if (s.has(/json.?web.?token.*decode|decode.*json.?web.?token/i)) sc += 0.7
    if (s.has(/\bjwt\b.*\bexpir|\bexpir\b.*\bjwt\b/i)) sc += 0.4
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/module.ts', content: IMPL }]
  },
})

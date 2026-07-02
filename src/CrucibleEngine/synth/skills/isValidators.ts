// Verified Tier-1C primitive: URL, UUID, IP address validators.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL =
  "// Synthesized by Crucible — isUrl, isUuid, isIp validators.\n" +
  "export function isUrl(s: string): boolean {\n" +
  "  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:' } catch { return false }\n" +
  "}\n\n" +
  "const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i\n" +
  "export function isUuid(s: string): boolean { return UUID_RE.test(s) }\n\n" +
  "const IPV4_RE = /^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$/\n" +
  "export function isIpv4(s: string): boolean {\n" +
  "  const m = IPV4_RE.exec(s)\n" +
  "  return m !== null && m.slice(1).every(n => parseInt(n, 10) <= 255)\n" +
  "}\n\n" +
  "const IPV6_RE = /^([0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}$/i\n" +
  "export function isIpv6(s: string): boolean { return IPV6_RE.test(s) }\n\n" +
  "export function isIp(s: string): boolean { return isIpv4(s) || isIpv6(s) }\n"

registerSkill({
  id: 'isValidators',
  summary: 'Validate URL, UUID, IPv4, IPv6 strings: isUrl, isUuid, isIp, isIpv4, isIpv6.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\bisUrl\b|\bvalidate.*url\b|\burl.*valid/i)) sc += 0.7
    if (s.has(/\bisUuid\b|\bvalidate.*uuid\b|\buuid.*valid/i)) sc += 0.7
    if (s.has(/\bisIp\b|\bisIpv4\b|\bisIpv6\b|\bvalidate.*ip\b|\bip.*valid/i)) sc += 0.7
    if (s.has(/\bisUrl\b.*\bisUuid\b|\bisUuid\b.*\bisUrl\b/i)) sc += 0.3
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/module.ts', content: IMPL }]
  },
})

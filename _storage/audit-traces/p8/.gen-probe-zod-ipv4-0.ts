
import * as __m from 'zod'
const __ns: any = __m as any
const z: any = __ns.z ?? __ns.default ?? __ns
const { ipv4 } = __ns as any

const validateIPv4 = (ip: string) => ipv4(ip);

for (const S of [validateIPv4] as any[]) {
  try { if (S.safeParse('1.2.3.4').success && !S.safeParse('999.1.1.1').success) console.log('__OK__') } catch {}
}

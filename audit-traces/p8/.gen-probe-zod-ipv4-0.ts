
import * as __m from 'zod'
const __ns: any = __m as any
const z: any = __ns.z ?? __ns.default ?? __ns
const { cidrv4, ipv4, ipv6, keyof } = __ns as any

const ipv4Address = '192.168.1.1';
const ipv6Address = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';

const ipv4Schema = ipv4();
const ipv6Schema = ipv6();

const ipv4Result = ipv4Schema.safeParse(ipv4Address);
const ipv6Result = ipv6Schema.safeParse(ipv6Address);

console.log(ipv4Result.success); // true
console.log(ipv6Result.success); // true

for (const S of [ipv4Address,ipv6Address,ipv4Schema,ipv6Schema,ipv4Result,ipv6Result] as any[]) {
  try { if (S.safeParse('1.2.3.4').success && !S.safeParse('999.1.1.1').success) console.log('__OK__') } catch {}
}

```typescript
import { cidrv4, ipv4, ipv6, keyof } from 'zod';

const ipv4Address = '192.168.1.1';
const ipv6Address = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';

const ipv4Schema = ipv4();
const ipv6Schema = ipv6();

const ipv4Result = ipv4Schema.safeParse(ipv4Address);
const ipv6Result = ipv6Schema.safeParse(ipv6Address);

console.log(ipv4Result.success); // true
console.log(ipv6Result.success); // true
```

---
Sources:
[S1] zod@4.4.3 — published type definitions (authoritative API surface) — https://www.npmjs.com/package/zod/v/4.4.3
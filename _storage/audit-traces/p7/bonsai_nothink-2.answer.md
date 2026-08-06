To validate an IPv4 address using Zod, you can use the built-in `z.ipv4()` function. This function ensures the input is a valid IPv4 address string.

```typescript
import { z } from 'zod';

const ipSchema = z.object({
  ip: z.ipv4()
});

// Example usage:
const result = ipSchema.parse({ ip: '192.168.1.1' });
console.log(result.data); // { ip: '192.168.1.1' }
```

The `z.ipv4()` function validates that the input is a string representing a valid IPv4 address. It checks for the correct format and range of each octet.

If you need to validate an IPv4 CIDR block, you can use `z.cidrv4()`.

```typescript
import { z } from 'zod';

const cidrSchema = z.object({
  cidr: z.cidrv4()
});

// Example usage:
const result = cidrSchema.parse({ cidr: '192.168.1.0/24' });
console.log(result.data); // { cidr: '192.168.1.0/24' }
```

The `z.cidrv4()` function validates that the input is a string representing a valid IPv4 CIDR block. It checks for the correct format and range of each octet, as well as the prefix length.
To validate an IPv4 address in Zod, use the built-in `z.ipv4()` function. According to the Zod API documentation, `z.ipv4()` is specifically designed to validate against common IPv4 string formats [S1].

```typescript
import { z } from 'zod';

const ipv4Schema = z.string().ipv4();
```

This schema enforces strict dotted-decimal notation. It automatically rejects invalid octets, out-of-range values, and malformed strings. If validation fails, Zod throws a `ZodError` with a clear message. You can also apply it directly as `z.ipv4()` in certain Zod versions, though chaining with `z.string()` remains the standard pattern for explicit type validation. The function handles all standard IPv4 validation rules
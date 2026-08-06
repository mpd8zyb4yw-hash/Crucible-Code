To validate an IPv4 address using Zod, use the built-in `z.ipv4()` function:

```typescript
import { z } from 'zod';

const ipv4Schema = z.string().ipv4();
```

This schema strictly validates dotted-decimal IPv4 notation, ensuring all four octets fall within the 0–255 range and rejecting malformed strings [S1]. The function is a native Zod utility that returns a `string` type upon successful validation. You can chain it with modifiers like `.trim()` to handle surrounding whitespace, though `z.ipv4()` already enforces the exact numeric format. For network addressing, Zod also provides `z.cidrv4()` to validate IPv4 CIDR blocks [S1]. 

The validation occurs synchronously and throws a `ZodError` with descriptive messages for invalid inputs. It requires no external packages and integrates directly into TypeScript projects, API parsers, and form handling libraries. Because it operates on strings, it safely handles edge cases like leading zeros or extra whitespace when combined with `.trim()`. This approach eliminates the need for third-party IP validation libraries while maintaining strict type safety.
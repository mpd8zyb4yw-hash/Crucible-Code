To validate an IPv4 address in Zod, apply the `.ipv4()` modifier to a string schema. The Zod API documentation explicitly lists `.ipv4()` as a built-in string format validator designed to enforce standard IPv4 syntax [S1].

```typescript
import { z } from 'zod';

const ipv4Schema = z.string().ipv4();
```

This schema strictly validates the four-octet decimal format, ensuring the input matches standard IPv4 rules. You can use it directly with Zod’s `parse()` or `safeParse()` methods for runtime validation. The resulting TypeScript inference will be `string`, but Zod will guarantee the value conforms to IPv4 format before it passes. You can optionally chain additional modifiers like `.optional()` or `.nullable()` depending on your application’s requirements. This approach provides a clean, type-safe way to handle network addresses without writing custom regex or parsing logic.
To validate an IPv4 address using Zod, use the built-in `z.ipv4()` function. This schema ensures the input is a string representing a valid IPv4 address (e.g., `"192.168.1.1"`).

```typescript
import { z } from 'zod';

const ipSchema = z.string().ipv4();
```

**Key Details:**
- **Type:** Validates strings only.
- **Format:** Checks for four decimal octets separated by dots, where each octet is between 0 and 255.
- **Leading Zeros:** By default, `z.ipv4()` rejects leading zeros (e.g., `"192.168.01.1"` is invalid).
- **Usage:** Can be used standalone or combined with other validations.

**Example:**
```typescript
const result = ipSchema.parse("192.168.1.1"); // Success
const error = ipSchema.parse("256.1.1.1");      // Error: Invalid IPv4
```

This approach is concise and leverages Zod's native IP validation capabilities.
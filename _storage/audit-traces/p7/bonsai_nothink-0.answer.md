To validate an IPv4 address using Zod, use the built-in `z.ipv4()` function. This function ensures the input is a string representing a valid IPv4 address.

```typescript
import { z } from 'zod';

const ipSchema = z.string().ipv4();
```

This schema will pass if the input is a valid IPv4 address (e.g., `"192.168.1.1"`) and fail otherwise.
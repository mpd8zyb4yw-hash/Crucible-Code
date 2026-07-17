```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Email Validation Schema",
  "type": "object",
  "properties": {
    "email": {
      "type": "string",
      "pattern": "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$",
      "description": "A valid email address"
    }
  },
  "required": ["email"]
}
```

---
Sources:
[S1] zod@4.4.3 — published type definitions (authoritative API surface) — https://www.npmjs.com/package/zod/v/4.4.3
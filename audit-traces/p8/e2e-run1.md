## Zod Schema for IPv4 Address Validation

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "IPv4 Address Validation",
  "type": "object",
  "properties": {
    "ipv4": {
      "type": "string",
      "pattern": "^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$",
      "description": "A valid IPv4 address must consist of four octets separated by dots, each ranging from 0 to 255."
    }
  },
  "required": ["ipv4"],
  "additionalProperties": false
}
```

## Explanation

- **Type**: The schema is an object of type `string`.
- **Properties**:
  - `ipv4`: A string that must match the pattern `^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$`.
    - This pattern ensures that the address has exactly four octets.
    - Each octet must be a number between 0 and 255.
    - Numbers are separated by dots.
- **Required**: The `ipv4` property is required.
- **Additional Properties**: The schema does not allow additional properties.

## Usage

To validate an IPv4 address using this schema, you can use the following code:

```javascript
const { validate } = require('zod');

const ipv4Schema = {
  ipv4: {
    type: 'string',
    pattern: '^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$',
    description: 'A valid IPv4 address must consist of four octets separated by dots, each ranging from 0 to 255.'
  }
};

const ipv4Address = '192.168.1.1';
const isValid = validate(ipv4Address, ipv4Schema);

console.log(isValid); // Output: true
```

This code uses the `validate` function from the Zod library to check if the provided IPv4 address matches the schema. If the address is valid, it returns `true`; otherwise, it returns `false`.

---
Sources:
[S1] zod@4.4.3 — published type definitions (authoritative API surface) — https://www.npmjs.com/package/zod/v/4.4.3
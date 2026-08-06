## Zod Schema for IPv4 Address Validation

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "IPv4 Address Validation",
  "type": "object",
  "properties": {
    "ip": {
      "type": "string",
      "pattern": "^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$",
      "description": "A valid IPv4 address must consist of four octets separated by dots, each ranging from 0 to 255."
    }
  },
  "required": ["ip"],
  "additionalProperties": false
}
```

## Explanation

- **Type**: The schema is an object of type `string`.
- **Properties**:
  - `ip`: A string that must match the pattern `^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$`.
    - This pattern ensures that the IPv4 address is correctly formatted with four octets, each ranging from 0 to 255.
  - **Required**: The `ip` property is required, meaning it must be present in the input.
  - **Additional Properties**: The schema does not allow any additional properties, ensuring that the input is strictly validated.

## Usage

To validate an IPv4 address using this schema, you can use the following function:

```javascript
const { validate } = require('zod');

const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  "title": "IPv4 Address Validation",
  "type": "object",
  "properties": {
    "ip": {
      "type": "string",
      "pattern": "^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$",
      "description": "A valid IPv4 address must consist of four octets separated by dots, each ranging from 0 to 255."
    }
  },
  "required": ["ip"],
  "additionalProperties": false
};

const address = "192.168.1.1";
const result = validate(address, schema);

if (result.valid) {
  console.log("The address is valid.");
} else {
  console.log("The address is invalid.");
}
```

This example demonstrates how to validate an IPv4 address using the `validate` function and the defined schema.

---
Sources:
[S1] zod@4.4.3 — published type definitions (authoritative API surface) — https://www.npmjs.com/package/zod/v/4.4.3
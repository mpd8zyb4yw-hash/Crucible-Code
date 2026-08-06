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
    - This pattern ensures that the IP address is in the correct format with four octets separated by dots.
    - Each octet must be a number between 0 and 255.
- **Required**: The `ip` property is required for the schema to be valid.
- **Additional Properties**: The schema does not allow any additional properties.

## Usage

To validate an IPv4 address using this schema, you can use the following function:

```javascript
const { validate } = require("zod");

const ipv4Schema = {
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
};

const ip = "192.168.1.1";
const isValid = validate
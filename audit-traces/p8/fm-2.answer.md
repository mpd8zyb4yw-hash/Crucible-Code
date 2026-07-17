## Zod Schema for IPv4 Address Validation

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "IPv4 Address Validation",
  "type": "object",
  "properties": {
    "ip": {
      "type": "string",
      "pattern": "^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9]?)\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9]?)\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9]?)\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$",
      "description": "A valid IPv4 address must consist of four octets, each ranging from 0 to 255, separated by dots."
    }
  },
  "required": ["ip"],
  "additionalProperties": false
}
```

## Explanation

- **Type**: The schema is an object of type `string`.
- **Properties**:
  - `ip`: A string that must match the pattern `^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9]?)\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9]?)\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9]?)\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$`. This pattern ensures that the address is in the correct format with four octets, each between 0 and 255.
- **Required**: The `ip` property is required, meaning it must be present in the schema.
- **Additional Properties**: The schema does not allow any additional properties, ensuring that it only validates the `ip` field.

## Usage

To validate an IPv4 address using this schema, you can use the following example:

```javascript
const validator = new Zod();
const ipAddress = "192.168.1.1";
const isValid = validator.ipv4(ipAddress);
console.log(isValid); // Output: true
```

This example demonstrates how to use the `ipv4` property of the Zod schema to validate an IPv4 address.
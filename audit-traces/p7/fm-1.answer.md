## Zod Schema for IPv4 Address Validation

### Key Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "IPv4 Address",
  "type": "object",
  "properties": {
    "address": {
      "type": "string",
      "pattern": "^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$"
    }
  },
  "required": ["address"]
}
```

### Explanation

- **$schema**: Specifies the schema version used.
- **title**: Provides a descriptive title for the schema.
- **type**: Indicates that the schema is an object.
- **properties**: Defines the properties of the object.
  - **address**: A string that must match the pattern for an IPv4 address.
    - **type**: String.
    - **pattern**: A regular expression that matches the standard IPv4 address format.
- **required**: Specifies the properties that are mandatory for the schema.

### Validation

This schema can be used to validate IPv4 addresses using the `vee-validate` package. Here's an example of how to use it:

```javascript
const veeValidator = require('vee-validate');
const { toTypedSchema } = require('@vee-validate/zod');

const schema = toTypedSchema({
  title: "IPv4 Address",
  type: "object",
  properties: {
    address: {
      type: "string",
      pattern: "^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$"
    }
  },
  required: ["address"]
});

const validator = veeValidator(schema);

const input = "192.168.1.1";
const result = validator.validate(input);

console.log(result);
```

### Conclusion

This Zod schema defines a valid IPv4 address. It can be used to validate IPv4 addresses using the `vee-validate` package.
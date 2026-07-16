## Zod Schema for IPv4 Address Validation

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "IPv4 Address",
  "type": "object",
  "properties": {
    "ip": {
      "type": "string",
      "pattern": "^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$"
    }
  },
  "required": ["ip"]
}
```

## Explanation

This Zod schema defines an `IPv4Address` object with a single required property, `ip`, which must be a valid IPv4 address. The `ip` property is a string that follows the standard IPv4 address format, which consists of four octets separated by dots. Each octet must be a number between 0 and 255, inclusive.

## Validation

The schema uses a regular expression pattern to validate the `ip` property. The pattern `^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$` matches the following:

- The first octet can be 25, 20, 16, 12, 8, 4, 2, or 0, and it must be followed by a zero or a digit between 0 and 9.
- The second octet can be 25, 20, 16, 12, 8, 4, 2, or 0, and it must be followed by a zero or a digit between 0 and 9.
- The third octet can be 25, 20, 16, 12, 8, 4, 2, or 0, and it must be followed by a zero or a digit between 0 and 9.
- The fourth octet can be 25, 20, 16, 12, 8, 4, 2, or 0, and it must be followed by a zero or a digit between
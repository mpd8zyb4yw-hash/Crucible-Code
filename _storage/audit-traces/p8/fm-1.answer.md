## Zod Schema for IPv4 Address Validation

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "IPv4 Address Validation",
  "type": "object",
  "properties": {
    "ipv4": {
      "type": "string",
      "pattern": "^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$"
    }
  },
  "required": ["ipv4"]
}
```

## Explanation

- **Type**: The schema is an object of type `string`.
- **Properties**:
  - `ipv4`: A string that must match the pattern for an IPv4 address.
  - **Pattern**: The pattern `^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$`:
    - `^`: Matches the start of the string.
    - `((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}`: Matches the first three octets. Each octet must be between 0 and 255, inclusive.
    - `(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$`: Matches the last three octets.
- **Required**: The `ipv4` property is required for the schema to be valid.

## Validation

This schema validates an IPv4 address by ensuring it follows the standard IPv4 address format. It checks that each octet is a number between 0 and 255, and that there are exactly four octets.

## Example

```json
{
  "ipv4": "192.168.1.1"
}
```

This example is valid according to the schema.

## Conclusion

This schema accurately validates an IPv4 address by ensuring it matches the standard IPv4 address format.
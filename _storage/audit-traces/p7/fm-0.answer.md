## Zod Schema for IPv4 Address Validation

```zod
type IpV4Address = {
  address: string,
};

const ipv4Schema = {
  type: "object",
  required: ["address"],
  properties: {
    address: {
      type: "string",
      pattern: "^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$",
    },
  },
};
```

## Explanation

- **Type**: The `type` property specifies that the schema is an object.
- **Required Fields**: The `required` property ensures that the `address` field is present in the input.
- **Properties**:
  - `address`: This field must be a string and must match the pattern `^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$`.
    - This pattern matches a standard IPv4 address format, ensuring that the address is valid and follows the correct structure.

## Usage

You can use this schema to validate IPv4 addresses in your applications. For example, in a Vue.js component, you can use the `toTypedSchema` function from the `@vee-validate/zod` package to convert the schema into a format that can be used with Vue's validation system.

```javascript
import { toTypedSchema } from '@vee-validate/zod';

const fieldSchema = toTypedSchema(ipv4Schema);

<Form>
  <Field name="email" type="email" :rules="fieldSchema" />
  <ErrorMessage name="email" />
</Form>
```

This example demonstrates how to use the `toTypedSchema` function to convert the `ipv4Schema` into a format that can be used with Vue's validation system. The `:rules` prop on the `<Field />` component is set to the `fieldSchema`, which contains the validation rules for the `email` field.
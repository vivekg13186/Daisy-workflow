# transform

A utility plugin used for data re-shaping and identity transformations. It accepts any input and returns it directly, making it ideal for resolving complex `${...}` expressions or mapping data structures within a workflow.

## Prerequisites
* **No External Dependencies:** This is a logic-only plugin and does not require any external servers or software.

## Inputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `value` | The data to be transformed or returned. Can be a string, number, object, or array. | `${data.users.map(u => u.id)}` |

## Outputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `value` | The resolved value from the input. | `[1, 2, 3]` |

## Sample workflow
```yaml
name: data-reshape-example
description: |
  Takes a raw API response and extracts specific fields into 
  a new object structure using the transform plugin.

data:
  rawUser:
    id: 101
    profile:
      firstName: "Jane"
      lastName: "Doe"
      email: "jane@example.com"
    meta:
      lastLogin: "2026-05-01"

nodes:
  - name: reshape_user
    action: transform
    inputs:
      - value:
          fullName: "${data.rawUser.profile.firstName} ${data.rawUser.profile.lastName}"
          contact: "${data.rawUser.profile.email}"
          userId: "${data.rawUser.id}"
    outputs:
      - value: simplifiedUser

  - name: debug_output
    action: log
    inputs:
      - message: "Processed user: ${simplifiedUser.fullName} (ID: ${simplifiedUser.userId})"

edges:
  - from: reshape_user
    to: debug_output
```

## Expected output
The plugin returns the exact structure defined in the `value` input after evaluating all expressions:
```json
{
  "value": {
    "fullName": "Jane Doe",
    "contact": "jane@example.com",
    "userId": 101
  }
}
```

## Troubleshooting
* **Undefined Values:** If a `${}` expression references a path that doesn't exist in `data`, the resulting field may be `undefined` or null.
* **Complex Objects:** Ensure that JSON syntax is strictly followed when defining object shapes in the workflow YAML.

## Library
* **Native:** This plugin uses standard JavaScript object assignment.

## Reference
* [Expression Language (DSL) Guide](#) - Refer to your specific workflow engine's documentation for supported `${}` syntax.

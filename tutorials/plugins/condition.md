# condition

A simple utility plugin used to evaluate a truthy or falsy value and return it as a formal boolean. This is primarily used to store the result of a complex logic check so it can be referenced by multiple downstream nodes using `executeIf`.

## Prerequisites
* **No External Dependencies:** This is a logic-only plugin and does not require any external servers or software.

## Inputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `value` | The expression or value to evaluate. | `${data.count > 10}` |

## Outputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `result` | The boolean result of the evaluation. | `true` |

## Sample workflow
```yaml
name: conditional-branching
description: |
  Evaluates a condition once and uses the result to 
  determine if subsequent steps should run.

data:
  inventoryCount: 5

nodes:
  - name: check_stock
    action: condition
    inputs:
      - value: "${data.inventoryCount > 0}"
    outputs:
      - result: isAvailable

  - name: process_order
    action: log
    executeIf: "${isAvailable}"
    inputs:
      - message: "Proceeding with order..."

  - name: notify_out_of_stock
    action: log
    executeIf: "${!isAvailable}"
    inputs:
      - message: "Item is out of stock."

edges:
  - from: check_stock
    to: process_order
  - from: check_stock
    to: notify_out_of_stock
```

## Expected output
The plugin explicitly returns a boolean:
```json
{
  "result": true
}
```

## Troubleshooting
* **Unexpected Falsy Values:** In JavaScript, values like `0`, `""` (empty string), `null`, and `undefined` are evaluated as `false`. Ensure your input logic accounts for this.
* **String Comparisons:** If comparing strings, ensure the casing matches, as `${"Active" == "active"}` will return `false`.

## Library
* **Native:** Uses the standard JavaScript `Boolean()` constructor.

## Reference
* [MDN Boolean](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Boolean)
* [Truthy vs Falsy (MDN)](https://developer.mozilla.org/en-US/docs/Glossary/Truthy)

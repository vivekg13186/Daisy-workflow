# log

A fundamental utility plugin used to output messages to the system console or logging service. It is essential for debugging workflows, tracking execution progress, and capturing state information at specific nodes.

## Prerequisites
* **Environment:** No external servers are required. The plugin uses the built-in logging utility of the workflow engine.
* **Access:** You must have access to the stdout/stderr or the log management dashboard of your runner to see the output.

## Inputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `message` | The text content to be logged. | `Processing started...` |
| `level` | The severity level: `debug`, `info`, `warn`, or `error`. | `info` |

## Outputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `message` | The exact message that was logged (useful for passing to the next node). | `Processing started...` |

## Sample workflow
```yaml
name: simple-logger-test
description: |
  A basic workflow demonstrating different log levels and 
  how messages are passed through.

nodes:
  - name: start_info
    action: log
    inputs:
      - message: "Workflow initiated successfully."
      - level: "info"

  - name: warning_check
    action: log
    inputs:
      - message: "Low disk space detected (Mock Warning)"
      - level: "warn"

  - name: debug_data
    action: log
    inputs:
      - message: "Internal state: { id: 101, status: 'active' }"
      - level: "debug"

edges:
  - from: start_info
    to: warning_check
  - from: warning_check
    to: debug_data
```

## Expected output
The plugin returns the message as an object. In the system console, you will see:
`[plugin:log] Workflow initiated successfully.`

The node output data will be:
```json
{
  "message": "Workflow initiated successfully."
}
```

## Troubleshooting
* **Logs not appearing:** Check your global logger configuration. If the system log level is set to `info`, messages sent with the `debug` level will be filtered out and won't appear in the console.
* **Variable Resolution:** If using template strings like `${data.var}`, ensure the variable is defined in the workflow context, otherwise it may log as `undefined`.

## Library
* `../../utils/logger.js` - A local utility module providing leveled logging capabilities.

## Reference
* [Node.js Console API](https://nodejs.org/api/console.html)

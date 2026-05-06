# delay

A simple utility plugin that pauses the workflow execution for a specified duration. This is useful for rate-limiting requests to external APIs, waiting for asynchronous background processes to complete, or introducing intentional gaps between retries.

## Prerequisites
* **No External Dependencies:** This is a logic-only plugin and does not require any external servers or software.

## Inputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `ms` | Duration to sleep in milliseconds (Max: 60,000 / 1 minute). | `5000` |

## Outputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `slept` | The actual amount of time paused in milliseconds. | `5000` |

## Sample workflow
```yaml
name: rate-limited-fetch
description: |
  Fetches data from an API, waits for 2 seconds to respect 
  rate limits, and then performs a second fetch.

nodes:
  - name: first_call
    action: http.request
    inputs:
      - url: "https://api.example.com/data/1"

  - name: wait_step
    action: delay
    inputs:
      - ms: 2000

  - name: second_call
    action: http.request
    inputs:
      - url: "https://api.example.com/data/2"

edges:
  - from: first_call
    to: wait_step
  - from: wait_step
    to: second_call
```

## Expected output
The plugin returns the duration of the sleep after the timer expires:
```json
{
  "slept": 2000
}
```

## Troubleshooting
* **Maximum Duration:** Note that the plugin is capped at 60,000ms (1 minute). For longer delays, consider using a specialized scheduling service or a long-running wait state if supported by your engine.
* **Non-Blocking:** While the node "waits," the underlying Node.js event loop remains free to handle other tasks, but the specific workflow branch will not proceed until the promise resolves.

## Library
* **Native:** Uses the standard JavaScript `setTimeout` wrapped in a Promise.

## Reference
* [MDN setTimeout](https://developer.mozilla.org/en-US/docs/Web/API/setTimeout)

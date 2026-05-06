# http.request

A versatile plugin for performing HTTP/HTTPS requests. It utilizes the native `fetch` API to interact with external web services, APIs, or microservices, returning the response status, headers, and body.

## Prerequisites
To test this plugin, you can use free, reliable mock API services:
* **JSONPlaceholder:** `https://jsonplaceholder.typicode.com/posts` (Great for GET/POST testing).
* **Httpbin:** `https://httpbin.org/post` (Echoes back your request data).

## Inputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `url` | The target URL (must be a valid URI). | `https://api.example.com/v1/data` |
| `method` | HTTP method: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`. | `POST` |
| `headers` | Custom HTTP headers. | `{"Authorization": "Bearer token123"}` |
| `body` | The request payload (String or Object). | `{"title": "foo", "body": "bar"}` |
| `timeoutMs` | Request timeout in milliseconds (max 60000). | `5000` |

## Outputs
| Name | Description | Sample |
| :--- | :--- | :--- |
| `status` | The HTTP response status code. | `200` |
| `headers` | An object containing response headers. | `{"content-type": "application/json"}` |
| `body` | The response data (automatically parsed if JSON). | `{"id": 1, "status": "ok"}` |

## Sample Workflows

### Example 1: HTTP GET (Fetch Data)
```yaml
name: fetch-api-data
nodes:
  - name: get_todo
    action: http.request
    inputs:
      - url: "https://jsonplaceholder.typicode.com/todos/1"
      - method: "GET"
    outputs:
      - status: httpCode
      - body: todoData

  - name: log_result
    action: log
    executeIf: "${httpCode == 200}"
    inputs:
      - message: "Fetched Todo: ${todoData.title}"
```

### Example 2: HTTP POST (Send JSON Data)
```yaml
name: submit-json-data
description: |
  Sends a JSON payload to a REST API. The plugin automatically 
  stringifies object inputs and sets the Content-Type to application/json.

nodes:
  - name: create_post
    action: http.request
    inputs:
      - url: "https://jsonplaceholder.typicode.com/posts"
      - method: "POST"
      - headers:
          Authorization: "Bearer MY_SECRET_TOKEN"
      - body:
          title: "Workflow Automation"
          body: "This post was created via the http.request plugin."
          userId: 1
    outputs:
      - status: responseStatus
      - body: responseBody

  - name: verify_creation
    action: log
    executeIf: "${responseStatus == 201}"
    inputs:
      - message: "Success! New Resource ID: ${responseBody.id}"
```

## Expected output (POST Success)
A successful POST to a REST API typically returns a `201 Created` status:
```json
{
  "status": 201,
  "headers": {
    "content-type": "application/json; charset=utf-8"
  },
  "body": {
    "title": "Workflow Automation",
    "body": "This post was created via the http.request plugin.",
    "userId": 1,
    "id": 101
  }
}
```

## Troubleshooting
* **Timeout Error:** If the server doesn't respond within `timeoutMs`, the request is aborted. Increase the timeout or check server health.
* **JSON Parsing:** The plugin attempts to parse the body as JSON. If the response is plain text or HTML, it will return the raw string instead.
* **CORS/Network Issues:** Ensure the runner has outbound internet access and isn't blocked by a firewall or proxy.

## Library
* `Native Fetch API` - Built-in Node.js fetch capability.
* `AbortController` - Used for managing request timeouts.

## Reference
* [MDN Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API)
* [HTTP Status Codes Reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status)

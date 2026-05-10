# agent

Run a stored LLM agent against an input text and return a parsed JSON
result. Each agent is a named persona — a system prompt + a stored
`ai.provider` configuration — managed from the Home page → Agents.
Multiple workflow nodes can reference the same agent by title; you only
manage the prompt + credentials in one place.

## Prerequisites

* **An `ai.provider` configuration**:
  1. Home → **Configurations** → **+ New** → type **AI provider**.
  2. Fill in `provider` (anthropic / openai), `apiKey` (encrypted at rest), `model`, optional `baseUrl` for an alternate endpoint.
  3. Save.
* **An agent**:
  1. Home → **Agents** → **+ New**.
  2. Set **Title** (this becomes the lookup key for the plugin), pick the **AI provider config** you created, write a **System prompt** (markdown supported, with edit / split / preview modes).
  3. Save.

The system prompt is what the agent **is** — instructions, output schema, examples. The plugin's `input` field is what the agent **gets to look at** — the text passed into a fresh user message on every call.

## Inputs

| Name | Description | Sample |
| :--- | :--- | :--- |
| `agent` | Required. Title of a stored agent (case-sensitive). | `Sentiment Analyser` |
| `input` | Required. Text passed to the agent. Usually a `${var}` reference to an upstream node's output. Renders as a textarea in the property panel. | `${reviewText}` |
| `maxTokens` | Optional. Upper bound on the model's response length. Default `2048`, max `16000`. | `1024` |

## Outputs

| Name | Description | Sample |
| :--- | :--- | :--- |
| `result` | Parsed JSON object/array the agent emitted, or `null` if the response wasn't JSON. The plugin tolerates a leading/trailing fenced code block (e.g. ```` ```json … ``` ````) before parsing. | `{ "sentiment": "positive", "confidence": 0.92 }` |
| `confidence` | 0–1 score plucked from `result.confidence` (also accepts 0–100, normalised to 0–1). `null` if absent or non-numeric. | `0.92` |
| `raw` | Full text response from the model — handy when JSON parsing fails. | `"I think this is positive."` |
| `usage` | `{ inputTokens, outputTokens }` reported by the provider. | `{ "inputTokens": 412, "outputTokens": 38 }` |

`primaryOutput`: `result`. Set the node-level **outputVar** (or map `result → <var>` in the Outputs panel) to expose the parsed JSON to downstream nodes.

## Sample workflow

A two-node flow that reads a customer review from the run input, asks
an agent to classify sentiment, and logs the result.

```json
{
  "name": "review-sentiment",
  "description": "Classify a customer review's sentiment via the Sentiment Analyser agent.",
  "data": {
    "reviewText": "The shipping was fast but the box arrived dented."
  },
  "nodes": [
    {
      "name": "classify",
      "action": "agent",
      "inputs": {
        "agent": "Sentiment Analyser",
        "input": "${data.reviewText}"
      },
      "outputs": { "result": "sentiment" }
    },
    {
      "name": "log_outcome",
      "action": "log",
      "inputs": {
        "message": "Review sentiment: ${sentiment.sentiment} (confidence: ${sentiment.confidence})"
      }
    }
  ],
  "edges": [
    { "from": "classify", "to": "log_outcome" }
  ]
}
```

A typical system prompt for the **Sentiment Analyser** agent:

````md
# Role
You are a sentiment analyser for customer reviews. Stay neutral; report
exactly what the text says, not what you'd hope a customer said.

## Output

Respond **only** with a JSON object matching this schema:

```json
{
  "sentiment":  "positive | neutral | negative",
  "confidence": <number from 0 to 1>,
  "highlights": ["short phrase 1", "short phrase 2"]
}
```

No prose, no preamble, no closing remarks — just the JSON.
````

## Expected output

```json
{
  "result": {
    "sentiment":  "neutral",
    "confidence": 0.78,
    "highlights": ["fast shipping", "box arrived dented"]
  },
  "confidence": 0.78,
  "raw": "{\n  \"sentiment\": \"neutral\",\n  \"confidence\": 0.78,\n  \"highlights\": [\"fast shipping\", \"box arrived dented\"]\n}",
  "usage": { "inputTokens": 412, "outputTokens": 64 }
}
```

## Patterns

### Reuse one agent across many nodes

Define the agent once; reference it from every node that needs it.
Editing the prompt in one place updates every node automatically — no
duplicated SYSTEM blocks scattered across workflows.

### Branch on the agent's confidence

`executeIf` accepts FEEL, so you can gate a downstream node by the
agent's reported confidence:

```json
{
  "name": "alert_human",
  "action": "email.send",
  "executeIf": "${nodes.classify.output.confidence < 0.6}",
  "inputs": { "config": "ops-mail", "to": "ops@example.com", "subject": "Low-confidence review", "text": "..." }
}
```

### Fall back when the agent doesn't emit JSON

`result` is `null` when parsing fails. Combine that with `onError: continue`
on the agent node, then branch downstream on `result == null` to log the
`raw` text for human review:

```json
{
  "name": "log_unparseable",
  "action": "log",
  "executeIf": "${nodes.classify.output.result = null}",
  "inputs": { "message": "Agent didn't return JSON — raw response: ${nodes.classify.output.raw}" }
}
```

## Troubleshooting

* **`no agent titled "<title>"`.** Either the agent doesn't exist or the title is misspelled. The plugin's `agent` input matches the agent's **Title** verbatim (case-sensitive, spaces preserved). Open Home → Agents and check the row.
* **`config "<name>" not found`.** The agent row references an `ai.provider` config that no longer exists. Re-open the agent in the editor and pick a current configuration.
* **`config "<name>" has no apiKey set` / `has no model set`.** The linked configuration is incomplete. Open Home → Configurations and fill in the required fields.
* **`anthropic: 401` / `openai: 401`.** Bad API key. The error message includes which provider rejected. The configurations page hides the saved key — re-paste it through Edit to rotate.
* **`result` always `null`, `raw` has prose.** The model is responding with explanation around the JSON. Tighten the system prompt: "Respond **only** with a JSON object. No preamble, no closing remarks." Few-shot examples help.
* **`confidence` is always `null`.** Either the agent isn't emitting a `confidence` key, or it's emitting a non-numeric value. The plugin reads only `parsed.confidence`; nested keys (`scores.confidence`, etc) are not auto-discovered.
* **Truncated JSON, parse fails.** The model hit `maxTokens` mid-response. Bump `maxTokens` on the node, or shorten the prompt / input.

## Library

* `fetch` — calls Anthropic Messages or OpenAI Chat Completions directly.
* `../agent/util.js` — provider dispatch, JSON parsing, confidence extraction, agent + config lookup.

## Reference

* [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)
* [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat)

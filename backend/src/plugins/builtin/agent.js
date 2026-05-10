// agent — run a stored LLM agent against an input text.
//
// Each agent row pairs a system prompt with a stored ai.provider config.
// This plugin sends that prompt + the workflow's `input` text to the
// configured provider and parses the response as JSON.
//
// Output shape (fixed wrapper):
//   {
//     result:     <parsed JSON object | array | null>,
//     confidence: <number 0–1 | null>,    // pulled from parsed.confidence if present
//     raw:        <full text response>,
//     usage:      { inputTokens, outputTokens }
//   }
//
// `result` is null when the model didn't emit JSON (or emitted invalid
// JSON). Downstream nodes can branch on that via executeIf.

import { loadAgent, callProvider, tryParseJson, extractConfidence } from "../agent/util.js";

export default {
  name: "agent",
  description:
    "Invoke a stored LLM agent. The `agent` input names a configured agent " +
    "(Home page → Agents). The `input` is the user-facing text passed to " +
    "the agent's prompt; the response is JSON-parsed and returned as " +
    "`result` along with a confidence score, the raw text, and token usage.",

  inputSchema: {
    type: "object",
    required: ["agent", "input"],
    properties: {
      agent: {
        type: "string",
        title: "Agent",
        minLength: 1,
        description: "Title of a stored agent. Manage from the Home page → Agents.",
      },
      input: {
        type: "string",
        title: "Input",
        format: "textarea",
        description:
          "Text passed to the agent. Usually a `${var}` reference to an " +
          "upstream node's output.",
      },
      maxTokens: {
        type: "integer",
        title: "Max output tokens",
        minimum: 1, maximum: 16000, default: 2048,
        description: "Upper bound on the model's response length.",
      },
    },
  },

  // What ctx[outputVar] receives when the node-level outputVar is set.
  primaryOutput: "result",

  outputSchema: {
    type: "object",
    required: ["raw", "usage"],
    properties: {
      result:     {                        description: "Parsed JSON the agent emitted, or null if the response wasn't JSON." },
      confidence: { type: ["number","null"], description: "0–1 score the agent emitted under `confidence`, normalised. Null if absent." },
      raw:        { type: "string",        description: "Full text response from the model." },
      usage: {
        type: "object",
        properties: {
          inputTokens:  { type: "integer" },
          outputTokens: { type: "integer" },
        },
      },
    },
  },

  async execute(input, ctx) {
    const { agent, cfg } = await loadAgent(ctx, input.agent);
    const { text, usage } = await callProvider({
      cfg,
      system:    agent.prompt,
      userText:  String(input.input ?? ""),
      maxTokens: input.maxTokens || 2048,
    });
    const parsed     = tryParseJson(text);
    const confidence = extractConfidence(parsed);
    return {
      result:     parsed,
      confidence,
      raw:        text,
      usage,
    };
  },
};

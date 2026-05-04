import { getTransport, defaultFrom } from "../email/util.js";

// String-or-array-of-strings — used for to / cc / bcc.
const stringList = {
  oneOf: [
    { type: "string" },
    { type: "array", items: { type: "string" } },
  ],
};

export default {
  name: "email.send",
  description: "Send an email via SMTP. Defaults to the SMTP_* env vars; pass `smtp: { host, port, secure, user, pass }` per-call to override. Set SMTP_HOST=json (or pass smtp.host=json) for a dry-run that doesn't actually send.",
  inputSchema: {
    type: "object",
    required: ["subject"],
    properties: {
      to:        stringList,
      cc:        stringList,
      bcc:       stringList,
      from:      { type: "string" },
      replyTo:   { type: "string" },
      subject:   { type: "string", minLength: 1 },
      text:      { type: "string" },
      html:      { type: "string" },
      headers:   { type: "object", additionalProperties: { type: "string" } },
      attachments: {
        type: "array",
        items: {
          type: "object",
          // Either inline `content` (string or base64) or a `path` to a local file.
          properties: {
            filename:    { type: "string" },
            content:     { type: "string" },
            path:        { type: "string" },
            contentType: { type: "string" },
            encoding:    { type: "string" },                  // e.g. "base64"
            cid:         { type: "string" },                  // for inline images
          },
        },
      },
      // Per-call SMTP override.
      smtp: {
        type: "object",
        properties: {
          host:   { type: "string" },
          port:   { type: "integer", minimum: 1, maximum: 65535 },
          secure: { type: "boolean" },
          user:   { type: "string" },
          pass:   { type: "string" },
        },
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["messageId"],
    properties: {
      messageId: { type: "string" },
      accepted:  { type: "array" },
      rejected:  { type: "array" },
      response:  { type: "string" },
      envelope:  { type: "object" },
      // Present in dry-run (jsonTransport) mode — the rendered MIME message
      // as a JSON string. Useful for tests.
      preview:   { type: "string" },
    },
  },

  async execute(input) {
    if (!input.to && !input.cc && !input.bcc) {
      throw new Error("email.send requires at least one of: to, cc, bcc");
    }
    if (!input.text && !input.html) {
      throw new Error("email.send requires either `text` or `html`");
    }
    const from = input.from || (input.smtp?.user) || defaultFrom();
    if (!from) {
      throw new Error("email.send: no `from` address (set SMTP_FROM or pass input.from)");
    }

    const transport = getTransport(input.smtp);
    const message = {
      from,
      to:          input.to,
      cc:          input.cc,
      bcc:         input.bcc,
      replyTo:     input.replyTo,
      subject:     input.subject,
      text:        input.text,
      html:        input.html,
      headers:     input.headers,
      attachments: input.attachments,
    };

    const info = await transport.sendMail(message);
    return {
      messageId: info.messageId || "",
      accepted:  info.accepted  || [],
      rejected:  info.rejected  || [],
      response:  info.response  || "",
      envelope:  info.envelope  || {},
      // jsonTransport returns the rendered email at info.message (string).
      preview:   typeof info.message === "string" ? info.message : "",
    };
  },
};

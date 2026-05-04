import "dotenv/config";

// AI provider config — supports Anthropic + any OpenAI-compatible API
// (OpenAI itself, Groq, Ollama-with-openai-compat, etc.).
const aiProvider =
  process.env.AI_PROVIDER ||
  (process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai");

const aiDefaults = {
  anthropic: { model: "claude-haiku-4-5-20251001", baseUrl: "https://api.anthropic.com/v1" },
  openai:    { model: "gpt-4o-mini",                baseUrl: "https://api.openai.com/v1" },
};

// .env files happily preserve whitespace, BOMs, surrounding quotes, and \r
// line endings — all of which Anthropic / OpenAI will reject as
// "invalid x-api-key" without any further explanation. Strip them defensively.
function cleanKey(raw) {
  if (!raw) return "";
  let v = String(raw).trim();
  // Strip a single layer of matching quotes if someone pasted   "sk-ant-..."
  if ((v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  // Strip any embedded whitespace (line wraps, accidental spaces).
  v = v.replace(/\s+/g, "");
  return v;
}

const rawAiKey =
  process.env.AI_API_KEY ||
  (aiProvider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) ||
  "";

export const config = {
  env: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || "3000", 10),
  databaseUrl: process.env.DATABASE_URL || "postgres://dag:dag@localhost:5432/dag_engine",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY || "4", 10),
  jwtSecret: process.env.JWT_SECRET || "change-me",

  ai: {
    provider: aiProvider,
    apiKey:    cleanKey(rawAiKey),
    rawKeyLen: rawAiKey.length,                           // for diagnostics
    model:     process.env.AI_MODEL    || aiDefaults[aiProvider]?.model    || "gpt-4o-mini",
    baseUrl:   process.env.AI_BASE_URL || aiDefaults[aiProvider]?.baseUrl  || "https://api.openai.com/v1",
    maxTokens: parseInt(process.env.AI_MAX_TOKENS || "2048", 10),
  },

  // Optional sandbox root for the file/csv/excel plugins. When set, every
  // plugin path is resolved relative to this directory and refuses any value
  // that would escape it. When unset, paths resolve against process.cwd() and
  // the plugins can touch anywhere the worker process has access to — fine
  // for self-hosted single-user setups, dangerous in shared deployments.
  fileRoot: process.env.FILE_ROOT || "",

  // Default SMTP transport for the email.send plugin. Each plugin call may
  // override host/port/secure/user/pass via its `smtp` input.
  // Set SMTP_HOST=json to use the dry-run "JSON transport" — nodemailer just
  // logs the rendered message instead of contacting a server (handy for tests).
  email: {
    host:   process.env.SMTP_HOST   || "",
    port:   parseInt(process.env.SMTP_PORT || "587", 10),
    secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
    user:   process.env.SMTP_USER   || "",
    pass:   process.env.SMTP_PASS   || "",
    from:   process.env.SMTP_FROM   || "",
  },
};

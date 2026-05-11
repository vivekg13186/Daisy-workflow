# Rate limiting

Per-IP, per-user, and per-email request budgets sitting in front of
the API. Backed by the same Redis instance BullMQ uses, so limits
are correct even when the API runs as multiple replicas.

## Why these specific limiters

| Limiter | Where applied | Default | Why it exists |
|---------|---------------|---------|---------------|
| `global` | every request, per IP | 600/min | Catch-all DOS guard — generous enough that legitimate users never hit it. |
| `login` | `/auth/login`, per IP | 10/min | Brute-force a single account from a single host. |
| `loginByEmail` | `/auth/login`, per email | 5/min | Credential-stuffing — same target email from a rotating-proxy farm. |
| `refresh` | `/auth/refresh`, per IP | 30/min | Bound the rate of new JWTs even if someone steals a refresh cookie. |
| `execute` | `POST /graphs/:id/execute`, per user | 60/min | Stop an authenticated user from drowning workers in synthetic runs. |
| `ai` | `/ai/chat` + `/ai/agent/chat`, per user | 30/min | LLM calls cost real money; cap them. |
| `webhook` | `/webhooks/:id`, per (webhook, IP) | 60/min | Public endpoint — limit per-source so one bad caller doesn't starve the others. |

The buckets compose: a request to `/auth/login` is checked against
the global limiter AND both login limiters. Hitting any of them
returns 429 immediately.

## Response shape

When a limiter trips, the API returns:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 47
RateLimit-Limit: 10
RateLimit-Remaining: 0
RateLimit-Reset: 47
content-type: application/json

{
  "error": "RATE_LIMITED",
  "message": "Too many requests. Slow down.",
  "retryAfter": 47
}
```

The frontend's axios layer can match on `error.response.data.error
=== "RATE_LIMITED"` and surface a friendly toast.

## Tuning

Every threshold is env-driven, no code change required:

```bash
RATE_LIMIT_GLOBAL_PER_MIN=600
RATE_LIMIT_LOGIN_PER_MIN=10
RATE_LIMIT_LOGIN_PER_EMAIL_PER_MIN=5
RATE_LIMIT_REFRESH_PER_MIN=30
RATE_LIMIT_EXECUTE_PER_MIN=60
RATE_LIMIT_AI_PER_MIN=30
RATE_LIMIT_WEBHOOK_PER_MIN=60
```

Reasonable starting points for different deployment shapes:

- **Internal-only / small team:** defaults are fine.
- **Public SaaS:** lower `global` to 200, `login` to 5, `loginByEmail`
  to 3, `ai` to 10 — anything higher invites cost overruns and bot
  noise.
- **Trusted partner integrations** hitting webhooks at high volume:
  raise `webhook` to 600 or higher and consider per-webhook overrides
  (see "Per-webhook custom limits" below).

To **disable everything** for tests / debugging:

```bash
RATE_LIMIT_ENABLED=false
```

This makes the middleware a no-op at module load — zero per-request
cost when off.

## Behind a proxy

Without configuration, every request appears to come from your
proxy's IP and the IP-based limits collapse to one shared bucket.
Set `TRUST_PROXY_HOPS` to the number of trusted proxy layers
between the client and the API:

```bash
TRUST_PROXY_HOPS=1            # nginx in front
TRUST_PROXY_HOPS=2            # Cloudflare → LB → API
```

Express's `trust proxy` reads `X-Forwarded-For` and walks N hops
back from the right to find the real client IP. Don't trust more
hops than you actually have — clients can spoof X-Forwarded-For
and you'd be reading attacker-controlled values.

## Behaviour under Redis outage

If Redis goes away, `rate-limit-redis` falls back to "allow." This
is deliberate: a brief Redis blip shouldn't lock everyone out. The
limits resume the moment Redis is back. If you'd rather fail-closed
during Redis outages, swap the limiter's store to in-memory + log a
warning when Redis errors. For most deployments fail-open is the
correct safety bias.

## Per-webhook custom limits (not built)

The current `webhook` limiter applies the same threshold to every
webhook ID. A near-future evolution: read the per-trigger config
field `rateLimitPerMin` and use it for that webhook's bucket — so
a low-volume security alert webhook can stay at 60/min while a
high-volume CRM-event webhook bumps to 6000/min, all from the
trigger config UI. Foundation is in place (the limiter's key
generator already partitions by webhook ID).

## Observability

429s are visible in:

- **Application logs** — every middleware hit is logged by morgan
  with status 429.
- **OTel traces** — the `plugin.<name>` / `workflow.run` spans for
  rejected requests carry the 429 status code.
- **Grafana** — add a panel `count(http_status = 429)` to the
  overview dashboard.

A spike in 429s is usually one of two things:
1. An actual abuser — check the source IPs in the logs.
2. A legitimate user whose use case outgrew the default — bump
   the appropriate env var.

## File map

| File | Role |
|------|------|
| `backend/src/middleware/rateLimit.js` | named limiters + Redis store + bypass logic |
| `backend/src/server.js` | mounts global limiter + sets `trust proxy` |
| `backend/src/api/auth.js` | login + refresh limiters |
| `backend/src/api/graphs.js` | execute limiter |
| `backend/src/api/ai.js` | ai limiters |
| `backend/src/api/webhooks.js` | webhook limiter |
| `backend/test/rate-limit.test.js` | env binding + disabled-mode tests |
| `backend/.env.example` | `RATE_LIMIT_*` + `TRUST_PROXY_HOPS` |

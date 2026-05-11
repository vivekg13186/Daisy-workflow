# TLS edge

Daisy itself doesn't terminate TLS — that's the reverse proxy's
job. This page covers the three deployment shapes operators
actually run and what each one needs to do.

The Daisy backend listens on plain HTTP `:3000`. Cleartext is the
right default *inside* a trusted network (between proxy and app,
between containers in compose, between pods in a k8s namespace).
TLS belongs at the edge — one place to manage certs, one place to
set security headers.

## Scenario A: managed PaaS (Fly / Render / Railway / Heroku)

The platform terminates TLS for you. Your Daisy container exposes
`:3000`, the platform binds `:443` to it, ships modern TLS + HSTS
out of the box. **You don't ship a proxy config.**

Two things to verify:

- `TRUST_PROXY_HOPS=1` in `backend/.env` (matches the platform's
  one-hop edge). Without this, `req.ip` is the proxy and rate
  limiting collapses to one shared bucket.
- The platform sends `X-Forwarded-For` + `X-Forwarded-Proto`. All
  the named PaaS providers do this by default.

## Scenario B: single VM with Docker Compose

Use the bundled `docker-compose.tls.yml` overlay. It adds a Caddy
container that auto-provisions a Let's Encrypt cert and proxies
everything to the backend + frontend.

```bash
# 1. Point DNS at the VM.
# 2. Open 80 + 443 on the firewall.
# 3. Run the overlay:

cd "DAG Engine"
export DAISY_DOMAIN=daisy.example.com
docker compose \
  -f docker-compose.yml \
  -f docker-compose.tls.yml \
  --profile full \
  up -d

# 4. Hit https://daisy.example.com — Caddy provisions the cert on
#    first request (5-10 seconds).
```

Volumes `caddy_data` + `caddy_config` persist cert state across
container recreations.

**Prefer nginx?** Use `deploy/edge/nginx.conf.example` instead.
Same shape, more knobs, more setup work — certbot manages the
cert, nginx serves it. The example file is the live config — drop
it in `/etc/nginx/sites-available/daisy`, `nginx -t && nginx -s
reload`.

## Scenario C: Kubernetes

The ingress controller terminates TLS. Daisy doesn't change. A
minimal Ingress for cert-manager users:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: daisy
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-body-size: "1m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
spec:
  ingressClassName: nginx
  tls:
    - hosts: [daisy.example.com]
      secretName: daisy-tls
  rules:
    - host: daisy.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend: { service: { name: daisy-api,      port: { number: 3000 } } }
          - path: /ws
            pathType: Prefix
            backend: { service: { name: daisy-api,      port: { number: 3000 } } }
          - path: /webhooks
            pathType: Prefix
            backend: { service: { name: daisy-api,      port: { number: 3000 } } }
          - path: /
            pathType: Prefix
            backend: { service: { name: daisy-frontend, port: { number: 80   } } }
```

Set `TRUST_PROXY_HOPS=1` in the Deployment env (ingress-nginx is
one hop). For multi-layer setups (CDN → LB → ingress) bump to 2 or
3 and verify by checking `req.ip` shows the real client.

## The security headers, explained

Both sample configs ship the same five headers:

| Header | Value | Why |
|--------|-------|-----|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Tells the browser to never connect over HTTP again. Once stable, [submit to hstspreload.org](https://hstspreload.org/). |
| `X-Frame-Options` | `DENY` | No one can iframe the app. Prevents clickjacking. |
| `X-Content-Type-Options` | `nosniff` | Browser respects the `Content-Type` header; doesn't try to guess. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | External links get the origin but not the path. |
| `Permissions-Policy` | `geolocation=(), microphone=(), camera=()` | Nothing in Daisy uses these; deny them explicitly. |
| `Content-Security-Policy` | see configs | The big one. Restricts where scripts, styles, images, and WebSocket connections can load from. |

The shipped CSP allows `unsafe-inline` for styles because Vue-Flow
and Quasar emit inline style attributes for dynamic theming. Once
you've audited which inline rules you actually use, you can tighten
this — see [csp-evaluator.withgoogle.com](https://csp-evaluator.withgoogle.com/).

## WebSocket support

Daisy's `/ws` endpoint streams live execution events. Both the
nginx and Caddy samples include the WebSocket-specific stanza
(`Upgrade` / `Connection: upgrade` headers + a long `read_timeout`).
If you're rolling your own proxy config, that's the part most
often missed — without it the Inspector "Live output" panel
silently disconnects after 60s.

## Verifying

```bash
# 1. Cert valid?
curl -vI https://daisy.example.com/ 2>&1 | head -30

# 2. HSTS + other headers present?
curl -sI https://daisy.example.com/ | grep -E 'Strict-Transport|X-Frame|X-Content|Content-Security|Referrer|Permissions'

# 3. WebSocket works? (need wscat / websocat)
TOKEN=$(curl -sX POST https://daisy.example.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"...","password":"..."}' | jq -r .accessToken)
wscat -c "wss://daisy.example.com/ws?executionId=test&access_token=$TOKEN"

# 4. Body-size cap fires?
curl -X POST https://daisy.example.com/api/graphs \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  --data-binary @some-big-file.json
# >1MB → 413 Payload Too Large
```

## Common gotchas

- **`req.ip` is the proxy IP**, not the client. Check
  `TRUST_PROXY_HOPS` matches your actual edge depth. One hop
  for "nginx in front" or "Caddy in front" or "k8s ingress." Two+
  for "Cloudflare → LB → app."
- **WebSocket disconnects after 60s.** The proxy's idle timeout
  is killing the long-lived `/ws` connection. Both sample configs
  set a long `read_timeout` — copy that pattern if you write your
  own.
- **CSP blocks the chat UI / live-output streaming.** The shipped
  CSP allows `connect-src 'self' wss:` which is correct for same-
  origin WS. If you proxy to a different hostname for the API,
  add it explicitly.
- **HSTS is sticky.** Once a browser caches HSTS for a domain you
  can't go back to HTTP without users clearing site data. Start
  with `max-age=300` (5 min) during testing, bump to a year once
  you're sure.

## File map

| File | Role |
|------|------|
| `deploy/edge/nginx.conf.example` | nginx config — full edge, certbot-friendly |
| `deploy/edge/Caddyfile.example` | Caddy config — auto-HTTPS, simpler |
| `docker-compose.tls.yml` | Caddy overlay for the bundled docker stack |
| `backend/.env.example` | `TRUST_PROXY_HOPS` documented next to rate limits |

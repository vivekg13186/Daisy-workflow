# Alerting

Daisy ships five Grafana alert rules out of the box, routed by
severity to PagerDuty / Slack / email. Operators wire their own
webhook URLs and SMTP creds; the rules + routing live in version
control.

## Quick start

```bash
# 1. Set up your notification destinations.
cp observability/alerts/contact-points.example \
   observability/alerts/contact-points.yml
$EDITOR observability/alerts/contact-points.yml     # paste webhook URLs

# 2. (optional) tweak the rules or routing.
$EDITOR observability/alerts/rules.yml
$EDITOR observability/alerts/notification-policies.yml

# 3. Restart Grafana so it re-provisions.
docker compose -f observability/docker-compose.yml restart grafana
```

You can verify the rules loaded in Grafana → **Alerting → Alert
rules**. They should appear under the `Daisy-DAG` folder, all in
the `daisy-dag` group.

## The five default rules

| UID | Severity | Fires when |
|-----|----------|------------|
| `daisy_high_failure_rate` | critical | >10% executions failed in the last 10 minutes (with a traffic floor of 10 to avoid flapping on low volume) |
| `daisy_p99_latency_high`  | warning  | p99 execution duration > 60s over the last 15 minutes |
| `daisy_queue_backlog`     | warning  | >50 executions in `queued` or `running` for 5 minutes |
| `daisy_stale_running`     | critical | An execution row has been `running` for > 30 minutes (usually a crashed worker that didn't get reaped) |
| `daisy_deadman`           | info     | Zero executions created in the last 30 minutes — silence per-workspace if you're not running continuous traffic |

All five query the same Postgres datasource the overview dashboard
already uses. No Prometheus, no extra exporters — the data is
already there.

## Routing

```
severity = critical  → PagerDuty   (oncall-pager contact point)
severity = warning   → Slack       (default-receiver)
severity = info      → Email digest (email-digest, 30-min batched)
```

Configured in `notification-policies.yml`. The route order matters:
the most specific match wins. Anything that doesn't match a child
route falls through to the root receiver (Slack).

`groupWait` / `groupInterval` / `repeatInterval` tuned so:

- Critical alerts page immediately (no waiting for additional alerts)
  and repeat every hour until acknowledged.
- Warnings wait 30 seconds to batch related alerts, then repeat
  every 4 hours.
- Info alerts batch on a 10-minute window and resend at most every
  12 hours — keeps the email-digest channel quiet.

## Wiring the three transports

### Slack

1. In your Slack workspace, **Apps → Incoming Webhooks → Add to a channel**.
2. Copy the webhook URL.
3. Paste into `contact-points.yml`:

```yaml
- uid: slack-warning
  type: slack
  settings:
    url: "https://hooks.slack.com/services/T0XXX/B0XXX/abcdef"
```

4. Restart Grafana.

### PagerDuty

1. In PagerDuty, **Service → Integrations → Add → Events API v2**.
2. Copy the integration key.
3. Paste into `contact-points.yml`:

```yaml
- uid: pagerduty-critical
  type: pagerduty
  settings:
    integrationKey: "abcdef1234567890..."
```

### Email

Email needs SMTP credentials, which live in Grafana's `grafana.ini`
(not in the contact-points YAML). The simplest path: mount a custom
`grafana.ini` into the container.

```yaml
# in observability/docker-compose.yml, under grafana.volumes:
- ./grafana.ini:/etc/grafana/grafana.ini:ro
```

```ini
# observability/grafana.ini
[smtp]
enabled       = true
host          = smtp.example.com:587
user          = postmaster@example.com
password      = "$__file{/etc/grafana/smtp-pass}"
from_address  = alerts@example.com
from_name     = Daisy-DAG Alerts
```

Then in `contact-points.yml`:

```yaml
- uid: email-warning
  type: email
  settings:
    addresses: "ops@example.com;leadership@example.com"
    singleEmail: true
```

## Adding custom rules

Drop a new YAML file under `observability/alerts/`. Grafana picks up
every `*.yml` at boot. The schema is documented at
[grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/file-provisioning/](https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/file-provisioning/).

A minimal extra rule, e.g. "alert when any node is failing
consistently":

```yaml
apiVersion: 1
groups:
  - orgId: 1
    name: daisy-extras
    folder: Daisy-DAG
    interval: 1m
    rules:
      - uid: node_repeated_failure
        title: "Daisy: node failing repeatedly"
        condition: C
        data:
          - refId: A
            relativeTimeRange: { from: 3600, to: 0 }
            datasourceUid: postgres
            model:
              refId: A
              format: table
              rawSql: |
                SELECT node_name, count(*)::int AS failures
                  FROM node_states
                 WHERE status='failed' AND updated_at > NOW() - INTERVAL '1 hour'
                 GROUP BY node_name HAVING count(*) > 10
                 ORDER BY failures DESC LIMIT 1
          - refId: C
            datasourceUid: __expr__
            model:
              refId: C
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [10] }
                  operator: { type: and }
                  query: { params: [A] }
                  reducer: { type: last, params: [] }
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "{{ $labels.node_name }} failed >10× in the last hour"
```

## Silencing

When an alert is firing for a known reason (planned maintenance,
acknowledged incident):

1. Grafana → **Alerting → Silences → New silence**.
2. Match by label (e.g. `alertname = "Daisy: high execution failure rate"`).
3. Set duration; Grafana auto-expires the silence after.

Or via CLI / API if you need to script it — Grafana's HTTP API
has `/api/alertmanager/grafana/api/v1/silences`.

## When you should write your own rules instead of the defaults

The shipped rules are designed for "self-hosted production-grade
single-tenant Daisy with continuous-ish traffic." If your shape
differs, tune:

- **Low-volume workspaces** — the deadman rule fires constantly;
  silence it or raise its window from 30m to 24h.
- **High-volume workspaces** — `queue_backlog` at 50 is too tight;
  bump to 500 or compute against the historical p95 of in-flight.
- **Multi-tenant** — add `WHERE workspace_id = '...'` clauses and
  duplicate rules per workspace. Or build one rule with a `GROUP
  BY workspace_id` and let Grafana fan out the alert.

## File map

| File | Role |
|------|------|
| `observability/alerts/rules.yml` | 5 default rules |
| `observability/alerts/notification-policies.yml` | severity → contact-point routing |
| `observability/alerts/contact-points.example` | template — copy + fill in |
| `observability/alerts/contact-points.yml` | real config (gitignored) |
| `observability/alerts/.gitignore` | excludes contact-points.yml |
| `observability/docker-compose.yml` | mounts `alerts/` into Grafana |

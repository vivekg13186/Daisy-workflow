# Schedule Trigger Guide

The **Schedule Trigger** is the heartbeat of many automated workflows. It allows you to run logic at specific times using standardized **Cron** expressions or simple fixed **intervals**.

---

## 1. Trigger Configuration

The trigger supports two primary modes. You must provide exactly one of the following:

### Mode A: Cron Expression
Used for complex scheduling (e.g., "Every Monday at 8:00 AM" or "Every 5 minutes").
* **Config:** `{ cron: "0 */5 * * * *" }`
* **Optional:** `{ timezone: "UTC" }` (Defaults to system time).

### Mode B: Interval
Used for simple, repetitive tasks regardless of the clock time.
* **Config:** `{ intervalMs: 60000 }` (Runs every 60 seconds).

---

## 2. Understanding Cron Syntax
The trigger uses the `croner` format, which supports six fields (seconds are optional but supported).

| Field | Range |
| :--- | :--- |
| **Seconds** | 0-59 |
| **Minutes** | 0-59 |
| **Hours** | 0-23 |
| **Day of Month** | 1-31 |
| **Month** | 1-12 |
| **Day of Week** | 0-7 (0 or 7 is Sunday) |

### Common Cron Examples:
* `*/15 * * * * *` : Every 15 seconds.
* `0 0 12 * * *` : Every day at noon.
* `0 0 9 * * 1` : Every Monday at 9:00 AM.
* `0 30 8 1 * *` : The first day of every month at 8:30 AM.

---

## 3. Workflow Example: Database Cleanup
This workflow runs every night at midnight to delete old logs from a PostgreSQL database.

```yaml
name: nightly-db-cleanup
description: Deletes logs older than 30 days every night at midnight.

trigger:
  action: schedule.trigger
  config:
    cron: "0 0 0 * * *"
    timezone: "America/New_York"

nodes:
  - name: delete_old_logs
    action: sql.execute
    inputs:
      - connectionString: "${process.env.DB_URL}"
      - query: "DELETE FROM logs WHERE created_at < NOW() - INTERVAL '30 days'"

  - name: notify_completion
    action: log
    inputs:
      - message: "Cleanup job fired at ${trigger.payload.firedAt}. Records cleared."

edges:
  - from: delete_old_logs
    to: notify_completion
```

---

## 4. Troubleshooting Steps

### A. Trigger Not Firing (Cron)
* **Verify Syntax:** Use a tool like [CronHub](https://cronhub.io/how-to-setup-cron-job) to validate your expression.
* **Check Timezone:** If your server is in UTC and you expect the job to run in EST, it will fire 5 hours "early." Explicitly set the `timezone` config.

### B. Interval Drifting
* **Mechanism:** The `intervalMs` uses `setInterval`. While reliable for most tasks, it does not guarantee millisecond precision if the system is under heavy CPU load.

### C. Overlapping Executions
* **Warning:** If your workflow takes 10 minutes to run but your trigger fires every 5 minutes, you will have multiple instances of the workflow running simultaneously. Ensure your logic (like database locks) handles concurrency or increase the interval.

---

## Technical Reference: Payload Structure
When the trigger fires, it passes the following context:
* `firedAt`: The actual ISO timestamp when the execution started.
* `scheduledFor`: The ISO timestamp of when the job was *supposed* to run (Cron only).
* `kind`: Either `"cron"` or `"interval"`.

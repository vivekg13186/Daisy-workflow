# Jira plugins for Daisy-workflow

This folder originally hosted a single `jira` plugin with an `operation`
discriminator. We've split it into a **family of focused plugins** — one
node per action — to match Daisy's convention (cf. `csv.read` / `csv.write`).
Each lives in its own folder and ships as its own Docker image:

| Plugin (Daisy node) | Folder | Default port |
|---|---|---|
| `jira.issue.get`         | `../jira-issue-get/`         | 8080 |
| `jira.issue.create`      | `../jira-issue-create/`      | 8080 |
| `jira.issue.update`      | `../jira-issue-update/`      | 8080 |
| `jira.issue.search`      | `../jira-issue-search/`      | 8080 |
| `jira.issue.comment.add` | `../jira-issue-comment-add/` | 8080 |
| `jira.issue.transition`  | `../jira-issue-transition/`  | 8080 |

## Auth (shared across all six)

All six plugins read a **single workspace `generic` config** that holds the
Jira Cloud credentials:

| Key        | Example                          | Notes                              |
|------------|----------------------------------|------------------------------------|
| `host`     | `https://acme.atlassian.net`     | No trailing slash. Required.       |
| `email`    | `you@example.com`                | Atlassian account email. Required. |
| `apiToken` | `ATATT3xFf…`                     | Create at id.atlassian.com → Security → API tokens. Required. |

The config's **name** can be anything (default expected: `jira`). Override
it per node via the `config` input if you have multiple Jira instances.

## Install

For each plugin you want available in your workflows:

```bash
# Build (once per plugin folder)
docker build -t daisy-jira-issue-get      -f plugins-external/jira-issue-get/Dockerfile      .
docker build -t daisy-jira-issue-create   -f plugins-external/jira-issue-create/Dockerfile   .
docker build -t daisy-jira-issue-update   -f plugins-external/jira-issue-update/Dockerfile   .
docker build -t daisy-jira-issue-search   -f plugins-external/jira-issue-search/Dockerfile   .
docker build -t daisy-jira-issue-comment  -f plugins-external/jira-issue-comment-add/Dockerfile .
docker build -t daisy-jira-issue-trans    -f plugins-external/jira-issue-transition/Dockerfile  .

# Or in one shot via docker-compose
docker compose -f docker-compose.yml -f docker-compose.plugins.yml --profile jira up -d

# Then register each with Daisy (admin token required)
npm run install-plugin -- --endpoint http://jira-issue-get:8080
npm run install-plugin -- --endpoint http://jira-issue-create:8080
npm run install-plugin -- --endpoint http://jira-issue-update:8080
npm run install-plugin -- --endpoint http://jira-issue-search:8080
npm run install-plugin -- --endpoint http://jira-issue-comment-add:8080
npm run install-plugin -- --endpoint http://jira-issue-transition:8080
```

## ADF (Atlassian Document Format)

Jira Cloud REST v3 requires comment / description bodies in ADF, not plain
text. Each plugin transparently wraps plain-text inputs in a minimal ADF
document. If you already have an ADF object, pass it as JSON and it'll be
forwarded as-is.

## Why six containers and not one?

It's a clean isolation boundary: a bug in `issue.create` can't crash
`issue.get`. Each plugin's manifest only lists the inputs it actually
uses, so the Daisy canvas property panel stays focused. The Docker
overhead is small (~20MB each at idle) and you can deploy only the
actions you actually need.

# Daisy-workflow: A Workflow Engine That Sits Between Temporal and zappier

*The middle ground between programmable workflows and visual workflow editors.*

---

Most workflow tools force a choice.

On one side: code-first engines like Temporal and Prefect. Workflows are real programs in real languages. They scale, they're durable, and they're great. But the moment your support team wants to tweak a step in the triage workflow, you're back to a code review and a deploy.

On the other side: canvas-first SaaS like zappier and n8n. Anyone can drag boxes around. But the moment you need a step that isn't already in the catalog, a deployment that isn't somebody else's cloud, or audit logs your security team will accept, you've hit a wall.

Daisy is what came out of trying to live in the middle.

It runs visual workflows that an operations person can author end-to-end, but the workflow is also a clean JSON file that engineers can review in pull requests. It ships with the integrations you'd expect — HTTP, SQL, email, MQTT, CSV, web scraping, AI agents — and you can add your own in any programming language. It has all the boring grown-up features (auth, multi-tenant workspaces, audit logs, encrypted secrets, observability) baked in from day one.

This post is a tour of what makes it interesting if you're picking a workflow engine in 2026.

![The home page — Workflows, Triggers, Configurations, all in one place](./screenshots/workflows.png)

---

## From a sentence to a working workflow

Let me show you how this feels in practice.

Imagine you're running a small e-commerce shop. Customers email questions to a shared inbox, and you'd like to triage and respond to them every morning — automatically where you can, with a human in the loop where you can't.

The shape of the automation is two workflows talking to each other:

- **Inbox Reader** wakes up at 8am, scans new emails in the support inbox, decides whether each one is a customer question, and — if it is — kicks off a separate workflow per email.
- **Query Handler** shows the email content to a human, waits for them to type a reply, and sends the reply back to the customer.

You could build that on the canvas, dragging boxes around. Or you can let the AI assistant build it for you.

In the editor, create a new workflow called **Inbox Reader** and paste this into the Prompt tab:

> Create a trigger to read emails every day at 8am from the support inbox. For each new email, identify the intent. If it looks like a customer query, start the "Query Handler" workflow with the email content.

A few seconds later you have a working workflow: an email trigger wired to an LLM step that classifies the intent, branching into a node that fires the second workflow when appropriate. You can save it as-is, or open the canvas to tweak any step before saving.

For **Query Handler**, paste this:

> Show the email content to a human, let them type a response, then send that response to the customer via email.

You get a workflow with a user-task step (the workflow pauses until a human responds via the UI) followed by an email send. The assistant knows about Daisy's actual plugin catalog, so it doesn't invent actions that don't exist.

Two paragraphs of plain English, two working workflows. The same workflows are JSON files you can diff in git, paste into Slack, or hand to a colleague who imports them into their own Daisy on the other side of the world.

![The visual designer renders the same workflow as an interactive graph](./screenshots/workflow_designer.png)

---

## What's in the box

Daisy ships with the integrations a typical workflow actually needs:

- **Triggers:** schedule (cron / interval), HTTP webhook, IMAP email, MQTT subscribe.
- **Nodes:** HTTP requests, SQL on any Postgres / MySQL / SQLite, email send, MQTT publish, file / CSV / Excel read+write, web scraping, transformations, conditional branching, batch fan-out, retries, and a user-task step for human-in-the-loop pauses.
- **AI:** named LLM personas you can call from any step, the prompt-to-workflow assistant shown above, a diagnose-this-failure button on every failed run, and a plugin-generator agent that can write new plugins for you from an English description.

When the catalog doesn't have what you need, you write a plugin. Plugins don't have to be in Node — they're small services that speak a four-endpoint HTTP contract, so you can author them in **any** language. Python, Go, Rust, PHP, whatever fits the job.

And if writing the plugin yourself sounds like work, the **Ask Agent** button on the Plugins page will write one for you. Describe what you want — *"a plugin that takes a list of URLs and returns each page's title"* — and the agent produces a complete project ready to drop into a folder and `docker build`. You review it, deploy it, install it.

---

## The grown-up stuff

Most of the value of a workflow engine isn't the engine — it's the layer of operational features around it that make it safe to run in production. Daisy includes these from day one:

- **Authentication and roles** — local accounts plus OIDC single sign-on, three roles (admin / editor / viewer).
- **Multi-tenant workspaces** — one installation hosts many logical tenants, with their own workflows, triggers, secrets, and runs.
- **Encrypted secrets** — credentials stored with envelope encryption (per-row data keys wrapped by a master key in your KMS).
- **Audit log** — who did what, when, on which resource. Searchable from an admin page.
- **Observability** — OpenTelemetry traces over every workflow + step + plugin call, plus a Grafana / Prometheus / Loki stack with five default alert rules.
- **Operational simplicity** — runs on Postgres + Redis + a Node process. Ships pre-built Docker images for both production and dev variants.

The trade-off is a slightly larger codebase than a minimum-viable workflow runner. I think that's the right trade. Most teams discover they needed audit logs six months after they should have built them.

---

## When Daisy isn't the right tool

Honesty: it's not Temporal. There's no deterministic replay across server crashes. Long-running workflows that pause for thirty days will hold worker resources. If you need millions of concurrent workflows or cross-region failover, you're shopping in a different aisle.

Pick Daisy when:

- Non-engineers will author or own workflows.
- Triggers come from the outside world (HTTP, email, MQTT) — not only the clock.
- You want AI-driven authoring and diagnosis as first-class features.
- Operational simplicity matters — Postgres, Redis, one Node process.
- You want to paste a workflow into Slack and have someone import it on their machine.

Pick something else when:

- Workflows span days or weeks with strict crash-recovery guarantees → **Temporal**.
- You need exactly-once side effects under arbitrary failure modes → **Temporal**.
- Your team is Python-first and treats workflows as code in a repo → **Prefect**.
- You only ever orchestrate shell scripts on one machine → **Dagu** is lighter.

---

## Try it

It's open source. The fastest way to try it is one command:

```bash
git clone https://github.com/vivekg13186/Daisy-workflow.git
cd Daisy-workflow
BACKEND_IMAGE=vivek13186/daisy-workflow-backend:latest \
FRONTEND_IMAGE=vivek13186/daisy-workflow-frontend:latest \
  docker compose --profile full up -d

docker compose exec backend npm run migrate
docker compose exec backend npm run create-admin
```

Open `http://localhost:5173`, sign in with the admin you just created, and click **+ New flow**. Try pasting one of the two prompts from earlier in this post — that's the fastest way to see what authoring feels like.

If you build a workflow with it — especially a weird one — I'd love to see it.

**Source:** <https://github.com/vivekg13186/Daisy-workflow>
**Wiki:** <https://github.com/vivekg13186/Daisy-workflow/wiki>
**Plugin SDK on npm:** <https://www.npmjs.com/package/@daisy-workflow/plugin-sdk>

---

*Tags: workflow-automation, devops, open-source, no-code, ai-tools, javascript*

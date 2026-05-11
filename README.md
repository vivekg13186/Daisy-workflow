# DAISY Workflow Engine


This project is a modular workflow engine where workflows are defined as DAGs (Directed Acyclic Graphs).

Each workflow is defined using a simple YAML-based DSL, can be visually designed, and is executed by a runtime engine that manages dependencies, scheduling, and node execution.

[more docs here](./wiki/README.md)


## News

### 10 May 2026
- Transition from code/YAML-based workflow definition to a visual editing experience.

- Replace YAML with JSON for better alignment with JavaScript ecosystems and tooling.

- Feelin expression system for building and evaluating logic.

- Improve and refine AI prompting mechanisms for better workflow generation and assistance.

- Enhance and expand flow trigger capabilities for more flexible workflow execution events


## Features


### Triggers
- Email (SMTP)
- Scheduled triggers (cron-like)
- MQTT events
- Webhook triggers

### Plugins

#### Core
- [Agent](./wiki/plugins/agent.md)
- [Condition](./wiki/plugins/condition.md)
- [Delay](./wiki/plugins/delay.md)
- [Transform](./wiki/plugins/transform.md)
- [Log](./wiki/plugins/log.md)

#### File System
- [Read](./wiki/plugins/file_read.md)
- [Write](./wiki/plugins/file_write.md)
- [List](./wiki/plugins/file_list.md)
- [Stat](./wiki/plugins/file_stat.md)
- [Delete](./wiki/plugins/file_delete.md)

#### CSV
- [Read](./wiki/plugins/csv_read.md)
- [Write](./wiki/plugins/csv_write.md)

#### Excel
- [Read](./wiki/plugins/excel_read.md)
- [Write](./wiki/plugins/excel_write.md)

#### Network
- [HTTP requests](./wiki/plugins/http_request.md)
- [Web scraping](./wiki/plugins/web_scrape.md)

#### Database
- [Select](./wiki/plugins/sql_select.md)
- [Insert](./wiki/plugins/sql_insert.md)
- [Update](./wiki/plugins/sql_update.md)
- [Delete](./wiki/plugins/sql_delete.md)
- [Execute queries](./wiki/plugins/sql_execute.md)

---

## UI

![Home Page](./images/home_page.png)
![Flow Inspector](./images/flow_inspector.png)
![Instance View](./images/instance_view.png)
![Prompt View](./images/ai_prompt.png)
![Flow Editor](./images/flow_editor.png)


---


Built as a personal exploration of workflow engines, automation systems, and DAG-based execution models.





 

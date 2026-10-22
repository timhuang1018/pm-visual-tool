# Data model, analysis and API

## `plan.json`

One file describes everything. `pmv import` creates or updates by `id`, all or nothing.

```jsonc
{
  "requirements": [
    // What the owner asked for. Draft until the owner clicks OK. Rewording sends it back to draft.
    { "id": "R-1", "title": "Short rephrase in the owner's terms", "detail": "Concrete: data, source, output, use case", "order": 1, "meta": {} }
  ],
  "groups": [
    // Phases (no parent) and at most one level of sub-groups.
    { "id": "ingest", "name": "Ingest", "goal": "What is true when this is done", "order": 1 },
    { "id": "ingest-api", "name": "API client", "goal": "...", "parent": "ingest", "order": 1 }
  ],
  "tasks": [
    {
      "id": "T-01", "title": "…", "description": "…",
      "group": "ingest-api",            // where it lives
      "requirements": ["R-1"],          // what it serves
      "dependsOn": [],                  // must finish before this one can finish
      "status": "ready",                // ready | in_progress | needs_verification | blocked | done
      "effort": "M", "impact": "L",     // S | M | L
      "gate": "What the owner checks",  // optional owner gate (string, or {description, status})
      "assignee": null,
      "meta": { "repo": "https://…", "rows": 1200 }   // any domain facts: string | number | boolean
    }
  ],
  "labels": [{ "from": "ingest", "to": "model", "label": "raw orders" }],   // text on a link (group or task ids)
  "notes":  [{ "target": "group:ingest", "tone": "deadline", "text": "Due Friday" }]  // info | deadline | risk | decision
}
```

The import rejects unknown ids, groups or requirements, and dependency cycles, with a message that
says what to fix.

### Element references

Comments, notes and change requests point at an element:

| Ref | Element |
|---|---|
| `req:R-1` | requirement |
| `group:<id>` | phase or sub-group |
| `task:T-01` | task |
| `link:<from>><to>` | link between two groups or tasks |
| `note:N-1` | note |
| `view:overview` / `view:all` / `view:<group-id>` | a whole view |

### Comments

| Kind | Who | Closes when |
|---|---|---|
| `change` | owner | the agent applies it and resolves it |
| `directive` (instruction) | owner | the agent resolves it |
| `question` | either | the other side replies |
| `comment` (note) | either | never needs closing |

## Analysis

**Effort points:** S = 1, M = 2, L = 4. The part still left depends on status: ready/blocked 100%,
in progress 60%, needs verification 25%, done 0%.

- **Critical path:** the longest chain of remaining effort through the dependencies. It's what
  decides when everything is done. Tasks on it have zero **slack**.
- **Work order:** what the agent should do first. Tasks are scheduled once their prerequisites
  are, sorted by:
  1. owner pins (a pin also pulls the pinned task's prerequisites forward);
  2. least slack (critical first);
  3. pending gates (early check-ins);
  4. most tasks unlocked;
  5. impact;
  6. least effort.
- **Now:** the top of the work order that isn't blocked, the gates coming up soon, open questions,
  unconfirmed requirements, and what the agents are working on.
- **Progress** of a phase or requirement: 1 − remaining / total effort points of its tasks.

## Plan check

`pmv check` / `GET …/check` flags what makes the chart hard to read:

| Code | Level | Meaning |
|---|---|---|
| `NO_REQUIREMENTS` | warn | Tasks exist but no requirements |
| `NO_PHASES` | warn | More than 9 tasks and no phases |
| `REQ_NO_TASKS` | warn | A requirement nothing serves |
| `TASK_UNGROUPED` / `TASK_UNLINKED` | warn | Tasks with no phase / serving no requirement |
| `TOO_MANY_PHASES` | warn | More than 7 phases |
| `GROUP_TOO_BIG` | warn | More than 9 items in one group |
| `TOO_DEEP` | warn | Nesting below phase → sub-group |
| `NO_EARLY_CHECKIN` | warn | No gate on the first third of the critical path |
| `CHANGE_REQUESTED` | warn | An owner change request is still open |
| `FLOWS_BACK` | info | Work flows from a later phase to an earlier one |
| `LINK_NO_LABEL` | info | A link between phases has no label |
| `GROUP_NO_GOAL`, `EMPTY_GROUP` | info | Group has no goal line / no tasks |
| `REQ_UNCONFIRMED` | info | The owner hasn't confirmed some requirements |

## HTTP API

Base `http://127.0.0.1:<port>/api`. Send `X-Actor: agent:<name>` (or `human:<name>`). JSON in and out.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/health` | `{ok, dataDir, pid}` |
| GET / POST | `/projects` | list / `{id?, name, description?}` |
| GET | `/projects/:pid` | `{project, analysis, structure}` |
| GET | `/projects/:pid/plan.md` | the plan as Markdown (`?limit=N`) |
| GET | `/projects/:pid/check` | plan check items |
| GET | `/projects/:pid/inbox?since=N` | owner requests (each with `about`), owner events, pins, pending gates |
| GET | `/projects/:pid/events?since=N` | event log |
| POST | `/projects/:pid/plan` | `{requirements?, groups?, tasks?, labels?, notes?}` create or update, all or nothing |
| POST / PATCH / DELETE | `/projects/:pid/tasks`, `/tasks/:id` | task, or array of tasks; partial update |
| POST | `/projects/:pid/tasks/:id/approve-gate` | humans only |
| POST / PATCH / DELETE | `/projects/:pid/requirements`, `/requirements/:id` | PATCH `{status:"confirmed"}` is humans only |
| POST / PATCH / DELETE | `/projects/:pid/groups`, `/groups/:id` | |
| PUT | `/projects/:pid/labels` | `{from, to, label}` (`label: null` clears) |
| POST / PATCH / DELETE | `/projects/:pid/notes`, `/notes/:id` | `{target, tone, text}` |
| POST | `/projects/:pid/comments` | `{target, kind, text, replyTo?}`; agents can't post `change`/`directive` |
| POST | `/projects/:pid/comments/:cid/resolve` | |
| PUT | `/projects/:pid/pins` | `{pins: [taskId…]}` |
| WS | `/ws?project=:pid` | pushes `{type:"snapshot", view, event}` on every change |

**Rules enforced by the server:**
- agents cannot approve gates, confirm requirements, or post change requests or instructions;
- `done` is refused while a gate is pending;
- dependency cycles are rejected.

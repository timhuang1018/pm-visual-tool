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

### Backlog rows and proposals

`pmv pull` mirrors chosen rows of the repo's backlog file as tasks whose id is the row id:

```jsonc
{ "id": "BL-102", "title": "Webcast adapter", "status": "in_progress", "impact": "M", "effort": "M",
  "backlog": { "id": "BL-102", "status": "In progress", "brief": "briefs/…md", "keyword": "calls", "mentions": ["BL-101"] } }
```

| Field | Owner |
|---|---|
| `status`, `impact`, `effort`, `backlog` | the backlog file, via `pmv pull`; the server refuses other changes |
| `title`, `group`, `requirements`, `dependsOn`, `gate`, `meta` | the board |

Backlog statuses map to board statuses: Ready, In progress, Needs verification, Blocked, Done as named;
Icebox → blocked, Cancelled → done (the card shows the original word). The project records the files as
`backlog: {files, syncedAt, subtasks?, claims?, problems?}`. When a backlog is linked, an open task with neither
`backlog` nor `subtask` is a **proposal** (*Not synced*). `pmv adopt` turns it into a mirrored row once the
backlog owner has written that row.

### Brief subtasks

A tracked row's brief `## Subtasks` table (format in [cli.md](cli.md#brief-subtasks)) becomes tasks:

```jsonc
{ "id": "T3", "title": "Ranges and open bounds", "status": "ready", "effort": "L", "dependsOn": ["T2"],
  "gate": { "description": "Owner reads the sample", "status": "approved", "approvedBy": "human:owner" },
  "meta": { "estimate": "L" },
  "subtask": { "row": "BL-381", "id": "T3", "status": "Ready", "brief": "docs/briefs/…bl381….md", "estimate": "L", "after": ["BL-487"] } }
```

| Field | Owner |
|---|---|
| `title`, `status`, `impact`/`effort` (when given), `dependsOn`, `gate.description`, `meta.estimate`, `subtask` | the brief's table; the server refuses other changes |
| `group`, `requirements`, `assignee`, other `meta`, `gate.status` (the owner's approval) | the board |

`subtask.after` holds waits-on the board can't draw (rows or subtasks not on it). The project keeps
`backlog.subtasks: [{row, group?}]` (rows shown, and where their new subtasks go), `backlog.claims`
(board-only task id → row: becomes that row's subtask once its table lists the id) and `backlog.problems`
(what the last sync couldn't read or apply).

**Sync.** The server re-reads the backlog files and tracked briefs when the board page loads, on agent reads
(`GET /projects/:pid`, `plan.md`, `brief.md`, `check`), on `POST /sync` and when a watched file changes. It skips
the work when no file changed. Bad data never fails a sync: an unknown status reads as Ready, a waits-on that would
make a cycle is left out, and each becomes a `SYNC_PROBLEM`. A subtask missing from its table stays and is reported.

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
| `BOARD_LARGE` | warn | More than 40 tasks: past a high-level slice |
| `DONE_WAITS_ON_OPEN` | warn | A done task waits on an open one (follow-up linked backwards, or a reopen) |
| `BACKLOG_MENTION` | info | A row's text names another row on the board, with no dependency path between them |
| `NOT_SYNCED` | warn | On a linked board: cards in neither the backlog nor a brief's Subtasks table |
| `SUBTASKS_PENDING` | info | Cards recorded for a row (`pmv subtasks export`) whose brief doesn't list them yet |
| `SYNC_PROBLEM` | warn | Something the last sync couldn't read or apply (missing brief or table, unknown status, cycle, dropped subtask) |
| `GATE_SKIPPED` | warn | A subtask is done in its brief while its owner gate is still pending on the board |

`NO_REQUIREMENTS` and `TASK_UNLINKED` only count board-only tasks; mirrored rows and subtasks are justified by their brief.
`BOARD_LARGE` doesn't count brief subtasks.

## HTTP API

Base `http://127.0.0.1:<port>/api`. Send `X-Actor: agent:<name>` (or `human:<name>`). JSON in and out.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/health` | `{ok, dataDir, pid}` |
| GET / POST | `/projects` | list / `{id?, name, description?}` |
| GET | `/projects/:pid` | `{project, analysis, structure}` |
| GET | `/projects/:pid/plan.md` | the plan as Markdown (`?limit=N`) |
| GET | `/projects/:pid/brief.md?since=N` | short session digest; owner activity after event N |
| GET | `/projects/:pid/proposals.md?ids=a,b` | proposals as ingest cards |
| POST | `/projects/:pid/backlog` | `{files, rows: [{id, title, status, impact?, effort?, brief?, keyword?, mentions?}], group?}` create or refresh mirrored rows |
| POST | `/projects/:pid/tasks/:id/adopt` | a backlog row `{id, status, …}`: link the task to it, renaming it to the row id |
| POST | `/projects/:pid/sync` | re-read the backlog and tracked briefs now: `{created, adopted, changed, problems}` |
| POST | `/projects/:pid/subtasks` | `{files, rows: [{row, group?, claim?: [taskId…]}]}` show rows' Subtasks tables (then syncs) |
| DELETE | `/projects/:pid/subtasks/:row` | stop showing a row's subtasks (removes their cards) |
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
| WS | `/ws?project=:pid` | syncs the documents, then pushes `{type:"snapshot", view, event}` on connect and on every change |

**Rules enforced by the server:**
- agents cannot approve gates, confirm requirements, or post change requests or instructions;
- status and sizing of a mirrored backlog row change only through the backlog file;
- title, status, size, waits-on and gate wording of a brief subtask change only through its Subtasks table;
- `done` is refused while a gate is pending;
- dependency cycles are rejected.

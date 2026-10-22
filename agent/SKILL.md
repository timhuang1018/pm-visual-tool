---
name: pm-visual
description: >-
  Use this skill when the user wants to see, plan, confirm or steer work visually: "show me the
  tasks", "put the plan on a board", "what's the status / what's next", "let me confirm the plan
  before you start", "I want to review the order", or any multi-step job where the user should be
  able to watch progress and redirect it. The agent keeps a live board with the `pmv` CLI;
  the user reads and steers it in the browser.
---

# PM Visual: keep a visual board the user can read and steer

The board turns your plan into a flow chart the user reads **top-down, one level at a time**:

1. **What they asked for**: their requirements, as you rephrased them. They confirm each one with **OK**.
2. **Phases**: 3–7 groups that you choose for this job, each with a one-line goal.
3. **Inside a phase**: its sub-groups or tasks, with links to the neighbouring phases.
4. **Now**: what must happen next, what is waiting on them, and what you are doing.

They answer your questions, approve gates, pin "do this first", and click any element to request a
change. You read all of that with `pmv inbox` and act on it.

```sh
npx pmv init            # once per project: creates .pm-visual/, starts the board, installs this skill
npx pmv open            # prints the board URL; give it to the user
```

Use `PM_ACTOR=agent:<your-name>` so the user sees who did what.
`pmv` is `npx pmv` if it's installed locally (`npm i -D github:timhuang1018/pm-visual-tool`).

## 1. Plan: build the chart from what the user asked and what you know

First **extract the structure** from the user's message, the codebase, docs, data sources and existing jobs.
Then write one `plan.json` and import it. Re-importing updates by id, so refine it freely.

| What | Guidance |
|---|---|
| **Requirements** | One per thing the user wants. `title`: a short rephrase in their terms. `detail`: what it concretely means for the real data, sources, outputs and use case. They stay *draft* until the user clicks OK. Rewording a confirmed one sends it back to draft. |
| **Phases** (`groups` without `parent`) | 3–7, in the order the work or data flows, named for *this* job (e.g. *Sources → Ingest → Process → Serve → UI*, or *Research → Draft → Review → Publish*). `goal` says what is true when the phase is done. `order` sets the reading order. |
| **Sub-groups** (`parent`) | Use them when a phase would show more than 9 items. One level only. |
| **Tasks** | Each has a `group` and the `requirements` it serves. `dependsOn` means "must finish before this one can finish". `effort`/`impact` are S/M/L. |
| **Gates** | `gate: "what the user checks"`. Put a cheap early check-in (a preview, a sample, a draft) before expensive work. |
| **Labels** | Text on a link between phases saying what flows: `"raw orders"`, `"scored claims"`. |
| **Notes** | One-line facts that wrap an element: `deadline`, `risk`, `decision`, `info`. |
| **Meta** | Free-form key/values on any task, group or requirement, for any domain: `{"repo": "https://…", "owner": "Ana", "rows": 1200}`. URLs become links. |

```json
{
  "requirements": [
    { "id": "R-1", "title": "Daily sales data from the shop API", "detail": "Orders and refunds from the Shopify Admin API, pulled nightly into the warehouse" },
    { "id": "R-2", "title": "A weekly revenue dashboard", "detail": "Revenue by product and region, refreshed Monday 08:00, for the sales team" }
  ],
  "groups": [
    { "id": "ingest", "name": "Ingest", "goal": "Orders and refunds land in the warehouse every night", "order": 1 },
    { "id": "model", "name": "Model", "goal": "Clean revenue tables the dashboard can trust", "order": 2 },
    { "id": "ui", "name": "Dashboard", "goal": "The sales team uses it every Monday", "order": 3 }
  ],
  "tasks": [
    { "id": "T-01", "title": "Shopify API client + nightly job", "group": "ingest", "requirements": ["R-1"], "effort": "M" },
    { "id": "T-02", "title": "Sample revenue table for review", "group": "model", "requirements": ["R-2"], "effort": "S",
      "dependsOn": ["T-01"], "gate": "User checks the numbers on one week" },
    { "id": "T-03", "title": "Dashboard page", "group": "ui", "requirements": ["R-2"], "effort": "M", "dependsOn": ["T-02"],
      "meta": { "route": "/reports/revenue" } }
  ],
  "labels": [
    { "from": "ingest", "to": "model", "label": "raw orders & refunds" },
    { "from": "model", "to": "ui", "label": "revenue tables" }
  ],
  "notes": [{ "target": "group:ui", "tone": "deadline", "text": "Needed for the Q3 sales kickoff" }]
}
```

```sh
pmv import plan.json     # all or nothing; prints how many warnings the plan check found
pmv check                # fix warnings until clean; each comes with the command that fixes it
pmv outline              # requirements → phases → tasks, as the user will read it
pmv shot                 # optional: screenshot the overview to check it reads well (needs playwright-core)
```

Then tell the user the board URL (`pmv open`) and ask them to confirm the requirements.

## 2. Work: follow the board's order

```sh
pmv inbox      # user requests first: change requests, instructions, questions, gate approvals, pins
pmv plan       # top-down: requests, requirements, phases, now, work order, critical path, checks
pmv start T-04 # in_progress + assigned to you (the user sees "working")
pmv verify T-04 | pmv done T-04 | pmv block T-04 "waiting on API key"
```

1. Before picking the next task, run `pmv inbox` and `pmv plan`.
2. Order of work: **user requests**, then **pins** (and what they need), then the work order top-down. The order already puts the critical path first.
3. You cannot pass a gate: `pmv done` is refused while it's pending. Ask (`pmv ask T-02 "..."`) and work on something else.
4. Keep statuses current; the user reads the board, not your chat log.
5. New work goes on the board with a phase, requirements and dependencies; don't silently grow a task.

## 3. Change requests: the user edits the chart by pointing at it

`pmv inbox` shows each request together with what the element is now:

```
- [C-7] CHANGE: "Split Store & readers, the reader switch-over is its own milestone"
    about sub-group graph-store "Store & readers" [goal: …; parent graph; order 1]
```

Apply it with the normal commands, for example:

- split a phase: `pmv group add` + `pmv edit T-x --group …`;
- reword a requirement: `pmv req edit`;
- relabel a link: `pmv label`;
- fix a dependency: `pmv edit --deps`;
- add a note: `pmv note`.

Then close it:

```sh
pmv reply C-7 "Split into graph-store and graph-readers; moved T-06, T-25, T-52." --resolve
```

Replying to a user's question answers it, and it closes by itself. Change requests and instructions close
only when you `--resolve` them, so do that once the change is applied.

Element references: `req:R-1` `group:<id>` `task:T-01` `link:<from>><to>` `note:N-2` `view:overview`.

## Reference

`pmv help` lists every command. The HTTP API (`http://127.0.0.1:<port>/api/projects/<id>/…`, with the header
`X-Actor: agent:<name>`) offers the same operations: `plan.md`, `check`, `inbox`, `POST plan`, `tasks`,
`requirements`, `groups`, `labels`, `notes`, `comments`.

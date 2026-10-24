# plan.json and change requests

Read this when you write or restructure a plan. `pmv import plan.json` creates or updates by id,
all or nothing. Re-importing is how you refine.

## What goes in

| What | Guidance |
|---|---|
| **Requirements** | One per thing the user wants. `title`: a short rephrase in their terms. `detail`: what it concretely means for the real data, sources, outputs and use case. They stay *draft* until the user clicks OK. Rewording a confirmed one sends it back to draft. |
| **Phases** (`groups` without `parent`) | 3–7, in the order the work or data flows, named for *this* job (e.g. *Sources → Ingest → Process → Serve → UI*). `goal` says what is true when the phase is done. `order` sets the reading order. |
| **Sub-groups** (`parent`) | Use them when a phase would show more than 9 items. One level only. |
| **Tasks** | Each has a `group` and the `requirements` it serves. `dependsOn` means "must finish before this one can finish" and may name backlog rows on the board (`BL-103`), done ones too. `effort`/`impact` are S/M/L. |
| **Gates** | `gate: "what the user checks"`. Put a cheap early check-in (a preview, a sample, a draft) before expensive work. It becomes the user walkthrough at ingest. |
| **Labels** | Text on a link between phases saying what flows: `"raw orders"`, `"scored claims"`. |
| **Notes** | One-line facts that wrap an element: `deadline`, `risk`, `decision`, `info`. |
| **Meta** | Free-form key/values on any task, group or requirement: `{"repo": "https://…", "owner": "Ana"}`. URLs become links. |

Keep cards abstract: one task is one backlog-sized item, not its subtasks. Subtasks live in the brief.

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

Backlog rows are not written in plan.json: add them with `pmv pull`, then give them a phase and
links with `pmv edit BL-103 --group extract --deps BL-102` (or in plan.json by id, without
`status`, `impact` or `effort`, which the backlog owns).

## Change requests

`pmv inbox` (and `pmv brief`) show each request with what the element is now:

```
- [C-7] CHANGE: "Split Store & readers, the reader switch-over is its own milestone"
    about sub-group graph-store "Store & readers" [goal: …; parent graph; order 1]
```

Apply it with the normal commands:

- split a phase: `pmv group add` + `pmv edit T-x --group …`;
- reword a requirement: `pmv req edit`;
- relabel a link: `pmv label`;
- fix a dependency: `pmv edit --deps`;
- add a note: `pmv note`.

Then close it: `pmv reply C-7 "Split into graph-store and graph-readers; moved T-06, T-25." --resolve`.
Replying to the user's question answers it. Change requests and instructions close only when you
`--resolve` them.

Element references: `req:R-1` `group:<id>` `task:T-01` `link:<from>><to>` `note:N-2` `view:overview`.
The HTTP API (`http://127.0.0.1:<port>/api/projects/<id>/…`, header `X-Actor: agent:<name>`) offers
the same operations; see the package's `docs/data-model.md`.

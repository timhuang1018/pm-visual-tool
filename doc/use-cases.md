# Use cases

Derived from the owner's own words in planning sessions. Each use case says what the owner (or
agent) needs, which part of the UI serves it, and what "good" means. They are simulated end to end
by `tests/ux/scenarios.mjs` with the `ux-walkthrough` skill.

## Who

| Persona | Context | What they care about |
|---|---|---|
| **Owner** | Gives an AI agent requirements in their own words: "I want this data from that source, processed into …, feeding this use case, shown like this in the UI". Checks in between other work. | Did the agent understand me? What are the big pieces? What must happen *now*? Is the order right? Can I steer by pointing at the chart? |
| **AI agent** | Plans and does the work, using the `pm` CLI or the HTTP API. | A structure the owner can read; clear owner instructions; never passing an owner gate. |

## Principles the owner asked for

1. **Top-down, one level at a time**: requirements → phases → sub-groups → tasks. Don't show too much at once.
2. **The owner's input first**: their requirements are always visible and can be traced.
3. **"Now" is explicit**: what must be done next changes as statuses change.
4. **Show, don't pop up**: use colour, border, line style, labels and wrapping notes, not pop-ups that demand reading.
5. **Never lost**: an obvious way back from any level, and an obvious "where am I".
6. **Everything is changeable from the chart**: point at any element and say what should change.
7. **The agent decides the phases**, and the tool guides it to a readable shape.

## Use cases

| ID | Need | Actor | UI that serves it | Good means |
|---|---|---|---|---|
| UC-1 | "Did the agent understand what I asked for?" | Owner | Requirements rail (dashed = the agent's reading), **OK** button, change request on a requirement | Each requirement is visible on the first screen; one click confirms it; one click plus text asks for a rewording |
| UC-2 | Turn the owner's message into a readable plan | Agent | `pm import plan.json`, `pm check`, `pm outline`, AGENTS.md | The plan check is clean; the overview shows 3–7 phases with goals and labelled links |
| UC-3 | See the big picture, then go deeper and come back | Owner | Overview phase cards → click → phase → sub-group; ← Back, breadcrumb, phase strip, Esc | Each level shows at most 9 cards with few words each; going back is 1 click or Esc; the current location is always shown |
| UC-4 | "What must happen now?" | Owner | **Now** panel (waiting on you, must happen next), **Next** tags, critical-path lens | Answered without opening anything; changes when statuses change |
| UC-5 | "Do this first" | Owner → Agent | Pin on a task, pins list (drag), Instruction message | The order on the board and in `pm plan` changes immediately; the agent sees it in `pm inbox` |
| UC-6 | Watch the agent work | Owner | Live status, agent-working tab, phase progress fill, Activity | A status change by the agent shows on the open view within a second, without reloading |
| UC-7 | The agent needs me (question or gate) | Agent → Owner | `pm ask`, gate; Now → "Waiting on you"; Approve; reply in Details | The owner sees it on the Now tab badge; answers in at most 2 clicks; the agent sees the answer; `pm done` stays refused until the gate is approved |
| UC-8 | "Change this part of the chart" | Owner → Agent | Click any element → Details → Change request; violet marker; `pm inbox` with the element's context; reply + resolve | The request reaches the agent with what the element currently is; when applied, the marker clears and the reply shows |
| UC-9 | "What serves this requirement? Is anything off-scope?" | Owner | Click a requirement (trace), "N tasks serve none of these" | Unrelated work fades; tasks are listed by phase; unlinked work is one click away |
| UC-10 | Find a specific task | Owner | Search (`/`) → result → opens it in its phase | The task is shown selected, in context, with its details |
| UC-11 | "Show how this part of the backlog fits together, and what you'd add" | Owner ↔ Agent | `pmv pull` (dry run, then `--yes`), mirrored cards with their backlog status, **Proposed** tag, Details "kept in the backlog", `pmv proposals` / `adopt` | Only rows the owner agreed to are on the board; proposals are told apart at a glance; a row's status can't drift from the backlog |

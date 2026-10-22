# Changelog

## 1.0.0 — 2026-10-22

First release.

### The board
- Top-down reading:
  - requirements rail (**OK** to confirm the agent's reading; click to trace);
  - an overview of agent-defined phases;
  - phase and sub-group views with stubs for neighbouring phases;
  - task details.
- **Critical path** view: only the chain that decides the finish date, each task labelled with its phase.
- **All tasks** view, boxed by phase.
- **Now**: what's waiting on you, what must happen next (it follows status), your change requests, and pins you can drag to reorder.
- **Details** for any element (requirement, phase, task, link, note, view), with a conversation: change request, instruction, question or note.
- Visual encoding instead of pop-ups:
  - progress shown as fill;
  - critical path as a red border;
  - dashed borders for not started or blocked;
  - "Next" tags, an agent-working tab, and markers for gates and change requests;
  - wrapping notes and labels on links.
- Navigation: ← Back, breadcrumb, phase strip, browser history, `Esc`, `/` search, `c` critical path.
- Live updates over WebSocket.

### For agents: the `pmv` CLI
- `pmv init`: per-project `.pm-visual/` folder; automatic port; installs the agent skill `.agents/skills/pm-visual/SKILL.md`.
- The board server starts automatically on the first command; `open`, `serve`, `status` and `stop` manage it.
- `import plan.json` creates or updates requirements, groups, tasks, labels and notes, all or nothing.
- `check` reports what makes the chart hard to read, each with the command that fixes it.
- `inbox` shows owner requests with the current state of the element they point at; `plan` gives a top-down Markdown view.
- Work: `start`, `verify`, `done` (refused while a gate is pending), `block`; talk: `ask`, `reply --resolve`.
- `shot` screenshots a view so the agent can check the visual result before handing over.
- Free-form `meta` on tasks, groups and requirements for any domain.
- HTTP API and WebSocket with the same operations.

### Development
- Unit tests for analysis, structure, store rules and scenes.
- `ux-walkthrough` skill and `npm run ux`: use cases simulated end to end (browser + CLI), with a report on clicks, density and on-screen text size.

# Changelog

## 1.2.0 — 2026-10-27

### Subtasks from briefs, and a board that keeps itself current
- A backlog item's steps live in its brief as a `## Subtasks` table (`| ID | Title | Status | Depends on | Estimate | Gate |`),
  the one format the product-manager skill writes and the board reads. `pmv subtasks add <row>` shows a row's table.
- The server re-reads the backlog and tracked briefs on every page load, agent read (`brief`, `plan`, `check`, `show`),
  `pmv pull` and file change (it watches their folders). Agents only edit the PM's documents; no `pmv done`/`start`/`edit`
  for synced items.
- The table owns a subtask's title, status, size, estimate, waits-on and gate wording; the server refuses those edits.
  The board keeps the phase, requirements, comments, pins and the owner's gate approval (kept while the wording stays).
- New subtasks are placed next to their siblings, else in a phase made for the row. Cross-brief waits-on: `BL-381.C4`.
- Board-only cards on a linked board are tagged *Not synced* (was *Proposed*).
- New plan checks: `NOT_SYNCED`, `SUBTASKS_PENDING`, `SYNC_PROBLEM` (bad data never fails a sync), `GATE_SKIPPED`.
  `BOARD_LARGE` no longer counts brief subtasks.
- Migration: `pmv subtasks export [<row> [<task>...]]...` prints the Subtasks table for existing board-only cards
  (`--write` puts it in the brief). Once the brief lists them, the cards keep their ids, comments and approvals.
- `pmv pull` without ids is now the same server-side sync; `POST /sync`, `POST /subtasks`, `DELETE /subtasks/:row`.

## 1.1.1 — 2026-10-24

- Install from the release tarball: `npm i -g https://github.com/timhuang1018/pm-visual-tool/releases/download/v1.1.1/pm-visual-1.1.1.tgz`.
  A global install from git (`npm i -g github:…`) fails to build because npm leaks `-g` into the prepare step.

## 1.1.0 — 2026-10-24

### Backlog bridge
- `pmv pull` mirrors chosen rows of a repo's backlog file (`docs/BACKLOG.md`, `docs/BACKLOG-done.md`; any column order). It never writes the backlog.
  - Adds only named or matched rows, as a dry run unless `--yes`.
  - `--related` adds the rows they name.
  - Without ids it refreshes the rows already there.
- Status and sizing of a mirrored row come only from the backlog; the server refuses edits. Cards keep the row's own status word (e.g. *Icebox*).
- Board-only work on a linked board is a **proposal**, tagged *Proposed*. It may depend on any row, done ones too.
- `pmv proposals` prints ingest cards for the backlog owner. `pmv adopt <task> <row>` links a proposal to its new row and renames it everywhere.
- New plan checks:
  - `BOARD_LARGE`: more than 40 tasks;
  - `DONE_WAITS_ON_OPEN`;
  - `BACKLOG_MENTION`: rows that name each other but aren't linked.
- Mirrored rows are exempt from the requirement-tracing checks.

### For agents
- `pmv brief`: about 12 lines per session instead of `inbox` + `plan`.
- The agent skill moved to `agent/pm-visual/` (SKILL.md plus `references/plan-format.md`, read on demand). Its trigger is narrowed to explicit requests to see or steer work visually.
- `pmv init` installs the skill where Claude Code and Codex read it (`.claude/skills/`, `.agents/skills/`). It skips the install when a user-wide copy exists.
- The skill is experimental and project-scoped (`scope: project`): it's installed per repo, never user-wide.
- Install globally, so no `package.json` changes (see 1.1.1 for the working install line).

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

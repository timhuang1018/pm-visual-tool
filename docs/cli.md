# `pmv` CLI reference

`pmv` (also `pm-visual`) is the command line for the board. Agents use it to plan and report.
Humans mostly use `init`, `open` and the browser.

## Setup and the board server

| Command | Does |
|---|---|
| `pmv init [--name "..."] [--id x] [--port N] [--no-skill]` | Creates `.pm-visual/` in the current folder, picks a free port (from 4317), starts the board and creates the project. Installs the agent skill into `.claude/skills/pm-visual/` and `.agents/skills/pm-visual/`, unless `--no-skill` or a user-wide copy exists (`~/.claude/skills/pm-visual`, `~/.codex/skills/pm-visual`) |
| `pmv open [--browser]` | Starts the board in the background if needed and prints the URL |
| `pmv serve [--port N] [--quiet]` | Runs the board in the foreground (Ctrl-C to stop) |
| `pmv status` | Is the board running, on which port, and which projects it has |
| `pmv stop` | Stops the background board |
| `pmv shot [overview\|critical\|all\|<group-id>] [--out file.png] [--width --height]` | Screenshots a view so an agent can check the visual result. Needs `playwright-core` in the project and a local Chrome |
| `pmv demo` | Creates a small demo project |
| `pmv projects`, `pmv project-create <id> "<name>"`, `pmv use <id>` | Several boards in one project |

Any command that talks to the board starts it first if it isn't running.

## Reading

| Command | Output |
|---|---|
| `pmv brief` | About 12 lines for the start of every session: open owner requests, owner activity since your last read, what waits on the owner, the critical path, what's next, proposals and backlog sync. Advances your inbox cursor |
| `pmv inbox [--all]` | Open owner requests (change requests, instructions, questions), each with the current state of the element it points at, plus owner activity since your last inbox, pins and unconfirmed requirements |
| `pmv plan [--limit N]` | Markdown, top-down: owner requests → requirements → phases (with progress and links) → now → work order → critical path → gates → plan check |
| `pmv outline` | Requirements and the phase/task tree |
| `pmv check` | Plan check: what makes the chart hard to read, each item with the command that fixes it |
| `pmv show <task-id>` | One task as JSON, with its analysis (rank, slack, unlocks) and comments |
| `pmv events [--since N]` | Raw event log |

## Planning

| Command | Does |
|---|---|
| `pmv import <plan.json>` | Creates or updates requirements, groups, tasks, labels and notes by id, all or nothing (see [data-model.md](data-model.md)). A plain JSON array counts as tasks |
| `pmv req add --title "..." --detail "..." [--id R-1] [--meta k=v,...]` | Adds a requirement (draft until the owner clicks OK) |
| `pmv req edit <id> [--title] [--detail] [--meta]` · `pmv req rm <id>` · `pmv req` | Edit / remove / list |
| `pmv group add --id <id> --name "..." --goal "..." [--parent <id>] [--order N]` | Adds a phase, or a sub-group with `--parent` |
| `pmv group edit <id> ...` · `pmv group rm <id>` · `pmv group` | Edit / remove (contents move up) / list |
| `pmv add --title "..." --group <id> --req R-1,R-2 [--id] [--deps T-01,T-02] [--effort S\|M\|L] [--impact S\|M\|L] [--gate "..."] [--meta k=v,...] [--description ...]` | Adds a task |
| `pmv edit <id> [any field above]` · `pmv rm <id>` | Edits / deletes a task. `--deps none`, `--gate none` and `--req none` clear a field |
| `pmv label <from> <to> "<text>"` | Text on a link between phases (or tasks); `""` clears it |
| `pmv note <element> "<text>" [--tone info\|deadline\|risk\|decision]` · `pmv note-rm <N-id>` | A one-line note that wraps an element |

`--meta` accepts `key=value,key2=value2` or a JSON object.

## Working

| Command | Does |
|---|---|
| `pmv start <id>` | `in_progress` and assigned to you (the owner sees "working") |
| `pmv verify <id>` | `needs_verification` (built, waiting on a read-back) |
| `pmv done <id>` | `done`. Refused while an owner gate is pending |
| `pmv block <id> "<reason>"` | `blocked`, plus a question to the owner with the reason |
| `pmv status <id> <status>` | Any status: `ready`, `in_progress`, `needs_verification`, `blocked`, `done` |

## Backlog bridge

For repos with a backlog file (`docs/BACKLOG.md` rows like `| BL-102 | Task | … | Status | Impact | Effort | Brief |`,
any column order; `docs/BACKLOG-done.md` is read too). The board reads the backlog and never writes it.

| Command | Does |
|---|---|
| `pmv pull` | Refreshes every mirrored row on the board (status, impact, effort, brief link). Never adds rows |
| `pmv pull <row-id>... [--match "<regex>"] [--related] [--group <id>] [--file a.md,b.md]` | Lists the rows it would add: the named ones, the ones whose text, keyword or section match, and with `--related` the rows they name. Adds nothing |
| `pmv pull ... --yes` | Adds them, in `--group` if given. Use it once the owner named or OK'd the rows |
| `pmv proposals [<id>...]` | Board-only tasks as ingest cards for the backlog owner. A card is ready when its requirements are owner-confirmed and it has no open change request |
| `pmv adopt <task-id> <row-id>` | After ingest: links the task to its new row and renames it everywhere (links, pins, notes, comments). Refused until the row exists |

A mirrored task keeps its backlog status word (e.g. *Icebox*) on its card. Its status and sizing can't
be changed on the board; its card title, phase, requirements, dependencies, gate and meta can.
The backlog file is remembered per project; `--file` changes it.

## Talking to the owner

| Command | Does |
|---|---|
| `pmv ask <task-id\|element> "<question>"` | A question the owner sees in **Now → Waiting on you** |
| `pmv comment <task-id\|element> "<text>"` | A note on an element |
| `pmv reply <C-id> "<text>" [--resolve]` | Replies. Replying to an owner's question answers it; `--resolve` also closes a change request or instruction |
| `pmv resolve <C-id>` | Closes a request once it's handled |
| `pmv pin <id> [<id>...]` | Replaces the priority pins (normally done by the owner in the UI) |

Elements: `task:T-01`, `group:<id>`, `req:R-1`, `note:N-1`, `link:<from>><to>`, `view:overview`.
A bare task id also works for `ask`/`comment`.

## Configuration

| Variable / flag | Default | Meaning |
|---|---|---|
| `PM_ACTOR` / `--actor` | `agent:ai` | Who you are: `agent:<name>` or `human:<name>`. Shown on the board |
| `PM_PROJECT` / `--project` | from `.pm-visual/config.json` | Which project on the board |
| `PM_URL` / `--url` | `http://127.0.0.1:<config port>` | Talk to a board elsewhere |
| `PM_DIR` | nearest `.pm-visual/` from the current folder upwards | The board folder |

## Files

```
.pm-visual/
  config.json      { "project": "<id>", "port": 4317 }
  data/<id>.json   the board: requirements, groups, tasks, labels, notes, comments, events
  server.log       background server log        (git-ignored)
  server.pid                                    (git-ignored)
  cursors/         where each actor's inbox left off   (git-ignored)
  shots/           pmv shot output              (git-ignored)
.claude/skills/pm-visual/   agent skill installed by init (also .agents/skills/pm-visual/)
```

The server listens on 127.0.0.1 only.

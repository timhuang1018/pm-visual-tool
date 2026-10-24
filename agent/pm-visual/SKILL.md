---
name: pm-visual
description: >-
  Use only when the user explicitly asks to see, plan, confirm or steer work visually: "show me the
  tasks visually", "put this on a board", "draw how these tasks relate", "let me confirm the plan on
  a board before you start". Also use when a .pm-visual/ board already exists for the work at hand.
  Not for ordinary status or what's-next questions; the repo's backlog owner answers those.
scope: project
---

# PM Visual: a board the user reads and steers

Experimental: installed per project (`skill-sync install pm-visual --scope project`), never user-wide.

The `pmv` CLI keeps a live flow chart the user reads top-down in the browser: **what they asked
for** (requirements they OK) → **phases** → **tasks** with dependencies → **Now** (next, waiting on
them, critical path). They answer questions, approve gates, pin "do this first" and click any
element to request a change. You read all of that back with `pmv brief`.

The board is a **high-level slice**, not a second backlog: one area, ≤ 40 cards, one card per
backlog-sized item. If the repo has a backlog (`docs/BACKLOG.md`), the board mirrors chosen rows
read-only and stages new work as **proposals** until the backlog owner ingests them.

## Set up (once per repo)

```sh
command -v pmv || npm i -g github:timhuang1018/pm-visual-tool#v1.1.0
pmv init --no-skill --name "<area>"   # repo root; you already have this skill
pmv open                              # board URL: give it to the user
```

Use a global install: it changes no `package.json`. Set `PM_ACTOR=agent:<your-name>`. One repo can
hold several boards (`pmv project-create <id> "<name>"`, `pmv use <id>`); keep one per area.
Unless the user wants the board shared, add `.pm-visual/` to `.gitignore`: the backlog and briefs
stay the record, the board is a view.

## Scope: load only what the user asked to see

1. **Rows from the backlog**: name them, or match them, and add them only once the user agrees.
   ```sh
   pmv pull BL-101 BL-102 BL-103          # dry run: lists what it would add
   pmv pull --match "earnings call|conference"     # dry run, by text, keyword or section
   pmv pull BL-101 --related               # + the rows those rows name ("waits on BL-104")
   pmv pull BL-101 BL-102 --group cal --yes
   ```
   Pass `--yes` only after the user named those rows or OK'd the listed set. Never pull a whole
   backlog. Pull done rows only when new work hangs off them.
2. **New work** (not in the backlog yet): plan it on the board as tasks. With a backlog linked,
   they show as *Proposed*. They may depend on any row on the board, done ones too.
3. `pmv check` warns when the board grows past a slice (`BOARD_LARGE`): remove finished or
   unrelated cards (`pmv rm`; the backlog keeps them).

## Plan

Extract the structure from the user's words, the code and the docs. Write one `plan.json`
(requirements, phases, tasks, labels, notes), then:

```sh
pmv import plan.json && pmv check   # fix warnings until clean
pmv edit BL-103 --group extract --deps BL-102   # place and link mirrored rows
```

Read [references/plan-format.md](references/plan-format.md) when writing a plan or applying change
requests. Ask the user to OK the requirements on the board before expensive work.

## Every session: one short read

```sh
pmv brief      # ~12 lines: owner requests, waiting on owner, critical path, next, proposals
```

Use `pmv plan` (full view), `pmv inbox --all` or `pmv show <id>` only when the brief points you
there. Don't paste board output back into chat; give the user the URL and a sentence.

Order of work: **owner requests**, then **pins**, then the work order (critical path first).
- Board-only tasks: `pmv start T-04`, `pmv verify T-04`, `pmv done T-04`, `pmv block T-04 "why"`.
  `done` is refused while a gate is pending: `pmv ask T-02 "..."` and work on something else.
- Mirrored rows: their status and sizing live in the backlog and the board refuses edits. After
  the backlog changes, `pmv pull` (no ids) refreshes every row on the board.
- Apply change requests, then `pmv reply C-7 "what changed" --resolve`.

## Hand proposals to the backlog owner

When the user wants the proposals tracked ("ingest these", "send them to the backlog"):

```sh
pmv proposals            # ingest cards: requirement source, phase, after/unlocks, gate, size
```

A card is *ready to ingest* when every requirement it serves is owner-confirmed on the board.
Pass the cards to the repo's backlog owner (the `product-manager` skill, intent `ingest-apply`
for confirmed cards, `ingest-propose` for the rest). Don't write the backlog yourself. Once
the row exists:

```sh
pmv adopt T-03 BL-120    # the card becomes that row: renamed everywhere, now mirrored
```

`pmv help` lists every command.

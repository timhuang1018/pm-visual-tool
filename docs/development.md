# Developing PM Visual

## Layout

| Path | What |
|---|---|
| `cli/main.ts` | The `pmv` CLI: board setup, auto-start, and all agent commands |
| `server/app.ts` | HTTP + WebSocket server (`startServer`), one per project board |
| `server/store.ts` | JSON-file store, validation and rules (gates, cycles, who may do what), events |
| `server/index.ts` | Development entry: API on :4317 with `data/` and the sample project |
| `shared/` | Types, dependency analysis (critical path, work order), structure rollups and plan check, Now, plan text |
| `web/` | React + React Flow UI (requirements rail, phase/task views, Now, Details) |
| `agent/` | The agent skill (`pm-visual/`, installed by `pmv init` and published to skill-repo) and the demo plan |
| `tests/` | Unit tests (`npm test`); use-case walkthrough scenarios in `tests/ux/` |
| `doc/` | Goal, sample backlog (`tasks.md` + `sample-structure.json`), use cases |
| `docs/` | User and agent documentation |
| `.agents/skills/ux-walkthrough/` | Dev/debug skill: walk through use cases in a real browser |

## Everyday commands

```sh
npm run dev        # API :4317 (data/, sample project) + Vite UI http://localhost:5173 with hot reload
npm run pm -- plan # the CLI against the dev server (PM_PROJECT defaults to "sample")
npm run demo       # adds the small demo project
npm run seed       # recreate the sample project (then restart the dev server)
npm test           # unit tests: analysis, structure, store rules, scenes
npm run ux         # use-case walkthrough with a screenshot report (ux-report/report.md)
npm run build      # type-check + dist/ui + dist/cli.js
```

## Packaging

- `npm run build:pkg` builds the UI with Vite into `dist/ui` and bundles the CLI and server with
  esbuild into a single `dist/cli.js`. The only runtime dependency is `ws`; React and React Flow are
  bundled into the UI.
- `prepare` runs `build:pkg`, so `npm i -g github:timhuang1018/pm-visual-tool#<tag>` builds on install.
- To check a release locally:

  ```sh
  npm pack
  npm i -g --prefix /tmp/pmv-global /path/to/pm-visual-<version>.tgz
  cd /tmp/host && PATH=/tmp/pmv-global/bin:$PATH pmv init && pmv import plan.json && pmv brief
  ```

## UX walkthrough (development and debugging tool)

[`ux-walkthrough`](../.agents/skills/ux-walkthrough/SKILL.md) checks the UI against
[doc/use-cases.md](../doc/use-cases.md). It plays each use case end to end in a real Chrome
(owner) together with CLI steps (agent), against an isolated server on port 4400 with temporary data.

```sh
npm run ux                    # all scenarios
npm run ux -- --only UC-2,UC-4   # some scenarios (UC-2 creates the "shop" project the others use)
npm run ux -- --headed        # watch it
```

The report (`ux-report/report.md`) has, for each use case:
- every step's result;
- clicks used against the limit;
- words per card;
- the **on-screen text size** of each card, including zoom;
- console errors;
- screenshots.

Look at the screenshots, not just the pass/fail. Then follow the skill's review heuristics.

**When to run it:**
- after any UI change, before handing it over;
- when the owner reports something confusing: add a scenario that reproduces it, then fix;
- when adding a feature: add a use case row and a scenario first.

For a quick visual check, an agent can use `pmv shot [view]` on a real board instead. It saves a
PNG the agent can look at before telling the user it's ready.

## Conventions

- **The owner's principles drive the UI.** They are in [doc/use-cases.md](../doc/use-cases.md): top-down, little text per
  card, state shown by encoding rather than pop-ups, a way back at every level, everything changeable
  from the chart.
- **Keep [agent/pm-visual/](../agent/pm-visual/SKILL.md) and [docs/cli.md](cli.md) in sync with `cli/main.ts`.**
- **The server is the source of rules**: who can approve, gates, cycles. The UI and CLI only present them.

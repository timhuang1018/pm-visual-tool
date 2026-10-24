# Working on PM Visual (for AI agents)

This repository is the **PM Visual** tool itself: a `pmv` CLI and board that other agents use in their own
projects. How agents *use* the board is in [agent/pm-visual/SKILL.md](agent/pm-visual/SKILL.md), which `pmv init`
installs into host projects and skill-repo publishes as an experimental, project-scoped skill. This file is for agents *developing* it.

## Before you change anything

- Read [docs/development.md](docs/development.md) for the layout and commands.
- Read [doc/use-cases.md](doc/use-cases.md). The owner's principles there are requirements, not suggestions:
  - top-down, one level at a time;
  - little text per card;
  - state shown by encoding, not pop-ups;
  - an obvious way back;
  - everything changeable from the chart.

## Rules

1. **Rules live in the server** (`server/store.ts`): gates, cycles, who may confirm or approve. The CLI and UI only present them.
2. **Any CLI change** updates `cli/main.ts`, [agent/pm-visual/](agent/pm-visual/SKILL.md) and [docs/cli.md](docs/cli.md) together.
3. **Any data-model change** updates `shared/types.ts`, the store's validation and [docs/data-model.md](docs/data-model.md).
4. **Any UI change**: run `npm test` and `npm run ux`, then look at the screenshots in `ux-report/` using the
   [ux-walkthrough](.agents/skills/ux-walkthrough/SKILL.md) heuristics before handing over. If you added
   behaviour, add or extend a scenario in `tests/ux/scenarios.mjs`.
5. **Releases**: bump `version` in `package.json` and `VERSION` in `cli/main.ts`, add a `CHANGELOG.md` entry, run
   `npm run build`, and test `npm pack` in a scratch project (see docs/development.md). Update the release URL in
   the skill's and README's install line, push the git tag, attach the tarball
   (`gh release create v<x> pm-visual-<x>.tgz --repo timhuang1018/pm-visual-tool`), then publish the skill:
   `skill-sync push pm-visual --source agent/pm-visual --yes` (after the skill-repo freshness check).

## Using the board while developing

The dev server (`npm run dev`) runs the sample project. Use the CLI as `npm run -s pm -- <command>` instead of
`pmv <command>`. Everything in [agent/pm-visual/SKILL.md](agent/pm-visual/SKILL.md) applies.

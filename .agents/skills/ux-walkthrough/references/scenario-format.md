# Scenario format

A scenarios module exports one object:

```js
export default {
  title: 'Product — use cases',
  baseUrl: 'http://localhost:5180',       // where the UI runs during the walkthrough
  outDir: 'ux-report',                     // report + screenshots (overridable with --out)
  viewport: { width: 1600, height: 960 },  // optional
  channel: 'chrome',                       // playwright-core browser channel (local Chrome)
  env: { },                                // extra env for setup and cli steps
  setup: {
    before: ['rm -rf /tmp/app-ux-data'],   // shell commands run once, first
    start: [                               // background processes, killed at the end
      { cmd: 'node server.js', env: { PORT: '4400', DATA_DIR: '/tmp/app-ux-data' }, ready: 'http://localhost:4400/health' },
      { cmd: 'npx vite --port 5180 --strictPort', ready: 'http://localhost:5180' },
    ],
    after: ['rm -rf /tmp/app-ux-data'],
  },
  scenarios: [
    {
      id: 'UC-1',
      title: 'Owner confirms the agent understood',
      need: '“Did the agent understand what I asked for?”',   // the user's words
      persona: 'Owner',
      maxClicks: 3,                                           // fails the scenario if exceeded
      steps: [ /* see below */ ],
    },
  ],
};
```

## Steps

Every step can have `why` (shown in the report). Selectors are CSS. `text` narrows a selector to
elements containing that text. `nth` picks a match. `timeout` is in ms (default 5000).

| Step | Fields | Does |
|---|---|---|
| `goto` | `path`, `waitFor?` | Opens `baseUrl + path`; waits for a selector |
| `click` / `dblclick` | `sel`, `text?`, `nth?`, `force?`, `settle?` | Clicks (counts towards `maxClicks`) |
| `hover` | `sel`, `text?` | Hovers |
| `fill` | `sel`, `value` | Types into an input |
| `press` | `key` | Keyboard key (`Escape`, `/`, `Enter`…) |
| `wait` | `ms` | Pauses |
| `expect` | `sel`, `text?`, `count?`, `visible?` | Asserts visible (default), hidden (`visible:false`) or an exact count; retries until timeout |
| `expectUrl` | `match` (regex) | Asserts the URL |
| `cli` | `cmd`, `expect?` (regex), `reject?` (regex) | Runs a shell command (e.g. the AI agent's CLI) and checks its output |
| `cliFails` | `cmd`, `expect?` | Asserts the command fails (e.g. a guard that must refuse) |
| `density` | `sel`, `maxWords`, `maxCards?`, `minPx?` (default 11), `strict?`, `label?` | Counts visible cards and words per card, and measures the on-screen size of each card's main text (zoom included); flags overload or illegible text (fails only with `strict`) |
| `shot` | `name`, `why` | Screenshot for review |
| `note` | `text` | Adds a line to the report |

After a failure, the remaining steps are skipped (screenshots still run) and a `-fail.png` is saved.
Console errors fail the scenario.

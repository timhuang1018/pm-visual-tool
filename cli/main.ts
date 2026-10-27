// pmv — PM Visual command line. A lightweight task board an AI agent drives from any project,
// and the owner reads in the browser: requirements → phases → tasks, what's critical now,
// owner gates, questions and change requests.
//
//   pmv init                     set up .pm-visual/ in this project (board data + agent skill)
//   pmv open                     start the board if needed and print its URL
//   pmv help                     every command
//
// Environment overrides: PM_URL, PM_PROJECT, PM_ACTOR (default agent:ai), PM_DIR (board folder).

import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, openSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { briefPath, matchRows, parseBacklog, parseSubtasks, renderSubtasks, writeSubtasks, type BacklogRow } from '../shared/backlog';
import { exportSubtasks, guessRows } from '../shared/subtasks';

export const VERSION = '1.2.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 4317;

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const flags: Record<string, string> = {};
const args: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=', 2);
    flags[k] = v ?? (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
  } else args.push(a);
}

// ---------------------------------------------------------------- board folder + config

interface Config {
  project: string;
  port: number;
}
interface Board {
  dir: string; // .pm-visual
  root: string; // the project that contains it
  config: Config;
}

function findBoard(): Board | null {
  if (process.env.PM_DIR) return loadBoard(path.resolve(process.env.PM_DIR));
  let cur = process.cwd();
  for (;;) {
    const dir = path.join(cur, '.pm-visual');
    if (existsSync(path.join(dir, 'config.json'))) return loadBoard(dir);
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}
function loadBoard(dir: string): Board | null {
  const file = path.join(dir, 'config.json');
  if (!existsSync(file)) return null;
  return { dir, root: path.dirname(dir), config: JSON.parse(readFileSync(file, 'utf8')) };
}

const board = findBoard();
const ACTOR = flags.actor ?? process.env.PM_ACTOR ?? 'agent:ai';
const BASE = (flags.url ?? process.env.PM_URL ?? `http://127.0.0.1:${board?.config.port ?? DEFAULT_PORT}`).replace(/\/$/, '');
let PROJECT = flags.project ?? process.env.PM_PROJECT ?? board?.config.project ?? '';
const P = () => `/api/projects/${encodeURIComponent(PROJECT)}`;

// ---------------------------------------------------------------- output helpers

function fail(msg: string): never {
  console.error(`pmv: ${msg}`);
  process.exit(1);
}
const out = (v: unknown) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const need = (v: string | undefined, usage: string) => v ?? fail(`usage: pmv ${usage}`);
const safeJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- server lifecycle

function uiDir(): string | null {
  for (const c of [path.join(HERE, 'ui'), path.join(HERE, '..', 'dist', 'ui')]) if (existsSync(path.join(c, 'index.html'))) return c;
  return null;
}

async function health(): Promise<{ ok: boolean; dataDir: string; pid: number; version?: string | null } | null> {
  try {
    const r = await fetch(`${BASE}/api/health`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Start the board server in the background for this project, if it isn't running. */
async function ensureServer(): Promise<void> {
  const h = await health();
  if (h) {
    if (board && path.resolve(h.dataDir) !== path.resolve(path.join(board.dir, 'data')))
      fail(`port ${board.config.port} is used by another board (${h.dataDir}). Set another "port" in ${path.join(board.dir, 'config.json')}.`);
    return;
  }
  if (!board) fail(`no board running at ${BASE}. Run \`pmv init\` in your project first.`);
  const log = openSync(path.join(board.dir, 'server.log'), 'a');
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], 'serve', '--quiet'], {
    cwd: board.root,
    env: { ...process.env, PM_DIR: board.dir },
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await health()) return;
  }
  fail(`the board did not start; see ${path.join(board.dir, 'server.log')}`);
}

let versionChecked = false;
/** This project's board runs another pmv version (e.g. after an upgrade): restart it on this one. */
async function matchVersion() {
  if (versionChecked || !board || flags.url || process.env.PM_URL) return;
  versionChecked = true;
  const h = await health();
  if (!h || h.version === VERSION || path.resolve(h.dataDir) !== path.resolve(path.join(board.dir, 'data'))) return;
  console.error(`pmv: restarting the board (it ran ${h.version ?? 'an older version'}, this is ${VERSION})`);
  try {
    process.kill(h.pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let i = 0; i < 40 && (await health()); i++) await new Promise((r) => setTimeout(r, 100));
  await ensureServer();
}

async function api(method: string, url: string, body?: unknown): Promise<any> {
  await matchVersion();
  const call = () =>
    fetch(BASE + url, {
      method,
      headers: { 'content-type': 'application/json', 'x-actor': ACTOR },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let res: Response;
  try {
    res = await call();
  } catch {
    await ensureServer();
    res = await call();
  }
  const txt = await res.text();
  if (!res.ok) fail(`${res.status}: ${safeJson(txt)?.error ?? txt}`);
  return res.headers.get('content-type')?.includes('json') ? JSON.parse(txt) : txt;
}

/** Pick the project when none is configured: the only one on the board. */
async function needProject() {
  if (PROJECT) return;
  const list = await api('GET', '/api/projects');
  if (list.length === 1) PROJECT = list[0].id;
  else fail(list.length ? `several projects (${list.map((p: any) => p.id).join(', ')}); pass --project <id>` : 'no project yet; run `pmv init`');
}

async function freePort(start: number): Promise<number> {
  for (let p = start; p < start + 50; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(false));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (ok) return p;
  }
  fail('no free port found');
}

// ---------------------------------------------------------------- cursors (for `pmv inbox`)

const cursorFile = () => path.join(board?.dir ?? path.join(process.cwd(), '.pm-visual'), 'cursors', `${PROJECT}-${ACTOR.replace(/\W+/g, '_')}`);
const readCursor = () => (existsSync(cursorFile()) ? Number(readFileSync(cursorFile(), 'utf8')) || 0 : 0);
const writeCursor = (n: number) => {
  mkdirSync(path.dirname(cursorFile()), { recursive: true });
  writeFileSync(cursorFile(), String(n));
};

const taskFields = (): Record<string, unknown> => {
  const f: Record<string, unknown> = {};
  for (const k of ['title', 'description', 'area', 'status', 'impact', 'effort', 'assignee', 'id', 'group']) if (flags[k] !== undefined) f[k] = flags[k];
  if (flags.req !== undefined) f.requirements = flags.req === '' || flags.req === 'none' ? [] : flags.req.split(',');
  if (flags.deps !== undefined) f.dependsOn = flags.deps === '' || flags.deps === 'none' ? [] : flags.deps.split(',');
  if (flags.gate !== undefined) f.gate = flags.gate === 'none' ? null : flags.gate;
  if (flags.meta !== undefined) f.meta = parseMeta(flags.meta);
  return f;
};
function parseMeta(s: string): Record<string, string> {
  // --meta "owner=Ana,repo=https://…"  or  --meta '{"owner":"Ana"}'
  if (s.trim().startsWith('{')) return JSON.parse(s);
  return Object.fromEntries(
    s
      .split(',')
      .filter(Boolean)
      .map((kv) => {
        const i = kv.indexOf('=');
        return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
      }),
  );
}

// ---------------------------------------------------------------- help

const HELP = `pmv ${VERSION} — a visual task board your AI agent keeps, and you read and steer in the browser.
Board: ${board ? path.relative(process.cwd(), board.dir) || '.pm-visual' : '(none here — run pmv init)'} · project=${PROJECT || '—'} · actor=${ACTOR} · ${BASE}

Set up and view
  pmv init [--name "..."] [--id x] [--port N]   Create .pm-visual/ here, start the board, install the agent skill
  pmv open [--browser]              Start the board if needed; print the URL (and open a browser)
  pmv serve [--port N]              Run the board in the foreground
  pmv stop | pmv status             Stop the background board / show what's running
  pmv shot [overview|critical|all|<group-id>] [--out file.png]   Screenshot a view (needs playwright-core + Chrome)
  pmv demo                          Create a small demo project to try the board

Reading (agents: start every work session with brief)
  pmv brief                         ~12 lines: owner requests, waiting on owner, critical path, next, proposals
  pmv inbox [--all]                 Owner requests (change requests, instructions, questions) + owner activity
  pmv plan [--limit N]              Full top-down plan: requests, requirements, phases, now, work order, checks
  pmv outline | pmv check           Structure as a tree / what to fix so the owner can read it
  pmv show <task-id>                One task with analysis and comments (JSON)
  pmv events [--since N] | pmv projects | pmv use <project-id>

Planning: requirements → phases → tasks
  pmv import <plan.json>            Create-or-update by id: {requirements, groups, tasks, labels, notes}
  pmv req add --title "..." --detail "..." [--id R-1]     pmv req edit <id> ...     pmv req rm <id>
  pmv group add --id <id> --name "..." --goal "..." [--parent <id>] [--order N]
  pmv group edit <id> [--name] [--goal] [--parent <id>|none] [--order N]             pmv group rm <id>
  pmv add --title "..." --group <id> --req R-1 [--deps T-01] [--effort S|M|L] [--impact S|M|L]
          [--gate "what the owner checks"] [--meta "key=value,..."] [--description ...]
  pmv edit <id> [same fields]       pmv rm <id>
  pmv label <from> <to> "<what flows>"                    pmv note <element> "<text>" [--tone info|deadline|risk|decision]

Working
  pmv start <id> | verify <id> | done <id> | block <id> "<reason>" | status <id> <status>

Backlog bridge (read-only on the backlog file; default docs/BACKLOG.md [+ docs/BACKLOG-done.md])
  The board re-reads the backlog and tracked briefs on every page load, read and file change.
  pmv pull                          Re-read now: rows on the board + tracked briefs' subtasks; never adds rows
  pmv pull <row-id>... | --match "<regex>" [--related] [--group <id>] [--file a.md,b.md] [--yes]
                                    Lists the rows it would add; adds them only with --yes
  pmv subtasks                      Tracked rows, their subtasks and what the sync could not read
  pmv subtasks add <row-id>... [--group <id>]   Show these rows' brief "## Subtasks" tables on the board
  pmv subtasks rm <row-id>          Stop showing a row's subtasks (cards leave; the brief keeps them)
  pmv subtasks export [<row-id> [<task-id>...]]... [--group a,b] [--write] [--dry-run]
                                    Board-only cards → a Subtasks table for each row's brief (prints it;
                                    --write puts it in the brief). The cards join the table once it lands.
  pmv proposals [<id>...]           Board-only tasks as ingest cards for the backlog owner
  pmv adopt <task-id> <row-id>      After ingest: the proposal becomes that row (renamed everywhere)

Talking to the owner
  pmv ask <task-id|element> "<question>"    pmv comment <task-id|element> "<text>"
  pmv reply <C-id> "<text>" [--resolve]     pmv resolve <C-id>      pmv pin <id> [<id>...] (owner)

Elements: task:T-01 group:<id> req:R-1 note:N-1 link:<from>><to> view:overview
Docs: the pm-visual agent skill (pmv init installs it unless you have it user-wide)`;

// ---------------------------------------------------------------- commands

const [cmd, ...rest] = args;

async function main() {
  if (flags.version || flags.v) return out(VERSION);
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
      return out(HELP);
    case 'version':
    case '--version':
      return out(VERSION);

    case 'init':
      return init();
    case 'serve':
      return serve();
    case 'open': {
      await ensureServer();
      await needProject().catch(() => {});
      const url = `${BASE}/#/${PROJECT}`;
      out(url);
      if (flags.browser) execFileSync(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [url]);
      return;
    }
    case 'stop': {
      const h = await health();
      if (!h) return out('no board running');
      process.kill(h.pid, 'SIGTERM');
      return out(`stopped board (pid ${h.pid})`);
    }
    case 'status':
      if (rest.length) return setStatus(rest[0], rest[1]);
      return boardStatus();
    case 'shot':
      return shot();
    case 'demo':
      return demo();

    case 'projects':
      for (const p of await api('GET', '/api/projects')) console.log(`${p.id}\t${p.name}`);
      return;
    case 'project-create':
      return out(await api('POST', '/api/projects', { id: need(rest[0], 'project-create <id> "<name>"'), name: rest[1] ?? rest[0], description: flags.description }));
    case 'use': {
      const id = need(rest[0], 'use <project-id>');
      if (!board) fail('no .pm-visual here; run pmv init');
      board.config.project = id;
      writeFileSync(path.join(board.dir, 'config.json'), JSON.stringify(board.config, null, 2));
      return out(`now using project ${id}`);
    }
  }

  await needProject();
  switch (cmd) {
    case 'plan':
      return out(await api('GET', `${P()}/plan.md?limit=${flags.limit ?? 15}`));
    case 'brief': {
      const since = readCursor();
      const box = await api('GET', `${P()}/inbox?since=${since}`);
      out(await api('GET', `${P()}/brief.md?since=${since}`));
      writeCursor(box.cursor);
      return;
    }
    case 'proposals':
      return out(await api('GET', `${P()}/proposals.md${rest.length ? `?ids=${rest.map(encodeURIComponent).join(',')}` : ''}`));
    case 'pull':
      return pull();
    case 'subtasks':
      return subtasksCmd();
    case 'adopt': {
      const [id, rowId] = [need(rest[0], 'adopt <task-id> <row-id>'), need(rest[1], 'adopt <task-id> <row-id>')];
      const v = await api('GET', P());
      const { files, rows } = readBacklog(v.project.backlog?.files);
      const row = rows.find((r) => r.id === rowId) ?? fail(`${rowId} is not in ${files.join(' + ')} yet. Ingest the proposal first (product-manager), then adopt it.`);
      await api('POST', `${P()}/tasks/${encodeURIComponent(id)}/adopt`, toInput(row));
      return console.log(`${id === rowId ? id : `${id} → ${rowId}`}: now mirrors ${row.file} [${row.status}]`);
    }
    case 'inbox': {
      const since = flags.all ? 0 : readCursor();
      const box = await api('GET', `${P()}/inbox?since=${since}`);
      console.log(`# Inbox for ${ACTOR} on ${PROJECT} (events after #${since}, now #${box.cursor})\n`);
      console.log('## Open owner requests (change requests, instructions, questions)');
      if (!box.openFromOwner.length) console.log('- none');
      for (const c of box.openFromOwner) console.log(`- [${c.id}] ${c.kind.toUpperCase()}: "${c.text}"\n    about ${c.about}`);
      if (box.unconfirmedRequirements.length) console.log(`- (owner has not confirmed ${box.unconfirmedRequirements.join(', ')} yet)`);
      console.log('\n## Owner activity');
      if (!box.ownerEvents.length) console.log('- none');
      for (const e of box.ownerEvents) console.log(`- #${e.seq} ${e.actor}: ${e.summary}`);
      console.log(`\n## Pins: ${box.pins.length ? box.pins.join(' → ') : 'none'}`);
      writeCursor(box.cursor);
      return;
    }
    case 'show': {
      const id = need(rest[0], 'show <id>');
      const v = await api('GET', P());
      const task = v.project.tasks.find((t: any) => t.id === id) ?? fail(`No task ${id}`);
      return out({ task, insight: v.analysis.insights[id], comments: v.project.comments.filter((c: any) => c.target === `task:${id}`) });
    }
    case 'events':
      for (const e of await api('GET', `${P()}/events?since=${flags.since ?? 0}`)) console.log(`#${e.seq} ${e.at} ${e.actor}: ${e.summary}`);
      return;
    case 'check': {
      const checks = await api('GET', `${P()}/check`);
      if (!checks.length) console.log('plan check: clean');
      for (const c of checks) console.log(`${c.level.toUpperCase().padEnd(5)} ${c.code}: ${c.message}${c.fix ? `\n      → ${c.fix}` : ''}`);
      return;
    }
    case 'outline':
      return outline();
    case 'import': {
      const file = need(rest[0], 'import <plan.json>');
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const r = await api('POST', `${P()}/plan`, Array.isArray(data) ? { tasks: data } : data);
      console.log(`imported: ${r.requirements} requirements, ${r.groups} groups, ${r.tasksCreated} tasks created, ${r.tasksUpdated} updated, ${r.labels} labels, ${r.notes} notes`);
      const warns = (await api('GET', `${P()}/check`)).filter((c: any) => c.level !== 'info');
      console.log(warns.length ? `plan check: ${warns.length} warning(s) — run \`pmv check\`` : 'plan check: no warnings');
      return;
    }
    case 'add': {
      const f = taskFields();
      if (!f.title) fail('usage: pmv add --title "..." --group <id> --req R-1 [--deps ...]');
      const [t] = await api('POST', `${P()}/tasks`, f);
      return console.log(`created ${t.id}: ${t.title}`);
    }
    case 'edit': {
      const t = await api('PATCH', `${P()}/tasks/${need(rest[0], 'edit <id> --field value')}`, taskFields());
      return console.log(`updated ${t.id}`);
    }
    case 'rm':
      await api('DELETE', `${P()}/tasks/${need(rest[0], 'rm <id>')}`);
      return console.log(`deleted ${rest[0]}`);
    case 'start':
    case 'verify':
    case 'done':
      return setStatus(need(rest[0], `${cmd} <id>`), cmd === 'start' ? 'in_progress' : cmd === 'verify' ? 'needs_verification' : 'done');
    case 'block': {
      const id = need(rest[0], 'block <id> "<reason>"');
      await api('PATCH', `${P()}/tasks/${id}`, { status: 'blocked' });
      if (rest[1]) await api('POST', `${P()}/comments`, { target: `task:${id}`, kind: 'question', text: `Blocked: ${rest[1]}` });
      return console.log(`${id} → blocked`);
    }
    case 'ask':
    case 'comment': {
      const target = need(rest[0], `${cmd} <task-id|element|-> "<text>"`);
      const c = await api('POST', `${P()}/comments`, {
        target: target === '-' ? null : target.includes(':') ? target : `task:${target}`,
        kind: cmd === 'ask' ? 'question' : (flags.kind ?? 'comment'),
        text: need(rest[1], `${cmd} <task-id|element> "<text>"`),
      });
      return console.log(`posted ${c.id}`);
    }
    case 'reply': {
      const id = need(rest[0], 'reply <C-id> "<text>" [--resolve]');
      const c = await api('POST', `${P()}/comments`, { replyTo: id, text: need(rest[1], 'reply <C-id> "<text>"') });
      if (flags.resolve) await api('POST', `${P()}/comments/${id}/resolve`);
      return console.log(`posted ${c.id}${flags.resolve ? `; resolved ${id}` : ''}`);
    }
    case 'resolve':
      await api('POST', `${P()}/comments/${need(rest[0], 'resolve <C-id>')}/resolve`);
      return console.log(`resolved ${rest[0]}`);
    case 'pin':
      return out(await api('PUT', `${P()}/pins`, { pins: rest }));
    case 'req':
      return reqCmd();
    case 'group':
      return groupCmd();
    case 'label':
      await api('PUT', `${P()}/labels`, { from: need(rest[0], 'label <from> <to> "<text>"'), to: need(rest[1], 'label <from> <to> "<text>"'), label: rest[2] ?? null });
      return console.log(`labelled ${rest[0]} → ${rest[1]}`);
    case 'note': {
      const n = await api('POST', `${P()}/notes`, { target: need(rest[0], 'note <element> "<text>"'), text: need(rest[1], 'note <element> "<text>"'), tone: flags.tone ?? 'info' });
      return console.log(`note ${n.id} on ${n.target}`);
    }
    case 'note-rm':
      await api('DELETE', `${P()}/notes/${need(rest[0], 'note-rm <N-id>')}`);
      return console.log(`removed ${rest[0]}`);
    default:
      fail(`unknown command "${cmd}". Run \`pmv help\`.`);
  }
}

// ---------------------------------------------------------------- backlog bridge

/** Backlog files, relative to the repo root: the remembered ones, --file, or the defaults. */
function readBacklog(remembered?: string[]): { files: string[]; rows: BacklogRow[] } {
  const root = board?.root ?? process.cwd();
  const files = flags.file
    ? flags.file.split(',').map((f) => path.relative(root, path.resolve(f)))
    : remembered?.length
      ? remembered
      : ['docs/BACKLOG.md', 'docs/BACKLOG-done.md', 'BACKLOG.md'].filter((f) => existsSync(path.join(root, f)));
  if (!files.length) fail('no backlog file found (looked for docs/BACKLOG.md); pass --file <path>');
  const rows = files.flatMap((f) => {
    const abs = path.join(root, f);
    if (!existsSync(abs)) fail(`backlog file ${f} not found`);
    return parseBacklog(readFileSync(abs, 'utf8'), f);
  });
  return { files, rows };
}

const toInput = (r: BacklogRow) => ({ id: r.id, title: r.title, status: r.status, impact: r.impact, effort: r.effort, brief: r.brief, keyword: r.keyword, mentions: r.mentions });
const rowLine = (r: BacklogRow) => `  ${r.id} [${r.status}] ${r.title}${r.section ? ` · ${r.section}` : ''}`;

/**
 * Mirror backlog rows onto the board. Always refreshes the rows already there; adds new rows only
 * when they are named or matched, and only with --yes, so a board never fills up with unrelated work.
 */
async function pull() {
  const v = await api('GET', P());
  const { files, rows } = readBacklog(v.project.backlog?.files);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const mirrored: string[] = v.project.tasks.filter((t: any) => t.backlog).map((t: any) => t.id);
  const onBoard = new Set<string>(v.project.tasks.map((t: any) => t.id));

  const picked = new Map<string, BacklogRow>();
  const unknown: string[] = [];
  for (const id of rest) byId.has(id) ? picked.set(id, byId.get(id)!) : unknown.push(id);
  if (flags.match) for (const r of matchRows(rows, flags.match)) picked.set(r.id, r);
  const named = (src: BacklogRow[]) => [...new Set(src.flatMap((r) => r.mentions))].filter((m) => byId.has(m) && !onBoard.has(m) && !picked.has(m));
  const base = picked.size || flags.match ? [...picked.values()] : mirrored.map((id) => byId.get(id)!).filter(Boolean);
  if (flags.related) for (const m of named(base)) picked.set(m, byId.get(m)!);
  for (const id of onBoard) picked.delete(id);
  if (unknown.length) fail(`not in ${files.join(' + ')}: ${unknown.join(', ')}`);

  const add = flags.yes ? [...picked.values()] : [];
  console.log(`backlog: ${files.join(' + ')} (${rows.length} rows)`);
  if (add.length || !v.project.backlog) {
    const r = await api('POST', `${P()}/backlog`, { files, rows: add.map(toInput), group: flags.group });
    if (r.created.length) console.log(`added ${r.created.length}: ${r.created.join(', ')}${flags.group ? ` (phase ${flags.group})` : ' (no phase yet: pmv edit <id> --group <id>)'}`);
  }
  await syncNow(mirrored.length);
  if (picked.size && !flags.yes) {
    const list = [...picked.values()];
    console.log(`would add ${list.length} row${list.length === 1 ? '' : 's'}. Show this list to the owner; add with --yes once they agree:`);
    for (const r of list.slice(0, 25)) console.log(rowLine(r));
    if (list.length > 25) console.log(`  +${list.length - 25} more; narrow --match or name the rows`);
  } else if (!picked.size && (rest.length || flags.match)) console.log('nothing new to add');
  const refresh = mirrored.map((id) => byId.get(id)).filter((r): r is BacklogRow => !!r);
  const mentioned = named([...refresh, ...add]);
  if (mentioned.length) console.log(`named by these rows but not on the board: ${mentioned.slice(0, 12).join(', ')}${mentioned.length > 12 ? ' …' : ''} (pmv pull --related lists them)`);
}

/** Ask the board to re-read the documents now, and say what changed. */
async function syncNow(rowsOnBoard?: number) {
  const r = await api('POST', `${P()}/sync`);
  const v = await api('GET', P());
  const subs = v.project.tasks.filter((t: any) => t.subtask).length;
  const tracked = (v.project.backlog?.subtasks ?? []).map((s: any) => s.row);
  console.log(
    `synced: ${rowsOnBoard ?? v.project.tasks.filter((t: any) => t.backlog).length} rows${tracked.length ? `, ${subs} subtasks from ${tracked.join(', ')}` : ''}` +
      `${r.created?.length ? `; new ${r.created.join(', ')}` : ''}${r.adopted?.length ? `; joined their brief: ${r.adopted.join(', ')}` : ''}`,
  );
  if (r.changed?.length) console.log(`changed: ${r.changed.join('; ')}`);
  for (const x of r.problems ?? []) console.log(`  ! ${x}`);
  return r;
}

async function subtasksCmd() {
  const [sub, ...ids] = rest;
  const v = await api('GET', P());
  const { files, rows } = readBacklog(v.project.backlog?.files);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const root = board?.root ?? process.cwd();
  const row = (id: string) => byId.get(id) ?? fail(`${id} is not in ${files.join(' + ')}`);

  if (sub === 'add') {
    if (!ids.length) fail('usage: pmv subtasks add <row-id>... [--group <id>]');
    for (const id of ids) {
      const b = briefPath(row(id));
      if (!b) console.log(`  ! ${id}'s row links no brief; its subtasks show once it does`);
      else if (!existsSync(path.join(root, b)) || !parseSubtasks(readFileSync(path.join(root, b), 'utf8')).found)
        console.log(`  ! ${b} has no "## Subtasks" table yet; the cards appear when the PM writes it`);
    }
    await api('POST', `${P()}/subtasks`, { files, rows: ids.map((r) => ({ row: r, ...(flags.group ? { group: flags.group } : {}) })) });
    console.log(`showing subtasks of ${ids.join(', ')}`);
    await syncNow();
    return;
  }
  if (sub === 'rm') {
    const r = await api('DELETE', `${P()}/subtasks/${encodeURIComponent(need(ids[0], 'subtasks rm <row-id>'))}`);
    return console.log(`stopped showing ${ids[0]}'s subtasks${r.removed.length ? `; removed ${r.removed.join(', ')}` : ''}`);
  }
  if (sub === 'export') return exportCmd(v.project, ids, { files, byId, root });
  if (sub) fail('usage: pmv subtasks [add <row-id>... | rm <row-id> | export [<row-id> [<task-id>...]]]');

  const tracked = v.project.backlog?.subtasks ?? [];
  if (!tracked.length) console.log('no subtasks shown yet: pmv subtasks add <row-id>');
  for (const t of tracked) {
    const list = v.project.tasks.filter((x: any) => x.subtask?.row === t.row);
    const counts = list.reduce((m: Record<string, number>, x: any) => ((m[x.subtask.status || '—'] = (m[x.subtask.status || '—'] ?? 0) + 1), m), {});
    const r = byId.get(t.row);
    console.log(`${t.row} ${r ? `"${r.title}" ` : ''}— ${list.length} subtasks (${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'none yet'})${r && briefPath(r) ? ` · ${briefPath(r)}` : ''}`);
  }
  const claims = Object.entries(v.project.backlog?.claims ?? {});
  if (claims.length) console.log(`waiting for their brief's table: ${claims.map(([id, r]) => `${id}→${r}`).join(', ')}`);
  const loose = v.project.tasks.filter((x: any) => !x.subtask && !x.backlog).map((x: any) => x.id);
  if (v.project.backlog && loose.length) console.log(`not synced (board-only): ${loose.join(', ')} — pmv subtasks export`);
  for (const x of v.project.backlog?.problems ?? []) console.log(`  ! ${x}`);
}

/** Board-only cards → Subtasks tables; records which row each card belongs to unless --dry-run. */
async function exportCmd(project: any, ids: string[], ctx: { files: string[]; byId: Map<string, BacklogRow>; root: string }) {
  const tasks = new Map<string, any>(project.tasks.map((t: any) => [t.id, t]));
  const plans: { row: string; ids: string[] }[] = [];
  let unassigned: string[] = [];
  if (ids.length) {
    // ROW [task...] [ROW [task...]]...: a token that is a backlog row starts the next row's list.
    for (const tok of ids) {
      if (ctx.byId.has(tok)) plans.push({ row: tok, ids: [] });
      else if (!plans.length) fail(`${tok} is not in ${ctx.files.join(' + ')}; start with a row id: pmv subtasks export <row-id> [<task-id>...]`);
      else plans[plans.length - 1].ids.push(tok);
    }
    const groups = flags.group ? flags.group.split(',') : [];
    for (const plan of plans) {
      if (!plan.ids.length)
        plan.ids = groups.length && plans.length === 1
          ? project.tasks.filter((t: any) => groups.includes(t.group) && !t.subtask && !t.backlog).map((t: any) => t.id)
          : (guessRows(project, (r) => r === plan.row).get(plan.row) ?? []).map((t) => t.id);
      if (!plan.ids.length) fail(`no board-only cards for ${plan.row}: name them (pmv subtasks export ${plan.row} T1 T2 ...) or pass --group <id>`);
      for (const id of plan.ids) {
        const t = tasks.get(id) ?? fail(`no task ${id}`);
        if (t.subtask || t.backlog) fail(`${id} is already synced (${t.subtask ? `${t.subtask.row}'s subtask ${t.subtask.id}` : `row ${t.backlog.id}`})`);
      }
    }
  } else {
    const guess = guessRows(project, (r) => ctx.byId.has(r));
    for (const [row, list] of guess) if (row) plans.push({ row, ids: list.map((t) => t.id) });
    unassigned = (guess.get(null) ?? []).filter((t) => !project.backlog?.claims?.[t.id]).map((t) => t.id);
    if (!plans.length && !unassigned.length) return console.log('every card on this board is synced or waiting for its brief');
  }
  const rowOf = (id: string) => plans.find((pl) => pl.ids.includes(id))?.row ?? project.backlog?.claims?.[id];

  for (const plan of plans) {
    const r = ctx.byId.get(plan.row)!;
    const brief = briefPath(r);
    const { items, loose } = exportSubtasks(project, plan.ids, plan.row, rowOf);
    const table = renderSubtasks(items);
    console.log(`\n## ${plan.row} "${r.title}" → ${brief ?? '(its row links no brief yet)'}\n`);
    if (flags.write && brief && !flags['dry-run']) {
      const abs = path.join(ctx.root, brief);
      if (!existsSync(abs)) fail(`brief ${brief} not found`);
      writeFileSync(abs, writeSubtasks(readFileSync(abs, 'utf8'), table));
      console.log(`wrote the Subtasks table into ${brief}`);
    } else {
      console.log('## Subtasks\n');
      console.log(table);
    }
    if (loose.length) console.log(`\n(waits on board-only ${loose.join(', ')}: export those too, or they show as text)`);
  }
  if (unassigned.length)
    console.log(`\nNames no backlog row: ${unassigned.join(', ')}\n  → pmv subtasks export <row-id> <task-id>...   (or --group <id>)`);
  if (flags['dry-run'] || !plans.length) return;
  // Each card joins its row's table when the brief lists its id; nothing changes on the board until then.
  const groupOf = (list: string[]) => {
    const c = new Map<string, number>();
    for (const id of list) if (tasks.get(id)?.group) c.set(tasks.get(id).group, (c.get(tasks.get(id).group) ?? 0) + 1);
    return [...c].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  await api('POST', `${P()}/subtasks`, { files: ctx.files, rows: plans.map((pl) => ({ row: pl.row, claim: pl.ids, ...(groupOf(pl.ids) ? { group: groupOf(pl.ids) } : {}) })) });
  console.log(
    `\nBoard: ${plans.map((pl) => `${pl.ids.length} cards → ${pl.row}`).join(', ')}. They keep their ids, comments and approvals and follow the brief once its table lists them${flags.write ? '' : ' (paste the table under "## Subtasks" in the brief)'}; the board picks it up on the next page load.`,
  );
  if (flags.write) await syncNow();
}

async function setStatus(id: string, status: string | undefined) {
  await needProject();
  const s = need(status, 'status <id> <ready|in_progress|needs_verification|blocked|done>');
  const patch: Record<string, unknown> = { status: s };
  if (s === 'in_progress') patch.assignee = ACTOR;
  if (s === 'done') patch.assignee = null;
  const t = await api('PATCH', `${P()}/tasks/${id}`, patch);
  console.log(`${t.id} → ${t.status}`);
}

async function boardStatus() {
  const h = await health();
  if (!h) return out(`no board running at ${BASE}${board ? ' (pmv open starts it)' : ''}`);
  const projects = await api('GET', '/api/projects');
  out(`board running at ${BASE} (pid ${h.pid}, data ${h.dataDir})\nprojects: ${projects.map((p: any) => p.id).join(', ') || 'none'}${PROJECT ? `\nusing: ${PROJECT} → ${BASE}/#/${PROJECT}` : ''}`);
}

async function init() {
  const root = process.cwd();
  const dir = path.join(root, '.pm-visual');
  if (existsSync(path.join(dir, 'config.json'))) {
    const b = loadBoard(dir)!;
    out(`already set up: ${path.relative(root, dir)} (project ${b.config.project}, port ${b.config.port}). Use \`pmv open\`.`);
    return;
  }
  const name = flags.name ?? path.basename(root);
  const id = (flags.id ?? name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'board';
  const port = Number(flags.port ?? (await freePort(DEFAULT_PORT)));
  mkdirSync(path.join(dir, 'data'), { recursive: true });
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ project: id, port }, null, 2));
  writeFileSync(path.join(dir, '.gitignore'), 'server.log\nserver.pid\ncursors/\nshots/\n');
  console.log(`created ${path.relative(root, dir)}/ (project "${id}", port ${port})`);

  // Re-exec so the rest runs with the new board config.
  const res = spawn(process.execPath, [...process.execArgv, process.argv[1], 'project-create', id, name], { cwd: root, stdio: 'inherit', env: { ...process.env, PM_DIR: dir } });
  await new Promise((r) => res.on('exit', r));

  if (!flags['no-skill']) {
    // A user-scope copy (e.g. from skill-repo) already serves every project; don't add a second one.
    const user = ['.claude', '.codex'].map((d) => path.join(homedir(), d, 'skills', 'pm-visual', 'SKILL.md')).find(existsSync);
    const src = [path.join(HERE, '..', 'agent', 'pm-visual'), path.join(HERE, 'agent', 'pm-visual')].find((d) => existsSync(path.join(d, 'SKILL.md')));
    if (user) console.log(`agent skill: using ${user}`);
    else if (src)
      for (const d of ['.claude', '.agents']) {
        const dest = path.join(root, d, 'skills', 'pm-visual');
        cpSync(src, dest, { recursive: true });
        console.log(`installed agent skill: ${path.relative(root, dest)}/`);
      }
  }
  const gi = path.join(root, '.gitignore');
  if (existsSync(gi) && !readFileSync(gi, 'utf8').includes('.pm-visual'))
    console.log('Board data lives in .pm-visual/data/. If the board is only a view of your backlog, add .pm-visual/ to .gitignore.');
  console.log(`
Board: http://127.0.0.1:${port}/#/${id}   (pmv open --browser)
Next, for the agent: follow the pm-visual skill. Write plan.json from the owner's request, or pmv pull rows
from the backlog, then: pmv import plan.json && pmv check`);
}

async function serve() {
  const dir = board?.dir ?? fail('no .pm-visual here; run pmv init');
  const port = Number(flags.port ?? board!.config.port);
  const { startServer } = await import('../server/app');
  const s = await startServer({ port, dataDir: path.join(dir, 'data'), uiDir: uiDir(), root: board!.root, version: VERSION }).catch((e: Error) => fail(`cannot start on port ${port}: ${e.message}`));
  writeFileSync(path.join(dir, 'server.pid'), String(process.pid));
  if (!flags.quiet) console.log(`PM Visual board on ${s.url}/#/${board!.config.project}  (Ctrl-C to stop)`);
  const stop = () =>
    s.close().then(() => {
      rmSync(path.join(dir, 'server.pid'), { force: true });
      process.exit(0);
    });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function outline() {
  const v = await api('GET', P());
  const { project: p, structure: st } = v;
  const pc = (r: any) => `${Math.round((r?.progress ?? 0) * 100)}%`;
  console.log('Requirements');
  for (const r of p.requirements) console.log(`  ${r.id} [${r.status}] ${r.title} — ${pc(st.requirements[r.id])}, ${st.requirements[r.id]?.tasks.length ?? 0} tasks`);
  console.log('Phases');
  const walk = (parent: string | null, depth: number) => {
    for (const g of p.groups.filter((x: any) => x.parent === parent).sort((a: any, b: any) => a.order - b.order)) {
      console.log(`${'  '.repeat(depth)}${g.id} "${g.name}" — ${pc(st.groups[g.id])}`);
      for (const t of p.tasks.filter((t: any) => t.group === g.id)) console.log(`${'  '.repeat(depth + 1)}${t.id} ${t.title} [${t.status}] ${t.requirements.join(',')}`);
      walk(g.id, depth + 1);
    }
  };
  walk(null, 1);
  const loose = p.tasks.filter((t: any) => !t.group);
  if (loose.length) console.log(`No phase\n${loose.map((t: any) => `  ${t.id} ${t.title}`).join('\n')}`);
}

async function reqCmd() {
  const [sub, id] = rest;
  const body: Record<string, unknown> = {};
  for (const k of ['title', 'detail', 'id']) if (flags[k] !== undefined) body[k] = flags[k];
  if (flags.order) body.order = Number(flags.order);
  if (flags.meta) body.meta = parseMeta(flags.meta);
  if (sub === 'add') {
    const [r] = await api('POST', `${P()}/requirements`, body);
    return console.log(`requirement ${r.id}: ${r.title}`);
  }
  if (sub === 'edit') {
    const r = await api('PATCH', `${P()}/requirements/${need(id, 'req edit <id> --title ...')}`, body);
    return console.log(`requirement ${r.id} updated${r.status === 'draft' ? ' (owner must confirm it again)' : ''}`);
  }
  if (sub === 'rm') {
    await api('DELETE', `${P()}/requirements/${need(id, 'req rm <id>')}`);
    return console.log(`removed ${id}`);
  }
  const v = await api('GET', P());
  for (const r of v.project.requirements) console.log(`${r.id}\t[${r.status}]\t${r.title}\n\t${r.detail}`);
}

async function groupCmd() {
  const [sub, id] = rest;
  const body: Record<string, unknown> = {};
  for (const k of ['name', 'goal', 'id']) if (flags[k] !== undefined) body[k] = flags[k];
  if (flags.parent !== undefined) body.parent = flags.parent === 'none' ? null : flags.parent;
  if (flags.order) body.order = Number(flags.order);
  if (flags.meta) body.meta = parseMeta(flags.meta);
  if (sub === 'add') {
    const [g] = await api('POST', `${P()}/groups`, body);
    return console.log(`group ${g.id}: ${g.name}${g.parent ? ` (in ${g.parent})` : ''}`);
  }
  if (sub === 'edit') {
    const g = await api('PATCH', `${P()}/groups/${need(id, 'group edit <id> --name ...')}`, body);
    return console.log(`group ${g.id} updated`);
  }
  if (sub === 'rm') {
    await api('DELETE', `${P()}/groups/${need(id, 'group rm <id>')}`);
    return console.log(`removed ${id}`);
  }
  const v = await api('GET', P());
  for (const g of v.project.groups) console.log(`${g.id}\t${g.parent ? `(in ${g.parent})` : 'phase'}\t${g.name} — ${g.goal}`);
}

/** Screenshot a view so an agent can check the visual result before handing over. */
async function shot() {
  await ensureServer();
  await needProject();
  let chromium: any;
  const load = async (spec: string) => {
    const m: any = await import(spec);
    return m.chromium ?? m.default?.chromium;
  };
  try {
    chromium = await load(pathToFileUrl(createRequire(path.join(process.cwd(), 'package.json')).resolve('playwright-core')));
  } catch {
    chromium = await load('playwright-core' as string).catch(() => null);
  }
  if (!chromium) fail('pmv shot needs playwright-core and a local Chrome: npm i -D playwright-core');
  const view = rest[0] ?? 'overview';
  const hash = view === 'overview' ? '' : view === 'all' || view === 'critical' ? `/${view}` : `/g/${view}`;
  const file = path.resolve(flags.out ?? path.join(board?.dir ?? '.', 'shots', `${PROJECT}-${view}.png`));
  mkdirSync(path.dirname(file), { recursive: true });
  const browser = await chromium.launch({ channel: flags.channel ?? 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: Number(flags.width ?? 1600), height: Number(flags.height ?? 960) } });
  await page.goto(`${BASE}/#/${PROJECT}${hash}`);
  await page.waitForSelector('.react-flow__node, .empty-board', { timeout: 15000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: file });
  await browser.close();
  out(file);
}
const pathToFileUrl = (p: string) => new URL(`file://${p}`).href;

async function demo() {
  const id = 'demo';
  const list = await api('GET', '/api/projects');
  if (!list.some((p: any) => p.id === id)) await api('POST', '/api/projects', { id, name: 'Demo: signups from the landing page' });
  PROJECT = id;
  const v = await api('GET', P());
  if (v.project.tasks.length) return out(`demo already exists: ${BASE}/#/${id}`);
  const plan = JSON.parse(readFileSync([path.join(HERE, '..', 'agent', 'demo-plan.json'), path.join(HERE, 'agent', 'demo-plan.json')].find(existsSync)!, 'utf8'));
  await api('POST', `${P()}/plan`, plan);
  await api('PATCH', `${P()}/tasks/D-02`, { status: 'done' });
  await api('PATCH', `${P()}/tasks/D-01`, { status: 'needs_verification' });
  await api('PATCH', `${P()}/tasks/D-08`, { status: 'in_progress', assignee: 'agent:demo' });
  await api('POST', `${P()}/comments`, { target: 'task:D-01', kind: 'question', text: 'Should "company" be an optional field?' });
  out(`demo ready: ${BASE}/#/${id}`);
}

main().catch((e) => fail(String(e?.message ?? e)));

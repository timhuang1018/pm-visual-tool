// HTTP + WebSocket server (one per project board). REST for humans and agents, WebSocket pushes live snapshots.
//
//   GET    /api/projects                         list projects
//   POST   /api/projects                         {id?, name, description?}
//   GET    /api/projects/:pid                    project + analysis (JSON)
//   GET    /api/projects/:pid/plan.md            plan written for AI agents (Markdown)
//   GET    /api/projects/:pid/brief.md?since=N   short session digest (owner activity after event N)
//   GET    /api/projects/:pid/proposals.md?ids=  board-only tasks as ingest cards for the backlog owner
//   POST   /api/projects/:pid/backlog            {files, rows, group?} mirror backlog rows (create or refresh)
//   POST   /api/projects/:pid/sync               re-read the backlog and tracked briefs now (also runs on page load)
//   POST   /api/projects/:pid/subtasks           {files, rows: [{row, group?, claim?}]} show rows' brief Subtasks tables
//   DELETE /api/projects/:pid/subtasks/:row      stop showing a row's subtasks
//   POST   /api/projects/:pid/tasks/:id/adopt    {backlog row} a proposal became that row (renames it)
//   POST   /api/projects/:pid/tasks              task object or array of tasks
//   PATCH  /api/projects/:pid/tasks/:id          partial task
//   DELETE /api/projects/:pid/tasks/:id
//   POST   /api/projects/:pid/tasks/:id/approve-gate   (humans only)
//   POST   /api/projects/:pid/comments           {taskId?, kind?, text, replyTo?}
//   POST   /api/projects/:pid/comments/:cid/resolve
//   PUT    /api/projects/:pid/pins               {pins: [taskId...]}
//   GET    /api/projects/:pid/events?since=N
//   GET    /api/projects/:pid/inbox?since=N      owner directives/questions/change requests + owner activity
//   POST   /api/projects/:pid/plan               {requirements?, groups?, tasks?, labels?, notes?} create-or-update by id
//   GET    /api/projects/:pid/check              plan check (structure feedback for agents)
//   POST   /api/projects/:pid/requirements       requirement or array;  PATCH/DELETE /requirements/:id
//   POST   /api/projects/:pid/groups             group or array;        PATCH/DELETE /groups/:id
//   PUT    /api/projects/:pid/labels             {from, to, label|null}
//   POST   /api/projects/:pid/notes              {target, tone, text};  PATCH/DELETE /notes/:id
//   WS     /ws?project=:pid                      live snapshots
//
// Identify yourself with the X-Actor header: "agent:<name>" or "human:<name>".

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { renderBrief, renderProposals } from '../shared/briefText';
import { renderPlan } from '../shared/planText';
import type { WsMessage } from '../shared/types';
import { HttpError, Store } from './store';
import { DocSync } from './sync';


export interface ServerOptions {
  port: number;
  /** Directory holding one JSON file per project. */
  dataDir: string;
  /** Built UI (index.html + assets); null = API only. */
  uiDir: string | null;
  /** Create the sample project from doc/tasks.md (development only). */
  seedSample?: boolean;
  host?: string;
  /** Repo root that backlog and brief paths are relative to; null = no document sync. */
  root?: string | null;
  /** Re-sync when a watched document changes (default true when root is set). */
  watch?: boolean;
  /** Package version, reported by /api/health so the CLI can restart an older board. */
  version?: string;
}

export interface RunningServer {
  url: string;
  store: Store;
  close: () => Promise<void>;
}

export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const store = new Store(opts.dataDir);
  if (opts.seedSample) store.seedSample();
  const DIST = opts.uiDir;
  const startedAt = new Date().toISOString();
  const docs = opts.root ? new DocSync(store, opts.root) : null;
  /** Bring a board up to date with the documents before showing it (cheap when nothing changed). */
  const fresh = (pid: string) => {
    docs?.safeSync(pid);
    return pid;
  };

  type Handler = (req: IncomingMessage, params: Record<string, string>, body: any, url: URL) => unknown;
  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
  function route(method: string, p: string, handler: Handler) {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' + p.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')).replace(/\./g, '\\.') + '$',
    );
    routes.push({ method, pattern, keys, handler });
  }

  const actorOf = (req: IncomingMessage, body?: any): string => {
    const a = String(req.headers['x-actor'] ?? body?.actor ?? '').trim();
    if (!a) return 'agent:unknown';
    return /^(agent|human):/.test(a) ? a : `agent:${a}`;
  };

  route('GET', '/api/health', () => ({ ok: true, app: 'pm-visual', version: opts.version ?? null, dataDir: opts.dataDir, startedAt, pid: process.pid }));
  route('GET', '/api/projects', () => store.listProjects());
  route('POST', '/api/projects', (req, _p, b) => {
    const p = store.createProject(b ?? {}, actorOf(req, b));
    return { id: p.id, name: p.name };
  });
  route('GET', '/api/projects/:pid', (_r, { pid }) => store.view(fresh(pid)));
  route('GET', '/api/projects/:pid/plan.md', (_r, { pid }, _b, url) =>
    text(renderPlan(store.view(fresh(pid)), { limit: Number(url.searchParams.get('limit') ?? 15) })),
  );
  route('GET', '/api/projects/:pid/brief.md', (_r, { pid }, _b, url) => {
    const since = url.searchParams.get('since');
    return text(renderBrief(store.view(fresh(pid)), { ownerEvents: since === null ? [] : store.inbox(pid, Number(since)).ownerEvents }));
  });
  route('GET', '/api/projects/:pid/proposals.md', (_r, { pid }, _b, url) =>
    text(renderProposals(store.view(pid), url.searchParams.get('ids')?.split(',').filter(Boolean))),
  );
  route('POST', '/api/projects/:pid/backlog', (req, { pid }, b) => store.syncBacklog(pid, b ?? {}, actorOf(req, b)));
  const sync = (pid: string) => {
    if (!docs) throw new HttpError(400, 'This server has no repo root, so it cannot read the backlog');
    store.get(pid);
    return docs.sync(pid, true) ?? { created: [], adopted: [], changed: [], problems: ['no backlog linked to this board yet'] };
  };
  route('POST', '/api/projects/:pid/sync', (_r, { pid }) => sync(pid));
  route('POST', '/api/projects/:pid/subtasks', (req, { pid }, b) => {
    const tracked = store.trackSubtasks(pid, b ?? {}, actorOf(req, b));
    return { ...tracked, ...(docs ? sync(pid) : {}) };
  });
  route('DELETE', '/api/projects/:pid/subtasks/:row', (req, { pid, row }) => store.untrackSubtasks(pid, row, actorOf(req)));
  route('POST', '/api/projects/:pid/tasks/:id/adopt', (req, { pid, id }, b) => store.adoptTask(pid, id, b ?? {}, actorOf(req, b)));
  route('POST', '/api/projects/:pid/tasks', (req, { pid }, b) => {
    const list = Array.isArray(b) ? b : Array.isArray(b?.tasks) ? b.tasks : [b];
    return store.createTasks(pid, list, actorOf(req, b));
  });
  route('PATCH', '/api/projects/:pid/tasks/:id', (req, { pid, id }, b) => store.updateTask(pid, id, b ?? {}, actorOf(req, b)));
  route('DELETE', '/api/projects/:pid/tasks/:id', (req, { pid, id }) => (store.deleteTask(pid, id, actorOf(req)), { ok: true }));
  route('POST', '/api/projects/:pid/tasks/:id/approve-gate', (req, { pid, id }, b) => store.approveGate(pid, id, actorOf(req, b)));
  route('POST', '/api/projects/:pid/comments', (req, { pid }, b) => store.addComment(pid, b ?? {}, actorOf(req, b)));
  route('POST', '/api/projects/:pid/comments/:cid/resolve', (req, { pid, cid }, b) => store.resolveComment(pid, cid, actorOf(req, b)));
  route('PUT', '/api/projects/:pid/pins', (req, { pid }, b) => ({ pins: store.setPins(pid, b?.pins, actorOf(req, b)) }));
  route('POST', '/api/projects/:pid/plan', (req, { pid }, b) => store.importPlan(pid, b, actorOf(req, b)));
  route('GET', '/api/projects/:pid/check', (_r, { pid }) => store.view(fresh(pid)).structure.checks);
  route('POST', '/api/projects/:pid/requirements', (req, { pid }, b) => store.upsertRequirements(pid, Array.isArray(b) ? b : [b], actorOf(req, b)));
  route('PATCH', '/api/projects/:pid/requirements/:id', (req, { pid, id }, b) => store.updateRequirement(pid, id, b ?? {}, actorOf(req, b)));
  route('DELETE', '/api/projects/:pid/requirements/:id', (req, { pid, id }) => (store.deleteRequirement(pid, id, actorOf(req)), { ok: true }));
  route('POST', '/api/projects/:pid/groups', (req, { pid }, b) => store.upsertGroups(pid, Array.isArray(b) ? b : [b], actorOf(req, b)));
  route('PATCH', '/api/projects/:pid/groups/:id', (req, { pid, id }, b) => store.updateGroup(pid, id, b ?? {}, actorOf(req, b)));
  route('DELETE', '/api/projects/:pid/groups/:id', (req, { pid, id }) => (store.deleteGroup(pid, id, actorOf(req)), { ok: true }));
  route('PUT', '/api/projects/:pid/labels', (req, { pid }, b) => (store.setLabel(pid, b?.from, b?.to, b?.label ?? null, actorOf(req, b)), { ok: true }));
  route('POST', '/api/projects/:pid/notes', (req, { pid }, b) => store.addNote(pid, b ?? {}, actorOf(req, b)));
  route('PATCH', '/api/projects/:pid/notes/:id', (req, { pid, id }, b) => store.updateNote(pid, id, b ?? {}, actorOf(req, b)));
  route('DELETE', '/api/projects/:pid/notes/:id', (req, { pid, id }) => (store.deleteNote(pid, id, actorOf(req)), { ok: true }));
  route('GET', '/api/projects/:pid/events', (_r, { pid }, _b, url) => store.events(pid, Number(url.searchParams.get('since') ?? 0)));
  route('GET', '/api/projects/:pid/inbox', (_r, { pid }, _b, url) => store.inbox(pid, Number(url.searchParams.get('since') ?? 0)));

  class Text {
    constructor(public body: string) {}
  }
  const text = (s: string) => new Text(s);

  async function readBody(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'Body must be JSON');
    }
  }

  function send(res: ServerResponse, status: number, body: unknown) {
    if (body instanceof Text) {
      res.writeHead(status, { 'content-type': 'text/markdown; charset=utf-8' });
      res.end(body.body);
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };

  function serveStatic(url: URL, res: ServerResponse) {
    if (!DIST) return send(res, 404, { error: 'This server runs the API only. In development the UI is on http://localhost:5173.' });
    let file = path.join(DIST, decodeURIComponent(url.pathname));
    if (!file.startsWith(DIST)) return send(res, 403, { error: 'forbidden' });
    if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    if (!existsSync(file)) return send(res, 404, { error: 'UI not built. Run `npm run build`.' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, x-actor');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (!url.pathname.startsWith('/api/')) return serveStatic(url, res);
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.pattern);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = ['POST', 'PATCH', 'PUT'].includes(req.method!) ? await readBody(req) : undefined;
        return send(res, 200, await r.handler(req, params, body, url));
      }
      send(res, 404, { error: `No route ${req.method} ${url.pathname}` });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: String((e as Error)?.message ?? e) });
    }
  });

  // ---------- WebSocket hub ----------

  const wss = new WebSocketServer({ server, path: '/ws' });
  const subs = new Map<WebSocket, string | null>();

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const pid = url.searchParams.get('project');
    subs.set(ws, pid);
    push(ws, { type: 'projects', projects: store.listProjects() });
    // Loading the page is the refresh: read the documents first, then show the board.
    if (pid && store.has(pid)) push(ws, { type: 'snapshot', project: pid, view: store.view(fresh(pid)) });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'subscribe') {
          subs.set(ws, msg.project);
          if (store.has(msg.project)) push(ws, { type: 'snapshot', project: msg.project, view: store.view(fresh(msg.project)) });
        }
      } catch {
        /* ignore */
      }
    });
    ws.on('close', () => subs.delete(ws));
  });

  function push(ws: WebSocket, msg: WsMessage) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  // Coalesce bursts (e.g. bulk task creation) into one snapshot per project per tick.
  const pending = new Map<string, import('../shared/types').PmEvent>();
  store.onEvent((pid, event) => {
    if (event.type === 'project.created') for (const ws of subs.keys()) push(ws, { type: 'projects', projects: store.listProjects() });
    const first = !pending.size;
    pending.set(pid, event);
    if (first)
      setTimeout(() => {
        for (const [p, ev] of pending) {
          const view = store.view(p);
          for (const [ws, sub] of subs) if (sub === p) push(ws, { type: 'snapshot', project: p, view, event: ev });
        }
        pending.clear();
      }, 30);
  });


  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      if (docs && opts.watch !== false) docs.watch();
      resolve({
        url: `http://localhost:${opts.port}`,
        store,
        close: () =>
          new Promise<void>((done) => {
            docs?.close();
            store.flush();
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}

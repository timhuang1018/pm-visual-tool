// Keeps boards in step with the repo's documents: the backlog file(s) and the Subtasks tables of
// the briefs a board tracks. Runs when the board page loads, when an agent reads the board, on
// `pmv pull`, and when a watched file changes. The store applies the rules; this only reads files.

import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { briefPath, parseBacklog, parseSubtasks, type BacklogRow } from '../shared/backlog';
import type { Project } from '../shared/types';
import type { DocsInput, Store, SubtaskSource } from './store';

const ACTOR = 'agent:docs';

export class DocSync {
  private seen = new Map<string, string>();
  private watchers = new Map<string, FSWatcher>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private store: Store,
    /** Repo root the backlog paths are relative to. */
    private root: string,
  ) {}

  private cache = new Map<string, { stamp: string; value: unknown }>();

  /** A file parsed, re-read only when its mtime or size changed; null when missing. */
  private read<T>(rel: string, parse: (text: string) => T): { value: T; stamp: string } | null {
    const abs = path.resolve(this.root, rel);
    try {
      const st = statSync(abs);
      const stamp = `${rel}:${st.mtimeMs}:${st.size}`;
      const hit = this.cache.get(`${abs}|${parse.name}`);
      if (hit?.stamp === stamp) return { value: hit.value as T, stamp };
      const value = parse(readFileSync(abs, 'utf8'));
      this.cache.set(`${abs}|${parse.name}`, { stamp, value });
      return { value, stamp };
    } catch {
      return null;
    }
  }

  /** Files a project depends on (backlog files and tracked briefs), for the watcher. */
  private files(p: Project, rows?: BacklogRow[]): string[] {
    const out = [...(p.backlog?.files ?? [])];
    for (const s of p.backlog?.subtasks ?? []) {
      const r = rows?.find((x) => x.id === s.row);
      const b = r && briefPath(r);
      if (b) out.push(b);
    }
    return out;
  }

  /**
   * Read the documents and apply them to one project. Skips the work when no file and nothing on
   * the board changed since the last run (unless forced). Returns null when the board has no backlog.
   */
  sync(pid: string, force = false) {
    if (!this.store.has(pid)) return null;
    const p = this.store.get(pid);
    if (!p.backlog) return null;
    const problems: string[] = [];
    const stamps: string[] = [`seq:${p.seq}`];
    const rows: BacklogRow[] = [];
    for (const f of p.backlog.files) {
      const got = this.read(f, function backlog(text) {
        return parseBacklog(text, f);
      });
      if (!got) {
        problems.push(`backlog file ${f} not found`);
        continue;
      }
      stamps.push(got.stamp);
      rows.push(...got.value);
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    const subtasks: SubtaskSource[] = [];
    for (const s of p.backlog.subtasks ?? []) {
      const row = byId.get(s.row);
      if (!row) {
        if (rows.length) problems.push(`${s.row}: not in ${p.backlog.files.join(' + ')}`);
        subtasks.push({ row: s.row, brief: '', items: [], missing: true });
        continue;
      }
      const brief = briefPath(row);
      const got = brief ? this.read(brief, parseSubtasks) : null;
      if (!brief || !got) {
        problems.push(`${s.row}: ${brief ? `brief ${brief} not found` : 'its row links no brief'}`);
        subtasks.push({ row: s.row, title: row.title, brief: brief ?? '', items: [], missing: true });
        continue;
      }
      stamps.push(got.stamp);
      const parsed = got.value;
      if (!parsed.found) problems.push(`${s.row}: ${brief} has no "## Subtasks" table yet`);
      subtasks.push({ row: s.row, title: row.title, brief, items: parsed.items, problems: parsed.problems, missing: !parsed.found });
    }
    const stamp = stamps.join('|');
    if (!force && this.seen.get(pid) === stamp) return { skipped: true as const };
    const mirrored = new Set(p.tasks.filter((t) => t.backlog).map((t) => t.backlog!.id));
    for (const id of mirrored) if (rows.length && !byId.has(id)) problems.push(`${id}: gone from the backlog (pmv rm ${id} if the row was removed)`);
    const input: DocsInput = {
      files: p.backlog.files,
      rows: rows.filter((r) => mirrored.has(r.id)).map((r) => ({ id: r.id, title: r.title, status: r.status, impact: r.impact, effort: r.effort, brief: r.brief, keyword: r.keyword, mentions: r.mentions })),
      subtasks,
      problems,
    };
    const result = this.store.syncDocs(pid, input, ACTOR);
    // Our own event moved seq; remember the state after it so the next read can skip.
    this.seen.set(pid, [`seq:${this.store.get(pid).seq}`, ...stamps.slice(1)].join('|'));
    this.rewatch(rows, pid);
    return result;
  }

  /** Sync, but never let a document problem break a page load or a read. */
  safeSync(pid: string) {
    try {
      return this.sync(pid);
    } catch (e) {
      console.error(`sync of ${pid} failed:`, e);
      return null;
    }
  }

  syncAll() {
    for (const { id } of this.store.listProjects()) this.safeSync(id);
  }

  // ---------- watching ----------

  private enabled = false;
  private wanted = new Map<string, Set<string>>();

  /** Watch the folders of every synced board's documents; a change re-syncs after a short pause. */
  watch() {
    this.enabled = true;
    this.syncAll();
  }

  private rewatch(rows: BacklogRow[], pid: string) {
    if (!this.enabled) return;
    const dirs = new Set(this.files(this.store.get(pid), rows).map((f) => path.dirname(path.resolve(this.root, f))));
    this.wanted.set(pid, dirs);
    const all = new Set([...this.wanted.values()].flatMap((s) => [...s]));
    for (const [dir, w] of this.watchers)
      if (!all.has(dir)) {
        w.close();
        this.watchers.delete(dir);
      }
    for (const dir of all) {
      if (this.watchers.has(dir) || !existsSync(dir)) continue;
      try {
        const w = watch(dir, (_e, name) => {
          if (name && !String(name).endsWith('.md')) return;
          if (this.timer) clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            this.timer = null;
            this.syncAll();
          }, 300);
        });
        w.on('error', () => {
          w.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, w);
      } catch {
        /* watching is optional: page loads and reads still sync */
      }
    }
  }

  close() {
    this.enabled = false;
    if (this.timer) clearTimeout(this.timer);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }
}

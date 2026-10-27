// In-memory project store persisted as one JSON file per project under data/.
// Every mutation appends an event and notifies listeners (the WebSocket hub).

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { analyze, cycleIfDepends } from '../shared/analysis';
import { backlogStatus, knownStatus, parseDep, plain, type Subtask } from '../shared/backlog';
import { describeRef } from '../shared/describe';
import { buildStructure, groupChain } from '../shared/structure';
import {
  COMMENT_KINDS,
  NOTE_TONES,
  SIZES,
  STATUSES,
  STATUS_LABEL,
  isSynced,
  parseRef,
  type Actor,
  type Comment,
  type CommentKind,
  type ElementRef,
  type Gate,
  type Group,
  type Meta,
  type Note,
  type NoteTone,
  type PmEvent,
  type Project,
  type ProjectMeta,
  type ProjectView,
  type Requirement,
  type Size,
  type Status,
  type Task,
} from '../shared/types';
import { loadSampleProject } from './seed';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_EVENTS = 2000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$/;

export type Listener = (projectId: string, event: PmEvent) => void;

export interface TaskInput {
  id?: string;
  title?: string;
  description?: string;
  area?: string;
  status?: string;
  impact?: string;
  effort?: string;
  dependsOn?: string[] | string;
  gate?: string | { description: string; status?: string } | null;
  group?: string | null;
  requirements?: string[] | string;
  assignee?: string | null;
  meta?: unknown;
}
export interface RequirementInput {
  id?: string;
  title?: string;
  detail?: string;
  order?: number;
  status?: string;
  meta?: unknown;
}
export interface GroupInput {
  id?: string;
  name?: string;
  goal?: string;
  parent?: string | null;
  order?: number;
  meta?: unknown;
}
export interface NoteInput {
  id?: string;
  target?: string;
  tone?: string;
  text?: string;
}
/** A backlog row as the CLI sends it (parsed from the repo's backlog file). */
export interface BacklogRowInput {
  id: string;
  title?: string;
  status: string;
  impact?: string;
  effort?: string;
  brief?: string;
  keyword?: string;
  mentions?: string[];
}
/** One tracked row's brief, as the server read it. */
export interface SubtaskSource {
  row: string;
  /** Card label of the row, for a phase made for its subtasks. */
  title?: string;
  /** Brief path relative to the repo root. */
  brief: string;
  items: Subtask[];
  problems?: string[];
  /** The brief or its table could not be read: leave the cards as they are. */
  missing?: boolean;
}
/** Everything a sync read from the repo's documents. */
export interface DocsInput {
  files: string[];
  /** Rows for the mirrored tasks (the ones found). */
  rows: BacklogRowInput[];
  subtasks: SubtaskSource[];
  problems?: string[];
}
export interface PlanInput {
  requirements?: RequirementInput[];
  groups?: GroupInput[];
  tasks?: TaskInput[];
  labels?: { from: string; to: string; label: string | null }[];
  notes?: NoteInput[];
}

export class Store {
  private projects = new Map<string, Project>();
  private listeners = new Set<Listener>();
  private saveTimers = new Map<string, NodeJS.Timeout>();
  private buffer: { pid: string; e: PmEvent }[] | null = null;

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const p = migrate(JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
        this.projects.set(p.id, p);
      } catch (e) {
        console.error(`Skipping unreadable project file ${f}:`, e);
      }
    }
  }

  onEvent(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  // ---------- projects ----------

  listProjects(): ProjectMeta[] {
    return [...this.projects.values()]
      .map(({ id, name, description, createdAt }) => ({ id, name, description, createdAt }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  createProject(input: { id?: string; name?: string; description?: string }, actor: Actor): Project {
    const name = (input.name ?? input.id ?? '').trim();
    if (!name) throw new HttpError(400, 'Project needs a name');
    const id = (input.id ?? slug(name)).trim();
    if (!ID_RE.test(id)) throw new HttpError(400, `Invalid project id "${id}"`);
    if (this.projects.has(id)) throw new HttpError(409, `Project "${id}" already exists`);
    const p: Project = migrate({ id, name, description: input.description ?? '', createdAt: new Date().toISOString() });
    this.projects.set(id, p);
    this.emit(p, actor, 'project.created', `Created project ${name}`);
    return p;
  }

  seedSample(force = false) {
    if (this.projects.has('sample') && !force) return;
    this.projects.delete('sample');
    const p = this.createProject(
      {
        id: 'sample',
        name: 'Earnings-call pipeline (sample)',
        description: 'Sample backlog from doc/tasks.md, structured into requirements and phases (doc/sample-structure.json).',
      },
      'human:owner',
    );
    this.importPlan('sample', loadSampleProject(), 'agent:sample-planner');
  }

  get(pid: string): Project {
    const p = this.projects.get(pid);
    if (!p) throw new HttpError(404, `No project "${pid}". Known: ${[...this.projects.keys()].join(', ') || 'none'}`);
    return p;
  }

  view(pid: string): ProjectView {
    const project = this.get(pid);
    const analysis = analyze(project.tasks, project.pins);
    return { project, analysis, structure: buildStructure(project, analysis) };
  }

  /** Run a multi-step change atomically: on error, roll the project back and drop its events. */
  private transact<T>(pid: string, fn: (p: Project) => T): T {
    const p = this.get(pid);
    const backup = structuredClone(p);
    const outer = this.buffer;
    const buf: { pid: string; e: PmEvent }[] = [];
    this.buffer = buf;
    try {
      const out = fn(p);
      this.buffer = outer;
      if (outer) outer.push(...buf);
      else for (const { pid: id, e } of buf) this.notify(id, e);
      return out;
    } catch (err) {
      this.buffer = outer;
      this.projects.set(pid, Object.assign(p, backup));
      throw err;
    }
  }

  // ---------- whole plan (agents) ----------

  /** Create-or-update requirements, groups, tasks, labels and notes by id, all or nothing. */
  importPlan(pid: string, plan: PlanInput, actor: Actor) {
    if (!plan || typeof plan !== 'object') throw new HttpError(400, 'Plan must be an object {requirements?, groups?, tasks?, labels?, notes?}');
    return this.transact(pid, (p) => {
      const result = { requirements: 0, groups: 0, tasksCreated: 0, tasksUpdated: 0, labels: 0, notes: 0 };
      if (plan.requirements?.length) result.requirements = this.upsertRequirements(pid, plan.requirements, actor).length;
      if (plan.groups?.length) result.groups = this.upsertGroups(pid, plan.groups, actor).length;
      if (plan.tasks?.length) {
        const existing = new Set(p.tasks.map((t) => t.id));
        const fresh = plan.tasks.filter((t) => !t.id || !existing.has(t.id));
        const updates = plan.tasks.filter((t) => t.id && existing.has(t.id));
        if (fresh.length) result.tasksCreated = this.createTasks(pid, fresh, actor).length;
        for (const u of updates) this.updateTask(pid, u.id!, u, actor);
        result.tasksUpdated = updates.length;
      }
      for (const l of plan.labels ?? []) {
        this.setLabel(pid, l.from, l.to, l.label, actor);
        result.labels++;
      }
      for (const n of plan.notes ?? []) {
        if (n.id && p.notes.some((x) => x.id === n.id)) this.updateNote(pid, n.id, n, actor);
        else this.addNote(pid, n, actor);
        result.notes++;
      }
      return result;
    });
  }

  // ---------- requirements ----------

  upsertRequirements(pid: string, inputs: RequirementInput[], actor: Actor): Requirement[] {
    const p = this.get(pid);
    if (!Array.isArray(inputs) || !inputs.length) throw new HttpError(400, 'Send a requirement or a non-empty array');
    return this.transact(pid, () =>
      inputs.map((inp) => {
        const existing = inp.id ? p.requirements.find((r) => r.id === inp.id) : undefined;
        if (existing) return this.updateRequirement(pid, existing.id, inp, actor);
        const title = String(inp.title ?? '').trim();
        if (!title) throw new HttpError(400, 'Requirement needs a title');
        const id = inp.id?.trim() || nextId(p.requirements.map((r) => r.id), 'R-', 1);
        if (!ID_RE.test(id)) throw new HttpError(400, `Invalid requirement id "${id}"`);
        const r: Requirement = {
          id,
          title,
          detail: String(inp.detail ?? ''),
          status: inp.status === 'confirmed' && !isAgent(actor) ? 'confirmed' : 'draft',
          order: inp.order ?? p.requirements.length + 1,
          ...(inp.meta !== undefined ? { meta: parseMeta(inp.meta) } : {}),
          createdBy: actor,
          createdAt: new Date().toISOString(),
        };
        p.requirements.push(r);
        this.emit(p, actor, 'structure.updated', `Requirement ${id} added: ${title}`, `req:${id}`);
        return r;
      }),
    );
  }

  updateRequirement(pid: string, id: string, inp: RequirementInput, actor: Actor): Requirement {
    const p = this.get(pid);
    const r = p.requirements.find((x) => x.id === id);
    if (!r) throw new HttpError(404, `No requirement ${id}`);
    const changes: string[] = [];
    let reworded = false;
    if (inp.title !== undefined && inp.title.trim() && inp.title !== r.title) {
      r.title = inp.title.trim();
      changes.push('title');
      reworded = true;
    }
    if (inp.detail !== undefined && inp.detail !== r.detail) {
      r.detail = inp.detail;
      changes.push('detail');
      reworded = true;
    }
    if (inp.order !== undefined && inp.order !== r.order) {
      r.order = Number(inp.order);
      changes.push('order');
    }
    if (inp.meta !== undefined) {
      r.meta = parseMeta(inp.meta);
      changes.push('details');
    }
    if (inp.status !== undefined && inp.status !== r.status) {
      if (inp.status === 'confirmed') {
        if (isAgent(actor)) throw new HttpError(403, 'Only the owner can confirm a requirement');
        r.status = 'confirmed';
        r.confirmedBy = actor;
        changes.push('confirmed');
      } else if (inp.status === 'draft') {
        r.status = 'draft';
        changes.push('back to draft');
      }
    }
    // An agent rewording a confirmed requirement sends it back to the owner.
    if (reworded && isAgent(actor) && r.status === 'confirmed') {
      r.status = 'draft';
      changes.push('needs re-confirmation');
    }
    if (changes.length) this.emit(p, actor, 'structure.updated', `Requirement ${id}: ${changes.join(', ')}`, `req:${id}`);
    return r;
  }

  deleteRequirement(pid: string, id: string, actor: Actor) {
    const p = this.get(pid);
    if (!p.requirements.some((r) => r.id === id)) throw new HttpError(404, `No requirement ${id}`);
    p.requirements = p.requirements.filter((r) => r.id !== id);
    for (const t of p.tasks) t.requirements = t.requirements.filter((x) => x !== id);
    p.comments = p.comments.filter((c) => c.target !== `req:${id}`);
    this.emit(p, actor, 'structure.updated', `Requirement ${id} removed`, `req:${id}`);
  }

  // ---------- groups ----------

  upsertGroups(pid: string, inputs: GroupInput[], actor: Actor): Group[] {
    const p = this.get(pid);
    if (!Array.isArray(inputs) || !inputs.length) throw new HttpError(400, 'Send a group or a non-empty array');
    return this.transact(pid, () => {
      // Create all new ids first so parents can be referenced within the batch.
      const created: Group[] = [];
      for (const inp of inputs) {
        if (inp.id && p.groups.some((g) => g.id === inp.id)) continue;
        const name = String(inp.name ?? '').trim();
        if (!name) throw new HttpError(400, 'Group needs a name');
        const id = inp.id?.trim() || slug(name);
        if (!ID_RE.test(id)) throw new HttpError(400, `Invalid group id "${id}"`);
        if (p.groups.some((g) => g.id === id)) throw new HttpError(409, `Group ${id} already exists`);
        const g: Group = { id, name, goal: String(inp.goal ?? ''), parent: null, order: inp.order ?? p.groups.filter((x) => !x.parent).length + 1 };
        p.groups.push(g);
        created.push(g);
      }
      const out = inputs.map((inp) => {
        const id = inp.id?.trim() || slug(String(inp.name));
        return this.updateGroup(pid, id, inp, actor, true);
      });
      for (const g of created) this.emit(p, actor, 'structure.updated', `${g.parent ? 'Sub-group' : 'Phase'} ${g.id} added: ${g.name}`, `group:${g.id}`);
      return out;
    });
  }

  updateGroup(pid: string, id: string, inp: GroupInput, actor: Actor, quiet = false): Group {
    const p = this.get(pid);
    const g = p.groups.find((x) => x.id === id);
    if (!g) throw new HttpError(404, `No group ${id}`);
    const changes: string[] = [];
    if (inp.name !== undefined && inp.name.trim() && inp.name !== g.name) (g.name = inp.name.trim()), changes.push('name');
    if (inp.goal !== undefined && inp.goal !== g.goal) (g.goal = inp.goal), changes.push('goal');
    if (inp.order !== undefined && Number(inp.order) !== g.order) (g.order = Number(inp.order)), changes.push('order');
    if (inp.meta !== undefined) (g.meta = parseMeta(inp.meta)), changes.push('details');
    if (inp.parent !== undefined && (inp.parent || null) !== g.parent) {
      const parent = inp.parent || null;
      if (parent) {
        if (!p.groups.some((x) => x.id === parent)) throw new HttpError(400, `Unknown parent group ${parent}`);
        if (parent === id || groupChain(p, parent).includes(id)) throw new HttpError(400, `Group ${id} cannot be inside itself`);
      }
      g.parent = parent;
      changes.push(`parent → ${parent ?? 'top level'}`);
    }
    if (changes.length && !quiet) this.emit(p, actor, 'structure.updated', `Group ${id}: ${changes.join(', ')}`, `group:${id}`);
    return g;
  }

  deleteGroup(pid: string, id: string, actor: Actor) {
    const p = this.get(pid);
    const g = p.groups.find((x) => x.id === id);
    if (!g) throw new HttpError(404, `No group ${id}`);
    for (const x of p.groups) if (x.parent === id) x.parent = g.parent;
    for (const t of p.tasks) if (t.group === id) t.group = g.parent;
    p.groups = p.groups.filter((x) => x.id !== id);
    p.notes = p.notes.filter((n) => n.target !== `group:${id}`);
    p.comments = p.comments.filter((c) => c.target !== `group:${id}`);
    this.emit(p, actor, 'structure.updated', `Group ${id} removed (contents moved up)`, `group:${id}`);
  }

  // ---------- labels and notes ----------

  setLabel(pid: string, from: string, to: string, label: string | null, actor: Actor) {
    const p = this.get(pid);
    const known = (id: string) => p.tasks.some((t) => t.id === id) || p.groups.some((g) => g.id === id);
    if (!known(from) || !known(to)) throw new HttpError(400, `Label ends must be task or group ids (got ${from} → ${to})`);
    p.labels = p.labels.filter((l) => !(l.from === from && l.to === to));
    if (label && label.trim()) p.labels.push({ from, to, label: label.trim() });
    this.emit(p, actor, 'structure.updated', label ? `Link ${from} → ${to} labelled "${label}"` : `Label removed from ${from} → ${to}`, `link:${from}>${to}`);
  }

  addNote(pid: string, inp: NoteInput, actor: Actor): Note {
    const p = this.get(pid);
    const text = String(inp.text ?? '').trim();
    if (!text) throw new HttpError(400, 'Note needs text');
    this.assertRef(p, inp.target);
    const n: Note = {
      id: inp.id?.trim() || nextId(p.notes.map((x) => x.id), 'N-', 1),
      target: inp.target!,
      tone: parseTone(inp.tone),
      text,
      createdBy: actor,
    };
    p.notes.push(n);
    this.emit(p, actor, 'structure.updated', `Note on ${n.target}: ${truncate(text, 60)}`, n.target);
    return n;
  }

  updateNote(pid: string, id: string, inp: NoteInput, actor: Actor): Note {
    const p = this.get(pid);
    const n = p.notes.find((x) => x.id === id);
    if (!n) throw new HttpError(404, `No note ${id}`);
    if (inp.text !== undefined) n.text = String(inp.text);
    if (inp.tone !== undefined) n.tone = parseTone(inp.tone);
    if (inp.target !== undefined) {
      this.assertRef(p, inp.target);
      n.target = inp.target;
    }
    this.emit(p, actor, 'structure.updated', `Note ${id} updated`, n.target);
    return n;
  }

  deleteNote(pid: string, id: string, actor: Actor) {
    const p = this.get(pid);
    const n = p.notes.find((x) => x.id === id);
    if (!n) throw new HttpError(404, `No note ${id}`);
    p.notes = p.notes.filter((x) => x.id !== id);
    this.emit(p, actor, 'structure.updated', `Note ${id} removed`, n.target);
  }

  // ---------- tasks ----------

  createTasks(pid: string, inputs: TaskInput[], actor: Actor): Task[] {
    const p = this.get(pid);
    if (!Array.isArray(inputs) || !inputs.length) throw new HttpError(400, 'Send a task object or a non-empty array of tasks');
    const now = new Date().toISOString();
    const existing = new Set(p.tasks.map((t) => t.id));
    let next = nextNumber(p.tasks);
    const created: Task[] = inputs.map((inp, i) => {
      const where = inputs.length > 1 ? ` (task #${i + 1})` : '';
      if (!inp || typeof inp !== 'object') throw new HttpError(400, `Task must be an object${where}`);
      const title = String(inp.title ?? '').trim();
      if (!title) throw new HttpError(400, `Task needs a title${where}`);
      let id = inp.id?.trim();
      if (id) {
        if (!ID_RE.test(id)) throw new HttpError(400, `Invalid task id "${id}"${where}`);
        if (existing.has(id)) throw new HttpError(409, `Task ${id} already exists${where}`);
      } else {
        do id = `T-${String(next++).padStart(2, '0')}`;
        while (existing.has(id) || inputs.some((x) => x.id === id));
      }
      existing.add(id);
      return {
        id,
        title,
        description: String(inp.description ?? ''),
        area: String(inp.area ?? '').trim(),
        status: parseStatus(inp.status ?? 'ready', where),
        impact: parseSize(inp.impact ?? 'M', 'impact', where),
        effort: parseSize(inp.effort ?? 'M', 'effort', where),
        dependsOn: parseList(inp.dependsOn),
        gate: parseGate(inp.gate, actor),
        group: this.checkGroup(p, inp.group, where),
        requirements: this.checkReqs(p, inp.requirements, where),
        assignee: inp.assignee ?? null,
        ...(inp.meta !== undefined ? { meta: parseMeta(inp.meta, where) } : {}),
        createdBy: actor,
        createdAt: now,
        updatedAt: now,
      };
    });
    const all = [...p.tasks, ...created];
    const ids = new Set(all.map((t) => t.id));
    for (const t of created) {
      const missing = t.dependsOn.filter((d) => !ids.has(d));
      if (missing.length) throw new HttpError(400, `${t.id} depends on unknown task(s): ${missing.join(', ')}`);
      const cycle = cycleIfDepends(
        all.map((x) => (x.id === t.id ? { ...x, dependsOn: [] } : x)),
        t.id,
        t.dependsOn,
      );
      if (cycle) throw new HttpError(400, `Dependency cycle: ${cycle.join(' → ')}`);
    }
    p.tasks.push(...created);
    if (created.length > 3) this.emit(p, actor, 'task.created', `${created.length} tasks created: ${created.map((t) => t.id).join(', ')}`);
    else for (const t of created) this.emit(p, actor, 'task.created', `${t.id} created: ${t.title}`, `task:${t.id}`);
    return created;
  }

  updateTask(pid: string, id: string, patch: TaskInput, actor: Actor): Task {
    const p = this.get(pid);
    const t = this.task(p, id);
    const changes: string[] = [];
    const next: Task = { ...t };
    const set = <K extends keyof Task>(k: K, v: Task[K], label: string, show = true) => {
      if (JSON.stringify(t[k]) === JSON.stringify(v)) return;
      next[k] = v;
      changes.push(show ? `${label}: ${fmt(t[k])} → ${fmt(v)}` : `${label} edited`);
    };
    if (patch.title !== undefined) set('title', String(patch.title).trim() || t.title, 'title');
    if (patch.description !== undefined) set('description', String(patch.description), 'description', false);
    if (patch.area !== undefined) set('area', String(patch.area).trim(), 'area');
    if (patch.status !== undefined) set('status', parseStatus(patch.status), 'status');
    if (patch.impact !== undefined) set('impact', parseSize(patch.impact, 'impact'), 'impact');
    if (patch.effort !== undefined) set('effort', parseSize(patch.effort, 'effort'), 'effort');
    if (patch.assignee !== undefined) set('assignee', patch.assignee || null, 'assignee');
    if (patch.meta !== undefined) set('meta', parseMeta(patch.meta), 'details', false);
    if (patch.gate !== undefined) set('gate', parseGate(patch.gate, actor), 'gate', false);
    if (patch.group !== undefined) set('group', this.checkGroup(p, patch.group), 'group');
    if (patch.requirements !== undefined) set('requirements', this.checkReqs(p, patch.requirements), 'serves');
    if (patch.dependsOn !== undefined) {
      const deps = parseList(patch.dependsOn);
      const ids = new Set(p.tasks.map((x) => x.id));
      const missing = deps.filter((d) => !ids.has(d));
      if (missing.length) throw new HttpError(400, `Unknown task(s): ${missing.join(', ')}`);
      if (deps.includes(id)) throw new HttpError(400, `${id} cannot depend on itself`);
      const cycle = cycleIfDepends(
        p.tasks.map((x) => (x.id === id ? { ...x, dependsOn: [] } : x)),
        id,
        deps,
      );
      if (cycle) throw new HttpError(400, `Dependency cycle: ${cycle.join(' → ')}`);
      set('dependsOn', deps, 'waits on');
    }
    if (t.backlog && (next.status !== t.status || next.impact !== t.impact || next.effort !== t.effort)) {
      throw new HttpError(
        409,
        `${id} mirrors backlog row ${t.backlog.id} (${p.backlog?.files[0] ?? 'the backlog'}): its status and sizing are kept there. Change the row, then \`pmv pull\`.`,
      );
    }
    if (t.subtask) {
      const kept = (['status', 'impact', 'effort', 'title', 'dependsOn'] as const).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(t[k]));
      if (next.gate?.description !== t.gate?.description || !!next.gate !== !!t.gate) kept.push('gate' as never);
      if (kept.length)
        throw new HttpError(
          409,
          `${id} is subtask ${t.subtask.id} of ${t.subtask.row}: its ${kept.join(', ')} ${kept.length > 1 ? 'are' : 'is'} kept in the Subtasks table of ${t.subtask.brief}. Change the table; the board refreshes on page load or \`pmv pull\`.`,
        );
    }
    if (next.status === 'done' && t.status !== 'done' && next.gate?.status === 'pending' && isAgent(actor)) {
      throw new HttpError(
        409,
        `${id} has a pending owner gate ("${next.gate.description}"). Ask the owner (pmv ask ${id} "...") and wait for approval before marking it done.`,
      );
    }
    if (!changes.length) return t;
    next.updatedAt = new Date().toISOString();
    Object.assign(t, next);
    if (t.status === 'done' && p.pins.includes(id)) p.pins = p.pins.filter((x) => x !== id);
    this.emit(p, actor, 'task.updated', `${id} ${changes.join('; ')}`, `task:${id}`);
    return t;
  }

  deleteTask(pid: string, id: string, actor: Actor) {
    const p = this.get(pid);
    const t = this.task(p, id);
    p.tasks = p.tasks.filter((x) => x.id !== id);
    for (const x of p.tasks) x.dependsOn = x.dependsOn.filter((d) => d !== id);
    p.pins = p.pins.filter((x) => x !== id);
    p.labels = p.labels.filter((l) => l.from !== id && l.to !== id);
    p.notes = p.notes.filter((n) => n.target !== `task:${id}`);
    p.comments = p.comments.filter((c) => c.target !== `task:${id}`);
    if (p.backlog?.claims) delete p.backlog.claims[id];
    this.emit(p, actor, 'task.deleted', `${id} deleted: ${t.title}`, `task:${id}`);
  }

  approveGate(pid: string, id: string, actor: Actor): Task {
    const p = this.get(pid);
    const t = this.task(p, id);
    if (!t.gate) throw new HttpError(400, `${id} has no gate`);
    if (isAgent(actor)) throw new HttpError(403, 'Only a human owner can approve a gate');
    if (t.gate.status === 'approved') return t;
    t.gate = { ...t.gate, status: 'approved', approvedBy: actor, approvedAt: new Date().toISOString() };
    t.updatedAt = t.gate.approvedAt!;
    this.emit(p, actor, 'gate.approved', `${id} gate approved: ${t.gate.description}`, `task:${id}`);
    return t;
  }

  // ---------- backlog mirror ----------

  /**
   * Mirror backlog rows: refresh the ones already on the board (status, sizing, link) and create
   * the others as tasks. The caller decides which rows; the board never writes the backlog.
   */
  syncBacklog(pid: string, input: { files?: string[]; rows?: BacklogRowInput[]; group?: string | null }, actor: Actor) {
    const rows = input?.rows;
    if (!Array.isArray(rows)) throw new HttpError(400, 'Send {files, rows: [{id, status, ...}]}');
    return this.transact(pid, (p) => {
      const group = this.checkGroup(p, input.group);
      const fresh = rows.filter((r) => !p.tasks.some((t) => t.id === r.id));
      const created = fresh.length
        ? this.createTasks(
            pid,
            fresh.map((r) => ({ id: r.id, title: r.title || r.id, group })),
            actor,
          )
        : [];
      const changed: string[] = [];
      for (const r of rows) {
        const t = this.task(p, r.id);
        if (!t.backlog && !created.includes(t)) throw new HttpError(409, `${r.id} is already a board task that does not mirror the backlog. Use \`pmv adopt ${r.id} ${r.id}\` to link it.`);
        const before = t.backlog?.status;
        this.mirror(p, t, r);
        if (before !== undefined && before !== t.backlog!.status) changed.push(`${t.id} ${before} → ${t.backlog!.status}`);
      }
      p.backlog = { files: input.files?.length ? input.files : (p.backlog?.files ?? []), syncedAt: new Date().toISOString() };
      if (changed.length) this.emit(p, actor, 'task.updated', `From the backlog: ${changed.join('; ')}`);
      return { created: created.map((t) => t.id), updated: rows.length - created.length, changed };
    });
  }

  /** A proposal was ingested as a backlog row: link it, renaming it to the row id everywhere. */
  adoptTask(pid: string, id: string, row: BacklogRowInput, actor: Actor): Task {
    if (!row?.id || !ID_RE.test(row.id)) throw new HttpError(400, 'Send the backlog row {id, status, ...}');
    return this.transact(pid, (p) => {
      const t = this.task(p, id);
      if (t.backlog) throw new HttpError(409, `${id} already mirrors backlog row ${t.backlog.id}`);
      if (row.id !== id) {
        if (p.tasks.some((x) => x.id === row.id)) throw new HttpError(409, `${row.id} is already on the board`);
        this.renameTask(p, id, row.id);
      }
      this.mirror(p, t, row);
      if (p.backlog?.claims) delete p.backlog.claims[id];
      this.emit(p, actor, 'task.updated', `${id === row.id ? id : `${id} → ${row.id}`}: now tracked in the backlog`, `task:${row.id}`);
      return t;
    });
  }

  private mirror(p: Project, t: Task, r: BacklogRowInput) {
    const before = JSON.stringify([t.status, t.impact, t.effort, t.assignee, t.backlog]);
    const status = backlogStatus(r.status ?? '');
    if (t.status !== 'done' && status === 'done') p.pins = p.pins.filter((x) => x !== t.id);
    t.status = status;
    if (r.impact) t.impact = parseSize(r.impact, 'impact');
    if (r.effort) t.effort = parseSize(r.effort, 'effort');
    if (status !== 'in_progress') t.assignee = null;
    t.backlog = {
      id: r.id,
      status: String(r.status ?? '').trim(),
      ...(r.brief ? { brief: String(r.brief) } : {}),
      ...(r.keyword ? { keyword: String(r.keyword) } : {}),
      ...(r.mentions?.length ? { mentions: parseList(r.mentions) } : {}),
    };
    if (JSON.stringify([t.status, t.impact, t.effort, t.assignee, t.backlog]) !== before) t.updatedAt = new Date().toISOString();
  }

  // ---------- brief subtasks ----------

  /**
   * Show the Subtasks tables of these rows' briefs on the board. `claim` names board-only tasks
   * that become the row's subtasks once its table lists their ids (migration: they keep their id,
   * comments and gate approval).
   */
  trackSubtasks(pid: string, input: { files?: string[]; rows?: { row: string; group?: string | null; claim?: string[] }[] }, actor: Actor) {
    const rows = input?.rows;
    if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, 'Send {files, rows: [{row, group?, claim?}]}');
    return this.transact(pid, (p) => {
      p.backlog ??= { files: input.files ?? [], syncedAt: new Date().toISOString() };
      if (input.files?.length) p.backlog.files = input.files;
      const list = (p.backlog.subtasks ??= []);
      const claims = (p.backlog.claims ??= {});
      for (const r of rows) {
        if (!r?.row || !ID_RE.test(r.row)) throw new HttpError(400, `Invalid row id "${r?.row}"`);
        const group = r.group === undefined ? undefined : this.checkGroup(p, r.group) ?? undefined;
        const cur = list.find((x) => x.row === r.row);
        if (cur) {
          if (group !== undefined) cur.group = group;
        } else list.push({ row: r.row, ...(group ? { group } : {}) });
        for (const id of parseList(r.claim)) {
          const t = this.task(p, id);
          if (isSynced(t)) throw new HttpError(409, `${id} already ${t.backlog ? `mirrors backlog row ${t.backlog.id}` : `is subtask ${t.subtask!.id} of ${t.subtask!.row}`}`);
          claims[id] = r.row;
        }
        const claimed = parseList(r.claim);
        this.emit(p, actor, 'structure.updated', `Showing ${r.row}'s subtasks from its brief${claimed.length ? `; ${claimed.join(', ')} join it once the table lists them` : ''}`);
      }
      return { subtasks: list, claims };
    });
  }

  /** Stop showing a row's subtasks: its cards leave the board (the brief keeps them). */
  untrackSubtasks(pid: string, row: string, actor: Actor) {
    return this.transact(pid, (p) => {
      const list = p.backlog?.subtasks ?? [];
      if (!list.some((x) => x.row === row)) throw new HttpError(404, `${row}'s subtasks are not on this board`);
      p.backlog!.subtasks = list.filter((x) => x.row !== row);
      for (const [id, r] of Object.entries(p.backlog!.claims ?? {})) if (r === row) delete p.backlog!.claims![id];
      const gone = p.tasks.filter((t) => t.subtask?.row === row).map((t) => t.id);
      for (const id of gone) this.deleteTask(pid, id, actor);
      this.emit(p, actor, 'structure.updated', `Stopped showing ${row}'s subtasks${gone.length ? ` (removed ${gone.join(', ')})` : ''}`);
      return { removed: gone };
    });
  }

  /**
   * Apply what the repo's documents say: mirrored rows' status and sizing, and every tracked row's
   * Subtasks table (new subtasks, title, status, size, estimate, waits-on, gate wording). The board
   * keeps placement, requirements, comments, pins and the owner's gate approvals. Never throws on
   * bad data: what it cannot apply becomes a problem for the plan check.
   */
  syncDocs(pid: string, input: DocsInput, actor: Actor) {
    return this.transact(pid, (p) => {
      const now = new Date().toISOString();
      p.backlog ??= { files: input.files ?? [], syncedAt: now };
      const src = p.backlog;
      if (input.files?.length) src.files = input.files;
      src.syncedAt = now;
      const problems = [...(input.problems ?? [])];
      const changed: string[] = [];
      const snap = (t: Task) => JSON.stringify([t.title, t.status, t.impact, t.effort, t.dependsOn, t.gate, t.meta, t.backlog, t.subtask, t.group, t.assignee]);

      for (const r of input.rows ?? []) {
        const t = p.tasks.find((x) => x.backlog?.id === r.id);
        if (!t) continue;
        const was = t.backlog!.status;
        this.mirror(p, t, r);
        if (was !== t.backlog!.status) changed.push(`${t.id} ${was} → ${t.backlog!.status}`);
      }

      const tracked = new Map((src.subtasks ?? []).map((x) => [x.row, x]));
      const claims = (src.claims ??= {});
      const created: Task[] = [];
      const adopted: string[] = [];
      const touched: { task: Task; item: Subtask; row: string; before: string }[] = [];
      const key = (row: string, id: string) => `${row}\u0000${id}`;
      const bySub = new Map<string, Task>();
      for (const t of p.tasks) if (t.subtask) bySub.set(key(t.subtask.row, t.subtask.id), t);

      for (const s of input.subtasks ?? []) {
        if (!tracked.has(s.row)) continue;
        for (const x of s.problems ?? []) problems.push(`${s.row} (${s.brief}): ${x}`);
        if (s.missing) continue;
        for (const item of s.items) {
          let t = bySub.get(key(s.row, item.id));
          let before = t ? snap(t) : '';
          if (!t) {
            const claimed = p.tasks.find((x) => !isSynced(x) && x.id === item.id && claims[x.id] === s.row);
            if (claimed) {
              t = claimed;
              before = snap(t);
              delete claims[item.id];
              adopted.push(item.id);
            } else {
              const id = [item.id, `${s.row}.${item.id}`].find((x) => ID_RE.test(x) && !p.tasks.some((y) => y.id === x));
              if (!id) {
                problems.push(`${s.row} ${item.id}: no free task id (${item.id} and ${s.row}.${item.id} are taken)`);
                continue;
              }
              t = {
                id,
                title: item.title,
                description: '',
                area: '',
                status: 'ready',
                impact: 'M',
                effort: 'M',
                dependsOn: [],
                gate: null,
                group: null,
                requirements: [],
                assignee: null,
                createdBy: actor,
                createdAt: now,
                updatedAt: now,
              };
              p.tasks.push(t);
              created.push(t);
            }
            bySub.set(key(s.row, item.id), t);
          }
          const status = backlogStatus(item.status);
          if (item.status && !knownStatus(item.status)) problems.push(`${s.row} ${item.id}: status "${item.status}" is not a backlog status word (read as Ready)`);
          if (!item.status) problems.push(`${s.row} ${item.id}: no status (read as Ready)`);
          if (status === 'done' && t.status !== 'done') p.pins = p.pins.filter((x) => x !== t!.id);
          t.title = item.title;
          t.status = status;
          if (item.effort) t.effort = item.effort;
          if (item.impact) t.impact = item.impact;
          if (status !== 'in_progress') t.assignee = null;
          const meta = { ...(t.meta ?? {}) };
          if (item.estimate) meta.estimate = item.estimate;
          else delete meta.estimate;
          if (Object.keys(meta).length) t.meta = meta;
          else delete t.meta;
          // The gate wording comes from the table; the owner's approval stays while the wording does.
          if (!item.gate) t.gate = null;
          else if (!t.gate || plain(t.gate.description) !== plain(item.gate)) t.gate = { description: item.gate, status: 'pending' };
          t.subtask = { row: s.row, id: item.id, status: item.status, brief: s.brief, ...(item.estimate ? { estimate: item.estimate } : {}) };
          touched.push({ task: t, item, row: s.row, before });
        }
        const listed = new Set(s.items.map((x) => x.id));
        for (const t of p.tasks)
          if (t.subtask?.row === s.row && !listed.has(t.subtask.id))
            problems.push(`${t.id}: no longer in ${s.row}'s Subtasks table (pmv rm ${t.id} if it was dropped)`);
      }

      // Waits-on, after every subtask exists: same-brief ids, other briefs' subtasks, rows on the board.
      const rowTask = (row: string) => p.tasks.find((x) => x.backlog?.id === row || (x.id === row && !x.subtask));
      for (const { task } of touched) task.dependsOn = [];
      for (const { task, item, row } of touched) {
        const after: string[] = [];
        for (const d of item.dependsOn) {
          const ref = parseDep(d, row);
          const target = !ref ? undefined : ref.id ? bySub.get(key(ref.row, ref.id)) : rowTask(ref.row);
          if (!target) {
            if (ref && ref.row === row && ref.id) problems.push(`${row} ${item.id}: waits on "${d}", which is not in the table`);
            after.push(d);
            continue;
          }
          if (target === task || task.dependsOn.includes(target.id)) continue;
          const cycle = cycleIfDepends(p.tasks, task.id, [...task.dependsOn, target.id]);
          if (cycle) {
            problems.push(`${row} ${item.id}: waiting on ${d} would make a cycle (${cycle.join(' → ')}); left out`);
            continue;
          }
          task.dependsOn.push(target.id);
        }
        if (after.length) task.subtask!.after = after;
      }

      // New subtasks go next to their siblings: the phase of one they wait on or that waits on
      // them, else their siblings' usual phase, else the row's phase (made when needed).
      for (const t of created) {
        const row = t.subtask!.row;
        const sib = p.tasks.filter((x) => x.subtask?.row === row && x.group && x !== t);
        const near = sib.find((x) => t.dependsOn.includes(x.id)) ?? sib.find((x) => x.dependsOn.includes(t.id));
        const counts = new Map<string, number>();
        for (const x of sib) counts.set(x.group!, (counts.get(x.group!) ?? 0) + 1);
        const usual = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
        t.group = near?.group ?? usual ?? this.rowGroup(p, tracked.get(row)!, input.subtasks.find((x) => x.row === row)?.title);
      }

      const lines: string[] = [];
      if (created.length) lines.push(`new: ${created.map((t) => t.id).join(', ')}`);
      if (adopted.length) lines.push(`now from the brief: ${adopted.join(', ')}`);
      for (const { task, item, before } of touched) {
        if (!before || before === snap(task) || created.includes(task) || adopted.includes(task.id)) continue;
        task.updatedAt = now;
        const old = JSON.parse(before)[8]?.status;
        changed.push(old !== undefined && old !== item.status ? `${task.id} ${old || '—'} → ${item.status || '—'}` : `${task.id} updated`);
      }
      src.problems = [...new Set(problems)];
      const all = [...lines, ...changed];
      if (all.length) this.emit(p, actor, 'task.updated', `From the docs: ${truncate(all.join('; '), 300)}`);
      return { created: created.map((t) => t.id), adopted, changed, problems: src.problems };
    });
  }

  /** The tracked row's phase: the one set for it, else one made for it (inside the row card's phase when there is one). */
  private rowGroup(p: Project, entry: { row: string; group?: string }, title?: string): string {
    if (entry.group && p.groups.some((g) => g.id === entry.group)) return entry.group;
    const id = slug(entry.row);
    if (!p.groups.some((g) => g.id === id)) {
      const home = p.tasks.find((t) => t.backlog?.id === entry.row)?.group;
      const parent = home && !p.groups.find((g) => g.id === home)?.parent ? home : null;
      p.groups.push({
        id,
        name: title ? `${entry.row} ${truncate(title, 40)}` : entry.row,
        goal: `${entry.row}'s subtasks, from its brief`,
        parent,
        order: p.groups.filter((g) => g.parent === parent).length + 1,
      });
    }
    entry.group = id;
    return id;
  }

  private renameTask(p: Project, from: string, to: string) {
    const swap = (r: string | null | undefined) => {
      const x = parseRef(r);
      if (!x) return r;
      if (x.type === 'task' && x.id === from) return `task:${to}`;
      if (x.type === 'link' && (x.id === from || x.to === from)) return `link:${x.id === from ? to : x.id}>${x.to === from ? to : x.to}`;
      return r;
    };
    for (const t of p.tasks) {
      if (t.id === from) t.id = to;
      t.dependsOn = t.dependsOn.map((d) => (d === from ? to : d));
    }
    p.pins = p.pins.map((x) => (x === from ? to : x));
    for (const l of p.labels) {
      if (l.from === from) l.from = to;
      if (l.to === from) l.to = to;
    }
    for (const n of p.notes) n.target = swap(n.target)!;
    for (const c of p.comments) c.target = swap(c.target) ?? null;
    for (const e of p.events) e.target = swap(e.target) ?? undefined;
  }

  // ---------- comments ----------

  addComment(
    pid: string,
    input: { target?: string | null; taskId?: string | null; kind?: string; text?: string; replyTo?: string },
    actor: Actor,
  ): Comment {
    const p = this.get(pid);
    const text = String(input.text ?? '').trim();
    if (!text) throw new HttpError(400, 'Comment needs text');
    const kind = (input.kind ?? 'comment') as CommentKind;
    if (!COMMENT_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${COMMENT_KINDS.join(', ')}`);
    if ((kind === 'directive' || kind === 'change') && isAgent(actor))
      throw new HttpError(403, 'Agents post comments or questions; instructions and change requests come from the owner');
    let target: ElementRef | null = input.target ?? (input.taskId ? `task:${input.taskId}` : null);
    let answered: Comment | undefined;
    if (input.replyTo) {
      const parent = p.comments.find((c) => c.id === input.replyTo);
      if (!parent) throw new HttpError(404, `No comment ${input.replyTo}`);
      target = target ?? parent.target;
      // A reply from the other side answers a question.
      if (parent.kind === 'question' && !parent.resolved && isAgent(parent.author) !== isAgent(actor)) answered = parent;
    }
    if (target) this.assertRef(p, target);
    const c: Comment = {
      id: `C-${p.comments.length + 1}`,
      target,
      author: actor,
      kind,
      text,
      replyTo: input.replyTo,
      resolved: false,
      createdAt: new Date().toISOString(),
    };
    p.comments.push(c);
    if (answered) {
      answered.resolved = true;
      answered.resolvedBy = actor;
    }
    const on = target ? ` on ${target}` : '';
    this.emit(p, actor, 'comment.created', `${kind === 'change' ? 'change request' : kind}${on}: ${truncate(text, 90)}`, target ?? undefined);
    return c;
  }

  resolveComment(pid: string, cid: string, actor: Actor): Comment {
    const p = this.get(pid);
    const c = p.comments.find((x) => x.id === cid);
    if (!c) throw new HttpError(404, `No comment ${cid}`);
    if (c.resolved) return c;
    c.resolved = true;
    c.resolvedBy = actor;
    this.emit(p, actor, 'comment.resolved', `${cid} resolved (${c.kind}: ${truncate(c.text, 60)})`, c.target ?? undefined);
    return c;
  }

  // ---------- pins ----------

  setPins(pid: string, pins: unknown, actor: Actor): string[] {
    const p = this.get(pid);
    if (!Array.isArray(pins)) throw new HttpError(400, 'pins must be an array of task ids');
    const ids = new Set(p.tasks.map((t) => t.id));
    const clean = [...new Set(pins.map(String))];
    const missing = clean.filter((x) => !ids.has(x));
    if (missing.length) throw new HttpError(400, `Unknown task(s): ${missing.join(', ')}`);
    if (JSON.stringify(clean) === JSON.stringify(p.pins)) return p.pins;
    p.pins = clean;
    this.emit(p, actor, 'pins.updated', clean.length ? `Priority pins: ${clean.join(' → ')}` : 'Priority pins cleared');
    return p.pins;
  }

  // ---------- reading ----------

  events(pid: string, since = 0): PmEvent[] {
    return this.get(pid).events.filter((e) => e.seq > since);
  }

  /** What an agent should look at: open owner requests (with what they point at) and owner activity since a cursor. */
  inbox(pid: string, since = 0) {
    const p = this.get(pid);
    return {
      cursor: p.seq,
      openFromOwner: p.comments
        .filter((c) => !c.resolved && !isAgent(c.author) && c.kind !== 'comment')
        .map((c) => ({ ...c, about: describeRef(p, c.target) })),
      ownerEvents: p.events.filter((e) => e.seq > since && !isAgent(e.actor)),
      pins: p.pins,
      pendingGates: p.tasks.filter((t) => t.gate?.status === 'pending').map((t) => ({ id: t.id, gate: t.gate!.description })),
      unconfirmedRequirements: p.requirements.filter((r) => r.status === 'draft').map((r) => r.id),
    };
  }

  // ---------- internals ----------

  private task(p: Project, id: string): Task {
    const t = p.tasks.find((x) => x.id === id);
    if (!t) throw new HttpError(404, `No task ${id} in project ${p.id}`);
    return t;
  }

  private checkGroup(p: Project, g: string | null | undefined, where = ''): string | null {
    if (g === undefined || g === null || g === '') return null;
    if (!p.groups.some((x) => x.id === g)) throw new HttpError(400, `Unknown group "${g}"${where}. Create it first: pmv group add --id ${g} --name "..."`);
    return g;
  }

  private checkReqs(p: Project, v: string[] | string | undefined, where = ''): string[] {
    const list = parseList(v);
    const missing = list.filter((r) => !p.requirements.some((x) => x.id === r));
    if (missing.length) throw new HttpError(400, `Unknown requirement(s) ${missing.join(', ')}${where}. Create them first: pmv req add --title "..."`);
    return list;
  }

  private assertRef(p: Project, r: string | null | undefined) {
    const x = parseRef(r);
    if (!x) throw new HttpError(400, `Invalid element reference "${r}". Use task:ID, group:ID, req:ID, note:ID, link:FROM>TO or view:SCOPE`);
    const ok =
      (x.type === 'task' && p.tasks.some((t) => t.id === x.id)) ||
      (x.type === 'group' && p.groups.some((g) => g.id === x.id)) ||
      (x.type === 'req' && p.requirements.some((q) => q.id === x.id)) ||
      (x.type === 'note' && p.notes.some((n) => n.id === x.id)) ||
      (x.type === 'link' && !!x.to) ||
      x.type === 'view';
    if (!ok) throw new HttpError(400, `No element ${r}`);
  }

  private emit(p: Project, actor: Actor, type: PmEvent['type'], summary: string, target?: ElementRef) {
    const e: PmEvent = { seq: ++p.seq, at: new Date().toISOString(), actor, type, summary, target };
    p.events.push(e);
    if (p.events.length > MAX_EVENTS) p.events.splice(0, p.events.length - MAX_EVENTS);
    if (this.buffer) this.buffer.push({ pid: p.id, e });
    else this.notify(p.id, e);
  }

  private notify(pid: string, e: PmEvent) {
    this.scheduleSave(pid);
    for (const l of this.listeners) l(pid, e);
  }

  private scheduleSave(pid: string) {
    clearTimeout(this.saveTimers.get(pid));
    this.saveTimers.set(
      pid,
      setTimeout(() => {
        this.saveTimers.delete(pid);
        this.save(pid);
      }, 150),
    );
  }

  save(pid: string) {
    const p = this.projects.get(pid);
    if (!p) return;
    const file = path.join(this.dir, `${pid}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(p, null, 2));
    renameSync(`${file}.tmp`, file);
  }

  flush() {
    for (const [pid, t] of this.saveTimers) {
      clearTimeout(t);
      this.save(pid);
    }
    this.saveTimers.clear();
  }

  has(pid: string) {
    return this.projects.has(pid);
  }
}

// ---------- helpers ----------

/** Fill in fields added after a project file was written. */
function migrate(raw: any): Project {
  const p = raw as Project;
  p.requirements ??= [];
  p.groups ??= [];
  p.tasks ??= [];
  p.labels ??= [];
  p.notes ??= [];
  p.comments ??= [];
  p.pins ??= [];
  p.events ??= [];
  p.seq ??= 0;
  for (const t of p.tasks) {
    t.group ??= null;
    t.requirements ??= [];
    t.area ??= '';
  }
  for (const c of p.comments as any[]) {
    if (c.target === undefined) c.target = c.taskId ? `task:${c.taskId}` : null;
    delete c.taskId;
  }
  for (const e of p.events as any[]) {
    if (e.target === undefined && e.taskId) e.target = `task:${e.taskId}`;
    delete e.taskId;
  }
  return p;
}

export function isAgent(actor: Actor) {
  return actor.startsWith('agent:');
}

function parseStatus(v: string, where = ''): Status {
  const s = String(v).trim().toLowerCase().replace(/[\s-]+/g, '_') as Status;
  if (!STATUSES.includes(s)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}${where}`);
  return s;
}

function parseSize(v: string, field: string, where = ''): Size {
  const s = String(v).trim().toUpperCase() as Size;
  if (!SIZES.includes(s)) throw new HttpError(400, `${field} must be S, M or L${where}`);
  return s;
}

function parseMeta(v: unknown, where = ''): Meta {
  if (v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, `meta must be an object of short key/values${where}`);
  const out: Meta = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!['string', 'number', 'boolean'].includes(typeof x)) throw new HttpError(400, `meta.${k} must be a string, number or boolean${where}`);
    out[String(k).slice(0, 40)] = typeof x === 'string' ? x.slice(0, 500) : (x as number | boolean);
  }
  return out;
}

function parseTone(v: string | undefined): NoteTone {
  const t = (v ?? 'info') as NoteTone;
  if (!NOTE_TONES.includes(t)) throw new HttpError(400, `tone must be one of ${NOTE_TONES.join(', ')}`);
  return t;
}

function parseList(v: string[] | string | undefined | null): string[] {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : String(v).split(',');
  return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
}

function parseGate(v: TaskInput['gate'], actor: Actor): Gate | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string') return { description: v, status: 'pending' };
  if (!v.description) throw new HttpError(400, 'gate needs a description');
  if (v.status === 'approved' && isAgent(actor)) throw new HttpError(403, 'Only a human owner can approve a gate');
  return { description: v.description, status: v.status === 'approved' ? 'approved' : 'pending' };
}

function nextNumber(tasks: Task[]): number {
  let max = 0;
  for (const t of tasks) {
    const m = t.id.match(/^T-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function nextId(ids: string[], prefix: string, start: number): string {
  let n = start;
  for (const id of ids) {
    const m = id.match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  return `${prefix}${n}`;
}

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'item'
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  if (typeof v === 'string' && v in STATUS_LABEL) return STATUS_LABEL[v as Status];
  return String(v);
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

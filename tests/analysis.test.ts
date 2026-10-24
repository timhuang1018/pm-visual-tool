import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze, cycleIfDepends, findCycles, lineage } from '../shared/analysis';
import { renderPlan } from '../shared/planText';
import { computeNow } from '../shared/now';
import type { Task } from '../shared/types';
import { loadSampleTasks } from '../server/seed';
import { Store } from '../server/store';
import { buildScene } from '../web/src/graph/scene';

const mk = (id: string, deps: string[] = [], extra: Partial<Task> = {}): Task => ({
  id,
  title: id,
  description: '',
  area: '',
  status: 'ready',
  impact: 'M',
  effort: 'M',
  dependsOn: deps,
  gate: null,
  group: null,
  requirements: [],
  assignee: null,
  createdBy: 'human:test',
  createdAt: '',
  updatedAt: '',
  ...extra,
});

const tmpStore = () => new Store(mkdtempSync(path.join(tmpdir(), 'pm-')));

describe('sample project', () => {
  const s = tmpStore();
  s.seedSample();
  const v = s.view('sample');

  it('has the 58 tasks and 75 links from tasks.md', () => {
    expect(loadSampleTasks()).toHaveLength(58);
    expect(v.project.tasks).toHaveLength(58);
    expect(v.project.tasks.reduce((n, t) => n + t.dependsOn.length, 0)).toBe(75);
  });

  it('is structured: every task in a phase, groups readable, a full order', () => {
    expect(v.structure.ungroupedTasks).toEqual([]);
    expect(v.analysis.cycles).toEqual([]);
    expect(v.analysis.order).toHaveLength(58);
    const warns = v.structure.checks.filter((c) => c.level === 'warn').map((c) => c.code);
    expect(warns).toEqual(['TASK_UNLINKED', 'BOARD_LARGE']); // T-07, T-53 are deliberately unlinked; 58 tasks is past a high-level slice
    const pos = new Map(v.analysis.order.map((id, i) => [id, i]));
    for (const t of v.project.tasks) for (const d of t.dependsOn) expect(pos.get(d)!).toBeLessThan(pos.get(t.id)!);
  });

  it('builds the overview and drill-down scenes', () => {
    const overview = buildScene(v.project, v.analysis, 'overview');
    expect(overview.nodes.map((n) => n.id)).toEqual(['g:collect', 'g:extract', 'g:graph', 'g:score', 'g:publish', 'g:operate', 'g:milestone']);
    expect(overview.edges.find((e) => e.id === 'g:collect>g:extract')?.label).toBe('transcripts');
    const inside = buildScene(v.project, v.analysis, { group: 'extract-core' });
    expect(inside.nodes.filter((n) => n.kind === 'task')).toHaveLength(6);
    const ghosts = inside.nodes.filter((n) => n.kind === 'ghost');
    expect(ghosts.some((g) => g.id === 'x:in:collect')).toBe(true); // T-27 waits on T-21
    expect(ghosts.some((g) => g.id === 'x:in:extract-coverage')).toBe(true); // sibling sub-group
    const all = buildScene(v.project, v.analysis, 'all');
    expect(all.nodes).toHaveLength(58);
    expect(all.boxes.length).toBeGreaterThan(7);
  });

  it('renders the plan top-down and computes Now', () => {
    const plan = renderPlan(v);
    expect(plan.indexOf('Owner requests')).toBeLessThan(plan.indexOf('What the owner asked for'));
    expect(plan.indexOf('What the owner asked for')).toBeLessThan(plan.indexOf('## 3. Phases'));
    expect(computeNow(v).next[0].task.id).toBe('T-21');
  });
});

describe('analyze', () => {
  const tasks = [mk('A', [], { effort: 'L' }), mk('B', ['A'], { effort: 'L' }), mk('C', ['A'], { effort: 'S' }), mk('D', ['B', 'C'])];

  it('finds the critical path and slack', () => {
    const a = analyze(tasks);
    expect(a.criticalPath).toEqual(['A', 'B', 'D']);
    expect(a.criticalLength).toBe(10);
    expect(a.insights.C.slack).toBe(3);
    expect(a.insights.A.unlocks).toBe(3);
    expect(a.order).toEqual(['A', 'B', 'C', 'D']);
  });

  it('owner pins pull prerequisites forward', () => {
    const t = [...tasks, mk('E', [], { effort: 'S' }), mk('F', ['E'], { effort: 'S' })];
    const a = analyze(t, ['F']);
    expect(a.order.slice(0, 2)).toEqual(['E', 'F']);
    expect(a.insights.E.pulledBy).toBe('F');
  });

  it('detects cycles and lineage', () => {
    expect(findCycles([mk('X', ['Z']), mk('Y', ['X']), mk('Z', ['Y'])])).toHaveLength(1);
    expect(cycleIfDepends(tasks, 'A', ['D'])).toEqual(['A', 'D', 'B', 'A']);
    const l = lineage(tasks, 'B');
    expect([...l.up]).toEqual(['A']);
    expect([...l.down]).toEqual(['D']);
  });
});

describe('store rules', () => {
  const store = () => {
    const s = tmpStore();
    s.createProject({ id: 'p', name: 'P' }, 'human:o');
    return s;
  };

  it('imports a plan by id, and re-import updates', () => {
    const s = store();
    const plan = {
      requirements: [{ id: 'R-1', title: 'Data in' }],
      groups: [{ id: 'in', name: 'Ingest', goal: 'data lands' }, { id: 'sub', name: 'Sub', parent: 'in' }],
      tasks: [{ id: 'T-1', title: 'a', group: 'sub', requirements: ['R-1'] }, { id: 'T-2', title: 'b', dependsOn: ['T-1'], group: 'in' }],
      labels: [{ from: 'T-1', to: 'T-2', label: 'rows' }],
      notes: [{ target: 'group:in', tone: 'deadline', text: 'Friday' }],
    };
    expect(s.importPlan('p', plan, 'agent:x')).toMatchObject({ requirements: 1, groups: 2, tasksCreated: 2 });
    expect(s.importPlan('p', { tasks: [{ id: 'T-2', title: 'b2' }] }, 'agent:x')).toMatchObject({ tasksUpdated: 1 });
    const v = s.view('p');
    expect(v.project.tasks.find((t) => t.id === 'T-2')!.title).toBe('b2');
    expect(v.structure.groups.in.tasks).toEqual(['T-1', 'T-2']);
  });

  it('rolls back a failed import completely', () => {
    const s = store();
    expect(() => s.importPlan('p', { requirements: [{ id: 'R-1', title: 'x' }], tasks: [{ id: 'T-1', title: 'a', group: 'nope' }] }, 'agent:x')).toThrow(/Unknown group/);
    expect(s.view('p').project.requirements).toHaveLength(0);
  });

  it('owner confirms requirements; agent rewording sends them back to draft', () => {
    const s = store();
    s.upsertRequirements('p', [{ id: 'R-1', title: 'x' }], 'agent:x');
    expect(() => s.updateRequirement('p', 'R-1', { status: 'confirmed' }, 'agent:x')).toThrow();
    s.updateRequirement('p', 'R-1', { status: 'confirmed' }, 'human:o');
    expect(s.updateRequirement('p', 'R-1', { title: 'y' }, 'agent:x').status).toBe('draft');
  });

  it('change requests target any element and reach the agent inbox with context', () => {
    const s = store();
    s.importPlan('p', { groups: [{ id: 'g', name: 'Phase G', goal: 'done' }] }, 'agent:x');
    expect(() => s.addComment('p', { target: 'group:g', kind: 'change', text: 'split it' }, 'agent:x')).toThrow();
    s.addComment('p', { target: 'group:g', kind: 'change', text: 'split it' }, 'human:o');
    const box = s.inbox('p');
    expect(box.openFromOwner[0].about).toContain('Phase G');
    expect(s.view('p').structure.checks.some((c) => c.code === 'CHANGE_REQUESTED')).toBe(true);
    expect(() => s.addComment('p', { target: 'group:nope', text: 'x' }, 'human:o')).toThrow();
  });

  it('a reply from the other side answers a question; change requests stay open until resolved', () => {
    const s = store();
    s.createTasks('p', [{ id: 'A', title: 'a' }], 'agent:x');
    const q = s.addComment('p', { target: 'task:A', kind: 'question', text: 'week or month?' }, 'agent:x');
    s.addComment('p', { replyTo: q.id, text: 'week' }, 'agent:y'); // same side: still open
    expect(s.view('p').project.comments.find((c) => c.id === q.id)!.resolved).toBe(false);
    s.addComment('p', { replyTo: q.id, text: 'week' }, 'human:o');
    expect(s.view('p').project.comments.find((c) => c.id === q.id)!.resolved).toBe(true);
    const ch = s.addComment('p', { target: 'task:A', kind: 'change', text: 'rename' }, 'human:o');
    s.addComment('p', { replyTo: ch.id, text: 'done' }, 'agent:x');
    expect(s.view('p').project.comments.find((c) => c.id === ch.id)!.resolved).toBe(false);
  });

  it('agents cannot pass an owner gate; cycles are rejected', () => {
    const s = store();
    s.createTasks('p', [{ id: 'G', title: 'g', gate: 'owner reads it' }, { id: 'H', title: 'h', dependsOn: 'G' }], 'agent:x');
    expect(() => s.updateTask('p', 'G', { status: 'done' }, 'agent:x')).toThrow(/gate/);
    expect(() => s.updateTask('p', 'G', { dependsOn: ['H'] }, 'agent:x')).toThrow(/cycle/);
    s.approveGate('p', 'G', 'human:o');
    expect(s.updateTask('p', 'G', { status: 'done' }, 'agent:x').status).toBe('done');
  });

  it('deleting a group moves its contents up', () => {
    const s = store();
    s.importPlan('p', { groups: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', parent: 'a' }], tasks: [{ id: 'T', title: 't', group: 'b' }] }, 'agent:x');
    s.deleteGroup('p', 'b', 'human:o');
    expect(s.view('p').project.tasks[0].group).toBe('a');
  });
});

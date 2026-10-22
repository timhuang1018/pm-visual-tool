// Builds the sample project: tasks from doc/tasks.md plus the structure an agent would add
// (doc/sample-structure.json). `npm run seed` (server/seed-cli.ts) recreates data/sample.json.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Size, Status } from '../shared/types';
import type { PlanInput, TaskInput } from './store';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STATUS_MAP: Record<string, Status> = {
  ready: 'ready',
  'in progress': 'in_progress',
  'needs verification': 'needs_verification',
  blocked: 'blocked',
  done: 'done',
};

export function parseTasksMarkdown(md: string): TaskInput[] {
  const tasks: (TaskInput & { id: string })[] = [];
  for (const line of md.split('\n')) {
    if (!/^\|\s*(T-\d+)\s*\|/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const [id, taskCell, area, status, impact, effort, deps, gate] = cells;
    const tm = taskCell.match(/^\*\*(.+?)\*\*:?\s*(.*)$/);
    tasks.push({
      id,
      title: tm ? tm[1] : taskCell,
      description: tm ? tm[2] : '',
      area,
      status: STATUS_MAP[status.toLowerCase()] ?? 'ready',
      impact: impact as Size,
      effort: effort as Size,
      dependsOn: deps === '—' || !deps ? [] : deps.split(',').map((d) => d.trim()),
      gate: gate && gate !== '—' ? gate : null,
    });
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

export function loadSampleTasks(): TaskInput[] {
  return parseTasksMarkdown(readFileSync(path.join(ROOT, 'doc/tasks.md'), 'utf8'));
}

interface SampleStructure {
  requirements: PlanInput['requirements'];
  groups: PlanInput['groups'];
  areaGroups: Record<string, string>;
  taskGroups: Record<string, string[]>;
  phaseRequirements: Record<string, string[]>;
  extraRequirements: Record<string, string[]>;
  unlinked: string[];
  labels: PlanInput['labels'];
  notes: PlanInput['notes'];
}

export function loadSampleProject(): PlanInput {
  const s = JSON.parse(readFileSync(path.join(ROOT, 'doc/sample-structure.json'), 'utf8')) as SampleStructure;
  const parentOf = new Map((s.groups ?? []).map((g) => [g.id!, g.parent ?? null]));
  const top = (g: string) => {
    let cur = g;
    while (parentOf.get(cur)) cur = parentOf.get(cur)!;
    return cur;
  };
  const explicit = new Map<string, string>();
  for (const [g, ids] of Object.entries(s.taskGroups)) for (const id of ids) explicit.set(id, g);

  const tasks = loadSampleTasks().map((t) => {
    const group = explicit.get(t.id!) ?? s.areaGroups[t.area ?? ''] ?? null;
    const reqs = s.unlinked.includes(t.id!) ? [] : [...new Set([...(group ? s.phaseRequirements[top(group)] ?? [] : []), ...(s.extraRequirements[t.id!] ?? [])])];
    return { ...t, group, requirements: reqs };
  });
  return { requirements: s.requirements, groups: s.groups, tasks, labels: s.labels, notes: s.notes };
}

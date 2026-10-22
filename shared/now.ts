// "Now": what must happen next, what is waiting on the owner, and what agents are doing.
// Derived from the work order, so it changes as soon as task statuses change.

import type { Comment, ProjectView, Requirement, Task } from './types';

export interface NowItem {
  task: Task;
  rank: number;
  reasons: string[];
}

export interface Now {
  next: NowItem[];
  blockedCritical: Task[];
  questions: Comment[];
  changes: Comment[];
  gates: Task[];
  unconfirmed: Requirement[];
  working: Task[];
}

export function computeNow(view: ProjectView, opts: { limit?: number; scope?: Set<string> } = {}): Now {
  const { project: p, analysis: a } = view;
  const limit = opts.limit ?? 5;
  const byId = new Map(p.tasks.map((t) => [t.id, t]));
  const inScope = (id: string) => !opts.scope || opts.scope.has(id);
  const order = a.order.filter(inScope);
  const next = order
    .map((id) => byId.get(id)!)
    .filter((t) => t.status !== 'blocked')
    .slice(0, limit)
    .map((t) => ({ task: t, rank: a.insights[t.id].rank!, reasons: a.insights[t.id].reasons }));
  const soon = new Set(order.slice(0, 12));
  return {
    next,
    blockedCritical: p.tasks.filter((t) => inScope(t.id) && t.status === 'blocked' && a.insights[t.id].critical),
    questions: p.comments.filter((c) => !c.resolved && c.author.startsWith('agent:') && c.kind === 'question'),
    changes: p.comments.filter((c) => !c.resolved && c.kind === 'change'),
    gates: p.tasks
      .filter(
        (t) =>
          inScope(t.id) &&
          t.gate?.status === 'pending' &&
          t.status !== 'done' &&
          (soon.has(t.id) || t.status === 'in_progress' || t.status === 'needs_verification'),
      )
      .sort((x, y) => (a.insights[x.id].rank ?? 999) - (a.insights[y.id].rank ?? 999)),
    unconfirmed: p.requirements.filter((r) => r.status === 'draft'),
    working: p.tasks.filter((t) => inScope(t.id) && t.status === 'in_progress' && t.assignee?.startsWith('agent:')),
  };
}

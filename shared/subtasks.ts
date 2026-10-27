// Migration: board-only cards → a brief's Subtasks table, so the PM's documents become their
// source. `pmv subtasks export` prints (or writes) the table; the cards keep their ids, comments
// and gate approvals once the brief lists them.

import { shortTitle, type Subtask } from './backlog';
import { STATUS_LABEL, isSynced, type Project, type Task } from './types';

const LEAD = /^\W*([A-Z]{2,8}-\d+[a-z]?)\b/;

/** Board-only cards, by the backlog row their title starts with ("BL-494 paid trial"; null = none). */
export function guessRows(p: Project, known: (row: string) => boolean): Map<string | null, Task[]> {
  const out = new Map<string | null, Task[]>();
  for (const t of p.tasks) {
    if (isSynced(t)) continue;
    const lead = t.title.match(LEAD)?.[1];
    const row = lead && known(lead) ? lead : null;
    (out.get(row) ?? out.set(row, []).get(row)!).push(t);
  }
  return out;
}

/** Order cards so each comes after the ones it waits on, keeping board order otherwise. */
function workOrder(tasks: Task[]): Task[] {
  const ids = new Set(tasks.map((t) => t.id));
  const done = new Set<string>();
  const out: Task[] = [];
  const visit = (t: Task, stack: Set<string>) => {
    if (done.has(t.id) || stack.has(t.id)) return;
    stack.add(t.id);
    for (const d of t.dependsOn) if (ids.has(d)) visit(tasks.find((x) => x.id === d)!, stack);
    done.add(t.id);
    out.push(t);
  };
  for (const t of tasks) visit(t, new Set());
  return out;
}

/**
 * Subtasks table rows for these cards. Waits-on inside the set stay bare ids; on cards that belong
 * to another row (synced, or going to it: `rowOf`) they become ROW.ID or the row id; on other
 * board-only cards they stay as ids and are reported.
 */
export function exportSubtasks(p: Project, taskIds: string[], row?: string, rowOf: (id: string) => string | undefined = () => undefined): { items: Subtask[]; loose: string[] } {
  const byId = new Map(p.tasks.map((t) => [t.id, t]));
  const set = new Set(taskIds);
  const loose = new Set<string>();
  const items = workOrder(taskIds.map((id) => byId.get(id)).filter((t): t is Task => !!t)).map((t) => {
    const dependsOn = t.dependsOn.map((d) => {
      if (set.has(d)) return d;
      const x = byId.get(d);
      if (x?.subtask) return x.subtask.row === row ? x.subtask.id : `${x.subtask.row}.${x.subtask.id}`;
      if (x?.backlog) return x.backlog.id;
      const other = rowOf(d);
      if (other) return other === row ? d : `${other}.${d}`;
      loose.add(d);
      return d;
    });
    const est = typeof t.meta?.estimate === 'string' ? t.meta.estimate : '';
    return {
      id: t.id,
      title: shortTitle(t.title) || t.id,
      status: STATUS_LABEL[t.status],
      dependsOn,
      estimate: est ? `${t.effort} · ${est}` : t.effort,
      effort: t.effort,
      ...(t.gate ? { gate: t.gate.description } : {}),
    } satisfies Subtask;
  });
  return { items, loose: [...loose] };
}

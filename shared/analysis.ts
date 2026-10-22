// Dependency analysis: critical path, slack, unlock counts and a recommended work order.
// Pure functions so the server, the UI and tests share exactly the same answers.

import type { Analysis, Size, Status, Task, TaskInsight } from './types';

/** Effort in rough points. L is "a lot more than M", not "1.5x". */
export const EFFORT_POINTS: Record<Size, number> = { S: 1, M: 2, L: 4 };
export const IMPACT_SCORE: Record<Size, number> = { S: 1, M: 2, L: 3 };

/** Share of the effort that is still left, by status. */
export const STATUS_REMAINING: Record<Status, number> = {
  ready: 1,
  blocked: 1,
  in_progress: 0.6,
  needs_verification: 0.25,
  done: 0,
};

const EPS = 1e-6;

export function remainingPoints(t: Task): number {
  return EFFORT_POINTS[t.effort] * STATUS_REMAINING[t.status];
}

/** Find dependency cycles (each reported once, as a list of ids). */
export function findCycles(tasks: Task[]): string[][] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 0 | 1 | 2>(); // 0 new, 1 on stack, 2 done
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();

  const visit = (id: string) => {
    state.set(id, 1);
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      const s = state.get(dep) ?? 0;
      if (s === 0) visit(dep);
      else if (s === 1) {
        const cycle = stack.slice(stack.indexOf(dep));
        const key = [...cycle].sort().join(',');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      }
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const t of tasks) if ((state.get(t.id) ?? 0) === 0) visit(t.id);
  return cycles;
}

/**
 * Would adding `deps` to task `id` create a cycle? Returns the cycle path
 * (id -> ... -> id) or null.
 */
export function cycleIfDepends(tasks: Task[], id: string, deps: string[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // A cycle exists if `id` is reachable (following dependsOn) from any of the new deps.
  for (const start of deps) {
    const prev = new Map<string, string | null>([[start, null]]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === id) {
        const path: string[] = [];
        for (let n: string | null = cur; n !== null; n = prev.get(n) ?? null) path.unshift(n);
        return [id, ...path]; // id -> start -> ... -> id
      }
      for (const d of byId.get(cur)?.dependsOn ?? []) {
        if (!prev.has(d)) {
          prev.set(d, cur);
          queue.push(d);
        }
      }
    }
  }
  return null;
}

export function analyze(tasks: Task[], pins: string[] = []): Analysis {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const missingDeps: Analysis['missingDeps'] = [];
  const cycles = findCycles(tasks);

  // Edges we trust: known ids only, back edges of cycles dropped.
  const cyclicEdges = new Set<string>();
  for (const c of cycles) cyclicEdges.add(`${c[c.length - 1]}->${c[0]}`);
  const deps = new Map<string, string[]>();
  for (const t of tasks) {
    const list: string[] = [];
    for (const d of t.dependsOn) {
      if (!byId.has(d)) missingDeps.push({ taskId: t.id, missing: d });
      else if (!cyclicEdges.has(`${t.id}->${d}`) && d !== t.id) list.push(d);
    }
    deps.set(t.id, list);
  }
  const dependents = new Map<string, string[]>(tasks.map((t) => [t.id, []]));
  for (const [id, ds] of deps) for (const d of ds) dependents.get(d)!.push(id);

  // Topological order (Kahn). Anything left over is still cyclic; append it.
  const indeg = new Map(tasks.map((t) => [t.id, deps.get(t.id)!.length]));
  const topo: string[] = [];
  const queue = tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  while (queue.length) {
    const id = queue.shift()!;
    topo.push(id);
    for (const n of dependents.get(id)!) {
      indeg.set(n, indeg.get(n)! - 1);
      if (indeg.get(n) === 0) queue.push(n);
    }
  }
  const inTopo = new Set(topo);
  for (const t of tasks) if (!inTopo.has(t.id)) topo.push(t.id);

  // Forward pass.
  const rem = new Map(tasks.map((t) => [t.id, remainingPoints(t)]));
  const ef = new Map<string, number>();
  const depth = new Map<string, number>();
  for (const id of topo) {
    let start = 0;
    let d = 0;
    for (const p of deps.get(id)!) {
      start = Math.max(start, ef.get(p) ?? 0);
      d = Math.max(d, (depth.get(p) ?? 0) + 1);
    }
    ef.set(id, start + rem.get(id)!);
    depth.set(id, d);
  }
  const criticalLength = Math.max(0, ...ef.values());

  // Backward pass.
  const lf = new Map<string, number>();
  for (const id of [...topo].reverse()) {
    let latest = criticalLength;
    for (const n of dependents.get(id)!) latest = Math.min(latest, (lf.get(n) ?? criticalLength) - rem.get(n)!);
    lf.set(id, latest);
  }

  // Transitive dependents.
  const downstream = new Map<string, Set<string>>();
  for (const id of [...topo].reverse()) {
    const s = new Set<string>();
    for (const n of dependents.get(id)!) {
      s.add(n);
      for (const x of downstream.get(n)!) s.add(x);
    }
    downstream.set(id, s);
  }

  // Critical chain: walk back from the latest-finishing task.
  const criticalPath: string[] = [];
  if (criticalLength > EPS) {
    let cur: string | undefined = topo.reduce((a, b) => ((ef.get(b) ?? 0) > (ef.get(a) ?? 0) ? b : a));
    while (cur) {
      if (rem.get(cur)! > EPS) criticalPath.unshift(cur);
      const target: number = ef.get(cur)! - rem.get(cur)!;
      if (target <= EPS) break;
      cur = deps.get(cur)!.find((p) => Math.abs(ef.get(p)! - target) < EPS);
    }
  }

  // Owner pins pull their unfinished prerequisites forward.
  const pinIndex = new Map<string, number>();
  pins.forEach((id, i) => byId.has(id) && !pinIndex.has(id) && pinIndex.set(id, i));
  const effPin = new Map<string, { idx: number; by: string | null }>();
  for (const id of [...topo].reverse()) {
    let best = { idx: pinIndex.get(id) ?? Infinity, by: pinIndex.has(id) ? id : null };
    for (const n of dependents.get(id)!) {
      const e = effPin.get(n)!;
      if (e.idx < best.idx) best = { idx: e.idx, by: e.by };
    }
    effPin.set(id, best);
  }

  const slackOf = (id: string) => Math.max(0, lf.get(id)! - ef.get(id)!);
  const isCritical = (id: string) => byId.get(id)!.status !== 'done' && slackOf(id) < EPS && criticalLength > EPS;

  // Priority-driven list scheduling over unfinished tasks.
  const priority = (id: string): (number | string)[] => {
    const t = byId.get(id)!;
    return [
      effPin.get(id)!.idx,
      Math.round(slackOf(id) * 100),
      t.gate?.status === 'pending' ? 0 : 1,
      -downstream.get(id)!.size,
      -IMPACT_SCORE[t.impact],
      rem.get(id)!,
      id,
    ];
  };
  const cmp = (a: string, b: string) => {
    const pa = priority(a);
    const pb = priority(b);
    for (let i = 0; i < pa.length; i++) {
      if (pa[i] < pb[i]) return -1;
      if (pa[i] > pb[i]) return 1;
    }
    return 0;
  };
  const open = tasks.filter((t) => t.status !== 'done').map((t) => t.id);
  const openSet = new Set(open);
  const waiting = new Map(open.map((id) => [id, deps.get(id)!.filter((d) => openSet.has(d)).length]));
  const available = open.filter((id) => waiting.get(id) === 0);
  const order: string[] = [];
  while (available.length) {
    available.sort(cmp);
    const id = available.shift()!;
    order.push(id);
    for (const n of dependents.get(id)!) {
      if (!waiting.has(n)) continue;
      waiting.set(n, waiting.get(n)! - 1);
      if (waiting.get(n) === 0) available.push(n);
    }
  }
  for (const id of open) if (!order.includes(id)) order.push(id); // cyclic leftovers
  const rank = new Map(order.map((id, i) => [id, i + 1]));

  const insights: Record<string, TaskInsight> = {};
  for (const t of tasks) {
    const id = t.id;
    const pin = pinIndex.has(id) ? pinIndex.get(id)! + 1 : null;
    const e = effPin.get(id)!;
    const pulledBy = !pin && e.by && t.status !== 'done' ? e.by : null;
    const reasons: string[] = [];
    if (t.status !== 'done') {
      if (pin) reasons.push(`Owner pin #${pin}`);
      if (pulledBy) reasons.push(`Needed by pinned ${pulledBy} (#${e.idx + 1})`);
      if (isCritical(id)) reasons.push('On the critical path');
      if (t.gate?.status === 'pending') reasons.push('Owner gate: check in early');
      if (t.status === 'needs_verification') reasons.push('Built, needs a read-back');
      const u = downstream.get(id)!.size;
      if (u > 0) reasons.push(`Unlocks ${u} task${u === 1 ? '' : 's'}`);
      if (!isCritical(id) && slackOf(id) > EPS) reasons.push(`Slack ${+slackOf(id).toFixed(2)} pts`);
    }
    insights[id] = {
      id,
      remaining: +rem.get(id)!.toFixed(3),
      earliestFinish: +ef.get(id)!.toFixed(3),
      latestFinish: +lf.get(id)!.toFixed(3),
      slack: +slackOf(id).toFixed(3),
      critical: isCritical(id),
      depth: depth.get(id)!,
      unlocks: downstream.get(id)!.size,
      dependents: dependents.get(id)!,
      rank: rank.get(id) ?? null,
      pin,
      pulledBy,
      reasons,
      unblocked: deps.get(id)!.every((d) => byId.get(d)!.status === 'done'),
    };
  }

  return {
    insights,
    order,
    criticalPath,
    criticalLength: +criticalLength.toFixed(3),
    totalRemaining: +[...rem.values()].reduce((a, b) => a + b, 0).toFixed(3),
    cycles,
    missingDeps,
  };
}

/** Ancestors (prerequisites) and descendants (dependents) of a task. */
export function lineage(tasks: Task[], id: string): { up: Set<string>; down: Set<string> } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rev = new Map<string, string[]>();
  for (const t of tasks) for (const d of t.dependsOn) (rev.get(d) ?? rev.set(d, []).get(d)!).push(t.id);
  const walk = (start: string, next: (x: string) => string[]) => {
    const seen = new Set<string>();
    const stack = [...next(start)];
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x) || x === start) continue;
      seen.add(x);
      stack.push(...next(x));
    }
    return seen;
  };
  return {
    up: walk(id, (x) => (byId.get(x)?.dependsOn ?? []).filter((d) => byId.has(d))),
    down: walk(id, (x) => rev.get(x) ?? []),
  };
}

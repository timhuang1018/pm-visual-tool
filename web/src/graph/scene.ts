// Builds what one view of the chart shows. The owner walks top-down:
//   overview   → top-level phases (+ links between them, labelled by the agent)
//   group <id> → that group's sub-groups and/or tasks, with one stub per neighbouring group
//   all        → every task, boxed by phase
// Task dependencies are aggregated onto whatever represents each task in the view.

import { groupChain } from '../../../shared/structure';
import type { Analysis, Group, Project } from '../../../shared/types';

export type Scope = 'overview' | 'all' | 'critical' | { group: string };

export type SceneNode =
  | { kind: 'group'; id: string; gid: string; tasks: string[] }
  | { kind: 'task'; id: string; tid: string; tasks: string[] }
  | { kind: 'ghost'; id: string; gid: string | null; tasks: string[]; side: 'in' | 'out' };

export interface SceneEdge {
  id: string;
  source: string;
  target: string;
  /** Element ref for selecting/commenting: link:<from-id>><to-id> */
  ref: string;
  count: number;
  critical: boolean;
  label: string | null;
  pairs: [string, string][];
  /** Goes against the agent's phase order (drawn, but ignored for layout). */
  backward: boolean;
}

export interface SceneBox {
  id: string;
  gid: string;
  parent: string | null;
  children: string[];
}

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  boxes: SceneBox[];
}

const EPS = 1e-6;
export const NONE = '__none';

export function scopeKey(s: Scope) {
  return typeof s === 'string' ? s : `g:${s.group}`;
}

export function buildScene(p: Project, a: Analysis, scope: Scope): Scene {
  const gById = new Map(p.groups.map((g) => [g.id, g]));
  const chainOf = new Map(p.tasks.map((t) => [t.id, groupChain(p, t.group)])); // leaf → top
  const nodes = new Map<string, SceneNode>();

  let rep: (tid: string) => string | null;

  if (scope === 'critical') {
    // Only the chain that decides the finish date, in order.
    const chain = new Set(a.criticalPath);
    rep = (tid) => (chain.has(tid) ? `t:${tid}` : null);
    for (const id of a.criticalPath) nodes.set(`t:${id}`, { kind: 'task', id: `t:${id}`, tid: id, tasks: [id] });
  } else if (scope === 'all' || !p.groups.length) {
    rep = (tid) => `t:${tid}`;
    for (const t of p.tasks) nodes.set(`t:${t.id}`, { kind: 'task', id: `t:${t.id}`, tid: t.id, tasks: [t.id] });
  } else if (scope === 'overview') {
    rep = (tid) => {
      const c = chainOf.get(tid)!;
      return `g:${c.length ? c[c.length - 1] : NONE}`;
    };
    for (const g of p.groups.filter((g) => !g.parent)) nodes.set(`g:${g.id}`, { kind: 'group', id: `g:${g.id}`, gid: g.id, tasks: [] });
    for (const t of p.tasks) {
      const id = rep(t.id)!;
      if (!nodes.has(id)) nodes.set(id, { kind: 'group', id, gid: NONE, tasks: [] });
      nodes.get(id)!.tasks.push(t.id);
    }
  } else {
    const gid = scope.group;
    const here = new Set(groupChain(p, gid)); // gid and its ancestors
    for (const g of p.groups.filter((g) => g.parent === gid)) nodes.set(`g:${g.id}`, { kind: 'group', id: `g:${g.id}`, gid: g.id, tasks: [] });
    rep = (tid) => {
      const c = chainOf.get(tid)!;
      const i = c.indexOf(gid);
      if (i === 0) return `t:${tid}`; // directly in this group
      if (i > 0) return `g:${c[i - 1]}`; // inside a child group
      // Outside: the top-most group on its chain that is not one of ours.
      for (let k = c.length - 1; k >= 0; k--) if (!here.has(c[k])) return `x:${c[k]}`;
      return `x:${c[0] ?? NONE}`;
    };
    for (const t of p.tasks) {
      const id = rep(t.id)!;
      if (id.startsWith('t:')) nodes.set(id, { kind: 'task', id, tid: t.id, tasks: [t.id] });
      else if (id.startsWith('g:')) nodes.get(id)?.tasks.push(t.id);
    }
  }

  // Aggregate dependencies. Neighbouring groups get an input stub (left) and/or an output stub (right).
  const edges = new Map<string, SceneEdge>();
  const ghostTasks = new Map<string, Set<string>>();
  const underlying = (nodeId: string) => nodeId.replace(/^x:(in|out):/, '').replace(/^[tg]:/, '');
  for (const t of p.tasks) {
    let b = rep(t.id);
    for (const d of t.dependsOn) {
      let aId = rep(d);
      if (!aId || !b || aId === b) continue;
      if (aId.startsWith('x:') && b.startsWith('x:')) continue;
      if (aId.startsWith('x:')) {
        aId = `x:in:${aId.slice(2)}`;
        (ghostTasks.get(aId) ?? ghostTasks.set(aId, new Set()).get(aId)!).add(d);
      }
      let bId = b;
      if (b.startsWith('x:')) {
        bId = `x:out:${b.slice(2)}`;
        (ghostTasks.get(bId) ?? ghostTasks.set(bId, new Set()).get(bId)!).add(t.id);
      }
      const key = `${aId}>${bId}`;
      const from = underlying(aId);
      const to = underlying(bId);
      const e = edges.get(key) ?? {
        id: key,
        source: aId,
        target: bId,
        ref: `link:${from}>${to}`,
        count: 0,
        critical: false,
        label: p.labels.find((l) => l.from === from && l.to === to)?.label ?? null,
        pairs: [],
        backward: false,
      };
      e.count++;
      e.pairs.push([d, t.id]);
      const ia = a.insights[d];
      const ib = a.insights[t.id];
      if (ia?.critical && ib?.critical && Math.abs(ia.earliestFinish - (ib.earliestFinish - ib.remaining)) < EPS) e.critical = true;
      edges.set(key, e);
    }
  }
  for (const [id, tasks] of ghostTasks) {
    const side = id.startsWith('x:in:') ? 'in' : 'out';
    const gid = id.replace(/^x:(in|out):/, '');
    nodes.set(id, { kind: 'ghost', id, gid: gid === NONE ? null : gid, tasks: [...tasks], side });
  }

  // Edges that run against the agent's phase order don't drive the layout.
  const orderOf = (nodeId: string): number | null => {
    if (!nodeId.startsWith('g:')) return null;
    const g = gById.get(nodeId.slice(2));
    return g ? g.order : 999;
  };
  for (const e of edges.values()) {
    const oa = orderOf(e.source);
    const ob = orderOf(e.target);
    if (oa !== null && ob !== null && oa > ob) e.backward = true;
  }

  // Boxes (all-tasks view): one per group, nested.
  const boxes: SceneBox[] = [];
  if (scope === 'all' && p.groups.length) {
    const used = new Set<string>();
    for (const t of p.tasks) for (const g of chainOf.get(t.id)!) used.add(g);
    for (const g of p.groups)
      if (used.has(g.id))
        boxes.push({
          id: `b:${g.id}`,
          gid: g.id,
          parent: g.parent && used.has(g.parent) ? `b:${g.parent}` : null,
          children: p.tasks.filter((t) => t.group === g.id).map((t) => `t:${t.id}`),
        });
  }

  return { nodes: sortNodes([...nodes.values()], gById), edges: [...edges.values()], boxes };
}

function sortNodes(nodes: SceneNode[], gById: Map<string, Group>) {
  const ord = (n: SceneNode) => (n.kind === 'group' ? (gById.get(n.gid)?.order ?? 999) : n.kind === 'ghost' ? (n.side === 'in' ? -1 : 1000) : 500);
  return nodes.sort((x, y) => ord(x) - ord(y) || x.id.localeCompare(y.id, undefined, { numeric: true }));
}

/** Where a task lives: the deepest group (to open), or 'all' when ungrouped. */
export function scopeOfTask(p: Project, tid: string): Scope {
  const t = p.tasks.find((x) => x.id === tid);
  return t?.group ? { group: t.group } : p.groups.length ? 'all' : 'overview';
}

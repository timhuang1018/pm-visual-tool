import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Background, BackgroundVariant, Controls, MarkerType, MiniMap, ReactFlow, useReactFlow, type Edge, type Node } from '@xyflow/react';
import { EFFORT_POINTS, STATUS_REMAINING } from '../../../shared/analysis';
import { computeNow } from '../../../shared/now';
import type { Group, Note, ProjectView, Rollup, Task } from '../../../shared/types';
import { isSynced } from '../../../shared/types';
import { FlowEdge, type FlowEdgeData } from './FlowEdge';
import { GROUP_H, GROUP_W, GHOST_H, GHOST_W, layoutAuto, layoutScene, NODE_H, NODE_W, NOTE_H, zoomLevel, type DirPref } from './layout';
import { BoxNode, GhostNode, GroupNode, NodeActions, TaskNode, type ReqDot, type Role } from './nodes';
import { NONE, scopeKey, type Scene, type SceneNode, type Scope } from './scene';
import { useStore } from '@xyflow/react';

const nodeTypes = { task: TaskNode, phase: GroupNode, ghost: GhostNode, box: BoxNode };
const edgeTypes = { flow: FlowEdge };

export interface CanvasProps {
  view: ProjectView;
  scope: Scope;
  scene: Scene;
  dir: DirPref;
  selected: string | null;
  hovered: string | null;
  /** Requirement id or 'unlinked' to highlight what serves it. */
  trace: string | null;
  flash: Set<string>;
  centerOn: { ref: string; n: number } | null;
  reqDots: (ids: string[]) => ReqDot[];
  onOpenGroup: (gid: string) => void;
  onSelect: (ref: string | null) => void;
  onHover: (ref: string | null) => void;
}

const NONE_GROUP: Group = { id: NONE, name: 'Not in a phase', goal: 'Tasks the agent has not placed in a phase yet', parent: null, order: 99 };

/** scene node id ↔ element ref */
export const refOfNode = (n: SceneNode | undefined): string | null =>
  !n ? null : n.kind === 'task' ? `task:${n.tid}` : n.kind === 'group' ? `group:${n.gid}` : n.gid ? `group:${n.gid}` : null;
const nodeIdOfRef = (ref: string | null) => (!ref ? null : ref.startsWith('task:') ? `t:${ref.slice(5)}` : ref.startsWith('group:') ? `g:${ref.slice(6)}` : null);

export function Canvas(p: CanvasProps) {
  const rf = useReactFlow();
  const level = useStore((s) => zoomLevel(s.transform[2]));
  const aspect = useStore((s) => (s.width && s.height ? Math.round((s.width / s.height) * 5) / 5 : 1.2));
  const heightPx = useStore((s) => Math.round((s.height || 800) / 50) * 50);
  const viewport = useStore((s) => (s.width && s.height ? `${s.width}x${s.height}` : ''));
  const { project, analysis, structure } = p.view;
  const tById = useMemo(() => new Map(project.tasks.map((t) => [t.id, t])), [project.tasks]);
  const gById = useMemo(() => new Map(project.groups.map((g) => [g.id, g])), [project.groups]);
  const sById = useMemo(() => new Map(p.scene.nodes.map((n) => [n.id, n])), [p.scene]);

  const topName = (gid: string | null) => {
    let g = gid ? gById.get(gid) : undefined;
    while (g?.parent) g = gById.get(g.parent);
    return g?.name;
  };
  const notesFor = useCallback((ref: string): Note[] => project.notes.filter((n) => n.target === ref), [project.notes]);

  const sizeOf = useCallback(
    (id: string) => {
      const n = sById.get(id);
      if (!n) return { w: NODE_W, h: NODE_H };
      if (n.kind === 'group') return { w: GROUP_W, h: GROUP_H };
      if (n.kind === 'ghost') return { w: GHOST_W, h: GHOST_H };
      const notes = notesFor(refOfNode(n) ?? '').length ? 1 : 0;
      return { w: NODE_W + (notes ? 8 : 0), h: NODE_H + (notes ? NOTE_H + 8 : 0) };
    },
    [sById, notesFor],
  );

  const layoutKey =
    scopeKey(p.scope) +
    p.dir +
    p.scene.nodes.map((n) => `${n.id}:${notesFor(refOfNode(n) ?? '').length ? 1 : 0}`).join(',') +
    p.scene.edges.filter((e) => !e.backward).map((e) => e.id).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const placed = useMemo(
    () => {
      const overview = p.scope === 'overview' && p.view.project.groups.length > 0;
      if (overview) return layoutScene(p.scene, p.dir === 'TB' ? 'TB' : 'LR', sizeOf, true, aspect);
      if (p.dir === 'auto' && p.scope !== 'all') return layoutAuto(p.scene, sizeOf, aspect, p.scope === 'critical', heightPx);
      const d = p.dir === 'auto' ? 'LR' : p.dir;
      const pl = layoutScene(p.scene, d, sizeOf);
      pl.flow = d;
      return pl;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutKey, aspect, heightPx],
  );

  // ---- highlighting
  const servesActive = useCallback(
    (taskIds: string[]) => {
      if (!p.trace) return true;
      if (p.trace === 'unlinked') return taskIds.some((id) => !tById.get(id)?.requirements.length);
      return taskIds.some((id) => tById.get(id)?.requirements.includes(p.trace!));
    },
    [p.trace, tById],
  );

  const focusNode = nodeIdOfRef(p.selected) ?? nodeIdOfRef(p.hovered);
  const lineage = useMemo(() => {
    if (!focusNode || !sById.has(focusNode)) return null;
    // In group views, only direct neighbours light up (the whole transitive chain is everything).
    const direct = p.scene.nodes.some((n) => n.kind === 'group');
    if (direct) {
      const up = new Set(p.scene.edges.filter((e) => e.target === focusNode).map((e) => e.source));
      const down = new Set(p.scene.edges.filter((e) => e.source === focusNode).map((e) => e.target));
      return { up, down };
    }
    const up = new Set<string>();
    const down = new Set<string>();
    const walk = (start: string, set: Set<string>, forward: boolean) => {
      const stack = [start];
      while (stack.length) {
        const cur = stack.pop()!;
        for (const e of p.scene.edges) {
          const nxt = forward ? (e.source === cur ? e.target : null) : e.target === cur ? e.source : null;
          if (nxt && !set.has(nxt) && nxt !== start) {
            set.add(nxt);
            stack.push(nxt);
          }
        }
      }
    };
    walk(focusNode, up, false);
    walk(focusNode, down, true);
    return { up, down };
  }, [focusNode, sById, p.scene]);

  const roleOf = (id: string): Role =>
    id === nodeIdOfRef(p.selected) ? 'selected' : lineage?.up.has(id) ? 'up' : lineage?.down.has(id) ? 'down' : id === nodeIdOfRef(p.hovered) ? 'hover' : null;

  const openChanges = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of project.comments) if (!c.resolved && c.kind === 'change' && c.target) m.set(c.target, (m.get(c.target) ?? 0) + 1);
    return m;
  }, [project.comments]);
  // Groups that hold something waiting on the owner soon: a gate coming up, or an agent question.
  const waitingTasks = useMemo(() => {
    const now = computeNow(p.view);
    const s = new Set(now.gates.slice(0, 3).map((t) => t.id)); // the gates shown first in Now
    for (const c of now.questions) if (c.target?.startsWith('task:')) s.add(c.target.slice(5));
    return s;
  }, [p.view]);
  const openTalk = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of project.comments)
      if (!c.resolved && (c.kind === 'question' || c.kind === 'directive') && c.target) m.set(c.target, (m.get(c.target) ?? 0) + 1);
    return m;
  }, [project.comments]);

  const dimmedNode = (n: SceneNode) => {
    if (!servesActive(n.tasks)) return true;
    if (focusNode && lineage && roleOf(n.id) === null) return true;
    return false;
  };

  const flow = placed.flow ?? (p.dir === 'TB' ? 'TB' : 'LR');
  const nodes: Node[] = useMemo(() => {
    const out: Node[] = [];
    for (const b of p.scene.boxes) {
      const pos = placed.get(b.id);
      const g = gById.get(b.gid);
      if (!pos || !g) continue;
      const r = structure.groups[b.gid];
      out.push({
        id: b.id,
        type: 'box',
        position: { x: pos.x, y: pos.y },
        width: pos.w,
        height: pos.h,
        zIndex: b.parent ? -1 : -2,
        selectable: false,
        data: { name: g.name, goal: g.goal, depth: b.parent ? 1 : 0, critical: (r?.critical ?? 0) > 0, pct: Math.round((r?.progress ?? 0) * 100), dimmed: Boolean(p.trace && r && !servesActive(r.tasks)) },
      });
    }
    for (const n of p.scene.nodes) {
      const pos = placed.get(n.id);
      if (!pos) continue;
      const role = roleOf(n.id);
      const dimmed = dimmedNode(n);
      const base = { id: n.id, position: { x: pos.x, y: pos.y }, width: pos.w, height: pos.h, zIndex: role ? 3 : 1 };
      if (n.kind === 'task') {
        const t = tById.get(n.tid)!;
        const ref = `task:${t.id}`;
        out.push({
          ...base,
          type: 'task',
          selected: p.selected === ref,
          data: {
            task: t,
            insight: analysis.insights[t.id],
            dir: flow,
            role,
            dimmed,
            openQuestions: openTalk.get(ref) ?? 0,
            changes: openChanges.get(ref) ?? 0,
            flash: p.flash.has(ref),
            notes: notesFor(ref),
            reqs: p.reqDots(t.requirements),
            context: p.scope === 'critical' ? topName(t.group) : undefined,
            proposal: !!project.backlog && !isSynced(t) && t.status !== 'done',
          },
        });
      } else if (n.kind === 'group') {
        const g = gById.get(n.gid) ?? NONE_GROUP;
        const r = structure.groups[n.gid] ?? quickRollup(n.tasks.map((id) => tById.get(id)!), p.view);
        const ref = `group:${g.id}`;
        out.push({
          ...base,
          type: 'phase',
          data: {
            group: g,
            rollup: r,
            order: p.scope === 'overview' ? g.order : 0,
            role,
            dimmed,
            flash: n.tasks.some((id) => p.flash.has(`task:${id}`)) || p.flash.has(ref),
            waiting: n.tasks.some((id) => waitingTasks.has(id)),
            dir: flow,
          },
        });
      } else {
        const g = n.gid ? gById.get(n.gid) : null;
        out.push({ ...base, type: 'ghost', data: { name: g?.name ?? NONE_GROUP.name, side: n.side, tasks: n.tasks, dimmed, dir: flow } });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.scene, placed, analysis, structure, p.selected, p.hovered, lineage, p.trace, p.flash, openChanges, openTalk, waitingTasks, project.notes, flow]);

  const edges: Edge[] = useMemo(() => {
    const dimById = new Map(nodes.map((n) => [n.id, Boolean((n.data as { dimmed?: boolean }).dimmed)]));
    return p.scene.edges.map((e) => {
      const chain =
        focusNode && lineage
          ? (lineage.up.has(e.source) || e.source === focusNode) && (lineage.up.has(e.target) || e.target === focusNode)
            ? 'up'
            : (lineage.down.has(e.target) || e.target === focusNode) && (lineage.down.has(e.source) || e.source === focusNode)
              ? 'down'
              : null
          : null;
      const dim = (dimById.get(e.source) || dimById.get(e.target)) && !chain ? true : Boolean(focusNode && lineage && !chain);
      const aggregate = !e.source.startsWith('t:') || !e.target.startsWith('t:');
      const color = chain === 'up' ? 'var(--up)' : chain === 'down' ? 'var(--down)' : e.critical ? 'var(--crit)' : 'var(--edge)';
      // Labels only where the owner is looking: the hovered/selected chain, critical links, or small views.
      const showLabel = Boolean(chain) || p.selected === e.ref || (e.critical && !dim) || p.scene.edges.length <= 6;
      const data: FlowEdgeData = {
        label: showLabel ? e.label : null,
        count: e.count,
        critical: e.critical,
        chain,
        dim,
        selected: p.selected === e.ref,
        backward: e.backward,
        change: (openChanges.get(e.ref) ?? 0) > 0,
        faint: aggregate && !chain && !e.critical && p.selected !== e.ref && p.scene.edges.length > 6,
        aggregate,
        ref: e.ref,
      };
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'flow',
        data,
        animated: e.critical && !dim && !aggregate,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
        zIndex: chain ? 2 : 0,
      } as Edge;
    });
  }, [p.scene.edges, nodes, focusNode, lineage, p.selected, openChanges]);

  // Fit when the view changes.
  const fitKey = useRef('');
  useEffect(() => {
    // Refit whenever the view or its layout bounds change (not on status-only updates).
    let w = 0;
    let h = 0;
    for (const v of placed.values()) {
      w = Math.max(w, v.x + v.w);
      h = Math.max(h, v.y + v.h);
    }
    if (!viewport) return; // wait until the canvas has a size, or the fit is computed against nothing
    const key = `${scopeKey(p.scope)}:${Math.round(w)}x${Math.round(h)}:${viewport}`;
    if (fitKey.current === key) return;
    fitKey.current = key;
    const t = setTimeout(() => rf.fitView({ padding: 0.1, duration: 300, maxZoom: 1 }), 60);
    return () => clearTimeout(t);
  }, [placed, p.scope, viewport, rf]);


  useEffect(() => {
    if (!p.centerOn) return;
    const pos = placed.get(nodeIdOfRef(p.centerOn.ref) ?? '');
    if (!pos) return;
    const t = setTimeout(() => rf.setCenter(pos.x + pos.w / 2, pos.y + pos.h / 2, { zoom: Math.max(rf.getZoom(), 0.85), duration: 450 }), 380);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.centerOn]);

  const actions = useMemo(() => ({ selectRef: (ref: string) => p.onSelect(ref) }), [p]);

  return (
    <NodeActions.Provider value={actions}>
      <ReactFlow
        className={`zoom-${level} ${p.scene.nodes.some((n) => n.kind === 'group') ? 'scene-groups' : 'scene-tasks'}`}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_, n) => {
          if (n.type === 'box') return p.onOpenGroup(n.id.slice(2));
          const s = sById.get(n.id);
          if (!s) return;
          if (s.kind === 'group') return s.gid !== NONE ? p.onOpenGroup(s.gid) : p.onSelect('view:all');
          if (s.kind === 'ghost') return s.gid ? p.onOpenGroup(s.gid) : undefined;
          p.onSelect(`task:${s.tid}`);
        }}
        onEdgeClick={(_, e) => p.onSelect((e.data as FlowEdgeData).ref)}
        onPaneClick={() => p.onSelect(null)}
        onNodeMouseEnter={(_, n) => p.onHover(refOfNode(sById.get(n.id)))}
        onNodeMouseLeave={() => p.onHover(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.1}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="var(--dots)" />
        <Controls showInteractive={false} position="bottom-right" />
        {p.scene.nodes.length > 14 && (
          <MiniMap position="top-right" style={{ width: 160, height: 104 }} pannable zoomable nodeBorderRadius={6} maskColor="hsl(40 20% 92% / 0.7)" />
        )}
      </ReactFlow>
    </NodeActions.Provider>
  );
}

/** Rollup for the pseudo group of ungrouped tasks. */
function quickRollup(tasks: Task[], view: ProjectView): Rollup {
  const counts = { ready: 0, in_progress: 0, needs_verification: 0, blocked: 0, done: 0 };
  let total = 0;
  let rem = 0;
  for (const t of tasks) {
    counts[t.status]++;
    total += EFFORT_POINTS[t.effort];
    rem += EFFORT_POINTS[t.effort] * STATUS_REMAINING[t.status];
  }
  return {
    tasks: tasks.map((t) => t.id),
    counts,
    progress: total ? 1 - rem / total : 0,
    critical: tasks.filter((t) => view.analysis.insights[t.id]?.critical).length,
    pendingGates: tasks.filter((t) => t.gate?.status === 'pending').length,
    agentsWorking: [],
    next: null,
    openChanges: 0,
    requirements: [...new Set(tasks.flatMap((t) => t.requirements))],
  };
}

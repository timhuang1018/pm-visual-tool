import { createContext, memo, useContext } from 'react';
import { Handle, Position, useStore, type Node, type NodeProps } from '@xyflow/react';
import type { Group, Note, Rollup, Task, TaskInsight } from '../../../shared/types';
import { STATUS_LABEL } from '../../../shared/types';
import { IconBot, IconCheck, IconChevron, IconGate, IconPen, IconPin, IconQuestion } from '../icons';
import { actorKind, actorName } from '../theme';
import { zoomLevel, type Direction } from './layout';

// Cards carry only what helps decide where to look next. Everything else lives in Details.
//   phase / sub-group: name, one-line goal, progress (fill), critical (red border), ≤2 signal icons
//   task:              id, title, status, "Next" for the top of the work order, ≤3 signal icons

export type Role = 'selected' | 'up' | 'down' | 'hover' | null;

export interface ReqDot {
  id: string;
  n: string;
  color: string;
}

/** Callbacks for clickable bits inside nodes (notes). */
export const NodeActions = createContext<{ selectRef: (ref: string) => void }>({ selectRef: () => {} });

const TONE_ICON: Record<Note['tone'], string> = { deadline: '⏱', risk: '⚠', decision: '✓', info: 'ℹ' };
const TONE_RANK: Record<Note['tone'], number> = { risk: 0, deadline: 1, decision: 2, info: 3 };

/** One note (the most important) wraps the card as a band underneath. */
function NoteWrap({ notes, children }: { notes: Note[]; children: React.ReactNode }) {
  const { selectRef } = useContext(NodeActions);
  if (!notes.length) return <>{children}</>;
  const n = [...notes].sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone])[0];
  return (
    <div className={`nwrap tone-${n.tone}`}>
      {children}
      <button
        className={`nband tone-${n.tone}`}
        onClick={(e) => {
          e.stopPropagation();
          selectRef(`note:${n.id}`);
        }}
      >
        <span className="nband-ico">{TONE_ICON[n.tone]}</span>
        <span className="nband-text">{n.text}</span>
        {notes.length > 1 && <span className="nband-more">+{notes.length - 1}</span>}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- task

export type TaskNodeData = {
  task: Task;
  insight: TaskInsight;
  dir: Direction;
  role: Role;
  dimmed: boolean;
  openQuestions: number;
  changes: number;
  flash: boolean;
  notes: Note[];
  reqs: ReqDot[];
  /** Phase name, shown when the view mixes phases (critical path, all tasks). */
  context?: string;
  /** Board-only work on a board that mirrors a backlog: not in the backlog yet. */
  proposal?: boolean;
};
export type TaskNodeType = Node<TaskNodeData, 'task'>;

function TaskNodeView({ data }: NodeProps<TaskNodeType>) {
  const { task: t, insight: ins, dir, role, dimmed, openQuestions, changes, flash, notes, context, proposal } = data;
  const lr = dir === 'LR';
  useStore((s) => zoomLevel(s.transform[2])); // re-render on zoom level change (CSS does the rest)
  const agentWorking = t.assignee && actorKind(t.assignee) === 'agent' && t.status === 'in_progress';
  const next = ins.rank !== null && ins.rank <= 3;
  // A backlog row keeps its own status word (e.g. "Icebox") on the card.
  const status = t.backlog?.status || STATUS_LABEL[t.status];
  const cls = ['tnode', `st-${t.status}`, ins.critical && 'is-critical', role && `role-${role}`, flash && 'is-flash', changes > 0 && 'has-change', proposal && 'is-proposal']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={`nshell ${dimmed ? 'is-dimmed' : ''}`}>
      <Handle type="target" position={lr ? Position.Left : Position.Top} className="thandle" />
      <NoteWrap notes={notes}>
        <div className={cls}>
          <div className="tnode-far">
            <span className="far-id mono">{t.id}</span>
            <span className="far-title">{t.title}</span>
            <span className="far-status">{status}</span>
          </div>
          <div className="tnode-near">
            <div className="tnode-head">
              <b className="tnode-id mono">{t.id}</b>
              {context && <span className="tnode-ctx">{context}</span>}
              <span className="tnode-icons">
                {ins.pin && <IconPin size={12} className="ico-pin" />}
                {t.gate?.status === 'pending' && <IconGate size={13} className="ico-gate" />}
                {openQuestions > 0 && <IconQuestion size={13} className="ico-q" />}
                {changes > 0 && <IconPen size={12} className="ico-change" />}
              </span>
            </div>
            <div className="tnode-title">{t.title}</div>
            <div className="tnode-status">
              {t.status === 'done' ? <IconCheck size={12} /> : <i className={`sdot s-${t.status}`} />}
              {status}
            </div>
          </div>
          {proposal && <span className="proposal-tag">Proposed</span>}
          {next && <span className="next-tag">Next</span>}
          {agentWorking && (
            <div className="tnode-assignee agent working">
              <IconBot size={12} />
              {actorName(t.assignee!)}
            </div>
          )}
        </div>
      </NoteWrap>
      <Handle type="source" position={lr ? Position.Right : Position.Bottom} className="thandle" />
    </div>
  );
}
export const TaskNode = memo(TaskNodeView);

// ---------------------------------------------------------------- group (phase / sub-group)

export type GroupNodeData = {
  group: Group;
  rollup: Rollup;
  order: number;
  role: Role;
  dimmed: boolean;
  flash: boolean;
  /** Something in here is waiting on the owner soon (gate or question). */
  waiting: boolean;
  dir: Direction;
};
export type GroupNodeType = Node<GroupNodeData, 'phase'>;

function GroupNodeView({ data }: NodeProps<GroupNodeType>) {
  const { group: g, rollup: r, order, role, dimmed, flash, waiting, dir } = data;
  const lr = dir === 'LR';
  const total = r.tasks.length;
  const allDone = total > 0 && r.counts.done === total;
  const notStarted = total > 0 && r.counts.done + r.counts.in_progress + r.counts.needs_verification === 0;
  const cls = [
    'gnode',
    r.critical > 0 && 'is-critical',
    allDone && 'is-done',
    notStarted && 'is-idle',
    role && `role-${role}`,
    flash && 'is-flash',
    r.openChanges > 0 && 'has-change',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={`nshell ${dimmed ? 'is-dimmed' : ''}`}>
      <Handle type="target" position={lr ? Position.Left : Position.Top} className="thandle" />
      <div className={cls} style={{ ['--pct' as string]: `${Math.round(r.progress * 100)}%` }}>
        <div className="gnode-fill" />
        <div className="gnode-head">
          {order > 0 && <span className="gnode-order">{order}</span>}
          <span className="gnode-name">{g.name}</span>
          <span className="gnode-icons">
            {r.agentsWorking.length > 0 && <IconBot size={14} className="ico-bot" />}
            {waiting && <IconGate size={14} className="ico-gate" />}
            {r.openChanges > 0 && <IconPen size={13} className="ico-change" />}
          </span>
        </div>
        <div className="gnode-goal">{g.goal}</div>
        <span className="gnode-open">
          Open <IconChevron size={12} />
        </span>
      </div>
      <Handle type="source" position={lr ? Position.Right : Position.Bottom} className="thandle" />
    </div>
  );
}
export const GroupNode = memo(GroupNodeView);

// ---------------------------------------------------------------- ghost (neighbouring group stub)

export type GhostNodeData = { name: string; side: 'in' | 'out'; tasks: string[]; dimmed: boolean; dir: Direction };
export type GhostNodeType = Node<GhostNodeData, 'ghost'>;

function GhostNodeView({ data }: NodeProps<GhostNodeType>) {
  const lr = data.dir === 'LR';
  return (
    <div className={`nshell ${data.dimmed ? 'is-dimmed' : ''}`}>
      <Handle type="target" position={lr ? Position.Left : Position.Top} className="thandle" />
      <div className={`ghost side-${data.side}`}>
        <span className="ghost-dir">{data.side === 'in' ? 'from' : 'to'}</span>
        <b>{data.name}</b>
      </div>
      <Handle type="source" position={lr ? Position.Right : Position.Bottom} className="thandle" />
    </div>
  );
}
export const GhostNode = memo(GhostNodeView);

// ---------------------------------------------------------------- box (group frame in the all-tasks view)

export type BoxNodeData = { name: string; goal: string; depth: number; critical: boolean; pct: number; dimmed: boolean };
export type BoxNodeType = Node<BoxNodeData, 'box'>;

function BoxNodeView({ data }: NodeProps<BoxNodeType>) {
  return (
    <div className={`box depth-${data.depth} ${data.critical ? 'is-critical' : ''} ${data.dimmed ? 'is-dimmed' : ''}`}>
      <div className="box-label">
        <b>{data.name}</b>
        <IconChevron size={12} />
      </div>
    </div>
  );
}
export const BoxNode = memo(BoxNodeView);

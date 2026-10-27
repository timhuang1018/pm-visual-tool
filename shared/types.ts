// Shared domain model used by the server, the web UI and the agent CLI.
//
// Three layers, read top-down by the owner:
//   Requirements – what the owner asked for (rephrased by the agent, confirmed by the owner)
//   Groups       – phases (and at most one level of sub-groups) the agent defines per project
//   Tasks        – the work, linked to a group and to the requirements it serves
// Plus view metadata the agent curates so the chart explains itself:
//   Labels       – text on links (e.g. what data flows from one phase to the next)
//   Notes        – short good-to-know details that wrap an element (deadline, risk, decision)

export const STATUSES = ['ready', 'in_progress', 'needs_verification', 'blocked', 'done'] as const;
export type Status = (typeof STATUSES)[number];

export const SIZES = ['S', 'M', 'L'] as const;
export type Size = (typeof SIZES)[number];

export const COMMENT_KINDS = ['comment', 'question', 'directive', 'change'] as const;
/**
 * comment   – plain note.
 * question  – needs an answer from the other side (owner <-> agent).
 * directive – an owner instruction about the work (e.g. "do this before T-12").
 * change    – an owner request to change the chart or its data (the targeted element).
 */
export type CommentKind = (typeof COMMENT_KINDS)[number];

export const NOTE_TONES = ['info', 'deadline', 'risk', 'decision'] as const;
export type NoteTone = (typeof NOTE_TONES)[number];

/** Actor ids are prefixed with their kind: "human:owner", "agent:claude". */
export type Actor = string;

/**
 * Reference to any element on the board:
 *   task:T-21  group:collect  req:R-1  note:N-3  link:<from>><to> (ids of tasks or groups)  view:<groupId|overview|all>
 */
export type ElementRef = string;

/**
 * Free-form facts for any domain (owner, repo, dataset, URL, cost…). Shown as a key/value list in
 * Details; URLs become links. Keys and values stay short.
 */
export type Meta = Record<string, string | number | boolean>;

export interface Gate {
  /** What the owner must confirm before work goes on. */
  description: string;
  status: 'pending' | 'approved';
  approvedBy?: Actor;
  approvedAt?: string;
}

export interface Requirement {
  id: string;
  /** Short rephrased headline, in the owner's terms. */
  title: string;
  /** What it means concretely, aligned with the real data/sources/outputs. */
  detail: string;
  status: 'draft' | 'confirmed';
  confirmedBy?: Actor;
  order: number;
  meta?: Meta;
  createdBy: Actor;
  createdAt: string;
}

export interface Group {
  id: string;
  name: string;
  /** One line: what is true when this group is done. */
  goal: string;
  /** null = top-level phase. */
  parent: string | null;
  order: number;
  meta?: Meta;
}

export interface FlowLabel {
  /** Task or group id. */
  from: string;
  to: string;
  /** What flows along the link, e.g. "transcripts". */
  label: string;
}

export interface Note {
  id: string;
  target: ElementRef;
  tone: NoteTone;
  text: string;
  createdBy: Actor;
}

/**
 * A task that mirrors a row of the repo's backlog file (e.g. docs/BACKLOG.md). The row is the
 * source of truth for status and sizing; the board adds phases, links and requirements around it.
 */
export interface BacklogLink {
  /** Row id, normally the task id too (e.g. BL-102). */
  id: string;
  /** Status exactly as written in the row ("Icebox", "Needs verification"). */
  status: string;
  /** First link in the row's brief/record cell. */
  brief?: string;
  keyword?: string;
  /** Other row ids the row's text names ("waits on BL-104"). */
  mentions?: string[];
}

/**
 * A task that is one row of a backlog item's `## Subtasks` table, in that item's brief. The table is
 * the source of truth for title, status, sizing, waits-on and gate wording; the board keeps the
 * placement, requirements, comments and the owner's gate approval.
 */
export interface SubtaskLink {
  /** Backlog row whose brief lists it, e.g. BL-381. */
  row: string;
  /** Id in the table, e.g. T1 (the task id too, unless another task already had it). */
  id: string;
  /** Status exactly as written in the table. */
  status: string;
  /** The brief, relative to the repo root. */
  brief: string;
  estimate?: string;
  /** Waits-on entries this board cannot draw (rows or tasks not on it). */
  after?: string[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  area: string;
  status: Status;
  impact: Size;
  effort: Size;
  /** Ids of tasks that must finish (or pass their gate) before this one can finish. */
  dependsOn: string[];
  gate: Gate | null;
  /** Group (phase or sub-group) this task belongs to. */
  group: string | null;
  /** Requirement ids this task serves. */
  requirements: string[];
  /** Who is currently working on it, e.g. "agent:claude". */
  assignee: Actor | null;
  meta?: Meta;
  /** Set when the task mirrors a backlog row; unset = board-only (a proposal when a backlog is linked). */
  backlog?: BacklogLink;
  /** Set when the task is a row of a brief's Subtasks table. */
  subtask?: SubtaskLink;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: string;
  /** Element the comment is about; null = the project as a whole. */
  target: ElementRef | null;
  author: Actor;
  kind: CommentKind;
  text: string;
  replyTo?: string;
  resolved: boolean;
  resolvedBy?: Actor;
  createdAt: string;
}

export interface PmEvent {
  seq: number;
  at: string;
  actor: Actor;
  type:
    | 'project.created'
    | 'task.created'
    | 'task.updated'
    | 'task.deleted'
    | 'gate.approved'
    | 'comment.created'
    | 'comment.resolved'
    | 'pins.updated'
    | 'structure.updated';
  target?: ElementRef;
  summary: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

export interface Project extends ProjectMeta {
  requirements: Requirement[];
  groups: Group[];
  tasks: Task[];
  labels: FlowLabel[];
  notes: Note[];
  comments: Comment[];
  /** Owner priority order: task ids to do first, in order. */
  pins: string[];
  /** The backlog this board mirrors rows from (paths relative to the repo root). */
  backlog?: BacklogSource;
  events: PmEvent[];
  seq: number;
}

export interface BacklogSource {
  files: string[];
  syncedAt: string;
  /** Rows whose brief Subtasks tables this board shows; group = where new subtasks go. */
  subtasks?: { row: string; group?: string }[];
  /** Board-only task id → row: the task becomes that row's subtask once its table lists the id. */
  claims?: Record<string, string>;
  /** What the last sync could not read or apply (shown by the plan check). */
  problems?: string[];
}

/** Mirrors a backlog row or a brief subtask: its status lives in the repo's documents. */
export const isSynced = (t: Pick<Task, 'backlog' | 'subtask'>) => !!(t.backlog || t.subtask);
/** The status word as the documents write it, else the board's label. */
export const statusWord = (t: Pick<Task, 'backlog' | 'subtask' | 'status'>) => t.subtask?.status || t.backlog?.status || STATUS_LABEL[t.status];

export interface TaskInsight {
  id: string;
  /** Remaining effort in points (S=1, M=2, L=4, scaled by status). */
  remaining: number;
  earliestFinish: number;
  latestFinish: number;
  slack: number;
  critical: boolean;
  depth: number;
  unlocks: number;
  dependents: string[];
  /** 1-based position in the work order; null for done tasks. */
  rank: number | null;
  pin: number | null;
  pulledBy: string | null;
  reasons: string[];
  unblocked: boolean;
}

export interface Analysis {
  insights: Record<string, TaskInsight>;
  order: string[];
  criticalPath: string[];
  criticalLength: number;
  totalRemaining: number;
  cycles: string[][];
  missingDeps: { taskId: string; missing: string }[];
}

export interface StatusCounts {
  ready: number;
  in_progress: number;
  needs_verification: number;
  blocked: number;
  done: number;
}

export interface Rollup {
  /** All tasks under this group / serving this requirement. */
  tasks: string[];
  counts: StatusCounts;
  /** 0..1 by effort points. */
  progress: number;
  critical: number;
  pendingGates: number;
  agentsWorking: string[];
  /** Best-ranked open task. */
  next: string | null;
  openChanges: number;
  requirements: string[];
}

export interface GroupLink {
  from: string;
  to: string;
  /** Number of task dependencies aggregated into this link. */
  count: number;
  critical: boolean;
  label: string | null;
}

export interface PlanCheck {
  level: 'error' | 'warn' | 'info';
  code: string;
  message: string;
  /** Suggested CLI command for the agent. */
  fix?: string;
  target?: ElementRef;
}

export interface Structure {
  groups: Record<string, Rollup>;
  requirements: Record<string, Rollup>;
  /** Links between top-level phases (aggregated from task dependencies). */
  phaseLinks: GroupLink[];
  unlinkedTasks: string[];
  ungroupedTasks: string[];
  checks: PlanCheck[];
}

export interface ProjectView {
  project: Project;
  analysis: Analysis;
  structure: Structure;
}

export type WsMessage =
  | { type: 'snapshot'; project: string; view: ProjectView; event?: PmEvent }
  | { type: 'projects'; projects: ProjectMeta[] };

export const STATUS_LABEL: Record<Status, string> = {
  ready: 'Ready',
  in_progress: 'In progress',
  needs_verification: 'Needs verification',
  blocked: 'Blocked',
  done: 'Done',
};

export const KIND_LABEL: Record<CommentKind, string> = {
  comment: 'Note',
  question: 'Question',
  directive: 'Instruction',
  change: 'Change request',
};

// ---------- element refs ----------

export const ref = {
  task: (id: string) => `task:${id}`,
  group: (id: string) => `group:${id}`,
  req: (id: string) => `req:${id}`,
  note: (id: string) => `note:${id}`,
  link: (from: string, to: string) => `link:${from}>${to}`,
  view: (scope: string) => `view:${scope}`,
};

export function parseRef(r: ElementRef | null | undefined): { type: string; id: string; to?: string } | null {
  if (!r) return null;
  const i = r.indexOf(':');
  if (i < 0) return null;
  const type = r.slice(0, i);
  const id = r.slice(i + 1);
  if (type === 'link') {
    const [from, to] = id.split('>');
    return { type, id: from, to };
  }
  return { type, id };
}

// Structure: roll tasks up into groups (phases) and requirements, aggregate phase-to-phase
// links, and check the plan's shape so agents get concrete feedback ("pm check").

import { EFFORT_POINTS, STATUS_REMAINING, lineage } from './analysis';
import type { Analysis, GroupLink, PlanCheck, Project, Rollup, StatusCounts, Structure, Task } from './types';
import { isSynced, parseRef } from './types';

/** boardTasks: the board is a high-level slice; past this, detail belongs in briefs or the backlog. */
export const LIMITS = { phases: 7, itemsPerGroup: 9, depth: 2, boardTasks: 40 };

const EPS = 1e-6;

/** [gid, parent, grandparent, ...] */
export function groupChain(p: Pick<Project, 'groups'>, gid: string | null): string[] {
  const byId = new Map(p.groups.map((g) => [g.id, g]));
  const chain: string[] = [];
  let cur = gid;
  while (cur && byId.has(cur) && !chain.includes(cur)) {
    chain.push(cur);
    cur = byId.get(cur)!.parent;
  }
  return chain;
}

export function topPhaseOf(p: Pick<Project, 'groups'>, gid: string | null): string | null {
  const c = groupChain(p, gid);
  return c.length ? c[c.length - 1] : null;
}

export function childGroups(p: Pick<Project, 'groups'>, parent: string | null) {
  return p.groups.filter((g) => g.parent === parent).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function emptyCounts(): StatusCounts {
  return { ready: 0, in_progress: 0, needs_verification: 0, blocked: 0, done: 0 };
}

function rollup(p: Project, a: Analysis, tasks: Task[], ownRefs: string[]): Rollup {
  const counts = emptyCounts();
  let total = 0;
  let rem = 0;
  let critical = 0;
  let pendingGates = 0;
  const agents = new Set<string>();
  const reqs = new Set<string>();
  let next: string | null = null;
  let nextRank = Infinity;
  for (const t of tasks) {
    counts[t.status]++;
    total += EFFORT_POINTS[t.effort];
    rem += EFFORT_POINTS[t.effort] * STATUS_REMAINING[t.status];
    const ins = a.insights[t.id];
    if (ins?.critical) critical++;
    if (t.gate?.status === 'pending' && t.status !== 'done') pendingGates++;
    if (t.status === 'in_progress' && t.assignee?.startsWith('agent:')) agents.add(t.assignee);
    for (const r of t.requirements) reqs.add(r);
    if (ins?.rank && ins.rank < nextRank) {
      nextRank = ins.rank;
      next = t.id;
    }
  }
  const refs = new Set([...ownRefs, ...tasks.map((t) => `task:${t.id}`)]);
  const openChanges = p.comments.filter((c) => !c.resolved && c.kind === 'change' && c.target && refs.has(c.target)).length;
  return {
    tasks: tasks.map((t) => t.id),
    counts,
    progress: total ? +(1 - rem / total).toFixed(3) : 0,
    critical,
    pendingGates,
    agentsWorking: [...agents],
    next,
    openChanges,
    requirements: [...reqs].sort(),
  };
}

export function buildStructure(p: Project, a: Analysis): Structure {
  const tasksByGroup = new Map<string, Task[]>();
  for (const t of p.tasks) {
    for (const g of groupChain(p, t.group)) (tasksByGroup.get(g) ?? tasksByGroup.set(g, []).get(g)!).push(t);
  }
  const groups: Structure['groups'] = {};
  for (const g of p.groups) groups[g.id] = rollup(p, a, tasksByGroup.get(g.id) ?? [], [`group:${g.id}`]);

  const requirements: Structure['requirements'] = {};
  for (const r of p.requirements)
    requirements[r.id] = rollup(
      p,
      a,
      p.tasks.filter((t) => t.requirements.includes(r.id)),
      [`req:${r.id}`],
    );

  // Aggregate task dependencies into links between top-level phases.
  const top = new Map(p.tasks.map((t) => [t.id, topPhaseOf(p, t.group)]));
  const links = new Map<string, GroupLink>();
  for (const t of p.tasks) {
    const to = top.get(t.id);
    for (const d of t.dependsOn) {
      const from = top.get(d);
      if (!from || !to || from === to) continue;
      const key = `${from}>${to}`;
      const l = links.get(key) ?? { from, to, count: 0, critical: false, label: null };
      l.count++;
      const ia = a.insights[d];
      const ib = a.insights[t.id];
      if (ia?.critical && ib?.critical && Math.abs(ia.earliestFinish - (ib.earliestFinish - ib.remaining)) < EPS) l.critical = true;
      links.set(key, l);
    }
  }
  for (const l of links.values()) l.label = p.labels.find((x) => x.from === l.from && x.to === l.to)?.label ?? null;

  // Mirrored rows and brief subtasks are already justified by their brief; only board-only work must trace to a requirement.
  const unlinkedTasks = p.requirements.length ? p.tasks.filter((t) => !t.requirements.length && !isSynced(t)).map((t) => t.id) : [];
  const ungroupedTasks = p.groups.length ? p.tasks.filter((t) => !t.group).map((t) => t.id) : [];

  const structure: Structure = { groups, requirements, phaseLinks: [...links.values()], unlinkedTasks, ungroupedTasks, checks: [] };
  structure.checks = checkPlan(p, a, structure);
  return structure;
}

const list = (ids: string[], n = 8) => (ids.length > n ? `${ids.slice(0, n).join(', ')} +${ids.length - n} more` : ids.join(', '));

export function checkPlan(p: Project, a: Analysis, s: Structure): PlanCheck[] {
  const out: PlanCheck[] = [];
  const push = (c: PlanCheck) => out.push(c);
  const byId = new Map(p.groups.map((g) => [g.id, g]));

  if (p.tasks.some((t) => !isSynced(t)) && !p.requirements.length)
    push({
      level: 'warn',
      code: 'NO_REQUIREMENTS',
      message: "No requirements recorded. Capture what the owner asked for so they can confirm you understood, and so every task traces back to it.",
      fix: 'pmv req add --title "<owner\'s ask, rephrased>" --detail "<concrete: data, source, output, use case>"',
    });
  if (p.tasks.length > LIMITS.itemsPerGroup && !p.groups.length)
    push({
      level: 'warn',
      code: 'NO_PHASES',
      message: `${p.tasks.length} tasks and no phases. Group them into 3–${LIMITS.phases} phases so the owner can read the plan top-down.`,
      fix: 'pmv group add --id <id> --name "<phase>" --goal "<what is true when done>" --order 1',
    });

  for (const r of p.requirements) {
    if (!s.requirements[r.id]?.tasks.length)
      push({ level: 'warn', code: 'REQ_NO_TASKS', message: `${r.id} "${r.title}" has no tasks serving it.`, fix: `pmv edit <task> --req ${r.id}   or   pmv add --title "..." --req ${r.id}`, target: `req:${r.id}` });
  }
  if (s.ungroupedTasks.length)
    push({ level: 'warn', code: 'TASK_UNGROUPED', message: `Not in any phase: ${list(s.ungroupedTasks)}.`, fix: `pmv edit ${s.ungroupedTasks[0]} --group <group-id>` });
  if (s.unlinkedTasks.length)
    push({
      level: 'warn',
      code: 'TASK_UNLINKED',
      message: `Serve no requirement: ${list(s.unlinkedTasks)}. Link them, or ask the owner whether the work is needed.`,
      fix: `pmv edit ${s.unlinkedTasks[0]} --req R-1,R-2`,
    });

  const phases = p.groups.filter((g) => !g.parent);
  if (phases.length > LIMITS.phases)
    push({ level: 'warn', code: 'TOO_MANY_PHASES', message: `${phases.length} top-level phases; the owner can take in about ${LIMITS.phases}. Merge some, or nest them as sub-groups.`, fix: 'pmv group edit <id> --parent <phase-id>' });

  for (const g of p.groups) {
    const depth = groupChainDepth(p, g.id);
    if (depth > LIMITS.depth)
      push({ level: 'warn', code: 'TOO_DEEP', message: `${g.id} is nested ${depth} levels deep; keep to phase → sub-group.`, fix: `pmv group edit ${g.id} --parent <phase-id>`, target: `group:${g.id}` });
    const kids = p.groups.filter((x) => x.parent === g.id).length + p.tasks.filter((t) => t.group === g.id).length;
    if (kids > LIMITS.itemsPerGroup)
      push({
        level: 'warn',
        code: 'GROUP_TOO_BIG',
        message: `${g.id} "${g.name}" shows ${kids} items at once (limit ${LIMITS.itemsPerGroup}). Split it into sub-groups.`,
        fix: `pmv group add --id <sub-id> --name "..." --goal "..." --parent ${g.id}`,
        target: `group:${g.id}`,
      });
    if (!(s.groups[g.id]?.tasks.length))
      push({ level: 'info', code: 'EMPTY_GROUP', message: `${g.id} "${g.name}" has no tasks.`, target: `group:${g.id}` });
    if (!g.goal.trim())
      push({ level: 'info', code: 'GROUP_NO_GOAL', message: `${g.id} "${g.name}" has no goal line.`, fix: `pmv group edit ${g.id} --goal "<what is true when done>"`, target: `group:${g.id}` });
  }

  for (const l of s.phaseLinks) {
    const A = byId.get(l.from);
    const B = byId.get(l.to);
    if (A && B && A.order > B.order)
      push({
        level: 'info',
        code: 'FLOWS_BACK',
        message: `Work flows back from "${A.name}" to the earlier phase "${B.name}" (${l.count} link${l.count > 1 ? 's' : ''}). Reorder the phases or move those tasks if that reads wrong.`,
        target: `link:${l.from}>${l.to}`,
      });
    if (!l.label)
      push({ level: 'info', code: 'LINK_NO_LABEL', message: `Link ${l.from} → ${l.to} has no label. Say what flows along it.`, fix: `pmv label ${l.from} ${l.to} "<what flows, e.g. transcripts>"`, target: `link:${l.from}>${l.to}` });
  }

  const cp = a.criticalPath;
  if (cp.length >= 3) {
    const early = cp.slice(0, Math.ceil(cp.length / 3));
    const tasks = new Map(p.tasks.map((t) => [t.id, t]));
    if (!early.some((id) => tasks.get(id)?.gate))
      push({
        level: 'warn',
        code: 'NO_EARLY_CHECKIN',
        message: `No owner check-in on the first part of the critical path (${early.join(', ')}). Add a cheap preview or sample gate before expensive work.`,
        fix: `pmv edit ${early[0]} --gate "<what the owner checks>"`,
      });
  }

  // Brief subtasks are bounded by their briefs; the slice limit is about everything else.
  const cards = p.tasks.filter((t) => !t.subtask).length;
  if (cards > LIMITS.boardTasks)
    push({
      level: 'warn',
      code: 'BOARD_LARGE',
      message: `${cards} tasks; this board is meant to stay a high-level slice (about ${LIMITS.boardTasks}). Remove finished or unrelated work (the backlog keeps it), or keep detail as subtasks in briefs.`,
      fix: 'pmv rm <id>',
    });

  if (p.backlog) {
    const claims = p.backlog.claims ?? {};
    const loose = p.tasks.filter((t) => !isSynced(t) && !claims[t.id]).map((t) => t.id);
    if (loose.length)
      push({
        level: 'warn',
        code: 'NOT_SYNCED',
        message: `Not in the backlog or a brief's Subtasks table: ${list(loose)}. Their status only changes by hand. If they are steps of a backlog item, put them in its brief; if they are new work, hand them to the backlog owner.`,
        fix: 'pmv subtasks export   (prints the Subtasks table for their brief)   or   pmv proposals',
      });
    const waiting = Object.entries(claims);
    if (waiting.length)
      push({
        level: 'info',
        code: 'SUBTASKS_PENDING',
        message: `Waiting for their brief's Subtasks table: ${list(waiting.map(([id, row]) => `${id}→${row}`))}. They follow the brief once it lists their ids.`,
        fix: 'pmv subtasks export <row-id> <task-id>...   (prints the table again)',
      });
    for (const x of p.backlog.problems ?? []) push({ level: 'warn', code: 'SYNC_PROBLEM', message: x });
    for (const t of p.tasks)
      if (t.subtask && t.status === 'done' && t.gate?.status === 'pending')
        push({
          level: 'warn',
          code: 'GATE_SKIPPED',
          message: `${t.id} is ${t.subtask.status || 'done'} in ${t.subtask.row}'s brief, but the owner has not approved its gate on the board: "${t.gate.description}".`,
          fix: `pmv ask ${t.id} "<what to check>"   (or reopen it in ${t.subtask.brief})`,
          target: `task:${t.id}`,
        });
  }

  const tasksById = new Map(p.tasks.map((t) => [t.id, t]));
  for (const t of p.tasks) {
    if (t.status !== 'done') continue;
    const open = t.dependsOn.filter((d) => tasksById.get(d) && tasksById.get(d)!.status !== 'done');
    if (open.length)
      push({
        level: 'warn',
        code: 'DONE_WAITS_ON_OPEN',
        message: `${t.id} is done but waits on ${open.join(', ')}. For follow-up work, make it wait on ${t.id} instead; if ${t.id} must reopen, that is a backlog decision.`,
        fix: t.subtask
          ? `fix "Depends on" in the Subtasks table of ${t.subtask.brief}`
          : `pmv edit ${t.id} --deps ${t.dependsOn.filter((d) => !open.includes(d)).join(',') || 'none'} && pmv edit ${open[0]} --deps ${t.id}`,
        target: `task:${t.id}`,
      });
  }
  // Rows that name each other but have no dependency path either way (direct or through others).
  for (const t of p.tasks) {
    const named = (t.backlog?.mentions ?? []).filter((m) => tasksById.has(m));
    if (!named.length) continue;
    const { up, down } = lineage(p.tasks, t.id);
    for (const m of named)
      if (!up.has(m) && !down.has(m))
        push({
          level: 'info',
          code: 'BACKLOG_MENTION',
          message: `${t.id}'s backlog row names ${m}, and both are on the board without a link. If one waits on the other, link them.`,
          fix: `pmv edit ${t.id} --deps ${[...t.dependsOn, m].join(',')}`,
          target: `task:${t.id}`,
        });
  }

  const drafts = p.requirements.filter((r) => r.status === 'draft');
  if (drafts.length)
    push({ level: 'info', code: 'REQ_UNCONFIRMED', message: `Owner has not confirmed ${drafts.map((r) => r.id).join(', ')}. Ask them to check the wording on the board.` });

  for (const c of p.comments)
    if (c.kind === 'change' && !c.resolved) {
      const r = parseRef(c.target);
      push({ level: 'warn', code: 'CHANGE_REQUESTED', message: `[${c.id}] owner asks to change ${c.target ?? 'the project'}: "${c.text}"`, fix: `apply it, then pmv reply ${c.id} "..." --resolve`, target: r ? c.target! : undefined });
    }

  return out;
}

function groupChainDepth(p: Project, gid: string) {
  return groupChain(p, gid).length;
}

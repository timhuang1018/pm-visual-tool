// Compact texts for agents, sized to be read every session without filling the context:
//   renderBrief      – the whole board in ~12 lines: owner requests, what waits on the owner,
//                      the critical path, what's next, proposals, sync state
//   renderProposals  – board-only work as ingest cards for the backlog owner (product-manager)
// `pmv plan` stays the full top-down view for when detail is needed.

import { describeRef } from './describe';
import { computeNow } from './now';
import type { PmEvent, ProjectView, Task } from './types';
import { STATUS_LABEL } from './types';

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const st = (t: Task) => t.backlog?.status || STATUS_LABEL[t.status];

/** The chain, shortened in the middle when long: first 3 … last 2. */
function chain(ids: string[], label: (id: string) => string): string {
  const shown = ids.length > 6 ? [...ids.slice(0, 3).map(label), `… ${ids.length - 5} more …`, ...ids.slice(-2).map(label)] : ids.map(label);
  return shown.join(' → ');
}

export function proposalsOf(view: ProjectView): Task[] {
  return view.project.tasks.filter((t) => !t.backlog && t.status !== 'done');
}

/** What still stands between a proposal and ingest ([] = ready): unconfirmed requirements, open change requests. */
export function proposalWaits(view: ProjectView, t: Task): string[] {
  const { requirements: reqs, comments } = view.project;
  const out: string[] = [];
  if (!t.requirements.length) out.push('serves no requirement');
  const draft = t.requirements.filter((id) => reqs.find((r) => r.id === id)?.status !== 'confirmed');
  if (draft.length) out.push(`owner to confirm ${draft.join(', ')}`);
  const changes = comments.filter((c) => !c.resolved && c.kind === 'change' && c.target === `task:${t.id}`);
  if (changes.length) out.push(`apply ${changes.map((c) => c.id).join(', ')}`);
  return out;
}

/** Short name of an element for one-line texts: `T-01 "title"`, otherwise the full description, cut. */
function refLabel(view: ProjectView, r: string | null): string {
  const t = r?.startsWith('task:') ? view.project.tasks.find((x) => `task:${x.id}` === r) : undefined;
  return t ? `${t.id} "${cut(t.title, 50)}"` : cut(describeRef(view.project, r), 70);
}

export function renderBrief(view: ProjectView, opts: { ownerEvents?: PmEvent[]; next?: number } = {}): string {
  const { project: p, analysis: a, structure: s } = view;
  const byId = new Map(p.tasks.map((t) => [t.id, t]));
  const counts = p.tasks.reduce<Record<string, number>>((m, t) => ((m[t.status] = (m[t.status] ?? 0) + 1), m), {});
  const L: string[] = [];
  const tally = Object.entries(counts)
    .map(([k, n]) => `${n} ${STATUS_LABEL[k as Task['status']].toLowerCase()}`)
    .join(' · ');
  L.push(`# ${p.id}: ${p.tasks.length} tasks (${tally || 'none'}) · critical path ${a.criticalLength} pts`);

  const open = p.comments.filter((c) => !c.resolved && !c.author.startsWith('agent:') && c.kind !== 'comment');
  L.push(`Owner requests:${open.length ? '' : ' none'}`);
  for (const c of open) L.push(`- [${c.id}] ${c.kind.toUpperCase()} on ${refLabel(view, c.target)}: "${cut(c.text, 160)}"`);
  // Requests are listed above while open; activity keeps the rest (confirmations, approvals, replies).
  const ev = (opts.ownerEvents ?? []).filter((e) => !/^(change request|directive|question)\b/.test(e.summary));
  if (ev.length) L.push(`Owner since last check: ${ev.slice(-4).map((e) => cut(e.summary, 60)).join('; ')}${ev.length > 4 ? ` (+${ev.length - 4} more: pmv inbox)` : ''}`);

  const now = computeNow(view, { limit: opts.next ?? 3 });
  const waiting = [
    ...now.unconfirmed.map((r) => `confirm ${r.id}`),
    ...now.gates.map((t) => `gate ${t.id} "${cut(t.gate!.description, 50)}"`),
    ...now.questions.map((c) => `answer ${c.id}`),
  ];
  if (waiting.length) L.push(`Waiting on owner: ${waiting.join(' · ')}`);
  if (p.pins.length) L.push(`Pins: ${p.pins.join(' → ')}`);

  const label = (id: string) => `${id} ${cut(byId.get(id)?.title ?? '', 32)}`;
  L.push(`Critical path: ${a.criticalPath.length ? `${chain(a.criticalPath, label)} (${a.criticalPath.length} tasks)` : 'none'}`);
  L.push(`Next: ${now.next.map((n) => `${n.task.id} ${cut(n.task.title, 40)} [${st(n.task)}]`).join(' · ') || 'nothing open'}`);
  if (now.blockedCritical.length) L.push(`Blocked on the critical path: ${now.blockedCritical.map((t) => t.id).join(', ')}`);

  if (p.backlog) {
    const props = proposalsOf(view);
    const ready = props.filter((t) => !proposalWaits(view, t).length);
    const mirrored = p.tasks.filter((t) => t.backlog).length;
    if (props.length) L.push(`Proposals (not in the backlog yet): ${props.map((t) => t.id).join(', ')}; ${ready.length} ready to ingest (pmv proposals)`);
    L.push(`Backlog: ${mirrored} rows mirrored from ${p.backlog.files.join(' + ')}, synced ${p.backlog.syncedAt.slice(0, 16).replace('T', ' ')} UTC`);
  }
  const warns = s.checks.filter((c) => c.level !== 'info').length;
  L.push(`Plan check: ${warns ? `${warns} warning(s) (pmv check)` : 'clean'} · cursor #${p.seq}`);
  return L.join('\n');
}

export function renderProposals(view: ProjectView, ids?: string[]): string {
  const { project: p, analysis: a } = view;
  const byId = new Map(p.tasks.map((t) => [t.id, t]));
  const all = proposalsOf(view);
  const list = ids?.length ? all.filter((t) => ids.includes(t.id)) : all;
  const where = p.backlog?.files[0] ?? 'the backlog';
  const L: string[] = [`# Proposals on ${p.id} (board-only, not yet in ${where})`];
  if (!list.length) return [...L, '- none'].join('\n');
  const ready = list.filter((t) => !proposalWaits(view, t).length);
  L.push(`Ready to ingest: ${ready.map((t) => t.id).join(', ') || 'none'}`);
  const blocked = list.filter((t) => proposalWaits(view, t).length);
  if (blocked.length) L.push(`Not yet: ${blocked.map((t) => `${t.id} (${proposalWaits(view, t).join('; ')})`).join(', ')}`);

  for (const t of list) {
    const ins = a.insights[t.id];
    const group = p.groups.find((g) => g.id === t.group);
    L.push('', `## ${t.id} ${t.title}`);
    if (t.description) L.push(t.description);
    for (const rid of t.requirements) {
      const r = p.requirements.find((x) => x.id === rid);
      if (r) L.push(`- Serves ${r.id} [${r.status === 'confirmed' ? 'owner confirmed' : 'draft'}]: "${r.title}"${r.detail ? ` — ${r.detail}` : ''}`);
    }
    if (group) L.push(`- Phase: ${group.name}${group.goal ? ` — ${group.goal}` : ''}`);
    if (t.dependsOn.length) L.push(`- After: ${t.dependsOn.map((d) => `${d} ${cut(byId.get(d)?.title ?? '', 40)} [${byId.get(d) ? st(byId.get(d)!) : '?'}]`).join('; ')}`);
    if (ins?.dependents.length) L.push(`- Unlocks: ${ins.dependents.join(', ')}`);
    if (t.gate) L.push(`- Owner check-in: "${t.gate.description}" (${t.gate.status})`);
    L.push(`- Impact ${t.impact} · Effort ${t.effort}${ins?.critical ? ' · on the critical path' : ''}`);
    const notes = p.notes.filter((n) => n.target === `task:${t.id}`);
    if (notes.length) L.push(`- Notes: ${notes.map((n) => `${n.tone}: ${n.text}`).join('; ')}`);
    if (t.meta && Object.keys(t.meta).length) L.push(`- Meta: ${Object.entries(t.meta).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    const thread = p.comments.filter((c) => c.target === `task:${t.id}` && !c.author.startsWith('agent:')).slice(-2);
    for (const c of thread) L.push(`- Owner ${c.kind}: "${cut(c.text, 200)}"`);
  }
  L.push('', 'After ingest: pmv adopt <task-id> <row-id> (links the card to its new row)');
  return L.join('\n');
}

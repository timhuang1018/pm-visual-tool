// Plain-text (Markdown) rendering of a project for AI agents. It reads top-down, the way the
// owner reads the board: requirements → phases → now → owner requests → order → checks.

import { describeRef } from './describe';
import { computeNow } from './now';
import { childGroups } from './structure';
import type { ProjectView, Rollup } from './types';
import { STATUS_LABEL, statusWord } from './types';

const pct = (r?: Rollup) => (r ? `${Math.round(r.progress * 100)}%` : '0%');

export function renderPlan(view: ProjectView, opts: { limit?: number } = {}): string {
  const { project: p, analysis: a, structure: s } = view;
  const byId = new Map(p.tasks.map((t) => [t.id, t]));
  const limit = opts.limit ?? 15;
  const title = (id: string) => byId.get(id)?.title ?? '(unknown)';
  const L: string[] = [];
  const counts = p.tasks.reduce<Record<string, number>>((m, t) => ((m[t.status] = (m[t.status] ?? 0) + 1), m), {});

  L.push(`# Plan: ${p.name} (project \`${p.id}\`)`, '');
  L.push(
    `${p.tasks.length} tasks — ` +
      Object.entries(counts)
        .map(([st, n]) => `${n} ${STATUS_LABEL[st as keyof typeof STATUS_LABEL].toLowerCase()}`)
        .join(', ') +
      `. Remaining ${a.totalRemaining} pts; critical path ${a.criticalLength} pts. Event cursor: ${p.seq}.`,
    '',
  );

  const now = computeNow(view);
  const ownerOpen = p.comments.filter((c) => !c.resolved && !c.author.startsWith('agent:') && c.kind !== 'comment');
  L.push('## 1. Owner requests (act on these first)');
  if (!ownerOpen.length) L.push('- none');
  for (const c of ownerOpen) L.push(`- [${c.id}] ${c.kind.toUpperCase()} about ${describeRef(p, c.target)}: "${c.text}"`);
  if (p.pins.length) L.push(`- Pins (do these and their prerequisites first): ${p.pins.map((id) => `${id} ${title(id)}`).join(' → ')}`);
  L.push('');

  L.push('## 2. What the owner asked for (requirements)');
  if (!p.requirements.length) L.push('- none recorded yet — run `pmv req add` (see AGENTS.md)');
  for (const r of [...p.requirements].sort((x, y) => x.order - y.order)) {
    const ru = s.requirements[r.id];
    L.push(
      `- ${r.id} [${r.status}] ${r.title} — ${pct(ru)} · ${ru?.tasks.length ?? 0} tasks${ru?.critical ? ` · ${ru.critical} critical` : ''}${ru?.next ? ` · next ${ru.next}` : ''}`,
    );
    if (r.detail) L.push(`  ${r.detail}`);
  }
  if (s.unlinkedTasks.length) L.push(`- (serving no requirement: ${s.unlinkedTasks.join(', ')})`);
  L.push('');

  L.push('## 3. Phases');
  if (!p.groups.length) L.push('- none defined yet — run `pmv group add` (see AGENTS.md)');
  const phaseLine = (gid: string, depth: number) => {
    const g = p.groups.find((x) => x.id === gid)!;
    const ru = s.groups[gid];
    const flags = [ru?.critical ? `${ru.critical} critical` : '', ru?.pendingGates ? `${ru.pendingGates} gates` : '', ru?.agentsWorking.length ? `working: ${ru.agentsWorking.join(', ')}` : '']
      .filter(Boolean)
      .join(' · ');
    L.push(
      `${'  '.repeat(depth)}- ${g.id} "${g.name}" — ${g.goal || '(no goal)'} — ${pct(ru)} (${ru?.counts.done ?? 0}/${ru?.tasks.length ?? 0} done)${flags ? ` · ${flags}` : ''}${ru?.requirements.length ? ` · serves ${ru.requirements.join(', ')}` : ''}`,
    );
    for (const c of childGroups(p, gid)) phaseLine(c.id, depth + 1);
  };
  for (const g of childGroups(p, null)) phaseLine(g.id, 0);
  for (const l of s.phaseLinks) L.push(`  link ${l.from} → ${l.to}${l.label ? ` "${l.label}"` : ''} (${l.count})`);
  L.push('');

  L.push('## 4. Now');
  L.push('Must happen next:');
  for (const n of now.next) L.push(`- #${n.rank} ${n.task.id} ${n.task.title} [${statusWord(n.task)}] — ${n.reasons.join('; ')}`);
  if (now.blockedCritical.length) L.push(`Blocked on the critical path: ${now.blockedCritical.map((t) => t.id).join(', ')}`);
  if (now.gates.length || now.unconfirmed.length) {
    L.push('Waiting on the owner:');
    for (const t of now.gates) L.push(`- gate on ${t.id}: ${t.gate!.description}`);
    if (now.unconfirmed.length) L.push(`- confirm requirements ${now.unconfirmed.map((r) => r.id).join(', ')}`);
  }
  L.push('');

  L.push(`## 5. Work order (top ${Math.min(limit, a.order.length)} of ${a.order.length} open)`);
  a.order.slice(0, limit).forEach((id, i) => {
    const t = byId.get(id)!;
    const who = t.assignee ? ` @${t.assignee}` : '';
    L.push(`${i + 1}. ${id} ${t.title} [${statusWord(t)}]${who} (${t.group ?? 'no phase'}) — ${a.insights[id].reasons.join('; ') || 'no constraints'}`);
  });
  L.push('', `Critical path (${a.criticalLength} pts): ${a.criticalPath.join(' → ') || 'none'}`, '');

  const gates = p.tasks.filter((t) => t.gate?.status === 'pending');
  L.push('## 6. Owner gates (you cannot pass these; ask the owner)');
  if (!gates.length) L.push('- none');
  for (const t of gates) L.push(`- ${t.id} ${t.title}: ${t.gate!.description}`);
  L.push('');

  L.push('## 7. Plan check (fix the warnings; see `pmv check`)');
  const shown = s.checks.filter((c) => c.level !== 'info' || c.code === 'REQ_UNCONFIRMED');
  if (!s.checks.length) L.push('- clean');
  for (const c of shown) L.push(`- ${c.level.toUpperCase()} ${c.code}: ${c.message}${c.fix ? `  → ${c.fix}` : ''}`);
  const infos = s.checks.length - shown.length;
  if (infos) L.push(`- (${infos} suggestions — \`pmv check\`)`);
  for (const c of a.cycles) L.push(`- ERROR cycle: ${[...c, c[0]].join(' → ')}`);
  return L.join('\n');
}

// Human/agent readable description of any board element, used in inbox and plan text so an
// agent receiving "change this" knows exactly what "this" currently is.

import { STATUS_LABEL, parseRef, type ElementRef, type Project } from './types';

export function describeRef(p: Project, r: ElementRef | null): string {
  const x = parseRef(r);
  if (!x) return 'the whole project';
  switch (x.type) {
    case 'task': {
      const t = p.tasks.find((t) => t.id === x.id);
      if (!t) return `task ${x.id} (deleted)`;
      return `task ${t.id} "${t.title}" [${STATUS_LABEL[t.status]}; group ${t.group ?? '—'}; serves ${t.requirements.join(', ') || '—'}; waits on ${t.dependsOn.join(', ') || '—'}${t.gate ? `; gate: ${t.gate.description} (${t.gate.status})` : ''}]`;
    }
    case 'group': {
      const g = p.groups.find((g) => g.id === x.id);
      if (!g) return `group ${x.id} (deleted)`;
      return `${g.parent ? 'sub-group' : 'phase'} ${g.id} "${g.name}" [goal: ${g.goal || '—'}; parent ${g.parent ?? '—'}; order ${g.order}]`;
    }
    case 'req': {
      const q = p.requirements.find((q) => q.id === x.id);
      if (!q) return `requirement ${x.id} (deleted)`;
      return `requirement ${q.id} "${q.title}" [${q.status}; detail: ${q.detail || '—'}]`;
    }
    case 'note': {
      const n = p.notes.find((n) => n.id === x.id);
      return n ? `note ${n.id} on ${n.target}: "${n.text}" (${n.tone})` : `note ${x.id} (deleted)`;
    }
    case 'link': {
      const lbl = p.labels.find((l) => l.from === x.id && l.to === x.to)?.label;
      return `link ${x.id} → ${x.to}${lbl ? ` labelled "${lbl}"` : ' (no label)'}`;
    }
    case 'view':
      return x.id === 'overview' ? 'the overview (phase map)' : x.id === 'all' ? 'the all-tasks chart' : `the view inside group ${x.id}`;
    default:
      return String(r);
  }
}

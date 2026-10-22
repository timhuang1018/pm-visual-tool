import { useEffect, useState } from 'react';
import { groupChain } from '../../../shared/structure';
import type { Group, ProjectView, Size, Status, Task } from '../../../shared/types';
import { SIZES, STATUSES, STATUS_LABEL, parseRef } from '../../../shared/types';
import { IconBot, IconCheck, IconChevron, IconGate, IconPin, IconTarget, IconX } from '../icons';
import { actorKind, actorName, STATUS_ORDER, timeAgo } from '../theme';
import type { Api } from '../api';
import type { ReqDot } from '../graph/nodes';
import { Thread } from './Thread';

export interface InspectorProps {
  view: ProjectView;
  /** Selected element, or the current view when nothing is selected. */
  target: string;
  api: Api;
  actor: string;
  reqDots: (ids: string[]) => ReqDot[];
  onSelect: (ref: string | null) => void;
  onReveal: (taskId: string) => void;
  onOpenGroup: (gid: string) => void;
  onHover: (ref: string | null) => void;
  onTrace: (req: string) => void;
  report: (e: unknown) => void;
}

/** Details of whatever is selected, plus a conversation to request changes to it. */
export function Inspector(props: InspectorProps) {
  const { view, target, api, actor, report } = props;
  const x = parseRef(target);
  const comments = view.project.comments.filter((c) => c.target === target);
  const thread = (title?: string) => <Thread target={target} comments={comments} api={api} actor={actor} report={report} title={title} />;
  let body: React.ReactNode = null;
  if (x?.type === 'task') body = <TaskDetails {...props} id={x.id} />;
  else if (x?.type === 'group') body = <GroupDetails {...props} id={x.id} />;
  else if (x?.type === 'req') body = <ReqDetails {...props} id={x.id} />;
  else if (x?.type === 'link') body = <LinkDetails {...props} from={x.id} to={x.to!} />;
  else if (x?.type === 'note') body = <NoteDetails {...props} id={x.id} />;
  else body = <ViewDetails {...props} scope={x?.id ?? 'overview'} />;
  const title =
    x?.type === 'view'
      ? 'Ask for a change to this view (phases, grouping, labels…)'
      : x?.type === 'link'
        ? 'Talk to the agent about this link'
        : undefined;
  return (
    <div className="panel-scroll inspector" key={target}>
      {body}
      {thread(title)}
    </div>
  );
}

// ---------------------------------------------------------------- shared bits

/** Domain facts the agent attached (owner, repo, dataset, URL…). */
function MetaList({ meta }: { meta?: Record<string, string | number | boolean> }) {
  const rows = Object.entries(meta ?? {});
  if (!rows.length) return null;
  return (
    <dl className="meta">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>
            {typeof v === 'string' && /^https?:\/\//.test(v) ? (
              <a href={v} target="_blank" rel="noreferrer">
                {v.replace(/^https?:\/\//, '')}
              </a>
            ) : (
              String(v)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Head({ kind, id, onClose, children }: { kind: string; id?: string; onClose?: () => void; children?: React.ReactNode }) {
  return (
    <div className="ins-head">
      <span className="ins-kind">
        {kind}
        {id && <b className="mono">{id}</b>}
        {children}
      </span>
      {onClose && (
        <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
          <IconX size={14} />
        </button>
      )}
    </div>
  );
}

function Crumbs({ view, gid, onOpenGroup }: { view: ProjectView; gid: string | null; onOpenGroup: (g: string) => void }) {
  const chain = groupChain(view.project, gid).reverse();
  if (!chain.length) return null;
  const byId = new Map(view.project.groups.map((g) => [g.id, g]));
  return (
    <div className="ins-crumbs">
      {chain.map((g, i) => (
        <span key={g}>
          {i > 0 && <IconChevron size={11} />}
          <button className="linklike" onClick={() => onOpenGroup(g)}>
            {byId.get(g)?.name ?? g}
          </button>
        </span>
      ))}
    </div>
  );
}

function ReqChips({ ids, reqDots, onTrace }: { ids: string[]; reqDots: (ids: string[]) => ReqDot[]; onTrace: (r: string) => void }) {
  const dots = reqDots(ids);
  if (!dots.length) return <span className="muted small">no requirement</span>;
  return (
    <span className="req-chips">
      {dots.map((d) => (
        <button key={d.id} className="req-chip" style={{ ['--rc' as string]: d.color }} onClick={() => onTrace(d.id)}>
          <i>{d.n}</i>
          {d.id}
        </button>
      ))}
    </span>
  );
}

function StatusBar({ counts, total }: { counts: Record<Status, number>; total: number }) {
  return (
    <div className="ins-sbar">
      <div className="sbar big">
        {STATUS_ORDER.map((s) => (counts[s] ? <i key={s} className={`s-${s}`} style={{ flexGrow: counts[s] }} /> : null))}
      </div>
      <div className="sbar-legend">
        {STATUS_ORDER.map((s) =>
          counts[s] ? (
            <span key={s}>
              <i className={`sdot s-${s}`} /> {counts[s]} {STATUS_LABEL[s].toLowerCase()}
            </span>
          ) : null,
        )}
        <span className="muted">of {total}</span>
      </div>
    </div>
  );
}

function TaskList({ ids, view, onReveal, onHover }: { ids: string[]; view: ProjectView; onReveal: (id: string) => void; onHover: (r: string | null) => void }) {
  const byId = new Map(view.project.tasks.map((t) => [t.id, t]));
  const sorted = [...ids].sort((a, b) => (view.analysis.insights[a]?.rank ?? 9999) - (view.analysis.insights[b]?.rank ?? 9999));
  return (
    <div className="dep-chips">
      {sorted.map((id) => {
        const t = byId.get(id);
        if (!t) return null;
        return (
          <button
            key={id}
            className={`dep-chip ${view.analysis.insights[id]?.critical ? 'crit' : ''}`}
            onClick={() => onReveal(id)}
            onMouseEnter={() => onHover(`task:${id}`)}
            onMouseLeave={() => onHover(null)}
          >
            <i className={`sdot s-${t.status}`} />
            <b className="mono">{id}</b>
            <span>{t.title}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- task

function TaskDetails({ view, id, api, actor, reqDots, onSelect, onReveal, onOpenGroup, onHover, onTrace, report }: InspectorProps & { id: string }) {
  const { project: p, analysis: a } = view;
  const t = p.tasks.find((x) => x.id === id);
  const [editDeps, setEditDeps] = useState(false);
  const [deps, setDeps] = useState('');
  useEffect(() => {
    setEditDeps(false);
    setDeps(t?.dependsOn.join(', ') ?? '');
  }, [id, t?.dependsOn]);
  if (!t) return <p className="empty">Task {id} was removed.</p>;
  const ins = a.insights[t.id];
  const pinned = p.pins.includes(t.id);
  const isHuman = actorKind(actor) === 'human';
  const patch = (body: Record<string, unknown>) => api.updateTask(t.id, body).catch(report);
  const notes = p.notes.filter((n) => n.target === `task:${t.id}`);

  return (
    <>
      <Head kind="Task" id={t.id} onClose={() => onSelect(null)}>
        {ins.critical && <span className="crit-chip">Critical</span>}
      </Head>
      <Crumbs view={view} gid={t.group} onOpenGroup={onOpenGroup} />
      <h2 className="ins-title">{t.title}</h2>
      {t.description && <p className="ins-desc">{t.description}</p>}
      {notes.map((n) => (
        <button key={n.id} className={`ins-note tone-${n.tone}`} onClick={() => onSelect(`note:${n.id}`)}>
          {n.text}
        </button>
      ))}

      <div className="ins-row">
        <span className="label">Serves</span>
        <ReqChips ids={t.requirements} reqDots={reqDots} onTrace={onTrace} />
      </div>
      <MetaList meta={t.meta} />

      <div className="tp-actions">
        <button className={`btn ${pinned ? 'btn-on' : 'btn-primary'}`} onClick={() => api.setPins(pinned ? p.pins.filter((x) => x !== t.id) : [...p.pins, t.id]).catch(report)}>
          <IconPin size={13} />
          {pinned ? `Pinned #${ins.pin}` : 'Do first'}
        </button>
        {t.gate?.status === 'pending' && isHuman && (
          <button className="btn btn-good" onClick={() => api.approveGate(t.id).catch(report)}>
            <IconCheck size={13} /> Approve gate
          </button>
        )}
      </div>

      <div className="tp-grid">
        <label className="field">
          <span className="label">Status</span>
          <select className="input" value={t.status} onChange={(e) => patch({ status: e.target.value as Status })}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Who</span>
          <span className="assignee">
            {t.assignee ? (
              <>
                {actorKind(t.assignee) === 'agent' && <IconBot size={13} />}
                {actorName(t.assignee)}
              </>
            ) : (
              <span className="muted">nobody</span>
            )}
          </span>
        </label>
        <label className="field">
          <span className="label">Impact</span>
          <SizeSeg value={t.impact} onChange={(v) => patch({ impact: v })} />
        </label>
        <label className="field">
          <span className="label">Effort</span>
          <SizeSeg value={t.effort} onChange={(v) => patch({ effort: v })} />
        </label>
      </div>

      <div className="metrics">
        <Metric label="Order" value={ins.rank ? `#${ins.rank}` : '—'} />
        <Metric label="Slack" value={ins.critical ? '0' : `${ins.slack}`} tone={ins.critical ? 'crit' : undefined} />
        <Metric label="Unlocks" value={`${ins.unlocks}`} />
        <Metric label="Left" value={`${ins.remaining}`} />
      </div>
      {ins.reasons.length > 0 && <p className="ins-why">{ins.reasons.join(' · ')}</p>}

      {t.gate && (
        <div className={`gate-box ${t.gate.status}`}>
          <span className="gate-head">
            {t.gate.status === 'pending' ? <IconGate size={14} /> : <IconCheck size={14} />}
            {t.gate.status === 'pending' ? 'Waiting for your go' : `Approved by ${actorName(t.gate.approvedBy ?? '')}`}
          </span>
          <p>{t.gate.description}</p>
        </div>
      )}

      <div className="deps">
        <div className="deps-head">
          <span className="label">Waits on ({t.dependsOn.length})</span>
          {!editDeps && isHuman && (
            <button className="linklike small" onClick={() => setEditDeps(true)}>
              Edit
            </button>
          )}
        </div>
        {editDeps ? (
          <form
            className="deps-edit"
            onSubmit={(e) => {
              e.preventDefault();
              api.updateTask(t.id, { dependsOn: deps }).then(() => setEditDeps(false)).catch(report);
            }}
          >
            <input className="input mono" autoFocus value={deps} onChange={(e) => setDeps(e.target.value)} list="task-ids" />
            <button className="btn btn-sm btn-primary">Save</button>
            <button type="button" className="btn btn-sm" onClick={() => setEditDeps(false)}>
              Cancel
            </button>
          </form>
        ) : t.dependsOn.length ? (
          <TaskList ids={t.dependsOn} view={view} onReveal={onReveal} onHover={onHover} />
        ) : (
          <p className="empty small">Nothing — can start any time</p>
        )}
        <span className="label">Needed by ({ins.dependents.length})</span>
        {ins.dependents.length ? <TaskList ids={ins.dependents} view={view} onReveal={onReveal} onHover={onHover} /> : <p className="empty small">Nothing waits on this</p>}
      </div>
      <p className="ins-foot muted small">
        Created by {t.createdBy} · updated {timeAgo(t.updatedAt)}
      </p>
    </>
  );
}

// ---------------------------------------------------------------- group

function GroupDetails({ view, id, reqDots, onSelect, onReveal, onOpenGroup, onHover, onTrace }: InspectorProps & { id: string }) {
  const { project: p, structure: s } = view;
  const g = p.groups.find((x) => x.id === id);
  if (!g) return <p className="empty">Group {id} was removed.</p>;
  const r = s.groups[id];
  const kids = p.groups.filter((x) => x.parent === id).sort((a, b) => a.order - b.order);
  const direct = p.tasks.filter((t) => t.group === id).map((t) => t.id);
  const notes = p.notes.filter((n) => n.target === `group:${id}`);
  return (
    <>
      <Head kind={g.parent ? 'Sub-group' : 'Phase'} />
      <Crumbs view={view} gid={g.parent} onOpenGroup={onOpenGroup} />
      <h2 className="ins-title">{g.name}</h2>
      <p className="ins-goal">
        <span className="label">Done when</span>
        {g.goal || <span className="muted">no goal line yet</span>}
      </p>
      {notes.map((n) => (
        <button key={n.id} className={`ins-note tone-${n.tone}`} onClick={() => onSelect(`note:${n.id}`)}>
          {n.text}
        </button>
      ))}
      <div className="ins-progress">
        <b>{Math.round((r?.progress ?? 0) * 100)}%</b>
        <StatusBar counts={r.counts} total={r.tasks.length} />
      </div>
      <div className="ins-row">
        <span className="label">Serves</span>
        <ReqChips ids={r.requirements} reqDots={reqDots} onTrace={onTrace} />
      </div>
      <MetaList meta={g.meta} />
      {kids.length > 0 && (
        <div className="ins-block">
          <span className="label">Sub-groups</span>
          {kids.map((k) => (
            <button key={k.id} className="dep-chip" onClick={() => onOpenGroup(k.id)}>
              <b>{k.name}</b>
              <span className="muted">{Math.round((s.groups[k.id]?.progress ?? 0) * 100)}%</span>
              <IconChevron size={12} />
            </button>
          ))}
        </div>
      )}
      {direct.length > 0 && (
        <div className="ins-block">
          <span className="label">Tasks, in work order</span>
          <TaskList ids={direct} view={view} onReveal={onReveal} onHover={onHover} />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- requirement

function ReqDetails({ view, id, api, actor, reqDots, onSelect, onReveal, onHover, report }: InspectorProps & { id: string }) {
  const { project: p, structure: s } = view;
  const q = p.requirements.find((x) => x.id === id);
  if (!q) return <p className="empty">Requirement {id} was removed.</p>;
  const r = s.requirements[id];
  const dot = reqDots([id])[0];
  const byPhase = new Map<string, string[]>();
  const gName = new Map(p.groups.map((g) => [g.id, g.name]));
  for (const tid of r.tasks) {
    const t = p.tasks.find((x) => x.id === tid)!;
    const top = groupChain(p, t.group).pop() ?? '—';
    (byPhase.get(top) ?? byPhase.set(top, []).get(top)!).push(tid);
  }
  return (
    <>
      <Head kind="Requirement" onClose={() => onSelect(null)}>
        {dot && (
          <span className="req-chip" style={{ ['--rc' as string]: dot.color }}>
            <i>{dot.n}</i>
            {id}
          </span>
        )}
      </Head>
      <h2 className="ins-title">{q.title}</h2>
      <p className="ins-desc">{q.detail}</p>
      <MetaList meta={q.meta} />
      {q.status === 'draft' ? (
        <div className="gate-box pending">
          <span className="gate-head">The agent's reading of what you asked for</span>
          <p>If this isn't what you meant, request a change below.</p>
          {actorKind(actor) === 'human' && (
            <button className="btn btn-good btn-sm" onClick={() => api.confirmRequirement(id).catch(report)}>
              <IconCheck size={13} /> That's right
            </button>
          )}
        </div>
      ) : (
        <p className="ins-ok">
          <IconCheck size={13} /> Confirmed by {actorName(q.confirmedBy ?? 'owner')}
        </p>
      )}
      <div className="ins-progress">
        <b>{Math.round((r?.progress ?? 0) * 100)}%</b>
        <StatusBar counts={r.counts} total={r.tasks.length} />
      </div>
      {[...byPhase.entries()].map(([g, ids]) => (
        <div className="ins-block" key={g}>
          <span className="label">{gName.get(g) ?? 'Not in a phase'}</span>
          <TaskList ids={ids} view={view} onReveal={onReveal} onHover={onHover} />
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- link

function LinkDetails({ view, from, to, onSelect, onReveal, onOpenGroup, onHover }: InspectorProps & { from: string; to: string }) {
  const { project: p } = view;
  const name = (id: string) => p.groups.find((g) => g.id === id)?.name ?? p.tasks.find((t) => t.id === id)?.title ?? id;
  const isGroup = (id: string) => p.groups.some((g) => g.id === id);
  const label = p.labels.find((l) => l.from === from && l.to === to)?.label;
  // Which task dependencies make up this link.
  const under = (id: string, tid: string) => (isGroup(id) ? groupChain(p, p.tasks.find((t) => t.id === tid)?.group ?? null).includes(id) : tid === id);
  const pairs: [string, string][] = [];
  for (const t of p.tasks) for (const d of t.dependsOn) if (under(to, t.id) && under(from, d)) pairs.push([d, t.id]);
  const end = (id: string) =>
    isGroup(id) ? (
      <button className="linklike" onClick={() => onOpenGroup(id)}>
        {name(id)}
      </button>
    ) : (
      <button className="linklike" onClick={() => onReveal(id)}>
        <b className="mono">{id}</b> {name(id)}
      </button>
    );
  return (
    <>
      <Head kind="Link" onClose={() => onSelect(null)} />
      <h2 className="ins-title link-title">
        {end(from)} <span className="muted">→</span> {end(to)}
      </h2>
      <p className="ins-desc">{label ? <>Carries: <b>{label}</b></> : <span className="muted">The agent hasn't said what flows along this link.</span>}</p>
      <div className="ins-block">
        <span className="label">Made of {pairs.length} task dependenc{pairs.length === 1 ? 'y' : 'ies'}</span>
        {pairs.map(([a, b]) => (
          <div key={a + b} className="pair" onMouseEnter={() => onHover(`task:${b}`)} onMouseLeave={() => onHover(null)}>
            <button className="linklike mono" onClick={() => onReveal(a)}>
              {a}
            </button>
            <span className="muted">must finish before</span>
            <button className="linklike mono" onClick={() => onReveal(b)}>
              {b}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- note

function NoteDetails({ view, id, onSelect }: InspectorProps & { id: string }) {
  const n = view.project.notes.find((x) => x.id === id);
  if (!n) return <p className="empty">Note {id} was removed.</p>;
  return (
    <>
      <Head kind="Note" id={id} onClose={() => onSelect(null)} />
      <div className={`ins-note big tone-${n.tone}`}>{n.text}</div>
      <p className="muted small">
        {n.tone} note on{' '}
        <button className="linklike" onClick={() => onSelect(n.target)}>
          {n.target}
        </button>{' '}
        by {actorName(n.createdBy)}
      </p>
    </>
  );
}

// ---------------------------------------------------------------- view

function ViewDetails(props: InspectorProps & { scope: string }) {
  const { view, scope } = props;
  const { project: p, structure: s } = view;
  const g: Group | undefined = p.groups.find((x) => x.id === scope);
  if (g) return <GroupDetails {...props} id={g.id} />;
  const warns = s.checks.filter((c) => c.level !== 'info' && c.code !== 'CHANGE_REQUESTED');
  return (
    <>
      <Head kind={scope === 'all' ? 'All tasks' : 'Overview'} />
      <h2 className="ins-title">{p.name}</h2>
      {p.description && <p className="ins-desc">{p.description}</p>}
      <div className="ins-block">
        <span className="label">How the agent has structured this plan</span>
        <p className="small muted">
          {p.requirements.length} requirements · {p.groups.filter((x) => !x.parent).length} phases · {p.groups.filter((x) => x.parent).length} sub-groups · {p.tasks.length} tasks
        </p>
        {warns.length === 0 ? (
          <p className="ins-ok">
            <IconCheck size={13} /> No structure warnings
          </p>
        ) : (
          <ul className="checks">
            {warns.map((c, i) => (
              <li key={i} className={`chk ${c.level}`}>
                {c.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="small muted">
        <IconTarget size={12} /> Click any phase, task, link, note or requirement to talk about that element. Messages here apply to the
        whole view.
      </p>
    </>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'crit' }) {
  return (
    <div className={`metric ${tone ?? ''}`}>
      <span className="metric-v">{value}</span>
      <span className="metric-l">{label}</span>
    </div>
  );
}

function SizeSeg({ value, onChange }: { value: Size; onChange: (s: Size) => void }) {
  return (
    <span className="seg seg-size">
      {SIZES.map((s) => (
        <button key={s} type="button" className={value === s ? 'on' : ''} onClick={() => value !== s && onChange(s)}>
          {s}
        </button>
      ))}
    </span>
  );
}

export type { Task };

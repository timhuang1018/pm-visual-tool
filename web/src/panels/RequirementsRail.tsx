import type { ProjectView } from '../../../shared/types';
import { IconCheck, IconPen } from '../icons';

interface Props {
  view: ProjectView;
  trace: string | null;
  selected: string | null;
  colorOf: (id: string) => string;
  onTrace: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onConfirm: (id: string) => void;
  canConfirm: boolean;
}

/**
 * "What you asked for": the owner's requirements as the agent understood them. Solid card =
 * confirmed by the owner; dashed = the agent's reading, waiting for the owner. Click to trace
 * everything that serves it across the chart.
 */
export function RequirementsRail({ view, trace, selected, colorOf, onTrace, onHover, onConfirm, canConfirm }: Props) {
  const { project: p, structure: s } = view;
  const reqs = [...p.requirements].sort((a, b) => a.order - b.order);

  return (
    <aside className="rail" aria-label="Your requirements">
      <div className="rail-head">
        <h2>What you asked for</h2>
        <span className="muted small">{reqs.length ? 'click one to trace it' : ''}</span>
      </div>
      {reqs.length === 0 && (
        <p className="empty small">
          No requirements yet. Your agent records them from your message (<code>pm req add</code>) so you can check it understood
          you.
        </p>
      )}
      <ol className="reqs">
        {reqs.map((r, i) => {
          const ru = s.requirements[r.id];
          const pct = Math.round((ru?.progress ?? 0) * 100);
          const on = trace === r.id;
          return (
            <li
              key={r.id}
              className={`req ${r.status} ${on ? 'on' : ''} ${trace && !on ? 'off' : ''} ${selected === `req:${r.id}` ? 'sel' : ''}`}
              style={{ ['--rc' as string]: colorOf(r.id) }}
              onMouseEnter={() => onHover(r.id)}
              onMouseLeave={() => onHover(null)}
            >
              <button className="req-main linklike" onClick={() => onTrace(on ? null : r.id)}>
                <span className="req-top">
                  <i className="req-dot">{i + 1}</i>
                  <span className="req-title">{r.title}</span>
                  {(ru?.openChanges ?? 0) > 0 && <IconPen size={12} className="ico-change req-pen" />}
                </span>
                {on && <span className="req-detail">{r.detail}</span>}
                <span className="req-progress">
                  <span className="req-bar">
                    <i style={{ width: `${pct}%` }} />
                  </span>
                  <b>{pct}%</b>
                </span>
              </button>
              {r.status === 'draft' && canConfirm && (
                <button className="req-ok" title="The agent's reading of what you asked for. Confirm if it's right." onClick={() => onConfirm(r.id)}>
                  <IconCheck size={11} /> OK
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {s.unlinkedTasks.length > 0 && (
        <button className={`unlinked ${trace === 'unlinked' ? 'on' : ''}`} onClick={() => onTrace(trace === 'unlinked' ? null : 'unlinked')}>
          <b>{s.unlinkedTasks.length}</b> task{s.unlinkedTasks.length > 1 ? 's' : ''} serve none of these
        </button>
      )}
    </aside>
  );
}

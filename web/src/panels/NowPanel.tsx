import { useState } from 'react';
import { computeNow } from '../../../shared/now';
import type { ProjectView, Task } from '../../../shared/types';
import { STATUS_LABEL } from '../../../shared/types';
import { IconBot, IconCheck, IconCopy, IconGate, IconGrip, IconPen, IconPin, IconQuestion, IconX } from '../icons';
import { actorName } from '../theme';

interface Props {
  view: ProjectView;
  /** Task ids of the current view (phase); null = whole project. */
  scopeTasks: Set<string> | null;
  scopeName: string | null;
  onReveal: (taskId: string) => void;
  onSelect: (ref: string) => void;
  onHover: (ref: string | null) => void;
  setPins: (pins: string[]) => void;
  onApproveGate: (id: string) => void;
  onConfirmReq: (id: string) => void;
}

/** What matters right now. Recomputed from task status, so it shifts as work moves. */
export function NowPanel({ view, scopeTasks, scopeName, onReveal, onSelect, onHover, setPins, onApproveGate, onConfirmReq }: Props) {
  const { project: p, analysis: a } = view;
  const [whole, setWhole] = useState(false);
  const [showOrder, setShowOrder] = useState(false);
  const [allGates, setAllGates] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const scope = whole ? null : scopeTasks;
  const now = computeNow(view, { scope: scope ?? undefined });
  const byId = new Map(p.tasks.map((t) => [t.id, t]));
  const pinned = new Set(p.pins);
  const waiting = now.questions.length + now.gates.length + now.unconfirmed.length;
  const gatesShown = allGates ? now.gates : now.gates.slice(0, 3);

  const copyPlan = async () => {
    const res = await fetch(`/api/projects/${encodeURIComponent(p.id)}/plan.md?limit=20`);
    await navigator.clipboard.writeText(await res.text());
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  const move = (from: number, to: number) => {
    const next = [...p.pins];
    const [x] = next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, x);
    setPins(next);
  };
  const row = (t: Task) => ({
    onMouseEnter: () => onHover(`task:${t.id}`),
    onMouseLeave: () => onHover(null),
  });

  return (
    <div className="panel-scroll now">
      {scopeTasks && (
        <div className="seg seg-scope">
          <button className={!whole ? 'on' : ''} onClick={() => setWhole(false)}>
            In {scopeName}
          </button>
          <button className={whole ? 'on' : ''} onClick={() => setWhole(true)}>
            Whole project
          </button>
        </div>
      )}

      {waiting > 0 && (
        <section className="psec">
          <h3>
            Waiting on you <span className="count">{waiting}</span>
          </h3>
          {now.questions.map((c) => (
            <button key={c.id} className="row-card q" onClick={() => c.target && onSelect(c.target)}>
              <span className="row-ico agent">
                <IconQuestion size={13} />
              </span>
              <span className="row-main">
                <span className="row-meta">
                  <IconBot size={11} /> {actorName(c.author)} asks {c.target ? `about ${c.target.replace(/^\w+:/, '')}` : ''}
                </span>
                <span className="row-text">{c.text}</span>
              </span>
            </button>
          ))}
          {now.unconfirmed.length > 0 && (
            <div className="row-line">
              <span className="row-ico req">
                <IconCheck size={12} />
              </span>
              <span className="row-line-text">
                Check that the agent understood you: <b>{now.unconfirmed.length}</b> requirement{now.unconfirmed.length > 1 ? 's' : ''} on the left need your OK
              </span>
            </div>
          )}
          {gatesShown.map((t) => (
            <div key={t.id} className="row-line" {...row(t)}>
              <span className="row-ico gate">
                <IconGate size={12} />
              </span>
              <button className="linklike row-line-text" onClick={() => onReveal(t.id)}>
                <b className="mono">{t.id}</b> {t.gate!.description}
              </button>
              <button className="btn btn-xs btn-good-soft" onClick={() => onApproveGate(t.id)}>
                Approve
              </button>
            </div>
          ))}
          {now.gates.length > 3 && (
            <button className="more" onClick={() => setAllGates((v) => !v)}>
              {allGates ? 'Fewer' : `${now.gates.length - 3} more gates coming up`}
            </button>
          )}
        </section>
      )}

      <section className="psec">
        <h3>Must happen next</h3>
        <ol className="nextlist">
          {now.next.map(({ task: t, rank }) => {
            const ins = a.insights[t.id];
            return (
              <li key={t.id} className={`next-row ${ins.critical ? 'crit' : ''}`} {...row(t)}>
                <span className="order-n">{rank}</span>
                <button className="linklike next-main" onClick={() => onReveal(t.id)}>
                  <span className="next-title">
                    <b className="mono">{t.id}</b> {t.title}
                  </span>
                  <span className="next-meta">
                    <span className={`chip chip-${t.status} chip-sm`}>{STATUS_LABEL[t.status]}</span>
                    {ins.pin && <span className="reason r-pin">your pin #{ins.pin}</span>}
                    {ins.pulledBy && <span className="reason r-pin">needed by {ins.pulledBy}</span>}
                    {ins.critical && <span className="reason r-crit">critical path</span>}
                    {t.assignee?.startsWith('agent:') && t.status === 'in_progress' && (
                      <span className="reason r-agent">
                        <IconBot size={10} /> {actorName(t.assignee)}
                      </span>
                    )}
                    {!ins.critical && !ins.pin && !ins.pulledBy && ins.unlocks > 0 && <span className="reason">unlocks {ins.unlocks}</span>}
                  </span>
                </button>
                <button
                  className={`icon-btn pin-toggle ${pinned.has(t.id) ? 'on' : ''}`}
                  title={pinned.has(t.id) ? 'Unpin' : 'Do first'}
                  onClick={() => setPins(pinned.has(t.id) ? p.pins.filter((x) => x !== t.id) : [...p.pins, t.id])}
                >
                  <IconPin size={13} />
                </button>
              </li>
            );
          })}
          {now.next.length === 0 && <p className="empty small">Nothing open here.</p>}
        </ol>
        {now.blockedCritical.length > 0 && (
          <p className="blocked-note">
            Blocked on the critical path:{' '}
            {now.blockedCritical.map((t) => (
              <button key={t.id} className="linklike mono" onClick={() => onReveal(t.id)}>
                {t.id}{' '}
              </button>
            ))}
          </p>
        )}
      </section>

      {now.changes.length > 0 && (
        <section className="psec">
          <h3>Your change requests</h3>
          {now.changes.map((c) => (
            <button key={c.id} className="row-line change" onClick={() => c.target && onSelect(c.target)}>
              <span className="row-ico change">
                <IconPen size={11} />
              </span>
              <span className="row-line-text">
                <span className="muted small">{c.target?.replace(/^(\w+):/, '$1 ') ?? 'project'} · waiting for the agent</span>
                <br />
                {c.text}
              </span>
            </button>
          ))}
        </section>
      )}

      <section className="psec">
        <h3>
          Your pins <span className="hint">agents do these, and what they need, first</span>
        </h3>
        {p.pins.length === 0 ? (
          <p className="empty small">Pin a task (📌) to move it, and everything it needs, to the front.</p>
        ) : (
          <ol className="pins" onDragLeave={() => setOverIdx(null)}>
            {p.pins.map((id, i) => {
              const t = byId.get(id);
              if (!t) return null;
              return (
                <li
                  key={id}
                  draggable
                  className={`pin-row ${overIdx === i ? 'drop-before' : ''} ${dragIdx === i ? 'dragging' : ''}`}
                  onDragStart={() => setDragIdx(i)}
                  onDragEnd={() => (setDragIdx(null), setOverIdx(null))}
                  onDragOver={(e) => (e.preventDefault(), setOverIdx(i))}
                  onDrop={() => {
                    if (dragIdx !== null && dragIdx !== i) move(dragIdx, i);
                    setDragIdx(null);
                    setOverIdx(null);
                  }}
                  {...row(t)}
                >
                  <span className="grip">
                    <IconGrip size={14} />
                  </span>
                  <span className="pin-n">{i + 1}</span>
                  <button className="linklike pin-title" onClick={() => onReveal(id)}>
                    <b className="mono">{id}</b> {t.title}
                  </button>
                  <button className="icon-btn" onClick={() => setPins(p.pins.filter((x) => x !== id))}>
                    <IconX size={12} />
                  </button>
                </li>
              );
            })}
            <li
              className={`pin-tail ${overIdx === p.pins.length ? 'drop-before' : ''}`}
              onDragOver={(e) => (e.preventDefault(), setOverIdx(p.pins.length))}
              onDrop={() => {
                if (dragIdx !== null) move(dragIdx, p.pins.length);
                setDragIdx(null);
                setOverIdx(null);
              }}
            />
          </ol>
        )}
      </section>

      <section className="psec">
        <button className="more" onClick={() => setShowOrder((v) => !v)}>
          {showOrder ? 'Hide' : 'Show'} the full work order ({a.order.length})
        </button>
        {showOrder && (
          <ol className="fullorder">
            {a.order.map((id) => {
              const t = byId.get(id)!;
              const ins = a.insights[id];
              return (
                <li key={id} className={ins.critical ? 'crit' : ''} {...row(t)}>
                  <span className="order-n sm">{ins.rank}</span>
                  <button className="linklike" onClick={() => onReveal(id)}>
                    <b className="mono">{id}</b> {t.title}
                  </button>
                  <span className={`sdot s-${t.status}`} />
                </li>
              );
            })}
          </ol>
        )}
        <button className="btn btn-sm copy-plan" onClick={copyPlan}>
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          {copied ? 'Copied' : 'Copy plan for an agent chat'}
        </button>
      </section>
    </div>
  );
}

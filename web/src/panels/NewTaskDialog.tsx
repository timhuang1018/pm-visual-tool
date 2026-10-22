import { useState } from 'react';
import type { Group, Requirement, Size, Task } from '../../../shared/types';
import { SIZES } from '../../../shared/types';
import { IconX } from '../icons';

interface Props {
  tasks: Task[];
  groups: Group[];
  requirements: Requirement[];
  defaultGroup?: string | null;
  defaultDeps?: string[];
  onCreate: (t: Record<string, unknown>) => Promise<unknown>;
  onClose: () => void;
}

export function NewTaskDialog({ groups, requirements, defaultGroup = null, defaultDeps = [], onCreate, onClose }: Props) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [group, setGroup] = useState<string>(defaultGroup ?? '');
  const [reqs, setReqs] = useState<string[]>([]);
  const [impact, setImpact] = useState<Size>('M');
  const [effort, setEffort] = useState<Size>('M');
  const [deps, setDeps] = useState(defaultDeps.join(', '));
  const [gate, setGate] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onCreate({ title, description, group: group || null, requirements: reqs, impact, effort, dependsOn: deps, gate: gate.trim() || null });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-head">
          <h2>New task</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX size={14} />
          </button>
        </div>
        <label className="field">
          <span className="label">Title</span>
          <input id="new-task-title" className="input" autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should be true when it's done?" />
        </label>
        <label className="field">
          <span className="label">Description</span>
          <textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="modal-row">
          <label className="field">
            <span className="label">Phase</span>
            <select className="input" value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">—</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.parent ? '  · ' : ''}
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="label">Impact</span>
            <select className="input" value={impact} onChange={(e) => setImpact(e.target.value as Size)}>
              {SIZES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="label">Effort</span>
            <select className="input" value={effort} onChange={(e) => setEffort(e.target.value as Size)}>
              {SIZES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>
        {requirements.length > 0 && (
          <div className="field">
            <span className="label">Serves</span>
            <div className="req-picks">
              {requirements.map((r) => (
                <label key={r.id} className={`req-pick ${reqs.includes(r.id) ? 'on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={reqs.includes(r.id)}
                    onChange={(e) => setReqs((xs) => (e.target.checked ? [...xs, r.id] : xs.filter((x) => x !== r.id)))}
                  />
                  {r.id} {r.title}
                </label>
              ))}
            </div>
          </div>
        )}
        <label className="field">
          <span className="label">Waits on (task ids, comma separated)</span>
          <input className="input mono" list="task-ids" value={deps} onChange={(e) => setDeps(e.target.value)} placeholder="T-01, T-02" />
        </label>
        <label className="field">
          <span className="label">Owner gate (optional)</span>
          <input className="input" value={gate} onChange={(e) => setGate(e.target.value)} placeholder="What you want to confirm before work goes on" />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !title.trim()}>
            Create task
          </button>
        </div>
      </form>
    </div>
  );
}

import { useState } from 'react';
import type { PmEvent, ProjectView } from '../../../shared/types';
import { IconBot, IconUser } from '../icons';
import { actorKind, actorName, timeAgo } from '../theme';

export function ActivityPanel({ view, onSelect }: { view: ProjectView; onSelect: (ref: string) => void }) {
  const [who, setWho] = useState<'all' | 'agent' | 'human'>('all');
  const events = [...view.project.events].reverse().filter((e) => who === 'all' || actorKind(e.actor) === who);

  return (
    <div className="panel-scroll">
      <div className="seg seg-filter" role="radiogroup" aria-label="Who">
        {(['all', 'agent', 'human'] as const).map((k) => (
          <button key={k} role="radio" aria-checked={who === k} className={who === k ? 'on' : ''} onClick={() => setWho(k)}>
            {k === 'all' ? 'Everyone' : k === 'agent' ? 'Agents' : 'People'}
          </button>
        ))}
      </div>
      {events.length === 0 && <p className="empty">No activity yet.</p>}
      <ol className="feed">
        {events.slice(0, 300).map((e) => (
          <EventRow key={e.seq} e={e} onSelect={onSelect} />
        ))}
      </ol>
    </div>
  );
}

function EventRow({ e, onSelect }: { e: PmEvent; onSelect: (ref: string) => void }) {
  const kind = actorKind(e.actor);
  const clickable = Boolean(e.target) && e.type !== 'task.deleted' && !(e.summary.includes('removed') && e.type === 'structure.updated');
  return (
    <li className={`feed-row ${kind} t-${e.type.replace('.', '-')}`}>
      <span className={`avatar ${kind}`}>{kind === 'agent' ? <IconBot size={13} /> : <IconUser size={13} />}</span>
      <div className="feed-main">
        <div className="feed-meta">
          <b>{actorName(e.actor)}</b>
          <span className="muted">
            #{e.seq} · {timeAgo(e.at)}
          </span>
        </div>
        {clickable ? (
          <button className="linklike feed-text" onClick={() => onSelect(e.target!)}>
            {e.summary}
          </button>
        ) : (
          <span className="feed-text">{e.summary}</span>
        )}
      </div>
    </li>
  );
}

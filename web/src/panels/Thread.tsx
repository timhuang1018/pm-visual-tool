import { useEffect, useRef, useState } from 'react';
import type { Comment, CommentKind } from '../../../shared/types';
import { KIND_LABEL } from '../../../shared/types';
import { IconBot, IconCheck, IconUser, IconX } from '../icons';
import { actorKind, actorName, timeAgo } from '../theme';
import type { Api } from '../api';

const PLACEHOLDER: Record<CommentKind, string> = {
  change: 'What should change here? e.g. "Split this into ingest and transcribe" or "This task also serves R-2"',
  directive: 'An instruction for the agent, e.g. "Do this before T-12"',
  question: 'Ask the agent…',
  comment: 'A note for the record…',
};

/**
 * Conversation about one element. The owner's default is a change request: point at any part of
 * the chart and say what should be different; the agent picks it up from its inbox.
 */
export function Thread({
  target,
  comments,
  api,
  actor,
  report,
  title = 'Talk to the agent about this',
}: {
  target: string | null;
  comments: Comment[];
  api: Api;
  actor: string;
  report: (e: unknown) => void;
  title?: string;
}) {
  const isHuman = actorKind(actor) === 'human';
  const kinds: CommentKind[] = isHuman ? ['change', 'directive', 'question', 'comment'] : ['comment', 'question'];
  const [kind, setKind] = useState<CommentKind>(kinds[0]);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(comments.length);

  useEffect(() => {
    if (comments.length > prevCount.current) endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    prevCount.current = comments.length;
  }, [comments.length]);
  useEffect(() => {
    setReplyTo(null);
    setText('');
  }, [target]);

  const send = () => {
    if (!text.trim()) return;
    api
      .comment({ target, kind: replyTo ? 'comment' : kind, text, replyTo: replyTo?.id })
      .then(() => {
        setText('');
        setReplyTo(null);
      })
      .catch(report);
  };

  return (
    <div className="thread">
      <span className="label">{title}</span>
      {comments.map((c) => {
        const parent = c.replyTo ? comments.find((x) => x.id === c.replyTo) : null;
        return (
          <div key={c.id} className={`msg ${actorKind(c.author)} k-${c.kind} ${c.resolved ? 'resolved' : ''}`}>
            <div className="msg-meta">
              {actorKind(c.author) === 'agent' ? <IconBot size={12} /> : <IconUser size={12} />}
              <b>{actorName(c.author)}</b>
              {c.kind !== 'comment' && <span className={`kind kind-${c.kind}`}>{KIND_LABEL[c.kind]}</span>}
              <span className="muted">{timeAgo(c.createdAt)}</span>
              {c.kind !== 'comment' && c.resolved && (
                <span className="done-mark">
                  <IconCheck size={11} /> {c.kind === 'change' ? 'applied' : 'resolved'}
                </span>
              )}
            </div>
            {parent && <div className="msg-quote">↳ {parent.text.slice(0, 80)}</div>}
            <div className="msg-text">{c.text}</div>
            <div className="msg-actions">
              <button className="linklike small" onClick={() => (setReplyTo(c), ref.current?.focus())}>
                Reply
              </button>
              {c.kind !== 'comment' && !c.resolved && (
                <button className="linklike small" onClick={() => api.resolve(c.id).catch(report)}>
                  Mark resolved
                </button>
              )}
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
      <div className="composer">
        {replyTo ? (
          <div className="replying">
            Replying to {actorName(replyTo.author)}
            <button className="icon-btn" onClick={() => setReplyTo(null)}>
              <IconX size={11} />
            </button>
          </div>
        ) : (
          <div className="seg" role="radiogroup" aria-label="Message type">
            {kinds.map((k) => (
              <button key={k} role="radio" aria-checked={kind === k} className={`${kind === k ? 'on' : ''} seg-${k}`} onClick={() => setKind(k)}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          className={`input composer-${replyTo ? 'comment' : kind}`}
          rows={2}
          value={text}
          placeholder={replyTo ? 'Write a reply…' : PLACEHOLDER[kind]}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
          }}
        />
        <div className="composer-foot">
          <span className="muted small">⌘↵ to send</span>
          <button className="btn btn-sm btn-primary" disabled={!text.trim()} onClick={send}>
            {replyTo ? 'Reply' : kind === 'change' ? 'Request change' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

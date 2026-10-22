import type { Status } from '../../shared/types';

/** Area palette: muted, distinguishable hues. Unknown areas hash into it. */
const PALETTE = [
  'hsl(205 62% 46%)',
  'hsl(262 38% 52%)',
  'hsl(168 52% 34%)',
  'hsl(32 78% 46%)',
  'hsl(340 48% 50%)',
  'hsl(222 40% 40%)',
  'hsl(90 36% 38%)',
  'hsl(14 72% 50%)',
];

export function areaColor(area: string): string {
  let h = 0;
  for (const c of area) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Requirement colours: stable by position, distinct from status colours. */
const REQ_PALETTE = [
  'hsl(199 70% 42%)',
  'hsl(283 42% 50%)',
  'hsl(160 55% 33%)',
  'hsl(28 85% 48%)',
  'hsl(340 58% 50%)',
  'hsl(226 52% 50%)',
  'hsl(64 55% 36%)',
  'hsl(4 62% 48%)',
];

export function reqColor(index: number): string {
  return REQ_PALETTE[((index % REQ_PALETTE.length) + REQ_PALETTE.length) % REQ_PALETTE.length];
}

export const STATUS_ORDER: Status[] = ['done', 'needs_verification', 'in_progress', 'ready', 'blocked'];

export function actorKind(actor: string): 'agent' | 'human' {
  return actor.startsWith('agent:') ? 'agent' : 'human';
}

export function actorName(actor: string): string {
  return actor.replace(/^(agent|human):/, '');
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

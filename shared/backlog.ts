// Read a repo's backlog file (Markdown tables of rows like `| BL-102 | Task | … | Status | … |`) so a
// board can mirror a chosen slice of it. Read-only: the board never writes the backlog.

import type { Size, Status } from './types';

export interface BacklogRow {
  id: string;
  /** Short card label derived from the row's text. */
  title: string;
  /** Status as written in the row. */
  status: string;
  impact?: Size;
  effort?: Size;
  brief?: string;
  keyword?: string;
  /** Nearest Markdown headings above the table, e.g. "Open, by area > Calendars". */
  section: string;
  /** Other row ids named in the row's text. */
  mentions: string[];
  /** The full row text, for matching only (never sent to the board). */
  text: string;
  file: string;
}

/** Backlog status words → board statuses. Unknown words map to ready; the raw word is kept. */
const STATUS_MAP: Record<string, Status> = {
  ready: 'ready',
  'in progress': 'in_progress',
  'needs verification': 'needs_verification',
  blocked: 'blocked',
  done: 'done',
  icebox: 'blocked',
  cancelled: 'done',
  canceled: 'done',
};

export function backlogStatus(raw: string): Status {
  return STATUS_MAP[raw.trim().toLowerCase()] ?? 'ready';
}

const ROW_ID = /^[A-Za-z]{1,8}-\d+[A-Za-z]?$/;
const MENTION = /\b[A-Z]{2,8}-\d+[a-z]?\b/g;
const TITLE_MAX = 72;

const COLUMNS: Record<string, keyof BacklogRow | 'text'> = {
  id: 'id',
  task: 'text',
  outcome: 'text',
  title: 'text',
  status: 'status',
  impact: 'impact',
  effort: 'effort',
  brief: 'brief',
  record: 'brief',
  'roadmap keyword': 'keyword',
  keyword: 'keyword',
};

function cells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

const isSeparator = (line: string) => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line.trim());

/** Markdown → plain text, enough for card labels and matching. */
export function plain(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A short label: the bold lead if the row has one, else the first clause, capped. */
export function shortTitle(md: string): string {
  const bold = md.trim().match(/^\*\*(.+?)\*\*/);
  let t = plain(bold ? bold[1] : md).split(/ — | – |; |\. (?=[A-Z0-9])/)[0];
  if (t.length > TITLE_MAX) {
    const cut = t.slice(0, TITLE_MAX - 1);
    const space = cut.lastIndexOf(' ');
    t = `${space > TITLE_MAX * 0.6 ? cut.slice(0, space) : cut}…`;
  }
  // A label cut inside a parenthesis ("daily (owner 10-15 ~22:00") reads better without it.
  const open = t.lastIndexOf('(');
  if (open > 8 && (t.match(/\(/g) ?? []).length > (t.match(/\)/g) ?? []).length) t = t.slice(0, open).trim();
  return t.replace(/[.:;,]\s*$/, '');
}

const firstLink = (md: string) => md.match(/\]\(([^)]+)\)/)?.[1] ?? (plain(md) && plain(md) !== '—' ? plain(md) : undefined);
const size = (v?: string): Size | undefined => (v && /^[SML]$/.test(v.trim().toUpperCase()) ? (v.trim().toUpperCase() as Size) : undefined);

/** Every row of every table whose header has an ID and a Status column. */
export function parseBacklog(md: string, file: string): BacklogRow[] {
  const lines = md.split('\n');
  const rows: BacklogRow[] = [];
  const headings: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      headings.length = h[1].length - 1;
      headings[h[1].length - 1] = plain(h[2]);
      continue;
    }
    if (!lines[i].trim().startsWith('|') || !isSeparator(lines[i + 1] ?? '')) continue;
    const header = cells(lines[i]).map((c) => COLUMNS[plain(c).toLowerCase()]);
    if (!header.includes('id') || !header.includes('status')) continue;
    const section = headings.filter(Boolean).slice(1).join(' > ') || headings.filter(Boolean).join(' > ');
    for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
      const c = cells(lines[i]);
      const get = (k: string) => {
        const j = header.indexOf(k as never);
        return j >= 0 ? (c[j] ?? '') : '';
      };
      const id = plain(get('id'));
      if (!ROW_ID.test(id)) continue;
      const text = get('text');
      rows.push({
        id,
        title: shortTitle(text) || id,
        status: plain(get('status')),
        impact: size(get('impact')),
        effort: size(get('effort')),
        brief: firstLink(get('brief')),
        keyword: plain(get('keyword')).replace(/^—$/, '') || undefined,
        section,
        mentions: [...new Set(text.match(MENTION) ?? [])].filter((m) => m !== id),
        text: plain(text),
        file,
      });
    }
    i--;
  }
  return rows;
}

/** Rows whose id, text, keyword or section match a case-insensitive pattern (`a|b` = either). */
export function matchRows(rows: BacklogRow[], pattern: string): BacklogRow[] {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
  return rows.filter((r) => re.test(r.id) || re.test(r.text) || re.test(r.keyword ?? '') || re.test(r.section));
}

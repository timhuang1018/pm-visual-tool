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
  // Words a subtask table may use.
  todo: 'ready',
  'to do': 'ready',
  'not started': 'ready',
  open: 'ready',
  next: 'ready',
  'in-progress': 'in_progress',
  doing: 'in_progress',
  started: 'in_progress',
  wip: 'in_progress',
  'in review': 'needs_verification',
  review: 'needs_verification',
  verify: 'needs_verification',
  waiting: 'blocked',
  paused: 'blocked',
  held: 'blocked',
  skipped: 'done',
  dropped: 'done',
  superseded: 'done',
  merged: 'done',
};

/** The first status word of a cell ("Done 10-26", "In progress — today"), mapped. */
function statusKey(raw: string): string | undefined {
  const s = plain(raw)
    .toLowerCase()
    .replace(/^[\s✅☑✔️⏳🚧❌]+/u, '')
    .replace(/^\[x\]/, 'done')
    .replace(/^\[ \]/, 'ready')
    .trim();
  return Object.keys(STATUS_MAP)
    .sort((a, b) => b.length - a.length)
    .find((k) => s === k || (s.startsWith(k) && /[^a-z]/.test(s[k.length])));
}

export function backlogStatus(raw: string): Status {
  const k = statusKey(raw);
  return k ? STATUS_MAP[k] : 'ready';
}
export const knownStatus = (raw: string) => !!statusKey(raw);

const ROW_ID = /^[A-Za-z]{1,8}-\d+[A-Za-z]?$/;
export const isRowId = (s: string) => ROW_ID.test(s);
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

/** The row's brief, relative to the repo root (its link is relative to the backlog file); null = none. */
export function briefPath(row: Pick<BacklogRow, 'brief' | 'file'>): string | null {
  if (!row.brief || /^[a-z]+:\/\//i.test(row.brief) || !/\.md(#.*)?$/i.test(row.brief)) return null;
  const parts = [...row.file.split('/').slice(0, -1), ...row.brief.replace(/#.*$/, '').split('/')];
  const out: string[] = [];
  for (const x of parts) {
    if (x === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else if (x && x !== '.') out.push(x);
  }
  return out.join('/');
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

// ---------------------------------------------------------------- brief subtasks

/**
 * One row of a brief's `## Subtasks` table:
 *
 *   | ID | Title | Status | Depends on | Estimate | Gate |
 *   |---|---|---|---|---|---|
 *   | T1 | Period shapes | Done | — | S | — |
 *   | T2 | Header basis | In progress | T1 | M · Thu 10-29 | Owner reads the sample |
 */
export interface Subtask {
  id: string;
  title: string;
  /** Status as written. */
  status: string;
  /** Waits-on entries as written: T1 (same brief), BL-487 (a row), BL-494.T3 (another brief's subtask). */
  dependsOn: string[];
  estimate?: string;
  /** Explicit size column, else read from the estimate. */
  effort?: Size;
  impact?: Size;
  /** What the owner checks before it goes on; undefined = no gate. */
  gate?: string;
}

const SUB_COLUMNS: Record<string, keyof Subtask> = {
  id: 'id',
  '#': 'id',
  step: 'id',
  title: 'title',
  task: 'title',
  subtask: 'title',
  what: 'title',
  status: 'status',
  state: 'status',
  'depends on': 'dependsOn',
  depends: 'dependsOn',
  deps: 'dependsOn',
  after: 'dependsOn',
  'waits on': 'dependsOn',
  estimate: 'estimate',
  est: 'estimate',
  eta: 'estimate',
  when: 'estimate',
  effort: 'effort',
  size: 'effort',
  impact: 'impact',
  gate: 'gate',
  'owner gate': 'gate',
  'sign-off': 'gate',
  signoff: 'gate',
};

const SUB_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,30}$/;
const NONE = /^(—|–|-|none|n\/a|no)?$/i;

/** Size from an estimate: a leading S/M/L, or a duration (½ day → S, 2 days → M, 1 week → L). */
export function effortOf(estimate?: string): Size | undefined {
  const e = plain(estimate ?? '').trim();
  if (!e) return undefined;
  const lead = e.match(/^([SML])\b/);
  if (lead) return lead[1] as Size;
  const n = (x: string) => (x === '½' ? 0.5 : Number(x.replace(',', '.')));
  const m = e.match(/(½|\d+(?:[.,]\d+)?)\s*(?:(?:–|-|to)\s*(\d+(?:[.,]\d+)?)\s*)?(h|hours?|d|days?|w|weeks?)\b/i);
  if (!m) return /½\s*day|half a day/i.test(e) ? 'S' : undefined;
  const v = n(m[2] ?? m[1]);
  const days = /^h/i.test(m[3]) ? v / 8 : /^w/i.test(m[3]) ? v * 5 : v;
  return days <= 1 ? 'S' : days <= 3 ? 'M' : 'L';
}

/** Lines of the `## Subtasks` section (heading level 2–4), or null when the brief has none. */
function subtasksSection(lines: string[]): { start: number; end: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(#{2,4})\s+Subtasks\b/i);
    if (!h) continue;
    let end = i + 1;
    while (end < lines.length && !(lines[end].match(/^(#{1,6})\s/) && lines[end].match(/^(#{1,6})\s/)![1].length <= h[1].length)) end++;
    return { start: i, end };
  }
  return null;
}

/** The first table under `## Subtasks` with an ID and a Status column. Checklists there are ignored. */
export function parseSubtasks(md: string): { found: boolean; items: Subtask[]; problems: string[] } {
  const lines = md.split('\n');
  const sec = subtasksSection(lines);
  const problems: string[] = [];
  if (!sec) return { found: false, items: [], problems };
  for (let i = sec.start + 1; i < sec.end; i++) {
    if (!lines[i].trim().startsWith('|') || !isSeparator(lines[i + 1] ?? '')) continue;
    const header = cells(lines[i]).map((c) => SUB_COLUMNS[plain(c).toLowerCase()]);
    if (!header.includes('id') || !header.includes('status')) continue;
    const items: Subtask[] = [];
    for (i += 2; i < sec.end && lines[i].trim().startsWith('|'); i++) {
      const c = cells(lines[i]);
      const get = (k: keyof Subtask) => {
        const j = header.indexOf(k);
        return j >= 0 ? (c[j] ?? '').trim() : '';
      };
      const id = plain(get('id')).replace(/\s+/g, '');
      if (!id) continue;
      if (!SUB_ID.test(id)) {
        problems.push(`subtask id "${id}" is not a short id (letters, digits, . _ -)`);
        continue;
      }
      if (items.some((x) => x.id === id)) {
        problems.push(`subtask ${id} is listed twice; the first row counts`);
        continue;
      }
      const deps = plain(get('dependsOn'));
      const estimate = plain(get('estimate'));
      const gate = plain(get('gate'));
      items.push({
        id,
        title: shortTitle(get('title')) || id,
        status: plain(get('status')),
        dependsOn: NONE.test(deps) ? [] : deps.split(/\s*[,;]\s*|\s+and\s+|\s*\+\s*/).map((d) => d.trim().replace(/\s+/g, ' ')).filter((d) => d && !NONE.test(d)),
        ...(estimate && !NONE.test(estimate) ? { estimate } : {}),
        ...(size(get('effort')) ?? effortOf(estimate) ? { effort: size(get('effort')) ?? effortOf(estimate) } : {}),
        ...(size(get('impact')) ? { impact: size(get('impact')) } : {}),
        ...(gate && !NONE.test(gate) ? { gate } : {}),
      });
    }
    return { found: true, items, problems };
  }
  return { found: true, items: [], problems: ['the Subtasks section has no table with ID and Status columns'] };
}

/**
 * A waits-on entry → what it names. Same-brief ids are bare (T1); another brief's subtask is
 * BL-494.T3 (or "BL-494 T3", "BL-494/T3"); a backlog row is its id.
 */
export function parseDep(dep: string, ownRow: string): { row: string; id?: string } | null {
  const d = dep.trim();
  const m = d.match(/^([A-Za-z]{1,8}-\d+[A-Za-z]?)(?:\s*[.\/#:]\s*|\s+)?([A-Za-z0-9][A-Za-z0-9_.-]{0,30})?$/);
  if (m) return m[2] ? { row: m[1], id: m[2] } : { row: m[1] };
  if (SUB_ID.test(d)) return { row: ownRow, id: d };
  return null; // free text ("after the C4 deploy"): shown, not drawn
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

/** A Subtasks table in the format parseSubtasks reads. */
export function renderSubtasks(items: Subtask[]): string {
  const L = ['| ID | Title | Status | Depends on | Estimate | Gate |', '|---|---|---|---|---|---|'];
  for (const s of items)
    L.push(`| ${esc(s.id)} | ${esc(s.title)} | ${esc(s.status)} | ${s.dependsOn.length ? esc(s.dependsOn.join(', ')) : '—'} | ${esc(s.estimate ?? '') || '—'} | ${esc(s.gate ?? '') || '—'} |`);
  return L.join('\n');
}

/**
 * Put a Subtasks table into a brief: replace the table under `## Subtasks`, or add it at the top of
 * that section, or add the section before `## Progress` (else at the end).
 */
export function writeSubtasks(md: string, table: string): string {
  const lines = md.split('\n');
  const sec = subtasksSection(lines);
  if (sec) {
    for (let i = sec.start + 1; i < sec.end; i++) {
      if (!lines[i].trim().startsWith('|') || !isSeparator(lines[i + 1] ?? '')) continue;
      let j = i + 2;
      while (j < sec.end && lines[j].trim().startsWith('|')) j++;
      lines.splice(i, j - i, ...table.split('\n'));
      return lines.join('\n');
    }
    lines.splice(sec.start + 1, 0, '', ...table.split('\n'));
    return lines.join('\n');
  }
  const progress = lines.findIndex((l) => /^##\s+Progress\b/i.test(l));
  const block = ['## Subtasks', '', ...table.split('\n'), ''];
  if (progress >= 0) lines.splice(progress, 0, ...block);
  else lines.push('', ...block);
  return lines.join('\n');
}

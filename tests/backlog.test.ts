import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchRows, parseBacklog, shortTitle } from '../shared/backlog';
import { renderBrief, renderProposals } from '../shared/briefText';
import { renderPlan } from '../shared/planText';
import { Store } from '../server/store';

const BACKLOG = `# Backlog

## Open, by area

### Calendars

| ID | Task | Roadmap keyword | Status | Impact | Effort | Brief |
|---|---|---|---|---|---|---|
| BL-101 | **Pilot milestone**: the pilot call passes every stage; steps in the brief | 法說會 | In progress | L | L | [brief](briefs/bl101.md) · [result](r.md) |
| BL-102 | Webcast adapter for key company\\|date\\|time lookups — after BL-101 step b | 法說會 | In progress | M | M | [brief](briefs/bl102.md) |
| BL-105 | A very long row that keeps going about transcripts and speakers and audio formats and more things than fit on a card. Waits on BL-102 | transcripts | Blocked | M | S | — |
| BL-106 | Run the old drift study | — | Icebox | M | M | [brief](briefs/bl106.md) |
| BL-107 | Unrelated payments work | billing | Ready | S | S | — |
`;

const DONE = `| ID | Outcome | Status | Record |
|---|---|---|---|
| BL-108 | **Old conference pipeline.** Superseded by BL-109 | Done | [doc](../docs/x.md) |
| BL-110 | **Legacy thing.** | Cancelled | — |
`;

const tmpStore = () => new Store(mkdtempSync(path.join(tmpdir(), 'pm-')));
const rowsOf = () => [...parseBacklog(BACKLOG, 'docs/BACKLOG.md'), ...parseBacklog(DONE, 'docs/BACKLOG-done.md')];
const input = (id: string) => {
  const r = rowsOf().find((x) => x.id === id)!;
  return { id: r.id, title: r.title, status: r.status, impact: r.impact, effort: r.effort, brief: r.brief, keyword: r.keyword, mentions: r.mentions };
};

describe('backlog parsing', () => {
  it('reads rows from any table with ID and Status columns, in either file format', () => {
    const rows = rowsOf();
    expect(rows.map((r) => r.id)).toEqual(['BL-101', 'BL-102', 'BL-105', 'BL-106', 'BL-107', 'BL-108', 'BL-110']);
    const r101 = rows[0];
    expect(r101).toMatchObject({ title: 'Pilot milestone', status: 'In progress', impact: 'L', effort: 'L', brief: 'briefs/bl101.md', keyword: '法說會', section: 'Open, by area > Calendars' });
    expect(rows[1].text).toContain('company|date|time'); // escaped pipes stay inside the cell
    expect(rows[1].mentions).toEqual(['BL-101']);
    expect(rows[3].keyword).toBeUndefined();
    expect(rows[5]).toMatchObject({ title: 'Old conference pipeline', status: 'Done', brief: '../docs/x.md' });
  });

  it('keeps card titles short', () => {
    expect(shortTitle('A very long row that keeps going about transcripts and speakers and audio formats and more things than fit on a card. Waits on BL-102').length).toBeLessThanOrEqual(72);
    expect(shortTitle('Plain clause — with detail after the dash')).toBe('Plain clause');
    expect(shortTitle('**Phase 1 — the universe narrowed.** Froze the list')).toBe('Phase 1');
    expect(shortTitle('Key-driven daily (owner 10-15 ~22: on-demand; nightly after)')).toBe('Key-driven daily');
    expect(shortTitle('Webcast adapter (the pilot milestone step b, top priority: it unblocks the stages after it and more)')).toBe('Webcast adapter');
  });

  it('matches by text, keyword or section', () => {
    expect(matchRows(rowsOf(), '法說會|transcript').map((r) => r.id)).toEqual(['BL-101', 'BL-102', 'BL-105']);
    expect(matchRows(rowsOf(), 'Calendars').length).toBe(5);
  });
});

describe('backlog mirror', () => {
  const setup = () => {
    const s = tmpStore();
    s.createProject({ id: 'p', name: 'P' }, 'human:o');
    s.upsertGroups('p', [{ id: 'cal', name: 'Calendars', goal: 'calls are known' }], 'agent:a');
    s.syncBacklog('p', { files: ['docs/BACKLOG.md'], rows: ['BL-101', 'BL-102', 'BL-106', 'BL-110'].map(input), group: 'cal' }, 'agent:a');
    return s;
  };

  it('creates mirrored tasks with the row status; refresh updates status but keeps the card title', () => {
    const s = setup();
    const t = s.get('p').tasks.find((x) => x.id === 'BL-106')!;
    expect(t).toMatchObject({ status: 'blocked', group: 'cal', backlog: { id: 'BL-106', status: 'Icebox' } });
    expect(s.get('p').tasks.find((x) => x.id === 'BL-110')!.status).toBe('done');
    s.updateTask('p', 'BL-101', { title: 'Pilot call milestone' }, 'agent:a');
    const r = s.syncBacklog('p', { rows: [{ ...input('BL-101'), status: 'Needs verification' }] }, 'agent:a');
    expect(r.changed).toEqual(['BL-101 In progress → Needs verification']);
    expect(s.get('p').tasks.find((x) => x.id === 'BL-101')).toMatchObject({ title: 'Pilot call milestone', status: 'needs_verification' });
    expect(s.get('p').backlog!.files).toEqual(['docs/BACKLOG.md']);
  });

  it('status and sizing of a mirrored task come only from the backlog; links and phases are the board’s', () => {
    const s = setup();
    expect(() => s.updateTask('p', 'BL-102', { status: 'done' }, 'agent:a')).toThrow(/mirrors backlog row BL-102/);
    expect(() => s.updateTask('p', 'BL-102', { effort: 'S' }, 'human:o')).toThrow(/pmv pull/);
    expect(s.updateTask('p', 'BL-102', { dependsOn: ['BL-101'] }, 'agent:a').dependsOn).toEqual(['BL-101']);
  });

  it('a proposal can wait on a done row, and adopt turns it into its new row everywhere', () => {
    const s = setup();
    s.upsertRequirements('p', [{ id: 'R-1', title: 'Score the pilot call' }], 'agent:a');
    s.createTasks('p', [{ id: 'T-01', title: 'Score claims', group: 'cal', requirements: ['R-1'], dependsOn: ['BL-110', 'BL-101'], gate: 'owner checks 20 claims' }], 'agent:a');
    s.createTasks('p', [{ id: 'T-02', title: 'Publish', group: 'cal', requirements: ['R-1'], dependsOn: ['T-01'] }], 'agent:a');
    s.setPins('p', ['T-01'], 'human:o');
    s.setLabel('p', 'T-01', 'T-02', 'scores', 'agent:a');
    s.addNote('p', { target: 'task:T-01', text: 'risk: model cost', tone: 'risk' }, 'agent:a');
    s.addComment('p', { target: 'task:T-01', kind: 'change', text: 'split by sector' }, 'human:o');

    expect(renderProposals(s.view('p'))).toMatch(/Not yet: T-01 \(owner to confirm R-1; apply C-1\)/);
    s.updateRequirement('p', 'R-1', { status: 'confirmed' }, 'human:o');
    expect(renderProposals(s.view('p'))).toMatch(/Ready to ingest: T-02\nNot yet: T-01 \(apply C-1\)/);
    const cards = renderProposals(s.view('p'));
    s.resolveComment('p', 'C-1', 'agent:a');
    expect(renderProposals(s.view('p'))).toMatch(/Ready to ingest: T-01, T-02/);
    expect(cards).toMatch(/After: BL-110 Legacy thing \[Cancelled\]; BL-101/);
    expect(cards).toMatch(/Owner change: "split by sector"/);

    s.adoptTask('p', 'T-01', { id: 'BL-120', status: 'Ready', impact: 'L', effort: 'M' }, 'agent:a');
    const p = s.get('p');
    expect(p.tasks.find((t) => t.id === 'BL-120')).toMatchObject({ title: 'Score claims', backlog: { id: 'BL-120' }, impact: 'L' });
    expect(p.tasks.find((t) => t.id === 'T-02')!.dependsOn).toEqual(['BL-120']);
    expect(p.pins).toEqual(['BL-120']);
    expect(p.labels[0]).toMatchObject({ from: 'BL-120', to: 'T-02' });
    expect(p.notes[0].target).toBe('task:BL-120');
    expect(p.comments[0].target).toBe('task:BL-120');
    expect(() => s.adoptTask('p', 'T-02', { id: 'BL-101', status: 'Ready' }, 'agent:a')).toThrow(/already on the board/);
  });

  it('checks: done work waiting on open work, rows that name each other, board size, no tracing noise for rows', () => {
    const s = setup();
    s.upsertRequirements('p', [{ id: 'R-1', title: 'x' }], 'agent:a');
    s.syncBacklog('p', { rows: [input('BL-105')] }, 'agent:a');
    s.createTasks('p', [{ id: 'T-01', title: 'follow-up', group: 'cal', requirements: ['R-1'] }], 'agent:a');
    s.updateTask('p', 'BL-110', { dependsOn: ['T-01'] }, 'agent:a');
    const codes = (id?: string) => s.view('p').structure.checks.filter((c) => !id || c.target === `task:${id}`).map((c) => c.code);
    expect(codes('BL-110')).toContain('DONE_WAITS_ON_OPEN');
    expect(codes('BL-105')).toContain('BACKLOG_MENTION'); // "Waits on BL-102", both on the board, not linked
    expect(codes()).not.toContain('TASK_UNLINKED');
    s.updateTask('p', 'BL-102', { dependsOn: ['BL-101'] }, 'agent:a');
    s.updateTask('p', 'BL-105', { dependsOn: ['BL-101'] }, 'agent:a');
    expect(codes('BL-105')).toContain('BACKLOG_MENTION'); // a shared prerequisite is not a path between them
    s.updateTask('p', 'BL-105', { dependsOn: ['BL-106'] }, 'agent:a');
    s.updateTask('p', 'BL-106', { dependsOn: ['BL-102'] }, 'agent:a');
    expect(codes('BL-105')).not.toContain('BACKLOG_MENTION'); // linked through BL-106
    expect(codes()).not.toContain('BOARD_LARGE');
    s.createTasks('p', Array.from({ length: 40 }, (_, i) => ({ title: `t${i}`, group: 'cal', requirements: ['R-1'] })), 'agent:a');
    expect(codes()).toContain('BOARD_LARGE');
  });
});

describe('compact texts', () => {
  it('the brief stays a few lines even on the 58-task sample, and is much shorter than the plan', () => {
    const s = tmpStore();
    s.seedSample();
    const v = s.view('sample');
    const brief = renderBrief(v);
    expect(brief.split('\n').length).toBeLessThanOrEqual(12);
    expect(brief).toMatch(/^Critical path: .+ \(\d+ tasks\)$/m);
    expect(brief.length * 5).toBeLessThan(renderPlan(v).length);
  });
});

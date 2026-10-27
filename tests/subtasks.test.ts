import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { briefPath, effortOf, parseDep, parseSubtasks, renderSubtasks, writeSubtasks } from '../shared/backlog';
import { renderBrief } from '../shared/briefText';
import { exportSubtasks, guessRows } from '../shared/subtasks';
import { startServer } from '../server/app';
import { Store, type SubtaskSource } from '../server/store';
import { DocSync } from '../server/sync';

const BRIEF = `---
backlog_id: BL-381
---

# BL-381 — report parser

## Subtasks

- [ ] an older checklist item stays prose

| ID | Title | Status | Depends on | Estimate | Gate |
|---|---|---|---|---|---|
| T1 | **Period shapes** — detail after the dash | Done 10-25 | — | S | — |
| T2 | Header basis | In progress | T1 | M · Thu 10-29 | — |
| T3 | Ranges \\| bounds | Ready | T2, BL-487 | 3–4 days | Owner reads the sample |
| C4 | Deploy to production | Ready | T3; after the C4 release window | ½ day | — |

- [ ] trailing checklist

## Progress

- 2026-10-27: filed.
`;

const BACKLOG = `| ID | Task | Status | Impact | Effort | Brief |
|---|---|---|---|---|---|
| BL-381 | **Report parser v2** — long | In progress | L | L | [brief](briefs/bl381.md) |
| BL-487 | Company profiles | Done | M | M | — |
| BL-494 | **Chunked parsing** | Ready | L | M | [brief](briefs/bl494.md) |
`;

const tmp = () => mkdtempSync(path.join(tmpdir(), 'pm-sub-'));

describe('Subtasks table parsing', () => {
  it('reads the first table under ## Subtasks and ignores checklists', () => {
    const r = parseSubtasks(BRIEF);
    expect(r.found).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.items.map((x) => x.id)).toEqual(['T1', 'T2', 'T3', 'C4']);
    expect(r.items[0]).toEqual({ id: 'T1', title: 'Period shapes', status: 'Done 10-25', dependsOn: [], estimate: 'S', effort: 'S' });
    expect(r.items[1]).toMatchObject({ dependsOn: ['T1'], estimate: 'M · Thu 10-29', effort: 'M' });
    expect(r.items[2]).toMatchObject({ title: 'Ranges | bounds', dependsOn: ['T2', 'BL-487'], effort: 'L', gate: 'Owner reads the sample' });
    expect(r.items[3]).toMatchObject({ dependsOn: ['T3', 'after the C4 release window'], effort: 'S' });
    expect(r.items[3].gate).toBeUndefined();
  });

  it('says when there is no section, or a section without a table', () => {
    expect(parseSubtasks('# x\n\n## Progress\n').found).toBe(false);
    expect(parseSubtasks('## Subtasks\n\n- [ ] only a checklist\n')).toMatchObject({ found: true, items: [], problems: [expect.stringContaining('no table')] });
  });

  it('accepts other column names and flags bad rows', () => {
    const md = '## Subtasks\n\n| Step | What | State | After | Size | Sign-off |\n|---|---|---|---|---|---|\n| 1 | a | todo | | L | no |\n| 1 | dup | done | | | |\n| bad id! | x | done | | | |\n';
    const r = parseSubtasks(md);
    expect(r.items).toEqual([{ id: '1', title: 'a', status: 'todo', dependsOn: [], effort: 'L' }]);
    expect(r.problems).toHaveLength(2);
  });

  it('reads sizes from estimates and names from waits-on entries', () => {
    expect([effortOf('S'), effortOf('L (two weeks)'), effortOf('½ day'), effortOf('2 days'), effortOf('1 week'), effortOf('4h'), effortOf('Wed 10-28')]).toEqual(['S', 'L', 'S', 'M', 'L', 'S', undefined]);
    expect(parseDep('T1', 'BL-381')).toEqual({ row: 'BL-381', id: 'T1' });
    expect(parseDep('BL-487', 'BL-381')).toEqual({ row: 'BL-487' });
    expect(parseDep('BL-494.T3', 'BL-381')).toEqual({ row: 'BL-494', id: 'T3' });
    expect(parseDep('BL-494 T3', 'BL-381')).toEqual({ row: 'BL-494', id: 'T3' });
    expect(parseDep('after the deploy', 'BL-381')).toBeNull();
    expect(briefPath({ file: 'docs/BACKLOG.md', brief: 'briefs/x.md' })).toBe('docs/briefs/x.md');
    expect(briefPath({ file: 'docs/BACKLOG-done.md', brief: '../notes/y.md#top' })).toBe('notes/y.md');
    expect(briefPath({ file: 'docs/BACKLOG.md', brief: 'https://x/y.md' })).toBeNull();
  });
});

describe('subtask sync rules (store)', () => {
  const source = (md = BRIEF): SubtaskSource => ({ row: 'BL-381', title: 'Report parser v2', brief: 'docs/briefs/bl381.md', items: parseSubtasks(md).items });
  const setup = () => {
    const s = new Store(tmp());
    s.createProject({ id: 'p', name: 'P' }, 'human:o');
    s.trackSubtasks('p', { files: ['docs/BACKLOG.md'], rows: [{ row: 'BL-381' }] }, 'agent:a');
    return s;
  };
  const sync = (s: Store, md = BRIEF) => s.syncDocs('p', { files: ['docs/BACKLOG.md'], rows: [], subtasks: [source(md)] }, 'agent:docs');
  const task = (s: Store, id: string) => s.get('p').tasks.find((t) => t.id === id)!;

  it('creates the subtasks with data-owned fields, waits-on and a phase for the row', () => {
    const s = setup();
    const r = sync(s);
    expect(r.created).toEqual(['T1', 'T2', 'T3', 'C4']);
    expect(task(s, 'T1')).toMatchObject({ status: 'done', effort: 'S', group: 'bl-381', subtask: { row: 'BL-381', id: 'T1', status: 'Done 10-25', brief: 'docs/briefs/bl381.md' } });
    expect(task(s, 'T3')).toMatchObject({ dependsOn: ['T2'], effort: 'L', gate: { description: 'Owner reads the sample', status: 'pending' }, subtask: { after: ['BL-487'] } });
    expect(task(s, 'C4').subtask!.after).toEqual(['after the C4 release window']);
    expect(s.get('p').groups.find((g) => g.id === 'bl-381')!.name).toBe('BL-381 Report parser v2');
    expect(task(s, 'T2').meta).toEqual({ estimate: 'M · Thu 10-29' });
  });

  it('follows table edits; an unchanged table changes nothing', () => {
    const s = setup();
    sync(s);
    const seq = s.get('p').seq;
    expect(sync(s).changed).toEqual([]);
    expect(s.get('p').seq).toBe(seq);
    const r = sync(s, BRIEF.replace('| T2 | Header basis | In progress |', '| T2 | Header basis | Done |').replace('| C4 | Deploy to production | Ready | T3; after the C4 release window | ½ day | — |', '| C4 | Deploy | Ready | T3 | ½ day | — |\n| C5 | Read back | Ready | C4 | S | — |'));
    expect(r.created).toEqual(['C5']);
    expect(r.changed).toContain('T2 In progress → Done');
    expect(task(s, 'C5')).toMatchObject({ dependsOn: ['C4'], group: 'bl-381' });
    expect(s.get('p').events.at(-1)!.summary).toMatch(/^From the docs: new: C5; T2 In progress → Done/);
  });

  it('keeps the owner approval while the gate wording stays; new wording asks again', () => {
    const s = setup();
    sync(s);
    s.approveGate('p', 'T3', 'human:owner');
    sync(s, BRIEF.replace('| T3 | Ranges \\| bounds | Ready |', '| T3 | Ranges \\| bounds | Done |'));
    expect(task(s, 'T3').gate).toMatchObject({ status: 'approved', approvedBy: 'human:owner' });
    sync(s, BRIEF.replace('Owner reads the sample', 'Owner reads two samples'));
    expect(task(s, 'T3').gate).toEqual({ description: 'Owner reads two samples', status: 'pending' });
  });

  it('refuses board edits of data-owned fields and keeps board-owned ones', () => {
    const s = setup();
    sync(s);
    expect(() => s.updateTask('p', 'T2', { status: 'done' }, 'agent:a')).toThrow(/kept in the Subtasks table of docs\/briefs\/bl381.md/);
    expect(() => s.updateTask('p', 'T2', { dependsOn: [] }, 'human:owner')).toThrow(/dependsOn/);
    expect(() => s.updateTask('p', 'T2', { gate: 'x' }, 'agent:a')).toThrow(/gate/);
    s.upsertGroups('p', [{ id: 'rules', name: 'Rules', goal: 'g' }], 'agent:a');
    expect(s.updateTask('p', 'T2', { group: 'rules' }, 'agent:a').group).toBe('rules');
    sync(s);
    expect(task(s, 'T2').group).toBe('rules');
  });

  it('adopts claimed board cards (id, comments, approval kept); unclaimed collisions get a qualified id', () => {
    const s = new Store(tmp());
    s.createProject({ id: 'p', name: 'P' }, 'human:o');
    s.upsertGroups('p', [{ id: 'rules', name: 'Rules', goal: 'g' }], 'agent:a');
    s.createTasks('p', [{ id: 'T1', title: 'T1 old title — DONE 10-25', group: 'rules', status: 'done' }, { id: 'T2', title: 'header', group: 'rules', dependsOn: ['T1'] }, { id: 'T3', title: 'ranges', gate: 'Owner reads the sample', group: 'rules' }, { id: 'C4', title: 'not BL-381 work' }], 'agent:a');
    s.approveGate('p', 'T3', 'human:owner');
    s.addComment('p', { target: 'task:T2', kind: 'question', text: 'which basis?' }, 'agent:a');
    s.trackSubtasks('p', { files: ['docs/BACKLOG.md'], rows: [{ row: 'BL-381', claim: ['T1', 'T2', 'T3'] }] }, 'agent:a');
    const r = sync(s);
    expect(r.adopted).toEqual(['T1', 'T2', 'T3']);
    expect(r.created).toEqual(['BL-381.C4']);
    expect(task(s, 'T1')).toMatchObject({ title: 'Period shapes', group: 'rules', subtask: { row: 'BL-381' } });
    expect(task(s, 'T3').gate!.status).toBe('approved');
    expect(task(s, 'C4').subtask).toBeUndefined();
    expect(task(s, 'BL-381.C4').group).toBe('rules'); // next to the siblings it waits on
    expect(s.get('p').comments[0].target).toBe('task:T2');
    expect(s.get('p').backlog!.claims).toEqual({});
  });

  it('turns bad data into problems instead of failing', () => {
    const s = setup();
    const md = BRIEF.replace('| T1 | **Period shapes** — detail after the dash | Done 10-25 | — |', '| T1 | Period shapes | Finished?? | C4 |').replace('| T2 | Header basis | In progress | T1 |', '| T2 | Header basis | In progress | T1, T9 |');
    const r = sync(s, md);
    expect(r.created).toHaveLength(4);
    expect(r.problems.join('\n')).toMatch(/T1: status "Finished\?\?"/);
    expect(r.problems.join('\n')).toMatch(/T2: waits on "T9", which is not in the table/);
    expect(r.problems.join('\n')).toMatch(/cycle/);
    const r2 = sync(s, BRIEF.replace(/\| C4 .*\n/, ''));
    expect(r2.problems).toContain("C4: no longer in BL-381's Subtasks table (pmv rm C4 if it was dropped)");
    const checks = s.view('p').structure.checks.map((c) => c.code);
    expect(checks).toContain('SYNC_PROBLEM');
  });

  it('checks: board-only cards are not synced; a done subtask with a pending gate is flagged', () => {
    const s = setup();
    sync(s, BRIEF.replace('| T3 | Ranges \\| bounds | Ready |', '| T3 | Ranges \\| bounds | Done |'));
    s.createTasks('p', [{ title: 'board-only idea', group: 'bl-381' }], 'agent:a');
    const checks = s.view('p').structure.checks;
    expect(checks.find((c) => c.code === 'NOT_SYNCED')!.message).toContain('T-01');
    expect(checks.find((c) => c.code === 'GATE_SKIPPED')!.target).toBe('task:T3');
    expect(renderBrief(s.view('p'))).toContain('4 subtasks from the briefs of BL-381');
  });

  it('untracking removes the cards', () => {
    const s = setup();
    sync(s);
    expect(s.untrackSubtasks('p', 'BL-381', 'agent:a').removed).toEqual(['T1', 'T2', 'T3', 'C4']);
    expect(s.get('p').tasks).toEqual([]);
  });
});

describe('migration: board cards → Subtasks table', () => {
  it('exports cards in work order, writes them into a brief, and the table reads back the same', () => {
    const s = new Store(tmp());
    s.createProject({ id: 'p', name: 'P' }, 'human:o');
    s.createTasks(
      'p',
      [
        { id: 'T2', title: 'header basis', dependsOn: [], effort: 'M' },
        { id: 'T1', title: 'period shapes — DONE 10-25', status: 'done', effort: 'S', meta: { estimate: 'done 10-25' } },
        { id: 'W2', title: 'BL-494 paid trial (≤US$6 | cap)', gate: 'Owner OKs the spend', dependsOn: ['T1'] },
      ],
      'agent:a',
    );
    s.updateTask('p', 'T2', { dependsOn: ['T1'] }, 'agent:a');
    const p = s.get('p');
    const guess = guessRows(p, (r) => r === 'BL-494');
    expect(guess.get('BL-494')!.map((t) => t.id)).toEqual(['W2']);
    expect(guess.get(null)!.map((t) => t.id)).toEqual(['T2', 'T1']);
    const { items, loose } = exportSubtasks(p, ['T2', 'T1', 'W2'], 'BL-381');
    expect(exportSubtasks(p, ['W2'], 'BL-494', (id) => (id === 'T1' ? 'BL-381' : undefined)).items[0].dependsOn).toEqual(['BL-381.T1']);
    expect(items.map((x) => x.id)).toEqual(['T1', 'T2', 'W2']);
    expect(items[0]).toMatchObject({ title: 'period shapes', status: 'Done', estimate: 'S · done 10-25' });
    expect(loose).toEqual([]);
    const table = renderSubtasks(items);
    const brief = writeSubtasks(BRIEF, table);
    expect(brief).toContain('- [ ] an older checklist item stays prose'); // the rest of the section stays
    const back = parseSubtasks(brief).items;
    expect(back.map((x) => [x.id, x.status, x.dependsOn.join(','), x.effort, x.gate ?? ''])).toEqual(items.map((x) => [x.id, x.status, x.dependsOn.join(','), x.effort, x.gate ?? '']));
    expect(back[2].title).toBe('BL-494 paid trial (≤US$6 | cap)');
    // No section yet: it goes before Progress.
    const fresh = writeSubtasks('# B\n\n## Context\n\nx\n\n## Progress\n\n- y\n', table);
    expect(fresh.indexOf('## Subtasks')).toBeLessThan(fresh.indexOf('## Progress'));
  });
});

describe('document sync from files', () => {
  const repo = () => {
    const root = tmp();
    mkdirSync(path.join(root, 'docs', 'briefs'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'BACKLOG.md'), BACKLOG);
    writeFileSync(path.join(root, 'docs', 'briefs', 'bl381.md'), BRIEF);
    return root;
  };
  const edit = (root: string, from: string, to: string) => {
    const f = path.join(root, 'docs', 'briefs', 'bl381.md');
    writeFileSync(f, readFileSync(f, 'utf8').replace(from, to));
  };

  it('reads the backlog and tracked briefs, and skips the work when nothing changed', () => {
    const root = repo();
    const s = new Store(tmp());
    s.createProject({ id: 'p', name: 'P' }, 'human:o');
    s.trackSubtasks('p', { files: ['docs/BACKLOG.md'], rows: [{ row: 'BL-381' }, { row: 'BL-494' }] }, 'agent:a');
    const d = new DocSync(s, root);
    const r: any = d.sync('p');
    expect(r.created).toEqual(['T1', 'T2', 'T3', 'C4']);
    expect(r.problems).toEqual(['BL-494: brief docs/briefs/bl494.md not found']);
    expect(d.sync('p')).toEqual({ skipped: true });
    edit(root, '| T2 | Header basis | In progress |', '| T2 | Header basis | Needs verification |');
    const r2: any = d.sync('p');
    expect(r2.changed).toEqual(['T2 In progress → Needs verification']);
    expect(s.get('p').tasks.find((t) => t.id === 'T2')!.status).toBe('needs_verification');
  });

  it('the server refreshes on a read and when a watched brief changes', async () => {
    const root = repo();
    const srv = await startServer({ port: 4471, dataDir: tmp(), uiDir: null, root });
    try {
      const api = async (method: string, url: string, body?: unknown) => {
        const res = await fetch(`http://127.0.0.1:4471${url}`, { method, headers: { 'content-type': 'application/json', 'x-actor': 'agent:t' }, body: body === undefined ? undefined : JSON.stringify(body) });
        return res.json();
      };
      await api('POST', '/api/projects', { id: 'p', name: 'P' });
      const tracked = await api('POST', '/api/projects/p/subtasks', { files: ['docs/BACKLOG.md'], rows: [{ row: 'BL-381' }] });
      expect(tracked.created).toEqual(['T1', 'T2', 'T3', 'C4']);
      expect((await api('PATCH', '/api/projects/p/tasks/T2', { status: 'done' })).error).toMatch(/Subtasks table/);

      edit(root, '| C4 | Deploy to production | Ready |', '| C4 | Deploy to production | In progress |');
      const deadline = Date.now() + 3000;
      while (srv.store.get('p').tasks.find((t) => t.id === 'C4')!.status !== 'in_progress' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(srv.store.get('p').tasks.find((t) => t.id === 'C4')!.status).toBe('in_progress'); // by the watcher, or…

      edit(root, '| T3 | Ranges \\| bounds | Ready |', '| T3 | Ranges \\| bounds | Blocked |');
      const view = await api('GET', '/api/projects/p'); // …by any read, at the latest
      expect(view.project.tasks.find((t: any) => t.id === 'T3').status).toBe('blocked');
    } finally {
      await srv.close();
    }
  });
});

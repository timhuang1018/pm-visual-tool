import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Group, PmEvent, ProjectView } from '../../shared/types';
import { Api, useLiveProject } from './api';
import { Canvas } from './graph/Canvas';
import type { DirPref } from './graph/layout';
import type { ReqDot } from './graph/nodes';
import { buildScene, scopeOfTask, type Scope } from './graph/scene';
import { IconArrowLeft, IconBolt, IconBot, IconChevron, IconGate, IconLayers, IconPen, IconPlus, IconSearch, IconUser } from './icons';
import { ActivityPanel } from './panels/ActivityPanel';
import { Inspector } from './panels/Inspector';
import { NewTaskDialog } from './panels/NewTaskDialog';
import { NowPanel } from './panels/NowPanel';
import { RequirementsRail } from './panels/RequirementsRail';
import { actorKind, actorName, reqColor } from './theme';

type Tab = 'now' | 'details' | 'activity';

// URL: #/<project>            overview
//      #/<project>/g/<group>  inside a phase / sub-group
//      #/<project>/all        all tasks
function parseHash(): { project: string; scope: Scope } {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const project = parts[0] || '';
  if (parts[1] === 'g' && parts[2]) return { project, scope: { group: parts[2] } };
  if (parts[1] === 'all') return { project, scope: 'all' };
  if (parts[1] === 'critical') return { project, scope: 'critical' };
  return { project, scope: 'overview' };
}
function hashFor(project: string, scope: Scope) {
  const p = `#/${encodeURIComponent(project)}`;
  return typeof scope === 'string' ? (scope === 'overview' ? p : `${p}/${scope}`) : `${p}/g/${encodeURIComponent(scope.group)}`;
}

export default function App() {
  const [{ project: projectId, scope }, setRoute] = useState(parseHash);
  const [actor, setActor] = useState(() => localStorage.getItem('pm.actor') ?? 'human:owner');
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [trace, setTrace] = useState<string | null>(null);
  const [hoverReq, setHoverReq] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('now');
  const [dir, setDir] = useState<DirPref>(() => (localStorage.getItem('pm.dir2') as DirPref) ?? 'auto');
  const [centerOn, setCenterOn] = useState<{ ref: string; n: number } | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [seenSeq, setSeenSeq] = useState(0);
  const [newTask, setNewTask] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const api = useMemo(() => new Api(projectId, actor), [projectId, actor]);

  const onEvent = useCallback((e: PmEvent) => {
    if (!e.target) return;
    const t = e.target;
    setFlash((s) => new Set(s).add(t));
    setTimeout(
      () =>
        setFlash((s) => {
          const n = new Set(s);
          n.delete(t);
          return n;
        }),
      2400,
    );
  }, []);
  const { view, projects, conn } = useLiveProject(projectId, onEvent);

  useEffect(() => {
    const h = () => setRoute(parseHash());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  useEffect(() => {
    setSelected(null);
    setTrace(null);
    setSeenSeq(0);
  }, [projectId]);
  useEffect(() => {
    localStorage.setItem('pm.actor', actor);
  }, [actor]);
  useEffect(() => {
    localStorage.setItem('pm.dir2', dir);
  }, [dir]);
  useEffect(() => {
    if (view && (tab === 'activity' || seenSeq === 0)) setSeenSeq(view.project.seq);
  }, [tab, view, seenSeq]);

  const go = useCallback((s: Scope) => {
    location.hash = hashFor(parseHash().project, s);
  }, []);
  const openGroup = useCallback(
    (gid: string) => {
      setSelected(null);
      go({ group: gid });
    },
    [go],
  );
  const report = useCallback((e: unknown) => {
    setError((e as Error).message ?? String(e));
    setTimeout(() => setError(''), 6000);
  }, []);
  const select = useCallback((ref: string | null) => {
    setSelected(ref);
    setTab(ref ? 'details' : 'now');
  }, []);
  const reveal = useCallback(
    (tid: string) => {
      if (!view) return;
      const s = scopeOfTask(view.project, tid);
      if (JSON.stringify(s) !== JSON.stringify(parseHash().scope)) go(s);
      setSelected(`task:${tid}`);
      setTab('details');
      setCenterOn({ ref: `task:${tid}`, n: Date.now() });
      setTimeout(() => setCenterOn(null), 1500);
    },
    [view, go],
  );
  const selectRef = useCallback(
    (ref: string | null) => {
      if (ref?.startsWith('task:')) return reveal(ref.slice(5));
      if (ref?.startsWith('req:')) setTrace(ref.slice(4));
      select(ref);
    },
    [reveal, select],
  );

  const scene = useMemo(() => (view ? buildScene(view.project, view.analysis, scope) : null), [view, scope]);
  const reqIndex = useMemo(() => {
    const m = new Map<string, number>();
    [...(view?.project.requirements ?? [])].sort((a, b) => a.order - b.order).forEach((r, i) => m.set(r.id, i));
    return m;
  }, [view?.project.requirements]);
  const reqDots = useCallback(
    (ids: string[]): ReqDot[] =>
      ids
        .filter((id) => reqIndex.has(id))
        .sort((a, b) => reqIndex.get(a)! - reqIndex.get(b)!)
        .map((id) => ({ id, n: String(reqIndex.get(id)! + 1), color: reqColor(reqIndex.get(id)!) })),
    [reqIndex],
  );

  // Esc: deselect, then go up one level. / search, c critical, n new task.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName);
      if (e.key === 'Escape') {
        if (typing) return (e.target as HTMLElement).blur();
        if (selected) return select(null);
        if (trace) return setTrace(null);
        const s = parseHash().scope;
        if (typeof s !== 'string' && view) {
          const parent = view.project.groups.find((g) => g.id === s.group)?.parent;
          go(parent ? { group: parent } : 'overview');
        } else if (s !== 'overview') go('overview');
        return;
      }
      if (typing) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'c') go(parseHash().scope === 'critical' ? 'overview' : 'critical');
      else if (e.key === 'n') {
        e.preventDefault();
        setNewTask(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, trace, view, go, select]);

  if (!projectId && projects.length) location.hash = `#/${projects[0].id}`;
  if (!view || !scene) {
    return (
      <div className="boot">
        <div className="boot-card">
          <span className={`conn conn-${conn}`} />
          {conn === 'offline' ? (
            <>
              <b>Can't reach the board server.</b>
              <span className="muted">
                Start it with <code>npm run dev</code>. Retrying…
              </span>
            </>
          ) : (
            <b>{projectId ? `Loading “${projectId}”…` : projects.length ? 'Opening…' : 'No projects yet. Run `pmv init` in your project.'}</b>
          )}
          {projects.length > 0 && !projects.some((p) => p.id === projectId) && (
            <span className="muted">
              No project “{projectId}”. Open{' '}
              {projects.map((p) => (
                <a key={p.id} href={`#/${p.id}`}>
                  {p.id}{' '}
                </a>
              ))}
            </span>
          )}
        </div>
      </div>
    );
  }

  const { project: p, structure: s } = view;
  const scopeGroup = typeof scope === 'string' ? null : p.groups.find((g) => g.id === scope.group) ?? null;
  const crumbs = scopeGroup ? [...chain(p.groups, scopeGroup.id)].reverse() : [];
  const inspectorTarget = selected ?? (scopeGroup ? `group:${scopeGroup.id}` : `view:${scope === 'all' ? 'all' : 'overview'}`);
  const scopeTasks = scopeGroup ? new Set(s.groups[scopeGroup.id]?.tasks ?? []) : null;
  const unseen = Math.max(0, p.seq - seenSeq);
  const waiting =
    p.comments.filter((c) => !c.resolved && c.author.startsWith('agent:') && c.kind === 'question').length +
    p.requirements.filter((r) => r.status === 'draft').length;
  const warnCount = s.checks.filter((c) => c.level === 'warn' && c.code !== 'CHANGE_REQUESTED').length;
  const q = search.trim().toLowerCase();
  const hits = q ? p.tasks.filter((t) => `${t.id} ${t.title}`.toLowerCase().includes(q)).slice(0, 7) : [];
  const detailsLabel = selected
    ? selected.startsWith('task:')
      ? selected.slice(5)
      : selected.startsWith('req:')
        ? selected.slice(4)
        : selected.startsWith('link:')
          ? 'Link'
          : selected.startsWith('note:')
            ? 'Note'
            : 'Details'
    : scopeGroup
      ? scopeGroup.parent
        ? 'Sub-group'
        : 'Phase'
      : 'This view';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            <svg viewBox="0 0 32 32" width="26" height="26">
              <rect width="32" height="32" rx="8" fill="var(--ink)" />
              <circle cx="9" cy="16" r="3.6" fill="var(--paper)" />
              <circle cx="23" cy="9" r="3.6" fill="var(--crit)" />
              <circle cx="23" cy="23" r="3.6" fill="var(--paper)" />
              <path d="M12 14.6l7.6-4.4M12 17.4l7.6 4.4" stroke="var(--paper)" strokeWidth="1.8" />
            </svg>
          </span>
          <h1>PM Visual</h1>
        </div>
        <select id="project-select" className="input input-ghost" value={projectId} onChange={(e) => (location.hash = `#/${e.target.value}`)} aria-label="Project">
          {projects.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>

        <div className="top-right">
          <div className="search">
            <IconSearch size={14} />
            <input
              id="search"
              ref={searchRef}
              className="input"
              placeholder="Find a task  /"
              value={search}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && hits[0]) {
                  reveal(hits[0].id);
                  setSearch('');
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
            {searchOpen && hits.length > 0 && (
              <div className="search-hits">
                {hits.map((t) => (
                  <button key={t.id} onMouseDown={() => (reveal(t.id), setSearch(''))}>
                    <i className={`sdot s-${t.status}`} />
                    <b className="mono">{t.id}</b> {t.title}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="seg seg-view" role="tablist" aria-label="View">
            <button className={scope !== 'all' && scope !== 'critical' ? 'on' : ''} onClick={() => (setSelected(null), go('overview'))} title="Requirements → phases → tasks">
              Phases
            </button>
            <button id="view-critical" className={scope === 'critical' ? 'on crit' : ''} onClick={() => (setSelected(null), go('critical'))} title="The chain of tasks that decides when everything is done (c)">
              <IconBolt size={12} /> Critical path
            </button>
            <button id="view-all" className={scope === 'all' ? 'on' : ''} onClick={() => (setSelected(null), go('all'))} title="Every task, boxed by phase">
              All tasks
            </button>
          </div>
          <button
            className="icon-btn bordered"
            onClick={() => setDir((d) => (d === 'auto' ? 'LR' : d === 'LR' ? 'TB' : 'auto'))}
            title={dir === 'auto' ? 'Layout: automatic (click for left → right)' : dir === 'LR' ? 'Layout: left → right (click for top → down)' : 'Layout: top → down (click for automatic)'}
          >
            <IconLayers size={14} />
          </button>
          <button id="new-task" className="icon-btn bordered" onClick={() => setNewTask(true)} title="New task (n)">
            <IconPlus size={14} />
          </button>
          <button
            className="identity"
            onClick={() => {
              const v = prompt('Your identity, e.g. human:alice', actor);
              if (v) setActor(/^(human|agent):/.test(v) ? v : `human:${v}`);
            }}
          >
            {actorKind(actor) === 'agent' ? <IconBot size={13} /> : <IconUser size={13} />}
            {actorName(actor)}
            <span className={`conn conn-${conn}`} />
          </button>
        </div>
      </header>

      <main className="body">
        <RequirementsRail
          view={view}
          trace={trace}
          selected={selected}
          colorOf={(id) => reqColor(reqIndex.get(id) ?? 0)}
          onTrace={(id) => {
            setTrace(id);
            select(id ? `req:${id}` : null);
          }}
          onHover={setHoverReq}
          onConfirm={(id) => api.confirmRequirement(id).catch(report)}
          canConfirm={actorKind(actor) === 'human'}
        />

        <section className="canvas" aria-label="Flow chart">
          <CanvasHeader
            view={view}
            scope={scope}
            scopeGroup={scopeGroup}
            crumbs={crumbs}
            onGo={(sc) => {
              setSelected(null);
              go(sc);
            }}
            onRequestChange={() => {
              setSelected(null);
              setTab('details');
              setTimeout(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(), 50);
            }}
          />
          <div className="flow">
            {p.tasks.length === 0 && p.groups.length === 0 ? (
              <EmptyBoard projectId={p.id} />
            ) : (
              <Canvas
                view={view}
                scope={scope}
                scene={scene}
                dir={dir}
                selected={selected}
                hovered={hovered}
                trace={hoverReq ?? trace}
                flash={flash}
                centerOn={centerOn}
                reqDots={reqDots}
                onOpenGroup={openGroup}
                onSelect={selectRef}
                onHover={setHovered}
              />
            )}
            {trace && (
              <div className="trace-banner" style={{ ['--rc' as string]: trace === 'unlinked' ? 'var(--muted)' : reqColor(reqIndex.get(trace) ?? 0) }}>
                {trace === 'unlinked' ? 'Showing work that serves no requirement' : `Showing what serves ${trace}`}
                <button className="btn btn-xs" onClick={() => setTrace(null)}>
                  Show all
                </button>
              </div>
            )}
          </div>
          <Legend groups={scene.nodes.some((n) => n.kind === 'group')} />
        </section>

        <aside className="side">
          <nav className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'now'} className={tab === 'now' ? 'on' : ''} onClick={() => setTab('now')}>
              Now
              {waiting > 0 && <span className="tab-badge alert">{waiting}</span>}
            </button>
            <button role="tab" aria-selected={tab === 'details'} className={tab === 'details' ? 'on' : ''} onClick={() => setTab('details')}>
              {detailsLabel}
              {!selected && warnCount > 0 && scope === 'overview' && <span className="tab-badge">{warnCount}</span>}
            </button>
            <button role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>
              Activity
              {unseen > 0 && tab !== 'activity' && <span className="tab-badge">{unseen > 99 ? '99+' : unseen}</span>}
            </button>
          </nav>
          {tab === 'now' && (
            <NowPanel
              view={view}
              scopeTasks={scopeTasks}
              scopeName={scopeGroup?.name ?? null}
              onReveal={reveal}
              onSelect={selectRef}
              onHover={setHovered}
              setPins={(pins) => api.setPins(pins).catch(report)}
              onApproveGate={(id) => api.approveGate(id).catch(report)}
              onConfirmReq={(id) => api.confirmRequirement(id).catch(report)}
            />
          )}
          {tab === 'details' && (
            <Inspector
              view={view}
              target={inspectorTarget}
              api={api}
              actor={actor}
              reqDots={reqDots}
              onSelect={selectRef}
              onReveal={reveal}
              onOpenGroup={openGroup}
              onHover={setHovered}
              onTrace={(r) => {
                setTrace(r);
                select(`req:${r}`);
              }}
              report={report}
            />
          )}
          {tab === 'activity' && <ActivityPanel view={view} onSelect={(r) => selectRef(r)} />}
        </aside>
      </main>

      <datalist id="task-ids">
        {p.tasks.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title}
          </option>
        ))}
      </datalist>

      {newTask && (
        <NewTaskDialog
          tasks={p.tasks}
          groups={p.groups}
          requirements={p.requirements}
          defaultGroup={scopeGroup?.id ?? null}
          defaultDeps={selected?.startsWith('task:') ? [selected.slice(5)] : []}
          onCreate={(t) => api.createTask(t)}
          onClose={() => setNewTask(false)}
        />
      )}
      {error && (
        <div className="toasts" aria-live="polite">
          <div className="toast toast-error">{error}</div>
        </div>
      )}
    </div>
  );
}

/** Where you are, the way back, and every phase one click away. */
function CanvasHeader({
  view,
  scope,
  scopeGroup,
  crumbs,
  onGo,
  onRequestChange,
}: {
  view: ProjectView;
  scope: Scope;
  scopeGroup: Group | null;
  crumbs: { id: string; name: string; parent: string | null }[];
  onGo: (s: Scope) => void;
  onRequestChange: () => void;
}) {
  const { project: p, structure: s } = view;
  const phases = p.groups.filter((g) => !g.parent).sort((a, b) => a.order - b.order);
  const parent = scopeGroup?.parent ? p.groups.find((g) => g.id === scopeGroup.parent) : null;
  const currentPhase = crumbs[0]?.id ?? null;
  const backTo: { label: string; scope: Scope } | null =
    scope === 'overview' ? null : parent ? { label: parent.name, scope: { group: parent.id } } : { label: 'Overview', scope: 'overview' };
  const cp = view.analysis.criticalPath;
  const title = scope === 'overview' ? 'Overview' : scope === 'all' ? 'All tasks' : scope === 'critical' ? 'Critical path' : scopeGroup?.name ?? '';
  const sub =
    scope === 'overview'
      ? phases.length
        ? `${phases.length} phases, in the order the work flows. Click one to open it.`
        : 'All tasks'
      : scope === 'all'
        ? 'Every task, boxed by phase. Click a box label to open that phase.'
        : scope === 'critical'
          ? cp.length
            ? `The ${cp.length} tasks that decide when everything is done (${view.analysis.criticalLength} effort points left). A delay in any of them delays the finish.`
            : 'Nothing left on the critical path.'
          : scopeGroup?.goal ?? '';
  return (
    <div className="cheader">
      <div className="cheader-row">
        {backTo && (
          <button id="back" className="back-btn" onClick={() => onGo(backTo.scope)} title="Back (Esc)">
            <IconArrowLeft size={15} />
            {backTo.label}
          </button>
        )}
        <div className="cheader-title">
          {crumbs.length > 1 && (
            <div className="cheader-crumbs">
              <button className="linklike" onClick={() => onGo('overview')}>
                Overview
              </button>
              {crumbs.slice(0, -1).map((g) => (
                <span key={g.id}>
                  <IconChevron size={11} />
                  <button className="linklike" onClick={() => onGo({ group: g.id })}>
                    {g.name}
                  </button>
                </span>
              ))}
            </div>
          )}
          <h2>{title}</h2>
          {sub && <p>{sub}</p>}
        </div>
        {scope !== 'critical' && <button id="suggest-change" className="suggest-btn" onClick={onRequestChange} title={`Ask the agent to change ${scopeGroup ? 'this phase' : 'this view'}`}>
          <IconPen size={13} /> Request a change{scopeGroup ? ` to ${scopeGroup.parent ? 'this sub-group' : 'this phase'}` : ''}
        </button>}
      </div>
      {scope !== 'overview' && phases.length > 0 && (
        <nav className="phase-strip" aria-label="Phases">
          {phases.map((g) => {
            const r = s.groups[g.id];
            return (
              <button
                key={g.id}
                className={`pstrip ${currentPhase === g.id ? 'on' : ''} ${(r?.critical ?? 0) > 0 ? 'crit' : ''}`}
                style={{ ['--pct' as string]: `${Math.round((r?.progress ?? 0) * 100)}%` }}
                onClick={() => onGo({ group: g.id })}
              >
                <i>{g.order}</i>
                {g.name}
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}

function chain(groups: { id: string; parent: string | null }[], gid: string) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const out: { id: string; name: string; parent: string | null }[] = [];
  let cur: string | null = gid;
  while (cur && byId.has(cur) && !out.some((x) => x.id === cur)) {
    const g = byId.get(cur)! as { id: string; name: string; parent: string | null };
    out.push(g);
    cur = g.parent;
  }
  return out;
}

function Legend({ groups }: { groups: boolean }) {
  const [open, setOpenState] = useState(() => localStorage.getItem('pm.legend') !== 'closed');
  const toggle = () =>
    setOpenState((o) => {
      localStorage.setItem('pm.legend', o ? 'closed' : 'open');
      return !o;
    });
  return (
    <div className={`legend ${open ? '' : 'closed'}`}>
      {open && (
        <div className="legend-body">
          <span className="lg">
            <svg width="26" height="8">
              <path d="M1 4h19" stroke="var(--edge)" strokeWidth="1.8" />
              <path d="M19 0.5l6 3.5-6 3.5z" fill="var(--edge)" />
            </svg>
            must finish before
          </span>
          <span className="lg">
            <svg width="26" height="8">
              <path d="M1 4h19" stroke="var(--crit)" strokeWidth="2.6" />
              <path d="M19 0.5l6 3.5-6 3.5z" fill="var(--crit)" />
            </svg>
            critical path
          </span>
          {groups ? (
            <>
              <span className="lg">
                <i className="lg-fill" /> green fill = done
              </span>
              <span className="lg">
                <i className="lg-dash" /> dashed = not started
              </span>
            </>
          ) : (
            <>
              <span className="lg">
                <span className="next-chip">Next</span> do first
              </span>
              <span className="lg">
                <i className="lg-dash" /> dashed = blocked
              </span>
            </>
          )}
          <span className="lg">
            <i className="lg-crit" /> red border = critical path
          </span>
          <span className="lg">
            <IconBot size={12} className="ico-bot" /> agent working
          </span>
          <span className="lg">
            <IconGate size={12} className="ico-gate" /> waiting for you
          </span>
          <span className="lg">
            <IconPen size={11} className="ico-change" /> change requested
          </span>
        </div>
      )}
      <button className="legend-toggle" onClick={toggle}>
        {open ? 'hide' : 'Legend'}
      </button>
    </div>
  );
}

function EmptyBoard({ projectId }: { projectId: string }) {
  return (
    <div className="empty-board">
      <h2>Nothing planned yet</h2>
      <p>Tell your AI agent what you want, and ask it to put the plan on this board (it follows AGENTS.md):</p>
      <pre>{`PM_PROJECT=${projectId} npm run pm -- import plan.json
PM_PROJECT=${projectId} npm run pm -- check`}</pre>
      <p className="muted">You'll see your requirements on the left, the phases here, and what matters now on the right.</p>
    </div>
  );
}

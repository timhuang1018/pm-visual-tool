import { useEffect, useRef, useState } from 'react';
import type { ProjectMeta, ProjectView, WsMessage, PmEvent } from '../../shared/types';

export class Api {
  constructor(
    public project: string,
    public actor: string,
  ) {}

  private async call<T = any>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-actor': this.actor },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const txt = await res.text();
    const data = txt ? JSON.parse(txt) : null;
    if (!res.ok) throw new Error(data?.error ?? `${res.status}`);
    return data as T;
  }

  private get p() {
    return `/api/projects/${encodeURIComponent(this.project)}`;
  }

  createProject = (id: string, name: string, description = '') => this.call('POST', '/api/projects', { id, name, description });
  createTask = (task: Record<string, unknown>) => this.call('POST', `${this.p}/tasks`, task);
  updateTask = (id: string, patch: Record<string, unknown>) => this.call('PATCH', `${this.p}/tasks/${id}`, patch);
  deleteTask = (id: string) => this.call('DELETE', `${this.p}/tasks/${id}`);
  approveGate = (id: string) => this.call('POST', `${this.p}/tasks/${id}/approve-gate`, {});
  comment = (body: { target?: string | null; kind?: string; text: string; replyTo?: string }) =>
    this.call('POST', `${this.p}/comments`, body);
  confirmRequirement = (id: string) => this.call('PATCH', `${this.p}/requirements/${id}`, { status: 'confirmed' });
  resolve = (cid: string) => this.call('POST', `${this.p}/comments/${cid}/resolve`, {});
  setPins = (pins: string[]) => this.call('PUT', `${this.p}/pins`, { pins });
}

export type Conn = 'connecting' | 'live' | 'offline';

/** Subscribes to live snapshots of one project over WebSocket (auto-reconnect). */
export function useLiveProject(project: string, onEvent: (e: PmEvent, view: ProjectView) => void) {
  const [view, setView] = useState<ProjectView | null>(null);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [conn, setConn] = useState<Conn>('connecting');
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;
    setView(null);

    const connect = () => {
      setConn('connecting');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws?project=${encodeURIComponent(project)}`);
      ws.onopen = () => {
        retry = 0;
        setConn('live');
      };
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data) as WsMessage;
        if (msg.type === 'projects') setProjects(msg.projects);
        else if (msg.type === 'snapshot' && msg.project === project) {
          setView(msg.view);
          if (msg.event) onEventRef.current(msg.event, msg.view);
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setConn('offline');
        timer = setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [project]);

  return { view, projects, conn };
}

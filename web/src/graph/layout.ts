import dagre from '@dagrejs/dagre';
import type { Scene } from './scene';

export const NODE_W = 240;
export const NODE_H = 100;
export const GROUP_W = 264;
export const GROUP_H = 104;
export const GHOST_W = 170;
export const GHOST_H = 48;
/** Extra height for the wrapping note band. */
export const NOTE_H = 26;

export type Direction = 'LR' | 'TB';
/** 'auto' picks, per view, whichever direction lets the cards be drawn largest. */
export type DirPref = Direction | 'auto';

export type ZoomLevel = 'near' | 'mid' | 'far';
/** Semantic zoom: below these zoom levels task cards switch to simpler, larger type. */
export const zoomLevel = (z: number): ZoomLevel => (z < 0.3 ? 'far' : z < 0.5 ? 'mid' : 'near');

/** Positions, plus the direction links should leave/enter cards (a single-column grid flows top → down). */
export type Placement = Map<string, Placed> & { flow?: Direction };

export interface Placed {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Layered layout: prerequisites left (or top), dependents right. Backward links (against the
 * agent's phase order) are drawn but don't shape the layout. Boxes become dagre clusters.
 */
export function layoutScene(
  scene: Scene,
  dir: Direction,
  size: (nodeId: string) => { w: number; h: number },
  readingOrder = false,
  aspect = 1.4,
): Placement {
  if (readingOrder) return gridLayout(scene, dir, size, aspect);
  const g = new dagre.graphlib.Graph({ compound: scene.boxes.length > 0 });
  const groupScene = scene.nodes.some((n) => n.kind === 'group');
  g.setGraph({
    rankdir: dir,
    nodesep: groupScene ? 40 : dir === 'LR' ? 26 : 36,
    ranksep: groupScene ? 110 : dir === 'LR' ? 64 : 60,
    marginx: 40,
    marginy: 40,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of scene.nodes) {
    const s = size(n.id);
    g.setNode(n.id, { width: s.w, height: s.h });
  }
  for (const b of scene.boxes) g.setNode(b.id, { paddingTop: 34, paddingLeft: 16, paddingRight: 16, paddingBottom: 16 } as any);
  for (const b of scene.boxes) {
    if (b.parent) g.setParent(b.id, b.parent);
    for (const c of b.children) if (g.hasNode(c)) g.setParent(c, b.id);
  }
  for (const e of scene.edges) if (!e.backward) g.setEdge(e.source, e.target);
  dagre.layout(g);
  const out = new Map<string, Placed>();
  for (const id of g.nodes()) {
    const n = g.node(id);
    if (!n || n.x === undefined) continue;
    out.set(id, { x: n.x - n.width / 2, y: n.y - n.height / 2, w: n.width, h: n.height });
  }
  return out;
}

/**
 * Overview: phases in the agent's order, laid out like reading a page (left → right, then the
 * next row), so the owner can walk through them top to bottom.
 */
function gridLayout(scene: Scene, dir: Direction, size: (id: string) => { w: number; h: number }, aspect: number) {
  const n = scene.nodes.length;
  const sizes = scene.nodes.map((x) => size(x.id));
  const cellW = Math.max(...sizes.map((s) => s.w)) + 110;
  const cellH = Math.max(...sizes.map((s) => s.h)) + 90;
  // Pick the column count that lets the cards be drawn largest in the visible canvas.
  let cols = 1;
  let best = 0;
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c);
    const [w, h] = dir === 'LR' ? [c * cellW, r * cellH] : [r * cellW, c * cellH];
    const zoom = Math.min(aspect / w, 1 / h);
    if (zoom > best * 1.04) {
      best = zoom;
      cols = c;
    }
  }
  const out: Placement = new Map<string, Placed>();
  if (dir === 'LR' && cols === 1) out.flow = 'TB';
  if (dir === 'TB' && cols === 1) out.flow = 'LR';
  scene.nodes.forEach((node, i) => {
    const s = sizes[i];
    const major = Math.floor(i / cols);
    const minor = i % cols;
    const [c, r] = dir === 'LR' ? [minor, major] : [major, minor];
    out.set(node.id, { x: 40 + c * cellW + (cellW - 110 - s.w) / 2, y: 40 + r * cellH, w: s.w, h: s.h });
  });
  return out;
}

/** Lay out both ways and keep the one that fits the visible canvas at the larger zoom. */
export function layoutAuto(
  scene: Scene,
  size: (nodeId: string) => { w: number; h: number },
  aspect: number,
  allowGrid = false,
  heightPx = 800,
): Placement {
  let best: Placement | null = null;
  let bestZoom = 0;
  const options: (() => Placement)[] = (['LR', 'TB'] as Direction[]).map((d) => () => {
    const pl = layoutScene(scene, d, size);
    pl.flow = d;
    return pl;
  });
  if (allowGrid) options.push(() => gridLayout(scene, 'LR', size, aspect));
  for (const make of options) {
    const pl = make();
    let maxX = 0;
    let maxY = 0;
    for (const v of pl.values()) {
      maxX = Math.max(maxX, v.x + v.w);
      maxY = Math.max(maxY, v.y + v.h);
    }
    // Zoom (in units of the canvas height) at which this layout fits; never above 1:1.
    const zoom = Math.min(aspect / (maxX + 40), 1 / (maxY + 40), 1 / heightPx);
    if (zoom > bestZoom * 1.08) {
      bestZoom = zoom;
      best = pl;
      best.flow ??= 'LR';
    }
  }
  return best!;
}

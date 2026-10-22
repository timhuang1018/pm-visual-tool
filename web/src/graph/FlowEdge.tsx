import { memo, useContext } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import { IconPen } from '../icons';
import { NodeActions } from './nodes';

export type FlowEdgeData = {
  label: string | null;
  count: number;
  critical: boolean;
  chain: 'up' | 'down' | null;
  dim: boolean;
  selected: boolean;
  backward: boolean;
  change: boolean;
  /** Group-level views draw thicker lines for more aggregated links and show labels. */
  aggregate: boolean;
  /** Secondary link in a busy group view: drawn faintly until its phase is hovered. */
  faint: boolean;
  ref: string;
};
export type FlowEdgeType = Edge<FlowEdgeData, 'flow'>;

/** Bezier edge with the agent's label (what flows) as a pill at the midpoint. */
function FlowEdgeView(props: EdgeProps<FlowEdgeType>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data } = props;
  const d = data!;
  const { selectRef } = useContext(NodeActions);
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: d.backward ? 0.5 : 0.25 });
  const width = d.aggregate ? Math.min(7, 1.6 + Math.log2(d.count + 1) * 1.3) : 1.4;
  const cls = ['fedge', d.critical && 'crit', d.chain && `chain-${d.chain}`, d.dim && 'dim', d.selected && 'sel', d.backward && 'back', d.change && 'has-change', d.faint && 'faint']
    .filter(Boolean)
    .join(' ');
  const showLabel = Boolean(d.label) || d.change;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={cls} style={{ strokeWidth: d.chain || d.critical ? width + 1 : width }} interactionWidth={18} />
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            className={`elabel nodrag nopan ${cls}`}
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
            onClick={() => selectRef(d.ref)}
          >
            {d.change && <IconPen size={10} />}
            {d.label && <span>{d.label}</span>}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
export const FlowEdge = memo(FlowEdgeView);

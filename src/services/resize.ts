import type { Bounds } from './store.js';

export const resizeEdges = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
export type ResizeEdge = typeof resizeEdges[number];
export type ResizeRequest = { phase: 'start'; edge: ResizeEdge } | { phase: 'move'; dx: number; dy: number } | { phase: 'end' };
export const MAX_WIDGET_SIZE = { width: 1000, height: 1400 };

// Anchor the opposite edge, including on monitors whose screen coordinates are negative.
export function resizeBounds(start: Bounds, edge: ResizeEdge, dx: number, dy: number, area: Bounds, minimum: { width: number; height: number }): Bounds {
  if (!resizeEdges.includes(edge) || ![dx, dy].every(Number.isFinite)) throw new Error('Invalid resize gesture');
  const clamp = (value: number, min: number, max: number) => Math.round(Math.max(min, Math.min(max, value)));
  const minWidth = Math.min(minimum.width, area.width);
  const minHeight = Math.min(minimum.height, area.height);
  let { x, y, width, height } = start;
  if (edge.includes('e')) width = clamp(start.width + dx, minWidth, Math.min(MAX_WIDGET_SIZE.width, area.x + area.width - start.x));
  if (edge.includes('s')) height = clamp(start.height + dy, minHeight, Math.min(MAX_WIDGET_SIZE.height, area.y + area.height - start.y));
  if (edge.includes('w')) {
    const right = start.x + start.width;
    x = clamp(start.x + dx, Math.max(area.x, right - MAX_WIDGET_SIZE.width), right - minWidth);
    width = right - x;
  }
  if (edge.includes('n')) {
    const bottom = start.y + start.height;
    y = clamp(start.y + dy, Math.max(area.y, bottom - MAX_WIDGET_SIZE.height), bottom - minHeight);
    height = bottom - y;
  }
  return { x, y, width, height };
}

import type { Project } from '../../types';
import { makePath2D, makePolygonPath } from '../path';
import { applyMat3 } from '../render';
import { enumeratePaintJobs, tileGeometry } from './composite';
import type { TileGeometry } from './composite';

export interface RenderedTile {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  scale: number;
}

function paintItem(ctx: CanvasRenderingContext2D, project: Project, objectIndex: number) {
  const item = project.objects[objectIndex]!;
  const path = makePath2D(item.path);
  ctx.globalAlpha = item.opacity;
  if (item.fill !== 'transparent') {
    ctx.fillStyle = item.fill;
    ctx.fill(path);
  }
  if (item.strokeWidth > 0) {
    ctx.strokeStyle = item.stroke;
    ctx.lineWidth = item.strokeWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke(path);
  }
}

/**
 * Render the periodic supercell. This is exactly exportPeriodicTile's output
 * (transparent background, same paint jobs, same clipping and source-over order), so the
 * seam audit measures the same pixels the PNG export and the 3×3 repeat preview display.
 */
export function renderTile(project: Project, options: { scale?: number } = {}): RenderedTile {
  const geom = tileGeometry(project);
  const scale = options.scale ?? 3;
  const { width, height } = geom;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.scale(scale, scale);
  ctx.clearRect(0, 0, width, height);

  const domainPath = makePath2D(makePolygonPath(geom.domain));

  for (const job of enumeratePaintJobs(project, geom)) {
    ctx.save();
    applyMat3(ctx, job.matrix);
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.clip();
    ctx.clip(domainPath);
    paintItem(ctx, project, job.objectIndex);
    ctx.restore();
  }
  return { canvas, width, height, scale };
}

export type { TileGeometry };

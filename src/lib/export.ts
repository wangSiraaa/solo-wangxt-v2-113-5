import type { Project } from '../types';
import { tileGeometry } from './seam/composite';
import { renderTile } from './seam/renderTile';

export interface TileResult {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  repeats: [number, number];
  primitive: [number, number];
}

/**
 * Render a true periodic image. Rectangular groups use one conventional cell.
 * Triangular groups export a rectangular supercell formed by 2×2 primitive vectors,
 * which still repeats under the wallpaper group's translation lattice. Fundamental
 * domains are clipped as matrix images, including on transparent pixels.
 *
 * The renderer is shared with the seam audit, so the exported PNG and the
 * geometric/final-color audit can never describe different composites.
 */
export function exportPeriodicTile(project: Project, scale = 2): TileResult {
  const geom = tileGeometry(project);
  const rendered = renderTile(project, { scale });
  return {
    canvas: rendered.canvas,
    width: rendered.width,
    height: rendered.height,
    repeats: geom.repeats,
    primitive: [geom.cellW, geom.cellH]
  };
}

export function downloadTile(project: Project, scale = 2) {
  const tile = exportPeriodicTile(project, scale);
  tile.canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name.replace(/[^\p{L}\p{N}._-]+/gu, '-')}-${project.group}-tile.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}

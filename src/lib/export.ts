import type { Project } from '../types';
import { GROUP_SPECS, getCellSize, translationMatrix } from './groups';
import { applyMat3, instanceMatrix } from './render';
import { makePath2D, makePolygonPath, tracePath } from './path';

export interface TileResult {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  repeats: [number, number];
  primitive: [number, number];
}

export interface SupercellRender {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** World-space window painted into the canvas: [origin, origin + size]. */
  origin: [number, number];
  repeats: [number, number];
  primitive: [number, number];
  triangular: boolean;
}

/**
 * Render a true periodic image. Rectangular groups use one conventional cell.
 * Triangular groups export a rectangular supercell formed by 2×2 primitive vectors,
 * which still repeats under the wallpaper group's translation lattice. Fundamental
 * domains are clipped as matrix images, including on transparent pixels.
 *
 * This is the single rasterization path shared by PNG export and the seam audit, so
 * what the audit compares is exactly what the repeat preview and exported PNG show.
 * The optional `margin` (world units) expands the painted window on every side with
 * extra primitive orbit copies; the audit uses it so both sides of a paired
 * periodic boundary are rendered as interior pixels by independent orbit images.
 */
export function renderSupercell(
  project: Project,
  scale = 2,
  margin: [number, number] = [0, 0]
): SupercellRender {
  const [cellW, cellH] = getCellSize(project.group, project.cellWidth, project.cellHeight);
  const spec = GROUP_SPECS[project.group];
  const triangular =
    project.group === 'p3' ||
    project.group === 'p3m1' ||
    project.group === 'p31m' ||
    project.group === 'p6' ||
    project.group === 'p6m';
  const repeatN = triangular ? 2 : 1;
  const repeatM = triangular ? 2 : 1;
  const width = cellW * repeatN;
  const height = cellH * repeatM;
  const originX = -margin[0];
  const originY = -margin[1];
  const canvasWidth = width + margin[0] * 2;
  const canvasHeight = height + margin[1] * 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(canvasWidth * scale));
  canvas.height = Math.max(1, Math.round(canvasHeight * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.translate(-originX, -originY);
  // Keep the exported tile transparent: deliberately do not paint a background.
  ctx.clearRect(originX, originY, canvasWidth, canvasHeight);
  paintInstances(project, ctx, originX, originY, width, height, cellW, cellH, triangular, margin);
  return {
    canvas,
    ctx,
    width,
    height,
    origin: [originX, originY],
    repeats: [repeatN, repeatM],
    primitive: [cellW, cellH],
    triangular
  };
}

/** Paint every object's orbit images into the window, each clipped to its domain image. */
export function paintInstances(
  project: Project,
  ctx: CanvasRenderingContext2D,
  originX: number,
  originY: number,
  width: number,
  height: number,
  cellW: number,
  cellH: number,
  triangular: boolean,
  margin: [number, number] = [0, 0]
) {
  const spec = GROUP_SPECS[project.group];
  const cosetMatrices = spec.cosets(cellW, cellH);
  const domainPath = makePath2D(makePolygonPath(spec.domain(cellW, cellH)));

  // A few extra neighboring primitive copies are needed only because some fundamental
  // domain coordinates (pm/pmg/cm) extend across the conventional rectangle's border.
  // A positive audit margin widens the window, so one more orbit ring is enumerated.
  const extraX = margin[0] > 0 ? 1 : 0;
  const extraY = margin[1] > 0 ? 1 : 0;
  const range = triangular
    ? { nMin: -1 - extraX, nMax: 2 + extraX, mMin: -1 - extraY, mMax: 2 + extraY }
    : { nMin: -1 - extraX, nMax: 1 + extraX, mMin: -1 - extraY, mMax: 1 + extraY };

  for (const item of project.objects) {
    const path = makePath2D(item.path);
    for (let coset = 0; coset < cosetMatrices.length; coset += 1) {
      for (let n = range.nMin; n <= range.nMax; n += 1) {
        for (let m = range.mMin; m <= range.mMax; m += 1) {
          ctx.save();
          // Translate into the positive rectangular supercell before clipping.
          const shift = translationMatrix(project.group, cellW, cellH, triangular ? 1 : 0, triangular ? 1 : 0);
          const matrix = shift;
          void matrix;
          applyMat3(ctx, instanceMatrix(project, coset, n + (triangular ? 1 : 0), m + (triangular ? 1 : 0)));
          ctx.beginPath();
          ctx.rect(originX, originY, width + (-originX) * 2, height + (-originY) * 2);
          ctx.clip();
          ctx.clip(domainPath);
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
          ctx.restore();
        }
      }
    }
  }
  void tracePath;
}

/**
 * Render one object's coverage mask (fills and strokes, ignoring color/opacity style)
 * using the same instance matrices, range and domain clips as the final composite.
 * The mask therefore answers the geometric part of the seam question even for paths
 * whose final pixels are fully transparent because the source opacity was zero.
 */
export function renderObjectMask(
  project: Project,
  objectIndex: number,
  scale = 2,
  margin: [number, number] = [0, 0]
): SupercellRender {
  const [cellW, cellH] = getCellSize(project.group, project.cellWidth, project.cellHeight);
  const spec = GROUP_SPECS[project.group];
  const triangular =
    project.group === 'p3' ||
    project.group === 'p3m1' ||
    project.group === 'p31m' ||
    project.group === 'p6' ||
    project.group === 'p6m';
  const repeatN = triangular ? 2 : 1;
  const repeatM = triangular ? 2 : 1;
  const width = cellW * repeatN;
  const height = cellH * repeatM;
  const originX = -margin[0];
  const originY = -margin[1];
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((width + margin[0] * 2) * scale));
  canvas.height = Math.max(1, Math.round((height + margin[1] * 2) * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.translate(-originX, -originY);
  ctx.clearRect(originX, originY, width + margin[0] * 2, height + margin[1] * 2);

  const item = project.objects[objectIndex]!;
  const path = makePath2D(item.path);
  const cosetMatrices = spec.cosets(cellW, cellH);
  const domainPath = makePath2D(makePolygonPath(spec.domain(cellW, cellH)));
  const extraX = margin[0] > 0 ? 1 : 0;
  const extraY = margin[1] > 0 ? 1 : 0;
  const range = triangular
    ? { nMin: -1 - extraX, nMax: 2 + extraX, mMin: -1 - extraY, mMax: 2 + extraY }
    : { nMin: -1 - extraX, nMax: 1 + extraX, mMin: -1 - extraY, mMax: 1 + extraY };

  for (let coset = 0; coset < cosetMatrices.length; coset += 1) {
    for (let n = range.nMin; n <= range.nMax; n += 1) {
      for (let m = range.mMin; m <= range.mMax; m += 1) {
        ctx.save();
        applyMat3(ctx, instanceMatrix(project, coset, n + (triangular ? 1 : 0), m + (triangular ? 1 : 0)));
        ctx.beginPath();
        ctx.rect(originX, originY, width + (-originX) * 2, height + (-originY) * 2);
        ctx.clip();
        ctx.clip(domainPath);
        // Opaque white: style opacity must not hide a geometric seam.
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#ffffff';
        if (item.fill !== 'transparent') ctx.fill(path);
        if (item.strokeWidth > 0) {
          ctx.lineWidth = item.strokeWidth;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.stroke(path);
        }
        ctx.restore();
      }
    }
  }
  return {
    canvas,
    ctx,
    width,
    height,
    origin: [originX, originY],
    repeats: [repeatN, repeatM],
    primitive: [cellW, cellH],
    triangular
  };
}

export function exportPeriodicTile(project: Project, scale = 2): TileResult {
  const render = renderSupercell(project, scale);
  return {
    canvas: render.canvas,
    width: render.width,
    height: render.height,
    repeats: render.repeats,
    primitive: render.primitive
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

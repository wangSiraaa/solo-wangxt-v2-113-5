import type { mat3 } from 'gl-matrix';
import type { Point, Project } from '../types';
import {
  GROUP_SPECS,
  compose,
  getCellSize,
  invert,
  latticeVectors,
  transformPoint,
  translationMatrix
} from './groups';
import { renderObjectMask, renderSupercell } from './export';
import { makePath2D, makePolygonPath } from './path';
import type {
  AuditToken,
  BoundaryKind,
  BoundaryResult,
  MismatchCluster,
  MismatchPoint,
  SeamReport
} from './seamTypes';

const AUDIT_SCALE = 2;
/** World-unit margin painted around the supercell for independent edge comparison. */
const MARGIN_WORLD = 28;
/** Pixel distance from the window edge; margin samples must stay clear of clip AA. */
const EDGE_GUARD_PX = 4;
/** Compare the first several interior columns/rows across a paired boundary. */
const STRIP_PX = 6;
/** A neighborhood of this radius on the partner side absorbs sub-pixel raster phase shifts. */
const NEIGHBOR_PX = 2;
/** Premultiplied per-channel-aware RGBA distance threshold for one sample pair. */
const COLOR_DELTA_LIMIT = 30;
/** Coverage mask alpha threshold for one sample pair. */
const GEOMETRY_DELTA_LIMIT = 48;
/** A boundary fails when this fraction (or more) of samples disagrees. */
const MISMATCH_RATIO_LIMIT = 0.004;

const TOLERANCE_GROUPS = new Set(['p3', 'p3m1', 'p31m', 'p6', 'p6m']);

interface SampleGrid {
  /** pixel coordinates (in the AUDIT_SCALE canvas) to sample. */
  pxs: Array<[number, number]>;
  /** matching partner pixel before wrapping; wrap mod canvas size. */
  partners: Array<[number, number]>;
  /** world coords of the A sample, for reporting. */
  worlds: Point[];
}

interface Raster {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface RunContext {
  token: AuditToken;
  isCancelled: () => boolean;
  yieldToUi: () => Promise<void>;
}

/**
 * Geometry-and-composite seam audit.
 *
 * Two independent comparisons are made on every paired periodic boundary:
 *  1. geometry  — per-object coverage masks (strokes and fills, style-independent),
 *                  so transparent/zero-opacity paths cannot hide a seam;
 *  2. composite — premultiplied RGBA of the exact rasterization used by PNG export,
 *                  so blending, anti-aliasing and transparent strokes are compared the
 *                  same way the 3×3 repeat preview displays them.
 *
 * Rectangular/centered groups check the wrap edges of the periodic rectangle.
 * Triangular groups additionally check both primitive lattice translations of the
 * 2×2 rectangular supercell, including the oblique (w/2,h) boundary; a single
 * horizontal/vertical pixel scan cannot see that seam.
 */
export async function runSeamAudit(project: Project, context: RunContext): Promise<SeamReport> {
  const startedAt = Date.now();
  const [cellW, cellH] = getCellSize(project.group, project.cellWidth, project.cellHeight);
  const spec = GROUP_SPECS[project.group];
  const triangular = TOLERANCE_GROUPS.has(project.group);
  const centered = project.group === 'cm' || project.group === 'cmm';
  // A margin band large enough for both primitive directions (tri lattice is
  // sheared: the horizontal period needs vertical room too).
  const margin: [number, number] = [Math.round(cellW * 0.25) + MARGIN_WORLD, Math.round(cellH) + MARGIN_WORLD];

  // The extended render is the audit's single source of truth: the central box is
  // byte-identical to what PNG export shows, and both sides of every paired
  // boundary are covered by independent orbit images well inside the window.
  const composite = renderSupercell(project, AUDIT_SCALE, margin);
  const compositeRaster = readRaster(composite.canvas);
  const maskCanvases = project.objects.map((_, index) => renderObjectMask(project, index, AUDIT_SCALE, margin));
  const maskRasters = maskCanvases.map((mask) => readRaster(mask.canvas));

  const boundaries: Array<{ kind: BoundaryKind; label: string; translation: Point }> = [
    {
      kind: 'wrap-x',
      label: triangular
        ? '超级周期左右矩形边界（水平平移 2w,0）'
        : '周期单元左右边界（水平平移 w,0）',
      translation: [composite.width, 0]
    },
    {
      kind: 'wrap-y',
      label: triangular
        ? '超级周期上下矩形边界（竖直平移 0,2h）'
        : '周期单元上下边界（竖直平移 0,h）',
      translation: [0, composite.height]
    }
  ];
  if (triangular || centered) {
    const [a, b] = latticeVectors(project.group, cellW, cellH);
    boundaries.push({
      kind: 'primitive-a',
      label: `原胞平移 t₁（${a[0].toFixed(1)}, ${a[1].toFixed(1)}）`,
      translation: a
    });
    boundaries.push({
      kind: 'primitive-b',
      label: `原胞平移 t₂（${b[0].toFixed(1)}, ${b[1].toFixed(1)}）斜向晶格边界`,
      translation: b
    });
  }

  const results: BoundaryResult[] = [];
  for (const boundary of boundaries) {
    if (context.isCancelled()) throw new Error('cancelled');
    await context.yieldToUi();
    const grid = buildGrid(composite, boundary.kind, boundary.translation);

    const points = compareSamples(grid, compositeRaster, maskRasters);
    const clusters = clusterMismatches(project, spec.domain(cellW, cellH), cellW, cellH, triangular, points, boundary);
    const mismatchPoints = points.filter((point) => point.colorDelta > COLOR_DELTA_LIMIT || point.geometryDelta > GEOMETRY_DELTA_LIMIT);
    const maxColorDelta = points.reduce((max, point) => Math.max(max, point.colorDelta), 0);
    const maxGeometryDelta = points.reduce((max, point) => Math.max(max, point.geometryDelta), 0);
    const mismatchRatio = points.length === 0 ? 0 : mismatchPoints.length / points.length;
    results.push({
      kind: boundary.kind,
      label: boundary.label,
      translation: boundary.translation,
      geometry: boundaryGeometry(boundary.kind, composite.width, composite.height, boundary.translation),
      passed: mismatchPoints.length === 0 || mismatchRatio < MISMATCH_RATIO_LIMIT,
      sampled: points.length,
      mismatchCount: mismatchPoints.length,
      mismatchRatio,
      maxColorDelta,
      maxGeometryDelta,
      clusters
    });
  }

  return {
    status: results.every((result) => result.passed) ? 'passed' : 'failed',
    fingerprint: context.token.fingerprint,
    epoch: context.token.epoch,
    runId: context.token.runId,
    group: project.group,
    cellWidth: cellW,
    cellHeight: cellH,
    supercell: {
      width: composite.width,
      height: composite.height,
      repeats: composite.repeats
    },
    scale: AUDIT_SCALE,
    startedAt,
    finishedAt: Date.now(),
    boundaries: results
  };
}

function readRaster(canvas: HTMLCanvasElement): Raster {
  const ctx = canvas.getContext('2d')!;
  return {
    data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
    width: canvas.width,
    height: canvas.height
  };
}

/**
 * Sample pairs for a paired periodic boundary.
 *
 * Wrap boundaries (rectangle frame): a strip just INSIDE the supercell is paired
 * with the geometrically adjacent strip just OUTSIDE it in the margin, i.e. the
 * independent orbit image the repeating tile places across the seam. Both sides
 * are interior pixels of the extended render — never clipped window edges — and
 * neither side is the other side of the same cut, so a motif edge that happens to
 * land on the frame can no longer cause a false positive.
 *
 * Primitive translations (including oblique ones): pairs lie strictly inside the
 * supercell box, displaced by the lattice vector; samples are excluded where
 * either member would leave the box (those pairs coincide with a wrap boundary
 * and are covered by the wrap checks).
 */
function buildGrid(
  render: ReturnType<typeof renderSupercell>,
  kind: BoundaryKind,
  translation: Point
): SampleGrid {
  const canvasW = render.canvas.width;
  const canvasH = render.canvas.height;
  const [ox, oy] = render.origin;
  const toPx = (worldX: number, worldY: number): [number, number] => [
    Math.round((worldX - ox) * AUDIT_SCALE),
    Math.round((worldY - oy) * AUDIT_SCALE)
  ];
  const W = render.width;
  const H = render.height;
  const pxs: Array<[number, number]> = [];
  const partners: Array<[number, number]> = [];
  const worlds: Point[] = [];
  const guard = EDGE_GUARD_PX;

  const add = (worldX: number, worldY: number, dx: number, dy: number) => {
    const [ax, ay] = toPx(worldX, worldY);
    const [bx, by] = toPx(worldX + dx, worldY + dy);
    if (ax < guard || ay < guard || bx < guard || by < guard) return;
    if (ax > canvasW - guard || ay > canvasH - guard || bx > canvasW - guard || by > canvasH - guard) return;
    pxs.push([ax, ay]);
    partners.push([bx, by]);
    worlds.push([worldX, worldY]);
  };

  if (kind === 'wrap-x') {
    const step = 1 / AUDIT_SCALE;
    // Strips along the inside of both vertical edges, paired across the seam with
    // the adjacent outside strips rendered by independent orbit copies.
    for (let y = 0; y < H; y += step) {
      for (let k = 1; k <= STRIP_PX; k += 1) {
        const d = k / AUDIT_SCALE;
        add(d, y, -2 * d, 0); // right side of left seam vs outside-left
        add(W - d, y, 2 * d, 0); // left side of right seam vs outside-right
      }
    }
  } else if (kind === 'wrap-y') {
    const step = 1 / AUDIT_SCALE;
    for (let x = 0; x < W; x += step) {
      for (let k = 1; k <= STRIP_PX; k += 1) {
        const d = k / AUDIT_SCALE;
        add(x, d, 0, -2 * d);
        add(x, H - d, 0, 2 * d);
      }
    }
  } else {
    // Interior displacement by the lattice vector; pairs leaving the box are
    // skipped (they coincide with a wrap boundary, covered separately).
    const [tx, ty] = translation;
    const step = 1 / AUDIT_SCALE;
    for (let y = 0; y < H; y += step) {
      for (let x = 0; x < W; x += step) {
        const ux = x + tx;
        const uy = y + ty;
        if (ux < 0 || ux > W || uy < 0 || uy > H) continue;
        add(x, y, tx, ty);
      }
    }
  }
  return { pxs, partners, worlds };
}

function compareSamples(
  grid: SampleGrid,
  composite: Raster,
  masks: Raster[]
): MismatchPoint[] {
  const points: MismatchPoint[] = [];
  for (let i = 0; i < grid.pxs.length; i += 1) {
    const [ax, ay] = grid.pxs[i]!;
    const [bx0, by0] = grid.partners[i]!;
    const colorDelta = neighborDistance(composite, ax, ay, bx0, by0, premultipliedDistance);
    let geometryDelta = 0;
    for (const mask of masks) {
      geometryDelta = Math.max(geometryDelta, neighborDistance(mask, ax, ay, bx0, by0, alphaDistance));
    }
    points.push({
      ax,
      ay,
      bx: bx0,
      by: by0,
      a: grid.worlds[i]!,
      b: [bx0 / AUDIT_SCALE, by0 / AUDIT_SCALE],
      colorDelta,
      geometryDelta
    });
  }
  return points;
}

/**
 * Bidirectional nearest-pair distance across a small neighborhood: the max of
 * (best match of A inside B's neighborhood, best match of B inside A's). One
 * direction catches added ink, the other catches missing ink; the neighborhood
 * absorbs anti-aliasing phase differences on slanted edges. An exact pixel match
 * short-circuits to zero — on a passing pattern almost every sample hits it, which
 * keeps the dense oblique-boundary grid cheap.
 */
function neighborDistance(
  raster: Raster,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  metric: (raster: Raster, x1: number, y1: number, x2: number, y2: number) => number
): number {
  const exact = metric(raster, ax, ay, bx, by);
  if (exact === 0) return 0;
  let forward = exact;
  let backward = exact;
  const r = NEIGHBOR_PX;
  for (let oy = -r; oy <= r; oy += 1) {
    for (let ox = -r; ox <= r; ox += 1) {
      if (ox === 0 && oy === 0) continue;
      forward = Math.min(forward, metric(raster, ax, ay, bx + ox, by + oy));
      backward = Math.min(backward, metric(raster, ax + ox, ay + oy, bx, by));
    }
  }
  return Math.max(forward, backward);
}

function premultipliedDistance(raster: Raster, x1: number, y1: number, x2: number, y2: number): number {
  const i1 = (y1 * raster.width + x1) * 4;
  const i2 = (y2 * raster.width + x2) * 4;
  const d1 = raster.data;
  const d2 = raster.data;
  // Canvas stores straight alpha but blends source-over in premultiplied space;
  // compare premultiplied values so faint-but-opaque vs strong-but-transparent
  // strokes cannot falsely agree or disagree on transparent seams.
  let total = 0;
  for (let channel = 0; channel < 4; channel += 1) {
    const v1 = channel === 3 ? d1[i1 + channel]! : (d1[i1 + channel]! * d1[i1 + 3]!) / 255;
    const v2 = channel === 3 ? d2[i2 + channel]! : (d2[i2 + channel]! * d2[i2 + 3]!) / 255;
    total += Math.abs(v1 - v2);
  }
  return total;
}

function alphaDistance(raster: Raster, x1: number, y1: number, x2: number, y2: number): number {
  return Math.abs(
    raster.data[(y1 * raster.width + x1) * 4 + 3]! -
      raster.data[(y2 * raster.width + x2) * 4 + 3]!
  );
}

function clusterMismatches(
  project: Project,
  domain: Point[],
  cellW: number,
  cellH: number,
  triangular: boolean,
  points: MismatchPoint[],
  boundary: { kind: BoundaryKind; translation: Point }
): MismatchCluster[] {
  const flagged = points.filter(
    (point) => point.colorDelta > COLOR_DELTA_LIMIT || point.geometryDelta > GEOMETRY_DELTA_LIMIT
  );
  if (flagged.length === 0) return [];

  // Flood fill connected components in audit-pixel space. Wrap boundaries are 1D
  // strips; translation boundaries (including the oblique lattice seam) need 2D
  // 8-connectivity so diagonal bands cluster together instead of per-row fragments.
  const byKey = new Map<string, MismatchPoint>();
  for (const point of flagged) byKey.set(`${point.ax},${point.ay}`, point);
  const visited = new Set<string>();
  const components: MismatchPoint[][] = [];
  for (const point of flagged) {
    const key = `${point.ax},${point.ay}`;
    if (visited.has(key)) continue;
    const members: MismatchPoint[] = [];
    const queue = [point];
    visited.add(key);
    while (queue.length > 0) {
      const current = queue.pop()!;
      members.push(current);
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          if (ox === 0 && oy === 0) continue;
          const neighborKey = `${current.ax + ox},${current.ay + oy}`;
          if (visited.has(neighborKey)) continue;
          const neighbor = byKey.get(neighborKey);
          if (!neighbor) continue;
          visited.add(neighborKey);
          queue.push(neighbor);
        }
      }
    }
    components.push(members);
  }

  const clusters = components.map((members) => {
    let sumX = 0;
    let sumY = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxColorDelta = 0;
    let maxGeometryDelta = 0;
    for (const point of members) {
      sumX += point.a[0];
      sumY += point.a[1];
      minX = Math.min(minX, point.a[0]);
      minY = Math.min(minY, point.a[1]);
      maxX = Math.max(maxX, point.a[0]);
      maxY = Math.max(maxY, point.a[1]);
      maxColorDelta = Math.max(maxColorDelta, point.colorDelta);
      maxGeometryDelta = Math.max(maxGeometryDelta, point.geometryDelta);
    }
    const centroid: Point = [sumX / members.length, sumY / members.length];
    let radius = 0;
    for (const point of members) {
      radius = Math.max(radius, Math.hypot(point.a[0] - centroid[0], point.a[1] - centroid[1]));
    }
    const owner = attributeMismatch(
      project,
      domain,
      cellW,
      cellH,
      triangular,
      members,
      boundary.translation
    );
    return {
      point: centroid,
      bounds: { x: minX, y: minY, w: Math.max(1 / AUDIT_SCALE, maxX - minX), h: Math.max(1 / AUDIT_SCALE, maxY - minY) },
      radius: Math.max(2 / AUDIT_SCALE, radius),
      pixelCount: members.length,
      maxColorDelta,
      maxGeometryDelta,
      objectId: owner?.objectId ?? null,
      objectName: owner?.objectName ?? null,
      instance: owner?.instance ?? null
    };
  });

  return clusters
    .sort((a, b) => Math.max(b.maxColorDelta, b.maxGeometryDelta) - Math.max(a.maxColorDelta, a.maxGeometryDelta))
    .slice(0, 24);
}

interface MismatchOwner {
  objectId: string;
  objectName: string;
  instance: string;
}

/**
 * Find the unique source object whose orbit image covers a mismatch region.
 * Probes several representative member pixels on both paired sides, so attribution
 * still succeeds when the centroid itself falls on a fully transparent anti-aliased
 * pixel. Returns the concrete instance key objectId@coset:n,m.
 */
function attributeMismatch(
  project: Project,
  domain: Point[],
  cellW: number,
  cellH: number,
  triangular: boolean,
  members: MismatchPoint[],
  _translation: Point
): MismatchOwner | null {
  const spec = GROUP_SPECS[project.group];
  const cosets = spec.cosets(cellW, cellH);
  const domainPath = makePath2D(makePolygonPath(domain));
  const range = triangular
    ? { nMin: -1, nMax: 2, mMin: -1, mMax: 2 }
    : { nMin: -1, nMax: 1, mMin: -1, mMax: 1 };
  // The audit's supercell coordinates are shifted by +(1,1) primitive copies for
  // triangular groups (same shift as export); undo that before un-transforming.
  const unshift = (point: Point): Point =>
    triangular ? transformPoint(translationMatrix(project.group, cellW, cellH, -1, -1), point[0], point[1]) : point;

  const ordered = members
    .slice()
    .sort((a, b) => Math.max(b.colorDelta, b.geometryDelta) - Math.max(a.colorDelta, a.geometryDelta));
  const probes: Point[] = [];
  for (const point of ordered) {
    probes.push(unshift(point.a));
    probes.push(unshift(point.b));
    if (probes.length >= 12) break;
  }
  if (ordered.length > 0) probes.unshift(unshift([ordered[0]!.a[0], ordered[0]!.a[1]]));

  const probe = document.createElement('canvas').getContext('2d')!;
  for (const query of probes) {
    for (let objectIndex = project.objects.length - 1; objectIndex >= 0; objectIndex -= 1) {
      const item = project.objects[objectIndex]!;
      const sourcePath = makePath2D(item.path);
      for (let coset = 0; coset < cosets.length; coset += 1) {
        for (let n = range.nMin; n <= range.nMax; n += 1) {
          for (let m = range.mMin; m <= range.mMax; m += 1) {
            const matrix = instanceMatrixFor(project, cellW, cellH, coset, n, m);
            const local = transformPoint(invert(matrix), query[0], query[1]);
            if (!probe.isPointInPath(domainPath, local[0], local[1])) continue;
            const inside =
              item.fill !== 'transparent' && probe.isPointInPath(sourcePath, local[0], local[1]);
            probe.lineWidth = Math.max(2, item.strokeWidth + 2);
            probe.lineJoin = 'round';
            if (inside || (item.strokeWidth > 0 && probe.isPointInStroke(sourcePath, local[0], local[1]))) {
              return {
                objectId: item.id,
                objectName: item.name,
                instance: `${item.id}@${coset}:${n},${m}`
              };
            }
          }
        }
      }
    }
  }
  return null;
}

function instanceMatrixFor(project: Project, w: number, h: number, coset: number, n: number, m: number): mat3 {
  const spec = GROUP_SPECS[project.group];
  return compose(translationMatrix(project.group, w, h, n, m), spec.cosets(w, h)[coset]!);
}

/** Polyline drawn in the UI for each boundary, in supercell world coordinates. */
function boundaryGeometry(kind: BoundaryKind, width: number, height: number, translation: Point): Point[] {
  if (kind === 'wrap-x') {
    return [
      [0, 0],
      [0, height]
    ];
  }
  if (kind === 'wrap-y') {
    return [
      [0, 0],
      [width, 0]
    ];
  }
  // Oblique/primitive boundary: draw every lattice-parallel segment crossing the
  // supercell so the hot zones sit on the actual diagonal seams.
  const segments: Point[] = [];
  const length = Math.hypot(width, height) * 2;
  const [tx, ty] = translation;
  const norm = Math.hypot(tx, ty) || 1;
  const dx = (tx / norm) * length;
  const dy = (ty / norm) * length;
  // Perpendicular stepping so parallel copies tile across the rectangle.
  const px = -dy / length;
  const py = dx / length;
  const span = Math.hypot(width, height) * 2;
  for (let step = -span; step <= span; step += Math.hypot(tx, ty)) {
    const cx = width / 2 + px * step;
    const cy = height / 2 + py * step;
    segments.push([cx - dx, cy - dy]);
    segments.push([cx + dx, cy + dy]);
  }
  return segments;
}

import type { Point, Project } from '../../types';
import type { mat3 } from 'gl-matrix';
import { GROUP_SPECS, latticeVectors, multiply, translationMatrix } from '../groups';
import type { ContributorHit, RGBA, SeamSampler } from './types';
import { enumeratePaintJobs, isTriangular, tileGeometry, type TileGeometry } from './composite';
import {
  applyMatrix,
  distanceToPath,
  flattenPath,
  flattenStyle,
  invertMatrix,
  pointInPath,
  pointInPolygon,
  type FlatSubpath
} from './geometry';

interface PreparedObject {
  subpaths: FlatSubpath[];
  fill: [number, number, number] | null;
  stroke: [number, number, number] | null;
  strokeWidth: number;
  opacity: number;
}

export interface SoftwareSamplerOptions {
  /**
   * 'infinite' evaluates the genuine infinite periodic composite at any world point
   * (any primitive copy whose fundamental domain contains the pre-image). 'tile'
   * reproduces the exported rectangular supercell exactly, including its fixed paint-job
   * range. Seam audits compare 'infinite' across glued edges; export consistency compares
   * 'tile' against 'infinite'.
   */
  mode?: 'infinite' | 'tile';
}

interface JobRecord {
  objectIndex: number;
  objectId: string;
  objectName: string;
  coset: number;
  n: number;
  m: number;
  inverse: mat3;
}

/**
 * Dependency-free re-implementation of the final composite. Paint order, the two clips
 * (fundamental domain in pre-image space; supercell rectangle for tile mode) and
 * source-over premultiplied compositing match exportPeriodicTile.
 */
export function createSoftwareSampler(project: Project, options: SoftwareSamplerOptions = {}): SeamSampler {
  const mode = options.mode ?? 'infinite';
  const geom = tileGeometry(project);
  const prepared: PreparedObject[] = project.objects.map((item) => {
    const style = flattenStyle(item);
    return {
      subpaths: flattenPath(item.path),
      fill: style.fill,
      stroke: style.stroke,
      strokeWidth: style.strokeWidth,
      opacity: style.opacity
    };
  });

  const fixedJobs: JobRecord[] = enumeratePaintJobs(project, geom).map((job) => ({
    objectIndex: job.objectIndex,
    objectId: job.objectId,
    objectName: job.objectName,
    coset: job.coset,
    n: job.n,
    m: job.m,
    inverse: invertMatrix(job.matrix)
  }));

  const fixedCellSet = new Set(fixedJobs.map((job) => `${job.n}:${job.m}`));
  const fixedJobKeySet = new Set(
    fixedJobs.map((job) => `${job.objectIndex}:${job.coset}:${job.n}:${job.m}`)
  );

  /** Primitive-copy candidates near a world point for the infinite composite. */
  function candidateCells(point: Point): Array<{ n: number; m: number }> {
    const [a, b] = latticeVectors(geom.group, geom.cellW, geom.cellH);
    const det = a[0] * b[1] - a[1] * b[0];
    const s = (b[1] * point[0] - b[0] * point[1]) / det;
    const t = (-a[1] * point[0] + a[0] * point[1]) / det;
    const n0 = Math.round(s);
    const m0 = Math.round(t);
    const cells: Array<{ n: number; m: number }> = [];
    for (let n = n0 - 2; n <= n0 + 2; n += 1) {
      for (let m = m0 - 2; m <= m0 + 2; m += 1) {
        // In tile mode only the exporter's actual paint-job copies are allowed.
        if (mode === 'tile' && !fixedCellSet.has(`${n}:${m}`)) continue;
        cells.push({ n, m });
      }
    }
    return cells;
  }

  /** Evaluate one concrete matrix image (n,m,coset) at a world point. */
  function evaluate(
    objectIndex: number,
    n: number,
    m: number,
    coset: number,
    inverse: mat3 | null,
    world: Point
  ): [number, [number, number, number]] | null {
    if (mode === 'tile' && (world[0] < -1e-7 || world[1] < -1e-7 || world[0] > geom.width + 1e-7 || world[1] > geom.height + 1e-7)) {
      return null;
    }
    const inv = inverse ?? inverseFor(n, m, coset);
    const q = applyMatrix(inv, world);
    if (!pointInPolygon(q, geom.domain)) return null;
    const obj = prepared[objectIndex]!;
    let alpha = 0;
    let color: [number, number, number] = [0, 0, 0];
    if (obj.fill && pointInPath(q, obj.subpaths)) {
      alpha = 1;
      color = obj.fill;
    }
    if (obj.stroke && obj.strokeWidth > 0) {
      const distance = distanceToPath(q, obj.subpaths);
      if (distance <= obj.strokeWidth / 2) {
        alpha = 1;
        color = obj.stroke;
      }
    }
    if (alpha <= 0 || obj.opacity <= 0) return null;
    return [alpha * obj.opacity, color];
  }

  const inverseCache = new Map<string, mat3>();
  function inverseFor(n: number, m: number, coset: number): mat3 {
    const key = `${n}:${m}:${coset}`;
    const cached = inverseCache.get(key);
    if (cached) return cached;
    const matrix = instanceWorldMatrix(geom, project.group, n, m, coset);
    const inv = invertMatrix(matrix);
    inverseCache.set(key, inv);
    return inv;
  }

  /** All (objectIndex, job) pairs painting at a point, in source-over order. */
  function covering(world: Point): Array<{ objectIndex: number; coset: number; n: number; m: number }> {
    const result: Array<{ objectIndex: number; coset: number; n: number; m: number }> = [];
    const cells = candidateCells(world);
    for (let objectIndex = 0; objectIndex < project.objects.length; objectIndex += 1) {
      const cosetCount = geom.cosets.length;
      cells.forEach(({ n, m }) => {
        for (let coset = 0; coset < cosetCount; coset += 1) {
          if (mode === 'tile' && !fixedJobKeySet.has(`${objectIndex}:${coset}:${n}:${m}`)) return;
          if (evaluate(objectIndex, n, m, coset, null, world)) {
            result.push({ objectIndex, coset, n, m });
          }
        }
      });
    }
    return result;
  }

  function compositeAt(world: Point): RGBA {
    // Paint order: objects in list order; within an object, coset then n then m — the
    // same order enumeratePaintJobs produces for the exporter.
    const covers = covering(world);
    covers.sort((x, y) =>
      x.objectIndex - y.objectIndex || x.coset - y.coset || x.n - y.n || x.m - y.m
    );
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (const cover of covers) {
      const obj = prepared[cover.objectIndex]!;
      const hit = evaluate(cover.objectIndex, cover.n, cover.m, cover.coset, null, world);
      if (!hit) continue;
      const [sourceAlpha, [sr, sg, sb]] = hit;
      const over = sourceAlpha * (1 - a);
      r += sr * over;
      g += sg * over;
      b += sb * over;
      a += over;
    }
    return [r, g, b, a];
  }

  return {
    sample(x, y, radius = 1.1): RGBA {
      // No coordinate wrapping here: tile mode renders exactly the exported supercell,
      // so probes outside the rectangle stay transparent (the exporter clips them).
      // The auditor wraps only outer translation-edge probes before calling sample().
      const center: Point = [x, y];
      const grid = 3;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let i = 0; i < grid; i += 1) {
        for (let j = 0; j < grid; j += 1) {
          const fx = ((i + 0.5) / grid - 0.5) * 2 * radius;
          const fy = ((j + 0.5) / grid - 0.5) * 2 * radius;
          const c = compositeAt([center[0] + fx, center[1] + fy]);
          r += c[0];
          g += c[1];
          b += c[2];
          a += c[3];
          count += 1;
        }
      }
      return [r / count, g / count, b / count, a / count];
    },
    contributorsAt(x, y, radius = 2.2): ContributorHit[] {
      const center: Point = [x, y];
      const offsets: Point[] = [
        [0, 0],
        [radius * 0.7, 0],
        [-radius * 0.7, 0],
        [0, radius * 0.7],
        [0, -radius * 0.7],
        [radius * 0.5, radius * 0.5],
        [-radius * 0.5, radius * 0.5],
        [radius * 0.5, -radius * 0.5],
        [-radius * 0.5, -radius * 0.5]
      ];
      const found = new Map<string, ContributorHit>();
      for (const offset of offsets) {
        const covers = covering([center[0] + offset[0], center[1] + offset[1]]);
        for (const cover of covers) {
          const key = `${cover.objectIndex}:${cover.coset}:${cover.n}:${cover.m}`;
          if (found.has(key)) continue;
          const obj = project.objects[cover.objectIndex]!;
          found.set(key, {
            objectId: obj.id,
            objectName: obj.name,
            coset: cover.coset,
            n: cover.n,
            m: cover.m
          });
        }
      }
      return [...found.values()];
    }
  };
}

function instanceWorldMatrix(geom: TileGeometry, group: Project['group'], n: number, m: number, coset: number): mat3 {
  const base = GROUP_SPECS[group].cosets(geom.cellW, geom.cellH)[coset]!;
  return multiply(translationMatrix(group, geom.cellW, geom.cellH, n, m), base);
}

export { tileGeometry, isTriangular };

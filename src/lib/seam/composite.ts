import type { mat3 } from 'gl-matrix';
import type { Point, Project } from '../../types';
import { GROUP_SPECS, getCellSize, multiply, translationMatrix } from '../groups';

/**
 * Geometry of the exported rectangular periodic unit. This is the single source of truth
 * shared by the PNG exporter, the Canvas-backed seam auditor and the headless software
 * sampler, so geometry and final composite can never disagree about what the tile is.
 */
export interface TileGeometry {
  group: Project['group'];
  cellW: number;
  cellH: number;
  /** Rectangular supercell size in world units. */
  width: number;
  height: number;
  /** Primitive cells combined per axis (2×2 for triangular lattices, else 1×1). */
  repeats: [number, number];
  /** Fundamental-domain polygon in primitive-cell (job pre-image) coordinates. */
  domain: Point[];
  cosets: mat3[];
}

export function isTriangular(group: Project['group']): boolean {
  return group === 'p3' || group === 'p3m1' || group === 'p31m' || group === 'p6' || group === 'p6m';
}

export function tileGeometry(project: Project): TileGeometry {
  const [cellW, cellH] = getCellSize(project.group, project.cellWidth, project.cellHeight);
  const triangular = isTriangular(project.group);
  const repeats: [number, number] = triangular ? [2, 2] : [1, 1];
  const spec = GROUP_SPECS[project.group];
  return {
    group: project.group,
    cellW,
    cellH,
    width: cellW * repeats[0],
    height: cellH * repeats[1],
    repeats,
    domain: spec.domain(cellW, cellH),
    cosets: spec.cosets(cellW, cellH)
  };
}

/** Primitive lattice copy range actually painted by exportPeriodicTile. */
export function paintRange(geom: TileGeometry): { nMin: number; nMax: number; mMin: number; mMax: number } {
  // Triangular exports use a 2×2 rectangular supercell. Chamber hexagons near its
  // corners (e.g. the (0,2h) corner, only covered by cell (-1,2)) require one ring
  // beyond the naive 0..2 range; otherwise unpainted corner wedges break tiling.
  if (isTriangular(geom.group)) return { nMin: -1, nMax: 3, mMin: -1, mMax: 3 };
  // Rectangular groups paint -1..1 for the pm/pg/cm domains that extend across the
  // conventional rectangle border.
  return { nMin: -1, nMax: 1, mMin: -1, mMax: 1 };
}

export interface PaintJob {
  objectIndex: number;
  objectId: string;
  objectName: string;
  /**
   * Full world matrix of the image inside supercell coordinates:
   * p_world = T(n,m) · C_i · p_source (triangular copies already carry the +1 shift
   * through paintRange). Clipping still applies the supercell rectangle and the
   * fundamental-domain polygon in pre-image space.
   */
  matrix: mat3;
  coset: number;
  n: number;
  m: number;
}

/**
 * Enumerate every matrix image (object × coset × periodic copy) that can paint into the
 * rectangular supercell. Source-over painting follows this exact array order in the
 * exporter and both samplers.
 */
export function enumeratePaintJobs(project: Project, geom: TileGeometry): PaintJob[] {
  const range = paintRange(geom);
  const jobs: PaintJob[] = [];
  project.objects.forEach((item, objectIndex) => {
    geom.cosets.forEach((cosetMatrix, coset) => {
      for (let n = range.nMin; n <= range.nMax; n += 1) {
        for (let m = range.mMin; m <= range.mMax; m += 1) {
          const lattice = translationMatrix(project.group, geom.cellW, geom.cellH, n, m);
          jobs.push({
            objectIndex,
            objectId: item.id,
            objectName: item.name,
            matrix: multiply(lattice, cosetMatrix),
            coset,
            n,
            m
          });
        }
      }
    });
  });
  return jobs;
}

import type { Point } from '../../types';
import { latticeVectors, transformPoint } from '../groups';
import { add, normalize, scale, subtract } from './geometry';
import { tileGeometry, type TileGeometry } from './composite';

export interface BoundarySpec {
  id: string;
  kind: 'translation' | 'oblique';
  label: string;
  direction: Point;
  from: Point;
  to: Point;
  /**
   * Outer supercell edges are periodic: the outside point is read from the wrapped
   * opposite edge of the exported tile. Interior tessellation edges compare two points
   * both inside the supercell without wrapping, so a missing/mis-clipped neighboring
   * copy on a slanted boundary fails instead of being hidden by coordinate wrap.
   */
  wrap: boolean;
}

const INSET = 0.8;
const SEGMENT_MIN = 6;

function outerBoundaries(geom: TileGeometry): BoundarySpec[] {
  const { width: W, height: H } = geom;
  return [
    {
      id: 'outer-left-right',
      kind: 'translation',
      label: `左右平移边界 x = 0 ⇄ ${Math.round(W)}：比较无限周期合成两侧的几何覆盖与预乘颜色`,
      direction: [0, 1],
      from: [0, INSET],
      to: [0, H - INSET],
      wrap: true
    },
    {
      id: 'outer-top-bottom',
      kind: 'translation',
      label: `上下平移边界 y = 0 ⇄ ${Math.round(H)}：比较无限周期合成两侧的几何覆盖与预乘颜色`,
      direction: [1, 0],
      from: [INSET, 0],
      to: [W - INSET, 0],
      wrap: true
    }
  ];
}

interface Segment {
  a: Point;
  b: Point;
}

function snap(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function edgeKey(a: Point, b: Point): string {
  const p = (q: Point) => `${snap(q[0])},${snap(q[1])}`;
  const ka = p(a);
  const kb = p(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function segmentLength(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/**
 * Edges of the wallpaper-group tessellation inside the rectangular supercell: every edge
 * of every transformed fundamental domain (all cosets and neighboring periodic copies).
 * These are exactly the lines across which the clipped pattern must agree with a
 * symmetry/translation image. Checking only the horizontal/vertical outer frame misses the
 * slanted chamber edges of triangular (p3…p6m) and centered (cm/cmm) lattices.
 */
function tessellationEdges(geom: TileGeometry): BoundarySpec[] {
  const polygon = geom.domain;
  const seen = new Map<string, Segment>();

  const consider = (rawA: Point, rawB: Point) => {
    const inside = (p: Point) =>
      p[0] >= -1 && p[1] >= -1 && p[0] <= geom.width + 1 && p[1] <= geom.height + 1;
    if (!inside(rawA) && !inside(rawB)) return;
    const clipped = clipSegmentRect(rawA, rawB, geom.width, geom.height);
    if (!clipped) return;
    const [a, b] = [
      [snap(clipped[0][0]), snap(clipped[0][1])] as Point,
      [snap(clipped[1][0]), snap(clipped[1][1])] as Point
    ];
    if (segmentLength(a, b) < SEGMENT_MIN) return;
    const key = edgeKey(a, b);
    if (!seen.has(key)) seen.set(key, { a, b });
  };

  const range = jobRangeForEdges(geom);
  const [v1, v2] = latticeVectors(geom.group, geom.cellW, geom.cellH);

  for (const cosetMatrix of geom.cosets) {
    for (let n = range.nMin; n <= range.nMax; n += 1) {
      for (let m = range.mMin; m <= range.mMax; m += 1) {
        const shift: Point = [n * v1[0] + m * v2[0], n * v1[1] + m * v2[1]];
        for (let i = 0; i < polygon.length; i += 1) {
          const pa = polygon[i]!;
          const pb = polygon[(i + 1) % polygon.length]!;
          // World edge = T(n,m) · C_i · (domain vertex); T is a pure translation.
          const ca = transformPoint(cosetMatrix, pa[0], pa[1]);
          const cb = transformPoint(cosetMatrix, pb[0], pb[1]);
          consider([ca[0] + shift[0], ca[1] + shift[1]], [cb[0] + shift[0], cb[1] + shift[1]]);
        }
      }
    }
  }

  return mergeSegments([...seen.values()])
    .filter((seg) => {
      const mid: Point = [(seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2];
      const onOuter =
        mid[0] <= 1.5 || mid[1] <= 1.5 || mid[0] >= geom.width - 1.5 || mid[1] >= geom.height - 1.5;
      return !onOuter;
    })
    .map((seg, index) => ({
      id: `tess-${index}`,
      kind: 'oblique' as const,
      label: `斜晶格/基本域镶嵌边界（端点 (${seg.a[0].toFixed(1)}, ${seg.a[1].toFixed(1)}) → (${seg.b[0].toFixed(
        1
      )}, ${seg.b[1].toFixed(1)})）`,
      direction: normalize(subtract(seg.b, seg.a)),
      from: seg.a,
      to: seg.b,
      wrap: false
    }));
}

function jobRangeForEdges(geom: TileGeometry): { nMin: number; nMax: number; mMin: number; mMax: number } {
  const repeatN = geom.repeats[0];
  const repeatM = geom.repeats[1];
  return { nMin: -repeatN, nMax: repeatN * 2, mMin: -repeatM, mMax: repeatM * 2 };
}

function clipSegmentRect(a: Point, b: Point, W: number, H: number): [Point, Point] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - INSET, W + INSET - a[0], a[1] - INSET, H + INSET - a[1]];
  for (let i = 0; i < 4; i += 1) {
    if (Math.abs(p[i]!) < 1e-12) {
      if (q[i]! < 0) return null;
    } else {
      const ratio = q[i]! / p[i]!;
      if (p[i]! < 0) t0 = Math.max(t0, ratio);
      else t1 = Math.min(t1, ratio);
    }
  }
  if (t0 > t1) return null;
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy]
  ];
}

function near(a: Point, b: Point): boolean {
  return Math.abs(a[0] - b[0]) < 0.02 && Math.abs(a[1] - b[1]) < 0.02;
}

function collinear(a: Point, b: Point, c: Point): boolean {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 0.5;
}

/** Join same-line segments that share a snapped endpoint, leaving distinct pieces apart. */
function mergeSegments(segments: Segment[]): Segment[] {
  const result: Segment[] = [];
  const used = new Array(segments.length).fill(false);
  for (let i = 0; i < segments.length; i += 1) {
    if (used[i]) continue;
    used[i] = true;
    let a = segments[i]!.a;
    let b = segments[i]!.b;
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < segments.length; j += 1) {
        if (used[j]) continue;
        const c = segments[j]!.a;
        const d = segments[j]!.b;
        if (near(a, d) && collinear(a, b, c)) {
          a = c;
          used[j] = true;
          grew = true;
        } else if (near(b, c) && collinear(a, b, d)) {
          b = d;
          used[j] = true;
          grew = true;
        } else if (near(a, c) && collinear(a, b, d)) {
          a = d;
          used[j] = true;
          grew = true;
        } else if (near(b, d) && collinear(a, b, c)) {
          b = c;
          used[j] = true;
          grew = true;
        }
      }
    }
    result.push({ a, b });
  }
  return result;
}

export function boundarySpecs(geom: TileGeometry): BoundarySpec[] {
  return [...outerBoundaries(geom), ...tessellationEdges(geom)];
}

/** Unit normal of a directed line. */
export function normalOf(direction: Point): Point {
  return normalize([-direction[1], direction[0]]);
}

/**
 * Paired points on the two sides of one seam at equal perpendicular depth. Both are
 * evaluated in the infinite periodic composite (never in one wrapped tile), so a path
 * crossing only one side of a paired edge fails instead of being hidden by wrapping.
 */
export function sidePoints(spec: BoundarySpec, station: Point, depth: number): { a: Point; b: Point } {
  const n = normalOf(spec.direction);
  return { a: add(station, scale(n, depth)), b: subtract(station, scale(n, depth)) };
}

export { tileGeometry };

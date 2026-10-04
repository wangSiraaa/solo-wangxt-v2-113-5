import type { PathSegment, Point, StyleSpec } from '../../types';
import type { mat3 } from 'gl-matrix';
import { latticeVectors, transformPoint } from '../groups';
import type { TileGeometry } from './composite';

export interface FlatSubpath {
  closed: boolean;
  points: Point[];
}

/** Flatten canvas-style path commands into line subpaths using cubic/quadratic subdivision. */
export function flattenPath(path: PathSegment[], tolerance = 0.35): FlatSubpath[] {
  const subpaths: FlatSubpath[] = [];
  let current: Point | null = null;
  let points: Point[] = [];

  const finish = (closed: boolean) => {
    if (points.length) subpaths.push({ closed, points });
    points = [];
    current = null;
  };

  for (const segment of path) {
    if (segment.type === 'M') {
      finish(false);
      current = [segment.x, segment.y];
      points = [current];
    } else if (segment.type === 'L' && current) {
      current = [segment.x, segment.y];
      points.push(current);
    } else if (segment.type === 'Q' && current) {
      const p0 = current;
      const p1: Point = [segment.cx, segment.cy];
      const p2: Point = [segment.x, segment.y];
      const steps = quadSteps(p0, p1, p2, tolerance);
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const mt = 1 - t;
        points.push([
          mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0],
          mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]
        ]);
      }
      current = p2;
    } else if (segment.type === 'C' && current) {
      const p0 = current;
      const p1: Point = [segment.cx1, segment.cy1];
      const p2: Point = [segment.cx2, segment.cy2];
      const p3: Point = [segment.x, segment.y];
      const steps = cubicSteps(p0, p1, p2, p3, tolerance);
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        points.push(cubicPoint(p0, p1, p2, p3, t));
      }
      current = p3;
    } else if (segment.type === 'Z') {
      finish(true);
    }
  }
  finish(false);
  return subpaths;
}

function cubicPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]
  ];
}

function quadSteps(p0: Point, p1: Point, p2: Point, tolerance: number): number {
  const dx = p0[0] - 2 * p1[0] + p2[0];
  const dy = p0[1] - 2 * p1[1] + p2[1];
  const error = Math.hypot(dx, dy) / 4;
  if (error <= tolerance) return 1;
  return Math.max(1, Math.min(64, Math.ceil(Math.sqrt(error / tolerance))));
}

function cubicSteps(p0: Point, p1: Point, p2: Point, p3: Point, tolerance: number): number {
  const dx = p0[0] - 3 * p1[0] + 3 * p2[0] - p3[0];
  const dy = p0[1] - 3 * p1[1] + 3 * p2[1] - p3[1];
  const error = Math.hypot(dx, dy) / 6;
  if (error <= tolerance) return 1;
  return Math.max(1, Math.min(80, Math.ceil(Math.sqrt(error / tolerance))));
}

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i]![0];
    const yi = polygon[i]![1];
    const xj = polygon[j]![0];
    const yj = polygon[j]![1];
    const intersects =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Nonzero fill rule over flattened subpaths (matches the editor/exporter default). */
export function pointInPath(point: Point, subpaths: FlatSubpath[]): boolean {
  let winding = 0;
  for (const sub of subpaths) {
    if (!sub.closed) continue;
    for (let i = 0, j = sub.points.length - 1; i < sub.points.length; j = i++) {
      const a = sub.points[j]!;
      const b = sub.points[i]!;
      if (a[1] <= point[1] && b[1] > point[1]) {
        const cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
        if (cross > 0) winding += 1;
      } else if (a[1] > point[1] && b[1] <= point[1]) {
        const cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
        if (cross < 0) winding -= 1;
      }
    }
  }
  return winding !== 0;
}

export function distancePointSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function distanceToPath(point: Point, subpaths: FlatSubpath[]): number {
  let best = Infinity;
  for (const sub of subpaths) {
    const pts = sub.points;
    const limit = sub.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < limit; i += 1) {
      best = Math.min(best, distancePointSegment(point, pts[i]!, pts[(i + 1) % pts.length]!));
    }
  }
  return best;
}

/** [r,g,b,a] straight alpha in 0..1. Returns null for transparent fills/strokes. */
export function parseColor(value: string): [number, number, number] | null {
  if (value === 'transparent' || value === '') return null;
  const text = value.trim().toLowerCase();
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const rgb = text.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const parts = rgb[1]!.split(',').map((p) => p.trim());
    return [Number(parts[0]) / 255, Number(parts[1]) / 255, Number(parts[2]) / 255];
  }
  return [0, 0, 0];
}

export interface FlatStyle {
  fill: [number, number, number] | null;
  stroke: [number, number, number] | null;
  strokeWidth: number;
  opacity: number;
}

export function flattenStyle(style: StyleSpec): FlatStyle {
  return {
    fill: parseColor(style.fill),
    stroke: parseColor(style.stroke),
    strokeWidth: style.strokeWidth,
    opacity: Math.max(0, Math.min(1, style.opacity))
  };
}

export function invertMatrix(m: mat3): mat3 {
  const a = m[0];
  const b = m[1];
  const c = m[3];
  const d = m[4];
  const e = m[6];
  const f = m[7];
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return m;
  const out = new Float32Array(9);
  out[0] = d / det;
  out[1] = -b / det;
  out[2] = 0;
  out[3] = -c / det;
  out[4] = a / det;
  out[5] = 0;
  out[6] = (c * f - d * e) / det;
  out[7] = (b * e - a * f) / det;
  out[8] = 1;
  return out as mat3;
}

export function applyMatrix(m: mat3, p: Point): Point {
  return transformPoint(m, p[0], p[1]);
}

/**
 * Reduce a world point by the translation lattice into the rectangular supercell
 * [0,width)×[0,height). Returns lattice indices (n,m) actually used plus the reduced point.
 * Searching nearby primitive copies mirrors render.translationRange and handles oblique
 * (triangular/centered) lattices where coordinate-wise modulo is wrong.
 */
export function wrapIntoSupercell(
  geom: TileGeometry,
  point: Point
): { point: Point; n: number; m: number } {
  const [[ax, ay], [bx, by]] = latticeVectors(geom.group, geom.cellW, geom.cellH);
  const det = ax * by - ay * bx;
  const s = (by * point[0] - bx * point[1]) / det;
  const t = (-ay * point[0] + ax * point[1]) / det;
  for (let dn = -2; dn <= 2; dn += 1) {
    for (let dm = -2; dm <= 2; dm += 1) {
      const n = Math.round(s) + dn;
      const m = Math.round(t) + dm;
      const qx = point[0] - n * ax - m * bx;
      const qy = point[1] - n * ay - m * by;
      if (qx >= -1e-6 && qx < geom.width - 1e-6 && qy >= -1e-6 && qy < geom.height - 1e-6) {
        return { point: [qx, qy], n, m };
      }
    }
  }
  return { point: [((point[0] % geom.width) + geom.width) % geom.width, ((point[1] % geom.height) + geom.height) % geom.height], n: Math.round(s), m: Math.round(t) };
}

/** Segment of an infinite lattice line (a-edge or b-edge family) inside the supercell rectangle. */
export function clipLineToRect(
  anchor: Point,
  direction: Point,
  width: number,
  height: number,
  pad = 1e-4
): { from: Point; to: Point } | null {
  // Liang–Barsky
  let t0 = -Infinity;
  let t1 = Infinity;
  const p = [-direction[0], direction[0], -direction[1], direction[1]];
  const q = [anchor[0] - pad, width - pad - anchor[0], anchor[1] - pad, height - pad - anchor[1]];
  for (let i = 0; i < 4; i += 1) {
    const pi = p[i]!;
    const qi = q[i]!;
    if (Math.abs(pi) < 1e-12) {
      if (qi < 0) return null;
    } else {
      const ratio = qi / pi;
      if (pi < 0) t0 = Math.max(t0, ratio);
      else t1 = Math.min(t1, ratio);
    }
  }
  if (t0 > t1 || t1 === -Infinity || t0 === Infinity) return null;
  if (!Number.isFinite(t0)) t0 = -Math.max(width, height);
  if (!Number.isFinite(t1)) t1 = Math.max(width, height);
  return {
    from: [anchor[0] + t0 * direction[0], anchor[1] + t0 * direction[1]],
    to: [anchor[0] + t1 * direction[0], anchor[1] + t1 * direction[1]]
  };
}

export function lerp(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export function subtract(a: Point, b: Point): Point {
  return [a[0] - b[0], a[1] - b[1]];
}

export function add(a: Point, b: Point): Point {
  return [a[0] + b[0], a[1] + b[1]];
}

export function scale(p: Point, k: number): Point {
  return [p[0] * k, p[1] * k];
}

export function normalize(p: Point): Point {
  const length = Math.hypot(p[0], p[1]) || 1;
  return [p[0] / length, p[1] / length];
}

import type { Point } from '../types';

export type AuditStatus = 'running' | 'passed' | 'failed' | 'stale' | 'error';
export type BoundaryKind = 'wrap-x' | 'wrap-y' | 'primitive-a' | 'primitive-b';

/** One mismatching sample point on a boundary, in supercell world coordinates. */
export interface MismatchPoint {
  /** Pixel coordinate of the A sample in the audit canvas. */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Point on the A side of the paired boundary. */
  a: Point;
  /** Paired point on the B side (the independent orbit image across the seam). */
  b: Point;
  /** Premultiplied color difference, 0..1020 (max distance across RGBA). */
  colorDelta: number;
  /** Geometric coverage difference, 0..255. */
  geometryDelta: number;
}

/** A connected region of mismatching samples; UI draws this as a clickable hot zone. */
export interface MismatchCluster {
  /** Centroid of the region in supercell world coordinates. */
  point: Point;
  /** World-space bounding rectangle of the hot zone. */
  bounds: { x: number; y: number; w: number; h: number };
  /** Radius from centroid to the farthest member, in world units. */
  radius: number;
  pixelCount: number;
  maxColorDelta: number;
  maxGeometryDelta: number;
  /** Source object that owns the geometry mismatch, if attributable. */
  objectId: string | null;
  objectName: string | null;
  /** Concrete orbit image of that object, objectId@coset:n,m. */
  instance: string | null;
}

export interface BoundaryResult {
  kind: BoundaryKind;
  label: string;
  /** Translation that identifies the paired boundary, in supercell world units. */
  translation: Point;
  /** Polyline describing the boundary geometry, in supercell world coordinates. */
  geometry: Point[];
  passed: boolean;
  sampled: number;
  mismatchCount: number;
  mismatchRatio: number;
  maxColorDelta: number;
  maxGeometryDelta: number;
  clusters: MismatchCluster[];
}

export interface SeamReport {
  status: Extract<AuditStatus, 'passed' | 'failed'>;
  fingerprint: string;
  /** Content epoch captured when the run started. */
  epoch: number;
  runId: number;
  group: string;
  cellWidth: number;
  cellHeight: number;
  supercell: { width: number; height: number; repeats: [number, number] };
  scale: number;
  startedAt: number;
  finishedAt: number;
  boundaries: BoundaryResult[];
}

export interface AuditRecord {
  /** `${projectId}` — at most one stored audit per project. */
  id: string;
  projectId: string;
  fingerprint: string;
  epoch: number;
  status: AuditStatus;
  startedAt: number;
  finishedAt: number | null;
  report: SeamReport | null;
  error: string | null;
}

/** Snapshot captured when a run starts; used to reject late results. */
export interface AuditToken {
  runId: number;
  projectId: string;
  fingerprint: string;
  epoch: number;
}

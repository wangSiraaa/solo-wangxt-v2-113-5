import type { GroupId, Point } from '../../types';

export type AuditStatus = 'running' | 'passed' | 'failed' | 'stale' | 'error';

/** Premultiplied RGBA in 0..1. */
export type RGBA = [number, number, number, number];

export interface AuditSample {
  /** Station point on the boundary line (world coordinates). */
  x: number;
  y: number;
  /** Side A / side B premultiplied colors. */
  a: RGBA;
  b: RGBA;
  /** Max channel difference, 0..1. */
  delta: number;
  /** Alpha coverage difference, 0..1. */
  geometricDelta: number;
  /** Premultiplied RGB difference, 0..1. */
  colorDelta: number;
}

export interface AuditContributor {
  objectId: string;
  objectName: string;
  /** Concrete transformed image, e.g. objectId@coset:n,m. */
  instance: string;
  side: 'a' | 'b' | 'both';
}

export interface AuditBoundary {
  id: string;
  kind: 'translation' | 'oblique';
  label: string;
  /** Unit direction of the boundary line in world space. */
  direction: Point;
  /** Sampled segment endpoints in world coordinates. */
  from: Point;
  to: Point;
  stationCount: number;
  mismatchCount: number;
  mismatchRatio: number;
  maxDelta: number;
  maxGeometricDelta: number;
  maxColorDelta: number;
  /** Segment [from,to] along the line covering every mismatching station. */
  mismatchRange: { from: Point; to: Point } | null;
  /** Mismatching samples, capped and spread along the boundary for the heat map. */
  samples: AuditSample[];
  /** Source objects and concrete images responsible for the mismatch. */
  contributors: AuditContributor[];
  passed: boolean;
}

export interface SupercellInfo {
  width: number;
  height: number;
  repeats: [number, number];
}

export type TerminalAuditStatus = 'passed' | 'failed' | 'error';

export interface SeamAuditReport {
  schemaVersion: number;
  projectId: string;
  projectName: string;
  fingerprint: string;
  group: GroupId;
  cellWidth: number;
  cellHeight: number;
  supercell: SupercellInfo;
  scale: number;
  startedAt: number;
  finishedAt: number;
  status: TerminalAuditStatus;
  error?: string;
  boundaries: AuditBoundary[];
}

export interface AuditState {
  status: AuditStatus;
  report: SeamAuditReport | null;
  fingerprint: string | null;
  startedAt: number | null;
  message?: string;
}

/** A concrete object image that paints near a queried point. */
export interface ContributorHit {
  objectId: string;
  objectName: string;
  coset: number;
  n: number;
  m: number;
}

/**
 * Sampler over the final composite. Both the browser Canvas 2D implementation and
 * the dependency-free software implementation used by the headless acceptance script
 * share the same paint-job enumeration, clipping and premultiplied compositing rules.
 */
export interface SeamSampler {
  /** Premultiplied color, averaged over `radius` world units. Coordinates wrap modulo the supercell. */
  sample(x: number, y: number, radius?: number): RGBA;
  /** Source object images that cover (or stroke within jitter of) a world point. */
  contributorsAt(x: number, y: number, radius: number): ContributorHit[];
}

export type SamplerFactory = (project: import('../../types').Project, geom: import('./composite').TileGeometry) => SeamSampler;

/**
 * Sampler for the exported rectangular tile. The browser implementation reads the exact
 * PNG pixels (wrapped); the software implementation reproduces that composite headlessly.
 */
export type TileSamplerFactory = SamplerFactory;

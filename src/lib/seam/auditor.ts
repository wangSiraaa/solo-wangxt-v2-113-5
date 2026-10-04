import type { Point, Project } from '../../types';
import { contentFingerprint, AUDIT_SCHEMA_VERSION } from './fingerprint';
import { tileGeometry } from './composite';
import { boundarySpecs, sidePoints, type BoundarySpec } from './boundaries';
import { lerp } from './geometry';
import { createSoftwareSampler } from './softwareSampler';
import type {
  AuditBoundary,
  AuditContributor,
  AuditSample,
  ContributorHit,
  RGBA,
  SamplerFactory,
  SeamAuditReport,
  SeamSampler
} from './types';

export interface AuditOptions {
  /** Browser audits pass the Canvas-backed factory; headless scripts use the software one. */
  samplerFactory?: SamplerFactory;
  /** Separate factory for the PNG tile (defaults to the software tile sampler). */
  tileSamplerFactory?: SamplerFactory;
  /** Yield to the event loop between chunks; injectable for tests. */
  yieldToEventLoop?: () => Promise<void>;
  isCancelled?: () => boolean;
}

// Side points are half a world unit from the seam; the sampler footprint is small enough
// not to straddle it. Tolerances absorb Canvas antialiasing and curve flattening.
const DEPTH = 0.55;
const RADIUS = 1.0;
const MAX_ALPHA_DELTA = 0.1;
const MAX_COLOR_DELTA = 0.12;
// Up to 4% of stations may sit on antialiased fringes; a genuinely moved path fails far
// more stations than this across a continuous run.
const MAX_MISMATCH_RATIO = 0.04;

function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function runSeamAudit(project: Project, options: AuditOptions = {}): Promise<SeamAuditReport> {
  const fingerprint = contentFingerprint(project);
  const geom = tileGeometry(project);
  const factory =
    options.samplerFactory ?? ((p: Project) => createSoftwareSampler(p, { mode: 'tile' }));
  const infinite = createSoftwareSampler(project, { mode: 'infinite' });
  const tile = factory(project, geom);
  const specs = boundarySpecs(geom);
  const yieldTo = options.yieldToEventLoop ?? yieldMacrotask;
  const isCancelled = options.isCancelled ?? (() => false);
  const startedAt = Date.now();

  async function work(): Promise<SeamAuditReport> {
    const boundaries: AuditBoundary[] = [];
    for (const spec of specs) {
      boundaries.push(
        await auditBoundary(spec, tile, infinite, geom.width, geom.height, yieldTo, isCancelled)
      );
    }
    boundaries.push(auditExportConsistency(infinite, tile, geom.width, geom.height));
    const failed = boundaries.some((b) => !b.passed);
    return {
      schemaVersion: AUDIT_SCHEMA_VERSION,
      projectId: project.id,
      projectName: project.name,
      fingerprint,
      group: project.group,
      cellWidth: project.cellWidth,
      cellHeight: project.cellHeight,
      supercell: { width: geom.width, height: geom.height, repeats: geom.repeats },
      scale: 1,
      startedAt,
      finishedAt: Date.now(),
      status: failed ? 'failed' : 'passed',
      boundaries
    };
  }

  return work();
}

async function auditBoundary(
  spec: BoundarySpec,
  tile: SeamSampler,
  infinite: SeamSampler,
  width: number,
  height: number,
  yieldTo: () => Promise<void>,
  isCancelled: () => boolean
): Promise<AuditBoundary> {
  const length = Math.hypot(spec.to[0] - spec.from[0], spec.to[1] - spec.from[1]);
  // Scale station count with edge length relative to a representative cell dimension.
  const cellRef = Math.max(width, height) / 2;
  const stationCount = Math.max(14, Math.round((length / cellRef) * 60));
  const samples: AuditSample[] = [];
  const contributors = new Map<string, AuditContributor>();
  let maxDelta = 0;
  let maxGeometric = 0;
  let maxColor = 0;
  let firstBad: Point | null = null;
  let lastBad: Point | null = null;
  let badRun = 0;
  let longestRun = 0;

  for (let i = 0; i < stationCount; i += 1) {
    if ((i & 15) === 0) {
      await yieldTo();
      if (isCancelled()) throw new Error('cancelled');
    }
    const t = (i + 0.5) / stationCount;
    const station = lerp(spec.from, spec.to, t);
    const { a: pa, b: pb } = sidePoints(spec, station, DEPTH);
    let aWorld = pa;
    let bWorld = pb;
    if (spec.wrap) {
      // Translation edge: read the glued counterpart from the opposite side of the tile.
      aWorld = wrapPoint(pa, width, height);
      bWorld = wrapPoint(pb, width, height);
    }
    const ca = tile.sample(aWorld[0], aWorld[1], RADIUS);
    const cb = tile.sample(bWorld[0], bWorld[1], RADIUS);
    const geometricDelta = Math.abs(ca[3] - cb[3]);
    const colorDelta = Math.max(Math.abs(ca[0] - cb[0]), Math.abs(ca[1] - cb[1]), Math.abs(ca[2] - cb[2]));
    const delta = Math.max(geometricDelta, colorDelta);
    const bad = geometricDelta > MAX_ALPHA_DELTA || colorDelta > MAX_COLOR_DELTA;
    if (bad) {
      badRun += 1;
      longestRun = Math.max(longestRun, badRun);
      if (!firstBad) firstBad = station;
      lastBad = station;
      // Contributor lookup uses the genuine infinite composite, which can resolve the
      // periodic copy just outside the rectangle for oblique-edge hot zones.
      collectContributors(infinite, pa, pb, contributors);
      samples.push({ x: station[0], y: station[1], a: ca, b: cb, delta, geometricDelta, colorDelta });
    } else {
      badRun = 0;
    }
    maxDelta = Math.max(maxDelta, delta);
    maxGeometric = Math.max(maxGeometric, geometricDelta);
    maxColor = Math.max(maxColor, colorDelta);
  }

  const mismatchCount = samples.length;
  const mismatchRatio = mismatchCount / stationCount;
  const passed = mismatchRatio <= MAX_MISMATCH_RATIO && longestRun <= 2;
  return {
    id: spec.id,
    kind: spec.kind,
    label: spec.label,
    direction: spec.direction,
    from: spec.from,
    to: spec.to,
    stationCount,
    mismatchCount,
    mismatchRatio,
    maxDelta,
    maxGeometricDelta: maxGeometric,
    maxColorDelta: maxColor,
    mismatchRange: firstBad && lastBad ? { from: firstBad, to: lastBad } : null,
    samples: samples.slice(0, 80),
    contributors: [...contributors.values()].slice(0, 30),
    passed
  };
}

function wrapPoint(p: Point, width: number, height: number): Point {
  return [((p[0] % width) + width) % width, ((p[1] % height) + height) % height];
}

function collectContributors(
  sampler: SeamSampler,
  pa: Point,
  pb: Point,
  output: Map<string, AuditContributor>
) {
  const radius = 1.6;
  const aHits = sampler.contributorsAt(pa[0], pa[1], radius);
  const bHits = sampler.contributorsAt(pb[0], pb[1], radius);
  const aKeys = new Set(aHits.map(hitKey));
  const bKeys = new Set(bHits.map(hitKey));
  const add = (hit: ContributorHit, side: 'a' | 'b' | 'both') => {
    const key = `${hit.objectId}:${hit.coset}:${hit.n},${hit.m}`;
    const existing = output.get(key);
    if (existing) {
      if (existing.side !== side) existing.side = 'both';
      return;
    }
    output.set(key, {
      objectId: hit.objectId,
      objectName: hit.objectName,
      instance: `${hit.objectId}@${hit.coset}:${hit.n},${hit.m}`,
      side
    });
  };
  for (const hit of aHits) add(hit, bKeys.has(hitKey(hit)) ? 'both' : 'a');
  for (const hit of bHits) if (!aKeys.has(hitKey(hit))) add(hit, 'b');
}

function hitKey(hit: ContributorHit): string {
  return `${hit.objectId}:${hit.coset}:${hit.n},${hit.m}`;
}

const CONSISTENCY_PROBES = 200;

/**
 * Export consistency: the wrapped PNG supercell must reproduce the infinite periodic
 * composite (geometry coverage and premultiplied color) at interior probes. This is what
 * the existing 3×3 repeat preview shows; the audit measures it instead of trusting pixels.
 */
function auditExportConsistency(
  infinite: SeamSampler,
  tile: SeamSampler,
  width: number,
  height: number
): AuditBoundary {
  const samples: AuditSample[] = [];
  const contributors = new Map<string, AuditContributor>();
  let maxGeometric = 0;
  let maxColor = 0;
  let firstBad: Point | null = null;
  let lastBad: Point | null = null;

  for (let i = 0; i < CONSISTENCY_PROBES; i += 1) {
    const gx = (0.03 + (((i * 0.61803398875) % 1) * 0.94)) * width;
    const gy = (0.03 + (((i * 0.41421356237) % 1) * 0.94)) * height;
    const ideal = infinite.sample(gx, gy, 0.9);
    const actual = tile.sample(gx, gy, 0.9);
    const geometricDelta = Math.abs(ideal[3] - actual[3]);
    const colorDelta = Math.max(
      Math.abs(ideal[0] - actual[0]),
      Math.abs(ideal[1] - actual[1]),
      Math.abs(ideal[2] - actual[2])
    );
    if (geometricDelta > 0.08 || colorDelta > 0.1) {
      if (!firstBad) firstBad = [gx, gy];
      lastBad = [gx, gy];
      samples.push({
        x: gx,
        y: gy,
        a: ideal,
        b: actual,
        delta: Math.max(geometricDelta, colorDelta),
        geometricDelta,
        colorDelta
      });
      collectContributors(infinite, [gx, gy], [gx + 0.5, gy + 0.5], contributors);
    }
    maxGeometric = Math.max(maxGeometric, geometricDelta);
    maxColor = Math.max(maxColor, colorDelta);
  }

  return {
    id: 'export-consistency',
    kind: 'translation',
    label: '导出一致性：PNG 超级周期与无限周期最终合成（与 3×3 重复预览同源）',
    direction: [1, 0],
    from: [0, 0],
    to: [width, height],
    stationCount: CONSISTENCY_PROBES,
    mismatchCount: samples.length,
    mismatchRatio: samples.length / CONSISTENCY_PROBES,
    maxDelta: Math.max(maxGeometric, maxColor),
    maxGeometricDelta: maxGeometric,
    maxColorDelta: maxColor,
    mismatchRange: firstBad && lastBad ? { from: firstBad, to: lastBad } : null,
    samples: samples.slice(0, 40),
    contributors: [...contributors.values()].slice(0, 20),
    passed: samples.length / CONSISTENCY_PROBES <= 0.03
  };
}

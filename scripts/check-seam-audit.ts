/**
 * Headless acceptance checks for the geometry-consistent seam audit.
 * Run with: npm run test:seam
 *
 * Covers the four acceptance cases:
 *   1. p1 sample with a transparent stroke crossing the paired left/right edges passes
 *      and agrees with the exported periodic tile;
 *   2. moving only one side of that path fails the paired boundary, with the unique
 *      source object and concrete boundary difference reported;
 *   3. p6m sample passes on the oblique supercell tessellation boundaries (not only the
 *      horizontal/vertical outer frame);
 *   4. edit→undo / refresh while an audit is in flight discards (stale) the late result;
 *      re-auditing passes; old-schema / foreign-fingerprint records never forge a pass.
 */
import { p1SeamSample, p6mSample } from '../src/lib/samples.ts';
import { runSeamAudit } from '../src/lib/seam/auditor.ts';
import { createSoftwareSampler } from '../src/lib/seam/softwareSampler.ts';
import { tileGeometry, enumeratePaintJobs } from '../src/lib/seam/composite.ts';
import { boundarySpecs } from '../src/lib/seam/boundaries.ts';
import { SeamAuditController } from '../src/lib/seam/controller.ts';
import { AUDIT_SCHEMA_VERSION } from '../src/lib/seam/fingerprint.ts';
import {
  applyMatrix,
  distanceToPath,
  flattenPath,
  flattenStyle,
  invertMatrix,
  pointInPath,
  pointInPolygon
} from '../src/lib/seam/geometry.ts';
import type { Point } from '../src/types.ts';
import type { ContributorHit, RGBA, SeamAuditReport, SeamSampler } from '../src/lib/seam/types.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const immediate = () => Promise.resolve();
async function audit(project: Project): Promise<SeamAuditReport> {
  return runSeamAudit(project, {
    yieldToEventLoop: immediate,
    samplerFactory: (p) => createSoftwareSampler(p, { mode: 'tile' }),
    tileSamplerFactory: (p) => createSoftwareSampler(p, { mode: 'tile' })
  });
}

function clone(project: Project): Project {
  return structuredClone(project);
}

/**
 * Simulate an exporter bug: one concrete matrix image (coset/copy) is not painted. The
 * rectangular outer frame stays intact, so a frame-only check cannot see it; the missing
 * image borders an interior oblique tessellation edge which must fail.
 */
function samplerWithoutImage(project: Project, dropCoset: number, dropN: number, dropM: number): SeamSampler {
  const geom = tileGeometry(project);
  const jobs = enumeratePaintJobs(project, geom).filter(
    (j) => !(j.coset === dropCoset && j.n === dropN && j.m === dropM)
  );
  const prepared = project.objects.map((o) => ({ style: flattenStyle(o), sub: flattenPath(o.path) }));
  const inv = jobs.map((j) => invertMatrix(j.matrix));
  const at = (x: number, y: number): RGBA => {
    if (x < -1e-7 || y < -1e-7 || x > geom.width + 1e-7 || y > geom.height + 1e-7) return [0, 0, 0, 0];
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let i = 0; i < jobs.length; i += 1) {
      const job = jobs[i]!;
      const q: Point = applyMatrix(inv[i]!, [x, y]);
      if (!pointInPolygon(q, geom.domain)) continue;
      const o = prepared[job.objectIndex]!;
      let sa = 0;
      let col: [number, number, number] = [0, 0, 0];
      if (o.style.fill && pointInPath(q, o.sub)) {
        sa = 1;
        col = o.style.fill;
      }
      if (o.style.stroke && o.style.strokeWidth > 0 && distanceToPath(q, o.sub) <= o.style.strokeWidth / 2) {
        sa = 1;
        col = o.style.stroke;
      }
      if (!sa) continue;
      const over = sa * o.style.opacity * (1 - a);
      r += col[0] * over;
      g += col[1] * over;
      b += col[2] * over;
      a += over;
    }
    return [r, g, b, a];
  };
  const inner = createSoftwareSampler(project, { mode: 'tile' });
  return {
    sample(x, y, radius = 1): RGBA {
      let rr = 0;
      let gg = 0;
      let bb = 0;
      let aa = 0;
      let c = 0;
      for (let i = 0; i < 3; i += 1) {
        for (let j = 0; j < 3; j += 1) {
          const fx = ((i + 0.5) / 3 - 0.5) * 2 * radius;
          const fy = ((j + 0.5) / 3 - 0.5) * 2 * radius;
          const v = at(x + fx, y + fy);
          rr += v[0];
          gg += v[1];
          bb += v[2];
          aa += v[3];
          c += 1;
        }
      }
      return [rr / c, gg / c, bb / c, aa / c];
    },
    contributorsAt(x: number, y: number, radius = 2.2): ContributorHit[] {
      return inner.contributorsAt(x, y, radius);
    }
  };
}

async function main() {
  // ── Case 1: p1 transparent stroke bridging the paired left/right edges ──────────
  const p1 = p1SeamSample();
  const report1 = await audit(p1);
  const outer = report1.boundaries.find((b) => b.id === 'outer-left-right');
  const consistency = report1.boundaries.find((b) => b.id === 'export-consistency');
  check('① p1 接缝样例整体通过', report1.status === 'passed', `status=${report1.status}`);
  check(
    '① p1 左右平移边界通过（透明描边跨边界）',
    !!outer && outer.passed,
    outer ? `mismatch=${outer.mismatchCount}/${outer.stationCount}` : 'boundary missing'
  );
  check(
    '① 审计与 PNG 导出（tile）最终合成一致',
    !!consistency && consistency.passed,
    consistency
      ? `tile/infinite mismatches=${consistency.mismatchCount}/${consistency.stationCount}`
      : 'consistency missing'
  );

  // ── Case 2: move only the LEFT end of the crossing path ─────────────────────────
  const broken = clone(p1);
  const wave = broken.objects.find((o) => o.name === '越界透明波浪')!;
  // Raise the left anchor and its tangent control point; the right end (x≈286) is
  // untouched, so the left/right paired edge can no longer match.
  const first = wave.path[0]!;
  const ctrl = wave.path[1]!;
  if (first.type === 'M') first.y += 34;
  if (ctrl.type === 'C') ctrl.cy1 -= 26;

  const report2 = await audit(broken);
  const failedEdge = report2.boundaries.find((b) => b.id === 'outer-left-right');
  check('② 移动一侧路径后审计失败', report2.status === 'failed');
  check(
    '② 失败定位到左右配对边界并给出差异范围',
    !!failedEdge && !failedEdge.passed && !!failedEdge.mismatchRange,
    failedEdge
      ? `mismatch=${failedEdge.mismatchCount}/${failedEdge.stationCount} maxAlpha=${failedEdge.maxGeometricDelta.toFixed(2)}`
      : 'no failed edge'
  );
  const objectIds = new Set(failedEdge?.contributors.map((c) => c.objectId));
  check(
    '② 差异关联到唯一源对象',
    objectIds.size === 1 && objectIds.has(wave.id),
    `objects=${[...objectIds].join(',') || 'none'}`
  );
  check(
    '② 列出具体实例（两侧周期副本）',
    (failedEdge?.contributors.length ?? 0) >= 2 &&
      failedEdge!.contributors.some((c) => c.instance.includes(':0,0')) &&
      failedEdge!.contributors.some((c) => c.instance.includes(':-1,0')),
    failedEdge?.contributors.map((c) => `${c.instance}(${c.side})`).join(' ')
  );

  // Restore: the unmodified content must pass again.
  check('② 恢复路径后重新审计通过', (await audit(p1)).status === 'passed');

  // ── Case 3: p6m oblique supercell boundaries ────────────────────────────────────
  const p6m = p6mSample();
  const geom = tileGeometry(p6m);
  const specKinds = boundarySpecs(geom);
  const obliqueSpecs = specKinds.filter((b) => b.kind === 'oblique');
  check(
    '③ p6m 超级周期枚举到斜向镶嵌边界（非仅水平/竖直外框）',
    obliqueSpecs.length >= 6,
    `oblique=${obliqueSpecs.length}`
  );
  const report3 = await audit(p6m);
  const obliqueResults = report3.boundaries.filter((b) => b.kind === 'oblique');
  const obliqueBad = obliqueResults.filter((b) => !b.passed);
  const outerBad = report3.boundaries.filter((b) => b.kind === 'translation' && !b.passed);
  check(
    '③ p6m 斜向边界全部通过',
    obliqueResults.length > 0 && obliqueBad.length === 0,
    obliqueResults.length
      ? `oblique=${obliqueResults.length}, bad=${obliqueBad.length}`
      : 'no oblique boundary audited'
  );
  check('③ p6m 平移外框与导出一致性通过', outerBad.length === 0, `bad=${outerBad.length}`);
  check('③ p6m 样例审计整体通过', report3.status === 'passed', `status=${report3.status}`);

  // ③b. Dropping one matrix image keeps the rectangular frame valid but breaks an
  // interior oblique edge — exactly the defect a horizontal/vertical-only check misses.
  const brokenSampler = samplerWithoutImage(p6m, 7, 1, 0);
  const report3b = await runSeamAudit(p6m, {
    yieldToEventLoop: immediate,
    samplerFactory: () => brokenSampler,
    tileSamplerFactory: () => brokenSampler
  });
  const oblique3b = report3b.boundaries.filter((b) => b.kind === 'oblique' && !b.passed);
  const outer3b = report3b.boundaries.filter((b) => b.id.startsWith('outer') && !b.passed);
  check(
    '③ 漏掉一个矩阵像时斜向边界失败（只测矩形外框会误报通过）',
    report3b.status === 'failed' && oblique3b.length > 0 && outer3b.length === 0,
    `obliqueBad=${oblique3b.length} outerBad=${outer3b.length}`
  );

  // ── Case 4: stale late results, undo, refresh, old migrations ────────────────────
  // 4a. A run superseded by edit then undo must never certify the new/returned content.
  const controller = new SeamAuditController(p1);
  let release: (() => void) | null = null;
  const gate = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  let runnerEntered = 0;
  const running = controller.start(p1, (current, controls) => {
    runnerEntered += 1;
    return runSeamAudit(current, {
      isCancelled: controls.isCancelled,
      yieldToEventLoop: gate
    });
  });
  await Promise.resolve();
  await Promise.resolve();
  check('④ 审计处于运行中', controller.state.status === 'running', controller.state.status);

  // Edit, then undo (content returns byte-identical): epoch advances twice anyway.
  controller.contentChanged(broken);
  controller.contentChanged(p1);
  check('④ 编辑后撤销，状态为过期而非通过', controller.state.status === 'stale');
  release!();
  await running.catch(() => undefined);
  check('④ 迟到结果被丢弃，仍为过期', controller.state.status === 'stale');
  check('④ 迟到结果未写入报告', controller.state.report === null);

  // Re-audit current content: now it passes.
  await controller.start(p1, (current, controls) =>
    runSeamAudit(current, { isCancelled: controls.isCancelled, yieldToEventLoop: immediate })
  );
  check('④ 重新审计后通过', controller.state.status === 'passed');

  // 4b. Refresh: a stored "running" row from a closed tab hydrates as stale.
  const refreshed = new SeamAuditController(p1);
  refreshed.hydrate(
    {
      status: 'running',
      startedAt: Date.now(),
      report: null,
      schemaVersion: AUDIT_SCHEMA_VERSION
    },
    AUDIT_SCHEMA_VERSION
  );
  check('④ 刷新后未完成(running)记录变为过期', refreshed.state.status === 'stale');

  // 4c. Old project migration: older schema must never restore a passing verdict.
  const migrated = new SeamAuditController(p1);
  migrated.hydrate(
    {
      status: 'passed',
      startedAt: Date.now(),
      report: { ...(controller.state.report as SeamAuditReport), schemaVersion: 0 },
      schemaVersion: 0
    },
    AUDIT_SCHEMA_VERSION
  );
  check('④ 旧版本审计记录迁移后不能伪造通过', migrated.state.status === 'stale');

  // 4d. A pass recorded for different content (fingerprint mismatch) is rejected.
  const foreign = new SeamAuditController(broken);
  foreign.hydrate(
    {
      status: 'passed',
      startedAt: Date.now(),
      report: controller.state.report as SeamAuditReport,
      schemaVersion: AUDIT_SCHEMA_VERSION
    },
    AUDIT_SCHEMA_VERSION
  );
  check('④ 指纹不匹配的通过记录按过期处理', foreign.state.status === 'stale');

  // 4e. Matching current-schema pass is adopted after refresh.
  const reload = new SeamAuditController(p1);
  reload.hydrate(
    {
      status: 'passed',
      startedAt: Date.now(),
      report: controller.state.report as SeamAuditReport,
      schemaVersion: AUDIT_SCHEMA_VERSION
    },
    AUDIT_SCHEMA_VERSION
  );
  check('④ 同指纹同版本记录刷新后恢复通过', reload.state.status === 'passed');

  // 4f. Persistence guard: a superseded late result resolves to null, so the persistence
  // layer (which only writes non-null accepted reports) cannot store it and later revive
  // it as a pass after edit→undo/refresh.
  const guarded = new SeamAuditController(p1);
  let resolveLate: ((r: SeamAuditReport) => void) | null = null;
  const latePromise = new Promise<SeamAuditReport>((resolve) => {
    resolveLate = resolve;
  });
  const accepted = guarded.start(p1, () => latePromise);
  guarded.contentChanged(broken); // edit
  guarded.contentChanged(p1); // then undo, back to identical bytes
  const passingReport = controller.state.report as SeamAuditReport;
  resolveLate!(passingReport);
  const acceptedReport = await accepted;
  check('④ 被取代的迟到报告不被接受（返回 null，不得持久化）', acceptedReport === null);
  check('④ 内容保持过期', guarded.state.status === 'stale');

  check('④ 审计运行器确实执行过', runnerEntered >= 1, `runs=${runnerEntered}`);

  console.log(failures === 0 ? '\n全部接缝验收通过' : `\n${failures} 项验收失败`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

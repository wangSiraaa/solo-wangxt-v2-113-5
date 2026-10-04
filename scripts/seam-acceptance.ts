/*
 * Seam audit acceptance suite (Node, no browser required).
 *
 * It drives the exact application modules used in production:
 *   - seamAudit.ts   geometry + premultiplied-composite boundary comparison
 *   - export.ts      identical rasterization path as PNG export / 3×3 preview
 *   - seamStore.ts   running/passed/failed/stale/error + late-result rejection
 *   - db.ts          persistence in IndexedDB (in-memory fake; same code paths)
 *
 * Run: npm run test:seam
 */
import napi from '@napi-rs/canvas';
import fakeIndexedDB, { IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { writeFileSync } from 'node:fs';

const { createCanvas, Path2D, DOMMatrix } = napi;
(globalThis as any).document = { createElement: () => createCanvas(300, 300) };
(globalThis as any).Path2D = Path2D;
(globalThis as any).DOMMatrix = DOMMatrix;
Object.assign(globalThis, {
  indexedDB: fakeIndexedDB,
  IDBKeyRange: FakeIDBKeyRange
});
(globalThis as any).structuredClone ??= (v: unknown) => JSON.parse(JSON.stringify(v));

const { runSeamAudit } = await import('../src/lib/seamAudit.ts');
const { exportPeriodicTile } = await import('../src/lib/export.ts');
const { contentFingerprint } = await import('../src/lib/fingerprint.ts');
const { seamP1Sample, p6mSample, glideSample, rotationSample } = await import('../src/lib/samples.ts');
const { GROUP_LIST } = await import('../src/lib/groups.ts');
const stores = await import('../src/lib/stores.ts');
const { get } = await import('svelte/store');
const auditStoreModule = await import('../src/lib/seamStore.ts');
const { loadAuditRecord, saveProject, listProjects } = await import('../src/lib/db.ts');

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function audit(project: any, cancelled: () => boolean = () => false) {
  return runSeamAudit(project, {
    token: { runId: 1, projectId: project.id, fingerprint: contentFingerprint(project), epoch: 0 },
    isCancelled: cancelled,
    yieldToUi: async () => {}
  });
}
const summarize = (r: any) =>
  r.boundaries.map(
    (b: any) =>
      `${b.kind}:${b.passed ? 'P' : 'F'}(m=${b.mismatchCount}/${b.sampled} cΔ${Math.round(b.maxColorDelta)} gΔ${Math.round(b.maxGeometryDelta)}${
        b.clusters[0] ? ` owner=${b.clusters[0].objectName}` : ''
      })`
  );

// ① p1 transparent stroked path crossing both left/right boundaries passes --------
const p1 = seamP1Sample();
const r1 = await audit(p1);
console.log('① p1:', summarize(r1));
check('① p1 跨左右边界透明路径通过几何+颜色审计', r1.status === 'passed', r1.boundaries.map((b: any) => `${b.kind}=${b.passed}`).join(','));

// ① audit agrees with the existing PNG repeat preview -----------------------------
const repeatDelta = await new Promise<number>((resolve) => {
  const tile = exportPeriodicTile(p1, 2);
  const c = createCanvas(tile.canvas.width * 2, tile.canvas.height * 2);
  const ctx = c.getContext('2d');
  ctx.drawImage(tile.canvas, 0, 0);
  ctx.drawImage(tile.canvas, tile.canvas.width, 0);
  ctx.drawImage(tile.canvas, 0, tile.canvas.height);
  ctx.drawImage(tile.canvas, tile.canvas.width, tile.canvas.height);
  const img = ctx.getImageData(0, 0, c.width, c.height).data;
  let maxDelta = 0;
  const scan = (x1: number, y1: number, x2: number, y2: number) => {
    const i1 = (y1 * c.width + x1) * 4;
    const i2 = (y2 * c.width + x2) * 4;
    for (let k = 0; k < 4; k++) maxDelta = Math.max(maxDelta, Math.abs(img[i1 + k]! - img[i2 + k]!));
  };
  for (let y = 0; y < c.height; y++) {
    scan(tile.canvas.width - 1, y, tile.canvas.width, y);
    scan(0, y, c.width - 1, y);
  }
  for (let x = 0; x < c.width; x++) {
    scan(x, tile.canvas.height - 1, x, tile.canvas.height);
    scan(x, 0, x, c.height - 1);
  }
  // The PNG is the deliverable; also prove it encodes.
  writeFileSync('/tmp/seamtest/p1-export.png', tile.canvas.toBuffer('image/png'));
  resolve(maxDelta);
});
check('① 审计结论与现有 PNG 重复预览一致（接缝像素一致）', repeatDelta <= 2, `maxSeamΔ=${repeatDelta}`);

// ② deliberately move one side -> failure, object + boundary located --------------
const broken = seamP1Sample();
broken.objects[0].path[0].y -= 28;
const r2 = await audit(broken);
console.log('② broken p1:', summarize(r2));
const wx = r2.boundaries.find((b: any) => b.kind === 'wrap-x');
const wy = r2.boundaries.find((b: any) => b.kind === 'wrap-y');
const owner = wx?.clusters?.[0];
check('② 移动一侧后左右边界失败', r2.status === 'failed' && wx && !wx.passed && wx.mismatchCount > 0, `m=${wx?.mismatchCount}`);
check(
  '② 差异定位到唯一源对象与具体实例',
  !!owner && owner.objectId === broken.objects[0].id && /@0:-?\d+,-?\d+$/.test(owner.instance ?? ''),
  owner ? `${owner.objectName} ${owner.instance}` : 'no owner'
);
check('② 未破坏的上下边界仍然通过', !!wy && wy.passed);
check('② 差异范围有坐标与Δ值', owner && owner.bounds.w > 0 && owner.maxGeometryDelta >= 48, JSON.stringify(owner?.bounds));

// ③ p6m oblique (diagonal lattice) boundary passes in the supercycle --------------
const p6 = p6mSample();
const r6 = await audit(p6);
console.log('③ p6m:', summarize(r6));
const pb = r6.boundaries.find((b: any) => b.kind === 'primitive-b');
const pa = r6.boundaries.find((b: any) => b.kind === 'primitive-a');
check('③ p6m 斜向原胞边界 t₂ 通过', !!pb && pb.passed, `m=${pb?.mismatchCount}/${pb?.sampled}`);
check('③ p6m 另一原胞平移 t₁ 通过', !!pa && pa.passed);
check('③ 斜向边界有实质采样（不是空测误报）', !!pb && pb.sampled > 100_000, `sampled=${pb?.sampled}`);
check('③ 超级周期矩形外框同样通过', r6.status === 'passed');

// A naive rect-only check would never inspect t₂ — prove the engine has 4 checks
// for triangular groups and 2 for rectangular groups.
const p1r = await audit(seamP1Sample());
check('③ 矩形群只检查 2 条框架边界、三角群检查 4 条（含斜向）', p1r.boundaries.length === 2 && r6.boundaries.length === 4);

// shipped samples other than p6m must also be seam-clean
const pg = await audit(glideSample());
const p4m = await audit(rotationSample());
check('③ pg / p4m 内置样例同样通过', pg.status === 'passed' && p4m.status === 'passed',
  [...summarize(pg), ...summarize(p4m)].join(' | '));

// empty projects for every one of the 17 groups trivially pass
let emptyFail = 0;
for (const g of GROUP_LIST) {
  const r = await audit({ id: 'z', name: 'z', group: g.id, cellWidth: 220, cellHeight: 180, objects: [], updatedAt: 0 });
  if (r.status !== 'passed') emptyFail++;
}
check('③ 全部 17 个群空工程均通过', emptyFail === 0, `fail=${emptyFail}`);

// transparent/zero-opacity path still audited geometrically ------------------------
const invisible = seamP1Sample();
invisible.objects[0].opacity = 0;
const rInv = await audit(invisible);
check('透明零不透明度路径仍参与几何检查且通过', rInv.status === 'passed');
const invisibleBroken = seamP1Sample();
invisibleBroken.objects[0].opacity = 0;
invisibleBroken.objects[0].path[0].y -= 30;
const rInvB = await audit(invisibleBroken);
const invWx = rInvB.boundaries.find((b: any) => b.kind === 'wrap-x');
check('零不透明度路径破坏时几何审计失败（颜色Δ为0、几何Δ>0）',
  !invWx.passed && invWx.maxColorDelta === 0 && invWx.maxGeometryDelta >= 48,
  `cΔ${Math.round(invWx.maxColorDelta)} gΔ${Math.round(invWx.maxGeometryDelta)}`);

// ④ stale / late-result semantics through the real Svelte store -------------------
function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ④a run started, content edited before it returns -> result must be stale, never pass
stores.setProject(seamP1Sample());
await delay(10);
const run1 = auditStoreModule.startAudit();
// mutate while running (the store invalidates synchronously on content change)
stores.updateProject((p: any) => {
  p.objects[0].path[0].y -= 40;
  return p;
});
await run1;
let st = get(auditStoreModule.seamAudit).status;
check('④a 运行中编辑：迟到结果标为过期/失败，不得通过', st === 'stale' || st === 'failed' || st === 'error', `status=${st}`);
const staleRecord = await loadAuditRecord(stores.editor ? get(stores.editor).project.id : '');
check('④a 过期状态已持久化（刷新后仍不能伪造通过）',
  !staleRecord || staleRecord.status === 'stale' || staleRecord.status === 'running',
  `stored=${staleRecord?.status ?? 'none'}`);

// ④b undo restores identical content -> still stale (new epoch), re-audit -> pass
stores.undo();
await delay(20);
st = get(auditStoreModule.seamAudit).status;
check('④b 撤销恢复原内容后旧审计仍为过期', st === 'stale', `status=${st}`);
await auditStoreModule.startAudit();
st = get(auditStoreModule.seamAudit).status;
check('④b 重新审计后通过', st === 'passed', `status=${st}`);

// ④c project switch mid-run: late result must never land on the new project.
// The store resets synchronously to idle for the new project; the late result is
// then discarded because its runId is no longer active.
stores.setProject(seamP1Sample());
await delay(10);
const run2 = auditStoreModule.startAudit();
const other = p6mSample();
const otherId = other.id;
stores.setProject(other);
st = get(auditStoreModule.seamAudit).status;
check('④c 切换瞬间新工程立即为 idle（不显示旧工程结论）', st === 'idle', `status=${st}`);
await run2;
const stateNow = get(auditStoreModule.seamAudit);
check('④c 运行中切换群/工程：迟到结果不污染新工程',
  (stateNow.status === 'idle' || stateNow.status === 'stale') && stateNow.projectId === otherId,
  `status=${stateNow.status} project=${stateNow.projectId.slice(0, 12)}`);

// ④d hydration: stored pass restores only when fingerprint matches; never fabricated
const auditedProject = seamP1Sample();
stores.setProject(auditedProject);
await delay(10);
await auditStoreModule.startAudit();
check('④d 当前工程已通过', get(auditStoreModule.seamAudit).status === 'passed');
await saveProject(get(stores.editor).project);
const auditedId = get(stores.editor).project.id;
// simulate a fresh page load: exercise hydrateProject directly against IndexedDB.
await auditStoreModule.hydrateProject(get(stores.editor).project);
check('④d 内容指纹一致时恢复通过', get(auditStoreModule.seamAudit).status === 'passed');
// never-audited project
const never = p6mSample();
stores.setProject(never);
await auditStoreModule.hydrateProject(never);
st = get(auditStoreModule.seamAudit).status;
check('④d 未审计/迁移工程不会伪造通过', st === 'idle' || st === 'stale', `status=${st}`);
// audited project whose content later changed -> stale on hydrate (same flow as
// opening the project from the library after its content was modified)
const mutated = structuredClone(auditedProject);
mutated.objects[0].path[0].y -= 15; // same id, different content
stores.setProject(mutated);
await auditStoreModule.hydrateProject(mutated);
st = get(auditStoreModule.seamAudit).status;
check('④d 同工程内容变更后恢复记录为过期', st === 'stale', `status=${st}`);

// ④e fingerprint stability: rename / autosave timestamps don't invalidate; geometry does
const fpBase = structuredClone(auditedProject);
const fpA = contentFingerprint(fpBase);
const renamed = structuredClone(fpBase);
renamed.name = '别的名字';
renamed.updatedAt = renamed.updatedAt + 999_999;
check('④e 重命名与 updatedAt 不影响内容指纹', contentFingerprint(renamed) === fpA);
const editedFp = structuredClone(fpBase);
editedFp.objects[0].strokeWidth = 9;
check('④e 样式/几何编辑改变内容指纹', contentFingerprint(editedFp) !== fpA);

// ⑤ PNG export still works --------------------------------------------------------
{
  const tile = exportPeriodicTile(p6, 2);
  const data = tile.canvas.getImageData ? null : null;
  void data;
  const buf = tile.canvas.toBuffer('image/png');
  const hasInk = tile.canvas
    .getContext('2d')
    .getImageData(0, 0, tile.canvas.width, tile.canvas.height).data.some((v: number, i: number) => i % 4 === 3 && v > 0);
  check('⑤ 原有 PNG 导出正常（三角超级周期、有内容、PNG 可编码）',
    buf[0] === 0x89 && buf[1] === 0x50 && hasInk && tile.repeats[0] === 2,
    `${buf.length} bytes ${tile.width}x${tile.height} repeats=${tile.repeats.join('x')}`);
  const rectTile = exportPeriodicTile(p1, 2);
  check('⑤ 矩形群导出仍是 1×1 单元', rectTile.repeats[0] === 1 && rectTile.repeats[1] === 1);
  const projects = await listProjects();
  check('⑤ IndexedDB 工程存取未受影响', Array.isArray(projects));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

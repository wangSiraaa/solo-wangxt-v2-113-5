<script lang="ts">
  import { onMount } from 'svelte';
  import { editor, selectObject } from '../lib/stores';
  import { requestLocateOriginal } from '../lib/ui';
  import { downloadTile, exportPeriodicTile, type TileResult } from '../lib/export';
  import { auditStore, startAudit } from '../lib/seam/auditStore';
  import { tileGeometry } from '../lib/seam/composite';
  import type { AuditBoundary, AuditState } from '../lib/seam/types';
  import type { Point } from '../types';

  let preview: HTMLCanvasElement;
  let overlay: HTMLCanvasElement;
  let repeatLayer: HTMLDivElement;
  let tile: TileResult | null = null;
  let dataUrl = '';
  let scale = 2;
  let repeats = 3;

  $: project = $editor.project;
  $: geom = tileGeometry(project);
  $: audit = ($auditStore[project.id] ?? {
    status: 'stale' as const,
    report: null,
    fingerprint: null,
    startedAt: null
  }) as AuditState;
  $: boundaries = (audit.report?.boundaries ?? []) as AuditBoundary[];
  $: failedBoundaries = boundaries.filter((b) => !b.passed);

  const DISPLAY_W = 520;

  function rebuild() {
    tile = exportPeriodicTile($editor.project, scale);
    dataUrl = tile.canvas.toDataURL('image/png');
    const ctx = preview.getContext('2d')!;
    ctx.clearRect(0, 0, preview.width, preview.height);
    for (let y = 0; y < repeats; y += 1) {
      for (let x = 0; x < repeats; x += 1) {
        ctx.drawImage(tile.canvas, x * tile.width, y * tile.height, tile.width, tile.height);
      }
    }
    repeatLayer.style.backgroundImage = `url(${dataUrl})`;
    repeatLayer.style.backgroundSize = `${tile.width}px ${tile.height}px`;
    repeatLayer.style.backgroundRepeat = 'repeat';
    requestAnimationFrame(drawOverlay);
  }

  $: displayScale = DISPLAY_W / geom.width;
  $: overlayHeight = geom.height * displayScale;

  /** World→screen factors use the actual displayed rect (CSS may scale the 520px buffer). */
  function screenToWorld(event: MouseEvent): Point {
    const rect = overlay.getBoundingClientRect();
    return [
      ((event.clientX - rect.left) / rect.width) * geom.width,
      ((event.clientY - rect.top) / rect.height) * geom.height
    ];
  }

  function drawOverlay() {
    if (!overlay) return;
    const ctx = overlay.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    ctx.setTransform(displayScale, 0, 0, displayScale, 0, 0);
    for (const boundary of boundaries) {
      if (boundary.id === 'export-consistency') continue;
      const color = boundary.passed ? 'rgba(22,163,74,0.85)' : 'rgba(220,38,38,0.95)';
      ctx.save();
      ctx.lineWidth = boundary.passed ? 1.2 / displayScale : 2.4 / displayScale;
      ctx.strokeStyle = color;
      ctx.setLineDash(boundary.passed ? [7 / displayScale, 5 / displayScale] : []);
      ctx.beginPath();
      ctx.moveTo(boundary.from[0], boundary.from[1]);
      ctx.lineTo(boundary.to[0], boundary.to[1]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (!boundary.passed) {
        // Heat zones: halo around every mismatching station.
        for (const sample of boundary.samples) {
          ctx.beginPath();
          ctx.fillStyle = 'rgba(220,38,38,0.22)';
          ctx.arc(sample.x, sample.y, 4.2 / displayScale, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.fillStyle = '#dc2626';
          ctx.arc(sample.x, sample.y, 1.8 / displayScale, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  $: if (audit.report) requestAnimationFrame(drawOverlay);

  function overlayHit(event: MouseEvent): AuditBoundary | null {
    const world = screenToWorld(event);
    let best: { boundary: AuditBoundary; distance: number } | null = null;
    for (const boundary of boundaries) {
      if (boundary.passed || boundary.id === 'export-consistency') continue;
      const distance = distanceToSegment(world, boundary.from, boundary.to);
      if (distance < 10 && (!best || distance < best.distance)) {
        best = { boundary, distance };
      }
      for (const sample of boundary.samples) {
        if (Math.hypot(world[0] - sample.x, world[1] - sample.y) < 9) {
          return boundary;
        }
      }
    }
    return best?.boundary ?? null;
  }

  function distanceToSegment(p: Point, a: Point, b: Point): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }

  function onOverlayClick(event: MouseEvent) {
    const boundary = overlayHit(event);
    if (!boundary || boundary.contributors.length === 0) return;
    // Every contributor carries the unique source object id; select that source and
    // record the concrete transformed image the hot zone belongs to.
    const contributor = boundary.contributors[0]!;
    selectObject(contributor.objectId, contributor.instance);
    requestLocateOriginal();
  }

  function run() {
    startAudit($editor.project);
  }

  function download() {
    downloadTile($editor.project, scale);
  }

  function formatPercent(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
  }

  const statusLabel = {
    running: '审计运行中…',
    passed: '通过 ✓',
    failed: '失败 ✗',
    stale: '过期',
    error: '错误'
  } as const;

  let unsubscribe: () => void;
  const autoRan = new Set<string>();
  onMount(() => {
    rebuild();
    unsubscribe = editor.subscribe(() => requestAnimationFrame(rebuild));
    // First visit per (project,fingerprint): run once so designers see a verdict without
    // hunting for the button. Any edit while it runs still invalidates it via the epoch.
    if (audit.status === 'stale' && !autoRan.has(`${project.id}:${audit.fingerprint ?? ''}`)) {
      autoRan.add(`${project.id}:${audit.fingerprint ?? ''}`);
      run();
    }
  });
</script>

<section class="seam">
  <div class="row">
    <label>导出倍率 <input type="number" min="1" max="4" bind:value={scale} on:change={rebuild} /></label>
    <button on:click={download}>导出周期单元 PNG</button>
    <button class="audit-run" on:click={run} disabled={audit.status === 'running'}>
      {audit.status === 'running' ? '审计运行中…' : '运行接缝审计'}
    </button>
  </div>
  {#if tile}
    <p class="meta">
      单元 {Math.round(tile.width)}×{Math.round(tile.height)}；三角晶格使用 {tile.repeats[0]}×{tile.repeats[1]}
      原胞形成可矩形重复的超级周期；背景保持透明。
    </p>
  {/if}

  <div class="audit-card" data-status={audit.status}>
    <div class="audit-head">
      <strong class={`status status-${audit.status}`}>{statusLabel[audit.status]}</strong>
      {#if audit.message}<span class="audit-msg">{audit.message}</span>{/if}
    </div>
    {#if audit.status === 'running'}
      <div class="progress"><div class="bar"></div></div>
    {/if}
    {#if audit.report}
      <p class="meta">
        审计 {boundaries.length} 条边界（平移外框 + 基本域镶嵌斜向边），指纹
        <code>{audit.report.fingerprint}</code>；几何覆盖与预乘透明度颜色同时比较。
      </p>
      <div class="tile-frame" style={`aspect-ratio:${geom.width} / ${geom.height}`}>
        <div class="tile-bg" style={`background-image:url(${dataUrl});background-size:100% 100%`}></div>
        <canvas bind:this={overlay} width={DISPLAY_W} height={Math.round(overlayHeight)}></canvas>
      </div>
      <p class="meta hint-line">绿虚线为已通过的镶嵌/平移边界；红色与红点为差异热区，点击热区定位唯一源对象。</p>
    {/if}
  </div>

  {#if failedBoundaries.length > 0}
    <div class="findings">
      <h4>失败边界与差异（{failedBoundaries.length}）</h4>
      {#each failedBoundaries as boundary (boundary.id)}
        <article class="finding">
          <header>
            <strong>{boundary.label}</strong>
            <span class="bad">失败</span>
          </header>
          <p class="meta">
            采样点 {boundary.stationCount}；差异 {boundary.mismatchCount}（{formatPercent(boundary.mismatchRatio)}）；
            最大 α 差 {boundary.maxGeometricDelta.toFixed(2)}、最大预乘颜色差 {boundary.maxColorDelta.toFixed(2)}
          </p>
          {#if boundary.mismatchRange}
            <p class="meta">
              差异范围：({boundary.mismatchRange.from[0].toFixed(1)}, {boundary.mismatchRange.from[1].toFixed(1)})
              → ({boundary.mismatchRange.to[0].toFixed(1)}, {boundary.mismatchRange.to[1].toFixed(1)})
            </p>
          {/if}
          {#if boundary.contributors.length > 0}
            <ul class="contribs">
              {#each boundary.contributors.slice(0, 8) as contributor (contributor.instance)}
                <li>
                  <button on:click={() => { selectObject(contributor.objectId, contributor.instance); requestLocateOriginal(); }}>
                    <span class="side side-{contributor.side}">{contributor.side === 'both' ? '两侧' : contributor.side === 'a' ? 'A 侧' : 'B 侧'}</span>
                    {contributor.objectName}
                    <code>{contributor.instance}</code>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </article>
      {/each}
    </div>
  {/if}

  <h4>PNG 重复预览（旧导出，与审计共用同一渲染）</h4>
  <div class="layer" bind:this={repeatLayer}></div>
  <canvas
    bind:this={preview}
    width={1200}
    height={1000}
    title="同一个周期单元 drawImage 重复 3×3，观察水平、竖直及对角接缝"
  ></canvas>
</section>

<style>
  .seam {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  input {
    width: 58px;
  }
  button {
    flex: 1;
  }
  .audit-run {
    background: #1d4ed8;
    border-color: #1d4ed8;
    color: white;
  }
  .meta {
    margin: 0;
    color: #475569;
    font-size: 12px;
    line-height: 1.4;
  }
  code {
    font-size: 11px;
  }
  .audit-card {
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    padding: 9px;
    display: flex;
    flex-direction: column;
    gap: 7px;
    background: #f8fafc;
  }
  .audit-card[data-status='passed'] {
    border-color: #86efac;
    background: #f0fdf4;
  }
  .audit-card[data-status='failed'] {
    border-color: #fca5a5;
    background: #fef2f2;
  }
  .audit-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .status {
    font-size: 14px;
  }
  .status-passed {
    color: #166534;
  }
  .status-failed {
    color: #991b1b;
  }
  .status-running {
    color: #1d4ed8;
  }
  .status-stale {
    color: #92400e;
  }
  .status-error {
    color: #991b1b;
  }
  .audit-msg {
    font-size: 12px;
    color: #64748b;
  }
  .progress {
    height: 5px;
    background: #dbeafe;
    border-radius: 99px;
    overflow: hidden;
  }
  .bar {
    height: 100%;
    width: 35%;
    background: #3b82f6;
    border-radius: 99px;
    animation: slide 1.1s infinite;
  }
  @keyframes slide {
    from { transform: translateX(-100%); }
    to { transform: translateX(320%); }
  }
  .tile-frame {
    position: relative;
    width: 100%;
    border: 1px solid #94a3b8;
    border-radius: 6px;
    overflow: hidden;
    background:
      linear-gradient(45deg, #e2e8f0 25%, transparent 25%),
      linear-gradient(-45deg, #e2e8f0 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #e2e8f0 75%),
      linear-gradient(-45deg, transparent 75%, #e2e8f0 75%);
    background-size: 16px 16px;
  }
  .tile-bg {
    position: absolute;
    inset: 0;
    background-color: transparent;
    background-repeat: no-repeat;
  }
  canvas {
    position: relative;
  }
  .tile-frame canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    cursor: pointer;
  }
  .hint-line {
    color: #64748b;
  }
  .findings {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  h4 {
    margin: 4px 0 0;
    font-size: 13px;
  }
  .finding {
    border: 1px solid #fecaca;
    background: white;
    border-radius: 7px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .finding header {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 12px;
  }
  .bad {
    color: #991b1b;
    font-weight: 600;
  }
  .contribs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 4px;
  }
  .contribs button {
    flex: none;
    width: 100%;
    text-align: left;
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 12px;
  }
  .side {
    font-size: 10px;
    border-radius: 4px;
    padding: 1px 5px;
    background: #e2e8f0;
  }
  .side-a {
    background: #dbeafe;
  }
  .side-b {
    background: #fee2e2;
  }
  .side-both {
    background: #dcfce7;
  }
  .layer {
    width: 100%;
    height: 90px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    background-color: #f8fafc;
    background-image:
      linear-gradient(45deg, #e2e8f0 25%, transparent 25%),
      linear-gradient(-45deg, #e2e8f0 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #e2e8f0 75%),
      linear-gradient(-45deg, transparent 75%, #e2e8f0 75%);
    background-size: 16px 16px;
    background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  }
  section > canvas {
    max-width: 100%;
    max-height: 360px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    background:
      linear-gradient(45deg, #e2e8f0 25%, transparent 25%),
      linear-gradient(-45deg, #e2e8f0 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #e2e8f0 75%),
      linear-gradient(-45deg, transparent 75%, #e2e8f0 75%);
    background-size: 16px 16px;
    background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  }
</style>

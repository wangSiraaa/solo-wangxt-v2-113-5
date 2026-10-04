<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { editor, selectObject } from '../lib/stores';
  import { requestLocateOriginal } from '../lib/ui';
  import { downloadTile, exportPeriodicTile, type TileResult } from '../lib/export';
  import { seamAudit, startAudit } from '../lib/seamStore';
  import type { BoundaryResult, MismatchCluster } from '../lib/seamTypes';

  let preview: HTMLCanvasElement;
  let tileLayer: HTMLDivElement;
  let overlay: HTMLCanvasElement;
  let tileWrap: HTMLDivElement;
  let tile: TileResult | null = null;
  let dataUrl = '';
  let scale = 2;
  let repeats = 3;
  let tileCssW = 0;
  let tileCssH = 0;
  let hoveredCluster: string | null = null;

  const TRI_GROUPS = new Set(['p3', 'p3m1', 'p31m', 'p6', 'p6m']);
  $: boundaryCount = TRI_GROUPS.has($editor.project.group) ? 4 : 2;

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
    tileLayer.style.backgroundImage = `url(${dataUrl})`;
    tileLayer.style.backgroundSize = `${tile.width}px ${tile.height}px`;
    tileLayer.style.backgroundRepeat = 'repeat';
    requestAnimationFrame(layoutOverlay);
  }

  function download() {
    downloadTile($editor.project, scale);
  }

  function layoutOverlay() {
    if (!overlay || !preview || !tile) return;
    const rect = preview.getBoundingClientRect();
    const wrapRect = tileWrap.getBoundingClientRect();
    tileCssW = rect.width;
    tileCssH = rect.height;
    const dpr = window.devicePixelRatio || 1;
    overlay.style.left = `${rect.left - wrapRect.left}px`;
    overlay.style.top = `${rect.top - wrapRect.top}px`;
    overlay.style.width = `${tileCssW}px`;
    overlay.style.height = `${tileCssH}px`;
    overlay.width = Math.round(tileCssW * dpr);
    overlay.height = Math.round(tileCssH * dpr);
    const ctx = overlay.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, tileCssW, tileCssH);
    drawOverlay(ctx);
  }

  function worldToCss(x: number, y: number): [number, number] {
    // The preview canvas keeps its 1200×1000 internal coordinate space (the tile is
    // drawn 1:1 in world units) and CSS scales that box uniformly to fit the panel.
    return [(x / preview.width) * tileCssW, (y / preview.height) * tileCssH];
  }

  function drawOverlay(ctx: CanvasRenderingContext2D) {
    const report = $seamAudit.report;
    if (!report || !tile) return;
    const factor = tileCssW / preview.width;

    for (const boundary of report.boundaries) {
      ctx.save();
      const failed = !boundary.passed;
      ctx.lineWidth = failed ? 1.6 : 1;
      ctx.setLineDash(failed ? [] : [6, 5]);
      ctx.strokeStyle = failed ? 'rgba(225,29,72,0.85)' : 'rgba(22,101,52,0.55)';
      drawBoundaryLine(ctx, boundary);
      ctx.restore();
    }

    for (const boundary of report.boundaries) {
      if (boundary.passed) continue;
      boundary.clusters.forEach((cluster, index) => {
        drawCluster(ctx, boundary, cluster, index, factor);
      });
    }
  }

  function drawBoundaryLine(ctx: CanvasRenderingContext2D, boundary: BoundaryResult) {
    if (!tile) return;
    const [w, h] = [tile.width, tile.height];
    ctx.beginPath();
    if (boundary.kind === 'wrap-x') {
      const [x0, y0] = worldToCss(0, 0);
      ctx.moveTo(x0, y0);
      const [x1, y1] = worldToCss(0, h);
      ctx.lineTo(x1, y1);
      const [xr] = worldToCss(w, 0);
      ctx.moveTo(xr, y0);
      ctx.lineTo(xr, y1);
    } else if (boundary.kind === 'wrap-y') {
      const [x0, y0] = worldToCss(0, 0);
      const [x1] = worldToCss(w, 0);
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y0);
      const [, yb] = worldToCss(0, h);
      ctx.moveTo(x0, yb);
      ctx.lineTo(x1, yb);
    } else {
      // Lattice-parallel (oblique) boundary: segments translated by the primitive
      // vector tile the supercell diagonally, so draw that family explicitly.
      const [tx, ty] = boundary.translation;
      const long = Math.hypot(w, h) * 2;
      const norm = Math.hypot(tx, ty) || 1;
      const dx = (tx / norm) * long;
      const dy = (ty / norm) * long;
      const px = -dy;
      const py = dx;
      const pNorm = Math.hypot(px, py) || 1;
      for (let s = -long; s <= long; s += norm) {
        const cx = w / 2 + (px / pNorm) * s;
        const cy = h / 2 + (py / pNorm) * s;
        const [ax, ay] = worldToCss(cx - dx, cy - dy);
        ctx.moveTo(ax, ay);
        const [bx, by] = worldToCss(cx + dx, cy + dy);
        ctx.lineTo(bx, by);
      }
    }
    ctx.stroke();
  }

  function drawCluster(
    ctx: CanvasRenderingContext2D,
    boundary: BoundaryResult,
    cluster: MismatchCluster,
    index: number,
    factor: number
  ) {
    const key = clusterKey(boundary, index);
    const hovered = hoveredCluster === key;
    const [cx, cy] = worldToCss(cluster.point[0], cluster.point[1]);
    const rw = Math.max(7, cluster.bounds.w * factor / 2 + 5);
    const rh = Math.max(7, cluster.bounds.h * factor / 2 + 5);
    ctx.save();
    ctx.fillStyle = hovered ? 'rgba(244,63,94,0.32)' : 'rgba(244,63,94,0.20)';
    ctx.strokeStyle = '#e11d48';
    ctx.lineWidth = hovered ? 2.4 : 1.6;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#9f1239';
    ctx.font = 'bold 11px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(index + 1), cx, cy);
    ctx.restore();
  }

  function clusterKey(boundary: BoundaryResult, index: number) {
    return `${boundary.kind}:${index}`;
  }

  function pickCluster(event: MouseEvent): { boundary: BoundaryResult; cluster: MismatchCluster; index: number } | null {
    if (!overlay || !tile) return null;
    const rect = overlay.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const report = $seamAudit.report;
    if (!report) return null;
    const factor = tileCssW / preview.width;
    let winner: { boundary: BoundaryResult; cluster: MismatchCluster; index: number; distance: number } | null = null;
    for (const boundary of report.boundaries) {
      if (boundary.passed) continue;
      for (let index = 0; index < boundary.clusters.length; index += 1) {
        const cluster = boundary.clusters[index]!;
        const [cx, cy] = worldToCss(cluster.point[0], cluster.point[1]);
        const rw = Math.max(9, (cluster.bounds.w * factor) / 2 + 8);
        const rh = Math.max(9, (cluster.bounds.h * factor) / 2 + 8);
        const normalized = ((mx - cx) / rw) ** 2 + ((my - cy) / rh) ** 2;
        if (normalized <= 1 && (!winner || normalized < winner.distance)) {
          winner = { boundary, cluster, index, distance: normalized };
        }
      }
    }
    if (!winner) return null;
    return { boundary: winner.boundary, cluster: winner.cluster, index: winner.index };
  }

  function onOverlayClick(event: MouseEvent) {
    const hit = pickCluster(event);
    if (!hit?.cluster.objectId) return;
    // Select the unique source object and record the concrete instance so the
    // inspector/canvas locate the original even though the click was on a seam.
    selectObject(hit.cluster.objectId, hit.cluster.instance);
    requestLocateOriginal();
  }

  function onOverlayMove(event: MouseEvent) {
    const hit = pickCluster(event);
    const key = hit ? clusterKey(hit.boundary, hit.index) : null;
    if (key !== hoveredCluster) {
      hoveredCluster = key;
      overlay.style.cursor = hit?.cluster.objectId ? 'pointer' : 'default';
      const ctx = overlay.getContext('2d')!;
      ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
      ctx.clearRect(0, 0, tileCssW, tileCssH);
      drawOverlay(ctx);
    }
  }

  $: statusLabel = (() => {
    switch ($seamAudit.status) {
      case 'running':
        return { text: '审计运行中…', cls: 'running' };
      case 'passed':
        return { text: '接缝审计通过', cls: 'passed' };
      case 'failed':
        return { text: '接缝审计失败', cls: 'failed' };
      case 'stale':
        return { text: '审计结果已过期', cls: 'stale' };
      case 'error':
        return { text: '审计出错', cls: 'error' };
      default:
        return { text: '尚未审计', cls: 'idle' };
    }
  })();

  let unsubscribe: () => void;
  let unsubscribeAudit: () => void;
  let resizeObserver: ResizeObserver;
  onMount(() => {
    rebuild();
    unsubscribe = editor.subscribe(() => requestAnimationFrame(rebuild));
    // Redraw boundary lines and hot zones as soon as a run finishes or goes stale.
    unsubscribeAudit = seamAudit.subscribe(() => requestAnimationFrame(layoutOverlay));
    resizeObserver = new ResizeObserver(() => requestAnimationFrame(layoutOverlay));
    resizeObserver.observe(tileWrap);
    // Auto-run the first audit for a project that has never been audited.
    if ($seamAudit.status === 'idle') void startAudit();
  });

  onDestroy(() => {
    unsubscribe?.();
    unsubscribeAudit?.();
    resizeObserver?.disconnect();
  });

  export { rebuild as refreshTile };
</script>

<section class="seam">
  <div class="row">
    <label>导出倍率 <input type="number" min="1" max="4" bind:value={scale} on:change={rebuild} /></label>
    <button on:click={download}>导出周期单元 PNG</button>
  </div>
  {#if tile}
    <p class="meta">
      单元 {Math.round(tile.width)}×{Math.round(tile.height)}；三角晶格使用 {tile.repeats[0]}×{tile.repeats[1]}
      原胞形成可矩形重复的超级周期；背景保持透明。
    </p>
  {/if}

  <div class="audit-card">
    <div class="audit-head">
      <span class="badge {$seamAudit.status}">{statusLabel.text}</span>
      <button class:running={$seamAudit.status === 'running'} disabled={$seamAudit.status === 'running'} on:click={() => void startAudit()}>
        {$seamAudit.status === 'running' ? '审计中…' : '运行 / 重新审计'}
      </button>
    </div>
    <p class="hint-text">
      审计使用与 PNG 导出完全相同的群矩阵、路径、周期单元与裁切：逐对象比较边界几何覆盖（透明/零不透明度也参与），
      再比较预乘透明度后的最终颜色；三角晶格额外检查超级周期的两条原胞平移（含斜向 t₂）边界。
    </p>
    {#if $seamAudit.status === 'stale'}
      <p class="banner stale">{$seamAudit.error ?? '工程内容已变更：旧结果不会把新内容标为通过，需重新审计。'}</p>
    {/if}
    {#if $seamAudit.status === 'error'}
      <p class="banner error">审计错误：{$seamAudit.error}</p>
    {/if}
    {#if $seamAudit.status === 'running'}
      <p class="banner running">
        正在渲染含外边距的超级周期，逐对象比较几何覆盖与预乘颜色，共 {boundaryCount} 条配对边界…
      </p>
    {/if}

    {#if $seamAudit.report}
      {@const report = $seamAudit.report}
      <ul class="boundaries">
        {#each report.boundaries as boundary}
          <li class:ok={boundary.passed} class:bad={!boundary.passed}>
            <div class="b-row">
              <span class="mark">{boundary.passed ? '✓' : '✗'}</span>
              <span class="b-label">{boundary.label}</span>
            </div>
            <div class="b-meta">
              采样 {boundary.sampled} 点 · 差异 {boundary.mismatchCount}
              （{(boundary.mismatchRatio * 100).toFixed(2)}%）· 颜色Δ最大 {Math.round(boundary.maxColorDelta)} ·
              几何Δ最大 {Math.round(boundary.maxGeometryDelta)}
            </div>
            {#if !boundary.passed && boundary.clusters.length > 0}
              <ul class="clusters">
                {#each boundary.clusters as cluster, index}
                  <li>
                    <button
                      class="cluster-btn"
                      disabled={!cluster.objectId}
                      on:click={() => {
                        if (cluster.objectId) {
                          selectObject(cluster.objectId, cluster.instance);
                          requestLocateOriginal();
                        }
                      }}
                      title={cluster.objectId ? `点击定位唯一源对象（实例 ${cluster.instance ?? ''}）` : '无法归属到单个对象'}
                    >
                      <em>{index + 1}</em>
                      {#if cluster.objectName}
                        <span>对象「{cluster.objectName}」</span>
                      {:else}
                        <span>多对象叠加差异</span>
                      {/if}
                      <code>{cluster.instance ?? '—'}</code>
                      <small>
                        中心 ({cluster.point[0].toFixed(0)}, {cluster.point[1].toFixed(0)}) · {cluster.pixelCount} 像素 ·
                        颜色Δ {Math.round(cluster.maxColorDelta)} / 几何Δ {Math.round(cluster.maxGeometryDelta)}
                      </small>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="layer" bind:this={tileLayer}></div>
  <div class="tile-wrap" bind:this={tileWrap}>
    <canvas
      bind:this={preview}
      width={1200}
      height={1000}
      title="同一个周期单元 drawImage 重复 3×3，观察水平、竖直及对角接缝"
    ></canvas>
    <canvas
      class="overlay"
      bind:this={overlay}
      on:click={onOverlayClick}
      on:mousemove={onOverlayMove}
    ></canvas>
  </div>
  <p class="meta">
    红色热区直接画在单个周期单元上：点击任一热区（或下方差异条目）选中唯一源对象并定位到其原始基本单元；
    绿色虚线为已通过的配对边界。
  </p>
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
  .row button {
    flex: 1;
  }
  .meta {
    margin: 0;
    color: #475569;
    font-size: 12px;
    line-height: 1.35;
  }
  .layer {
    width: 100%;
    height: 70px;
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
  .tile-wrap {
    position: relative;
    width: 100%;
  }
  .tile-wrap canvas {
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
  .tile-wrap .overlay {
    position: absolute;
    left: 0;
    top: 0;
    background: transparent;
    border: 0;
    border-radius: 8px;
    max-height: none;
  }
  .audit-card {
    border: 1px solid #cbd5e1;
    border-radius: 10px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: #f8fafc;
  }
  .audit-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .badge {
    font-size: 13px;
    font-weight: 700;
    padding: 4px 10px;
    border-radius: 999px;
  }
  .badge.passed {
    background: #dcfce7;
    color: #166534;
  }
  .badge.failed {
    background: #ffe4e6;
    color: #9f1239;
  }
  .badge.running {
    background: #dbeafe;
    color: #1e40af;
  }
  .badge.stale {
    background: #fef3c7;
    color: #92400e;
  }
  .badge.error,
  .badge.idle {
    background: #e2e8f0;
    color: #334155;
  }
  button.running {
    opacity: 0.6;
  }
  .hint-text {
    margin: 0;
    font-size: 11.5px;
    line-height: 1.45;
    color: #64748b;
  }
  .banner {
    margin: 0;
    padding: 6px 8px;
    border-radius: 6px;
    font-size: 12px;
  }
  .banner.stale {
    background: #fef9c3;
    color: #854d0e;
  }
  .banner.error {
    background: #fee2e2;
    color: #991b1b;
  }
  .banner.running {
    background: #dbeafe;
    color: #1e3a8a;
  }
  .boundaries {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .boundaries > li {
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 7px 8px;
    background: white;
  }
  .boundaries > li.ok {
    border-color: #bbf7d0;
  }
  .boundaries > li.bad {
    border-color: #fecdd3;
    background: #fff1f2;
  }
  .b-row {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
  .mark {
    font-weight: 700;
  }
  .ok .mark {
    color: #16a34a;
  }
  .bad .mark {
    color: #e11d48;
  }
  .b-label {
    font-size: 12.5px;
    font-weight: 600;
  }
  .b-meta {
    margin-top: 2px;
    padding-left: 20px;
    font-size: 11px;
    color: #64748b;
  }
  .clusters {
    list-style: none;
    margin: 6px 0 0;
    padding: 0 0 0 12px;
    display: grid;
    gap: 5px;
  }
  .cluster-btn {
    width: 100%;
    display: grid;
    grid-template-columns: 22px 1fr;
    gap: 1px 8px;
    text-align: left;
    padding: 5px 8px;
    border-color: #fda4af;
    background: white;
  }
  .cluster-btn:not(:disabled):hover {
    background: #fff1f2;
    border-color: #e11d48;
  }
  .cluster-btn em {
    grid-row: span 2;
    font-style: normal;
    font-weight: 700;
    color: #be123c;
    align-self: center;
  }
  .cluster-btn code,
  .cluster-btn small {
    font-size: 10.5px;
    color: #64748b;
    word-break: break-all;
  }
</style>

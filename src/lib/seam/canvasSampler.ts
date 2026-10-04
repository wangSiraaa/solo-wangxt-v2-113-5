import type { Project } from '../../types';
import { tileGeometry, type TileGeometry } from './composite';
import { createSoftwareSampler } from './softwareSampler';
import { renderTile } from './renderTile';
import type { ContributorHit, RGBA, SeamSampler } from './types';

interface PixelSource {
  data: Uint8ClampedArray;
  pxW: number;
  pxH: number;
  scale: number;
  width: number;
  height: number;
}

/**
 * Canvas-backed sampler for the exported supercell. Geometry coverage (alpha) and final
 * premultiplied color come from reading the same rendered pixels the PNG export and the
 * 3×3 repeat preview produce, so transparent strokes and compositing are measured as
 * they actually appear. Out-of-rectangle points read as transparent: the auditor wraps
 * only the outer translation-edge probes itself, while interior oblique edges compare
 * two points genuinely inside the tile (no coordinate wrapping that could hide a gap).
 *
 * Source-object attribution for hot zones uses the geometry-faithful software sampler
 * with the identical paint-job enumeration, so a click still resolves to the unique
 * source object and the concrete periodic image responsible.
 */
export function createCanvasSampler(project: Project, geom: TileGeometry): SeamSampler {
  const tile = renderTile(project, { scale: 4 });
  const scale = 4;
  const ctx = tile.canvas.getContext('2d', { willReadFrequently: true })!;
  const data = ctx.getImageData(0, 0, tile.canvas.width, tile.canvas.height).data;
  const source: PixelSource = {
    data,
    pxW: tile.canvas.width,
    pxH: tile.canvas.height,
    scale,
    width: tile.width,
    height: tile.height
  };
  const software = createSoftwareSampler(project, { mode: 'infinite' });

  function pixelAt(x: number, y: number): RGBA {
    if (x < 0 || y < 0 || x >= source.width || y >= source.height) return [0, 0, 0, 0];
    const px = Math.floor(x * source.scale);
    const py = Math.floor(y * source.scale);
    if (px < 0 || py < 0 || px >= source.pxW || py >= source.pxH) return [0, 0, 0, 0];
    const index = (py * source.pxW + px) * 4;
    const a = source.data[index + 3]! / 255;
    // Canvas stores straight alpha; seam comparison uses premultiplied color.
    return [
      (source.data[index]! / 255) * a,
      (source.data[index + 1]! / 255) * a,
      (source.data[index + 2]! / 255) * a,
      a
    ];
  }

  return {
    sample(x, y, radius = 1.35): RGBA {
      const grid = 3;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let i = 0; i < grid; i += 1) {
        for (let j = 0; j < grid; j += 1) {
          const fx = ((i + 0.5) / grid - 0.5) * 2 * radius;
          const fy = ((j + 0.5) / grid - 0.5) * 2 * radius;
          const c = pixelAt(x + fx, y + fy);
          r += c[0];
          g += c[1];
          b += c[2];
          a += c[3];
          count += 1;
        }
      }
      return [r / count, g / count, b / count, a / count];
    },
    contributorsAt(x: number, y: number, radius = 2.2): ContributorHit[] {
      return software.contributorsAt(x, y, radius);
    }
  };
}

export { tileGeometry };
